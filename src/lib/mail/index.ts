/**
 * The mail module's public surface. Views and `ai.ts` import from here, never
 * from `client.ts` or `mime.ts` directly — the transport pick and the MIME
 * parser are implementation details, and the credential read lives behind them.
 */
export {
  byDateDescending, DEFAULT_MAILBOX, deleteMessage, getMessage, icloudAccount, listFolders, loadHeaders,
  mailboxStatus, markSeen, moveMessage, moveToInbox, moveToJunk, peekMessage,
  resolveJunkMailbox, resolveTrashMailbox, searchMail,
} from "./mailbox";
export { clearMailCache } from "./cache";
export { saveAttachment } from "./download";
// The one thing a view needs out of the MIME layer: where the new message ends
// and the quoted thread underneath it begins. A display split — `body` keeps
// the whole message either way.
export { splitQuoted } from "./mime";
export { MailError } from "./types";
export type {
  MailAddress, MailAttachment, MailboxStatus, MailLink, MailMessageDetail, MailMessageSummary,
  MailSearchParams, MailSearchResult,
} from "./types";
