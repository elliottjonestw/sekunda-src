import type { ImapBodyPart, ImapFolderResult, ImapMessageResult } from "@secondbrain/shared";

/**
 * The parsing half of the IMAP client: tokens in, meaning out.
 *
 * Split from `imap.ts` because that file imports `cloudflare:sockets` and so
 * can only run inside a Worker isolate, while everything here is a pure
 * function over a string. `BODYSTRUCTURE` is the most intricate thing in IMAP
 * and it is written twice in this repo — once here and once in
 * `src-tauri/src/mail.rs` — so being able to run it under `node --test` against
 * captured responses is not a nicety.
 *
 * Anything changed in this file has a counterpart in `mail.rs`.
 */

export class ImapError extends Error {
  constructor(message: string, readonly kind: "auth" | "network" | "protocol" = "protocol") {
    super(message);
    this.name = "ImapError";
  }
}

// ---------------------------------------------------------------------------
// Response tokens
// ---------------------------------------------------------------------------

export type Token = string | Token[];

/**
 * Parse an IMAP response into nested tokens.
 *
 * Atoms are bracket-aware: `BODY[HEADER.FIELDS (DATE SUBJECT)]` and
 * `BODY[]<0>` are each ONE token, not four, because the brackets can contain
 * both spaces and parentheses. Getting that wrong shifts every key/value pair
 * in a FETCH response by one and reads as "the server sent nothing".
 */
export function parseTokens(s: string, start: number): { items: Token[]; i: number } {
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

export function isList(t: Token | undefined): t is Token[] {
  return Array.isArray(t);
}

export function str(t: Token | undefined): string {
  return typeof t === "string" ? t : "";
}

/** An atom the server may have sent as `NIL`, which means "no value" and is not
 *  the three-letter string it looks like. */
function nilable(t: Token | undefined): string | null {
  const s = str(t);
  return !s || s.toUpperCase() === "NIL" ? null : s;
}

// ---------------------------------------------------------------------------
// BODYSTRUCTURE
//
// The grammar, because reading it off RFC 3501 §7.4.2 every time is how the
// index arithmetic below goes wrong:
//
//   multipart:  (<part> <part> … subtype (params) disposition language location)
//               — one or more nested part LISTS, then the subtype STRING. The
//                 leading run of lists is what distinguishes it from a leaf,
//                 whose first element is the type string.
//
//   leaf:       (type subtype (params) id description encoding size …)
//                 0    1        2      3  4           5        6
//               then, by type:
//                 text/*            7 = line count, extensions from 8
//                 message/rfc822    7 = envelope, 8 = the NESTED bodystructure,
//                                   9 = line count, extensions from 10
//                 anything else     extensions from 7
//               extensions are: md5, disposition, language, location — so the
//               disposition sits one past wherever they start.
// ---------------------------------------------------------------------------

/** Nesting bound. A hand-crafted message can nest multiparts far enough to blow
 *  the stack, and nothing legitimate goes past a handful. */
const MAX_DEPTH = 10;

function paramList(t: Token | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isList(t)) return out;
  for (let i = 0; i + 1 < t.length; i += 2) {
    const key = str(t[i]).toLowerCase();
    const value = nilable(t[i + 1]);
    if (key && value !== null) out[key] = value;
  }
  return out;
}

function dispositionOf(t: Token | undefined): { type: string | null; params: Record<string, string> } {
  if (!isList(t)) return { type: null, params: {} };
  return { type: nilable(t[0])?.toLowerCase() ?? null, params: paramList(t[1]) };
}

/**
 * Flatten a BODYSTRUCTURE into its leaves, each with the part number that names
 * it.
 *
 * `node` is the *body of a message* whose own part number is `prefix` (empty at
 * the top level). That framing is what makes the `message/rfc822` case fall out
 * for free: RFC 3501 §6.4.5 numbers the parts inside an attached message as the
 * attachment's number, a period, and the numbering that message would have had
 * on its own — which is precisely this function again with a new prefix.
 */
export function parseBodyStructure(node: Token, prefix = "", embedded = false, depth = 0): ImapBodyPart[] {
  // An empty list is not a part with empty fields — it is a server saying
  // nothing, and inventing a leaf out of it would put a nameless zero-byte
  // attachment on the message.
  if (!isList(node) || node.length === 0 || depth > MAX_DEPTH) return [];
  const out: ImapBodyPart[] = [];
  if (isList(node[0])) {
    // Multipart: its children are 1..n under this prefix. The multipart itself
    // is never emitted — it is structure, and there is nothing to do with it.
    let i = 0;
    while (i < node.length && isList(node[i])) {
      out.push(...walkPart(node[i], prefix ? `${prefix}.${i + 1}` : `${i + 1}`, embedded, depth + 1));
      i++;
    }
    return out;
  }
  // A message with no multipart at all still has one part, numbered 1.
  return walkPart(node, prefix ? `${prefix}.1` : "1", embedded, depth + 1);
}

function walkPart(node: Token, part: string, embedded: boolean, depth: number): ImapBodyPart[] {
  if (!isList(node) || node.length === 0 || depth > MAX_DEPTH) return [];
  if (isList(node[0])) {
    const out: ImapBodyPart[] = [];
    let i = 0;
    while (i < node.length && isList(node[i])) {
      out.push(...walkPart(node[i], `${part}.${i + 1}`, embedded, depth + 1));
      i++;
    }
    return out;
  }

  const type = str(node[0]).toLowerCase();
  const subtype = str(node[1]).toLowerCase();
  const params = paramList(node[2]);
  const encoding = (nilable(node[5]) ?? "").toLowerCase();
  const size = Number(str(node[6]));

  const isMessage = type === "message" && subtype === "rfc822";
  const extensions = type === "text" ? 8 : isMessage ? 10 : 7;
  const disposition = dispositionOf(node[extensions + 1]);

  const leaf: ImapBodyPart = {
    part,
    type,
    subtype,
    params,
    encoding,
    size: Number.isFinite(size) && size >= 0 ? size : null,
    disposition: disposition.type,
    // The name lives in either place depending on the sending client, and
    // neither is more correct — Content-Disposition wins because it is the one
    // that means "this is a file".
    filename: disposition.params.filename ?? params.name ?? null,
    embedded,
  };

  // An attached message is BOTH a thing to list and a tree to look inside.
  if (isMessage) {
    return [leaf, ...parseBodyStructure(node[8], part, true, depth + 1)];
  }
  return [leaf];
}

/**
 * The part to show as the message's body.
 *
 * **This rule is written twice** — here and in `mail.rs` — because the choice
 * has to be made by whoever holds the connection, and a second round trip from
 * the client would be a second TLS handshake and a second login. So it is kept
 * deliberately blunt: type first, never position.
 *
 * Position is what the old whole-message walker used, and it is wrong for a
 * `multipart/alternative` whose HTML part comes first (§1.6). Preferring the
 * message's own text over an attached message's is the other half: a forwarded
 * email's body is not this email's body, but it is better than nothing, so it
 * is the fallback rather than the answer.
 */
export function chooseTextPart(parts: ImapBodyPart[]): ImapBodyPart | null {
  const readable = (p: ImapBodyPart) => p.type === "text" && p.disposition !== "attachment";
  const pick = (embedded: boolean, subtype: string) =>
    parts.find((p) => p.embedded === embedded && p.subtype === subtype && readable(p));
  return pick(false, "plain") ?? pick(false, "html") ?? pick(true, "plain") ?? pick(true, "html") ?? null;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export function parseFolders(lines: string[]): ImapFolderResult[] {
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

export function parseUids(lines: string[]): number[] {
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

/** A parsed FETCH, plus the one field that never leaves the executor: the bytes
 *  of an isolated part, which `runOp` pairs with the structure that describes
 *  them before anything is returned. */
export interface FetchResult extends ImapMessageResult {
  partBody?: string;
}

/**
 * Pull the key/value pairs out of `* n FETCH (…)`.
 *
 * The `BODY[…]` keys are matched by prefix and **in order of decreasing
 * specificity**: the server echoes back the section it was asked for, so
 * `BODY[HEADER.FIELDS (…)]`, `BODY[]<0>` and `BODY[2.1]<0>` all start `BODY[`
 * and mean three different things. Test the two specific forms before the
 * general one.
 */
export function parseFetch(lines: string[]): FetchResult[] {
  const out: FetchResult[] = [];
  for (const line of lines) {
    const { items } = parseTokens(line, 0);
    if (str(items[0]) !== "*" || str(items[2]).toUpperCase() !== "FETCH") continue;
    const body = items[3];
    if (!isList(body)) continue;

    const msg: FetchResult = { uid: 0, flags: [], internal_date: null, size: null };
    for (let i = 0; i + 1 < body.length; i += 2) {
      const key = str(body[i]).toUpperCase();
      const value = body[i + 1];
      if (key === "UID") msg.uid = Number(str(value)) || 0;
      else if (key === "FLAGS" && isList(value)) msg.flags = value.filter((f): f is string => typeof f === "string");
      else if (key === "INTERNALDATE") msg.internal_date = str(value) || null;
      else if (key === "RFC822.SIZE") msg.size = Number(str(value)) || null;
      else if (key === "BODYSTRUCTURE" || key === "BODY") msg.structure = parseBodyStructure(value);
      else if (key.startsWith("BODY[HEADER")) msg.headers = str(value);
      else if (key.startsWith("BODY[]")) msg.raw = str(value);
      else if (key.startsWith("BODY[")) msg.partBody = str(value);
    }
    if (msg.uid > 0) out.push(msg);
  }
  return out;
}
