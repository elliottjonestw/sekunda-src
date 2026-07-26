import {
  ICLOUD_IMAP, MAIL_MAX_RESULTS, queryTerms,
  type ImapMessageResult, type MailCriteria,
} from "@secondbrain/shared";
import type { MailAccount, MailFolder } from "../settings";
import {
  cachedMessage, cachedSearch, forgetMessage, markMessageSeen,
  noteUidValidity, rememberMessage, rememberSearch,
} from "./cache";
import { imapCall } from "./client";
import {
  addTextLinks, attachmentsFromStructure, decodeMailboxName, decodeStandalonePart, decodeWords, header,
  parseAddresses, parseHeaders, parseMailDate, parseMessage,
} from "./mime";
import {
  MailError,
  type MailboxStatus, type MailMessageDetail, type MailMessageSummary,
  type MailSearchParams, type MailSearchResult,
} from "./types";

/**
 * Reading a mailbox, in the app's own vocabulary.
 *
 * Nothing here is *stored*: no table, no row, no id in this app's namespace,
 * for the same reason remote calendar events have none. Mail belongs to the
 * mail account, and copying it into a second place makes two copies to keep in
 * step and a second place to leak from.
 *
 * There is an in-memory cache (`cache.ts`) between these functions and the
 * network, which is a different thing — it dies with the app process and never
 * touches disk. It sits *here*, below the views, so that the assistant's
 * `search_mail` and `get_message` are cached too; a cache inside `MailView`
 * would have helped the UI and nothing else.
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
  return result.folders.map((f) => ({
    name: f.name,
    // Decoded for the picker only. `name` stays exactly as the server said it,
    // because that is what every later command has to carry.
    label: decodeMailboxName(f.name),
    delimiter: f.delimiter,
    flags: f.flags,
  }));
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
): Promise<MailSearchResult> {
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
    ...(params.uidMin ? { uid_min: params.uidMin } : {}),
  };
  // `toImapDate` returns undefined for junk; strip those rather than sending a
  // key the schema will reject and turn into "expected a mail op".
  for (const key of ["since", "before"] as const) {
    if (criteria[key] === undefined) delete criteria[key];
  }

  const limit = Math.min(Math.max(Math.floor(params.limit ?? 25), 1), MAIL_MAX_RESULTS);

  // The cache key is the criteria as sent, plus the limit — which changes the
  // answer, so serving the assistant's 25 to the view's 50 would silently drop
  // half a list. A `uid_min` search is never cached in either direction: it is
  // "what arrived since", which is a different answer every time it is asked
  // and is exactly the call that exists to keep a cached list current.
  const cacheable = criteria.uid_min === undefined;
  const key = { criteria, limit };
  if (cacheable && !params.refresh) {
    const hit = cachedSearch(account.username, mailbox, key);
    if (hit) return { ...hit, cached: true };
  }

  const result = await imapCall(account, { op: "search", mailbox, criteria, limit });
  if (result.op !== "search") throw new MailError("The mail server answered the wrong question.");
  // Before storing anything: a changed UIDVALIDITY means every uid we remember
  // for this mailbox now names a different message.
  noteUidValidity(account.username, mailbox, result.uidvalidity);

  const found: MailSearchResult = {
    total: result.total,
    truncated: result.truncated,
    mailbox,
    uids: result.uids,
    status: {
      uidvalidity: result.uidvalidity,
      uidnext: result.uidnext,
      messages: result.exists,
      unseen: null,
    },
    results: byDateDescending(result.messages.map((m) => toSummary(mailbox, m))),
    cached: false,
  };
  // Stored even on an explicit refresh — bypassing the cache means not *reading*
  // it, not declining to learn from the answer.
  if (cacheable) rememberSearch(account.username, mailbox, result.uidvalidity, key, found);
  return found;
}

/**
 * Headers for uids already in hand — one page of a list `searchMail` returned.
 *
 * This is what makes "Load older" one small fetch instead of a second search,
 * and paging over a *snapshot* of the uid list is safe against mail arriving
 * mid-session for a reason that is a property of uids rather than luck: uids
 * ascend with arrival, so a new message is always above the window being paged,
 * never inside it. Offset paging is what duplicates and skips rows; this
 * cannot. A message deleted while paging simply comes back missing.
 */
export async function loadHeaders(
  account: MailAccount,
  uids: number[],
  mailbox = DEFAULT_MAILBOX,
): Promise<MailMessageSummary[]> {
  const wanted = uids.filter((u) => Number.isInteger(u) && u > 0).slice(0, MAIL_MAX_RESULTS);
  if (wanted.length === 0) return [];
  const result = await imapCall(account, { op: "headers", mailbox, uids: wanted });
  if (result.op !== "headers") throw new MailError("The mail server answered the wrong question.");
  noteUidValidity(account.username, mailbox, result.uidvalidity);
  return byDateDescending(result.messages.map((m) => toSummary(mailbox, m)));
}

/**
 * What the server says about a mailbox, without any message data.
 *
 * The answer to "is the list I am showing still current?" — exactly, rather
 * than by a cache TTL, which can only guess at something the server will state.
 * `uidnext` moving means new mail; `messages` moving on its own means a
 * deletion elsewhere; `unseen` moving on its own means read elsewhere.
 */
export async function mailboxStatus(
  account: MailAccount,
  mailbox = DEFAULT_MAILBOX,
): Promise<MailboxStatus> {
  const result = await imapCall(account, { op: "status", mailbox });
  if (result.op !== "status") throw new MailError("The mail server answered the wrong question.");
  // The one check no comparison of counts could make: if this moved, every uid
  // we are holding names a different message, so everything goes.
  noteUidValidity(account.username, mailbox, result.uidvalidity);
  return {
    uidvalidity: result.uidvalidity,
    uidnext: result.uidnext,
    messages: result.messages,
    unseen: result.unseen,
  };
}

/**
 * Newest first, by DATE — not by uid.
 *
 * A uid is arrival order *in that mailbox*, which is the same as send order
 * only for mail that was delivered there and never touched. Anything filed by a
 * rule, moved by hand, or imported from another account arrives in whatever
 * order the copy happened, so an Archive folder sorted by uid is in no order a
 * person recognises. Undated messages sink rather than sorting as 1970.
 *
 * Exported because the view has to re-apply it after merging new arrivals into
 * a list on screen: a message *moved* into the mailbox (Move to Inbox) gets a
 * fresh high uid but keeps its old Date, so it is "new" by uid and old by date.
 * Prepending it by uid would float it above genuinely newer mail; re-sorting
 * the merged list puts it back where its date belongs.
 */
export function byDateDescending(messages: MailMessageSummary[]): MailMessageSummary[] {
  return [...messages].sort((a, b) => {
    if (!a.date || !b.date) return a.date ? -1 : b.date ? 1 : 0;
    return b.date.localeCompare(a.date);
  });
}

/** Body text kept from one message. Well past a long email and well short of
 *  anything that would fill the assistant's context with a newsletter. */
const MAX_BODY_CHARS = 20_000;

/**
 * A message we already have, without asking for it — or undefined.
 *
 * Synchronous on purpose, and the reason is a render frame: `getMessage` is
 * async even on a hit, so a view that awaits it must first show a loading state
 * and then immediately replace it. That flicker on every click between two
 * already-read messages is exactly what the cache exists to remove, so the
 * cache is allowed to be asked a question it can answer without yielding —
 * the same reason `secrets.ts` reads synchronously.
 */
export function peekMessage(
  account: MailAccount,
  uid: number,
  mailbox = DEFAULT_MAILBOX,
): MailMessageDetail | undefined {
  return cachedMessage(account.username, mailbox, uid);
}

/**
 * One message, decoded.
 *
 * The uid is only meaningful inside its mailbox — the same number names a
 * different message in Sent — so the mailbox travels with it everywhere,
 * including through the assistant's tool arguments.
 *
 * Two shapes can come back, decided by the executor from the message's size
 * (see `fetchMessage` in `worker/src/imap.ts`): the whole raw message, which the
 * original MIME walker handles, or one isolated text part plus a description of
 * the MIME tree. The second is what lets a message with a large attachment open
 * at all — under the old whole-message cap, text sitting after the attachment
 * was simply past the end.
 */
export async function getMessage(
  account: MailAccount,
  uid: number,
  mailbox = DEFAULT_MAILBOX,
): Promise<MailMessageDetail> {
  // A message body is immutable content: a uid names one set of bytes for as
  // long as UIDVALIDITY holds, so a hit needs no revalidation at all. What can
  // go stale is `seen` — a cosmetic dot, on a reader that cannot change a flag.
  const hit = cachedMessage(account.username, mailbox, uid);
  if (hit) return hit;

  const result = await imapCall(account, { op: "fetch", mailbox, uid });
  if (result.op !== "fetch") throw new MailError("The mail server answered the wrong question.");
  noteUidValidity(account.username, mailbox, result.uidvalidity);

  const msg = result.message;
  const structure = msg.structure ?? [];
  const whole = msg.raw !== undefined ? parseMessage(msg.raw) : null;

  const headers = whole ? whole.headers : parseHeaders(msg.headers ?? "");
  const part = !whole && msg.part
    ? decodeStandalonePart(msg.part.body, msg.part.encoding, msg.part.charset, msg.part.type)
    : null;
  const text = whole?.text ?? part?.text ?? "";
  // Harvested from the FULL text, deliberately before the body cap below: a
  // verification link sitting past the cut is precisely the one worth keeping,
  // and the list is a few hundred bytes where the body is twenty thousand.
  const links = addTextLinks(whole?.links ?? part?.links ?? [], text);
  // The structure's list wins wherever we have one, on both paths: its sizes
  // are the server's own count rather than whatever survived truncation, and it
  // names the part numbers. The walker's list is the fallback for a message the
  // server described in a way we could not read.
  const attachments = structure.length > 0
    ? attachmentsFromStructure(structure)
    : whole?.attachments ?? [];

  const flags = msg.flags.map((f) => f.toLowerCase());
  const body = text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}…` : text;

  const detail: MailMessageDetail = {
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
    links,
    attachments,
  };
  rememberMessage(account.username, mailbox, result.uidvalidity, detail);
  return detail;
}

/**
 * Mark one message read (or unread) — the reader's mark-as-read.
 *
 * A WRITE, and the first this module makes. Deliberately NOT folded into
 * `getMessage`: the assistant reads mail through `getMessage` too, and reading
 * mail aloud must not change its flags. So this is a separate call the UI makes
 * and the assistant never does.
 *
 * The cache is patched from the server's own answer (the flags it reports after
 * the STORE) rather than from the boolean we asked for, so a read state that
 * survives navigation is the one the server actually holds.
 */
export async function markSeen(
  account: MailAccount,
  uid: number,
  mailbox = DEFAULT_MAILBOX,
  seen = true,
): Promise<void> {
  const result = await imapCall(account, { op: "mark_seen", mailbox, uid, seen });
  if (result.op !== "mark_seen") throw new MailError("The mail server answered the wrong question.");
  noteUidValidity(account.username, mailbox, result.uidvalidity);
  // The server's reported flags win, but only when it actually reported some: a
  // STORE that answered without a FLAGS list (or SILENT) must not be read as
  // "now unseen" and undo the very change we just made — fall back to what we
  // asked for.
  const actualSeen = result.flags.length > 0
    ? result.flags.map((f) => f.toLowerCase()).includes("\\seen")
    : seen;
  markMessageSeen(account.username, mailbox, uid, actualSeen);
}

/**
 * The account's Trash folder, where a deleted message is moved.
 *
 * Resolved from the folder list the account already carries (LISTed on connect
 * and refreshed on mount): the SPECIAL-USE `\Trash` flag if the server sends
 * one, else a folder named like Trash, else iCloud's own "Deleted Messages".
 * The fallback is safe because the executors are iCloud-only anyway.
 */
export function resolveTrashMailbox(account: MailAccount): string {
  const folders = account.folders ?? [];
  const byFlag = folders.find((f) => f.flags.some((fl) => fl.toLowerCase() === "\\trash"));
  if (byFlag) return byFlag.name;
  const byName = folders.find((f) => /deleted messages|trash/i.test(f.label ?? f.name));
  return byName?.name ?? "Deleted Messages";
}

/**
 * The account's Junk folder, where "Move to Junk" files a message.
 *
 * Same resolution shape as `resolveTrashMailbox`: the SPECIAL-USE `\Junk` flag
 * if the server sends one, else a folder named like Junk/Spam/Bulk, else
 * iCloud's own "Junk".
 */
export function resolveJunkMailbox(account: MailAccount): string {
  const folders = account.folders ?? [];
  const byFlag = folders.find((f) => f.flags.some((fl) => fl.toLowerCase() === "\\junk"));
  if (byFlag) return byFlag.name;
  const byName = folders.find((f) => /junk|spam|bulk/i.test(f.label ?? f.name));
  return byName?.name ?? "Junk";
}

/**
 * Delete one message — moved to Trash, reversible.
 *
 * Also a WRITE. `UID MOVE` to the account's Trash folder (an expunge when the
 * message is already in Trash — see the `delete` op). On success the message is
 * dropped from the cache and the mailbox's cached search pages are invalidated,
 * because their uid lists now name a message that has moved.
 */
export async function deleteMessage(
  account: MailAccount,
  uid: number,
  mailbox = DEFAULT_MAILBOX,
): Promise<void> {
  const trash = resolveTrashMailbox(account);
  const result = await imapCall(account, { op: "delete", mailbox, uid, trash });
  if (result.op !== "delete") throw new MailError("The mail server answered the wrong question.");
  noteUidValidity(account.username, mailbox, result.uidvalidity);
  forgetMessage(account.username, mailbox, uid);
}

/**
 * Move one message to a named folder — the reader's file-away.
 *
 * The generic write that `deleteMessage` is a special case of: `UID MOVE` to
 * `dest`, with the same cache treatment (the message leaves this mailbox, so it
 * and the mailbox's search pages are forgotten). Move to Junk is the first
 * caller; a future Move to Archive is this same call with a different folder.
 */
export async function moveMessage(
  account: MailAccount,
  uid: number,
  mailbox: string,
  dest: string,
): Promise<void> {
  const result = await imapCall(account, { op: "move", mailbox, uid, dest });
  if (result.op !== "move") throw new MailError("The mail server answered the wrong question.");
  noteUidValidity(account.username, mailbox, result.uidvalidity);
  forgetMessage(account.username, mailbox, uid);
}

/** Move one message to the account's Junk folder. */
export function moveToJunk(account: MailAccount, uid: number, mailbox = DEFAULT_MAILBOX): Promise<void> {
  return moveMessage(account, uid, mailbox, resolveJunkMailbox(account));
}

/** Move one message back to the Inbox — restoring a junked or deleted message.
 *  `INBOX` is IMAP's one reserved, universal mailbox name, so it needs no
 *  folder-list resolution the way Junk and Trash do. */
export function moveToInbox(account: MailAccount, uid: number, mailbox: string): Promise<void> {
  return moveMessage(account, uid, mailbox, DEFAULT_MAILBOX);
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
