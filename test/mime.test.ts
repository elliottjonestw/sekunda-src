import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeMailboxName, parseMailDate } from "../src/lib/mail/mime";

/**
 * The client half of the mail pipeline, where the executors' raw bytes become
 * something a person reads.
 *
 * Outside `src/` for the same reason `worker/test/` is outside `worker/src/`:
 * `tsconfig.json` includes only `src`, and `node:test` is not part of a DOM
 * build. Run with `npm test`.
 *
 * `mime.ts` touches no browser API beyond `atob` and `TextDecoder`, both of
 * which Node has — which is what makes this testable at all without a headless
 * browser.
 */

test("a mailbox name comes out of modified UTF-7", () => {
  // The encoding IMAP predates UTF-8 with: base64 of UTF-16BE between & and -,
  // with `,` standing in for `/` because `/` is the hierarchy delimiter.
  assert.equal(decodeMailboxName("&ZeVnLIqe-"), "日本語");
  assert.equal(decodeMailboxName("~peter/mail/&U,BTFw-/&ZeVnLIqe-"), "~peter/mail/台北/日本語");
  // ASCII is left exactly alone — most names are, and touching them is how a
  // folder called "INBOX" stops matching itself.
  assert.equal(decodeMailboxName("INBOX"), "INBOX");
  assert.equal(decodeMailboxName("Archive/2025"), "Archive/2025");
  // `&-` is a literal ampersand; anything that isn't really an encoded run is
  // left as it was, because a folder named `R&D` is not an error.
  assert.equal(decodeMailboxName("Sent &- Drafts"), "Sent & Drafts");
  assert.equal(decodeMailboxName("R&D"), "R&D");
});

test("the sender's Date wins only while it is plausible", () => {
  const internal = "21-Jul-2026 10:00:00 +0800";

  // Ordinary mail: the header is what every other client shows.
  assert.equal(
    parseMailDate("Tue, 21 Jul 2026 09:30:00 +0800", internal),
    new Date("2026-07-21T09:30:00+08:00").toISOString(),
  );

  // The header is written by the SENDER, so a spammer sets it to next year to
  // pin the message to the top of a list sorted by date. Beyond a day's grace
  // — enough for a merely wrong clock — what the server saw wins.
  const server = new Date("2026-07-21T10:00:00+08:00").toISOString();
  assert.equal(parseMailDate("Fri, 1 Jan 2999 00:00:00 +0000", internal), server);
  assert.equal(parseMailDate("Mon, 1 Jan 1970 00:00:00 +0000", internal), server);

  // Missing or unparseable falls back; both missing is null, not epoch.
  assert.equal(parseMailDate("", internal), server);
  assert.equal(parseMailDate("not a date", internal), server);
  assert.equal(parseMailDate("", null), null);
  // With nothing to fall back to, an absurd claim is still better than nothing.
  assert.equal(
    parseMailDate("Fri, 1 Jan 2999 00:00:00 +0000", null),
    new Date("2999-01-01T00:00:00Z").toISOString(),
  );
});
