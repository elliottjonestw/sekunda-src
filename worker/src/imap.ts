import { connect } from "cloudflare:sockets";
import {
  MAIL_MAX_BODY_BYTES,
  type ImapFolderResult,
  type ImapMessageResult,
  type MailCriteria,
  type MailOp,
  type MailOpResult,
} from "@secondbrain/shared";

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

export class ImapError extends Error {
  constructor(message: string, readonly kind: "auth" | "network" | "protocol" = "protocol") {
    super(message);
    this.name = "ImapError";
  }
}

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
// Response tokens
// ---------------------------------------------------------------------------

type Token = string | Token[];

/**
 * Parse an IMAP response into nested tokens.
 *
 * Atoms are bracket-aware: `BODY[HEADER.FIELDS (DATE SUBJECT)]` and
 * `BODY[]<0>` are each ONE token, not four, because the brackets can contain
 * both spaces and parentheses. Getting that wrong shifts every key/value pair
 * in a FETCH response by one and reads as "the server sent nothing".
 */
function parseTokens(s: string, start: number): { items: Token[]; i: number } {
  const items: Token[] = [];
  let i = start;
  while (i < s.length) {
    const c = s[i];
    if (c === " ") { i++; continue; }
    if (c === ")") { i++; break; }
    if (c === "(") {
      const inner = parseTokens(s, i + 1);
      items.push(inner.items);
      i = inner.i;
      continue;
    }
    if (c === '"') {
      let out = "";
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\") i++;
        out += s[i];
        i++;
      }
      i++;
      items.push(out);
      continue;
    }
    if (c === "{") {
      // The literal's bytes sit immediately after the marker — see readResponse.
      const close = s.indexOf("}", i);
      if (close < 0) throw new ImapError("Malformed response from the mail server.");
      const n = Number(s.slice(i + 1, close));
      const from = close + 1;
      items.push(s.slice(from, from + n));
      i = from + n;
      continue;
    }
    let atom = "";
    while (i < s.length && !" ()".includes(s[i])) {
      if (s[i] === "[") {
        let depth = 0;
        do {
          if (s[i] === "[") depth++;
          else if (s[i] === "]") depth--;
          atom += s[i];
          i++;
        } while (i < s.length && depth > 0);
        continue;
      }
      atom += s[i];
      i++;
    }
    items.push(atom);
  }
  return { items, i };
}

function isList(t: Token | undefined): t is Token[] {
  return Array.isArray(t);
}

function str(t: Token | undefined): string {
  return typeof t === "string" ? t : "";
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

function parseFolders(lines: string[]): ImapFolderResult[] {
  const folders: ImapFolderResult[] = [];
  for (const line of lines) {
    const { items } = parseTokens(line, 0);
    if (str(items[0]) !== "*" || str(items[1]).toUpperCase() !== "LIST") continue;
    const flags = isList(items[2]) ? items[2].filter((f): f is string => typeof f === "string") : [];
    const delimiter = str(items[3]) === "NIL" ? "" : str(items[3]);
    const name = str(items[4]);
    if (!name) continue;
    // \Noselect names a hierarchy node that cannot be opened. Offering it as a
    // searchable mailbox produces a failure the user can do nothing about.
    if (flags.some((f) => f.toLowerCase() === "\\noselect")) continue;
    folders.push({ name, delimiter, flags });
  }
  return folders;
}

/** The criteria, as IMAP SEARCH arguments. `ALL` when nothing was asked for —
 *  an empty search key list is a syntax error, not "everything". */
function searchArgs(criteria: MailCriteria): { args: Arg[]; nonAscii: boolean } {
  const args: Arg[] = [];
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
  if (args.length === 0) args.push("ALL");

  // NO TRAILING SPACE BEFORE THE CRLF. Each term above appends its own
  // separator, which leaves one dangling on the last of them, and iCloud
  // answers `BAD Parse Error` to `UID SEARCH UNSEEN ` — the space is a token
  // boundary promising a search key that never arrives. `ALL` was the only
  // branch that didn't append one, which is why an unfiltered list worked and
  // every filter failed.
  const last = args[args.length - 1];
  if (typeof last === "string" && last.endsWith(" ")) {
    const trimmed = last.replace(/ +$/, "");
    // A bare separator after a literal has nothing left once trimmed.
    if (trimmed) args[args.length - 1] = trimmed;
    else args.pop();
  }
  return { args, nonAscii };
}

function parseUids(lines: string[]): number[] {
  const uids: number[] = [];
  for (const line of lines) {
    const { items } = parseTokens(line, 0);
    if (str(items[0]) !== "*" || str(items[1]).toUpperCase() !== "SEARCH") continue;
    for (const t of items.slice(2)) {
      const n = Number(str(t));
      if (Number.isInteger(n) && n > 0) uids.push(n);
    }
  }
  return uids;
}

/** Pull the key/value pairs out of `* n FETCH (…)`. Keys are matched by prefix
 *  because the body key carries its own section and octet range. */
function parseFetch(lines: string[]): ImapMessageResult[] {
  const out: ImapMessageResult[] = [];
  for (const line of lines) {
    const { items } = parseTokens(line, 0);
    if (str(items[0]) !== "*" || str(items[2]).toUpperCase() !== "FETCH") continue;
    const body = items[3];
    if (!isList(body)) continue;

    const msg: ImapMessageResult = { uid: 0, flags: [], internal_date: null, size: null };
    for (let i = 0; i + 1 < body.length; i += 2) {
      const key = str(body[i]).toUpperCase();
      const value = body[i + 1];
      if (key === "UID") msg.uid = Number(str(value)) || 0;
      else if (key === "FLAGS" && isList(value)) msg.flags = value.filter((f): f is string => typeof f === "string");
      else if (key === "INTERNALDATE") msg.internal_date = str(value) || null;
      else if (key === "RFC822.SIZE") msg.size = Number(str(value)) || null;
      else if (key.startsWith("BODY[HEADER")) msg.headers = str(value);
      else if (key.startsWith("BODY[]")) msg.raw = str(value);
    }
    if (msg.uid > 0) out.push(msg);
  }
  return out;
}

async function runOp(conn: ImapConnection, op: MailOp): Promise<MailOpResult> {
  if (op.op === "list") {
    return { op: "list", folders: parseFolders(await conn.command(['LIST "" "*"'])) };
  }

  // Read-only. The server enforces it from here on — see the header note.
  await conn.command(["EXAMINE ", astring(op.mailbox)]);

  if (op.op === "fetch") {
    const lines = await conn.command([
      `UID FETCH ${op.uid} (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[]<0.${MAIL_MAX_BODY_BYTES}>)`,
    ]);
    const message = parseFetch(lines)[0];
    if (!message) throw new ImapError("That message no longer exists.");
    message.truncated = (message.size ?? 0) > MAIL_MAX_BODY_BYTES;
    return { op: "fetch", message };
  }

  const { args, nonAscii } = searchArgs(op.criteria);
  const uids = parseUids(await conn.command([
    "UID SEARCH ",
    // CHARSET is required before non-ASCII search keys, and rejected by some
    // servers when there are none — so it is sent only when it is needed.
    ...(nonAscii ? ["CHARSET UTF-8 " as Arg] : []),
    ...args,
  ]));

  // Newest last in a UID search, and newest is what a person means by "my
  // mail" — so the window comes off the end, not the start.
  const wanted = uids.slice(-op.limit);
  if (wanted.length === 0) return { op: "search", total: 0, truncated: false, messages: [] };

  const messages = parseFetch(await conn.command([
    `UID FETCH ${wanted.join(",")} (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS})])`,
  ]));
  messages.sort((a, b) => b.uid - a.uid);
  return { op: "search", total: uids.length, truncated: uids.length > wanted.length, messages };
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
