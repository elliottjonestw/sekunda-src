# 🧠 Sekunda

A personal life-management desktop app: **Calendar, Reminders, Notes, Diary, and People** in one integrated tool, with an optional **AI assistant** that can answer questions about your data *and* create, update, or delete items on your behalf. Built with Tauri v2 + React + TypeScript on a Cloudflare Worker + D1 backend, so your data follows you between devices. You sign in with an account; reads fall back to a local cache when you're offline, and writes fail loudly rather than pretending to succeed. The other network calls are the ones you opt into: OpenAI (assistant/voice) and your own **iCloud calendar** if you connect one.

## Stack

| Layer | Choice |
|-------|--------|
| Shell | Tauri v2 (Rust) |
| Frontend | React 19 + TypeScript + Vite + Tailwind CSS |
| Icons | `lucide-react` |
| Languages | `i18next` + `react-i18next` (English, 繁體中文) |
| Database | Cloudflare D1 (SQLite) behind a Hono Worker; image bytes in Workers KV |
| Auth | Own implementation — client-side argon2id KDF, server-side keyed verifier, JWT + rotating refresh tokens |
| Read cache | IndexedDB, stale-while-revalidate |
| Notifications | `tauri-plugin-notification` |
| Recurrence | `rrule` (RFC 5545) for local events; `ical.js` for remote (TZID-aware) |
| ICS import/export | `ical-generator` (export) + `ical.js` (import) |
| Calendar sync | CalDAV (RFC 4791) over `tauri-plugin-http`; `ical.js` for VEVENT parse/serialize |
| File I/O | `tauri-plugin-dialog` + `tauri-plugin-fs` |
| Networking | `lib/httpFetch.ts` — `tauri-plugin-http` in the app (bypasses webview CORS), native `fetch` on the web |
| Voice | `getUserMedia`/`MediaRecorder` + OpenAI Whisper (STT); OpenAI `audio/speech` or Web `speechSynthesis` (TTS) |

The Rust side is intentionally thin — plugin registration only (`src-tauri/src/lib.rs`), with no database and no migrations. **All business logic lives in TypeScript** (`src/db.ts` is the only module that calls the data API; `worker/src/db/` is the only place SQL is written), so a plain-browser, Windows or iOS build is a packaging change, not a rewrite.

## Prerequisites

- Node.js 18+ and npm
- Rust toolchain (`rustc` / `cargo`) — https://rustup.rs
- macOS: Xcode **Command Line Tools** only (`xcode-select --install`) — no Xcode IDE, Swift, or Apple frameworks used anywhere.

## Setup & run

```bash
npm install            # install JS deps (already done if you're reading this in-repo)
npm run tauri dev      # compile Rust + launch the native app (first run downloads crates, ~1–2 min)
```

Other commands:

```bash
npm run dev            # frontend only, in a browser at http://localhost:1420 (DB calls no-op outside Tauri)
npm run build          # type-check + build the frontend bundle
npm run tauri build    # produce a distributable macOS .app / .dmg
```

### Packaged build (required for voice / microphone)

`tauri dev` runs a bare binary with no merged `Info.plist`, so macOS WKWebView won't expose microphone access there — **voice input only works in a packaged build.** After finishing changes, build and launch the bundled app:

```bash
npm run tauri build
open "src-tauri/target/release/bundle/macos/Sekunda.app"
```

## Where your data lives

> **Moved to a Cloudflare backend** (branch `cloud-migration`). Data used to
> live only on the device that created it and so couldn't follow you between
> devices; it now lives in a Cloudflare D1 database behind a Workers API, with
> user accounts and a local read cache. See
> [`docs/cloud-migration-plan.md`](docs/cloud-migration-plan.md) for the design
> and [`worker/README.md`](worker/README.md) for the backend. **The migration is
> complete through M5 (hardening)** — see the end of this note.
>
> **Every domain now lives in the cloud.** M0 built the infrastructure and the
> multi-tenant schema; M1 added accounts; M2–M4 moved all the data —
> reminders, people, events, tags, links, and notes — to
> **Cloudflare D1**, reached through a typed Worker API, with **note-image
> bytes in Workers KV** (D1 caps a row at 2 MB). Everything syncs across
> devices; reads fall back to a local IndexedDB cache when offline, and writes
> are disabled offline and say so.
>
> The whole backend runs on **free-plan products with no payment method on the
> account**, which is a deliberate safety property rather than a cost-saving
> one: free plans return quota errors instead of billing overages, so a traffic
> spike — including a malicious one — can take the app offline until the daily
> counter resets, but can never produce a bill. That is why note images use KV
> (included free, no card) rather than R2, which requires a card on file even to
> use its own free tier. The cost of that choice is a 1 GB image budget and
> 1,000 uploads/day.
>
> **The local SQLite stack is gone.** `tauri-plugin-sql`, `browserDb.ts`,
> `src-tauri/migrations/`, the demo seeder and the `sql:*` capabilities have all
> been deleted, and `lib.rs` is plugin wiring only — architecture rule 1 held
> more completely than before the migration, and the side effect is that iOS is
> unblocked (`tauri-plugin-sql` never supported it). Backup/restore and
> Settings' "clear all data" are now server-side: a *logical* export that walks
> the tables one page at a time, because `wrangler d1 export` refuses a database
> containing virtual tables and `notes_fts` is one.
>
> **Staging and production are both deployed and verified**, each with its own
> D1 database, KV namespace and secrets, so nothing crosses between them.
> Packaged builds read `VITE_API_URL` from `.env.production` and target
> production; the dev app runs client and Worker together locally
> (`npm run tauri dev`).
>
> **M5 (hardening) is in.** Password reset and email confirmation over
> [Resend](https://resend.com) (free tier, no card); account deletion that
> removes the user, their space, every row in it and the note-image bytes in
> KV, gated on re-entering the password; per-user rate limits on the proxy
> routes so a stolen session can't be used as a relay; a Content-Security-Policy
> on the web build and hardening headers on every API response; and the Tauri
> HTTP scope narrowed off `http://*`. **Reset requires `RESEND_API_KEY` to be
> set on the Worker** — until it is, the reset and confirmation endpoints
> refuse identically for every address (deliberately: a response that varied
> would be the account-existence oracle the whole flow avoids).
>
> **Rate limiting now covers every endpoint, not just the proxy routes.** The
> auth surface, all ~90 space routes and the public health check have per-minute
> caps, registration demands a captcha on every platform, and outbound mail and
> note-image uploads have durable per-day ceilings in D1. See
> [Rate limiting](#rate-limiting).
>
> **The app is no longer standalone.** It now depends on the deployed Worker
> being reachable — no Worker, no login. That is the trade the cloud migration
> makes for cross-device sync.
>
> **Passwords are never sent to the server.** The client derives an argon2id key
> from your password and sends only that; the server stores a keyed hash of it.
> This is the same design Bitwarden and 1Password use. It means offline
> cracking resistance is unchanged while the server never sees a plaintext
> password — and it fits Cloudflare's free plan, whose 10 ms CPU cap per request
> cannot accommodate a correctly tuned password hash.
>
> **A password reset never breaks that property.** The reset link doesn't
> authorise "change this password" — it authorises replacing the account's KDF
> salt, parameters and verifier with values the *client* computed from the new
> password. Reset tokens are random, stored hashed, single-use, expire in 30
> minutes, and using one signs every device out. What a reset does *not* do is
> kill an access token already in flight: those are stateless 15-minute JWTs
> verified without a database read, so there is a bounded window where a stolen
> one still works. That is a known trade, not an oversight.
>
> **Deleting an account is permanent and needs the password again**, not just a
> valid session — an access token can be fifteen minutes old on an unattended
> machine. It removes the user, the space, every domain row and the note-image
> bytes in KV. It is deliberately separate from Settings → Data → "clear all
> data", which empties a space you keep.

In **Cloudflare D1**, scoped to your account's space, reached only through the
Worker — nothing is kept on the device but a read cache. Migrations live in
`worker/migrations/` and are applied with `wrangler d1 migrations apply`.

App **settings** live outside the domain database, so they survive a data wipe
and never travel in a backup file. They are split by what the setting *is*:

- **Per-device, in the webview's `localStorage`** — your model choice, your
  voice and speech settings, your calendar-account configuration, the UI
  language, the theme, and your Today card layout. These are answers about a
  particular machine, and you re-enter them once per machine. The short-lived
  Today caches (weather, stock quotes, RSS headlines, the AI day summary) are
  also `localStorage`, but **scoped per signed-in account and cleared on sign
  out**: they describe one account's data (the RSS list is yours, the briefing
  is built from your day), so on a shared device they must not survive the
  session the way the machine-level settings above do.
- **The two credentials, on their own** — your OpenAI API key and your iCloud
  app-specific password. Also `localStorage`, also per-device, also **never sent
  to the server**, but deliberately kept out of the settings objects entirely
  (`src/lib/secrets.ts`) so that nothing which handles settings — the cloud
  sync, the backup writer, the Settings form — is holding a credential it has to
  remember not to write down. They are still **plain text on the device**, and
  they are **cleared when you sign out**: coming back means entering them again,
  which is the point. Each field links to the page that issues *and revokes*
  that credential, because revocation is the real remedy if a device is lost.
- **Per-account, in the cloud** — everything on **Settings → Widgets**: your
  weather location and temperature unit, your stock watchlist, your **RSS
  subscriptions**, and how many articles the news card shows. These are answers
  about *you*, not about a machine, so they are stored in D1 against your
  account and pulled down when you sign in on a new device.

The line between the two is an explicit allowlist (`CLOUD_SETTING_KEYS` in
`packages/shared`), enforced on both sides: the client only ever uploads a key
on that list, and the Worker rejects a patch containing any key that isn't. It
is now the second line of defence rather than the only one — since the two
credentials aren't part of the settings objects at all, there is nothing there
for a careless upload to pick up. Cloud
settings are last-write-wins per key, are kept in `localStorage` as well so the
app still works offline, and an edit made offline is pushed when you reconnect
rather than being overwritten by the server's older copy.

**Note images are stored separately from the note text.** The markdown body holds only a reference (`![alt](sbimg:<id>)`); the bytes live in Workers KV, with only metadata in D1, and are fetched by the preview that renders them. Inlining them as data URIs would put every image on the `notes` row — which the sidebar re-reads on every keystroke in the search box — and feed them to a *trigram* full-text index. Measured on one 300 KB image, that's a 638 KB search index versus 331 bytes.

**An image's display size lives in the reference too** (`sbimg:<id>?size=s|m|l` — small, medium, large, or no marker for the image's own size). Click an image in the note preview and a small picker appears. It belongs to *that appearance* of the image rather than to the stored file, so the same picture can be a thumbnail in one paragraph and full width in another, and a body copied elsewhere carries its layout with it. The sizes are fractions of the note column, not caps — picking "Large" enlarges a small image rather than leaving it alone.

**Connected Apple calendars are not stored here.** They're fetched from iCloud live whenever the visible date range changes, and edits are written straight back — nothing is copied to disk. That's why connecting a calendar needs no migration and no schema change, and also why Apple events need a connection to show up (see [Limitations](#notes--current-limitations)).

## Features

- **Today** — dashboard of the day's schedule (across every visible calendar), due/overdue tasks & reminders, pinned + recent notes, and upcoming birthdays. Schedule events and notes are clickable — they jump straight to that item. **Arrows beside the date step to any other day** (with a "Today" button to come back); the schedule, due items and birthdays follow it, while "overdue" only ever counts against *now*, so it pulls extra items in on today alone. A **written summary of the day** appears as its own card when the assistant is configured; without an OpenAI key the card still shows, explaining what it's for and how to switch it on — see below. A fresh install starts with **New York** as the weather location and **Apple + Alphabet** on the stock watchlist, so both tiles are there on day one; change or clear them in Settings. The forecast tile joins the grid whenever a location is set, following the day you're looking at; a market ticker joins it whenever the **stock watchlist** is non-empty, and a news card joins it whenever you follow at least one **RSS feed** (both today-only — a quote and a headline describe now, so they say nothing about any other day). **Edit** opens a card manager: reorder the cards with the arrows, or hide the ones you don't want — and a hidden card stops fetching, so switching off the summary or the weather stops the request as well as the tile.
- **Calendar** — month / week / day views, event CRUD, RRULE recurrence, all-day + color-coded events. A bottom bar (on every calendar view) has **ICS import/export** on the left, with the export path and any calendar-unavailable warning on the right (the bottom-right corner belongs to the assistant's floating button). Supports **multiple calendars** — the built-in one plus connected Apple/iCloud calendars — viewable individually or together (see below).
- **Apple Calendar (iCloud)** — connect your iCloud account in Settings and your Apple calendars appear alongside the built-in one, each with its own color and a visibility toggle so you can view them **individually or together**. Create, edit, delete, and skip-an-occurrence all write straight back to iCloud. When creating an event you pick its calendar; a **default calendar** setting decides where events land otherwise (including ones the assistant creates).
- **Mail (iCloud, read-only)** — connect your iCloud inbox in Settings and a **Mail page** joins the sidebar: pick a mailbox, search it, page back through it, and read a message — downloading an attachment if you want one. The page **only appears once an inbox is connected** — with no account it has nothing to show, so it stays out of the sidebar rather than leading somewhere empty. The **assistant reads the same inbox**: ask *"did the plumber ever reply?"* or *"what did the school send on Monday?"* and it searches your actual mail. It is **read-only by construction** — mailboxes are opened with IMAP's read-only command and bodies are fetched without touching the read flag — so nothing here can send, reply, delete, file, or even mark a message as read, and *not by mistake either*. That is why the page has no buttons beside a message: their absence matches what the server would allow anyway. Nothing is stored — no local copy, no database row; what you have already looked at is kept in memory for the life of the app and nothing reaches the disk. Message bodies are rendered as **plain text, never as HTML**, because a message is arbitrary markup written by a stranger and this webview holds your session. See below.
- **Reminders** — Apple-Reminders-style with a filter sidebar (**All / Scheduled / Flagged / Completed**, each with live counts). Due date + optional alert time, recurrence, priority. Native OS notifications fire when due (polled once a minute while the app is open).
- **Notes** — markdown with live preview, pin, FTS5 full-text search. The editor holds local state and debounces saves, so typing stays smooth. A **formatting toolbar** sits above the text while editing (bold, italic, strikethrough, H1–H3, bullet/numbered/checklist, link, inline code, quote) — buttons act on the current selection, line markers apply to every line the selection touches and toggle off when re-applied, and **⌘/Ctrl+B, +I and +K** do bold, italic and link from the keyboard. The toolbar is hidden in preview mode. **Tables** go in from the toolbar's grid button: a dialog opens with a drag-to-size grid (up to 8×8, the Word/Docs gesture), number fields for anything larger or for keyboard use, and left/centre/right column alignment. It inserts a GFM table skeleton with a header row and numbered `Header n` placeholders, padded so the markdown source stays readable when you edit the cells by hand. **Images** go in from the toolbar's picker or by pasting a screenshot straight into the text; they're downscaled to 1600px and re-encoded as JPEG on the way in, and they render in the preview. **Click an image in the preview to resize it** — small, medium, large, or its original size — which is stored in the markdown reference, so each appearance of an image is sized on its own. **YouTube videos** go in too: paste a video's "Copy embed code" `<iframe>` straight into the text, or use the toolbar's ▶ button (which also accepts a plain link), and the preview shows the video with a play button; clicking it opens the video in your browser. What's stored is just the video's URL on its own line — so any bare YouTube link in a note becomes a video, while a link you've labelled (`[watch this](…)`) stays an ordinary link. The video opens in your browser rather than playing inside the note because YouTube's embedded player refuses to load without an HTTP `Referer`, which a packaged Tauri app — served from `tauri://localhost` — cannot give it ([tauri#14422](https://github.com/tauri-apps/tauri/issues/14422)). An in-app window doesn't help: the embedded player returns the same "Error 153" even when it *is* the page, so the only thing that actually plays is YouTube in a real browser. A **mic button in the bottom-right corner of the editor** dictates into the note: click to record, click again to stop, and the speech is transcribed with **OpenAI Whisper** (the same path the assistant uses, so it needs an OpenAI API key). A marker goes in at the cursor the moment recording starts and is replaced by the transcript when it arrives, so the text lands where you started talking even if you keep typing meanwhile.
- **Diary** — a dated journal under **Diary** in the sidebar. Entries are keyed by calendar **day** (one per day), browsed with a **mini month calendar** that dots the days you've written on, prev/next-month arrows, a **Today's entry** button, and a reverse-chronological list. Writing an entry uses the **exact same editor as Notes** — the formatting toolbar, live preview, image insert/resize, YouTube embeds, dictation and debounced auto-save are the same component (`MarkdownDocEditor`), so everything Notes can do a diary entry can too; an entry also carries a title and its own tags/links/people. Under the hood a diary entry **is a note** (`notes.kind='diary'`, with an `entry_date`), so it reuses the FTS index, the note-image pipeline and backup with no separate storage — the day is a **floating wall date**, timezone-independent like an all-day event, so it never drifts. Diary entries **do not appear in the Notes page** and notes do not appear here; both **do** appear in global search (see below). The **assistant can read, write and show the diary** — see the tool table below, and it renders diary entries as clickable cards like any other item — which, like notes and events, means those entries are sent to OpenAI on the turns it reads them.
- **People** — a contacts book modeled on **vCard 4.0**: multiple emails/phones/addresses/websites (each with a type), structured name, nickname, organization, title, birthday (the profile also shows the **age** derived from it), notes, favorite, a **profile photo**, and **user-defined custom fields** (e.g. "Eye color: Blue", reorderable with ▲/▼). Custom-field **labels are global** — a field you add shows up on every person (each person keeps its own value). Because that makes deletion destructive, the ✕ on a field asks first, offering to either clear just this person's value or delete the field (and its data) for everyone. Master-detail with the same debounced auto-save as Notes (no Save button). **Selecting a person opens a read-only profile** — only filled-in fields are shown — and **Edit** switches to the form; a person you've just created opens straight in the form, the same rule the Notes editor uses. Click an email/phone/website to open it (`mailto:`/`tel:`/browser), from either mode. Tags and links stay visible in both. Upcoming birthdays surface on the Today dashboard.
- **Weather** — an optional forecast tile on Today: condition, high/low and chance of rain, an **hour-by-hour strip** for the rest of the day, and a stat row with **feels-like, humidity, wind, UV index, air quality (US AQI) and daylight hours** — for whichever day you're viewing. Feels-like is often the number that matters: in a humid summer it runs several degrees above the air temperature. Air quality comes from Open-Meteo's separate (equally keyless) air-quality service and only applies to today, since it's a live reading. Data comes from [Open-Meteo](https://open-meteo.com), which needs **no account, no API key and no registration** — you pick a location in Settings and that's the whole setup. Nothing is written to the database: forecasts are fetched live and cached in `localStorage` for half an hour, the same rule connected calendar events follow. Celsius or Fahrenheit is a setting; with no location set, the tile doesn't exist.

- **Stocks** — an optional market ticker on Today, in the spirit of the iOS Stocks widget: one row per symbol with the ticker, its name, an **intraday sparkline drawn against the previous close**, the current price in its own currency, and the day's move as a signed percentage (green up, red down). A **Closed** marker appears when that market isn't trading, which for a watchlist spanning several exchanges is most of the time. A new install is seeded with Apple and Alphabet; search for a company or ticker in Settings to add more, reorder with the arrows, and the card follows that order — equities, ETFs and indices all work, on any exchange the provider covers (an index level renders as a plain number, not an amount of money). Like the forecast, nothing is written to the database: quotes are fetched live and cached in `localStorage` for five minutes while a market is open and half an hour once it has closed, since a closed market's number cannot change. With an empty watchlist the card doesn't exist, and the card only renders on today.

  A caveat worth stating plainly: quotes come from **Yahoo Finance's chart endpoint, which needs no account and no API key** — but unlike Open-Meteo it is *undocumented*, with no published terms and no stability guarantee, so it may change or stop working without notice. It also sends no CORS headers, so the web build reaches it through a narrow authenticated proxy on the Worker while the desktop app calls it directly. It was chosen because no keyless, documented equity API currently exists: Stooq (the closest match to how Open-Meteo was picked) is now behind a bot check, and Alpha Vantage, Finnhub, Twelve Data, marketstack and FMP all require registration. All of it is isolated in `lib/stocks.ts`, so replacing the provider is one file; and the card fails soft — an unreachable service shows "Couldn't reach the markets" inside that tile and nothing else on the page notices.
- **News (RSS)** — an optional headline card on Today, fed by **RSS or Atom feeds you subscribe to** in Settings → Widgets. Paste a feed address and it is fetched and checked on the spot: the channel's real title becomes the label in your list and the byline on each headline, and a URL that turns out to be a site's home page rather than its feed is refused there and then instead of quietly showing nothing later. Several feeds merge into **one list, newest first**, deduplicated so a story syndicated to two feeds you follow appears once; you choose how many headlines the card shows. Clicking one **opens the article in your browser**, never inside the app — a news site is arbitrary third-party HTML and has no business rendering inside a webview holding your session. Nothing is written to the database: articles are fetched live and cached in `localStorage` for half an hour, the same rule the forecast and the ticker follow, and a publisher that goes down keeps showing its last-seen headlines rather than blanking the card. Your **subscription list follows your account**, so it is waiting for you on a new device. With no feeds subscribed the card doesn't exist, and it only renders on today.

  Feeds are fetched through a **narrow authenticated relay on the Worker**, on desktop as well as web — the one external service where the desktop app doesn't get a direct path. Feeds overwhelmingly send no CORS headers, which rules out the browser; and while the desktop HTTP plugin has no CORS problem, every host it may reach has to be listed in the Tauri capability scope, which an arbitrary subscription list can never be. Widening that scope to "any https host" would hand any script running in the webview a general-purpose HTTP client outside the browser's origin rules, so relaying is the cheaper risk. The relay is the only route in the app that accepts a URL, and it is fenced accordingly: session required, per-user rate limit, https only, no credentials in the URL, private and loopback addresses refused, redirects followed by hand and re-checked at each hop, a 2 MB cap, and upstream headers dropped. See `worker/src/routes/feed.ts`.
- **Assistant** — an AI chat that answers questions about your data and can create, update, or delete items, by typing **or by voice** (see below). It's reachable two ways: its own page, or a **floating chat window** available from every other page (see below).
- **Settings** — a sidebar splits configuration into **General** (language, appearance), **Account**, **Widgets** (weather location + temperature unit, stock watchlist, RSS feeds + article count — the settings that follow your account), **Assistant** (OpenAI key + model, plus how long the Today briefing is held before it's rewritten), **Voice** (voice engine, spoken-reply voice, speaking rate, speech-to-text model), **Calendars** (connect iCloud, pick visible calendars, set the default), **Mail** (connect your iCloud inbox for the assistant to read), and **Data** (back up, restore, and reset, see below).
- **Backup & restore** — **Settings → Data** exports *everything the app holds for you* — every event, reminder, note, person, tag and link, including the images embedded in your notes — to a single JSON file, and imports one back. Import **replaces all current data** (there's a confirmation), then reloads. The **OpenAI key and the iCloud credentials (calendar and mail) are deliberately excluded** — those device-bound secrets never travel in the backup file; non-secret preferences (UI language, model names, calendar visibility/default) are included. Image bytes are re-uploaded through the ordinary upload endpoint, which is rate-limited, so a restore paces itself against the per-minute cap and — if the account's 200-image daily budget runs out partway — finishes everything else and reports how many pictures came back missing, rather than failing and rolling the whole restore back. Those notes keep their reference and show the missing-image chip; importing the same file again the next day fills them in. See `src/lib/backup.ts`.
- **Reset** — **Settings → Data** also has a **Reset all data** button that permanently deletes every event, reminder, note, person, tag and link (behind a confirmation), then reloads to a clean, empty app. It clears every data table via `clearAllData` (`src/db.ts`); the OpenAI key and iCloud account are left untouched since they live in `localStorage`, not the database.
- **Light & dark** — the whole app has a dark theme, chosen in **Settings → General → Appearance**: *Light*, *Dark*, or *Use system appearance*, which follows the OS and keeps following it while the app is open (macOS flips on a schedule). It applies instantly, with no restart, and is stored per account alongside the language. Two things move together: the `dark` class Tailwind keys off, and the CSS `color-scheme` that decides how the *browser* draws native controls — without the second, the event form's date and time pickers stay light on a dark dialog.
- **Languages** — the whole UI is available in **English** and **Traditional Chinese (繁體中文)**. Dates, times, the first day of the week, and relative labels ("tomorrow") follow the selected language via `Intl`; switching applies instantly with no restart. Set it in **Settings → General** (defaults to following your OS).
- **Integration** — shared tagging and generic `links` (any item ↔ any item) across all four types; a person can be attached to any event, reminder, or note (and shown/edited from either side). **Global search** covers everything — events (built-in *and* connected calendars), reminders, notes, diary entries and people — matching each word of the query separately rather than the whole phrase as one string, so "lunch with Alex meeting" still finds "Lunch with Alex". A recurring event appears once, dated to its next occurrence rather than to whenever the series began, and clicking any result opens it on the right day even if that's months away. When an **inbox is connected**, search also reaches your mail: those results come from the **inbox only, newest first** (IMAP has no relevance ranking), on a slower debounce because each mail query is a round-trip to the server, and clicking one opens it in the Mail reader.

- **Page loading** — Calendar, Reminders, Notes and People wait for their first read before drawing, instead of appearing empty and filling in a moment later (an empty list and "you have nothing here" look identical, which is the worse of the two). Only that first read blocks: reloading after an edit, or typing in a page's search box, leaves what's on screen alone. Two rules keep the wait from becoming a trap — a read that **fails** ends on a short "couldn't load this page" panel with a **Try again** button, and a read that simply never comes back stops blocking after eight seconds, showing the page with a small "still loading" marker until it does. The worst case is the old behaviour, never a spinner that never stops. Today waits the same way, but for its whole grid: its cards each fetch their own data, so instead of one page read it holds until every card's opening fetch has landed, then reveals them together rather than popping in one skeleton at a time. The same eight-second escape hatch applies, and a card that fails to load stops waiting and shows its own error in place.

- **Phone and tablet layout** — the web build is usable on a phone. Below Tailwind's `md` breakpoint (768px) the layout rearranges; at 768px and above it is byte-for-byte the desktop layout it always was, because every change is a mobile-first default with an `md:` rule restoring the original. What changes: the **sidebar becomes a drawer** behind a hamburger, with the global search field moving into a top bar; **Notes and People** stop being two panes and take turns owning the screen, with a back arrow returning to the list; the narrow rails in **Reminders and Settings** lie down into horizontally scrolling chip strips; the **calendar** month grid tightens to fit seven columns in 375px while week view scrolls sideways behind a pinned hour gutter; the **assistant's floating window** spans the width instead of a fixed 380px; and forms that pair fields two-up stack them. One touch-specific adjustment goes beyond layout: form controls take a **16px minimum font size** below `md`, because mobile Safari zooms the page in on any smaller focused input and never zooms back out. Safe-area insets are honoured, so nothing hides under a notch or a home indicator.

- **Install it (PWA)** — the web build is an installable Progressive Web App, so on a phone or tablet it can live on the home screen and open full-screen, without an App Store or Play Store. On **Android** (Chrome) the browser offers "Install app"; on **iOS/iPadOS** (Safari) it's **Share → Add to Home Screen** — Safari has no install prompt of its own. Installed, it launches standalone (no browser chrome), keeps the safe-area handling above, and shows the app shell offline while online data still follows the app's usual "reads fall back to cache, writes fail loudly" rule. A service worker (generated by `vite-plugin-pwa`) precaches only the static shell — never any account data or API responses, which matters because the web build lives on a shared `github.io` origin — and updates land on the next visit rather than interrupting what you're doing. This is web-only: the service worker is not registered inside the desktop app (which packages the same files but ignores them), and no push notifications are involved.

The UI uses a consistent modern icon set (`lucide-react`) throughout — no emoji.

## Languages (i18n)

The UI ships in **English** and **Traditional Chinese (繁體中文)**, built on **`i18next` + `react-i18next`**. Catalogs are plain JSON bundled at build time — there's no backend to fetch translations from, which suits an offline desktop app.

**Choosing a language:** *Settings → General*. The default follows your OS locale; only Traditional variants (`zh-Hant`/`zh-TW`/`zh-HK`) map to Chinese, since showing Traditional characters to a Simplified reader would be worse than English. Switching applies **instantly** — `useTranslation()` subscribes to i18next's `languageChanged`, so the tree re-renders without a restart.

**What follows the language:**

- **Dates and times** go through `Intl.DateTimeFormat`, not hardcoded patterns, so each locale gets its own conventions: `2:30 PM` vs `下午2:30`, `Jul 20, 2026` vs `2026年7月20日`, `1 PM` vs `下午1時`. Hardcoded `"MMM d"`-style patterns produce `7月 20` in Chinese where the correct form is `7月20日`.
- **The first day of the week** comes from the date-fns locale — Sunday for `en-US`, Monday for `zh-TW` — so the calendar grid and its weekday headers reorder.
- **Relative labels** ("today", "tomorrow", "in 5 days") use `Intl.RelativeTimeFormat`.
- **`<html lang>`** is set at runtime. This matters more than it looks: many CJK codepoints are Han-unified, and with a wrong or missing `lang` the renderer picks an arbitrary variant — a Traditional reader can end up seeing Japanese glyph forms.
- **Spoken replies** pick a voice by detecting the script of the reply text, then rank the installed voices for that language by quality (see AI Assistant → Voice).

**Adding a language** is a translation job, not an engineering one: add a catalog under `src/locales/<code>/app.json`, add the code to `LANGUAGES` in `src/lib/i18n.ts`, and map it in `matchSystemLanguage`. Keys are **type-checked** — `src/@types/i18next.d.ts` derives the key union from the English catalog, so `t("typo.here")` is a compile error and English is the enforced source of truth.

**Deliberately left in English:** the assistant's `SYSTEM_PROMPT`, its tool schemas, and the tool-result error strings. Those are model-facing, not user-facing — translating them costs tokens and tool-selection accuracy, and the model paraphrases them into the user's language anyway. The demo dataset (Shift+8+9) is also English-only.

## Apple Calendar (CalDAV)

Connect your iCloud account and your Apple calendars work alongside the built-in **Sekunda** calendar. There is **no server, hosting, or developer configuration** — the app talks to iCloud's CalDAV endpoints directly using your own credentials.

**Setup (Settings → Calendar accounts):**

1. Create an **app-specific password** at [account.apple.com](https://account.apple.com/account/manage) → *Sign-In and Security* → *App-Specific Passwords*. Your normal Apple password will **not** work if you have two-factor authentication on (and you almost certainly do).
2. Enter your Apple ID + that app-specific password, then hit **Connect**. The app discovers your calendars and lists them.
3. Tick the calendars you want visible, and choose a **default calendar** for new events.

**What syncs:** title, start/end, all-day, recurrence (`RRULE`), skipped occurrences (`EXDATE`), location, description, and status. Real timezones are handled properly — a *timed* event authored in another zone (`DTSTART;TZID=…` with an embedded `VTIMEZONE`) resolves to the correct absolute instant and renders at the right wall-clock time locally, and is written back in that same zone rather than flattened to UTC. An **all-day** event is deliberately *not* an instant: it is stored as a floating wall date (a `yyyy-MM-dd` with no zone), so "24 July" stays 24 July no matter where you view it — it can't slide to the 23rd or 25th when the device's timezone changes. It round-trips to CalDAV as a `VALUE=DATE`, with `EXDATE` matching that same value type.

**How it works:**

- **Live fetch, no stored copy.** Events are read with a window-scoped CalDAV `calendar-query` `REPORT` whenever the visible date range changes, and written back with `PUT`/`DELETE`. Nothing is persisted, so there's no migration, no schema change, and no stale-copy problem — but also no offline access to Apple events. This is why the cloud migration left `calendars.ts` untouched.
- **Conflict-safe writes.** Every write carries the event's `ETag` as `If-Match`. If the event changed on another device in the meantime the server returns `412` and the app tells you to reload rather than silently overwriting.
- **Fails soft.** If iCloud is unreachable or the credentials are wrong, the built-in calendar and every other feature keep working; the Calendar view shows a *"Some calendars unavailable"* chip instead of erroring.
- **Provider-agnostic seams.** The client is generic CalDAV behind a small provider abstraction (`src/lib/caldav/`), with iCloud the only implementation shipped. Google/Fastmail/Nextcloud/generic-URL accounts are a provider entry plus a capability scope.

`src/lib/calendars.ts` is the aggregation layer the UI and the assistant both call: it lists calendars, merges occurrences for a window, and routes each write to either `db.ts` (local) or the CalDAV client (remote).

## Apple Mail (IMAP)

Connect your iCloud inbox and you get a **Mail page** plus an assistant that can read your email. **iCloud only, nothing stored.** There is no sending and no copy of a message anywhere in this app. From the reader you can do a few things that change a mailbox — **mark a message read** (automatically, when you open it), **move it to Trash** (a Delete button), and **move it to Junk** — but nothing else, and **the assistant is read-only entirely**: it never marks, deletes, or moves anything.

**Setup (Settings → Mail):** the same app-specific password you may already have created for calendars — one Apple app-specific password covers both, and the pane offers to reuse it rather than making you generate a second. Enter your Apple ID, hit **Connect**, and it lists your mailboxes.

**The Mail page** (sidebar, only present once an inbox is connected): a mailbox picker, a debounced search box, an unread-only filter, and a message pane. Searching is a network round-trip per query rather than a filter over something already loaded, so the box waits for you to stop typing; opened messages are remembered for as long as the page is, so flicking between two costs nothing. Messages arrive fifty at a time behind a **Load older** button — an explicit button rather than infinite scroll, because each page is a round-trip to Apple and a scroll position should not be able to spend one by accident. **New mail appears when you come back to the window**, at the cost of one small command that carries no message data: if nothing has changed the list you are looking at is provably current, and if something has, only the new messages are fetched. There is no timer — polling would mean signing in to Apple every few seconds forever, including while nobody is looking. Opening a message **marks it read** (the unread dot clears immediately and the change is written back to iCloud), and the message has a small **toolbar**: **Delete** moves it to Trash — reversible from your Trash folder, matching Apple Mail; deleting one that is *already* in Trash removes it for good, after a confirmation that says so — and **Move to Junk** files it in your Junk folder (hidden when you are already looking at Junk). Inside Junk or Trash, a **Move to Inbox** button appears to put a message back. The toolbar is where **Summarize** and **Reply** will go later. Bodies render as plain text and links are deliberately *not* clickable — a link in an email is the phishing surface, and this webview holds your session. Attachments show their name, type and **real size**, and **clicking one downloads it** — to a file you choose on the desktop, to your downloads folder in the browser. Nothing is fetched until you click, and a file too large to hand over in one piece (over 10 MB) says so rather than saving you something truncated.

**What the assistant can do:** `search_mail` (by free text, sender, subject, date range, or unread), `get_message` (one message in full, plus what was attached), and `list_mailboxes` — and nothing that writes. It has no mark-as-read, delete, or move tool, and `get_message` opens a message with `BODY.PEEK`, so **asking the assistant to read your mail never marks it read, removes it, or files it**; those are things *you* do from the message toolbar. Attachments are listed for the assistant but **never downloaded by it** — it has no use for bytes it cannot read, and a tool that pulls 10 MB into a chat turn is a mistake waiting to be made. Downloading is something you do, on the page. Each field's words are matched **separately and ANDed**, never as one phrase — IMAP matches a search key as a substring, so "Manda Contact emails" as a single key finds nothing in a mailbox full of mail from Manda Contact. It is the same rule the rest of the app's search follows.

**How it works:**

- **Reads are read-only at the protocol level; writes are a small named set.** Every *read* opens the mailbox with `EXAMINE` rather than `SELECT` and fetches with `BODY.PEEK`, so the *server itself* refuses anything a read path could ask for — a property of the connection, not a promise about our code, and it holds even against a bug or a prompt injection reaching the assistant (which builds no write op at all). The *writes* — mark-as-read (`UID STORE \Seen`), delete (`UID MOVE` to Trash, or an expunge from Trash) and move (`UID MOVE` to a named folder, which drives Move to Junk) — are separate, explicit operations that open the mailbox read-write and each issue exactly one constrained mutation; they take no arbitrary flag or command from the caller. Downloading an attachment is still a read: `BODY.PEEK` on one section of a message.
- **Live fetch, no stored copy.** Same rule connected calendar events follow: nothing is written to the database or cached on disk, so there is no stale copy and nothing to leak from. Each query is its own connection — log in, one command, log out.
- **Remembered in memory, never on disk.** Within one run of the app, a list you have already seen and a message you have already opened are not fetched again — including for the assistant, which used to re-download a message you were looking at. That cache dies when the app closes and touches no storage, so "nothing is stored" stays literally true; it is also cleared the moment you sign out or disconnect the inbox. **An on-disk cache is deliberately not built:** it would turn a promise about there being nothing to retain into a promise about a retention policy, which is a bigger decision than a performance fix deserves. The **Refresh** button always goes all the way to the server.
- **A uid is only meaningful while `UIDVALIDITY` holds.** IMAP servers may renumber a mailbox, after which message 991 is simply a *different* message. Every cached thing is keyed by that number and the whole mailbox is dropped when it changes — without which the cache would confidently show you the wrong email under the subject you clicked.
- **The desktop app talks to Apple directly.** IMAP is a stateful TCP socket, which neither a browser nor `tauri-plugin-http` can open, so the desktop path goes through a small custom Rust command (`src-tauri/src/mail.rs`) — the one exception to "the Rust layer is plugin wiring only", and the reason for it. It enforces its own iCloud-only host allowlist, since custom commands are not bound by the capability scope.
- **The web build relays through the Worker**, which speaks IMAP over `cloudflare:sockets` (`worker/src/routes/mail.ts`). This means your app-specific password and the messages you read pass through our server in plaintext — TLS terminates there. It is the same trade already accepted for connected calendars, with email being the more sensitive of the two, and it is **said in the Settings pane itself** rather than only in the source. Nothing is stored, nothing is logged, a session is required, only iCloud's IMAP endpoint is reachable, and the route is rate-limited per user. Use the desktop app to avoid the relay entirely.
- **Only the text is downloaded.** Before fetching anything, the server is asked what the message is made of (`BODYSTRUCTURE`, which is its own parse of the MIME tree and costs no body bytes). Small messages are then taken whole, as before; anything larger has just its text part fetched, and attachments are described — name, type, **true size** — without a byte of them crossing the wire. That is a saving, but mostly it is a correctness fix: MIME parts arrive in whatever order the sender chose, so a fixed cap on the whole message meant a 10 MB image ahead of the text made the message open **blank**.
- **Decoded once.** Both paths return raw message bytes and all the awkward parts — RFC 2047 encoded subject lines, MIME multipart, transfer encodings, charsets — are handled in one place, `src/lib/mail/mime.ts`. Two parsers would be two sets of bugs and a desktop build that disagrees with the web build about what an email says.
- **IMAP search is a filter, not a search engine.** The server has no ranking, so results are the most *recent* matches rather than the best ones, and what it indexes for free-text search is up to it (headers reliably, bodies unevenly). The assistant's tool description says so, so it doesn't present a filter as a judgement.
- **Sorted by date, not by arrival.** A message's position in a mailbox is the order it was *put there*, which matches send order only for mail that was delivered and never touched — so an Archive folder full of filed or imported mail was in no order anyone would recognise. The date shown is the sender's own `Date` header, as every mail client does, except when it is implausible (more than a day in the future, or before 1990), where what the server saw wins instead. That is not a spam filter; it is a refusal to let a sender pin a message to the top of your list.
- **Mail deleted elsewhere stays hidden.** A message flagged for deletion in another client is waiting to be expunged, and offering to open it means offering mail you believe is gone. Folder names are decoded too — IMAP predates Unicode mailbox names, so a folder called 日本語 travels as `&ZeVnLIqe-`, which is what the picker used to show.

**What goes to OpenAI.** The assistant is an OpenAI model, so anything it reads on your behalf is sent there — stated in the Settings pane as well as here, because it is the part nobody would guess. A search sends subjects, senders and dates and **no message text at all**; opening a message sends that message's text, for that one question. Tool results aren't re-sent on later turns, though whatever the assistant *quotes back* stays in the conversation. If you never ask the assistant about mail, none of it leaves your device except to Apple (and, on the web, through the relay above).

**Deliberately not built.** Stated so they aren't rediscovered as bugs:

- **No threading.** IMAP offers no reliable threading, and reconstructing it from `References`/`In-Reply-To` is real work for a result that often looks wrong. A conversation is N rows.
- **No unread counts or badges.** Cheap to get, but it is a per-mailbox call on every list.
- **No unified search.** One mailbox at a time — the one you have selected.
- **Nothing offline.** Mail is live-only, unlike every other part of the app, because the cache is in memory by choice (above). An offline app has no mail at all.
- **Writes are only from the reader** — mark-as-read, move-to-Trash, and move-to-Junk. There is still no send and no reply, and the *assistant* writes nothing at all: its read-only guarantee is the server's, enforced by `EXAMINE` and `BODY.PEEK`, and holds even against a prompt injection. The writes were added deliberately for the human at the keyboard — reading state that silently diverged from Apple Mail, and no way to clear or file mail, were what people actually missed. The underlying `move` op is generic (any folder), so a future Move to Archive is a button, not a new operation.

Adding another provider (Fastmail, Yahoo) is a preset plus an allowlist entry on both paths; none is shipped.

## AI Assistant

An optional assistant that answers questions about your events, reminders, notes, and people — and can also **create, update, link, and delete** them for you. Its text model runs on **OpenAI, with your own API key** — configuration stays on-device.

**Setup:** open **Settings → Assistant** (sidebar, bottom), paste your `sk-…` key, pick a model, and Save.

**Model** is a dropdown (`OPENAI_MODELS` in `settings.ts`), listed cheapest first and defaulting to `gpt-5-nano`. That default only applies to accounts that have never saved the setting — settings live in `localStorage`, so an existing install keeps whatever it had. The list is every model that can run *this* assistant rather than everything OpenAI sells, and the gate is **function calling**: `ai.ts` is a tool-calling loop, so a model without tools would answer by inventing rather than looking. That gate is also why the whole list is gpt-5-lineage — on Chat Completions the models that search the web *natively* are precisely the ones that can't do function calling, so web search reaches every model here through the delegated `web_search` tool instead (see above), never by the model doing it itself. Prices aren't shown — they move, and a stale number in the UI is worse than none — and there's one entry per price point, since two models at the same price is just dropdown noise. A model set before the dropdown existed (or synced from another device) stays selected as an extra option rather than snapping to the first entry. Every listed model accepts only the default `temperature`, so `callChat` omits the field for all of them (`supportsTemperature` matches `gpt-5*`); the 0.6 default there now only applies to a `gpt-4` id typed in by hand, and the card-recovery round can't cool to 0 on the shipped models, though it still narrows the toolset. Tone is therefore governed by the prompt's "How to answer" block on every model, which is where a stiff-reply regression gets fixed.

Then open **Assistant** and try:
- *"What's due next week?"* / *"Which notes mention the Q3 report?"* (read)
- *"Add a reminder to call the dentist tomorrow at 2pm"* / *"Mark 'Buy groceries' as done"* / *"Create a weekly team-lunch event on Fridays at noon"* (write)
- *"Add a contact for Alex Rivera at Acme, email alex@acme.com"* / *"Set Alex's eye color to blue"* / *"Add Alex to Friday's lunch"* (people + linking)
- *"Add lunch tomorrow at noon"* (lands in your **default** calendar) / *"Put it in my Work calendar instead"* (calendars)
- *"Delete the dentist reminder"* / *"Remove the team-lunch event"* (delete — it'll confirm the exact item first)

**How it works — tool calling, not context stuffing:** rather than sending your entire dataset with every request (which doesn't scale), the model is given a set of **tools** and pulls/changes only what it needs via an agentic loop (`src/lib/ai.ts`):

| Read tool | Purpose |
|------|---------|
| `get_overview` | counts, tag names, current time (cheap orientation) |
| `search_events` | events in a date range **across every visible calendar** (recurring events expanded to occurrences) + query/calendar/tag |
| `list_calendars` | the available calendars (built-in + connected), which are visible/read-only, and which is the default |
| `search_reminders` | filter by query, status, flagged, date range, tag |
| `search_notes` | FTS5 keyword search (or recent), pinned filter — **notes only, never diary** |
| `search_diary` | FTS5 keyword search (or recent) over **diary entries**, each with its day |
| `get_diary_entry` | the diary entry for one day (title + full body), by `YYYY-MM-DD` |
| `search_people` | contacts by name/nickname/org/email/phone, tag filter; a known birthday also returns a computed `age` and `next_birthday` |
| `get_item` | full detail of one item (incl. `person`, with the same computed `age`, and events in a connected calendar) + its tags and linked items |
| `get_weather` | one day's forecast for the weather location set in Settings — condition, high/low, feels-like, rain chance, wind, UV, sunrise/sunset, plus today-only "right now" temperature, humidity and air quality (optional hour-by-hour strip) |
| `list_mailboxes` | the mailboxes in the connected iCloud inbox. **Only present when an inbox is connected** |
| `search_mail` | message summaries from the connected inbox by text, sender, subject, date range or unread — most recent first (IMAP has no ranking). **Only present when an inbox is connected** |
| `get_message` | one message in full: body text and the list of attachments. Reading a message this way also shows you a **card for it** beneath the reply (click to open it in the Mail reader). **Only present when an inbox is connected** |
| `web_search` | a short written answer from current web sources, with citations. **Off by default** and only present when Settings → Assistant → Web search is on — see below |

| Write tool | Purpose |
|------|---------|
| `create_event` / `update_event` | create or edit a calendar event **in any calendar** (incl. recurrence, all-day, location); new events use the default calendar unless a `calendar` name is given |
| `create_reminder` / `update_reminder` | create or edit a reminder (incl. alert time, recurrence, complete) |
| `create_note` / `update_note` | create or edit a markdown note |
| `write_diary_entry` | create or update the diary entry for a day (find-or-create by `YYYY-MM-DD`; replaces the fields passed) |
| `create_person` / `update_person` | create or edit a contact (incl. emails/phones/addresses, birthday, and user-defined `custom_fields`; custom labels register globally) |
| `add_tag` | tag any item (incl. a person) |
| `link_items` / `unlink_items` | connect/disconnect any two items (e.g. attach a person to an event) |
| `delete_event` / `delete_reminder` / `delete_note` / `delete_diary_entry` / `delete_person` | permanently delete an item (`delete_diary_entry` takes a `YYYY-MM-DD` day) |

| Presentation tool | Purpose |
|------|---------|
| `show_items` | display the items the reply is about as cards under the message (max 8; changes no data) |

**It looks things up itself.** Ask about your own data and the assistant searches for it before answering — it won't claim it doesn't know, and it won't ask permission to check first. A question that sounds like general knowledge ("when should I take my vitamins?") is treated as a question about *your* reminders and notes, so it searches and only says something's missing once a search actually comes back empty.

**Built to find things:** searches match **individual terms, not the whole phrase**. This matters because you rarely name an item the way it's stored — asking to delete "my lunch with Alex meeting" has to find the event titled "Lunch with Alex", and a whole-phrase match finds nothing there. Terms are ANDed first; if nothing matches every word, the search falls back to the closest partial matches and flags them, so the assistant asks which one you meant rather than acting on a loose guess. The calendar's default window also starts at **midnight today**, not the current moment, so something earlier today is still findable this afternoon (looking further back needs an explicit start date).

**It can look things up online — but only if you let it, and only when it has to.** Settings → Assistant → **Web search** is **off by default**. Off, the tool schema isn't sent at all, so the feature costs nothing (not even the tokens its own description would occupy on every turn) for anyone who doesn't want it. On, it still costs nothing until the model decides a question actually needs the web — the assistant answers from your data and its own knowledge as before, and reaches for a search only for current real-world facts it can't know and your data can't hold: today's news, a live price, whether somewhere is open now. It's told not to search for your own items, not for the weather (`get_weather` covers that), not for stable general knowledge, and not to double-check itself.

Two things enforce that beyond the prompt, because prompt wording alone has never been reliable here. Searches are capped at **two per turn** by a counter in `ToolContext`, not by an instruction — past the cap the tool returns an error the model can answer around. And what re-enters the conversation is a **three-sentence digest with citations**, not retrieved pages, which is what keeps one search from inflating every later round of the same turn.

Under the hood this is **two calls, not one**, and that's forced: OpenAI's Chat Completions search models *always* search and **can't do function calling**, so one can never be the assistant's own model. The model you picked decides a search is needed; `gpt-5-search-api` performs it at `search_context_size: "low"`; its prose comes back as an ordinary tool result. Billing to know about: web search is charged **per call** (~$0.01) on top of tokens, which is why the cap is on calls rather than rounds. Failures degrade softly — a dead search returns `{ error }` like any other tool, so the assistant says it couldn't look it up instead of losing the turn.

**It knows what day it is.** Every request states today's date up front and repeats it next to your question, with the model told plainly that its training data is older than today and that the given date governs all arithmetic — ages, "how long ago", "how many days until". Dates the model would otherwise *calculate* are calculated by the app instead wherever possible: a contact's `age` and `next_birthday` come back already worked out from their birthday, since asked to subtract 1986 from the current year a model will happily answer with the year its training ended.

**Built to scale:** every read tool is filtered and paginated — bounded `limit` (default 25, max 100) — and returns a `total` count and `truncated` flag so the model knows when there's more and narrows its filters instead of assuming it saw everything. Nothing loads a whole table blindly: searches push filters into SQL, notes use the FTS index, and `search_events` only fully expands *recurring* local events while pre-filtering non-recurring ones by the requested window (connected calendars are filtered server-side by the CalDAV time-range query). Live tool activity ("Checking the calendar…", "Creating a reminder…") is shown while the assistant works.

**How replies read — prose plus cards:** the assistant answers in **one or two sentences of natural prose**, not a formatted data dump. It's told explicitly not to use tables, lists, or bold field labels: replies are often read aloud by the voice feature, where a numbered list with **Time:** sub-bullets is unlistenable. Numbers stay readable, though — phone numbers, times and prices appear as digits (`+1 555-010-2020`, `3pm`), never spelled out, even where the prose around them reads like speech. The detail lives in the UI instead — the model calls `show_items` with the items it's actually discussing, and those render as **clickable cards beneath the message**. Click one to jump straight to that item in its own view; the conversation is preserved when you navigate back.

Two things follow from this design. The cards are the model's *explicit* choice, so items it merely searched through don't clutter the reply — and each card **loads the item's own row to render itself**, so the times and titles shown are the real stored values rather than whatever the model wrote (and stay correct if the item has changed since). Recurring items show the **right occurrence**, not the series' origin: a card for a weekday standup or a daily 8am reminder shows today's instance, resolved by the app rather than left to the model to specify — and a repeating reminder isn't flagged overdue, since it recurs by design. This is prompt-governed, so tone is tuned in `SYSTEM_PROMPT` (`src/lib/ai.ts`), not in the UI.

**Email is the one exception, and it works the other way round.** A message the assistant reads in full (`get_message`) also gets a card beneath the reply — but mail is not one of your items: it has no local row, no tags and no links, so it never goes through `show_items` and there is nothing to reload. The card carries the message summary the read already fetched, and clicking it opens that message in the Mail reader (the same path a global-search mail hit uses). It appears automatically whenever the assistant opens a message, with no cooperation from the model — a bare `search_mail`, which reads no message, shows no card.

Because writing a reply and calling a tool compete for the same step, the model skips `show_items` a fair fraction of the time no matter how the prompt is worded. So there's a **recovery round**: if a turn ends having looked items up but never shown them, the assistant re-asks once with only the `show_items` schema, requesting the item references alone. The reply you already have is never regenerated, and if the recovery call fails it's ignored — cards are an enhancement and never cost you an answer.

**Follow-ups understand "it".** The items shown as cards are remembered as context for the next message, so you can say *"delete it"*, *"move the lunch one to 1pm"*, or *"who's coming to that?"* without re-naming the item — the assistant resolves the reference to the exact card it just showed you, rather than guessing or searching again. (The confirm-before-deleting rule still applies.)

**Calendars and the assistant:** `search_events` covers the built-in calendar and every visible Apple calendar in one call, and the assistant can view, edit, and delete events in all of them. New events go to your **default calendar** unless you name another one ("put it in my Work calendar"). Two things it's told to be honest about: events in connected calendars have **no tags, links, or attached people** (those are local-only), and if a calendar can't be reached the tool reports `unavailable_calendars` so the assistant says which ones it couldn't see rather than implying it saw your whole schedule.

**The day summary on Today** is the same model but deliberately *not* the agentic loop. The Today page has already loaded exactly the day's events, due items and birthdays, so making the assistant search for facts already in hand would cost several round trips to learn nothing new. Instead the app builds a compact digest of that day and makes **one tool-free call** that only turns it into prose — with every fact the model is bad at (what's overdue, the age someone turns, whether the day is past or future) resolved in TypeScript beforehand, and the day's tense stated outright so a briefing about next Tuesday doesn't read as if it were happening now. If a weather location is set, that day's forecast goes into the same call — the briefing mentions it only when it would change what you do (rain, a storm, an unusually hot or cold day, air quality above US AQI 100, plans that look outdoor), and prefers the feels-like temperature to the air temperature when they diverge rather than reciting a forecast that already has its own tile. Summaries are written in your UI language and **cached per day**, against both a signature of that day's contents and the time they were written: stepping between days or leaving and returning costs nothing, while adding an event regenerates it — but only once the standing briefing is more than **6 hours old**. That hold is the one automatic billed request in the app, so without it a morning of ticking reminders off buys a rewrite per tick; **Settings → Assistant** changes the number of hours or switches the hold off entirely for anyone who'd rather the card always be current. A failure is silent — the tiles below already show the same data — and there's a refresh button to rewrite one on demand. Empty days never call the model at all. When the assistant isn't configured the card still appears, but instead of a briefing it explains what "Your day" is for, points to Settings to add an OpenAI key, and notes it can be hidden with Edit — so a new account discovers the feature rather than never seeing it.

**Ask from anywhere — the floating chat window.** Every page except the Assistant itself has a small button in the bottom-right corner that opens a chat window in the corner of that page, in the manner of a support widget: ask a question, get an answer, keep working — no navigation, and the page you were on stays exactly as you left it. It is the *same assistant*, not a cut-down one: the same tool-calling loop, the same item cards, the same mic and hold-Space-to-talk, the same spoken replies.

It is also the **same conversation** *and the same running turn*. Both live in one place regardless of which surface you typed into, so **Open in Assistant** is just navigation — there's nothing to hand over, the history is already there, and going the other way works too (start on the Assistant page, walk away to your calendar, and the popup picks up mid-thread). Switch surfaces a second after hitting send and the question, the thinking indicator and its Stop button all move with you; the answer arrives wherever you've ended up. Clicking an item card navigates to that item and **leaves the window open**, since staying on your page with the chat up is the entire point. Escape cancels a running turn if there is one, and closes the window if there isn't. The button doesn't appear until the assistant is configured — a button on every page that only says "go to Settings" is noise — and closing the window discards a half-finished recording rather than leaving the mic open behind a collapsed window.

Note the one deliberate cost: while the window is open, **hold-Space-to-talk is live app-wide**. Space still types and still activates a focused button or link, but on a page where it would otherwise scroll, holding it now records. That's the price of full voice parity in the popup, and it's scoped to the window being open.

**Voice mode:** the Assistant has a mic button. Click it to start recording and click again to stop, **or hold the Space bar to talk and release to send** (as long as the text box isn't focused) — your speech is transcribed with **OpenAI Whisper** (`whisper-1` by default) and sent as a normal turn. **Talk to the assistant and it replies aloud**; **type and it replies in text** — that's the whole rule, no toggle. Voice is just an I/O layer around the same tool-calling loop, so it can answer *and* create/update/delete items by voice. Choose the transcription model in **Settings → Voice**.

**Running token count.** The Assistant header (and the floating popup's) shows the **total OpenAI tokens** the current conversation has spent, once any have been used. It tallies every chat round of every turn — typed *and* spoken, including the extra tool rounds and the card-recovery round — so voice turns count exactly like typed ones; transcription adds to it only when the speech-to-text model reports usage (`whisper-1`, the default, doesn't, so it stays silent there). The count is per-conversation: **Clear** resets it to zero, and it's driven straight off each response's `usage.total_tokens` rather than an estimate.

**Two voice engines:** spoken replies come from either **OpenAI's neural voices** (default) or the **OS's own voices**, chosen in Settings → Voice. Natural voices reuse the API key that's already there for the assistant and transcription, so they add no new account, and Chinese replies are steered toward **Taiwanese Mandarin** via the model's `instructions` field — the voices are multilingual but drift to mainland Putonghua without it. They're billed per character (order of a cent a minute) and need the network. **The system voice is always the fallback**, and any failure — offline, no key, rate limit — drops to it silently rather than losing the reply; Settings reports afterwards that it happened, since otherwise the only symptom is a suddenly robotic voice. Choosing "System (offline)" keeps spoken replies local, offline and free.

**One voice setting, except where the platform forbids it.** OpenAI's voices are multilingual, so "Natural" exposes a *single* voice picker that reads both English and Chinese, and the offline fallback quietly auto-selects the best installed voice. System voices are the opposite — each one speaks exactly one language, and an English voice handed Chinese text is **silent, with no error** — so "System" is the one mode that still shows a picker per language. That asymmetry is forced by the Web Speech API, not a leftover.

**Spoken replies appear as they're read, not before.** Natural voices need a network round-trip to synthesise, so printing the reply the moment it arrived left it sitting on screen through a second or two of silence, as if the app were reading it back to you. The Assistant now holds the text until `onStart` fires. That makes speech a dependency of *seeing your answer*, so `voice.ts` guarantees `onStart` always fires and always precedes `onEnd` — including when there's no matching voice, no network, or an outright failure — and `AssistantView` keeps a 10s timeout plus a reveal-on-stop hook on top. Verified against every path: voice installed, no matching voice, OpenAI failure falling back, and empty reply text. A timing nicety must never be able to swallow a reply.

**Speaking rate** is a single slider in Settings → Voice (0.5×–2×, default 1×) that applies to whichever engine is active — `utterance.rate` for system voices, the `speed` parameter for OpenAI. The pace is *also* described in words in the `instructions` sent with each reply, but that's reinforcement, not the mechanism: measured on identical text, `speed` 1.6 alone cut 6.55s to 4.44s while the wording alone at `speed` 1.0 managed only 6.86s. Widely-repeated reports that `gpt-4o-mini-tts` ignores `speed` no longer hold. (`tts-1` is the reverse — it honours `speed` and rejects `instructions` outright, which is why `instructions` is only sent to `gpt-4o*` models.) Both Preview buttons take the slider's *live* value rather than the saved one, so a rate can be heard before it's committed.

> **Rejected: Microsoft Edge "Read Aloud".** It's free, needs no account, and has real `zh-TW` neural voices, so it was implemented first — but its synthesis endpoint returns an empty-bodied **403 to every request**, verified across both hosts (`speech.platform.bing.com`, `api.msedgeservices.com`), with and without the `Sec-MS-GEC` token, across five `Sec-MS-GEC-Version` strings, and with the Edge extension `Origin`. The voices-*list* endpoint still returns 200 with the same trusted token and the local clock is within a second of the server's, so the token and the time bucket are fine — this is deliberate hardening of the free synthesis path, matching [the long 403 history in `rany2/edge-tts`](https://github.com/rany2/edge-tts/issues/458). Don't reach for it again without re-testing.

**Choosing a system voice:** macOS ships a *compact* voice for every language and downloads the good ones on demand, so picking the first voice that matches the language gives you the robotic one even when a far better one is installed. Instead the app **ranks the installed voices** — exact language tag first (a `zh-TW` voice beats a higher-tier `zh-CN` one), then quality tier (Premium → Enhanced → Standard → Compact), with macOS's novelty voices ("Zarvox", "Bad News") excluded since they match `en` like any other. The tier is read from the parenthesised suffix on the voice name, the only signal the Web Speech API exposes. **Settings → Voice** lists the ranked voices per language with a **Preview** button, and defaults to "Best available" — a deliberate option rather than a hidden fallback, so it upgrades itself when you install a better voice. To get one: **System Settings › Accessibility › Spoken Content › System Voice › Manage Voices** (free download; Enhanced/Premium sound dramatically better than the default). Siri voices are *not* exposed to the Web Speech API, so they can't be used here.

- Voice **input** sends audio to OpenAI (billed per minute). Spoken **replies** are billed per character when using natural voices, or free and offline on system voices. Transcription is OpenAI-only, so **voice input needs an OpenAI key** — the mic says so rather than failing silently.
- **Voice input requires a packaged build** (`npm run tauri build`), not `tauri dev`. macOS WKWebView only exposes `navigator.mediaDevices` when the running app is recognized as mic-capable, which needs the `NSMicrophoneUsageDescription` from the merged `src-tauri/Info.plist` — present only in a bundled `.app`. In the packaged app, the first voice attempt triggers the system mic prompt. In `tauri dev` the mic button shows a "not available in this environment" error.
- Recording/transcription/TTS all use standard web APIs (`getUserMedia`/`MediaRecorder`/`speechSynthesis`/`Audio`), so this stays portable to the browser/Windows builds.

**Write behavior & safety:**
- The assistant can **create, update, and delete**. Deletion is **permanent and irreversible**, so the system prompt tells the model to look up the exact item first and **confirm which item(s) it will delete** unless you've already named a specific one — and never to delete more than you asked for.
- The system prompt also instructs the model to look up an item's id before updating it, to **ask a clarifying question when a request is ambiguous** rather than guess, and to briefly **confirm what it created, updated, or deleted** afterwards (in one sentence, with the item shown as a card).
- Changes appear in the other views the next time you open them (each view reloads its data on navigation).
- Configuration is stored locally. Requests go via the Rust HTTP plugin, scoped to `api.openai.com`, `*.icloud.com` and the deployed Worker — so an OpenAI key is sent directly to OpenAI and never leaves the device. Loopback (`localhost`/`127.0.0.1`, the local dev Worker) is **not** in that scope; it is added at runtime under `debug_assertions` only, so no packaged build can reach the user's own machine.

Adding further capabilities later is just more entries in the `TOOLS` array and the `executeTool` switch — the agentic loop already handles multi-tool rounds.

## What a new account starts with

Registering creates the space and three pieces of welcome content, all in **one atomic D1 batch** — a half-populated account is not a state that can exist. The seed is a "Tell everyone about Sekunda" reminder, a pinned "How Sekunda works" note that introduces the sections and the assistant, and an all-day "Organize my life" calendar event. Everything is dated to the day the account was created, so the new user's first Today page has something on it rather than being empty. All three are ordinary rows — delete them like anything else.

"The day the account was created" means the user's **local** day, not a UTC one. The Worker has no timezone, so `register` carries an optional `tz_offset` (the client's `Date.getTimezoneOffset()`); without it — a non-browser API caller — the seed falls back to UTC. This is the same westward date-shift the rest of the app guards against: UTC midnight is the *previous* day for everyone west of Greenwich, which would have put the welcome items on a day the user never saw. Timed items are seeded at local noon so they read as today without arriving already overdue, and the all-day event stores the local day as a floating wall date (`yyyy-MM-ddT00:00:00`, no zone), exactly as `EventForm` does. See `worker/src/db/onboarding.ts`; the statements are appended to `createUserWithSpace`'s batch rather than issued separately.

Known limitation: the seed text is **English only**. It is written server-side at registration, and registration doesn't carry a UI language — so a user who registers with the app in Chinese still gets English welcome items. Translating it means sending the language with `register` and keeping the copy in the Worker.

## Demo data (easter egg)

Hold **Shift + 8 + 9** together anywhere in the app to open a "Load demo data?" prompt. Confirming **permanently deletes all current data** and seeds a realistic, cross-linked sample dataset (events, recurring events, reminders, notes, people with birthdays/custom fields, tags, and links — including people attached to events) — handy for exploring the app. Your API key is **not** affected (it lives in `localStorage`). See `src/lib/demo.ts`.

## Standards / sync

Calendar sync is built (**CalDAV, iCloud** — see above). The schema was designed for it, and remains CardDAV-ready for contacts:

- UUID primary keys double as iCalendar `UID`s (events) and vCard `UID`s (people).
- Events store RFC 5545 fields directly (`summary`, `dtstart`, `rrule`, `exdates`, `status`, `categories`, …).
- **People are modeled on vCard 4.0 (RFC 6350)** — `full_name`→`FN`, structured name→`N`, `emails`/`phones`/`addresses`/`urls`→`EMAIL`/`TEL`/`ADR`/`URL`, `birthday`→`BDAY`, `organization`/`title`→`ORG`/`TITLE`, tags→`CATEGORIES`, and user-defined `custom_fields`→`X-` extension properties. Multi-value fields are stored as JSON on the row (like `exdates`/`categories`), so a future `.vcf` import/export is a straight field mapping. **Profile photos are `PHOTO`** — stored inline as a data URI rather than as a file on disk, so a person is still one self-contained row; uploads are center-cropped and re-encoded to a 256px JPEG (~30 KB) because `listPeople` reads the column on every render.
- Every syncable row has `created_at`, `updated_at`, and a `sequence` that increments on edit (mirrors iCalendar `SEQUENCE` / vCard `REV`).
- **Export to `.ics`** (Calendar → bottom bar → Export) proves the schema is standards-compliant — drag the file straight into Apple Calendar. Import reads events back, preserving UIDs. (vCard `.vcf` import/export is future work; the schema already maps to it.)

## Rate limiting

The whole backend runs on free tiers with **no payment method on file**, which
decides the shape of this: free-plan products fail closed with errors rather
than billing an overage, so the worst case of abuse is availability, never a
bill. The exception is anything that spends a quota measured **per day** —
Resend's ~100 messages, KV's 1,000 writes — because those don't come back until
tomorrow, and a stranger who exhausts one has denied the service to real users
for the rest of the day.

Three mechanisms, each doing something the others structurally cannot:

| | Where | Counts | Window | Cost |
|---|---|---|---|---|
| **Failed-attempt throttle** | D1 (`auth_throttle`) | failures, then locks | 15 min | ~105 ms, once per sign-in |
| **Cloudflare binding** | in-colo | successes | **10 or 60 s only** | ~1 ms |
| **Daily budget** | D1 (`quota`) | successes | calendar day | ~105 ms, rare paths only |

**The binding cannot bound a day.** Its `period` accepts only 10 or 60 seconds,
so even a strict 5-per-minute cap on registration still permits 7,200 sign-ups
a day from one address — 72× the entire daily mail allowance. That gap is the
whole reason the third mechanism exists, and it is why a new limit protecting a
provider quota needs a daily budget *in addition to* a binding, never instead
of one: the binding absorbs the flood cheaply, the budget survives a caller
patient enough to stay under it.

**Per-minute caps** (all per-colo; see the limitations note below). Keyed by
**user id** wherever an identity exists by the time they run, and by **IP**
otherwise — which is most of the auth surface. The IP-keyed ones are set
generously on purpose, for the reason spelled out in `worker/src/auth/throttle.ts`:
one address can be a household, an office, or a mobile carrier's CGNAT, so a
strict shared-address limit turns protection into a denial-of-service vector.
Every number below is far above what any real client does.

- `/auth/kdf`, `/auth/login` — 30/min per IP
- `/auth/register` — 5/min per IP, plus the shared mail budget
- `/auth/refresh`, `/auth/logout` — 60/min per IP
- `/v1/spaces/*` (all ~90 routes) — 600/min per user
- `/v1/mail` (the IMAP relay, web only) — 30/min per user
- note-image upload — 10/min per user
- `/v1/health` — 20/min per IP
- the proxy routes (`/v1/dav`, `/v1/quotes/*`, `/v1/feed`) and outbound mail keep their existing caps

**Per-day ceilings** (`worker/migrations/0007_quota.sql`, `worker/src/db/quota.ts`):

- **All outbound mail: 80/day**, across every endpoint and recipient. This is
  the circuit breaker — no combination of addresses, IPs or endpoints can push
  Resend past its free tier. Enforced inside `sendEmail` rather than per-route,
  so a future mail path cannot forget it.
- **Mail per IP: 5/day.**
- **Note-image uploads: 200/day per user**, against KV's 1,000 free writes —
  by a wide margin the tightest quota in the stack.

A 429 from a per-minute limit carries `Retry-After`; **a refused per-day ceiling
deliberately does not**, and that difference is a signal the client reads. A
backup restore uploads note images in a tight loop and is the one caller that
can honestly wait, so it sleeps through a burst limit and gives up on the daily
one — the presence of the header is how it tells "wait a minute" from "wait
until tomorrow". The message names the resource but never the
budget: telling a caller how long to wait is what an honest client needs, while
telling it how many calls it gets is telling an abusive one how to pace itself.
On the auth routes every limiter returns the *same* message, because a 429 that
differed between "the address you asked about" and "the address you came from"
would be the account-existence oracle the decoy KDF salt exists to deny.

**Registration now requires a captcha on every platform**, desktop included —
see the Turnstile note under [limitations](#notes--current-limitations) for
what that changes and how to undo it if desktop sign-up breaks.

## Project layout

The repo is npm workspaces: the root package is the app, plus two workspaces
added by the cloud migration.

```
worker/                 # Cloudflare Worker — the API (see worker/README.md)
  migrations/           #   D1 schema; 0001 squashes local 001–007 + tenancy,
                        #   0006 adds the cloud-synced Widgets settings,
                        #   0008 adds notes.kind + entry_date for the Diary
  src/                  #   Hono app, error boundary, CORS, routes
packages/shared/        # types + zod schemas + normalization, imported by BOTH
                        #   the client and the Worker, as TypeScript source, so
                        #   the two cannot drift
src/
  db.ts                 # data-access facade — every domain calls the Worker;
                        #   the only module that talks to the data API
  lib/
    api.ts              # the only path to the Worker: auth headers, token
                        #   refresh (deduplicated), offline detection
    auth.ts             # register / login / logout / restore, in UI terms
    authStore.ts        # session + current space on this device (swap this
                        #   one file for an OS keychain on mobile)
    kdf.ts              # client-side argon2id — the password never leaves here
    cache.ts            # IndexedDB snapshot of remote reads, for offline
    platform.ts         # isTauri(), split out to avoid an import cycle
  components/auth/
    AuthGate.tsx        # decides whether <App> mounts at all
  views/AuthView.tsx    # sign in / create account
worker/src/
  authorize.ts          # the single tenancy choke point (membership + role)
  db/                    # all SQL, every query scoped by space_id
  routes/spaces.ts       # /v1/spaces/:spaceId/(reminders|notes|...|settings)
  routes/feed.ts         # the RSS relay — the ONE route that takes a URL
  routes/mail.ts         # the IMAP relay (web only); imap.ts is the client
  db/settings.ts         # the cloud-synced Widgets settings (key/value per space)
  types.ts              # domain types mirroring the schema
  locales/
    en/app.json         # translation catalogs (English is the source of truth)
    zh-TW/app.json
  @types/
    i18next.d.ts        # typed translation keys (a typo is a compile error)
  lib/
    i18n.ts             # i18next setup, language detection, <html lang>
    recurrence.ts       # rrule expansion (local events)
    ics.ts              # ICS import/export
    backup.ts           # full-data JSON backup/restore (all tables + non-secret settings)
    calendars.ts        # calendar registry + local/remote aggregation & write routing
    mail/               # read-only IMAP: transport pick, MIME decoding
      client.ts         # Rust command (desktop) vs Worker relay (web)
      mime.ts           # encoded words, multipart, charsets — decoded ONCE here
      mailbox.ts        # listFolders / searchMail / getMessage
    caldav/
      client.ts         # authenticated WebDAV requests + XML helpers
      discovery.ts      # principal -> calendar-home -> calendar collections
      events.ts         # calendar-query REPORT (read) + PUT/DELETE (write), ETags
      ical.ts           # VEVENT <-> UnifiedEvent via ical.js (TZID-aware)
    notifications.ts    # due-item notification poller
    format.ts           # date helpers
    images.ts           # decode/downscale/re-encode (person photos, note images)
    settings.ts         # app settings: per-device in localStorage (model, voice,
                        #   calendar accounts, theme, layout) PLUS the cloud sync
                        #   for the Widgets ones (weather location + unit,
                        #   watchlist, RSS feeds + count). The allowlist that keeps
                        #   secrets off the server lives in packages/shared.
    secrets.ts          # the ONLY module holding credentials: the OpenAI key and
                        #   the iCloud app password. Own storage keys, per account,
                        #   cleared on sign-out. Still plaintext — not encryption.
    ai.ts               # AI assistant: read + write tools + agentic loop
    weather.ts          # Open-Meteo forecast, hourly, air quality + place search
                        #   (keyless, never stored)
    stocks.ts           # stock quotes + intraday series + symbol search
                        #   (keyless but undocumented, never stored)
    rss.ts              # RSS/Atom fetch (via the Worker relay) + parse + merge
                        #   (never stored; cached in localStorage for 30 min)
    voice.ts            # mic recording, Whisper transcription, TTS engines + fallback
    openaiTts.ts        # OpenAI neural voices (natural spoken replies)
    demo.ts             # reset + seed demo data
  components/
    today/              # one file per Today widget + the registry they're
                        #   listed in; each fetches its own data and renders
                        #   inside an error boundary
    assistant/          # useAssistantChat (the turn + voice lifecycle) and the
                        #   pieces both surfaces render: MessageList, Composer,
                        #   AssistantPopup (the floating chat window)
    ui.tsx              # Modal, Button, priority helpers
    ViewGate.tsx        # a view's first-load state: spinner, retry panel, and
                        #   the timeout that stops either owning the page
    Avatar.tsx          # contact avatar (photo or initials)
    PhotoPicker.tsx     # avatar + profile-photo upload (crop/downscale)
    MarkdownToolbar.tsx # note formatting bar (selection/line transforms)
    DictateButton.tsx   # reusable mic button: record → Whisper → text
    NoteImage.tsx       # renders sbimg: refs in the note preview, + size picker
    YouTubeEmbed.tsx    # bare YouTube URL → video card; opens in the browser
    ItemMeta.tsx        # shared Tags + Links + People panels
    ItemCard.tsx        # item row: search results + assistant chat cards
    EventForm.tsx       # event create/edit
  views/                # Today, Calendar, Reminders, Notes, People,
                        #   Mail (only routed when an inbox is connected),
                        #   Assistant, Settings, Search
src-tauri/
  src/lib.rs            # plugin wiring + the one custom command (thin)
  src/mail.rs           # imap_op: TLS socket to iCloud IMAP, read-only,
                        #   iCloud-only host allowlist. The one exception to
                        #   "plugin wiring only" — no plugin can open a socket.
  Info.plist           # macOS NSMicrophoneUsageDescription (voice input)
  migrations/
    001_init.sql            # initial schema
    002_default_lists.sql   # seed Personal/Work, drop Inbox
    003_people.sql          # people (contacts, vCard 4.0-modeled)
    004_person_custom_fields.sql  # global custom-field label registry
    005_fts_trigram.sql     # rebuild notes FTS with the trigram tokenizer (CJK)
    006_note_images.sql     # note_images: image bytes referenced from note bodies
    007_unique_list_name.sql  # collapse duplicate list names, unique index on lists.name
  capabilities/default.json  # plugin permissions THAT SHIP (notification, dialog,
                             #   fs scope, http scope for api.openai.com +
                             #   caldav.icloud.com / *.icloud.com +
                             #   api.open-meteo.com / geocoding-api.open-meteo.com /
                             #   air-quality-api.open-meteo.com /
                             #   query1.finance.yahoo.com + the deployed Workers)
  dev-capabilities/localhost.json  # loopback http scope for the dev Worker.
                             #   NOT in capabilities/ — everything there is
                             #   embedded unconditionally. Added at runtime by
                             #   lib.rs under #[cfg(debug_assertions)].
CLAUDE.md              # architecture, conventions & gotchas for contributors
```

## Contributing / development

See [CLAUDE.md](CLAUDE.md) for architecture principles, conventions, and the gotchas that have bitten us (migrations are checksummed, `window.prompt` doesn't work in the webview, timezone handling, the view-remount pattern, adding AI tools, etc.). Please run `tsc` and `vite build` (and `cargo check` if Rust changed) before considering a change done — **and keep this README up to date with every change.**

## Notes / current limitations

- The AI assistant can read, create/update, **and delete** data, and requires your own OpenAI API key. It acts without a per-change confirmation *dialog* — it relies on the model to confirm ambiguous or destructive requests in chat first — so review what it reports, especially deletions (which are permanent). Replies are non-streaming (the whole answer appears once ready).
- Voice input is **push-to-talk** (click to start/stop) — no hands-free/continuous mode or silence auto-stop yet. It **only works in a packaged build** (`tauri dev` can't access the mic — see the Setup section), needs microphone permission, and sends audio to OpenAI for transcription. Spoken-reply voice quality depends on the OS's installed voices — the app picks the best one installed and Settings lets you override it, but it can't improve on what macOS offers, and Siri voices aren't available to the Web Speech API. Genuinely neural TTS would mean a network voice or a bundled local model.
- Desktop notifications are **poll-based** (checked every 60s while the app is open) — the plugin has no cross-platform "schedule for later" API. Alerts won't fire while the app is closed.
- **The mobile layout is a responsive web layout, not a mobile app.** The break happens at 768px, so a phone in landscape and most tablets get the desktop two-pane layout — which is the intent, but it means the cutover is width-based rather than device-based. A few desktop affordances stay desktop-only because they're hover-revealed and touch has no hover: a note list row's secondary controls, for instance. Reordering was fixed rather than dropped — see above. Nothing here changes the packaged desktop app.
- **There is no drag-and-drop anywhere in the app**, by decision rather than omission: HTML5 drag doesn't work in the WKWebView the packaged app runs in, and a drag handle that silently does nothing is worse than no handle. Reordering custom fields is ▲/▼ buttons (which also work from a keyboard); rescheduling an event means opening it and changing the date.
- **Apple calendars need a connection** — they're fetched live and never cached to disk, so they don't appear offline (the built-in calendar is unaffected). This is the deliberate trade for having no local copy to keep in sync.
- **Apple events can't carry tags, links, or people.** Those live in D1 keyed by a built-in event id, and a connected event has no such row. The event editor hides those panels for remote events.
- **Global search covers connected calendars only within a date window.** CalDAV has no unbounded keyword search — the only server-side filter is a time-range — so connected calendars are searched a year either side of today, widened in steps from a control under the results that names the range being searched. The built-in calendar has no such limit; it's in D1, so it's searched over all time. An event in a connected calendar outside the window is missing rather than absent, which is why the range is stated rather than assumed. **Connected mail is searched too, but the inbox only** — IMAP SEARCH is per-mailbox and unranked, so global search asks the inbox and shows the newest matches, on its own 500ms debounce because each query is a login to the mail server. Mail in another folder is missing rather than absent; a note under the results says so, and the mail leg is skipped entirely when no inbox is connected.
- **Moving an event between calendars isn't supported in-app** — the calendar picker is fixed once an event exists, because copy-then-delete would silently drop a local event's tags, links, and people. Delete it and recreate it in the target calendar.
- Remote **timed** events keep the timezone they were authored in on write: re-saving an event that came from Apple writes `DTSTART;TZID=…` (and a matching `EXDATE;TZID=…`) with the original `VTIMEZONE` copied back in, so a 9am weekly standup stays at 9am across a daylight-saving boundary. All-day events use `VALUE=DATE`. **What's still UTC:** events whose source zone we never saw — chiefly **events created in the app**, which have no `TZID` of their own. The app ships no timezone database, and RFC 5545 requires the `VTIMEZONE` definition to travel with any `TZID` reference, so there's nothing honest to emit; a *new recurring timed* event therefore still drifts an hour across a DST change. Single events are unaffected either way (the instant is the same).
- Per-instance `RECURRENCE-ID` overrides, attendees, and `VALARM` alarms are not synced — an event with per-instance overrides shows its series pattern, and editing it would drop the overrides.
- Local events have no timezone handling beyond the machine's local zone (fine for single-user local use; remote events *are* resolved from their source zone).
- **Chinese notes search needs 3+ characters to be ranked.** The notes index uses D1's FTS5 `trigram` tokenizer, which can't answer queries shorter than 3 characters — and the commonest Chinese words are exactly 2 (北京, 會議). Those queries fall back to a `LIKE` scan, which is correct but unranked and slower on large note sets.
- **A custom (non-preset) RRULE is described in English** even in Chinese. `rrule`'s `toText()` substitutes token by token, and Chinese word order differs enough ("every week on Monday" vs 每週一) that the output would read worse than English. The repeat presets themselves are translated, which covers the common cases.
- **Profile photos accept PNG/JPEG/WebP/GIF, not HEIC** — the webview can't decode HEIC, so a photo dragged straight out of Apple Photos is rejected with an error rather than silently failing; export it as JPEG first. Photos are stored inline on the person row, so they're included in a Settings → Data backup (and inflate the JSON by ~30 KB each) rather than living as separate files.
- The demo dataset and the assistant's own prose are **English-only**; the assistant replies in whatever language you write to it in.
- The OpenAI API key **and the iCloud app-specific password** are stored in plaintext in `localStorage`, keyed per signed-in account. They are confined to `src/lib/secrets.ts` — one module, its own storage keys, no credential inside any settings object — and **cleared on sign-out**, so they no longer outlive a session on a shared machine. That shrinks the surface and the lifetime; it does **not** encrypt anything. On the desktop, plaintext-at-rest is typical for a local app: anyone with the machine profile can read them, and moving them to the OS keychain is future work. **On the web build it is more serious**: `github.io` is a public origin, so any script execution there reads both secrets *and* the refresh token. The built page ships a `Content-Security-Policy` meta tag (`default-src 'self'`, no inline or remote script, `connect-src` limited to the API and the handful of CORS-sending services) precisely to narrow that, but GitHub Pages cannot send real headers, so `frame-ancestors` is unavailable and the CSP is the only layer. The durable fix is for the web build not to hold those secrets at all.
- **Injected script is worse inside the packaged app than on the web, which is counter-intuitive.** The web CSP above also constrains *exfiltration* — no arbitrary `connect-src`, `object-src 'none'`, no `form-action`, images limited to `'self' data: blob:`. Inside Tauri, `plugin-http` runs in Rust and is not subject to CSP at all, and `capabilities/default.json` scopes `api.openai.com` and `*.icloud.com`; so injected script still cannot post the secrets to an attacker's host, but it can *use* them in place — spend the OpenAI balance, read or delete iCloud calendars. Both credentials are therefore linked to their revocation page in Settings, and both are worth scoping at the source: a key kept for this app alone, with a spend limit on it.

  Because that capability scope is the *only* boundary on the plugin, what is in it matters more than it looks. **Loopback used to be**: `http://localhost:*/*` and `http://127.0.0.1:*/*` were in the shipped list for the sake of the dev Worker, which meant the same injected script could also reach every service listening on the user's own machine — another app's local API, a database admin panel — from outside the browser's origin rules entirely. They are now in `src-tauri/dev-capabilities/localhost.json`, added at runtime by `lib.rs` under `#[cfg(debug_assertions)]`. The gate is deliberately *not* a cargo feature: a feature can be named on a release build, `debug_assertions` cannot, so a packaged app is structurally incapable of reaching loopback rather than merely configured not to. The trade is that an E2E build (release, `--features wdio`) has no loopback access either, so those specs run against the deployed Worker named in `.env.production` — which is what they already did.
- **The Worker relays iCloud credentials for the web build.** `POST /v1/dav` forwards the app-specific password and calendar contents in plaintext because iCloud sends no CORS headers; TLS terminates at the Worker, so both are visible to it in memory. Nothing is stored or logged, a session is required, only iCloud hosts are reachable, redirects are never followed, and it is rate-limited per user — but it is an accepted exposure, not an eliminated one. The desktop app doesn't use it.
- **Password reset needs email configured on the server.** Without `RESEND_API_KEY`, requesting a reset link returns the same "if that address has an account…" response it always does and no mail is sent; the operator sees it in `wrangler tail`, the user sees nothing.
- **Email confirmation is required to sign in.** Registration no longer logs you in — it creates the account, mails a confirmation link, and shows a "check your inbox" screen. A correct password for an unconfirmed address is refused with a distinct `email_unverified` code so the sign-in screen can offer to resend rather than showing "wrong password". Because a locked-out user can't reach an authenticated endpoint, the resend link is a public, oracle-safe, rate-limited endpoint (`/v1/auth/email/verify/resend`) that answers identically for confirmed, unconfirmed and unknown addresses alike. This means **the server must have `RESEND_API_KEY` set or nobody new can get in** — the gate and the mailer are now coupled.
- **Per-minute rate limits are counted per Cloudflare colo**, not globally, because they use Cloudflare's in-colo rate-limiting binding rather than a database row (a D1 counter would add ~105 ms to every relayed CalDAV call). A caller spread across datacentres therefore gets the budget several times over. That's sound for what these limits defend against — one stolen session relaying from one place — and genuinely distributed abuse hits the Worker's own 100k requests/day first. **The per-day ceilings are not affected**: those live in D1 and are globally consistent, which is exactly why the things that spend real money have one. See [Rate limiting](#rate-limiting).
- **A refused daily budget is counted, not just refused.** `consumeDailyQuota` increments before it answers, so an attempt turned away still spends a unit. That over-counts abuse and makes the mail breaker trip slightly early — the conservative direction for a ceiling whose entire job is to not be crossed, and it avoids a read-then-write race. It also means a D1 outage stops outbound mail rather than un-capping it: the mail path fails closed by design.
- **A Cloudflare Turnstile captcha guards register and login, web-only, enforced per origin.** Turnstile is a browser widget, so it renders only on the web build; the desktop app serves from a `tauri://` origin the Worker exempts (its native http-plugin requests carry no `Origin` header). The Worker verifies the token server-side (`worker/src/auth/turnstile.ts`) whenever `TURNSTILE_SECRET_KEY` is set and the request comes from a browser origin — the client widget is not the enforcement. Two knobs are coupled: the public site key ships in the web build as `VITE_TURNSTILE_SITE_KEY` and the secret is a Worker secret (`wrangler secret put TURNSTILE_SECRET_KEY`); **set both or neither** — a secret with no site key locks web users out (the widget that mints the token never renders), and neither one leaves desktop or unconfigured environments blocked. **Registration is the exception: it now requires a token on every platform, desktop included.** The per-origin exemption was the hole on that endpoint — a script sends no `Origin` at all, so exempting "no origin" exempted precisely the caller the check exists to stop, and registration is the one unauthenticated route a stranger can use to mint accounts and spend the daily mail allowance. Sign-in keeps the web-only rule deliberately: whether Cloudflare will issue a token to a widget hosted at `tauri://localhost` is **unproven** (a site key's allowlist is expressed in domains, and a custom scheme has no obvious spelling in one), so if the bet loses the damage is confined to new desktop sign-ups while existing users can still get in. **If desktop registration breaks, set `TURNSTILE_ALLOW_NATIVE=1`** on the Worker — it restores the per-origin exemption for registration, turning the fix into one `wrangler secret put` rather than a code change and a redeploy. For that to actually work the desktop client renders the widget but does **not** block submit on having a token (the web build still does): otherwise a failed widget would keep sign-up broken until the app was rebuilt and redistributed, no matter what the operator set on the Worker. The Worker stays the only thing that decides. Registration then falls back to its rate limit plus the daily mail budget, which is weaker, so leave it unset unless it's needed.
