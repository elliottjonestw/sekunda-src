/**
 * What the rest of the app sees of a mailbox.
 *
 * Deliberately NOT the IMAP shapes: `packages/shared/src/mail.ts` describes the
 * wire (raw headers, raw bodies, server date syntax) and everything here is
 * already decoded and normalized. Nothing outside `src/lib/mail/` should have
 * to know what an ENVELOPE or a transfer-encoding is.
 *
 * These are also NOT rows. Mail is never stored — there is no table, no id
 * namespace, and no `ItemRef` for a message — so a summary is only ever as
 * fresh as the call that produced it, and a `uid` is only meaningful together
 * with its mailbox.
 */

export interface MailAddress {
  /** Display name, decoded from RFC 2047 if it was encoded. */
  name: string | null;
  address: string;
}

export interface MailMessageSummary {
  uid: number;
  mailbox: string;
  subject: string;
  from: MailAddress[];
  to: MailAddress[];
  /** ISO 8601, from the message's own Date header, else the server's
   *  INTERNALDATE. Null only when both are missing or unparseable. */
  date: string | null;
  seen: boolean;
  flagged: boolean;
  size: number | null;
}

export interface MailAttachment {
  /**
   * IMAP part number (`"2.1"`), when the server described the message's
   * structure. Null on the small-message path, where the list is reconstructed
   * from the bytes and there is no numbering to read.
   *
   * Nothing uses it yet: there is no download path. It is here because the part
   * number is the *only* thing that would make one possible, and it costs
   * nothing to carry.
   */
  part: string | null;
  filename: string | null;
  content_type: string;
  /** Bytes as encoded on the wire; absent when the part gave no length. */
  size: number | null;
}

export interface MailMessageDetail extends MailMessageSummary {
  cc: MailAddress[];
  reply_to: MailAddress[];
  message_id: string | null;
  /** Plain text. An HTML-only message is converted; there is no HTML path
   *  anywhere in this app — the assistant reads mail aloud, and the Notes
   *  renderer is not going to be handed a stranger's markup. */
  body: string;
  /** True when the body was cut — by the fetch's octet cap or by ours. */
  body_truncated: boolean;
  /** Listed, never downloaded. There is no attachment fetch path. */
  attachments: MailAttachment[];
}

/** What the server says about a mailbox, with no message data in it. */
export interface MailboxStatus {
  /**
   * The number that makes a uid mean anything.
   *
   * A uid identifies a message only while this is unchanged; when the server
   * changes it, uid 991 is a *different message*. So it is part of every cache
   * key, and a change to it drops everything remembered about that mailbox —
   * without which the cache would confidently serve the wrong email under the
   * subject that was clicked. Zero means the server didn't say, which is
   * treated as "remember nothing", never as a value that compares equal.
   */
  uidvalidity: number;
  /** The uid the next arrival will get. Unchanged means nothing new. */
  uidnext: number;
  /** How many messages it holds — catches a deletion elsewhere, which leaves
   *  `uidnext` alone. */
  messages: number;
  /**
   * Catches read-elsewhere, which moves neither of the other two.
   *
   * Null when the number came from opening the mailbox rather than from a
   * STATUS: EXAMINE reports the *sequence number of the first unseen message*,
   * not a count, and a number that looks plausible and is wrong is worse than
   * none. So this is comparable only from one STATUS to the next.
   */
  unseen: number | null;
}

export interface MailSearchResult {
  /** How many matched in all. */
  total: number;
  /** True when even the uid list was capped, so paging cannot reach the end. */
  truncated: boolean;
  mailbox: string;
  /** Every matching uid, newest first — the list to page over. Held by the
   *  caller so a later page costs a header fetch, not a second search. */
  uids: number[];
  /** The freshness baseline this search saw, for a later `mailboxStatus` to be
   *  compared against. `unseen` is null because opening a mailbox does not
   *  report a count of unseen messages — only a later STATUS does. */
  status: MailboxStatus;
  /** The first page, already decoded and sorted newest-first by date. */
  results: MailMessageSummary[];
  /**
   * True when this came from memory rather than the network.
   *
   * The caller needs it because a cached list is not *validated* — nothing here
   * knows whether mail arrived since. It is the signal to run the `STATUS`
   * check, which answers that exactly; a fresh result needs no such check,
   * having just asked.
   */
  cached: boolean;
}

export interface MailSearchParams {
  mailbox?: string;
  /** Free text: matched by the server against headers and, where it indexes
   *  them, bodies. IMAP has no ranking, so this is a filter, not a search
   *  engine — see `searchMail`. */
  query?: string;
  from?: string;
  subject?: string;
  /** ISO date or datetime; IMAP compares whole days. */
  since?: string;
  before?: string;
  unseen?: boolean;
  limit?: number;
  /** Only mail at or above this uid — how a list picks up new arrivals without
   *  asking the server to re-run the whole query. */
  uidMin?: number;
  /** Skip the cache and re-search. The refresh button, and nothing else — the
   *  answer is still remembered, this only declines to *read* what was. */
  refresh?: boolean;
}

/** Anything that went wrong reaching or reading the mailbox. One class, because
 *  every caller does the same thing with it: show the message. */
export class MailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailError";
  }
}
