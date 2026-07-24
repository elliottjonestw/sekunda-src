// Small date helpers built on date-fns, plus <input> value converters.
//
// This module holds the *active date-fns locale* for the whole app. lib/i18n.ts
// pushes it here whenever the language changes, which is why the helpers below
// keep their one-argument signatures — the ~40 existing call sites don't have to
// thread a locale through. The re-exported `format` is wrapped for the same
// reason: it injects the active locale, so a plain `format(d, "MMMM yyyy")`
// renders Chinese month names without the call site knowing about locales.

import {
  format as dfFormat,
  startOfDay,
  endOfDay,
  startOfWeek as dfStartOfWeek,
  endOfWeek as dfEndOfWeek,
  startOfMonth,
  endOfMonth,
  isSameDay,
  isToday,
  addDays,
} from "date-fns";
import { enUS } from "date-fns/locale";
import type { Locale } from "date-fns";

let activeLocale: Locale = enUS;

/** Set by lib/i18n.ts on init and on every language change. */
export function setDateLocale(locale: Locale): void {
  activeLocale = locale;
  formatters.clear();
}

export function dateLocale(): Locale {
  return activeLocale;
}

/** BCP 47 tag for the active locale, for the Intl.* APIs. */
function localeTag(): string {
  return activeLocale.code ?? "en-US";
}

// Display formatting goes through Intl.DateTimeFormat rather than date-fns
// patterns. A pattern like "MMM d" produces "7月 20" in Chinese where the
// correct form is "7月20日", and "h a" produces "1 下午" instead of "下午1時" —
// Intl knows each locale's actual conventions, so we don't encode them here.
// date-fns is still what decides which day the week starts on.
const formatters = new Map<string, Intl.DateTimeFormat>();

function fmt(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(options);
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(localeTag(), options);
    formatters.set(key, f);
  }
  return f;
}

export { startOfDay, endOfDay, startOfMonth, endOfMonth, isSameDay, isToday };

/** date-fns `format` with the active locale applied. Prefer the named helpers
 * below; use this directly only for one-off patterns. */
export function format(
  date: Date | number,
  pattern: string,
  options?: Parameters<typeof dfFormat>[2],
): string {
  return dfFormat(date, pattern, { locale: activeLocale, ...options });
}

// The week does not start on Sunday everywhere — the locale decides.
export function startOfWeek(d: Date): Date {
  return dfStartOfWeek(d, { locale: activeLocale });
}

export function endOfWeek(d: Date): Date {
  return dfEndOfWeek(d, { locale: activeLocale });
}

export function fmtTime(d: Date): string {
  return fmt({ hour: "numeric", minute: "2-digit" }).format(d);
}

export function fmtDate(d: Date): string {
  return fmt({ year: "numeric", month: "short", day: "numeric" }).format(d);
}

export function fmtDateTime(iso: string | null): string {
  if (!iso) return "";
  return fmt({
    year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  }).format(new Date(iso));
}

/** Day + month only, no year — used for birthdays. */
export function fmtMonthDay(d: Date): string {
  return fmt({ month: "short", day: "numeric" }).format(d);
}

/** Weekday + full date — the Today header. */
export function fmtFullDate(d: Date): string {
  return fmt({ weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(d);
}

/** Month + year — the calendar's month-view title. */
export function fmtMonthYear(d: Date): string {
  return fmt({ year: "numeric", month: "long" }).format(d);
}

/** Hour-of-day label for the calendar's time gutter. */
export function fmtHour(hour: number): string {
  return fmt({ hour: "numeric" }).format(new Date(2020, 0, 1, hour));
}

/** Short weekday name for one date, e.g. "Mon" / "週一". */
export function fmtWeekdayShort(d: Date): string {
  return fmt({ weekday: "short" }).format(d);
}

/** Short weekday names in locale order, starting on the locale's first day. */
export function weekdayNames(): string[] {
  const start = startOfWeek(new Date());
  return Array.from({ length: 7 }, (_, i) => fmtWeekdayShort(addDays(start, i)));
}

/** "today" / "tomorrow" / "in 5 days", localized. */
export function fmtRelativeDays(days: number): string {
  const rtf = new Intl.RelativeTimeFormat(localeTag(), { numeric: "auto" });
  return rtf.format(days, "day");
}

/**
 * A price in its own currency, formatted for the active locale.
 *
 * Not every listing is quoted in dollars — Tencent comes back in HKD, the FTSE
 * in GBp — so the currency is whatever the quote service reported and Intl
 * decides where the symbol goes and how the digits group. An empty `currency`
 * means the number isn't money at all (an index level), and renders bare.
 */
export function fmtPrice(value: number, currency: string): string {
  const digits = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  if (!currency) return new Intl.NumberFormat(localeTag(), digits).format(value);
  try {
    return new Intl.NumberFormat(localeTag(), { style: "currency", currency, ...digits }).format(value);
  } catch {
    // An unrecognised currency code throws, and this renders inside a card —
    // a bad code must cost the symbol, not the whole tile.
    return new Intl.NumberFormat(localeTag(), digits).format(value);
  }
}

/** "+1.24%" / "−0.38%" — always signed, because the sign is the whole point. */
export function fmtChangePercent(percent: number): string {
  return new Intl.NumberFormat(localeTag(), {
    style: "percent",
    signDisplay: "exceptZero",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(percent / 100);
}

/**
 * A byte count, at the scale a person reads it: "812 KB", "3.4 MB".
 *
 * Decimal units, not binary — an attachment's size is what a mail client and a
 * file manager show, and both of those count in thousands. Locale-aware for the
 * decimal separator; the unit itself is not translated because "KB" and "MB"
 * are written the same way everywhere this app runs.
 */
export function fmtBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = Math.max(bytes, 0);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  // No decimal on bytes (there are none) or once past a hundred, where a tenth
  // of a megabyte is noise.
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${new Intl.NumberFormat(localeTag(), { maximumFractionDigits: digits }).format(value)} ${units[unit]}`;
}

/** Date -> value for <input type="datetime-local"> (local time, no seconds). */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** value from <input type="datetime-local"> -> ISO string. */
export function fromLocalInput(v: string): string {
  return new Date(v).toISOString();
}

/** Date -> value for <input type="date">. */
export function toDateInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parsed `yyyy-mm-dd` birthday. `year` is null for a vCard date with no year
 *  (`--05-14`), which is legal and means "we know the day, not the age".
 *  Exported so the People read-only label and the age/next-birthday helpers
 *  below share one parser — two parsers would inevitably drift on edge cases. */
export function parseBirthday(value: string): { year: number | null; month: number; day: number } | null {
  // `-` as the year is vCard's "unknown year" marker, giving `--05-14`.
  const m = /^(\d{4}|-)-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year: m[1] === "-" ? null : Number(m[1]), month, day };
}

/**
 * Age in whole years, or null when the birthday has no year or lies in the
 * future. Deliberately locale-free and computed here rather than anywhere it's
 * displayed: `ai.ts` feeds this to the model, which otherwise does the
 * subtraction itself and reaches for the year its training data ended in.
 */
export function ageFromBirthday(value: string, now: Date = new Date()): number | null {
  const b = parseBirthday(value);
  if (!b || b.year === null) return null;
  let age = now.getFullYear() - b.year;
  // Not yet had this year's birthday.
  if (now.getMonth() + 1 < b.month || (now.getMonth() + 1 === b.month && now.getDate() < b.day)) age--;
  return age >= 0 ? age : null;
}

/** The next occurrence of a birthday as `yyyy-mm-dd`, or null if unparseable.
 *  Works without a birth year — only the month/day matter. */
export function nextBirthday(value: string, now: Date = new Date()): string | null {
  const b = parseBirthday(value);
  if (!b) return null;
  let year = now.getFullYear();
  const thisYear = new Date(year, b.month - 1, b.day);
  if (startOfDay(thisYear) < startOfDay(now)) year++;
  return toDateInput(new Date(year, b.month - 1, b.day));
}

export function isOverdue(iso: string | null): boolean {
  if (!iso) return false;
  return new Date(iso).getTime() < Date.now();
}
