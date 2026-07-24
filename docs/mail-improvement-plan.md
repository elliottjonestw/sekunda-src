# iCloud Mail — improvement plan

Closes every item in [`mail-known-issues.md`](mail-known-issues.md). Seven
phases, each one shippable on its own and leaving the app working.

> **Status: phases 1–4 and 7 shipped. Phases 5 and 6 were skipped by decision**,
> after testing in production. So this document is history rather than a
> worklist, and it is **not** the record of what happened —
> [`mail-known-issues.md`](mail-known-issues.md) is, including what skipping 5
> and 6 left open. Read that first.
>
> The one thing to carry forward: phase 5's gate asked for a *measurement* of
> ops per minute, and none was taken. Phase 6's corpus of real mail was never
> built, so every automated test here still runs on constructed fixtures.

## Decisions this plan is built on

Taken deliberately; the rest of the plan follows from them.

1. **Caching is IN-MEMORY only.** No IndexedDB, no localStorage, no D1. The
   cache survives navigating between pages and dies with the app. "Nothing is
   stored" stays literally true, so the README, CLAUDE.md and the Settings pane
   need no privacy rewrite and no clear-cache control. Revisit on-disk caching
   only after Phases 1–3, with real numbers.
2. **Strictly read-only, permanently.** `EXAMINE` and `BODY.PEEK` stay. The
   guarantee remains *the server's*, not a property of my code being correct,
   which is what makes it robust against a bug or a prompt injection in the
   assistant. Accepted cost: unread state diverges from Apple Mail.
3. **Attachment download is the only new feature.** Threading, unread badges and
   unified search are explicitly out (§7.3). Downloading a part is still a read,
   so it does not touch decision 2.
4. **Web mail works** — the earlier `AUTHENTICATIONFAILED` was an undeployed
   Worker. Both platforms stay supported. Issue §3.3 is closed, not fixed.

---

## Phase 1 — Fetch the right bytes

**The biggest win in the plan, and the riskiest change.** Everything else is
smaller than this.

Today `get_message` fetches `BODY.PEEK[]<0.262144>` — the first 256 KB of the
whole raw message, attachments and all — and `mime.ts` walks it. That wastes the
download, and worse, it can *lose* the body when a large part precedes the text
(§1.2).

**Approach:** ask the server what the message is made of before asking for any
of it. `BODYSTRUCTURE` is a parse of the MIME tree that costs no body bytes.

New sequence for `fetch`:
1. `UID FETCH n (UID FLAGS INTERNALDATE RFC822.SIZE BODYSTRUCTURE)`
2. Decide from the structure:
   - small message (≤ 64 KB total) → `BODY.PEEK[]` as today, and let the
     existing, well-tested `mime.ts` walker handle it;
   - otherwise → fetch **only** the chosen text part, `BODY.PEEK[2.1]` style.
3. Attachments are listed **from the structure**, so their names, types and
   **true sizes** are known without downloading a byte.

Both fetches ride the same connection, so the extra round-trip is nearly free.

**Work**
- `worker/src/imap.ts` + `src-tauri/src/mail.rs`: a `BODYSTRUCTURE` parser. The
  existing token parser already handles the nesting; this adds the *semantics* —
  walking the parenthesised tree into `{ partNumber, type, subtype, encoding,
  charset, size, filename, disposition }`, including the `message/rfc822` and
  nested-multipart forms.
- `packages/shared/src/mail.ts`: the fetch result gains `structure` and
  `part_encoding`/`part_charset` for whatever was returned.
- `src/lib/mail/mime.ts`: gains a "decode one already-isolated part" path beside
  the existing whole-message walker. The walker stays — it is the small-message
  path and it is the tested one.

**Closes:** §1.2, §1.5 (the structure exposes nested `message/rfc822`, so its
text part is selectable), §1.6 (choose `text/plain` by *type*, not position),
§1.8 (true sizes), §2.3.

**Risk:** `BODYSTRUCTURE` is the most intricate thing in IMAP, and it is written
twice. Mitigated by keeping the whole-message path for small mail — the common
case never touches the new code — and by Phase 6's corpus test, which should be
built *first* if this phase slips.

**Verify:** parser unit tests both languages against structures captured from
real mail; a message with a 10 MB attachment opens as fast as one without; a
message whose text follows a large inline image renders its text (today: empty).

---

## Phase 2 — Show the right messages, in the right order

Small, visible, low-risk. Good to ship right after the big one.

- **Pagination (§2.1).** `UID SEARCH` already returns every matching uid; keep
  the whole list in view state and fetch headers a page at a time. UI is an
  explicit **"Load older"** button, not infinite scroll — each page is a network
  round-trip to Apple, and scroll-triggered fetching would fire them by
  accident. Page size stays 50.

  Paging over a *snapshot* of the uid list is safe against mail arriving
  mid-session, and that is a property of uids rather than luck: uids ascend with
  arrival, so a new message is always above the window being paged, never inside
  it. Offset-based paging is what duplicates and skips rows; this cannot. A
  message deleted while paging simply comes back missing from `UID FETCH`, which
  is skipped silently.
- **Sort by date, not uid (§1.3).** Sorting moves client-side into `searchMail`,
  which already resolves `Date` and `INTERNALDATE`. Uid order is arrival order in
  that mailbox, which is wrong for anything filed or imported.
- **Decode mailbox names (§1.4).** Modified UTF-7 → text, for *display only*;
  the raw name stays the value we send back. Lives in `mime.ts` beside the other
  decoders.
- **Hide `\Deleted` (§1.9).** Add `NOT DELETED` to every search.
- **Date shown (§1.10).** Keep the `Date` header as the displayed date — it is
  what every other mail client shows — but fall back to `INTERNALDATE` sooner:
  when `Date` parses to something absurd (more than a day in the future, or
  before 1990), prefer what the server saw.
- **The read-only marker below `md` (§4).** Currently `hidden md:flex`; make it
  visible on mobile, where the absence of buttons is most confusing.

### Freshness — how new mail arrives

Paging handles going *backwards*; this is the front of the list. It replaces
the TTL sketched for the cache in Phase 3, and is better than it: a TTL is a
guess standing in for something the server will tell us exactly.

`STATUS <mailbox> (UIDNEXT MESSAGES UNSEEN)` is one cheap command carrying no
message data:

- **Unchanged `UIDNEXT` and `MESSAGES`** — the cached list is *provably* current.
  Serve it, no expiry guessing.
- **`UIDNEXT` moved** — fetch headers for only the new uids (`UID FETCH <cached>:*`)
  and prepend them. An arrival costs one small fetch, never a re-search.
- **Filtered lists** get the same treatment restricted to the new range
  (`UID SEARCH UID <cached>:* <criteria>`), so we learn whether the new mail
  matches the current query without redoing the search.
- **`MESSAGES`** catches deletions elsewhere; **`UNSEEN`** catches
  read-elsewhere.

**When to check: on mount and on window focus. No timer.** `STATUS` still needs
a connection and a login, so a poll every N seconds is a login every N seconds
forever, including while nobody is looking — the same objection that keeps the
Today summary off a timer. Real push (IMAP `IDLE`) needs a held connection, so
it is desktop-only and belongs in Phase 5 behind the same measurement gate, if
at all.

Note for Phase 5: `STATUS` on a mailbox that is *currently selected* is
discouraged by the RFC. It is correct here only because each op is its own
one-shot connection. If a connection is ever held open, the equivalent is `NOOP`
on the selected mailbox and reading the untagged `* n EXISTS` it triggers.

**Verify:** an Archive folder with imported mail orders by send date; a
non-English folder name renders; "Load older" walks back through a large
mailbox; sending yourself a message and refocusing the window shows it without a
full re-search (observable as one `STATUS` + one small `FETCH`).

---

## Phase 3 — UIDVALIDITY, then the in-memory cache

**Order matters inside this phase.** `UIDVALIDITY` must land before the cache,
not with it: a uid is only meaningful while that number is unchanged, and a
cache keyed without it would serve *a different message* under the subject you
clicked (§1.1).

**3a. Plumb `UIDVALIDITY`.** `EXAMINE` already returns `* OK [UIDVALIDITY n]`
and both executors discard it. Capture it, return it on every `search` and
`fetch` result, and surface it in `MailOpResult`.

**3b. The cache.** A module in `src/lib/mail/cache.ts`, used by `mailbox.ts` —
**not** by `MailView`. That placement is the point: putting it behind the
business layer means the assistant's `search_mail`/`get_message` get the same
cache for free (§2.6), where a cache inside the view would help only the UI.

- Message bodies keyed `account|mailbox|uidvalidity|uid` — immutable content, so
  they can live for the session.
- Search results keyed `account|mailbox|uidvalidity|criteria`, validated by the
  `STATUS` check from Phase 2 rather than by a TTL — `UIDNEXT`/`MESSAGES` say
  whether the list is current, which a timer can only guess at. The **refresh
  button bypasses everything** and re-searches.
- A `UIDVALIDITY` that differs from the cached one drops every entry for that
  mailbox.
- Cleared on sign-out and on disconnect, alongside `clearSecrets()`.
- Bounded (an LRU of ~200 messages) so a long session can't grow without limit.

**Closes:** §1.1, §2.2, §2.6.

**Verify:** navigate Mail → Calendar → Mail and see no network call; refresh
still fetches; a forced `UIDVALIDITY` change empties the right entries.

---

## Phase 4 — Attachment download

The one new feature (decision 3). Still read-only: fetching a part is a read.

- **New op `part`**: `{ mailbox, uid, part, encoding }` → the part's bytes.
- **Web returns the part still encoded** (base64 as it sits on the wire) and the
  client decodes. Decoding in the Worker would inflate a 10 MB attachment into a
  ~20 MB JSON string in an isolate with a 128 MB ceiling; passing it through
  untouched keeps the relay cheap and moves the work to the machine that wants
  the file anyway.
- **Caps:** 10 MB, both platforms, with an explicit "too large to download here"
  message rather than a truncated file. Bigger needs streaming, which the JSON
  envelope cannot do — a deliberate stopping point.
- **Saving:** desktop uses the already-wired `plugin-dialog` save dialog +
  `plugin-fs`; web uses a `Blob` and an `<a download>`. Both behind one function
  in `src/lib/mail/`, so the view doesn't branch on platform.
- **UI:** the attachment chips in `MailView` become buttons with a size and a
  spinner. Nothing is fetched until clicked.
- **Assistant:** gets NO attachment tool. It has no use for bytes it cannot
  read, and a tool that pulls 10 MB into a chat turn is a mistake waiting to be
  made.

**Closes:** the attachment-download gap in §4. Depends on Phase 1 — without
`BODYSTRUCTURE` there are no part numbers to fetch.

---

## Phase 5 — Connection reuse, *only if measured*

§2.4 is the item I'd most like to skip. Every op is currently connect → login →
command → logout, so reading five messages is five logins, and **Apple throttles
repeated authentication** — a real risk of an `AUTHENTICATIONFAILED` that has
nothing to do with credentials.

But Phase 3's cache removes most repeat ops, and this is the change most likely
to introduce a subtle lifecycle bug. So:

**Gate:** after Phases 1–3, measure ops per minute during ordinary use. If a
realistic session stays well under Apple's tolerance and under `MAIL_LIMIT`, do
nothing and record the measurement.

If it doesn't:
- **Desktop:** hold one authenticated connection per account in Rust behind a
  mutex, with an idle timeout (~2 min) and a re-login on failure. Contained,
  because the desktop process is long-lived.
- **Web:** *not* a persistent connection — the Worker is stateless by design and
  Durable Objects are deliberately unused. Instead add a **batch op**: several
  commands in one request, hence one login. That collapses "search then open
  three messages" from four logins into one.
- **Revisit `MAIL_LIMIT` (§2.5)** in the same change, since batching changes what
  one request costs.
- **Revisit the 20 s deadline (§2.7)** with a real large-mailbox measurement.

---

## Phase 6 — Robustness and honest testing

The parser is tested against messages I wrote, which is the weakest part of the
whole feature (§5.1, §5.2).

- **A real corpus.** A script that saves raw messages from a live mailbox to
  `e2e/fixtures/mail/` (gitignored — it is personal mail), and a test that runs
  `parseMessage` over every one, asserting no throw, non-empty text where a text
  part exists, and a sane attachment list. This is how the `message/rfc822`,
  `multipart/related`, `text/calendar` and odd-charset cases get found: by
  meeting them, not by imagining them.
- **A stricter fake server (§5.1).** The harness passed the trailing-space bug
  that broke every filtered search against Apple. Make it validate command
  syntax against the RFC grammar subset we use, and reject what Apple rejects.
- **RFC 2231 filenames (§1.7).** Small; do it here with the corpus to prove it.
- **Assistant routing (§5.3).** No code change. Watch it; if `search_people` wins
  again, rename `search_mail` to something unconfusable and make `search_people`
  say it is not email.

---

## Phase 7 — Say the true thing

Cheap, and the part most likely to be skipped.

- **What goes to OpenAI (§3.2).** One line under the Settings connect button:
  searches send subjects and senders; opening a message sends its text for that
  question only. Precise, not alarming — and precise is what makes it credible.
- **Docs.** README and CLAUDE.md updated for pagination, caching (in-memory, and
  *why* not disk), attachments, and the read-only decision as a decision.
- **`mail-known-issues.md`** becomes the record: each item marked fixed with its
  phase, or accepted with the reason.
- **Declare the out-of-scope gaps** (§7.3 below) in the README rather than
  leaving them to be rediscovered.

---

## Coverage

Every issue, and where it goes.

| Issue | Phase |
|---|---|
| §1.1 `UIDVALIDITY` unchecked | 3a |
| §1.2 Truncation loses the body | 1 |
| §1.3 Sorted by uid | 2 |
| §1.4 Mailbox names not decoded | 2 |
| §1.5 Attached emails opaque | 1 |
| §1.6 `multipart/alternative` by position | 1 |
| §1.7 RFC 2231 filenames | 6 |
| §1.8 Attachment sizes wrong | 1 |
| §1.9 `\Deleted` shown | 2 |
| §1.10 Sender-controlled date | 2 |
| §2.1 Newest 50 only | 2 |
| §2.2 Re-downloads every visit | 3b |
| §2.3 Attachment downloaded to discard | 1 |
| §2.4 TLS + LOGIN per op | 5 (gated) |
| §2.5 `MAIL_LIMIT` reachable | 5 |
| §2.6 Assistant caches nothing | 3b |
| §2.7 20 s deadline at scale | 5 |
| §3.1 Disk cache reverses a promise | Decision 1 — no disk cache |
| §3.2 Mail to OpenAI | 7 |
| §3.3 Web sign-in fails | Closed — was an undeployed Worker |
| §3.4 Relay sees password and mail | Accepted; unchanged |
| §3.5 Credential plaintext in localStorage | Accepted; keychain is its own project |
| §4 Attachment download | 4 |
| §4 Read-only marker hidden on mobile | 2 |
| §4 New mailboxes need Reconnect | 2 (re-LIST on mount, cached) |
| §4 `TEXT` body indexing unverified | 6 (answered by the corpus work) |
| §5.1 Lenient fake server | 6 |
| §5.2 `get_message` unverified on real mail | 6 |
| §5.3 Routing is empirical | 6 |

### 7.3 Deliberately not doing

- **Threading.** IMAP gives no reliable threading; reconstructing it from
  `References`/`In-Reply-To` is real work for a result that often looks wrong.
- **Unread counts.** Cheap (`STATUS`), but it is a per-mailbox call on every
  list, and nobody asked for it.
- **Unified search.** One search per mailbox; wait until connection reuse (Phase
  5) makes it not-slow, then reconsider.
- **Offline mail.** Requires the disk cache that decision 1 declined.
- **Any write path.** Decision 2.

---

## Sequencing

**1 → 2 → 3 → 4**, then **6**, with **5** gated on measurement and **7**
alongside whichever phase changes user-visible behaviour.

Phase 1 is the one to do carefully — it is twice-written parsing of the
fiddliest part of the protocol, and everything downstream assumes it. If it
looks shaky when started, build Phase 6's corpus first and develop Phase 1
against real mail.
