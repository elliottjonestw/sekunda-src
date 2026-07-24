// Weather for the Today page, from Open-Meteo.
//
// Chosen because it needs no account, no API key and no registration — the app
// stays something you can build and run without signing up to anything, which
// is the same reason there's no backend. Free for non-commercial use under
// CC-BY-4.0; the attribution lives in Settings and the README.
//
// Like connected calendars, forecasts are NEVER written to SQLite. They're
// fetched live and cached in localStorage for a few minutes — a forecast is
// stale within the hour, so persisting it would only mean showing yesterday's
// weather with confidence. Failures are soft: no network means no tile, never
// an error banner over the rest of the day.
//
// Requests go through tauri-plugin-http's fetch (runs in Rust) — the webview's
// own fetch is blocked by CORS from tauri://, and both hosts are scoped in
// capabilities/default.json.

import { httpFetch as fetch } from "./httpFetch";
import { scopedCacheKey } from "./settings";
import type { TemperatureUnit, WeatherLocation } from "./settings";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
// Same platform, same keyless terms, different service.
const AIR_QUALITY_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";

/**
 * How far either side of today Open-Meteo will serve. It reports the exact
 * window in its error text (~92 days back, ~15 forward) and these stay just
 * inside it, so an out-of-range day hides the tile instead of spending a
 * request to be told no.
 */
const MAX_PAST_DAYS = 90;
const MAX_FUTURE_DAYS = 14;

/** Long enough that stepping around the week is free, short enough to stay true. */
const CACHE_TTL_MS = 30 * 60 * 1000;
// Versioned: the cached object is DayWeather, so a build that changes that
// shape must retire what earlier builds wrote rather than read it back.
const CACHE_KEY = "secondbrain.weather.v2";
const CACHE_MAX = 20;

/** One hour of the day, for the strip across the card. */
export interface HourWeather {
  /** Local ISO timestamp as the service returned it. */
  time: string;
  temp: number;
  code: number;
  /** Chance of precipitation, 0–100, or null if the service didn't say. */
  precipitation: number | null;
}

/**
 * The `hourly` block from Open-Meteo: parallel arrays indexed alike. Typed
 * loosely (values may be the wrong type or absent on a malformed reply) so the
 * parser still has to guard each read — replacing the `any` this used to be
 * without pretending the service's output is cleaner than it is.
 */
interface HourlyPayload {
  time?: unknown[];
  temperature_2m?: unknown[];
  weather_code?: unknown[];
  precipitation_probability?: unknown[];
}

/** One day's forecast, already unit-converted by the service. */
export interface DayWeather {
  /** WMO code — pass to `weatherIconKey` / `weatherLabelKey`. */
  code: number;
  high: number;
  low: number;
  /** Chance of precipitation, 0–100, or null if the service didn't say. */
  precipitation: number | null;
  /** Temperature right now. Only meaningful for today, so null on other days. */
  now: number | null;
  /**
   * What it feels like: the current apparent temperature on today, the day's
   * apparent high on any other. Humidity and wind can put this 7°C above the
   * air temperature, which is the number that actually describes going outside.
   */
  feelsLike: number | null;
  /** "°C" / "°F", as reported by the service rather than assumed. */
  unit: string;
  /** Relative humidity now, 0–100. Today only — `current` has no other meaning. */
  humidity: number | null;
  /** Wind now on today, the day's max otherwise. */
  wind: number | null;
  /** "km/h" / "mph", as reported. */
  windUnit: string;
  /** Daily maximum UV index. Available for every day, unlike the `current` block. */
  uvIndex: number | null;
  sunrise: string | null;
  sunset: string | null;
  /** The rest of the day, hour by hour. Empty if the service didn't return it. */
  hours: HourWeather[];
  /** Air quality now, from a separate endpoint. Today only, and null if it failed. */
  air: AirQuality | null;
}

/** Current air quality. US AQI because its categories are the widely-known ones. */
export interface AirQuality {
  usAqi: number;
  pm25: number | null;
}

/**
 * US AQI band. Thresholds are the EPA's published breakpoints; `label` is a
 * `weather.aqi.*` translation key and `tone` is a Tailwind text colour.
 */
export function aqiBand(usAqi: number): { label: string; tone: string } {
  if (usAqi <= 50) return { label: "good", tone: "text-green-600" };
  if (usAqi <= 100) return { label: "moderate", tone: "text-yellow-600" };
  if (usAqi <= 150) return { label: "sensitive", tone: "text-orange-500" };
  if (usAqi <= 200) return { label: "unhealthy", tone: "text-red-500" };
  if (usAqi <= 300) return { label: "veryUnhealthy", tone: "text-purple-500" };
  return { label: "hazardous", tone: "text-rose-800" };
}

/** A geocoding hit, for the Settings place picker. */
export interface PlaceResult extends WeatherLocation {
  /** Distinguishes the several "Springfield"s a search returns. */
  admin: string | null;
}

/** yyyy-MM-dd in *local* time. `toISOString` would shift the day westward. */
function isoDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Whole days from today to `day`, both taken at local midnight. */
function dayOffset(day: Date): number {
  const at = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((at(day) - at(new Date())) / 86400000);
}

/** Is there a forecast to be had for this day at all? */
export function isForecastable(day: Date): boolean {
  const offset = dayOffset(day);
  return offset >= -MAX_PAST_DAYS && offset <= MAX_FUTURE_DAYS;
}

// --- Cache -------------------------------------------------------------------
// Keyed by place + day + unit. Entries carry their own timestamp, so a stale one
// is simply a miss rather than something to sweep.

interface CacheEntry { at: number; data: DayWeather }

function cacheKey(loc: WeatherLocation, day: Date, unit: TemperatureUnit): string {
  // Coordinates rounded to ~1km: re-picking the same city from the geocoder can
  // return a slightly different centroid, which shouldn't cost a fresh request.
  return `${loc.latitude.toFixed(2)},${loc.longitude.toFixed(2)}|${isoDay(day)}|${unit}`;
}

/**
 * Is this a cached entry of the shape the app currently renders?
 *
 * A cache written by an older build outlives the code that wrote it: adding
 * `hours` to DayWeather meant every unexpired entry came back without one, and
 * the card crashed reading `.length` off it. The key is versioned to retire the
 * old blob, and this check means the *next* shape change degrades to a refetch
 * instead of a crash, whether or not someone remembers to bump the version.
 */
function isCurrentShape(entry: unknown): entry is CacheEntry {
  const data = (entry as CacheEntry)?.data as Partial<DayWeather> | undefined;
  return (
    typeof (entry as CacheEntry)?.at === "number" &&
    !!data &&
    typeof data.code === "number" &&
    typeof data.high === "number" &&
    typeof data.low === "number" &&
    Array.isArray(data.hours)
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

function writeCache(key: string, data: DayWeather): void {
  try {
    const cache = readCache();
    delete cache[key]; // re-insert at the end so the oldest untouched entry ages out
    cache[key] = { at: Date.now(), data };
    const keys = Object.keys(cache);
    for (const k of keys.slice(0, Math.max(0, keys.length - CACHE_MAX))) delete cache[k];
    localStorage.setItem(scopedCacheKey(CACHE_KEY), JSON.stringify(cache));
  } catch {
    /* the cache is an optimisation, never a failure */
  }
}

// --- Fetching ----------------------------------------------------------------

/** First element of an Open-Meteo daily array, as a number or null. */
function firstNumber(arr: unknown): number | null {
  const v = Array.isArray(arr) ? arr[0] : null;
  return typeof v === "number" ? v : null;
}

function firstString(arr: unknown): string | null {
  const v = Array.isArray(arr) ? arr[0] : null;
  return typeof v === "string" ? v : null;
}

/**
 * The forecast for one day at one place, or null if there isn't one to be had
 * (day outside the served window, or the service is unreachable).
 *
 * Never throws: the tile is an enhancement on a page that works without it.
 */
export async function getDayWeather(
  loc: WeatherLocation,
  day: Date,
  unit: TemperatureUnit,
  signal?: AbortSignal,
): Promise<DayWeather | null> {
  if (!isForecastable(day)) return null;

  const key = cacheKey(loc, day, unit);
  const hit = readCache()[key];
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const date = isoDay(day);
  const isToday = dayOffset(day) === 0;
  // Wind follows the temperature unit: whoever wants °F wants mph.
  const windUnit = unit === "fahrenheit" ? "mph" : "kmh";
  const params = new URLSearchParams({
    latitude: String(loc.latitude),
    longitude: String(loc.longitude),
    daily: "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max," +
      "precipitation_probability_max,wind_speed_10m_max,uv_index_max,sunrise,sunset",
    hourly: "temperature_2m,weather_code,precipitation_probability",
    current: "temperature_2m,weather_code,apparent_temperature,relative_humidity_2m,wind_speed_10m",
    // The service buckets days in the *location's* timezone, which is what makes
    // "the high on Friday" mean the same thing there as it does on the tile.
    timezone: "auto",
    temperature_unit: unit,
    wind_speed_unit: windUnit,
    start_date: date,
    end_date: date,
  });

  try {
    // Air quality is a different service on the same platform, so it's a second
    // request — fired alongside, and allowed to fail on its own. `current` only
    // describes now, so it's today's card or nothing.
    const [res, air] = await Promise.all([
      fetch(`${FORECAST_URL}?${params}`, { method: "GET", signal }),
      isToday ? getAirQuality(loc, signal) : Promise.resolve(null),
    ]);
    if (!res.ok) return null;
    const data = await res.json();
    // Open-Meteo reports refusals as 200 + `{ error: true, reason }`.
    if (data?.error) return null;

    const code = firstNumber(data?.daily?.weather_code);
    const high = firstNumber(data?.daily?.temperature_2m_max);
    const low = firstNumber(data?.daily?.temperature_2m_min);
    // A day with no code or no temperatures has nothing to show; treat it as a
    // miss rather than rendering a tile full of blanks.
    if (code === null || high === null || low === null) return null;

    // The location's UTC offset, as the service reports it. The hourly strings
    // are location-local (timezone=auto), so trimming "the rest of today" must
    // compare against the location's clock — `new Date().getHours()` would be
    // the device's hour, which is a different day for anyone viewing weather
    // away from home.
    const offset = typeof data?.utc_offset_seconds === "number" ? data.utc_offset_seconds : 0;

    const currentNumber = (field: string): number | null =>
      isToday && typeof data?.current?.[field] === "number" ? data.current[field] : null;

    const out: DayWeather = {
      code,
      high,
      low,
      precipitation: firstNumber(data?.daily?.precipitation_probability_max),
      // "Now" only means something on today's tile.
      now: currentNumber("temperature_2m"),
      // Today knows what it feels like right now; other days only have the
      // day's apparent high, which is the honest stand-in.
      feelsLike: currentNumber("apparent_temperature")
        ?? firstNumber(data?.daily?.apparent_temperature_max),
      unit: typeof data?.daily_units?.temperature_2m_max === "string"
        ? data.daily_units.temperature_2m_max
        : "°",
      humidity: currentNumber("relative_humidity_2m"),
      wind: currentNumber("wind_speed_10m") ?? firstNumber(data?.daily?.wind_speed_10m_max),
      windUnit: typeof data?.daily_units?.wind_speed_10m_max === "string"
        ? data.daily_units.wind_speed_10m_max
        : "km/h",
      uvIndex: firstNumber(data?.daily?.uv_index_max),
      sunrise: firstString(data?.daily?.sunrise),
      sunset: firstString(data?.daily?.sunset),
      hours: parseHours(data?.hourly, isToday, offset),
      air,
    };
    writeCache(key, out);
    return out;
  } catch {
    return null; // offline, aborted, or the service is having a day
  }
}

/**
 * The hourly arrays as a list, trimmed to what's still ahead.
 *
 * On today that means from the current hour on — hours that have already
 * happened are history, not forecast. On any other day the whole day is ahead,
 * so it starts at the beginning.
 */
function parseHours(hourly: HourlyPayload, isToday: boolean, offsetSeconds = 0): HourWeather[] {
  const times: unknown = hourly?.time;
  if (!Array.isArray(times)) return [];
  const out: HourWeather[] = [];
  for (let i = 0; i < times.length; i++) {
    const time = times[i];
    if (typeof time !== "string") continue;
    const temp = hourly?.temperature_2m?.[i];
    const code = hourly?.weather_code?.[i];
    if (typeof temp !== "number" || typeof code !== "number") continue;
    const p = hourly?.precipitation_probability?.[i];
    out.push({ time, temp, code, precipitation: typeof p === "number" ? p : null });
  }
  if (!isToday) return out;
  // The strings are local wall-clock ("2026-07-21T15:00") for the *location*,
  // so the cutoff hour is the location's, not the device's: UTC now, shifted by
  // the offset the service returned, floored to [0,24) for the date wrap.
  const nowUtcHour = (Math.floor(Date.now() / 3600000) + offsetSeconds / 3600) % 24;
  return out.filter((h) => Number(h.time.slice(11, 13)) >= nowUtcHour);
}

/**
 * Current air quality, or null if it's unavailable. Never throws, for the same
 * reason the forecast doesn't: this decorates a card that must still render.
 */
async function getAirQuality(loc: WeatherLocation, signal?: AbortSignal): Promise<AirQuality | null> {
  const params = new URLSearchParams({
    latitude: String(loc.latitude),
    longitude: String(loc.longitude),
    current: "pm2_5,us_aqi",
    timezone: "auto",
  });
  try {
    const res = await fetch(`${AIR_QUALITY_URL}?${params}`, { method: "GET", signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.error) return null;
    const usAqi = data?.current?.us_aqi;
    if (typeof usAqi !== "number") return null;
    const pm25 = data?.current?.pm2_5;
    return { usAqi, pm25: typeof pm25 === "number" ? pm25 : null };
  } catch {
    return null;
  }
}

/**
 * Places matching a typed query, for the Settings picker. Throws on failure —
 * unlike the tile, a search box that silently returns nothing is a bug the user
 * can't tell apart from "no such place".
 */
export async function searchPlaces(
  query: string,
  language: string,
  signal?: AbortSignal,
): Promise<PlaceResult[]> {
  const name = query.trim();
  if (!name) return [];
  const params = new URLSearchParams({
    name,
    count: "8",
    // Returns localized place names where the service has them.
    language,
    format: "json",
  });
  const res = await fetch(`${GEOCODING_URL}?${params}`, { method: "GET", signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  return results
    .filter((r: any) => typeof r?.latitude === "number" && typeof r?.longitude === "number")
    .map((r: any) => ({
      name: typeof r.name === "string" ? r.name : "",
      country: typeof r.country === "string" ? r.country : "",
      // admin1 is the state/province — the only thing separating the
      // Springfields from each other.
      admin: typeof r.admin1 === "string" ? r.admin1 : null,
      latitude: r.latitude,
      longitude: r.longitude,
    }));
}

// --- WMO weather codes -------------------------------------------------------
// The service reports conditions as WMO 4677 codes. Grouped here into the
// handful of distinctions worth drawing on a dashboard tile: "light drizzle"
// and "moderate drizzle" get one icon and one label between them.

/** Icon name from `lucide-react`, resolved to a component by the tile. */
export type WeatherIcon =
  | "sun" | "cloud-sun" | "cloud" | "cloud-fog" | "cloud-drizzle"
  | "cloud-rain" | "cloud-snow" | "cloud-lightning";

interface WeatherCondition {
  icon: WeatherIcon;
  /** Suffix of a `weather.conditions.*` translation key. */
  label: string;
}

/** Ranges are inclusive on both ends; first match wins. */
const CONDITIONS: { from: number; to: number; condition: WeatherCondition }[] = [
  { from: 0, to: 0, condition: { icon: "sun", label: "clear" } },
  { from: 1, to: 1, condition: { icon: "sun", label: "mainlyClear" } },
  { from: 2, to: 2, condition: { icon: "cloud-sun", label: "partlyCloudy" } },
  { from: 3, to: 3, condition: { icon: "cloud", label: "overcast" } },
  { from: 45, to: 48, condition: { icon: "cloud-fog", label: "fog" } },
  { from: 51, to: 55, condition: { icon: "cloud-drizzle", label: "drizzle" } },
  { from: 56, to: 57, condition: { icon: "cloud-drizzle", label: "freezingDrizzle" } },
  { from: 61, to: 65, condition: { icon: "cloud-rain", label: "rain" } },
  { from: 66, to: 67, condition: { icon: "cloud-rain", label: "freezingRain" } },
  { from: 71, to: 75, condition: { icon: "cloud-snow", label: "snow" } },
  { from: 77, to: 77, condition: { icon: "cloud-snow", label: "snowGrains" } },
  { from: 80, to: 82, condition: { icon: "cloud-rain", label: "rainShowers" } },
  { from: 85, to: 86, condition: { icon: "cloud-snow", label: "snowShowers" } },
  { from: 95, to: 95, condition: { icon: "cloud-lightning", label: "thunderstorm" } },
  { from: 96, to: 99, condition: { icon: "cloud-lightning", label: "thunderstormHail" } },
];

const UNKNOWN_CONDITION: WeatherCondition = { icon: "cloud", label: "unknown" };

/** Icon + label key for a WMO code. Unrecognised codes degrade to a plain cloud. */
export function weatherCondition(code: number): WeatherCondition {
  return CONDITIONS.find((c) => code >= c.from && code <= c.to)?.condition ?? UNKNOWN_CONDITION;
}

/**
 * English condition text for the AI day summary. Deliberately not `t()` — like
 * every other string in `ai.ts`, what the model reads stays English regardless
 * of the UI language.
 */
const ENGLISH_CONDITIONS: Record<string, string> = {
  clear: "clear sky",
  mainlyClear: "mainly clear",
  partlyCloudy: "partly cloudy",
  overcast: "overcast",
  fog: "fog",
  drizzle: "drizzle",
  freezingDrizzle: "freezing drizzle",
  rain: "rain",
  freezingRain: "freezing rain",
  snow: "snow",
  snowGrains: "snow grains",
  rainShowers: "rain showers",
  snowShowers: "snow showers",
  thunderstorm: "thunderstorm",
  thunderstormHail: "thunderstorm with hail",
  unknown: "unsettled",
};

export function englishCondition(code: number): string {
  return ENGLISH_CONDITIONS[weatherCondition(code).label] ?? ENGLISH_CONDITIONS.unknown;
}
