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
}

/** Anything that went wrong reaching or reading the mailbox. One class, because
 *  every caller does the same thing with it: show the message. */
export class MailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailError";
  }
}
