import { z } from "zod";

/**
 * The IMAP op envelope, shared by every party that speaks it.
 *
 * Mail is the one feature with THREE implementations of the same conversation:
 * the client builds an op, and it is executed either by the Rust command
 * (`src-tauri/src/mail.rs`, desktop) or by the Worker relay
 * (`worker/src/routes/mail.ts`, web). Rust cannot import this file, so it
 * mirrors these shapes by hand — but the client and the Worker validate against
 * the same schema, which is what stops the two TypeScript ends drifting.
 *
 * Three properties of the design, each load-bearing:
 *
 *  1. **Stateless, one op per call.** Every call is login → EXAMINE → one
 *     command → LOGOUT. The Worker keeps no connection between requests (there
 *     are no Durable Objects in this project — see worker/src/env.ts), and the
 *     Rust command stays a single self-contained function. The cost is a TLS
 *     handshake per query, which is acceptable for reading.
 *
 *  2. **Structured criteria, never a command string.** The client sends fields;
 *     each executor builds the IMAP command itself and quotes the values. If
 *     the client could send raw command text, a crafted subject would be IMAP
 *     command injection against the user's own mailbox — and on the web path,
 *     against a mailbox the Worker is holding a live credential for.
 *
 *  3. **The executors return RAW message text, not parsed mail.** Header
 *     decoding (RFC 2047 encoded-words), MIME walking, charset and
 *     transfer-encoding are all done ONCE, client-side, in `src/lib/mail/mime.ts`.
 *     Implementing that twice — once in Rust, once in a V8 isolate — is two
 *     parsers to keep in step and two sets of bugs; this way the desktop and web
 *     paths cannot disagree about what a message says.
 */

/**
 * The one mail server this app talks to.
 *
 * It is a constant rather than a setting because it is a security boundary:
 * both executors refuse any other host, which is what stops the web relay being
 * an SSRF tool with a raw socket. Adding a provider means adding a preset here
 * AND to the Rust allowlist — never accepting one from the client.
 */
export const ICLOUD_IMAP = { host: "imap.mail.me.com", port: 993 } as const;

/** Bytes of a message body ever fetched in one op. Mail is read aloud by an
 *  assistant, not archived — a message past this is quoted, not lost. */
export const MAIL_MAX_BODY_BYTES = 262_144;

/** Messages one search may return. Matches ai.ts's own MAX_LIMIT. */
export const MAIL_MAX_RESULTS = 100;

/**
 * An IMAP date, `d-MMM-yyyy` with an English month (`1-Jan-2026`).
 *
 * Formatted by the client and re-validated by both executors. IMAP has no other
 * date syntax, and a value that reached the command unchecked would be the one
 * place a search criterion could carry arbitrary text.
 */
export const imapDate = z.string().regex(/^\d{1,2}-[A-Z][a-z]{2}-\d{4}$/, "Expected a d-MMM-yyyy date.");

/**
 * A search term. Bounded, and CR/LF is refused outright: those two characters
 * are IMAP's command separator, so rejecting them is defence in depth behind
 * the quoting each executor already does.
 */
const searchTerm = z.string().min(1).max(200).refine((s) => !/[\r\n]/.test(s), "Line breaks are not allowed.");

/**
 * A mailbox name. Also CR/LF-free; length bounded well above any real folder
 * path (IMAP nests with a delimiter, so "Archive/2024/Receipts" is normal).
 */
const mailboxName = z.string().min(1).max(500).refine((s) => !/[\r\n]/.test(s), "Line breaks are not allowed.");

/**
 * TERMS, never a phrase — the rule the rest of this codebase already follows.
 *
 * IMAP matches a search key as one substring, so `TEXT "Manda Contact emails"`
 * finds nothing when the message says "Manda Contact", and the assistant then
 * reports there is no such mail. Splitting into terms and letting IMAP AND them
 * (adjacent search keys are implicitly ANDed) is the same fix `matchQuery`
 * applies to every other search in the app, for the same reason.
 *
 * Bounded at 8: each term is another key the server has to evaluate, and a
 * question long enough to need more of them wants a different question.
 */
const searchTerms = z.array(searchTerm).min(1).max(8);

export const mailCriteriaSchema = z.object({
  from: searchTerms.optional(),
  to: searchTerms.optional(),
  subject: searchTerms.optional(),
  /** IMAP TEXT: headers *and* body, as far as the server chooses to index. */
  text: searchTerms.optional(),
  since: imapDate.optional(),
  before: imapDate.optional(),
  unseen: z.boolean().optional(),
});

export type MailCriteria = z.infer<typeof mailCriteriaSchema>;

/**
 * Credentials ride on every op because nothing is kept between calls. They come
 * from `secrets.ts` on the client and are never stored by either executor.
 */
const credentials = {
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  user: z.string().min(1).max(320),
  pass: z.string().min(1).max(512),
};

export const mailOpSchema = z.discriminatedUnion("op", [
  z.object({ ...credentials, op: z.literal("list") }),
  z.object({
    ...credentials,
    op: z.literal("search"),
    mailbox: mailboxName,
    criteria: mailCriteriaSchema,
    limit: z.number().int().min(1).max(MAIL_MAX_RESULTS),
  }),
  z.object({
    ...credentials,
    op: z.literal("fetch"),
    mailbox: mailboxName,
    uid: z.number().int().min(1),
  }),
]);

export type MailOp = z.infer<typeof mailOpSchema>;

// ---------------------------------------------------------------------------
// Results
//
// `headers` and `raw` are BINARY STRINGS: one JavaScript code unit per byte of
// the wire, so no information is lost before the client's MIME parser has read
// the charset the message declares. Decoding them as UTF-8 in the executor
// would mangle every message that isn't UTF-8 — which is most older mail — in a
// way nothing downstream could undo.
// ---------------------------------------------------------------------------

export interface ImapFolderResult {
  name: string;
  delimiter: string;
  flags: string[];
}

export interface ImapMessageResult {
  uid: number;
  flags: string[];
  /**
   * IMAP INTERNALDATE, verbatim (`21-Jul-2026 10:00:00 +0800`). Left in the
   * server's own syntax rather than normalized to ISO for the same reason the
   * bodies are raw: converting it would be a third place — Rust — that has to
   * agree about date handling. The client normalizes it once.
   */
  internal_date: string | null;
  size: number | null;
  /** Raw header block (search), or the whole raw message (fetch). */
  headers?: string;
  raw?: string;
  /** True when the body was cut at MAIL_MAX_BODY_BYTES. */
  truncated?: boolean;
}

export type MailOpResult =
  | { op: "list"; folders: ImapFolderResult[] }
  | { op: "search"; total: number; truncated: boolean; messages: ImapMessageResult[] }
  | { op: "fetch"; message: ImapMessageResult };
