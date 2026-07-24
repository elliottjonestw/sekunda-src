import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  cachedMessage, cachedSearch, clearMailCache, forgetMailbox, knownUidValidity,
  noteUidValidity, rememberMessage, rememberSearch,
} from "../src/lib/mail/cache";
import type { MailMessageDetail, MailSearchResult } from "../src/lib/mail/types";

/**
 * The in-memory mail cache.
 *
 * The behaviour worth testing here is not "does a Map work" — it is the two
 * rules that make caching mail safe at all: everything is keyed by UIDVALIDITY,
 * so a server that renumbers a mailbox can never have an old uid answered with
 * a new message; and everything can be dropped on demand, because sign-out has
 * no storage key to scope this away the way it does the secrets.
 */

const USER = "someone@icloud.com";

function message(uid: number, subject: string): MailMessageDetail {
  return {
    uid, mailbox: "INBOX", subject, from: [], to: [], cc: [], reply_to: [],
    message_id: null, date: null, seen: false, flagged: false, size: null,
    body: "", body_truncated: false, attachments: [],
  };
}

function search(total: number): MailSearchResult {
  return {
    total, truncated: false, mailbox: "INBOX", uids: [], cached: false, results: [],
    status: { uidvalidity: 1, uidnext: 1, messages: 0, unseen: null },
  };
}

beforeEach(() => clearMailCache());

test("nothing is cached until the server has said what UIDVALIDITY is", () => {
  // The ordering problem this exists to handle: a lookup happens before the
  // call that would report the number, so with no remembered one there is
  // nothing to key on — and guessing would be the exact bug being avoided.
  rememberMessage(USER, "INBOX", 0, message(991, "no validity, no store"));
  assert.equal(cachedMessage(USER, "INBOX", 991), undefined);
  assert.equal(knownUidValidity(USER, "INBOX"), 0);

  noteUidValidity(USER, "INBOX", 42);
  rememberMessage(USER, "INBOX", 42, message(991, "stored"));
  assert.equal(cachedMessage(USER, "INBOX", 991)?.subject, "stored");
});

test("a changed UIDVALIDITY drops the mailbox — uid 991 is a different message now", () => {
  noteUidValidity(USER, "INBOX", 42);
  rememberMessage(USER, "INBOX", 42, message(991, "the old message"));
  rememberSearch(USER, "INBOX", 42, { q: "x" }, search(7));

  noteUidValidity(USER, "INBOX", 43);

  // Not merely a miss: the entries are gone, so a long session cannot sit on
  // megabytes of provably meaningless mail.
  assert.equal(cachedMessage(USER, "INBOX", 991), undefined);
  assert.equal(cachedSearch(USER, "INBOX", { q: "x" }), undefined);
  assert.equal(knownUidValidity(USER, "INBOX"), 43);
});

test("a zero UIDVALIDITY is 'the server didn't say', not a value", () => {
  noteUidValidity(USER, "INBOX", 42);
  rememberMessage(USER, "INBOX", 42, message(991, "kept"));
  // A server that omits it must not look like a change and wipe the cache, and
  // must not compare equal to anything either.
  noteUidValidity(USER, "INBOX", 0);
  assert.equal(knownUidValidity(USER, "INBOX"), 42);
  assert.equal(cachedMessage(USER, "INBOX", 991)?.subject, "kept");
});

test("mailboxes and accounts do not bleed into each other", () => {
  noteUidValidity(USER, "INBOX", 42);
  noteUidValidity(USER, "Sent", 42);
  noteUidValidity("other@icloud.com", "INBOX", 42);
  rememberMessage(USER, "INBOX", 42, message(1, "inbox"));
  rememberMessage(USER, "Sent", 42, message(1, "sent"));
  rememberMessage("other@icloud.com", "INBOX", 42, message(1, "someone else"));

  // The same uid in a different mailbox is a different message — that is why
  // the mailbox travels with a uid everywhere in this module.
  assert.equal(cachedMessage(USER, "INBOX", 1)?.subject, "inbox");
  assert.equal(cachedMessage(USER, "Sent", 1)?.subject, "sent");

  forgetMailbox(USER, "INBOX");
  assert.equal(cachedMessage(USER, "INBOX", 1), undefined);
  assert.equal(cachedMessage(USER, "Sent", 1)?.subject, "sent");
  assert.equal(cachedMessage("other@icloud.com", "INBOX", 1)?.subject, "someone else");
});

test("a search is keyed by its criteria, so one filter never answers another", () => {
  noteUidValidity(USER, "INBOX", 42);
  rememberSearch(USER, "INBOX", 42, { criteria: {}, limit: 50 }, search(100));
  rememberSearch(USER, "INBOX", 42, { criteria: { unseen: true }, limit: 50 }, search(3));

  assert.equal(cachedSearch(USER, "INBOX", { criteria: {}, limit: 50 })?.total, 100);
  assert.equal(cachedSearch(USER, "INBOX", { criteria: { unseen: true }, limit: 50 })?.total, 3);
  // The limit is part of the answer, not part of the question: serving the
  // assistant's 25 to the view's 50 would silently drop half a list.
  assert.equal(cachedSearch(USER, "INBOX", { criteria: {}, limit: 25 }), undefined);
});

test("the message store is bounded, evicting least-recently-used", () => {
  noteUidValidity(USER, "INBOX", 42);
  for (let uid = 1; uid <= 200; uid++) rememberMessage(USER, "INBOX", 42, message(uid, `m${uid}`));
  // Touch the oldest so it is no longer the oldest.
  assert.equal(cachedMessage(USER, "INBOX", 1)?.subject, "m1");
  rememberMessage(USER, "INBOX", 42, message(201, "m201"));

  assert.equal(cachedMessage(USER, "INBOX", 201)?.subject, "m201");
  assert.equal(cachedMessage(USER, "INBOX", 1)?.subject, "m1", "a read must count as use");
  assert.equal(cachedMessage(USER, "INBOX", 2), undefined, "the untouched oldest goes");
});

test("clearing forgets everyone — sign-out has no storage key to do it for us", () => {
  noteUidValidity(USER, "INBOX", 42);
  rememberMessage(USER, "INBOX", 42, message(1, "private"));
  rememberSearch(USER, "INBOX", 42, { q: "x" }, search(1));

  clearMailCache();

  assert.equal(cachedMessage(USER, "INBOX", 1), undefined);
  assert.equal(cachedSearch(USER, "INBOX", { q: "x" }), undefined);
  // Including the UIDVALIDITY map, or the next account's first lookup would be
  // keyed on a number from the last one's mailbox.
  assert.equal(knownUidValidity(USER, "INBOX"), 0);
});
