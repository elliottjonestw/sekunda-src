import type { ImapBodyPart } from "@secondbrain/shared";
import type { MailAddress, MailAttachment, MailLink } from "./types";

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

/**
 * A mailbox name out of IMAP's modified UTF-7 and into text.
 *
 * IMAP predates UTF-8 mailbox names, so a folder called 日本語 arrives on the
 * wire as `&ZeVnLIqe-` — which is what the picker was showing. The encoding is
 * base64 of UTF-16BE between `&` and `-`, with `,` standing in for `/` (which
 * is the hierarchy delimiter), and a bare `&-` meaning a literal ampersand.
 *
 * **For display only.** The raw name is what every later command must carry:
 * the server named the mailbox, and handing back a prettier version of it is
 * how you get "no such mailbox" for a folder that plainly exists.
 *
 * The base64 here is UNPADDED, so it cannot go through `decodeBase64` — that
 * one trims a ragged tail, which is right for a truncated message body and
 * exactly wrong here, where a six-character chunk is four real bytes.
 */
export function decodeMailboxName(name: string): string {
  return name.replace(/&([A-Za-z0-9+,]*)-/g, (whole, chunk: string) => {
    if (chunk === "") return "&";
    const b64 = chunk.replace(/,/g, "/");
    try {
      const bytes = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
      let out = "";
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        out += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1));
      }
      return out || whole;
    } catch {
      // Not actually an encoded run. Leaving it as it was is the only honest
      // answer — a folder whose name really does contain `&x-` is not an error.
      return whole;
    }
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
 * Split a structured header on the semicolons that are OUTSIDE quoted strings,
 * unquoting as it goes.
 *
 * `value.split(";")` cuts `filename="report; final.pdf"` in half, and on the
 * download path the half that survives is what gets written to disk. Boundaries
 * are the other victim: `boundary="----=_Part_1; 2"` is legal and splitting it
 * loses every part of the message.
 */
function splitParams(value: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quoted && ch === "\\" && i + 1 < value.length) { buf += value[++i]; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === ";" && !quoted) { parts.push(buf); buf = ""; continue; }
    buf += ch;
  }
  parts.push(buf);
  return parts;
}

/**
 * RFC 2231's charset-tagged, percent-encoded parameter: `UTF-8''%E6%97%A5.pdf`.
 *
 * The charset is part of the value rather than assumed, which is the whole
 * point of the form — a Latin-1 sender and a UTF-8 sender both use it and mean
 * different bytes. A value with no `'` separators is taken as already-plain
 * text, because a sender that wrote `filename*=report.pdf` meant `report.pdf`.
 */
function decodeExtended(value: string): string {
  const parts = value.split("'");
  const charset = parts.length >= 3 ? parts[0] : "";
  const encoded = parts.length >= 3 ? parts.slice(2).join("'") : value;
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === "%" && /^[0-9a-f]{2}$/i.test(encoded.slice(i + 1, i + 3))) {
      bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    bytes.push(encoded.charCodeAt(i) & 0xff);
  }
  return decodeBytes(Uint8Array.from(bytes), charset || "utf-8");
}

/**
 * A `type/subtype; key=value` header, split into its parts.
 *
 * **RFC 2231 is handled** — `filename*0=`/`filename*1=` continuations and
 * `filename*=UTF-8''%E6%97%A5.pdf` extended values, in either combination.
 * Senders reach for that form for long or non-ASCII names, which is exactly
 * when the name matters most: before this,
 * `filename*0="invoice-2026-"; filename*1="q3.pdf"` parsed as the truncated
 * `invoice-2026-`, and the download path saved a real file under it.
 *
 * Sections are gathered before any of them is decoded, because a section is
 * only a piece: a multi-byte character can be split across two of them, so
 * decoding each one alone produces two mojibake halves rather than one letter.
 *
 * RFC 2047 encoded words are still decoded for plain parameters — plenty of
 * senders use them here despite the spec preferring 2231 — but never for an
 * extended value, which has already been decoded and where a `=?…?=` is a
 * literal part of the name.
 */
export function parseContentType(value: string): { type: string; params: Record<string, string> } {
  const [head, ...rest] = splitParams(value);
  const plain: Record<string, string> = {};
  const sections = new Map<string, Map<number, string>>();
  const extended = new Set<string>();

  for (const part of rest) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const raw = part.slice(eq + 1).trim();
    const shape = /^([^*]+)(?:\*(\d+))?(\*)?$/.exec(key);
    if (!shape) continue;
    const [, name, section, star] = shape;
    if (section === undefined && !star) { plain[name] = raw; continue; }
    if (star) extended.add(name);
    const bySection = sections.get(name) ?? new Map<number, string>();
    bySection.set(section === undefined ? 0 : Number(section), raw);
    sections.set(name, bySection);
  }

  const params: Record<string, string> = {};
  for (const [name, raw] of Object.entries(plain)) params[name] = decodeWords(raw);
  // Written second so a continuation wins over a plain parameter of the same
  // name: a sender that provides both is offering the short one as a fallback.
  for (const [name, bySection] of sections) {
    const joined = [...bySection.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, raw]) => raw)
      .join("");
    params[name] = extended.has(name) ? decodeExtended(joined) : decodeWords(joined);
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
 *
 * `Date` is preferred because it is what every other mail client shows and what
 * the sender meant. But it is written by the *sender*, so it is also the one
 * field a spammer sets to next year to pin a message to the top of a list
 * sorted by date — and a misconfigured clock does the same thing by accident.
 * So it is preferred only while it is *plausible*; outside that, what the
 * server saw wins. Not a spam filter, just a refusal to be told anything.
 */
export function parseMailDate(dateHeader: string, internalDate: string | null): string | null {
  const server = internalDate
    ? isoOrNull(internalDate.replace(/^(\d{1,2})-(\w{3})-(\d{4})/, "$1 $2 $3"))
    : null;
  const claimed = isoOrNull(dateHeader);
  if (!claimed) return server;
  // A day's grace ahead of now covers a clock that is merely wrong rather than
  // lying; 1990 is comfortably before any mail anyone still has.
  const t = new Date(claimed).getTime();
  const plausible = t < Date.now() + 86_400_000 && t > Date.UTC(1990, 0, 1);
  return plausible || !server ? claimed : server;
}

function isoOrNull(value: string): string | null {
  if (!value.trim()) return null;
  const d = new Date(value.trim());
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  mdash: "—", ndash: "–", hellip: "…", bull: "•", middot: "·",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  copy: "©", reg: "®", trade: "™", deg: "°", times: "×",
  euro: "€", pound: "£", yen: "¥", cent: "¢",
};

/**
 * HTML entities to the characters they stand for.
 *
 * Its own function because the BODY is not the only thing that needs it: an
 * `href` is entity-encoded too, and a query string full of `&amp;` is a
 * different URL from the one the sender wrote. Getting that wrong on a
 * verification link produces a link that looks right and does not work.
 *
 * Each pass scans forward from the end of its own match, so `&amp;lt;` decodes
 * once to `&lt;` rather than twice to `<`.
 */
export function decodeEntities(text: string): string {
  const codePoint = (n: number) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "");
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, digits: string) => codePoint(Number(digits)))
    .replace(/&([a-z][a-z0-9]*);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole);
}

/**
 * The schemes a link out of a message is allowed to have.
 *
 * This is the injection boundary for the whole link feature, and it is enforced
 * HERE — at parse time, on the way into `MailLink` — rather than at the click,
 * so no later code can hold a `MailLink` that isn't already safe to open.
 *
 * On desktop the opener plugin's own scope (`opener:default`) restricts schemes
 * as well, so that path is guarded twice. On the web there is no second guard:
 * the click is `window.open`, and `window.open("javascript:…")` runs the script
 * in this origin. So this list is load-bearing rather than defence in depth.
 */
const LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** Links one message may contribute. A newsletter has dozens; nothing sane has
 *  hundreds, and an unbounded list is a page full of rows nobody asked for. */
export const MAX_LINKS = 100;

/**
 * One href, validated and normalized — or null, which means it is not offered.
 *
 * Everything the view will display comes out of `URL`'s own parse rather than
 * out of the string the sender wrote, and that is the anti-spoofing measure:
 *
 *  - `host` is `URL.hostname`, so `https://apple.com@evil.com/` reports
 *    `evil.com` (the part that decides where the request goes) and an IDN
 *    homograph like `аpple.com` reports its punycode `xn--pple-43d.com`. A row
 *    that showed only the sender's text would show the lie in both cases.
 *  - credentials are stripped outright. They change nothing about *where* the
 *    link goes — the host is the host either way — so dropping them only
 *    removes the half of the URL that exists to be misread.
 *
 * A relative href fails `new URL` and is dropped, which is correct: a relative
 * link in mail has no base document to resolve against and cannot be opened.
 */
export function safeLink(href: string, label: string | null = null): MailLink | null {
  // Control characters are stripped rather than rejected: `java\nscript:` is an
  // old filter-evasion trick, and `URL` would happily ignore the newline.
  const value = decodeEntities(href).replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!LINK_SCHEMES.has(url.protocol)) return null;
  url.username = "";
  url.password = "";
  const host = url.protocol === "mailto:" ? safeDecodeUri(url.pathname) : url.hostname;
  if (!host) return null;
  return { url: url.href, host, label: label || null };
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Dedupe by URL, keeping the first occurrence and the first non-empty label,
 *  and cap the result. Order is meaningful — it is the numbering the body's
 *  `[n]` markers refer to — so this never sorts. */
export function mergeLinks(links: MailLink[]): MailLink[] {
  const byUrl = new Map<string, MailLink>();
  for (const link of links) {
    const held = byUrl.get(link.url);
    if (!held) {
      if (byUrl.size >= MAX_LINKS) break;
      byUrl.set(link.url, link);
      continue;
    }
    // An image link and a text link to the same place are one row, and the one
    // with words on it is the one worth labelling.
    if (!held.label && link.label) byUrl.set(link.url, { ...held, label: link.label });
  }
  return [...byUrl.values()];
}

/** Markup out, entities decoded, whitespace collapsed — for an anchor's label,
 *  which is a phrase rather than a document. */
function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Sentinels that survive tag-stripping, so block structure can be applied to
 *  whole lines once the markup around them is gone. */
const QUOTE_IN = "\u0002";
const QUOTE_OUT = "\u0003";
const BULLET = "\u0006";

/**
 * HTML to something readable and speakable, plus the links it contained.
 *
 * Not a renderer and not a sanitizer — the output is plain text that never goes
 * near `dangerouslySetInnerHTML` or the Markdown pipeline. Scripts, styles,
 * comments and `<head>` are dropped whole because their *contents* would
 * otherwise survive as text, which is how a "plain text" summary ends up
 * reciting CSS or a `<title>`.
 *
 * **Anchors are harvested rather than discarded.** The old version turned
 * `<a href="https://…/verify?token=…">Verify your email</a>` into the three
 * words `Verify your email`: not an unclickable link, no link at all, and no
 * way to recover it. Every accepted href becomes a `MailLink` and leaves a
 * `[n]` marker behind at the point it appeared, which is what tells the "Verify"
 * button apart from the footer's "Privacy policy" in a message with forty of
 * them. A rejected href leaves the anchor's words alone and adds nothing.
 *
 * **Block structure survives as text.** Lists get `- `, blockquotes get `> `
 * per line at their nesting depth, headings and paragraphs get a blank line.
 * The quote prefix is not decoration: it is what lets `splitQuoted` find the
 * reply trail in an HTML message, the same way it does in a plain-text one.
 */
function htmlToText(html: string): { text: string; links: MailLink[] } {
  const links: MailLink[] = [];
  const numbers = new Map<string, number>();

  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");

  const marked = stripped.replace(
    /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi,
    (_whole, attrs: string, inner: string) => {
      const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const raw = href ? (href[1] ?? href[2] ?? href[3] ?? "") : "";
      const link = raw ? safeLink(raw, stripTags(inner).slice(0, 120)) : null;
      if (!link) return inner;
      let n = numbers.get(link.url);
      if (n === undefined) {
        if (links.length >= MAX_LINKS) return inner;
        links.push(link);
        n = links.length;
        numbers.set(link.url, n);
      } else if (!links[n - 1].label && link.label) {
        links[n - 1] = { ...links[n - 1], label: link.label };
      }
      return `${inner} [${n}]`;
    },
  );

  const flattened = decodeEntities(
    marked
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, `\n${BULLET}`)
      .replace(/<blockquote\b[^>]*>/gi, `\n${QUOTE_IN}\n`)
      .replace(/<\/blockquote\s*>/gi, `\n${QUOTE_OUT}\n`)
      // Generous on both the open and close tag: `\n{3,}` collapses below, so
      // an extra break costs nothing and a missing one runs two paragraphs
      // together.
      .replace(/<\/?(p|h[1-6]|hr|ul|ol|table|section|article)\b[^>]*>/gi, "\n\n")
      // `li` is NOT in this list: its opening tag already broke the line, and
      // closing it too puts a blank line between every bullet.
      .replace(/<\/(div|tr)\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\u00a0]+/g, " ")
    // Tags became spaces, so every line that had markup around it now starts or
    // ends with one — trim per line, not just at the ends of the message.
    .replace(/[ \t]*\n[ \t]*/g, "\n");

  // Block structure, applied per line now that there is no markup left to
  // confuse a line boundary with an element boundary.
  const out: string[] = [];
  let depth = 0;
  for (const line of flattened.split("\n")) {
    if (line === QUOTE_IN) { depth = Math.min(depth + 1, 8); continue; }
    if (line === QUOTE_OUT) { depth = Math.max(depth - 1, 0); continue; }
    const bulleted = line.startsWith(BULLET);
    const content = (bulleted ? line.slice(BULLET.length) : line).trim();
    // A blank line inside a quote stays blank rather than becoming a bare `>`.
    // Mail clients do write it that way, but here it survives the `\n{3,}`
    // collapse below and leaves a ladder of `>` between every paragraph.
    if (!content) { out.push(""); continue; }
    out.push(`${"> ".repeat(depth)}${bulleted ? "- " : ""}${content}`);
  }

  return { text: out.join("\n").replace(/\n{3,}/g, "\n\n").trim(), links };
}

/**
 * Bare URLs written out in the text, added to whatever the markup already gave.
 *
 * The other half of the problem: a great many services send their sign-in links
 * as `text/plain` with the URL spelled out, where there is no `href` to harvest
 * and the address is visible but not actionable. Deduped against the links
 * already found, so an `<a>` whose words *are* its URL stays one row.
 *
 * Trailing punctuation is trimmed because a URL at the end of a sentence
 * collects the full stop, and an unbalanced closing bracket because a URL
 * inside parentheses collects that too — both produce a 404 that reads as a
 * broken link rather than as a parsing mistake.
 */
export function addTextLinks(links: MailLink[], text: string): MailLink[] {
  const found: MailLink[] = [];
  for (const match of text.matchAll(/(?:https?:\/\/|mailto:)[^\s<>"'`\]]+/gi)) {
    let raw = match[0].replace(/[.,;:!?'"]+$/, "");
    while (raw.endsWith(")") && !raw.includes("(")) raw = raw.slice(0, -1);
    const link = safeLink(raw);
    if (link) found.push(link);
  }
  return mergeLinks([...links, ...found]);
}

// ---------------------------------------------------------------------------
// Quoted replies
// ---------------------------------------------------------------------------

/**
 * Where the new message ends and the thread underneath it begins.
 *
 * Conservative on purpose, and the direction matters: a false positive HIDES
 * something the sender wrote, which is much worse than a false negative that
 * merely leaves a long message long. So this only fires on the delimiters mail
 * clients actually emit, it never fires when the split would leave nothing
 * visible, and it declines to bother for a trail too short to be in the way.
 *
 * Signatures are deliberately NOT collapsed, even though `-- ` is the one
 * reliable delimiter here. A sign-off is short and is usually the part you
 * wanted to read.
 *
 * This is a DISPLAY split. `MailMessageDetail.body` keeps the whole message, so
 * search still reaches the trail and the assistant still gets the context of
 * what was said earlier in the thread.
 */
export function splitQuoted(body: string): { visible: string; quoted: string } {
  const whole = { visible: body, quoted: "" };
  const lines = body.split("\n");
  const at = quoteStart(lines);
  if (at <= 0) return whole;

  const visible = lines.slice(0, at).join("\n").replace(/\s+$/, "");
  const quoted = lines.slice(at).join("\n").trim();
  if (!visible.trim()) return whole;
  // Not worth a control for: hiding four lines behind a button people have to
  // press is a worse read than four lines.
  if (quoted.length < 120 || quoted.split("\n").length < 3) return whole;
  return { visible, quoted };
}

function quoteStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const next = (lines[i + 1] ?? "").trim();

    // Outlook: a rule, then the forwarded message's own headers.
    if (/^_{5,}$/.test(line) && /^(From|Sent|To|Subject):/i.test(next)) return i;
    if (/^-{2,}\s*(Original Message|Forwarded message)\s*-{2,}$/i.test(line)) return i;

    // "On <date>, <someone> wrote:" — what almost every client writes, and
    // often folded onto a second line by the sending client's own wrapping.
    if (line.length < 240 && /^On\b[\s\S]*\bwrote:$/.test(line)) return i;
    if (line.length < 240 && /^On\b/.test(line) && /\bwrote:$/.test(next)) return i;

    // A run of quoted lines carrying the rest of the message — which covers
    // HTML replies too, because `htmlToText` renders a <blockquote> this way.
    if (line.startsWith(">") && quotedToEnd(lines, i)) {
      const previous = (lines[i - 1] ?? "").trim();
      return previous && /\bwrote:$/.test(previous) ? i - 1 : i;
    }
  }
  return -1;
}

/** Is what follows mostly quotation? A single `>` line in the middle of a
 *  message is someone quoting a sentence, not the start of the thread. */
function quotedToEnd(lines: string[], from: number): boolean {
  const rest = lines.slice(from).map((l) => l.trim()).filter(Boolean);
  if (rest.length < 3) return false;
  const quoted = rest.filter((l) => l.startsWith(">")).length;
  return quoted / rest.length >= 0.6;
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
  links: MailLink[];
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
 *
 * LINKS are the one thing gathered from every alternative rather than only from
 * the part that won. A sender whose plain twin says "tap the button below" puts
 * the sign-in URL in the HTML twin and nowhere else, and that URL is exactly the
 * one worth having — so the chosen part's links come FIRST (they are what the
 * body's `[n]` markers count) and the siblings' are appended behind them.
 */
function walkPart(raw: string, depth: number): Walked {
  // Nesting is bounded: a hand-crafted message can nest multiparts far enough
  // to blow the stack, and nothing legitimate goes past a handful.
  if (depth > 10) return { text: "", links: [], attachments: [] };

  const split = /\r?\n\r?\n/.exec(raw);
  const headers = parseHeaders(split ? raw.slice(0, split.index) : raw);
  const body = split ? raw.slice(split.index + split[0].length) : "";

  const { type, params } = parseContentType(header(headers, "content-type") || "text/plain");
  const disposition = parseContentType(header(headers, "content-disposition"));
  const encoding = header(headers, "content-transfer-encoding");
  const filename = disposition.params.filename ?? params.name ?? null;

  if (type.startsWith("multipart/")) {
    const boundary = params.boundary;
    if (!boundary) return { text: "", links: [], attachments: [] };
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
        links: mergeLinks([...(plain?.links ?? []), ...parts.flatMap((p) => p.links)]),
        attachments: parts.flatMap((p) => p.attachments),
      };
    }
    return {
      text: parts.map((p) => p.text).filter(Boolean).join("\n\n"),
      links: mergeLinks(parts.flatMap((p) => p.links)),
      attachments: parts.flatMap((p) => p.attachments),
    };
  }

  const isAttachment = disposition.type === "attachment" || (!!filename && !type.startsWith("text/"));
  if (isAttachment || !type.startsWith("text/")) {
    return {
      text: "",
      links: [],
      // No part number: this walker works from the bytes, which carry no
      // numbering. `attachmentsFromStructure` is the path that has one, and it
      // is preferred whenever the server gave us a BODYSTRUCTURE.
      attachments: [{
        part: null,
        encoding: encoding.trim().toLowerCase(),
        filename,
        content_type: type || "application/octet-stream",
        size: body.length || null,
      }],
    };
  }

  const text = decodePart(body, encoding, params.charset ?? "utf-8");
  if (type === "text/html") {
    const { text: flattened, links } = htmlToText(text);
    return { text: flattened, links, attachments: [] };
  }
  return { text: text.trim(), links: [], attachments: [] };
}

/**
 * A whole raw message: its headers, its readable text, and what was attached.
 *
 * `multipart/alternative` prefers text/plain by ordering — the plain part comes
 * first in a well-formed message, and `walkPart` takes the first part that
 * produced any text, so an HTML-only message still yields its converted text
 * rather than nothing.
 */
export function parseMessage(raw: string): {
  headers: Headers;
  text: string;
  links: MailLink[];
  attachments: MailAttachment[];
} {
  const split = /\r?\n\r?\n/.exec(raw);
  const headers = parseHeaders(split ? raw.slice(0, split.index) : raw);
  const { text, links, attachments } = walkPart(raw, 0);
  return {
    headers,
    text: text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(),
    links,
    attachments,
  };
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
 *
 * Only ONE part is fetched on this path, so unlike `walkPart` there are no
 * sibling alternatives to gather links from — an HTML twin's links are out of
 * reach here. That is the existing shape of the large-message path rather than
 * a new limitation: the whole point of it is not to download the rest.
 */
export function decodeStandalonePart(
  body: string,
  encoding: string,
  charset: string | null,
  contentType: string,
): { text: string; links: MailLink[] } {
  const text = decodePart(body, encoding, charset ?? "utf-8");
  if (contentType.trim().toLowerCase() === "text/html") return htmlToText(text);
  return { text: text.trim(), links: [] };
}

/**
 * One part's actual BYTES, transfer encoding undone.
 *
 * The other decoders here all end in a string, because everything else in this
 * module is text that a person or a model will read. An attachment is a file: a
 * PDF put through `TextDecoder` is not a slightly damaged PDF, it is not a PDF.
 * So this stops one step earlier and hands back the octets.
 *
 * Base64 is padded rather than trimmed here — unlike `decodeBase64`, which
 * tolerates a body cut mid-quantum. A truncated *file* is refused upstream, so
 * anything reaching this should be whole, and quietly dropping a ragged tail
 * would turn "your download was cut short" into a file that opens wrong.
 */
export function decodePartBytes(body: string, encoding: string): Uint8Array {
  const enc = encoding.trim().toLowerCase();
  if (enc === "base64") {
    const clean = body.replace(/[^A-Za-z0-9+/=]/g, "");
    const padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);
    try {
      return toBytes(atob(padded));
    } catch {
      return new Uint8Array(0);
    }
  }
  if (enc === "quoted-printable") return toBytes(decodeQuotedPrintable(body));
  // 7bit / 8bit / binary — already the bytes, one code unit each.
  return toBytes(body);
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
      // Carried so the download path knows how to turn the bytes back into a
      // file. It comes off the structure rather than off the part's own headers
      // because at download time we have the part and not the headers.
      encoding: p.encoding,
      filename: p.filename,
      content_type: `${p.type || "application"}/${p.subtype || "octet-stream"}`,
      size: p.size,
    }));
}
