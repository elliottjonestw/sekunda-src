import { connect } from "cloudflare:sockets";
import {
  MAIL_MAX_BODY_BYTES,
  MAIL_MAX_UIDS,
  MAIL_SMALL_MESSAGE_BYTES,
  type MailCriteria,
  type MailOp,
  type MailOpResult,
} from "@secondbrain/shared";
import {
  chooseTextPart, ImapError, parseExamine, parseFetch, parseFolders, parseStatus, parseUids,
} from "./imapParse";

/** The pure parsing layer lives in `imapParse.ts` so it can run outside a
 *  Worker isolate; `routes/mail.ts` still imports the error type from here. */
export { ImapError };

/**
 * A minimal IMAP4rev1 client for the Worker, over `cloudflare:sockets`.
 *
 * Hand-rolled on purpose. Every mature Node IMAP library (`imapflow`, `node-imap`)
 * is built on `net`/`tls` and an EventEmitter stack that a V8 isolate does not
 * have, so "just use a library" is not an option here — and the alternative,
 * shipping a compatibility layer, would be far more code than the subset this
 * app needs. That subset is: LOGIN, LIST, EXAMINE, UID SEARCH, UID FETCH,
 * LOGOUT. Nothing writes.
 *
 * **EXAMINE, never SELECT.** EXAMINE opens a mailbox read-only, so the server
 * itself refuses anything that would change it. That is what makes "read-only"
 * a property of the connection rather than a promise about our own code: even a
 * bug here cannot mark a message as read, move it, or expunge it. Body fetches
 * use BODY.PEEK for the same reason (plain BODY[] sets \Seen).
 *
 * The protocol details that bite, all handled below:
 *   - **Literals.** Any response line may end with `{n}` meaning "n raw bytes
 *     follow, then the line continues". A reader that works line-by-line will
 *     mis-frame every message whose subject contains a newline or non-ASCII.
 *   - **Bytes, not text.** Responses carry mail in whatever charset the sender
 *     used. Everything here is read as a binary string (one code unit per byte)
 *     and decoded client-side, where the MIME headers say what the charset is.
 *   - **Synchronizing literals on the way out.** Sending a non-ASCII search
 *     term means writing `{n}`, waiting for the server's `+` continuation, and
 *     only then the bytes. LITERAL+ would skip the wait; not every server has
 *     it, and one round-trip on a rare path is not worth the branch.
 */

/** Whole-conversation deadline. A stalled socket must not hold a Worker
 *  request open until the platform kills it with no explanation. */
const DEADLINE_MS = 20_000;

/** A single response line, literals included. Guards against a hostile or
 *  broken server streaming unbounded data into memory. */
const MAX_RESPONSE_BYTES = MAIL_MAX_BODY_BYTES + 65_536;

/** Header block per message in a search. Real headers are 2–8 KB; a chain of
 *  Received/DKIM/ARC lines can be larger, and none of it is worth more. */
const HEADER_FIELDS = "DATE SUBJECT FROM TO CC REPLY-TO MESSAGE-ID CONTENT-TYPE LIST-ID";

// ---------------------------------------------------------------------------
// Bytes ↔ binary strings
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

/** One code unit per byte. Chunked because `apply` on a 256 KB array blows the
 *  argument limit — the failure mode is a RangeError on large messages only,
 *  which is exactly the kind of bug that ships. */
function binaryString(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Command arguments
// ---------------------------------------------------------------------------

type Arg = string | { literal: string };

/**
 * A string as IMAP wants it: quoted when it can be, a literal when it can't.
 *
 * The quoting is the injection boundary. A search term containing `"` would
 * otherwise close the string and let the rest be read as command syntax — with
 * the user's live IMAP session on the other end. CR/LF is already refused by
 * the shared schema; this handles everything else.
 */
function astring(value: string): Arg {
  if (/^[\x20-\x7e]*$/.test(value) && !value.includes("{")) {
    return `"${value.replace(/([\\"])/g, "\\$1")}"`;
  }
  return { literal: value };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

class ImapConnection {
  private buf = new Uint8Array(0);
  private tag = 0;

  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly writer: WritableStreamDefaultWriter<Uint8Array>,
  ) {}

  private async fill(): Promise<void> {
    const { value, done } = await this.reader.read();
    if (done || !value) throw new ImapError("The mail server closed the connection.", "network");
    const next = new Uint8Array(this.buf.length + value.length);
    next.set(this.buf);
    next.set(value, this.buf.length);
    this.buf = next;
  }

  private async readLine(): Promise<string> {
    for (;;) {
      for (let i = 0; i + 1 < this.buf.length; i++) {
        if (this.buf[i] === 13 && this.buf[i + 1] === 10) {
          const line = binaryString(this.buf.subarray(0, i));
          this.buf = this.buf.slice(i + 2);
          return line;
        }
      }
      if (this.buf.length > MAX_RESPONSE_BYTES) {
        throw new ImapError("The mail server sent more data than we will read.");
      }
      await this.fill();
    }
  }

  private async readBytes(n: number): Promise<string> {
    while (this.buf.length < n) await this.fill();
    const out = binaryString(this.buf.subarray(0, n));
    this.buf = this.buf.slice(n);
    return out;
  }

  /** One logical response: a line, with any literals spliced in where their
   *  `{n}` marker sits, so the parser can slice them back out by length. */
  private async readResponse(): Promise<string> {
    let out = await this.readLine();
    for (;;) {
      const m = /\{(\d+)\}$/.exec(out);
      if (!m) return out;
      const n = Number(m[1]);
      if (n > MAX_RESPONSE_BYTES || out.length + n > MAX_RESPONSE_BYTES) {
        throw new ImapError("The mail server sent more data than we will read.");
      }
      out += (await this.readBytes(n)) + (await this.readLine());
    }
  }

  private async write(text: string): Promise<void> {
    await this.writer.write(encoder.encode(text));
  }

  async greeting(): Promise<void> {
    const line = await this.readResponse();
    if (/^\* (OK|PREAUTH)/i.test(line)) return;
    throw new ImapError("The mail server refused the connection.", "network");
  }

  /**
   * Run one command; return its untagged response lines.
   *
   * A NO/BAD becomes an ImapError carrying the server's own text, truncated.
   * That text is safe to surface — it describes the command, not the
   * credential — and without it an authentication failure is indistinguishable
   * from a missing mailbox.
   */
  async command(args: Arg[]): Promise<string[]> {
    const tag = `a${++this.tag}`;
    let pending = `${tag} `;

    for (const arg of args) {
      if (typeof arg === "string") {
        pending += arg;
        continue;
      }
      const bytes = encoder.encode(arg.literal);
      await this.write(`${pending}{${bytes.length}}\r\n`);
      pending = "";
      // Untagged responses may arrive before the continuation; skip them.
      for (;;) {
        const line = await this.readResponse();
        if (line.startsWith("+")) break;
        if (!line.startsWith("*")) throw new ImapError("The mail server refused the command.");
      }
      await this.writer.write(bytes);
    }

    await this.write(`${pending}\r\n`);

    const lines: string[] = [];
    for (;;) {
      const line = await this.readResponse();
      if (line.startsWith(`${tag} `)) {
        const rest = line.slice(tag.length + 1);
        if (/^OK\b/i.test(rest)) return lines;
        throw new ImapError(rest.slice(0, 200).trim() || "The mail server rejected the request.");
      }
      lines.push(line);
    }
  }
}

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------


/** The criteria, as IMAP SEARCH arguments. */
function searchArgs(criteria: MailCriteria): { args: Arg[]; nonAscii: boolean } {
  // UNDELETED, always and first. A message flagged \Deleted has been deleted in
  // another client and is waiting for an expunge; showing it means offering to
  // open mail the user believes is gone. It also makes the key list never empty,
  // so the old `ALL` fallback — an empty search key list is a syntax error, not
  // "everything" — has nothing left to guard.
  const args: Arg[] = ["UNDELETED "];
  let nonAscii = false;
  // One key per term. Adjacent IMAP search keys are ANDed, so `FROM "Manda"
  // FROM "Contact"` is "both", which is what a multi-word query means.
  const terms = (key: string, values: string[] | undefined) => {
    for (const value of values ?? []) {
      if (!/^[\x00-\x7f]*$/.test(value)) nonAscii = true;
      args.push(`${key} `, astring(value), " ");
    }
  };
  terms("FROM", criteria.from);
  terms("TO", criteria.to);
  terms("SUBJECT", criteria.subject);
  terms("TEXT", criteria.text);
  if (criteria.since) args.push(`SINCE ${criteria.since} `);
  if (criteria.before) args.push(`BEFORE ${criteria.before} `);
  if (criteria.unseen) args.push("UNSEEN ");
  // `UID n:*` — everything that arrived since we last looked. The number is a
  // validated integer, so it is interpolated rather than quoted; IMAP has no
  // quoted form for a sequence set anyway.
  if (criteria.uid_min) args.push(`UID ${Math.floor(criteria.uid_min)}:* `);

  // NO TRAILING SPACE BEFORE THE CRLF. Each term above appends its own
  // separator, which leaves one dangling on the last of them, and iCloud
  // answers `BAD Parse Error` to `UID SEARCH UNSEEN ` — the space is a token
  // boundary promising a search key that never arrives.
  const last = args[args.length - 1];
  if (typeof last === "string" && last.endsWith(" ")) {
    const trimmed = last.replace(/ +$/, "");
    // A bare separator after a literal has nothing left once trimmed.
    if (trimmed) args[args.length - 1] = trimmed;
    else args.pop();
  }
  return { args, nonAscii };
}



/**
 * One message: ask what it is made of, then fetch only what is worth having.
 *
 * The old single command was `BODY.PEEK[]<0.262144>` — the first 256 KB of the
 * whole raw message, attachments included. That downloads a PDF in order to
 * throw it away, and it can *lose the body entirely*: MIME parts arrive in the
 * order the sender chose, so a 10 MB image ahead of the text meant the text was
 * past the cap and the message opened blank.
 *
 * `BODYSTRUCTURE` is the server's own parse of the MIME tree and costs no body
 * bytes, so asking first is nearly free — the second command rides the same
 * connection, which is already open and already authenticated.
 *
 * Two paths out of it, and the split is deliberate:
 *   - **small** (or a structure we could not read) — take the whole message as
 *     before and let the client's whole-message walker handle it. That walker
 *     is the tested one, and it stays on the common path so a bug in the new
 *     code cannot reach ordinary mail.
 *   - **large** — fetch the one text part the structure names. Attachments are
 *     still listed, with their real names, types and sizes, without a byte of
 *     them crossing the wire.
 */
async function fetchMessage(conn: ImapConnection, uid: number) {
  const message = parseFetch(await conn.command([
    `UID FETCH ${uid} (UID FLAGS INTERNALDATE RFC822.SIZE BODYSTRUCTURE ` +
    `BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS})])`,
  ]))[0];
  if (!message) throw new ImapError("That message no longer exists.");

  const size = message.size ?? 0;
  const structure = message.structure ?? [];
  // An unreadable structure is not fatal: fall back to the path that was here
  // before, which needs nothing from the server but the bytes.
  const whole = structure.length === 0 || (size > 0 && size <= MAIL_SMALL_MESSAGE_BYTES);

  if (whole) {
    const body = parseFetch(await conn.command([
      `UID FETCH ${uid} (UID BODY.PEEK[]<0.${MAIL_MAX_BODY_BYTES}>)`,
    ]))[0];
    message.raw = body?.raw ?? "";
    message.truncated = size > MAIL_MAX_BODY_BYTES;
    return message;
  }

  const text = chooseTextPart(structure);
  if (!text) {
    // A message that is nothing but attachments. Its structure still describes
    // them, so there is something to show; there is just no body to fetch.
    message.truncated = false;
    return message;
  }

  const body = parseFetch(await conn.command([
    `UID FETCH ${uid} (UID BODY.PEEK[${text.part}]<0.${MAIL_MAX_BODY_BYTES}>)`,
  ]))[0];
  message.part = {
    part: text.part,
    type: `${text.type}/${text.subtype}`,
    encoding: text.encoding,
    charset: text.params.charset ?? null,
    body: body?.partBody ?? "",
  };
  message.truncated = (text.size ?? 0) > MAIL_MAX_BODY_BYTES;
  return message;
}

/** Headers for a set of uids. One command; the caller decides which uids. */
async function fetchHeaders(conn: ImapConnection, uids: number[]) {
  if (uids.length === 0) return [];
  const messages = parseFetch(await conn.command([
    `UID FETCH ${uids.join(",")} (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS})])`,
  ]));
  // A message deleted since the uid list was taken simply comes back missing.
  // That is the whole reason paging over a uid snapshot is safe: there is no
  // offset to shift, so a gap is a gap and never a duplicated or skipped row.
  messages.sort((a, b) => b.uid - a.uid);
  return messages;
}

async function runOp(conn: ImapConnection, op: MailOp): Promise<MailOpResult> {
  if (op.op === "list") {
    return { op: "list", folders: parseFolders(await conn.command(['LIST "" "*"'])) };
  }

  // STATUS is the one op that must NOT open the mailbox: the RFC discourages
  // STATUS on a selected mailbox, and there is nothing to gain from EXAMINE
  // here — the whole point is a single command carrying no message data.
  if (op.op === "status") {
    return {
      op: "status",
      // UIDVALIDITY rides along: it is what makes the freshness check able to
      // say "everything you remember about this mailbox is now meaningless",
      // which no comparison of counts could ever detect.
      ...parseStatus(await conn.command([
        "STATUS ", astring(op.mailbox), " (UIDVALIDITY UIDNEXT MESSAGES UNSEEN)",
      ])),
    };
  }

  // Read-only. The server enforces it from here on — see the header note.
  // EXAMINE also volunteers UIDNEXT and EXISTS, which is the freshness baseline
  // for free: a later STATUS can be compared against it without this call
  // having paid for a second round trip.
  const examine = parseExamine(await conn.command(["EXAMINE ", astring(op.mailbox)]));

  const uidvalidity = examine.uidvalidity;
  if (op.op === "fetch") {
    return { op: "fetch", uidvalidity, message: await fetchMessage(conn, op.uid) };
  }
  if (op.op === "headers") {
    return { op: "headers", uidvalidity, messages: await fetchHeaders(conn, op.uids) };
  }

  const { args, nonAscii } = searchArgs(op.criteria);
  const found = parseUids(await conn.command([
    "UID SEARCH ",
    // CHARSET is required before non-ASCII search keys, and rejected by some
    // servers when there are none — so it is sent only when it is needed.
    ...(nonAscii ? ["CHARSET UTF-8 " as Arg] : []),
    ...args,
  ]));

  // Newest last in a UID search, and newest is what a person means by "my
  // mail" — so both the cap and the first page come off the end. Handing back
  // the whole (capped) list rather than just the page is what lets the client
  // page backwards without asking the server to run the query again.
  const uids = found.slice(-MAIL_MAX_UIDS).reverse();
  return {
    op: "search",
    total: found.length,
    truncated: found.length > uids.length,
    uidvalidity,
    uids,
    uidnext: examine.uidnext,
    exists: examine.exists,
    messages: await fetchHeaders(conn, uids.slice(0, op.limit)),
  };
}

/**
 * Open a TLS socket, run one op, log out.
 *
 * The socket is always closed, including on the deadline path — a Worker that
 * leaks a connection to iCloud leaks it with a credential attached.
 */
export async function runImapOp(op: MailOp): Promise<MailOpResult> {
  // `secureTransport: "on"` is implicit TLS, which is what port 993 is; the
  // STARTTLS form on 143 would put the credential a downgrade away.
  const socket = connect(
    { hostname: op.host, port: op.port },
    { secureTransport: "on", allowHalfOpen: false },
  );
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const conn = new ImapConnection(reader, writer);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ImapError("The mail server took too long to answer.", "network")),
      DEADLINE_MS,
    );
  });

  try {
    return await Promise.race([
      (async () => {
        await conn.greeting();
        try {
          await conn.command(["LOGIN ", astring(op.user), " ", astring(op.pass)]);
        } catch (e) {
          // The server's own text is KEPT — see `login_error` in
          // src-tauri/src/mail.rs for why swallowing it was a mistake. Apple's
          // refusal describes the attempt, never the credential.
          throw new ImapError(
            `Apple rejected the sign-in: ${e instanceof Error ? e.message : "no reason given"}. ` +
            "Two things to check: the password must be an app-specific password, not your Apple ID " +
            "password; and the username must be your @icloud.com address — iCloud Mail does not accept " +
            "a non-Apple Apple ID here even though Calendar does.",
            "auth",
          );
        }
        const result = await runOp(conn, op);
        await conn.command(["LOGOUT"]).catch(() => {
          /* the answer is already in hand; a rude goodbye is not an error */
        });
        return result;
      })(),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try {
      reader.releaseLock();
      writer.releaseLock();
      await socket.close();
    } catch {
      /* already closed, or closing while a read is pending — nothing to do */
    }
  }
}
