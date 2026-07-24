# iCloud Mail — known issues

Everything wrong with, or missing from, the mail feature as it stands, gathered
from use and from reading the code back. Ordered by section; severity is a
judgement about *user impact*, not effort.

Nothing here is a reason the feature doesn't work — it does. This is the list of
what to fix next and what to say out loud in the meantime.

Legend: **Bug** = it does the wrong thing. **Gap** = it doesn't do the thing.
**Accepted** = deliberate, documented, and still true — listed so it isn't
rediscovered as a surprise.

---

## 1. Correctness

### 1.1 `UIDVALIDITY` is never checked — Bug, high
A uid identifies a message only for as long as the mailbox's `UIDVALIDITY`
stays the same. Apple bumps it when a mailbox is recreated or restored, and
every uid then points at a *different message*.

Today the exposure is one page visit, because nothing is persisted. **It becomes
serious the moment anything is cached** (§2.2): a stale uid would open somebody
else's message under the subject line you clicked. `EXAMINE` already returns
`* OK [UIDVALIDITY n]` and `worker/src/imap.ts` discards it.

*Fix:* return it from both executors, and make it part of every cache key. Do
this **before** writing a cache, not after.

### 1.2 A truncated fetch can lose the body entirely — Bug, high
`getMessage` fetches `BODY.PEEK[]<0.262144>` — the first 256 KB of the **whole
raw message**, attachments included and base64-inflated. If a large image or
attachment part sits *before* the text part in the MIME structure, the text is
past the cut and the reader shows an empty or garbled body rather than a
shortened one.

Same root cause as §2.3, and the same fix solves both.

*Fix:* `BODYSTRUCTURE` first, then fetch only the text part by its part number.

### 1.3 Messages sort by uid, not by date — Bug, medium
`worker/src/imap.ts` and `mail.rs` both sort by uid descending, and uid order is
*arrival order in that mailbox*. Anything moved, filed, imported or restored
sorts by when it was filed rather than when it was sent. INBOX usually agrees;
Archive frequently doesn't.

*Fix:* sort by the resolved date client-side in `searchMail`, which already has
both the `Date` header and `INTERNALDATE`.

### 1.4 Mailbox names are not decoded from modified UTF-7 — Bug, medium
IMAP encodes non-ASCII mailbox names in modified UTF-7 (RFC 3501 §5.1.3), so a
folder called `受信箱` arrives as `&ZeVnLIqe-` and is displayed verbatim in the
picker and in Settings. Nothing decodes it.

Round-tripping is unaffected — we send back exactly what the server gave us — so
this is cosmetic, but it is very visible to anyone with non-English folders.

*Fix:* decode for display only, in `mime.ts`; keep the raw name as the value.

### 1.5 Attached emails are opaque — Bug, low
`walkPart` treats `message/rfc822` as an attachment rather than recursing into
it, so a forwarded message's text is lost. "What did the forwarded mail say?"
returns nothing.

### 1.6 `multipart/alternative` takes the first part that yields text — Bug, low
Well-formed senders put `text/plain` first, so this is right in practice. A
sender who puts HTML first gets the HTML-converted text even when a plain part
exists. Prefer by content type rather than by position.

### 1.7 RFC 2231 filename continuations unhandled — Bug, low
`filename*0=`/`filename*1=` (very long attachment names) parse as a truncated
name. Documented in `mime.ts`. The name is display-only — nothing can be
downloaded — so the cost is cosmetic.

### 1.8 Attachment sizes are the encoded length — Bug, low
Reported size is the length of the encoded part, so base64 attachments read
about 33% larger than the real file.

### 1.9 `\Deleted` messages still appear — Bug, low
Messages flagged deleted but not yet expunged are listed like any other.

### 1.10 The displayed date is sender-controlled — Bug, low
`parseMailDate` prefers the message's own `Date` header and falls back to
`INTERNALDATE`. A message with a wrong or forged `Date` displays that date.
Preferring `INTERNALDATE` (what the server saw) would be more truthful.

---

## 2. Performance and scale

### 2.1 Only the newest 50, with no way back — Gap, high
`UID SEARCH` returns *every* matching uid and we keep the last 50, discarding
the rest. There is no "load more", so older mail is unreachable from the UI
however much of it matched.

*Fix:* keep the uid list and page through it. Cheap — the expensive call
(`UID FETCH`) is already batched, and the uid list is just integers.

### 2.2 Everything re-downloads on every visit — Gap, high
Nothing is cached anywhere. `App` renders `{view === "mail" && <MailView />}`,
so navigating away unmounts the view and discards both the list and any opened
messages. Returning to Mail is a fresh TLS handshake, `LOGIN`, `EXAMINE`,
`UID SEARCH`, `UID FETCH`, `LOGOUT`.

Options, in increasing order of commitment:
- **In-memory, app-scoped.** Survives navigation, dies with the app. No stated
  privacy property changes. Cheap.
- **On-disk with background backfill.** Genuinely better for a large mailbox,
  but it means the app *stores your email* — see §3.1, which is a decision
  rather than an implementation detail.

Either way, key on `UIDVALIDITY` (§1.1).

### 2.3 An attachment is downloaded to be thrown away — Bug, high
Opening a message with a 10 MB PDF pulls 256 KB of base64 to display a
two-line email, then discards the attachment parts client-side. Slow on every
platform, and on web it is 256 KB through the Worker as well.

*Fix:* the same `BODYSTRUCTURE` part-fetch as §1.2.

### 2.4 A fresh TLS handshake and `LOGIN` per operation — Gap, medium
Every op is connect → login → one command → logout. Reading five messages is
five logins. **Apple throttles repeated IMAP authentication**, so an active
session could plausibly trip it, and it would surface as
`[AUTHENTICATIONFAILED]` — indistinguishable from a wrong password (§3.3).

Desktop could hold a connection open in Rust. The Worker structurally cannot
without Durable Objects, which this project deliberately doesn't use.

### 2.5 The web relay's rate limit is reachable by a person — Gap, low
`MAIL_LIMIT` is 30/min per user and one op is one message opened. A brisk few
minutes of reading could hit it. Raising it trades against §2.4.

### 2.6 The assistant caches nothing — Gap, low
Every `search_mail` and `get_message` is its own connection. A question that
searches and opens two messages is three round-trips to Apple.

### 2.7 Large mailboxes vs. the 20-second deadline — Gap, low
Both executors give the whole conversation 20s. A very large `UID SEARCH` could
exceed it and surface as "the mail server took too long". Untested at scale.

---

## 3. Privacy and security

### 3.1 A disk cache would reverse a stated promise — Decision, high
"Nothing is stored" is currently a *claim we make to the user*: in the README,
in CLAUDE.md, and in the Settings pane beside the relay warning. Any on-disk
cache (§2.2) makes that false, and browser storage is plaintext on the origin —
the same place the CSP note says an XSS can read.

If we cache to disk, the honest version ships **with** the Settings copy
rewritten and a "clear cached mail" control, in the same change.

### 3.2 Mail read by the assistant goes to OpenAI — Accepted, medium
Scoped more tightly than it first appears, and worth stating precisely:
- `search_mail` sends **no bodies** — subject, sender, date, read state only.
- `get_message` sends **one message's text**, up to 20,000 characters, in full
  (not just the matching part), for messages the model chose to open.
- Tool results live in a single turn's `messages` array and are **not** re-sent
  on later turns. An email read three questions ago is not still travelling.
- But: what the model *quotes in its reply* is in the history and does persist;
  the model's choice of what to open is judgement, not a filter, and the loop
  allows up to 8 rounds; and 50 subject lines and sender addresses per search is
  itself a description of who is emailing you.

Inherent to the feature. Not currently said anywhere in the UI — one line under
the connect button would cover it.

### 3.3 Web sign-in fails with `[AUTHENTICATIONFAILED]` — Unresolved, high
Desktop works with the same credentials; the two paths send a byte-identical
`LOGIN`. Two candidates, undistinguished by Apple's response:
1. The username on web is still the old (non-@icloud.com) address — web has its
   own `localStorage` and credentials deliberately don't sync.
2. Apple refusing app-specific-password logins proxied from a Cloudflare
   datacenter IP.

If (2), **no code change fixes it** and mail becomes desktop-only — in which
case the web Settings pane should say so rather than offer a button that cannot
succeed.

### 3.4 The web relay sees the password and the mail — Accepted, high
TLS terminates at the Worker. Nothing stored, nothing logged, session required,
iCloud-only, rate-limited. Documented at length in `worker/src/routes/mail.ts`
and stated in the Settings pane. Unavoidable for any browser client; desktop is
unaffected.

### 3.5 The credential is plaintext in `localStorage` — Accepted, medium
Same as the CalDAV password. `secrets.ts` narrows the surface and shortens the
lifetime; it is not encryption. The real fix is an OS keychain on desktop.

---

## 4. Functional gaps

None of these are broken — they were never built.

- **No pagination controls** (§2.1) and no unified/all-mailbox search: the box
  searches only the selected mailbox.
- **No unread counts** on mailboxes, no badge anywhere.
- **No threading** — a conversation is N separate rows.
- **No attachment download** and **no inline images**; attachments are listed
  only. Deliberate: there is no fetch-a-part path at all.
- **Nothing offline.** Mail is live-only, so an offline app has no mail
  whatsoever — unlike every other domain, which falls back to a cache.
- **Read state diverges.** Reading in Sekunda cannot mark a message read (the
  connection is read-only by design), so Apple Mail still shows it unread. Arguably
  correct, definitely surprising.
- **iCloud's `TEXT` search may not index bodies.** Unverified. If it matches
  headers only, the search box is quietly weaker than it looks and the tool
  description's hedge is doing real work.
- **New server-side mailboxes don't appear** until Settings → Reconnect; the
  folder list is cached at connect time.
- **The "Read-only" marker is hidden below `md`** — trivial, but the one place
  the UI explains why there are no buttons.

---

## 5. Process and verification

### 5.1 The fake IMAP server is more permissive than Apple — Process, medium
The scripted-server suite passed the trailing-space bug that made *every*
filtered search fail against iCloud. A harness written alongside the client
shares its assumptions. It proves framing and sequencing; it does not prove
protocol conformance.

### 5.2 `get_message` is unverified on complex real mail — Process, medium
The MIME parser is tested against constructed messages. Real-world mail —
nested multiparts, `multipart/related` with inline images, Outlook's
`text/calendar` parts, unusual charsets — has not been through it.

### 5.3 Assistant routing is empirical — Process, low
The `search_people`-instead-of-`search_mail` misrouting was fixed with prompt
wording. Prompt fixes cannot be proven, only observed. If it recurs, the next
levers are renaming `search_mail` to something unconfusable, or making
`search_people` state that it is not email.

---

## Suggested order

1. **`BODYSTRUCTURE` part-fetch** — fixes §1.2 and §2.3 together; the largest
   single win, and it makes every message open fast.
2. **Pagination** — fixes §2.1; nearly free, the uid list is already in hand.
3. **`UIDVALIDITY` plumbed through** — fixes §1.1 and unblocks any caching.
4. **In-memory session cache** — most of §2.2 with no privacy change.
5. **Sort by date** (§1.3) and **decode mailbox names** (§1.4) — small, visible.
6. **Resolve §3.3** — it decides whether web mail exists at all.
7. Then reassess the on-disk cache (§3.1). It may not be worth it once 1–4 land.
