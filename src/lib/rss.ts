// RSS/Atom reading for the Today page's feed card.
//
// TRANSPORT: every platform goes through the Worker's /v1/feed relay — this is
// the one external service where desktop does NOT get a direct path, and the
// difference from `stocks.ts` is worth stating because it looks like an
// oversight otherwise. `tauri-plugin-http` could reach a feed host directly,
// but only if that host is listed in `capabilities/default.json`, and a
// subscription list is by definition not knowable at build time. The only way
// to allow it there is a `https://*` scope, which would hand any XSS in the
// webview a general-purpose HTTP client running outside the browser's origin
// rules. Relaying is the cheaper risk. See worker/src/routes/feed.ts for what
// keeps that route from being an open proxy.
//
// PARSING happens here rather than on the Worker, deliberately. `DOMParser` is
// present in every webview and browser this app targets and has no equivalent
// in Workers, so parsing server-side would mean writing a second XML reader —
// or regexing XML, which is how feeds with CDATA and namespaced elements start
// coming out empty. The relay moves bytes; this file understands them.
//
// STORAGE: same rule as forecasts and quotes — articles are never written to
// the database. They're live data cached in localStorage for half an hour. What
// IS stored server-side is the subscription list itself (`settings.rssFeeds`),
// because that's the user's own configuration and it should follow them.

import { apiRequest } from "./api";
import { scopedCacheKey } from "./settings";

/** One article. Everything the card renders, and nothing else. */
export interface FeedItem {
  /** Feed-provided guid, else the link — used to dedupe across a refresh. */
  id: string;
  title: string;
  /** Absolute http(s) URL of the article, or null if the feed gave none. */
  link: string | null;
  /** Publication instant, or null when the feed omits or mangles it. */
  published: Date | null;
  /** Which subscription this came from, for the card's per-item byline. */
  source: string;
}

/** A fetched feed: its own title, and its articles newest-first. */
export interface Feed {
  title: string;
  items: FeedItem[];
}

/** Half an hour. Feeds update on the order of hours; the card is a glance, not
 *  a live ticker, and every miss is a relayed request. */
const TTL_MS = 30 * 60 * 1000;

// Versioned, because the cached object is a `Feed` and it outlives the code
// that wrote it. Any change to the shapes above retires what earlier builds
// stored instead of reading it back and crashing a render — the trap that
// shipped a TypeError on the weather card. Bump it.
const CACHE_KEY = "secondbrain.rss.v1";

/** How many articles are kept per feed. The card shows fewer; the surplus is
 *  what lets several feeds be merged and still fill the list. */
const MAX_ITEMS_PER_FEED = 30;

// --- Cache -------------------------------------------------------------------

interface CacheEntry { at: number; data: Feed }

/** A `published` date survives JSON as a string; this is the stored form. */
interface StoredItem extends Omit<FeedItem, "published"> { published: string | null }

function isCurrentShape(entry: unknown): entry is { at: number; data: { title: string; items: StoredItem[] } } {
  const data = (entry as CacheEntry)?.data as Partial<Feed> | undefined;
  return (
    typeof (entry as CacheEntry)?.at === "number" &&
    !!data &&
    typeof data.title === "string" &&
    Array.isArray(data.items)
  );
}

function readCache(): Record<string, CacheEntry> {
  try {
    const raw = JSON.parse(localStorage.getItem(scopedCacheKey(CACHE_KEY)) || "null");
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, CacheEntry> = {};
    for (const [url, entry] of Object.entries(raw)) {
      if (!isCurrentShape(entry)) continue;
      out[url] = {
        at: entry.at,
        data: {
          title: entry.data.title,
          // Dates come back as strings; an unparseable one becomes null rather
          // than an Invalid Date that renders as "Invalid Date".
          items: entry.data.items.map((i) => ({ ...i, published: toDate(i.published) })),
        },
      };
    }
    return out;
  } catch {
    return {};
  }
}

function writeCache(url: string, data: Feed): void {
  try {
    const cache = readCache();
    cache[url] = { at: Date.now(), data };
    // Bounded by unsubscribing rather than swept: a feed removed from the list
    // stops being asked for, and its entry goes on the next write.
    const urls = Object.keys(cache);
    for (const u of urls.slice(0, Math.max(0, urls.length - 20))) delete cache[u];
    localStorage.setItem(scopedCacheKey(CACHE_KEY), JSON.stringify(cache));
  } catch {
    /* the cache is an optimisation, never a failure */
  }
}

/** Drop one feed's cached articles, so the next read goes to the network. */
export function invalidateFeed(url: string): void {
  try {
    const cache = readCache();
    delete cache[url];
    localStorage.setItem(scopedCacheKey(CACHE_KEY), JSON.stringify(cache));
  } catch {
    /* nothing to do — a stale entry ages out on its own */
  }
}

// --- Fetching ----------------------------------------------------------------

/**
 * Fetch and parse one feed. Never throws — like `getDayWeather`, this feeds a
 * card that has to degrade quietly rather than take the page with it. A null
 * means "nothing to show for this source right now", which the card reports
 * once for the whole list rather than per feed.
 */
export async function getFeed(url: string, signal?: AbortSignal): Promise<Feed | null> {
  const hit = readCache()[url];
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  try {
    const feed = await fetchFeed(url, signal);
    writeCache(url, feed);
    return feed;
  } catch {
    // A stale entry beats an empty card: a publisher being down for an hour
    // shouldn't blank a list the user was reading five minutes ago.
    return hit?.data ?? null;
  }
}

/**
 * Fetch and parse one feed, THROWING on failure.
 *
 * This is what Settings calls when a feed is added: there, a silent empty
 * result is indistinguishable from "that URL isn't a feed", and the user needs
 * to be told which. Same split as `getDayWeather` vs `searchPlaces`.
 */
export async function fetchFeed(url: string, signal?: AbortSignal): Promise<Feed> {
  const res = await apiRequest<{ content_type: string; body: string }>(
    `/v1/feed?url=${encodeURIComponent(url)}`,
    { signal },
  );
  return parseFeed(res.body, url);
}

/** Reject what can't be a feed URL before spending a request on it. The Worker
 *  checks all of this again — this copy is only so the settings form can say
 *  something useful without a round-trip. */
export function normalizeFeedUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // A bare "example.com/feed" is what people paste; assume https rather than
  // rejecting it. http:// typed explicitly is still refused below.
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

// --- Parsing -----------------------------------------------------------------

/**
 * Parse RSS 2.0, RSS 1.0 (RDF) and Atom into one shape.
 *
 * All three are read with the same `DOMParser` pass rather than sniffed first:
 * the element names barely overlap, so asking for both spellings of each field
 * is shorter than deciding which dialect this is and branching. `getElementsByTagName`
 * is used throughout instead of the namespace-aware variants because feeds in
 * the wild bind these namespaces inconsistently — matching on local name is what
 * actually works.
 */
export function parseFeed(xml: string, url: string): Feed {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  // A parse failure yields a document containing <parsererror> rather than
  // throwing. Usually it means the URL served HTML — a site's home page, or a
  // "subscribe here" landing page — which is the single most common mistake
  // when adding a feed by hand.
  if (doc.getElementsByTagName("parsererror").length) {
    throw new Error("Not a feed");
  }

  const channel = doc.getElementsByTagName("channel")[0] ?? doc.documentElement;
  const source = text(channel, "title") || hostOf(url);

  // RSS calls them <item>, Atom calls them <entry>.
  const nodes = [
    ...Array.from(doc.getElementsByTagName("item")),
    ...Array.from(doc.getElementsByTagName("entry")),
  ];
  if (!nodes.length && !doc.getElementsByTagName("rss").length && !doc.getElementsByTagName("feed").length) {
    // Valid XML that is not a feed at all — an XML sitemap, say.
    throw new Error("Not a feed");
  }

  const items = nodes
    .map((node) => toItem(node, source))
    .filter((i): i is FeedItem => !!i)
    // Newest first. Items with no date sort last rather than to the top, where
    // an undated entry would permanently outrank real news.
    .sort((a, b) => (b.published?.getTime() ?? 0) - (a.published?.getTime() ?? 0))
    .slice(0, MAX_ITEMS_PER_FEED);

  return { title: source, items };
}

function toItem(node: Element, source: string): FeedItem | null {
  const title = text(node, "title");
  const link = linkOf(node);
  // Something has to be clickable or readable; an entry with neither is a row
  // of nothing.
  if (!title && !link) return null;

  return {
    id: text(node, "guid") || text(node, "id") || link || title,
    title: title || link || "",
    link,
    published: toDate(
      text(node, "pubDate") || text(node, "published") || text(node, "updated") || text(node, "date"),
    ),
    source,
  };
}

/**
 * The article URL.
 *
 * RSS puts it in the element's text; Atom puts it in a `href` attribute and may
 * offer several `<link>`s, of which only `rel="alternate"` (or no rel at all)
 * is the article — `rel="self"` is the feed's own address, and taking it would
 * point every headline back at the XML.
 */
function linkOf(node: Element): string | null {
  for (const el of Array.from(node.getElementsByTagName("link"))) {
    const rel = el.getAttribute("rel");
    if (rel && rel !== "alternate") continue;
    const href = el.getAttribute("href")?.trim() || el.textContent?.trim();
    if (href && isHttpUrl(href)) return href;
  }
  return null;
}

/** Only http(s) is ever handed to the opener. A feed is third-party content,
 *  so a `javascript:` or `file:` href is not something to pass along. */
function isHttpUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** First matching child's trimmed text, by local name. */
function text(parent: Element, name: string): string {
  const el = parent.getElementsByTagName(name)[0];
  return el?.textContent?.trim() ?? "";
}

/** RFC 822 (RSS) and ISO 8601 (Atom) are both what `Date` already parses; the
 *  work here is refusing everything else rather than passing an Invalid Date
 *  into a formatter. */
function toDate(raw: string | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "news.ycombinator.com" — the fallback name for a feed with no title. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Merge several feeds into one list, newest first.
 *
 * Deduped by id and by link: the same story syndicated to two feeds a user
 * subscribes to is one row, not two.
 */
export function mergeFeeds(feeds: (Feed | null)[], limit: number): FeedItem[] {
  const seen = new Set<string>();
  const out: FeedItem[] = [];

  for (const item of feeds.flatMap((f) => f?.items ?? [])) {
    const key = item.link || item.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out
    .sort((a, b) => (b.published?.getTime() ?? 0) - (a.published?.getTime() ?? 0))
    .slice(0, limit);
}
