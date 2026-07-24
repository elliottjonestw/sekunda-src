// App settings, persisted in localStorage, scoped per signed-in account (see
// the note on KEY). Kept out of the database on purpose: "clear all data" must
// not erase the user's configuration, and settings aren't part of the syncable
// calendar data model.
//
// **No credentials live in this file.** The OpenAI API key and the iCloud
// app-specific password are in `secrets.ts`, under their own storage keys and
// their own accessors, precisely so that nothing here — the cloud-sync
// allowlist, the backup writer, the Settings draft — has to remember to exclude
// them. Adding a secret-bearing field to `AppSettings` or `CalDavAccount` puts
// that burden back; put it in `secrets.ts` instead.
//
// MOST settings are per-device and stay that way. The handful on Settings →
// Widgets also follow the account through the Worker — see the cloud-sync
// section at the bottom of this file.
//
// The authStore and api imports are safe in both directions: authStore depends
// only on @secondbrain/shared, and api.ts depends on authStore/platform/shared
// but never on this module, so neither can close a cycle. `secrets.ts` imports
// `scopedKey` FROM here and this module must never import it back.

import { CLOUD_SETTING_KEYS, type CloudSettingKey } from "@secondbrain/shared";
import { getCachedSession, getCurrentSpaceId } from "./authStore";
import { apiRequest } from "./api";
import type { ThemePreference } from "./theme";

/** Which text-to-speech engine speaks assistant replies. */
export type TtsEngine = "openai" | "system";

/** Bounds for `speechRate`. Both engines behave sensibly across this range. */
export const MIN_SPEECH_RATE = 0.5;
export const MAX_SPEECH_RATE = 2;

export function clampSpeechRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.min(MAX_SPEECH_RATE, Math.max(MIN_SPEECH_RATE, rate));
}

/**
 * The models offered for the assistant, cheapest first (verified against the
 * OpenAI catalog and pricing pages, July 2026).
 *
 * Membership is not "every model OpenAI sells" — it's every model that can run
 * *this* assistant, which means Chat Completions **with function calling**,
 * since `ai.ts` is a tool-calling loop and a model without tools would answer
 * every question by making the answer up. That same requirement is why the list
 * is all gpt-5-lineage: the models that can search the web *natively* on Chat
 * Completions (the `-search` models behind the `web_search` tool) are exactly
 * the ones that CANNOT do function calling, so they can never be the assistant's
 * own model — web search reaches every model here through the delegated tool
 * instead (see `WEB_SEARCH_MODEL` in `ai.ts`). Prices aren't shown: they move,
 * and a stale number in the UI is worse than none. One entry per price point —
 * two models at an identical price is just noise in a dropdown.
 *
 * Every model here begins with "gpt-5", and that whole lineage accepts only the
 * default `temperature`, so `callChat` omits the field for all of them — see
 * `supportsTemperature`. The 0.6 default there now only applies to a gpt-4 id
 * typed in by hand.
 */
export const OPENAI_MODELS = [
  "gpt-5-nano",     // $0.05 / $0.40
  "gpt-5.4-nano",   // $0.20 / $1.25
  "gpt-5-mini",     // $0.25 / $2.00
  "gpt-5.4-mini",   // $0.75 / $4.50
  "gpt-5.6-luna",   // $1.00 / $6.00
  "gpt-5",          // $1.25 / $10.00
  "gpt-5.6-terra",  // $2.50 / $15.00
  "gpt-5.6-sol",    // $5.00 / $30.00
] as const;

export interface AppSettings {
  // NOTE: the OpenAI API key is deliberately NOT here — it and the iCloud
  // app-specific password live in `secrets.ts`, under their own storage keys.
  // Don't add a credential to this interface; see that module's header.
  openaiModel: string;
  /** Speech-to-text model used for voice input. */
  sttModel: string;
  /**
   * Which engine speaks replies. "openai" is neural voices over the network
   * (billed); "system" is the OS's offline voices. Either way the system voice
   * below is the fallback, so a reply is never lost to a network problem.
   */
  ttsEngine: TtsEngine;
  /** Text-to-speech model used for spoken replies. */
  ttsModel: string;
  /**
   * Chosen OpenAI voice. A single setting rather than one per language: these
   * voices are multilingual, so the same voice reads both English and Chinese.
   * (System voices are the opposite — each one speaks a single language — which
   * is why `preferredVoices` below stays a per-language map.)
   */
  openaiVoice: string;
  /** Speaking rate multiplier, 1 = normal. Applies to both engines. */
  speechRate: number;
  /**
   * Chosen *system* voice per speech language, as BCP 47 tag → voiceURI.
   * Empty/absent means "let the app pick the best installed voice".
   */
  preferredVoices: Record<string, string>;
  /** UI language: "system" to follow the OS, or a code from lib/i18n LANGUAGES. */
  language: string;
  /**
   * Light or dark appearance, or "system" to follow the OS. Applied by
   * `lib/theme.ts`, which owns the `dark` class on <html> — Tailwind is on the
   * class strategy precisely so this setting can override the OS.
   */
  theme: ThemePreference;
  /**
   * Where to show the weather for, or null for "don't". Resolved once by the
   * Settings place search and stored whole: the Today tile then needs no
   * geocoding lookup, so a place that has been chosen keeps working offline
   * right up to the forecast call itself.
   */
  weatherLocation: WeatherLocation | null;
  /** Temperature unit for the weather tile. Open-Meteo converts server-side. */
  temperatureUnit: TemperatureUnit;
  /**
   * Symbols on the Today ticker, in the order they're shown. Empty means the
   * card doesn't render at all — like the weather tile with no location, an
   * empty ticker would just be a standing advert for a setting.
   *
   * Resolved whole by the Settings picker (ticker *and* display name), so the
   * card never has to look a symbol up before it can draw a row.
   */
  watchlist: StockSymbol[];
  /**
   * RSS/Atom feeds on the Today page, in the order they're read.
   *
   * Cloud-synced (see CLOUD_SETTING_KEYS): a subscription list is built up over
   * months and is one of the things people most expect to find waiting on a new
   * machine. Empty means the card doesn't render — like the weather tile with
   * no location, an empty feed list would just advertise a setting.
   */
  rssFeeds: RssFeed[];
  /** How many articles the feed card shows, across all subscribed feeds. */
  rssItemCount: number;
  /**
   * Order and visibility of the Today page's cards. Stored as the user arranged
   * it, NOT as the complete truth — read it through `mergeTodayLayout`, which
   * drops ids the app no longer has and appends ones it has gained. An empty
   * array means "never customised", i.e. every card in its default order.
   */
  todayLayout: TodayCardPref[];
  /**
   * Hold the Today page's "Your day" briefing for `summaryMaxAgeHours` after it
   * was written, instead of rewriting it whenever the day's facts change. Purely
   * a spend control — that card is the app's only *automatic* billed request, so
   * ticking off four todos otherwise buys four summaries. Off means the old
   * behaviour: any change to the day regenerates. The refresh button ignores
   * this either way.
   */
  summaryThrottle: boolean;
  /** How long a written briefing stays good for, in hours. */
  summaryMaxAgeHours: number;
  /**
   * Let the assistant search the web when a question needs facts that aren't in
   * the user's data. Off by default, and the switch is a *token* control as much
   * as a privacy one: off, the tool schema isn't sent at all, so a user who
   * doesn't want this pays nothing for its existence. On, it still costs nothing
   * until the model actually calls it — see `WEB_SEARCH_TOOL` in `ai.ts`.
   */
  webSearch: boolean;
}

export const MIN_SUMMARY_MAX_AGE_HOURS = 1;
export const MAX_SUMMARY_MAX_AGE_HOURS = 168; // a week

export function clampSummaryMaxAge(hours: number): number {
  if (!Number.isFinite(hours)) return DEFAULTS.summaryMaxAgeHours;
  return Math.min(MAX_SUMMARY_MAX_AGE_HOURS, Math.max(MIN_SUMMARY_MAX_AGE_HOURS, Math.round(hours)));
}

/**
 * How long a cached briefing may be reused even after the day's facts change,
 * in ms. 0 when the throttle is off, i.e. only an exact fact match is reusable.
 */
export function summaryMaxAgeMs(): number {
  const s = getSettings();
  return s.summaryThrottle ? clampSummaryMaxAge(s.summaryMaxAgeHours) * 3600_000 : 0;
}

/** One card's placement on the Today page. Order is the array's own order. */
export interface TodayCardPref {
  id: string;
  hidden: boolean;
}

/**
 * Reconcile a stored layout with the cards this build actually has.
 *
 * Storage is a *preference*, not an inventory: a card added in a later version
 * must show up for someone who arranged their page in an earlier one, and a
 * card that's been removed must not linger as a dead row in the editor. So
 * known ids keep their saved order and visibility, unknown ids are dropped, and
 * anything missing is appended visible.
 */
export function mergeTodayLayout(stored: TodayCardPref[], known: readonly string[]): TodayCardPref[] {
  const valid = stored.filter((p) => known.includes(p.id));
  const seen = new Set(valid.map((p) => p.id));
  return [...valid, ...known.filter((id) => !seen.has(id)).map((id) => ({ id, hidden: false }))];
}

export const MIN_RSS_ITEMS = 1;
export const MAX_RSS_ITEMS = 20;

/** How many feeds one account may subscribe to. Every feed on the list is a
 *  relayed request on each Today load that misses the cache, so this is the
 *  same kind of cap as MAX_WATCHLIST and exists for the same reason. */
export const MAX_FEEDS = 10;

export function clampRssItemCount(count: number): number {
  if (!Number.isFinite(count)) return DEFAULTS.rssItemCount;
  return Math.min(MAX_RSS_ITEMS, Math.max(MIN_RSS_ITEMS, Math.round(count)));
}

/**
 * A subscribed feed.
 *
 * `id` is a client-minted uuid rather than the URL: it keeps React keys and
 * removal stable if a user ever edits a feed's address, and it means the list
 * reorders like every other list in the app.
 */
export interface RssFeed {
  id: string;
  /** Absolute https URL of the feed document. Validated when it's added. */
  url: string;
  /** Channel title, resolved once at add time so the settings list and the
   *  card can name the source without a fetch. Falls back to the host. */
  title: string;
}

export type TemperatureUnit = "celsius" | "fahrenheit";

/**
 * An instrument chosen in Settings. Lives here rather than in `stocks.ts` for
 * the same reason `WeatherLocation` does: it's the stored *configuration*, and
 * keeping it on this side means the provider module depends on settings and
 * never the other way round.
 */
export interface StockSymbol {
  /** Ticker as the quote service knows it, e.g. "AAPL", "0700.HK", "^GSPC". */
  symbol: string;
  /** Display name resolved once at pick time, e.g. "Apple Inc.". */
  name: string;
}

/** A place chosen in Settings, as returned by the geocoding search. */
export interface WeatherLocation {
  /** Display name, e.g. "Taipei". */
  name: string;
  /** Region/country for disambiguation in the UI, e.g. "Taiwan". */
  country: string;
  latitude: number;
  longitude: number;
}

/**
 * Settings are stored PER ACCOUNT, not per device.
 *
 * They used to be one shared bucket, which was harmless when the app had a
 * single user and no accounts. It stopped being harmless the moment anyone
 * could sign out and someone else could register on the same machine: the
 * second person inherited the first person's OpenAI API key and their iCloud
 * app-specific password, because a new account never cleared localStorage.
 *
 * Namespacing by user id fixes that, and also means a shared device keeps each
 * person's weather location, watchlist and Today layout separate.
 *
 * Signed out, reads and writes go to an `anon` bucket. That is why the login
 * screen shows the default language rather than the last user's: a preference
 * is not worth leaking which account was last used on a shared machine.
 *
 * **This is isolation, not secrecy.** Everything here is still plaintext in
 * localStorage, readable from devtools by anyone at the keyboard and by any
 * XSS on the origin. That is tolerable for a watchlist and a theme, which is
 * all this file holds now — the two credentials moved to `secrets.ts`, which
 * applies the same scoping and additionally clears itself on sign-out.
 */
const KEY = "secondbrain.settings";

/** The signed-in user's id, or null. Read through authStore so this module
 *  never has to know how a session is persisted. */
function currentUserId(): string | null {
  return getCachedSession()?.user?.id ?? null;
}

/**
 * The storage key for this account, migrating the pre-account bucket into it
 * on first touch. Exported for `secrets.ts`, which stores the two credentials
 * under the same per-account rule; nothing else should need it.
 *
 * The migration is lazy rather than a step in the sign-in flow because it must
 * hold whatever order things load in: whoever reads settings first after an
 * upgrade adopts the old values, and the shared copy is removed so no later
 * account can inherit it.
 */
export function scopedKey(base: string): string {
  const uid = currentUserId();
  const key = `${base}.${uid ?? "anon"}`;
  if (uid) {
    const legacy = localStorage.getItem(base);
    if (legacy !== null) {
      // Don't clobber a bucket this account already has.
      if (localStorage.getItem(key) === null) localStorage.setItem(key, legacy);
      localStorage.removeItem(base);
    }
  }
  return key;
}

/**
 * The short-lived, per-device caches that hold live third-party data (weather,
 * RSS, stock quotes, the AI day summary). None of it is credentials and none of
 * it is the user's own rows — but the RSS list and the day summary still
 * *describe* one account's data, so on a shared device they must not follow the
 * account out of the session the way the four caches once did: they were left
 * under bare keys when settings and secrets moved to `scopedKey`, so signing
 * out left the next person to sign in reading the previous user's feeds and
 * schedule-derived briefing.
 *
 * Each entry is a *base* key the cache module owns (versioned, so a shape
 * change still retires what earlier builds wrote). `scopedCacheKey` routes one
 * through `scopedKey` so it lands in this account's bucket; `clearScopedCaches`
 * wipes every registered key and is called from `logout`/`deleteAccount` before
 * `clearAuth`, for the same reason `clearSecrets` is: once the session is gone
 * `scopedKey` resolves to the `anon` bucket and a wipe would hit nothing.
 *
 * A new short-lived cache registers here rather than adding a second clear call
 * to the auth paths — that is the point of the list, because "remember to clear
 * it on sign-out" is exactly what the four below forgot to do.
 */
const SCOPED_CACHE_BASES = [
  "secondbrain.weather.v2",
  "secondbrain.rss.v1",
  "secondbrain.stocks.v1",
  "secondbrain.daySummary.v2",
];

/** The per-account storage key for a registered short-lived cache. */
export function scopedCacheKey(base: string): string {
  return scopedKey(base);
}

/** Wipe every registered short-lived cache for the currently-signed-in account.
 *  MUST run before `clearAuth` — see the note on the list above. */
export function clearScopedCaches(): void {
  for (const base of SCOPED_CACHE_BASES) localStorage.removeItem(scopedKey(base));
}

const DEFAULTS: AppSettings = {
  openaiModel: "gpt-5-nano",
  sttModel: "whisper-1",
  // Natural voices by default — they're the reason this setting exists. Safe as
  // a default even though they're billed: a spoken reply only happens after
  // *speech input*, which already needs an OpenAI key for Whisper. With no key
  // it falls back to the system voice rather than failing.
  ttsEngine: "openai",
  ttsModel: "gpt-4o-mini-tts",
  openaiVoice: "",
  speechRate: 1,
  preferredVoices: {},
  language: "system",
  // Follow the OS unless told otherwise, same rule as the language.
  theme: "system",
  // A fresh install gets a populated weather tile and ticker rather than two
  // cards advertising a setting. Both are ordinary values the user can change
  // or clear in Settings; clearing sticks, because a stored settings object
  // overrides these defaults key by key.
  weatherLocation: { name: "New York", country: "United States", latitude: 40.7128, longitude: -74.006 },
  temperatureUnit: "celsius",
  watchlist: [
    { symbol: "AAPL", name: "Apple Inc." },
    { symbol: "GOOGL", name: "Alphabet Inc." },
  ],
  // No feeds by default: unlike a weather location, there is no sensible guess
  // at what someone reads, and seeding one would be an editorial choice.
  rssFeeds: [],
  rssItemCount: 5,
  todayLayout: [],
  summaryThrottle: true,
  summaryMaxAgeHours: 6,
  webSearch: false,
};

export function getSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(scopedKey(KEY));
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch };
  localStorage.setItem(scopedKey(KEY), JSON.stringify(next));
  // Anything on the cloud allowlist also goes to the server, in the background.
  // Local storage is written first and unconditionally, so a failed or offline
  // push costs the user nothing they can see.
  pushCloudSettings(pickCloud(patch));
  return next;
}

// ---------------------------------------------------------------------------
// The few settings that follow the ACCOUNT rather than the device
//
// Everything above is per-device by design, and most of it should stay that
// way — a voice, a theme, a layout are answers about *this* machine. The
// Widgets page is the exception: where you are, what you hold and what you read
// are answers about you, and re-entering them on every new device is the kind
// of small tax that makes an app feel like it doesn't know you.
//
// The rule that makes this safe is CLOUD_SETTING_KEYS in @secondbrain/shared:
// the client only ever uploads a key on that list, and the Worker rejects any
// key off it. It is now a second line of defence rather than the only one —
// the two credentials aren't in `AppSettings` at all, so there is nothing here
// for a careless upload to catch. Both properties are worth keeping: adding a
// key still means asking whether the value is a secret first, and if it is, it
// belongs in `secrets.ts` and not on this list.
//
// Reads stay synchronous. `getSettings()` is called from render paths all over
// the app, so the cloud is not a second source of truth to await: it is loaded
// once at sign-in by `syncSettingsFromCloud`, written into the same
// localStorage bucket, and read from there forever after. That makes the local
// copy an offline cache as well, so the Widgets page works with no network.
//
// Conflicts are last-write-wins, per key, with no merge. Two devices changing
// the same watchlist minutes apart is not worth a vector clock, and every value
// here is one the user can see and re-set.
// ---------------------------------------------------------------------------

/**
 * Keys whose local edits haven't reached the server yet.
 *
 * Without this an edit made offline would be silently reverted by the next
 * sign-in, which is a data-loss bug wearing the costume of a sync feature. The
 * pending list is consulted by `syncSettingsFromCloud`, which pushes those keys
 * instead of letting the server's older value overwrite them.
 */
const PENDING_KEY = "secondbrain.settings.pending";

function readPending(): CloudSettingKey[] {
  try {
    const raw = JSON.parse(localStorage.getItem(scopedKey(PENDING_KEY)) || "[]");
    return Array.isArray(raw) ? raw.filter(isCloudKey) : [];
  } catch {
    return [];
  }
}

function writePending(keys: CloudSettingKey[]): void {
  try {
    if (keys.length) localStorage.setItem(scopedKey(PENDING_KEY), JSON.stringify(keys));
    else localStorage.removeItem(scopedKey(PENDING_KEY));
  } catch {
    /* storage full or disabled — the push below still tries */
  }
}

function isCloudKey(key: string): key is CloudSettingKey {
  return (CLOUD_SETTING_KEYS as readonly string[]).includes(key);
}

/** The cloud-eligible subset of a patch. This function is the only place a
 *  value leaves the device, so the filter lives here and nowhere else. */
function pickCloud(patch: Partial<AppSettings>): Partial<CloudSettings> {
  // Built as a loose record and cast once: writing `out[key]` where `key` is a
  // union of literals narrows the assignable type to the INTERSECTION of the
  // value types, which is `never`. The read side (`patch[key]`) is sound, and
  // the keys come from CLOUD_SETTING_KEYS, so the shape is right by
  // construction — this is TypeScript's limit, not a loosened check.
  const out: Record<string, unknown> = {};
  for (const key of CLOUD_SETTING_KEYS) {
    if (key in patch) out[key] = patch[key];
  }
  return out as Partial<CloudSettings>;
}

/** The shape stored per key. Named so the picker above can't drift from
 *  AppSettings without a compile error. */
type CloudSettings = Pick<AppSettings, CloudSettingKey>;

/**
 * Send cloud-eligible settings to the server, in the background.
 *
 * Deliberately not awaited by `saveSettings`: every caller of that is a UI
 * event handler, and blocking a checkbox on a round-trip to make a *preference*
 * durable is the wrong trade. Failure marks the keys pending and returns — the
 * next successful save or sign-in flushes them.
 */
function pushCloudSettings(values: Partial<CloudSettings>): void {
  const keys = Object.keys(values).filter(isCloudKey);
  if (!keys.length) return;
  // Signed out, there is no account for these to follow. The anon bucket is
  // local-only by definition.
  if (!currentUserId() || !getCurrentSpaceId()) return;

  const pending = new Set([...readPending(), ...keys]);
  writePending([...pending]);

  void (async () => {
    try {
      await apiRequest(spaceSettingsPath(), { method: "PATCH", body: values });
      // Only clear what this request actually carried: another save may have
      // added a key while this one was in flight.
      writePending(readPending().filter((k) => !keys.includes(k)));
    } catch {
      // Offline, or the server said no. The keys stay pending; nothing is
      // surfaced, because the local value — the one the user is looking at —
      // was saved either way.
    }
  })();
}

/**
 * Pull this account's settings from the server into the local bucket.
 *
 * Called once when the app mounts with a session. Anything still pending from
 * an offline edit is pushed first and then left alone, so the server's older
 * copy can't undo a change the user made on this device while disconnected.
 *
 * Never throws: a failure here means the Widgets page shows this device's last
 * known values, which is exactly what it did before any of this existed.
 */
export async function syncSettingsFromCloud(): Promise<void> {
  if (!currentUserId() || !getCurrentSpaceId()) return;

  const pending = readPending();
  if (pending.length) {
    const local = getSettings();
    // Same union-key cast as `pickCloud` — see the note there.
    const values: Record<string, unknown> = {};
    for (const key of pending) values[key] = local[key];
    pushCloudSettings(values as Partial<CloudSettings>);
  }

  try {
    const remote = await apiRequest<Partial<Record<CloudSettingKey, unknown>>>(spaceSettingsPath());
    const patch: Partial<AppSettings> = {};
    for (const key of CLOUD_SETTING_KEYS) {
      // A key edited offline is authoritative here — see above.
      if (pending.includes(key)) continue;
      if (!(key in remote)) continue;
      const value = remote[key];
      if (isPlausible(key, value)) (patch as Record<string, unknown>)[key] = value;
    }
    if (Object.keys(patch).length) {
      // Straight to storage: routing through saveSettings would push what we
      // just pulled back to the server on every launch.
      localStorage.setItem(scopedKey(KEY), JSON.stringify({ ...getSettings(), ...patch }));
      notifyCloudSettingsApplied();
    }
  } catch {
    /* offline or unauthenticated — the local copy stands in */
  }
}

/**
 * Is a value from the server the right *kind* of thing for this key?
 *
 * Not full validation — a shallow check, for the same reason `weather.ts`
 * screens its cache: this data was written by a build that may be older or
 * newer than this one, and a `rssFeeds` that arrives as a string must become a
 * refusal rather than a `TypeError` inside a render. Anything that fails is
 * ignored, leaving the local default in place.
 */
function isPlausible(key: CloudSettingKey, value: unknown): boolean {
  switch (key) {
    case "weatherLocation":
      return value === null
        || (typeof value === "object" && typeof (value as WeatherLocation).latitude === "number");
    case "temperatureUnit":
      return value === "celsius" || value === "fahrenheit";
    case "watchlist":
      return Array.isArray(value) && value.every((s) => typeof s?.symbol === "string");
    case "rssFeeds":
      return Array.isArray(value) && value.every((f) => typeof f?.url === "string" && typeof f?.id === "string");
    case "rssItemCount":
      return typeof value === "number" && Number.isFinite(value);
  }
}

function spaceSettingsPath(): string {
  return `/v1/spaces/${getCurrentSpaceId()}/settings`;
}

/**
 * Notified when a cloud pull actually CHANGED something locally.
 *
 * Settings are read synchronously from storage during render, which works
 * because every other write happens in an event handler that re-renders its own
 * pane anyway. The cloud pull is the one write that lands out of band — mid-way
 * through a Today page that has already drawn — so it needs a way to say so.
 *
 * Deliberately NOT fired by `saveSettings`. The Today layout editor saves on
 * every reorder, and a general "settings changed" signal would make each ▲
 * click refetch every widget's data. This fires once per sign-in, at most.
 */
const cloudApplied = new Set<() => void>();

export function onCloudSettingsApplied(fn: () => void): () => void {
  cloudApplied.add(fn);
  return () => { cloudApplied.delete(fn); };
}

function notifyCloudSettingsApplied(): void {
  for (const fn of cloudApplied) fn();
}

// ---------------------------------------------------------------------------
// Calendar accounts (CalDAV)
//
// Which calendars exist, which are visible, and which is the default is
// *configuration*, not calendar data — and remote events are never stored in
// SQLite — so all of it lives here in localStorage rather than in the DB. Kept
// under its own key so the shape can grow without disturbing AppSettings.
//
// The app-specific password that makes these calendars reachable is NOT here:
// it's in `secrets.ts`, read by `caldav/client.ts` when it builds the auth
// header. So a `CalDavAccount` can be passed around, logged or serialized
// freely — which `discovery.ts` and `calendars.ts` do — without carrying a
// credential along with it.
// ---------------------------------------------------------------------------

/** A calendar collection discovered on a CalDAV server. */
export interface CalDavCalendar {
  id: string; // stable identity = the collection href
  href: string; // absolute URL of the calendar collection
  displayName: string;
  color: string | null; // from CalDAV calendar-color, else a fallback
  visible: boolean;
  supportsVEVENT: boolean;
  readOnly: boolean;
}

export interface CalDavAccount {
  provider: "icloud"; // future: "google" | "fastmail" | "generic"
  username: string; // Apple ID
  // The app-specific password lives in `secrets.ts` — see the note above.
  principalUrl?: string; // discovered
  calendarHomeUrl?: string; // discovered
  calendars: CalDavCalendar[]; // discovered, cached here
}

export interface CalendarSettings {
  account: CalDavAccount | null;
  localVisible: boolean; // show the built-in Sekunda calendar
  defaultCalendarId: string; // where new events land — "local" or a calendar id
}

const CAL_KEY = "secondbrain.calendars";

const CAL_DEFAULTS: CalendarSettings = {
  account: null,
  localVisible: true,
  defaultCalendarId: "local",
};

export function getCalendarSettings(): CalendarSettings {
  try {
    const raw = localStorage.getItem(scopedKey(CAL_KEY));
    if (!raw) return { ...CAL_DEFAULTS };
    return { ...CAL_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...CAL_DEFAULTS };
  }
}

export function saveCalendarSettings(patch: Partial<CalendarSettings>): CalendarSettings {
  const next = { ...getCalendarSettings(), ...patch };
  localStorage.setItem(scopedKey(CAL_KEY), JSON.stringify(next));
  return next;
}

/** Replace the stored calendar list for the connected account (e.g. after a
 * visibility toggle or a re-discovery). No-op when nothing is connected. */
export function saveAccountCalendars(calendars: CalDavCalendar[]): CalendarSettings {
  const s = getCalendarSettings();
  if (!s.account) return s;
  return saveCalendarSettings({ account: { ...s.account, calendars } });
}

export function hasCalendarAccount(): boolean {
  const s = getCalendarSettings();
  return !!s.account && s.account.calendars.length > 0;
}

// ---------------------------------------------------------------------------
// Mail account (IMAP)
//
// Same shape and the same reasoning as the calendar bucket above: which server,
// which account and which mailboxes exist is *configuration*, and mail itself is
// never stored — the assistant reads it live over IMAP. So it lives here in
// localStorage under its own key rather than in AppSettings, and therefore
// never appears in `CLOUD_SETTING_KEYS`: an account name plus a mailbox list is
// not something to sync to a server that has no business holding it.
//
// The app-specific password is NOT here — it is in `secrets.ts`, read by
// `mail/client.ts` when it builds the op envelope. A `MailAccount` can be
// passed around and serialized freely without carrying a credential.
// ---------------------------------------------------------------------------

/** One mailbox as reported by the IMAP LIST response. */
export interface MailFolder {
  name: string; // full path AS THE SERVER SAID IT — what every command carries
  /** The same name out of IMAP's modified UTF-7, for display only. Optional
   *  because this shape is persisted: an account connected before decoding
   *  existed has folders without one, and they show the raw name until the next
   *  LIST refreshes them. */
  label?: string;
  delimiter: string; // hierarchy separator, usually "/"
  flags: string[]; // \HasNoChildren, \Sent, \Junk …
}

export interface MailAccount {
  provider: "icloud"; // future: "yahoo" | "fastmail" | "generic"
  username: string; // Apple ID
  host: string; // "imap.mail.me.com"
  port: number; // 993
  folders: MailFolder[]; // discovered via LIST, cached
  connectedAt?: string;
}

export interface MailSettings {
  account: MailAccount | null;
}

const MAIL_KEY = "secondbrain.mail";

const MAIL_DEFAULTS: MailSettings = { account: null };

export function getMailSettings(): MailSettings {
  try {
    const raw = localStorage.getItem(scopedKey(MAIL_KEY));
    if (!raw) return { ...MAIL_DEFAULTS };
    return { ...MAIL_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...MAIL_DEFAULTS };
  }
}

export function saveMailSettings(patch: Partial<MailSettings>): MailSettings {
  const next = { ...getMailSettings(), ...patch };
  localStorage.setItem(scopedKey(MAIL_KEY), JSON.stringify(next));
  // Connecting or disconnecting adds or removes a whole page from the sidebar,
  // and that sidebar is rendered by `App` — which has no reason to re-render
  // when a pane inside it writes to localStorage. This is the narrowest thing
  // that closes the gap: one event, one listener, no shared state.
  //
  // The calendar bucket needs no equivalent because it changes nothing outside
  // the pane that writes it.
  window.dispatchEvent(new Event(MAIL_ACCOUNT_EVENT));
  return next;
}

/** Fired when the connected inbox appears or disappears. See `saveMailSettings`. */
export const MAIL_ACCOUNT_EVENT = "sekunda:mail-account";

/**
 * Is an inbox connected? This gates the assistant's mail tools — off, their
 * schemas are never sent, so a user who hasn't connected mail pays nothing for
 * the feature (the same rule web search follows).
 */
export function hasMailAccount(): boolean {
  return !!getMailSettings().account;
}
