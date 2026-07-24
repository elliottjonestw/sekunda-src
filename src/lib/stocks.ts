// Stock quotes for the Today page's ticker.
//
// Every keyless-and-documented option was checked and none exists: Stooq (the
// closest analogue to Open-Meteo — plain CSV, no account) now sits behind a
// JavaScript proof-of-work challenge, and Alpha Vantage, Finnhub, Twelve Data,
// marketstack and FMP all want a registered key. Yahoo's chart endpoint is the
// one thing that still answers an anonymous request, so that's what this uses.
//
// It is NOT a public API, and that's the difference from `weather.ts`: there's
// no documentation and no usage grant, so treat it as something that may stop
// working one day rather than a contract. That's why every fetch lives behind
// `getQuote` — the provider is this one file to replace, and the card degrades
// to "unavailable" inside its own boundary instead of taking the page with it.
//
// Same storage rule as forecasts and remote calendar events: quotes are NEVER
// written to SQLite. They're live data cached in localStorage for minutes, and
// a persisted price is just yesterday's number shown confidently.
//
// TWO transports, picked at runtime, because Yahoo sends no CORS headers:
//
//   * In the app, tauri-plugin-http's fetch runs in Rust, outside the browser's
//     origin rules, and calls Yahoo directly. The host is scoped in
//     capabilities/default.json.
//   * On the web that's impossible — the browser refuses before the request
//     leaves — so the call goes through the Worker's narrow /v1/quotes proxy
//     instead. See worker/src/routes/quotes.ts for why that proxy takes a
//     symbol and never a URL.
//
// Desktop deliberately does NOT use the proxy: it doesn't need it, and routing
// it through the Worker would spend request quota to solve a problem that only
// browsers have.

import { httpFetch as fetch } from "./httpFetch";
import { apiRequest } from "./api";
import { isTauri } from "./platform";
import { scopedCacheKey } from "./settings";
import type { StockSymbol } from "./settings";

export type { StockSymbol };

const CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search";

/** Yahoo's chart JSON for one symbol, however it has to be reached. */
async function fetchChart(ticker: string, params: URLSearchParams, signal?: AbortSignal): Promise<any> {
  if (!isTauri()) {
    return apiRequest<any>(`/v1/quotes/chart/${encodeURIComponent(ticker)}?${params}`, { signal });
  }
  const res = await fetch(`${CHART_URL}/${encodeURIComponent(ticker)}?${params}`, {
    method: "GET",
    signal,
  });
  if (!res.ok) return null;
  return res.json();
}

/** Yahoo's symbol search, however it has to be reached. Throws on failure —
 *  unlike quotes, a silent empty result is indistinguishable from "no match". */
async function fetchSearch(q: string, signal?: AbortSignal): Promise<any> {
  if (!isTauri()) {
    return apiRequest<any>(`/v1/quotes/search?q=${encodeURIComponent(q)}`, { signal });
  }
  const params = new URLSearchParams({ q, quotesCount: "8", newsCount: "0" });
  const res = await fetch(`${SEARCH_URL}?${params}`, { method: "GET", signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * How many symbols a watchlist may hold.
 *
 * The batch quote endpoint (`/v7/finance/quote`) now refuses anonymous callers,
 * so this is one request per symbol. The cap is what stops a long watchlist
 * from turning one glance at the Today page into thirty requests.
 */
export const MAX_WATCHLIST = 12;

/** Trading moves; a quote goes stale in minutes. */
const OPEN_TTL_MS = 5 * 60 * 1000;
/**
 * Once the closing bell has gone the number cannot change, so re-asking is pure
 * cost to someone else's server. Still bounded rather than infinite: a stale
 * entry must not survive into the next session's opening.
 */
const CLOSED_TTL_MS = 30 * 60 * 1000;

// Versioned: the cached object is `Quote`, so any change to that shape has to
// retire what earlier builds wrote instead of reading it back and crashing.
const CACHE_KEY = "secondbrain.stocks.v1";

/** Points kept for the sparkline. A day of 5-minute bars is ~78. */
const MAX_POINTS = 120;

/** A search hit from the symbol picker. */
export interface SymbolResult extends StockSymbol {
  /** "NASDAQ", "HKSE" — what separates the several listings of one company. */
  exchange: string;
  /** "EQUITY" / "ETF" / "INDEX" / "CRYPTOCURRENCY". */
  type: string;
}

/** A quote, everything the ticker row renders. */
export interface Quote {
  symbol: string;
  /** Short name from the service; falls back to the symbol. */
  name: string;
  price: number;
  /** Previous session's close — what `change` is measured against. */
  previousClose: number;
  /** Absolute move since the previous close. Negative is a fall. */
  change: number;
  /** The same move as a percentage. */
  changePercent: number;
  /**
   * ISO 4217 code, e.g. "USD". Listings are not all in dollars.
   *
   * Empty for an index: the service reports the S&P as USD, but "$7,443.28" is
   * not what that number is — an index level has no currency. Empty means
   * `fmtPrice` renders it as a plain number.
   */
  currency: string;
  /** Intraday closes for the sparkline, oldest first. May be empty. */
  points: number[];
  /** Is the regular session running right now? Drives the "Closed" marker. */
  marketOpen: boolean;
}

// --- Cache -------------------------------------------------------------------
// Keyed by symbol alone. Unlike the forecast there's no day in the key: a quote
// only ever describes now, which is also why the card hides on other days.

interface CacheEntry { at: number; data: Quote }

/**
 * Is this a cached entry of the shape the app currently renders?
 *
 * A cache outlives the code that wrote it — this is the trap that shipped a
 * `TypeError` on the weather card when `hours` was added to `DayWeather`. The
 * key above is versioned to retire the old blob; this check means the *next*
 * shape change degrades to a refetch whether or not anyone remembers to bump it.
 */
function isCurrentShape(entry: unknown): entry is CacheEntry {
  const data = (entry as CacheEntry)?.data as Partial<Quote> | undefined;
  return (
    typeof (entry as CacheEntry)?.at === "number" &&
    !!data &&
    typeof data.symbol === "string" &&
    typeof data.price === "number" &&
    typeof data.changePercent === "number" &&
    Array.isArray(data.points)
  );
}

function readCache(): Record<string, CacheEntry> {
  try {
    const raw = JSON.parse(localStorage.getItem(scopedCacheKey(CACHE_KEY)) || "null");
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, CacheEntry> = {};
    for (const [k, v] of Object.entries(raw)) if (isCurrentShape(v)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function writeCache(symbol: string, data: Quote): void {
  try {
    const cache = readCache();
    cache[symbol] = { at: Date.now(), data };
    // Bounded by the watchlist cap rather than swept: a symbol dropped from the
    // list stops being asked for, and its entry ages out on the next write.
    const keys = Object.keys(cache);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_WATCHLIST * 2))) delete cache[k];
    localStorage.setItem(scopedCacheKey(CACHE_KEY), JSON.stringify(cache));
  } catch {
    /* the cache is an optimisation, never a failure */
  }
}

/** TTL for an entry, decided by whether the market was open when it was taken. */
function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.at < (entry.data.marketOpen ? OPEN_TTL_MS : CLOSED_TTL_MS);
}

// --- Fetching ----------------------------------------------------------------

/** Symbols are uppercase and space-free; normalising here keeps cache keys aligned. */
export function normalizeSymbol(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * The current quote for one symbol, or null if there isn't one to be had.
 *
 * Never throws, for the same reason `getDayWeather` doesn't: this is an
 * enhancement on a page that has to work without it.
 */
export async function getQuote(symbol: string, signal?: AbortSignal): Promise<Quote | null> {
  const ticker = normalizeSymbol(symbol);
  if (!ticker) return null;

  const hit = readCache()[ticker];
  if (hit && isFresh(hit)) return hit.data;

  // One day of 5-minute bars: the same response carries both the quote fields
  // and the intraday series, so the sparkline costs no extra request.
  const params = new URLSearchParams({ range: "1d", interval: "5m" });

  try {
    const data = await fetchChart(ticker, params, signal);
    if (!data) return null;
    // Refusals come back as `{ chart: { result: null, error: {...} } }`.
    const result = data?.chart?.result?.[0];
    if (!result || data?.chart?.error) return null;

    const quote = parseQuote(ticker, result);
    if (quote) writeCache(ticker, quote);
    return quote;
  } catch {
    return null; // offline, aborted, or the endpoint is having a day
  }
}

/**
 * Quotes for a whole watchlist, in the order given.
 *
 * Each symbol settles on its own — one delisted or misspelt ticker returns null
 * and the rest of the list still renders.
 */
export async function getQuotes(
  symbols: StockSymbol[],
  signal?: AbortSignal,
): Promise<(Quote | null)[]> {
  return Promise.all(symbols.slice(0, MAX_WATCHLIST).map((s) => getQuote(s.symbol, signal)));
}

/** The `meta` + `indicators` blocks as a Quote, or null if the essentials are missing. */
function parseQuote(ticker: string, result: any): Quote | null {
  const meta = result?.meta;
  const price = meta?.regularMarketPrice;
  // `chartPreviousClose` is the one the chart's baseline is drawn from; on some
  // listings it's the only one of the two present.
  const previousClose = meta?.previousClose ?? meta?.chartPreviousClose;
  // Without a price and something to compare it to there's no row to draw —
  // treat it as a miss rather than rendering a line of blanks.
  if (typeof price !== "number" || typeof previousClose !== "number" || previousClose === 0) {
    return null;
  }

  const change = price - previousClose;

  return {
    symbol: typeof meta.symbol === "string" ? meta.symbol : ticker,
    name: typeof meta.shortName === "string" ? meta.shortName
      : typeof meta.longName === "string" ? meta.longName
      : ticker,
    price,
    previousClose,
    change,
    changePercent: (change / previousClose) * 100,
    // An index level is a number, not an amount of money — see `currency`.
    currency: meta.instrumentType === "INDEX" || typeof meta.currency !== "string"
      ? ""
      : meta.currency,
    points: parsePoints(result?.indicators?.quote?.[0]?.close),
    marketOpen: isMarketOpen(meta?.currentTradingPeriod?.regular),
  };
}

/**
 * The intraday close series, gaps removed.
 *
 * The array is padded to the session's full length, so bars that haven't
 * happened yet — and the occasional hole mid-session — come back as null. They
 * have to be dropped rather than zeroed: a zero would rescale the sparkline to
 * run from nothing to the share price and flatten the actual day's movement.
 */
function parsePoints(closes: unknown): number[] {
  if (!Array.isArray(closes)) return [];
  const out = closes.filter((c): c is number => typeof c === "number" && Number.isFinite(c));
  // Keep the most recent stretch if a longer range ever gets requested.
  return out.length > MAX_POINTS ? out.slice(-MAX_POINTS) : out;
}

/** Is now inside the regular session, per the window the service reported? */
function isMarketOpen(regular: unknown): boolean {
  const period = regular as { start?: unknown; end?: unknown } | undefined;
  if (typeof period?.start !== "number" || typeof period?.end !== "number") return false;
  const now = Date.now() / 1000;
  return now >= period.start && now < period.end;
}

/**
 * Symbols matching a typed query, for the Settings picker. Throws on failure —
 * unlike the card, a search box that silently returns nothing is a bug the user
 * can't tell apart from "no such ticker".
 */
export async function searchSymbols(query: string, signal?: AbortSignal): Promise<SymbolResult[]> {
  const q = query.trim();
  if (!q) return [];
  const data = await fetchSearch(q, signal);
  const quotes = Array.isArray(data?.quotes) ? data.quotes : [];

  return quotes
    // The endpoint also returns funds, futures and the odd entry with no ticker
    // at all; anything without a symbol can't be watched.
    .filter((q: any) => typeof q?.symbol === "string" && q.symbol)
    .map((q: any) => ({
      symbol: normalizeSymbol(q.symbol),
      name: typeof q.shortname === "string" ? q.shortname
        : typeof q.longname === "string" ? q.longname
        : q.symbol,
      exchange: typeof q.exchDisp === "string" ? q.exchDisp : "",
      type: typeof q.quoteType === "string" ? q.quoteType : "",
    }));
}

