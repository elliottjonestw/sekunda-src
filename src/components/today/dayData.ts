// Shared day data for widgets that fetch their own.
//
// Each widget owns its loading, but several want the same rows: the schedule
// and the summary both need the day's events, the due card and the summary both
// need events and reminders. Routing every read through one promise cache means
// "widgets fetch independently" doesn't turn into "the page runs the same query
// five times" — the second caller joins the first request rather than starting
// another.
//
// The cache is in memory and per-revision, so it never serves data older than
// the last mutation. Nothing here is persisted: `weather.ts` has its own
// localStorage cache because forecasts are worth keeping between launches;
// local SQLite rows are not.

import type { EventOccurrence, ReminderRow, NoteRow, PersonRow } from "../../types";
import { listReminders, listNotes, listPeople } from "../../db";
import { getOccurrences } from "../../lib/calendars";
import { startOfDay, endOfDay } from "../../lib/format";
import { getDayWeather, type DayWeather } from "../../lib/weather";
import { getQuotes, type Quote } from "../../lib/stocks";
import { getFeed, mergeFeeds, type FeedItem } from "../../lib/rss";
import {
  getSettings, clampRssItemCount,
  type WeatherLocation, type TemperatureUnit, type StockSymbol, type RssFeed,
} from "../../lib/settings";

let cacheRevision = -1;
const cache = new Map<string, Promise<unknown>>();

/**
 * A revision number nobody has used before.
 *
 * Monotonic across the module, NOT per-mount: `useState(0)` on every mount
 * would match a `cacheRevision` left at 0 by an earlier visit, and the page
 * would serve rows cached before the user went away and edited them. Taking a
 * fresh number on mount makes returning to Today always a cache miss.
 */
let revisionCounter = 0;
export function nextRevision(): number {
  return ++revisionCounter;
}

/**
 * Join an in-flight request for the same thing, or start one.
 *
 * A change in `revision` (any mutation on the page) drops everything: the
 * alternative is a widget rendering the row it just deleted.
 */
function cached<T>(revision: number, key: string, load: () => Promise<T>): Promise<T> {
  if (revision !== cacheRevision) {
    cache.clear();
    cacheRevision = revision;
  }
  const hit = cache.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const pending = load();
  cache.set(key, pending);
  // A rejected promise must not be cached, or the failure is permanent until
  // the next mutation — every retry would be handed the same dead result.
  pending.catch(() => { if (cache.get(key) === pending) cache.delete(key); });
  return pending;
}

/** `yyyy-MM-dd` local, for cache keys. Matches the day the user is looking at. */
function dayKey(day: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/**
 * The day's events, from every visible calendar.
 *
 * `getOccurrences` fails soft — an unreachable CalDAV server yields errors
 * alongside whatever did load, so a dead iCloud can't empty the local calendar.
 */
export function loadEvents(day: Date, revision: number): Promise<EventOccurrence[]> {
  return cached(revision, `events|${dayKey(day)}`, async () => {
    const { occurrences } = await getOccurrences(startOfDay(day), endOfDay(day));
    return occurrences;
  });
}

// These aren't day-scoped — the widgets filter them — so they key on revision
// alone and are shared across every day the user steps to.
export function loadReminders(revision: number): Promise<ReminderRow[]> {
  return cached(revision, "reminders", listReminders);
}

export function loadNotes(revision: number): Promise<NoteRow[]> {
  return cached(revision, "notes", listNotes);
}

export function loadPeople(revision: number): Promise<PersonRow[]> {
  return cached(revision, "people", listPeople);
}

/** The configured weather location, or null when the feature is off. */
export function weatherLocation(): WeatherLocation | null {
  return getSettings().weatherLocation;
}

export function temperatureUnit(): TemperatureUnit {
  return getSettings().temperatureUnit;
}

/**
 * The day's forecast, shared between the weather card and the summary.
 *
 * Both want it, and on a cold start they ask at the same moment — without this
 * they'd fire two identical requests before either could populate the
 * localStorage cache in `weather.ts`.
 */
export function loadWeather(
  loc: WeatherLocation,
  day: Date,
  unit: TemperatureUnit,
  revision: number,
): Promise<DayWeather | null> {
  const key = `weather|${dayKey(day)}|${loc.latitude.toFixed(2)},${loc.longitude.toFixed(2)}|${unit}`;
  return cached(revision, key, () => getDayWeather(loc, day, unit));
}

/** The configured watchlist, or empty when the ticker is off. */
export function watchlist(): StockSymbol[] {
  return getSettings().watchlist;
}

/**
 * Quotes for the watchlist.
 *
 * No day in the key: a quote only ever describes now, which is also why the
 * card hides itself on any day but today. The symbols are in the key so
 * editing the list in Settings and coming back is a miss rather than a stale
 * row for a ticker that's no longer on it.
 */
export function loadQuotes(symbols: StockSymbol[], revision: number): Promise<(Quote | null)[]> {
  const key = `stocks|${symbols.map((s) => s.symbol).join(",")}`;
  return cached(revision, key, () => getQuotes(symbols));
}

/** The subscribed feeds, or empty when the card is off. Cloud-synced, but read
 *  synchronously from the local copy like every other setting. */
export function rssFeeds(): RssFeed[] {
  return getSettings().rssFeeds;
}

export function rssItemCount(): number {
  return clampRssItemCount(getSettings().rssItemCount);
}

/**
 * Articles from every subscribed feed, merged newest-first.
 *
 * No day in the key, for the same reason quotes have none: a feed describes now
 * — which is also why the card hides itself on any day but today. The URLs are
 * in the key so subscribing to something in Settings and coming back is a miss
 * rather than a list missing the feed just added.
 *
 * Each feed settles on its own inside `getFeed`, which never throws: one dead
 * publisher costs its own rows, not the card.
 */
export function loadFeedItems(feeds: RssFeed[], revision: number): Promise<FeedItem[]> {
  const key = `rss|${feeds.map((f) => f.url).join(",")}`;
  return cached(revision, key, async () => {
    const loaded = await Promise.all(feeds.map((f) => getFeed(f.url)));
    return mergeFeeds(loaded, rssItemCount());
  });
}
