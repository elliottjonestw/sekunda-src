# iCloud Mail — known issues, and what became of them

Originally the list of everything wrong with or missing from the mail feature.
It is now **the record**: every item carries its outcome, and the ones still
open say why they are open rather than quietly disappearing.

Worked through in [`mail-improvement-plan.md`](mail-improvement-plan.md).
Phases 1–4 and 7 shipped. **Phases 5 and 6 were skipped** — see
[Where it stopped](#where-it-stopped), which is the most important part of this
document, because it is the part a reader would otherwise have to infer.

Legend: **FIXED** — done, with the phase. **ACCEPTED** — deliberate, documented,
still true. **OPEN** — still wrong, and nothing is scheduled.

---

## 1. Correctness

### 1.1 `UIDVALIDITY` is never checked — FIXED (phase 3a)
Both executors discarded the `* OK [UIDVALIDITY n]` that `EXAMINE` already
sends. It now rides on every op that opens a mailbox, `STATUS` asks for it too,
and it is part of every cache key — a change drops everything remembered about
that mailbox.

Landed **before** the cache rather than with it, deliberately: a uid names a
message only while that number holds, so a cache keyed without it would serve
the wrong email under the subject that was clicked.

### 1.2 A truncated fetch can lose the body entirely — FIXED (phase 1)
`BODYSTRUCTURE` is now read first — the server's own parse of the MIME tree,
costing no body bytes and riding the connection that is already open. Messages
at or under `MAIL_SMALL_MESSAGE_BYTES` (64 KB) still take the whole-message path
and the original, well-tested walker; larger ones fetch only the text part the
structure names.

Keeping the small path is the risk control: the common case never touches the
newer code. A structure we cannot read falls back to it too.

### 1.3 Messages sort by uid, not by date — FIXED (phase 2)
Sorted client-side in `searchMail` by the resolved date. Uid order is arrival
order *in that mailbox*, which is wrong for anything filed, moved or imported.

### 1.4 Mailbox names are not decoded from modified UTF-7 — FIXED (phase 2)
`decodeMailboxName` in `mime.ts`, for display only. `MailFolder.name` stays
exactly what the server said, because that is what every later command carries;
`label` is the readable one. `list_mailboxes` returns both and the tool
description says which is which.

### 1.5 Attached emails are opaque — FIXED (phase 1)
The structure walker recurses into `message/rfc822` and marks everything inside
it `embedded`. The attached message is still listed as an attachment; its text
is the *fallback* body, never preferred over the message's own.

### 1.6 `multipart/alternative` takes the first part that yields text — FIXED (phase 1)
`chooseTextPart` picks by type: plain, then HTML, then the same two inside an
attached message. Position is not consulted.

### 1.7 RFC 2231 filename continuations unhandled — **OPEN**
`filename*0=`/`filename*1=` still parse as a truncated name. Was scheduled for
phase 6, alongside the corpus that would have proven it.

**It costs more than it did.** The original note said the name was display-only
because nothing could be downloaded — that is no longer true (§4), so a long or
non-ASCII attachment name now produces a wrong *saved filename*, not merely a
wrong label. Noted in `parseContentType`.

### 1.8 Attachment sizes are the encoded length — FIXED (phase 1)
Sizes come from `BODYSTRUCTURE`, which is the server's own count. The old figure
was whatever survived truncation — wrong precisely when the attachment was large
enough to care about.

Still the *encoded* size, which is what the server reports and what `size` is
documented to mean; base64 reads about a third above the saved file.

### 1.9 `\Deleted` messages still appear — FIXED (phase 2)
`UNDELETED` leads every search. It also makes the key list never empty, so the
old `ALL` fallback has nothing left to guard.

### 1.10 The displayed date is sender-controlled — FIXED (phase 2)
The `Date` header is still preferred, because it is what every mail client shows
and what the sender meant — but only while it is *plausible* (under a day in the
future, after 1990). Outside that, `INTERNALDATE` wins. Not a spam filter; a
refusal to let a sender pin itself to the top of a date-sorted list.

---

## 2. Performance and scale

### 2.1 Only the newest 50, with no way back — FIXED (phase 2)
`search` returns every matching uid (capped at `MAIL_MAX_UIDS` = 5,000) and a
page is a `headers` op over a slice of it. An explicit **Load older** button, not
infinite scroll: each page is a login and a round-trip to Apple, and a scroll
position should not be able to spend one by accident.

Paging over a *snapshot* is safe against mail arriving mid-session as a property
of uids rather than luck — uids ascend with arrival, so a new message is always
above the window being paged.

### 2.2 Everything re-downloads on every visit — FIXED (phase 3b)
`src/lib/mail/cache.ts`, in memory only. Search results validated by the
`STATUS` check rather than a TTL; message bodies need no revalidation at all,
being immutable content. Cleared on sign-out, account deletion, disconnect and
connect.

### 2.3 An attachment is downloaded to be thrown away — FIXED (phase 1)
Same `BODYSTRUCTURE` change as §1.2. Attachments are described — name, type,
true size — without a byte of them crossing the wire until asked for.

### 2.4 A fresh TLS handshake and `LOGIN` per operation — **OPEN, accepted for now**
Still one connect → login → command → logout per op. Phase 5 would have added
connection reuse on desktop and a batch op on web, **gated on measuring ops per
minute during ordinary use**.

That measurement was never taken. The gate was closed on two weaker grounds: use
in production without trouble, and a count from the code — opening the page is
2 ops, a message is 1, a refocus with nothing new is 1, so reading five messages
is about 7 and a busy minute lands near 16, against a `MAIL_LIMIT` of 30/60s.
Phase 3's cache removes most repeat ops, which was the plan's own reason for
expecting the gate to close.

**What that does not cover:** `MAIL_LIMIT` is web-only and per-colo; the desktop
path talks to Apple directly with no cap of ours, so Apple's authentication
throttling is the only bound there and no figure for it is known. If
`[AUTHENTICATIONFAILED]` ever appears on a working password, this is the first
thing to suspect.

### 2.5 The web relay's rate limit is reachable by a person — **OPEN**
`MAIL_LIMIT` is unchanged at 30/min. Phase 3's cache made it materially harder
to reach — a re-read costs nothing now — but the number was never revisited,
because that was to happen in the same change as §2.4.

### 2.6 The assistant caches nothing — FIXED (phase 3b)
The cache sits behind `mailbox.ts` rather than inside `MailView`, so
`search_mail` and `get_message` get it too. That placement was the point.

### 2.7 Large mailboxes vs. the 20-second deadline — **OPEN, partly moved**
Still 20 s for every op except attachment download, which was raised to 60 s in
phase 4 — that one is bounded by bytes rather than latency, and a working
download reporting "the mail server took too long" is the worst of both.

A very large `UID SEARCH` against the 20 s deadline remains untested at scale.

---

## 3. Privacy and security

### 3.1 A disk cache would reverse a stated promise — ACCEPTED, and the promise holds
Answered by declining the disk cache. The cache built in phase 3 is in memory:
it dies with the app process and touches no storage, so "nothing is stored"
stays literally true and needed no rewrite of the README, CLAUDE.md or the
Settings copy, and no "clear cached mail" control.

Revisit only with real numbers. An on-disk cache turns a promise about there
being nothing to retain into a promise about a *retention policy*, which is a
bigger decision than a performance fix.

### 3.2 Mail read by the assistant goes to OpenAI — ACCEPTED, and now SAID (phase 7)
Unchanged in substance, and the substance is narrower than it sounds: a search
sends subjects, senders and dates and no message text; opening a message sends
that message's text for that one question; tool results are not re-sent on later
turns, though what the model quotes back persists in the conversation.

The gap was that none of it was stated in the UI. There is now a line in
Settings → Mail, and a paragraph in the README. Written precisely rather than as
a warning — "some data may be shared" is the kind of sentence people learn to
skip.

### 3.3 Web sign-in failed with `[AUTHENTICATIONFAILED]` — CLOSED, not a bug
The Worker had not been deployed with the current code. Kept because the failure
mode is worth recognising: Apple answers the same way for a wrong password and
for a relay problem, so "check your credentials" is not a safe conclusion.

### 3.4 The web relay sees the password and the mail — ACCEPTED, unchanged
TLS terminates at the Worker. Nothing stored, nothing logged, session required,
iCloud-only, rate-limited. Documented at length in `worker/src/routes/mail.ts`
and stated in the Settings pane. Unavoidable for any browser client; desktop is
unaffected.

### 3.5 The credential is plaintext in `localStorage` — ACCEPTED, unchanged
Same as the CalDAV password. `secrets.ts` narrows the surface and shortens the
lifetime; it is not encryption. The real fix is an OS keychain on desktop, which
is its own project.

---

## 4. Functional gaps

- **No pagination controls** — FIXED (phase 2).
- **No attachment download** — FIXED (phase 4). One at a time, on click, capped
  at 10 MB, and it **refuses rather than truncates**: a file cut short is a
  corrupted file that looks like a saved one. The assistant deliberately gets no
  attachment tool.
- **New server-side mailboxes don't appear** — FIXED (phase 2): re-`LIST` on
  mount, still cached in settings so the picker renders before the network
  answers.
- **The "Read-only" marker is hidden below `md`** — FIXED (phase 2). It was
  hidden exactly where it is needed most.
- **No threading**, **no unread counts**, **no unified search**, **nothing
  offline** — ACCEPTED, and now **declared in the README** rather than left to
  be rediscovered. Each has a reason there.
- **No write path of any kind** — SUPERSEDED. This was the decision the whole
  design rested on, and reads still hold to it (`EXAMINE` + `BODY.PEEK`, the
  server enforcing it). Writes were then added deliberately, for the reader UI
  only: **mark-as-read** on open (`UID STORE \Seen`), **delete** (`UID MOVE` to
  Trash, or an expunge from Trash) and **move** (`UID MOVE` to a named folder,
  which drives **Move to Junk** and is generic enough for a future Move to
  Archive). Each opens the mailbox read-write and issues exactly one constrained
  mutation; the assistant builds none of them, so its read-only guarantee is
  unchanged. This also closes the old **"read state diverges from Apple Mail"**
  cost — opening a message here now marks it read there. The new posture: reads
  are protocol-enforced read-only, writes are a small named set, and the
  relay/command headers say so where the old blanket claim lived.
- **No inline images** — still true. Message bodies render as plain text and
  widening that is not a rendering choice but a security one.
- **iCloud's `TEXT` search may not index bodies** — **OPEN, still unverified.**
  Phase 6 was to answer this. If it matches headers only, the search box is
  quietly weaker than it looks and the tool description's hedge is doing real
  work.

---

## 5. Process and verification

All three were phase 6. **None of them was done.**

### 5.1 The fake IMAP server is more permissive than Apple — **OPEN**
Unchanged. The harness still shares the client's assumptions, and it is the
thing that passed the trailing-space bug which made every filtered search fail
against iCloud.

What *was* added is narrower and worth knowing about: unit tests for the pure
parsing layer, run by `npm test` — `worker/test/` for `BODYSTRUCTURE`, `STATUS`,
`EXAMINE`, part numbers and the op envelope, and `test/` for the client's MIME
decoding and the cache. They cover the twice-written parsers on both sides, and
they found two real bugs while being written. They are not a conformance test.

### 5.2 `get_message` is unverified on complex real mail — **OPEN, partly answered by use**
No corpus was built. Nothing in phases 1–4 was developed against a real mailbox;
every fixture in the test suite is constructed.

The author reports testing in production and finding it works, which is real
evidence and is why the corpus was skipped — but it is *use*, not coverage. The
cases the corpus existed to find are the ones that do not appear in a normal
inbox on a normal day: `multipart/related` with inline images, Outlook's
`text/calendar` parts, deeply nested forwards, unusual charsets. If a message
ever opens blank or garbled, this is the reason there is no test that would have
caught it, and `e2e/fixtures/mail/` is the thing to build.

### 5.3 Assistant routing is empirical — **OPEN by nature**
Unchanged, and unchangeable: prompt fixes can be observed, not proven. If
`search_people` wins again, the levers are renaming `search_mail` to something
unconfusable, or making `search_people` state that it is not email.

---

## Where it stopped

Phases 1–4 shipped, then phase 7. **Phases 5 and 6 were skipped by decision**,
after testing in production, and the effect is worth stating plainly rather than
leaving it to be worked out from the sections above:

- **Nothing in this feature has been tested against a corpus of real mail.**
  Every automated test uses constructed fixtures. Confidence in the MIME and
  `BODYSTRUCTURE` work rests on unit tests plus one person's use of one mailbox.
- **The connection-per-op cost was never measured**, only estimated from the
  code. The estimate says there is plenty of headroom on the web path; the
  desktop path has no cap of ours at all.
- **Three small correctness items remain open** — RFC 2231 filenames (§1.7,
  which got *more* expensive when download shipped), the permissive fake server
  (§5.1), and whether iCloud's `TEXT` search indexes bodies (§4).

None of that is a reason the feature does not work — it does. It is the list of
what a future problem would most likely be, and where to look first.
