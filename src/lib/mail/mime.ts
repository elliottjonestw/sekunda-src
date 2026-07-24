import type { ImapBodyPart } from "@secondbrain/shared";
import type { MailAddress, MailAttachment } from "./types";

/**
 * Turning raw internet mail into text, once, on the client.
 *
 * This is the reason both executors — the Rust command and the Worker relay —
 * return raw bytes rather than parsed messages: RFC 2047 encoded words, MIME
 * multipart walking, transfer encodings and charsets are a great deal of fiddly
 * behaviour, and two implementations of it would be two sets of bugs and a
 * desktop build that disagrees with the web build about what an email says.
 *
 * Everything here takes a BINARY STRING — one JavaScript code unit per byte of
 * the wire — because a message declares its own charset in a header that has to
 * be read before the bytes can be decoded. Decoding to UTF-8 in the transport
 * would corrupt every message that isn't UTF-8, irreversibly.
 */

/** Bytes back out of a binary string, for a real decoder to interpret. */
function toBytes(binary: string): Uint8Array {
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Decode bytes in whatever charset the part claimed.
 *
 * An unknown or misspelled charset falls back to UTF-8 rather than throwing —
 * `TextDecoder` rejects labels it doesn't know, and a message that arrives as
 * mojibake is still readable, where one that throws takes the whole search
 * result with it.
 */
function decodeBytes(bytes: Uint8Array, charset: string): string {
  const label = charset.trim().toLowerCase() || "utf-8";
  try {
    return new TextDecoder(label, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

/**
 * Base64 to bytes, tolerant of a stream that was cut mid-quantum.
 *
 * `atob` throws on a length that isn't a multiple of four, which matters now
 * that a part can arrive truncated at an arbitrary byte offset: without the
 * trim, a body one character past a boundary decodes to nothing at all rather
 * than to almost all of itself. Dropping the ragged tail loses at most two
 * characters of text.
 */
function decodeBase64(binary: string): string {
  const clean = binary.replace(/[^A-Za-z0-9+/=]/g, "");
  const whole = clean.slice(0, clean.length - (clean.length % 4));
  try {
    return atob(whole);
  } catch {
    return "";
  }
}

function decodeQuotedPrintable(text: string): string {
  return text
    .replace(/=\r?\n/g, "") // soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

/**
 * RFC 2047 encoded words: `=?UTF-8?B?…?=` / `=?ISO-8859-1?Q?…?=`.
 *
 * Adjacent encoded words separated only by whitespace are joined with the
 * whitespace removed — that rule is not decoration: a long CJK subject is split
 * across several words at arbitrary byte boundaries, and keeping the separators
 * inserts spaces into the middle of the sentence.
 */
export function decodeWords(text: string): string {
  return text
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)(\s+)(?==\?)/g, "$1")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset: string, encoding: string, data: string) => {
      const binary = encoding.toUpperCase() === "B"
        ? decodeBase64(data)
        // In Q encoding, and ONLY in headers, `_` stands for a space.
        : decodeQuotedPrintable(data.replace(/_/g, " "));
      const decoded = decodeBytes(toBytes(binary), charset);
      return decoded || whole;
    });
}

export type Headers = Map<string, string[]>;

/**
 * Split a header block, unfolding continuation lines.
 *
 * Values are kept RAW (still encoded, still with their parameters) — callers
 * decode what they need. Folding matters more than it looks: a `Subject` that
 * wraps is one header, and treating the second line as a new one loses half the
 * subject and can turn the remainder into a header name that shadows a real
 * one.
 */
export function parseHeaders(block: string): Headers {
  const headers: Headers = new Map();
  const lines = block.replace(/\r\n/g, "\n").split("\n");
  let current = "";
  const flush = () => {
    const colon = current.indexOf(":");
    if (colon > 0) {
      const name = current.slice(0, colon).trim().toLowerCase();
      const value = current.slice(colon + 1).trim();
      const existing = headers.get(name);
      if (existing) existing.push(value);
      else headers.set(name, [value]);
    }
    current = "";
  };
  for (const line of lines) {
    if (!line.trim()) { flush(); break; } // blank line ends the header block
    if (/^[ \t]/.test(line) && current) current += ` ${line.trim()}`;
    else { flush(); current = line; }
  }
  flush();
  return headers;
}

export function header(headers: Headers, name: string): string {
  return headers.get(name.toLowerCase())?.[0] ?? "";
}

/**
 * A `type/subtype; key=value` header, split into its parts.
 *
 * Handles quoted parameter values; does NOT handle RFC 2231 continuations
 * (`filename*0=`), which only show up on very long attachment names — the cost
 * there is a truncated filename in a list the user cannot download from anyway.
 */
export function parseContentType(value: string): { type: string; params: Record<string, string> } {
  const [head, ...rest] = value.split(";");
  const params: Record<string, string> = {};
  for (const part of rest) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let raw = part.slice(eq + 1).trim();
    if (raw.startsWith('"')) raw = raw.slice(1, raw.lastIndexOf('"') > 0 ? raw.lastIndexOf('"') : undefined);
    params[key] = decodeWords(raw);
  }
  return { type: head.trim().toLowerCase(), params };
}

/**
 * An address-list header into addresses.
 *
 * Split on commas that are outside quotes and outside angle brackets: a display
 * name is very often `"Surname, Given"`, and splitting naively turns one
 * contact into two, one of which has no address at all.
 */
export function parseAddresses(value: string): MailAddress[] {
  if (!value.trim()) return [];
  const parts: string[] = [];
  let buf = "";
  let inQuotes = false;
  let inAngle = false;
  for (const ch of value) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "<") inAngle = true;
    else if (ch === ">") inAngle = false;
    if (ch === "," && !inQuotes && !inAngle) { parts.push(buf); buf = ""; continue; }
    buf += ch;
  }
  parts.push(buf);

  const out: MailAddress[] = [];
  for (const part of parts) {
    const text = part.trim();
    if (!text) continue;
    const angle = /^(.*)<([^>]*)>$/.exec(text);
    const name = angle ? decodeWords(angle[1].trim().replace(/^"|"$/g, "")).trim() : "";
    const address = (angle ? angle[2] : text).trim();
    if (!address) continue;
    out.push({ name: name || null, address });
  }
  return out;
}

/**
 * The message's own `Date` header, or the server's INTERNALDATE, as ISO.
 *
 * INTERNALDATE arrives in IMAP's own syntax (`21-Jul-2026 10:00:00 +0800`),
 * which `Date` cannot parse until the day-month-year hyphens become spaces.
 * Both are normalized here — the one place that knows both formats.
 */
export function parseMailDate(dateHeader: string, internalDate: string | null): string | null {
  const candidates = [
    dateHeader,
    internalDate ? internalDate.replace(/^(\d{1,2})-(\w{3})-(\d{4})/, "$1 $2 $3") : "",
  ];
  for (const candidate of candidates) {
    if (!candidate.trim()) continue;
    const d = new Date(candidate.trim());
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/**
 * HTML to something speakable.
 *
 * Not a renderer and not a sanitizer — the output is plain text that never goes
 * near `dangerouslySetInnerHTML` or the Markdown pipeline. Scripts and styles
 * are dropped whole because their *contents* would otherwise survive as text,
 * which is how a "plain text" summary ends up reciting CSS.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, " ")
    // Tags become spaces, so every line that had markup around it now starts or
    // ends with one — trim per line, not just at the ends of the message.
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Undo the transfer encoding, then the charset. Order is not optional: base64
 *  yields bytes, and only then does the charset mean anything. */
function decodePart(body: string, encoding: string, charset: string): string {
  const enc = encoding.trim().toLowerCase();
  const binary = enc === "base64" ? decodeBase64(body)
    : enc === "quoted-printable" ? decodeQuotedPrintable(body)
      : body;
  return decodeBytes(toBytes(binary), charset);
}

interface Walked {
  text: string;
  attachments: MailAttachment[];
}

/**
 * Walk one MIME part.
 *
 * The rules, in the order they matter:
 *  - `multipart/alternative` — take the RICHEST readable part, preferring
 *    text/plain. Concatenating the alternatives would print the same message
 *    twice, once as prose and once as flattened HTML.
 *  - any other multipart — concatenate, because those parts are different
 *    pieces of one message rather than versions of it.
 *  - an explicit `attachment` disposition, or any non-text leaf — listed, never
 *    decoded. There is no download path, and decoding a 4 MB PDF into a string
 *    to throw it away is the kind of thing that only shows up under load.
 */
function walkPart(raw: string, depth: number): Walked {
  // Nesting is bounded: a hand-crafted message can nest multiparts far enough
  // to blow the stack, and nothing legitimate goes past a handful.
  if (depth > 10) return { text: "", attachments: [] };

  const split = /\r?\n\r?\n/.exec(raw);
  const headers = parseHeaders(split ? raw.slice(0, split.index) : raw);
  const body = split ? raw.slice(split.index + split[0].length) : "";

  const { type, params } = parseContentType(header(headers, "content-type") || "text/plain");
  const disposition = parseContentType(header(headers, "content-disposition"));
  const encoding = header(headers, "content-transfer-encoding");
  const filename = disposition.params.filename ?? params.name ?? null;

  if (type.startsWith("multipart/")) {
    const boundary = params.boundary;
    if (!boundary) return { text: "", attachments: [] };
    // Split on the boundary, dropping the preamble and the closing epilogue.
    // Non-capturing: `String.split` interleaves capture groups into its result,
    // so a `(--)?` here inserts an `undefined` between every part.
    const sections = body.split(
      new RegExp(`\r?\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?\r?\n?`),
    );
    const parts = sections.slice(1, -1).map((section) => walkPart(section, depth + 1));

    if (type === "multipart/alternative") {
      const plain = parts.find((p) => p.text.trim());
      return {
        text: plain?.text ?? "",
        attachments: parts.flatMap((p) => p.attachments),
      };
    }
    return {
      text: parts.map((p) => p.text).filter(Boolean).join("\n\n"),
      attachments: parts.flatMap((p) => p.attachments),
    };
  }

  const isAttachment = disposition.type === "attachment" || (!!filename && !type.startsWith("text/"));
  if (isAttachment || !type.startsWith("text/")) {
    return {
      text: "",
      // No part number: this walker works from the bytes, which carry no
      // numbering. `attachmentsFromStructure` is the path that has one, and it
      // is preferred whenever the server gave us a BODYSTRUCTURE.
      attachments: [{ part: null, filename, content_type: type || "application/octet-stream", size: body.length || null }],
    };
  }

  const text = decodePart(body, encoding, params.charset ?? "utf-8");
  return { text: type === "text/html" ? htmlToText(text) : text.trim(), attachments: [] };
}

/**
 * A whole raw message: its headers, its readable text, and what was attached.
 *
 * `multipart/alternative` prefers text/plain by ordering — the plain part comes
 * first in a well-formed message, and `walkPart` takes the first part that
 * produced any text, so an HTML-only message still yields its converted text
 * rather than nothing.
 */
export function parseMessage(raw: string): { headers: Headers; text: string; attachments: MailAttachment[] } {
  const split = /\r?\n\r?\n/.exec(raw);
  const headers = parseHeaders(split ? raw.slice(0, split.index) : raw);
  const { text, attachments } = walkPart(raw, 0);
  return { headers, text: text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), attachments };
}

// ---------------------------------------------------------------------------
// The BODYSTRUCTURE path
//
// Everything above walks a whole raw message. These two take the server's own
// description of the MIME tree instead, which is what makes it possible to open
// a message with a 10 MB attachment without downloading the attachment.
// ---------------------------------------------------------------------------

/**
 * One part that was fetched on its own, as readable text.
 *
 * The same two steps `decodePart` does — transfer encoding, then charset — plus
 * the HTML flattening `walkPart` would have applied. It is a separate entry
 * point rather than a reuse of the walker because there is no message around
 * these bytes: the type and charset came from BODYSTRUCTURE, not from headers
 * that are present.
 */
export function decodeStandalonePart(
  body: string,
  encoding: string,
  charset: string | null,
  contentType: string,
): string {
  const text = decodePart(body, encoding, charset ?? "utf-8");
  return contentType.trim().toLowerCase() === "text/html" ? htmlToText(text) : text.trim();
}

/**
 * The attachment list, from the structure rather than from the bytes.
 *
 * Better than the walker's list in the two ways that were actually wrong:
 * sizes are the server's own count rather than however much of the part
 * survived truncation, and an attached `message/rfc822` appears as one item
 * instead of as whatever its innards happened to look like.
 *
 * What counts as an attachment, in order:
 *  - never a part inside an attached message — the attached message is the
 *    thing the user sees, and listing its parts alongside it lists the same
 *    bytes twice;
 *  - anything the sender marked `attachment`, or gave a filename;
 *  - anything that is not text. A `multipart/alternative`'s HTML twin is text
 *    with no filename and no disposition, so it correctly falls out here —
 *    it is a version of the message, not something attached to it.
 */
export function attachmentsFromStructure(parts: ImapBodyPart[]): MailAttachment[] {
  return parts
    .filter((p) => !p.embedded)
    .filter((p) => p.disposition === "attachment" || !!p.filename || p.type !== "text")
    .map((p) => ({
      part: p.part,
      filename: p.filename,
      content_type: `${p.type || "application"}/${p.subtype || "octet-stream"}`,
      size: p.size,
    }));
}
