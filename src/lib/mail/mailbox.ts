import {
  ICLOUD_IMAP, MAIL_MAX_RESULTS, queryTerms,
  type ImapMessageResult, type MailCriteria,
} from "@secondbrain/shared";
import type { MailAccount, MailFolder } from "../settings";
import { imapCall } from "./client";
import { decodeWords, header, parseAddresses, parseHeaders, parseMailDate, parseMessage } from "./mime";
import {
  MailError,
  type MailMessageDetail, type MailMessageSummary, type MailSearchParams,
} from "./types";

/**
 * Reading a mailbox, in the app's own vocabulary.
 *
 * Everything here is live: nothing about a message is stored, cached or given
 * an id in this app's namespace, for the same reason remote calendar events
 * aren't. Mail belongs to the mail account; copying it into a second place
 * makes two copies to keep in step and a second place to leak from.
 */

/** IMAP's date syntax is English-only regardless of the user's locale, so the
 *  month names are a fixed table rather than anything from `format.ts`. */
const IMAP_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Local calendar day, not UTC — the same reason `weather.ts` refuses
 *  `toISOString().slice(0,10)`: east of Greenwich that shifts the day. */
function toImapDate(value: string): string | undefined {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? `${value.trim()}T00:00:00` : value);
  if (isNaN(d.getTime())) return undefined;
  return `${d.getDate()}-${IMAP_MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}

export const DEFAULT_MAILBOX = "INBOX";

/** Terms for one IMAP search key, or undefined when there is nothing to match.
 *  Capped at the 8 the schema allows so a rambling query is trimmed rather than
 *  rejected outright — a refused search reads to the model as "no mail". */
function terms(value: string | undefined): string[] | undefined {
  const list = queryTerms((value ?? "").trim()).slice(0, 8);
  return list.length > 0 ? list : undefined;
}

/**
 * The mailboxes on the account, as IMAP reports them.
 *
 * Called by the Settings pane when connecting — it doubles as the credential
 * check, exactly as CalDAV discovery does — and by the assistant's
 * `list_mailboxes`.
 */
export async function listFolders(account: MailAccount): Promise<MailFolder[]> {
  const result = await imapCall(account, { op: "list" });
  if (result.op !== "list") throw new MailError("The mail server answered the wrong question.");
  return result.folders.map((f) => ({ name: f.name, delimiter: f.delimiter, flags: f.flags }));
}

/** A summary from the raw header block the search fetched. */
function toSummary(mailbox: string, msg: ImapMessageResult): MailMessageSummary {
  const headers = parseHeaders(msg.headers ?? "");
  const flags = msg.flags.map((f) => f.toLowerCase());
  return {
    uid: msg.uid,
    mailbox,
    subject: decodeSubject(header(headers, "subject")),
    from: parseAddresses(header(headers, "from")),
    to: parseAddresses(header(headers, "to")),
    date: parseMailDate(header(headers, "date"), msg.internal_date),
    seen: flags.includes("\\seen"),
    flagged: flags.includes("\\flagged"),
    size: msg.size,
  };
}

/**
 * The subject, decoded, never empty.
 *
 * The placeholder is English because the only consumer is the assistant, and
 * model-facing text stays English by the same rule that keeps `SYSTEM_PROMPT`
 * and the tool descriptions English (see the i18n section of CLAUDE.md).
 */
function decodeSubject(raw: string): string {
  return decodeWords(raw).trim() || "(no subject)";
}

/**
 * Search a mailbox.
 *
 * IMAP SEARCH is a FILTER, not a search engine: no ranking, no scoring, and
 * what a server indexes for `TEXT` is entirely up to it — iCloud matches
 * headers reliably and bodies unevenly. So this returns the newest matches
 * rather than the "best" ones, and `total` says how many matched in all. A
 * caller that presents this as a ranked result set is lying about it; the
 * assistant's tool description says so explicitly.
 *
 * The window comes off the END of the uid list because uids ascend with
 * arrival — newest is what someone means by "my mail".
 */
export async function searchMail(
  account: MailAccount,
  params: MailSearchParams = {},
): Promise<{ total: number; truncated: boolean; mailbox: string; results: MailMessageSummary[] }> {
  const mailbox = params.mailbox?.trim() || DEFAULT_MAILBOX;
  // `queryTerms` is the app's one splitter — the same one the global search bar
  // and every assistant search tool use. A phrase sent as a single IMAP key
  // matches as one substring, so "Manda Contact emails" would find nothing in
  // a mailbox full of mail from "Manda Contact".
  const criteria: MailCriteria = {
    ...(terms(params.from) ? { from: terms(params.from) } : {}),
    ...(terms(params.subject) ? { subject: terms(params.subject) } : {}),
    ...(terms(params.query) ? { text: terms(params.query) } : {}),
    ...(params.since ? { since: toImapDate(params.since) } : {}),
    ...(params.before ? { before: toImapDate(params.before) } : {}),
    ...(params.unseen ? { unseen: true } : {}),
  };
  // `toImapDate` returns undefined for junk; strip those rather than sending a
  // key the schema will reject and turn into "expected a mail op".
  for (const key of ["since", "before"] as const) {
    if (criteria[key] === undefined) delete criteria[key];
  }

  const limit = Math.min(Math.max(Math.floor(params.limit ?? 25), 1), MAIL_MAX_RESULTS);
  const result = await imapCall(account, { op: "search", mailbox, criteria, limit });
  if (result.op !== "search") throw new MailError("The mail server answered the wrong question.");

  return {
    total: result.total,
    truncated: result.truncated,
    mailbox,
    results: result.messages.map((m) => toSummary(mailbox, m)),
  };
}

/** Body text kept from one message. Well past a long email and well short of
 *  anything that would fill the assistant's context with a newsletter. */
const MAX_BODY_CHARS = 20_000;

/**
 * One message, decoded.
 *
 * The uid is only meaningful inside its mailbox — the same number names a
 * different message in Sent — so the mailbox travels with it everywhere,
 * including through the assistant's tool arguments.
 */
export async function getMessage(
  account: MailAccount,
  uid: number,
  mailbox = DEFAULT_MAILBOX,
): Promise<MailMessageDetail> {
  const result = await imapCall(account, { op: "fetch", mailbox, uid });
  if (result.op !== "fetch") throw new MailError("The mail server answered the wrong question.");

  const msg = result.message;
  const { headers, text, attachments } = parseMessage(msg.raw ?? "");
  const flags = msg.flags.map((f) => f.toLowerCase());
  const body = text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}…` : text;

  return {
    uid: msg.uid,
    mailbox,
    subject: decodeSubject(header(headers, "subject")),
    from: parseAddresses(header(headers, "from")),
    to: parseAddresses(header(headers, "to")),
    cc: parseAddresses(header(headers, "cc")),
    reply_to: parseAddresses(header(headers, "reply-to")),
    message_id: header(headers, "message-id") || null,
    date: parseMailDate(header(headers, "date"), msg.internal_date),
    seen: flags.includes("\\seen"),
    flagged: flags.includes("\\flagged"),
    size: msg.size,
    body,
    body_truncated: !!msg.truncated || text.length > MAX_BODY_CHARS,
    attachments,
  };
}

/** A connectable account for the one provider this supports. The host and port
 *  are fixed here rather than typed by the user: they are the allowlist both
 *  executors enforce, so a free-text field could only ever produce a refusal. */
export function icloudAccount(username: string): MailAccount {
  return {
    provider: "icloud",
    username: username.trim(),
    host: ICLOUD_IMAP.host,
    port: ICLOUD_IMAP.port,
    folders: [],
  };
}
