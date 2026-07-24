// Recurrence expansion via the `rrule` package (RFC 5545). We never hand-roll
// recurrence math. Given an event and a visible date window, produce concrete
// occurrences for the calendar to render.
//
// This is the *local* calendar's expansion path: local events store a plain
// absolute DTSTART with no TZID to resolve. Remote (CalDAV) events carry their
// own VTIMEZONE and are expanded by ical.js instead — see lib/caldav/ical.ts.

import { rrulestr } from "rrule";
import i18next from "i18next";
import type { UnifiedEvent, EventOccurrence } from "../types";
import { exdateMatches } from "./exdate";

function normalizeRule(rrule: string): string {
  return rrule.startsWith("RRULE:") || rrule.startsWith("DTSTART")
    ? rrule
    : `RRULE:${rrule}`;
}

/**
 * Expand one event into occurrences overlapping [windowStart, windowEnd].
 * Non-recurring events yield 0 or 1 occurrence.
 */
export function expandEvent(
  ev: UnifiedEvent,
  windowStart: Date,
  windowEnd: Date,
): EventOccurrence[] {
  const start = new Date(ev.dtstart);
  const durationMs =
    ev.dtend && ev.dtend !== "" ? new Date(ev.dtend).getTime() - start.getTime() : 0;

  const exdates: Date[] = ev.exdates ? JSON.parse(ev.exdates).map((d: string) => new Date(d)) : [];

  if (!ev.rrule) {
    const end = ev.dtend ? new Date(ev.dtend) : null;
    const effectiveEnd = end ?? start;
    if (effectiveEnd >= windowStart && start <= windowEnd) {
      return [{ event: ev, start, end, isRecurringInstance: false }];
    }
    return [];
  }

  let rule;
  try {
    rule = rrulestr(normalizeRule(ev.rrule), { dtstart: start });
  } catch {
    // Malformed rule — fall back to treating it as a single event.
    return [{ event: ev, start, end: ev.dtend ? new Date(ev.dtend) : null, isRecurringInstance: false }];
  }

  // Pad the window so multi-day recurrences that start before the window
  // still appear.
  const padStart = new Date(windowStart.getTime() - Math.max(durationMs, 0));
  const occurrences = rule.between(padStart, windowEnd, true);

  return occurrences
    .filter((occStart) => !exdates.some((ex) => exdateMatches(ex, occStart, ev.all_day === 1)))
    .map((occStart) => {
      const occEnd = durationMs ? new Date(occStart.getTime() + durationMs) : null;
      return {
        event: ev,
        start: occStart,
        end: occEnd,
        isRecurringInstance: true,
      };
    })
    .filter((o) => (o.end ?? o.start) >= windowStart && o.start <= windowEnd);
}

/**
 * The occurrence of a recurring datetime on or after `from` (inclusive).
 *
 * Used to display recurring reminders at their current instance instead of the
 * series' stored base — a daily 8am reminder otherwise shows the day it was
 * created, wrongly flagged overdue. No rule → the base unchanged; a series that
 * has fully ended before `from` → the base as a last resort (so the card is
 * never dateless). Reminders are local, so plain rrule is correct here (unlike
 * remote events, which need ical.js for TZID).
 */
export function nextOccurrenceFrom(baseIso: string | null, rrule: string | null, from: Date): Date | null {
  if (!baseIso) return null;
  const base = new Date(baseIso);
  if (isNaN(base.getTime())) return null;
  if (!rrule) return base;
  try {
    const rule = rrulestr(normalizeRule(rrule), { dtstart: base });
    return rule.after(from, true) ?? base;
  } catch {
    return base;
  }
}

/** Expand many events across a window and sort chronologically. */
export function expandEvents(
  events: UnifiedEvent[],
  windowStart: Date,
  windowEnd: Date,
): EventOccurrence[] {
  return events
    .flatMap((ev) => expandEvent(ev, windowStart, windowEnd))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

// ---------------------------------------------------------------------------
// Repeat presets, shared by the event and reminder editors.
//
// These used to be two near-identical arrays in EventForm and RemindersView,
// which meant every label had to be translated twice and could drift apart.
// ---------------------------------------------------------------------------
export type RrulePresetKey =
  | "recurrence.none" | "recurrence.daily" | "recurrence.weekdays"
  | "recurrence.weekly" | "recurrence.monthly" | "recurrence.yearly";

export interface RrulePreset { key: RrulePresetKey; value: string | null }

export const RRULE_PRESETS: RrulePreset[] = [
  { key: "recurrence.none", value: null },
  { key: "recurrence.daily", value: "FREQ=DAILY" },
  { key: "recurrence.weekdays", value: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" },
  { key: "recurrence.weekly", value: "FREQ=WEEKLY" },
  { key: "recurrence.monthly", value: "FREQ=MONTHLY" },
  { key: "recurrence.yearly", value: "FREQ=YEARLY" },
];

/**
 * Human-readable summary of an RRULE for display in forms.
 *
 * Presets are matched first so the common cases are properly localized. Custom
 * RFC 5545 rules fall through to rrule's own `toText()`, which is English-only:
 * its gettext hook substitutes token by token, and Chinese word order differs
 * enough ("every week on Monday" vs 每週一) that the result reads worse than
 * leaving it in English. Documented as a limitation.
 */
export function describeRrule(rrule: string | null): string {
  const t = i18next.t.bind(i18next);
  if (!rrule) return t("recurrence.none");

  const preset = RRULE_PRESETS.find((p) => p.value === rrule);
  if (preset) return t(preset.key);

  try {
    const rule = rrulestr(normalizeRule(rrule), { dtstart: new Date() });
    return rule.toText().replace(/^\w/, (c) => c.toUpperCase());
  } catch {
    return rrule;
  }
}
