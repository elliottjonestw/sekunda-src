// VEVENT <-> UnifiedEvent, via ical.js. We never hand-roll iCalendar parsing or
// recurrence (same rule as lib/ics.ts and lib/recurrence.ts).
//
// Why ical.js expansion here rather than the `rrule` path used for local
// events: a remote VEVENT carries its own timezone (DTSTART;TZID=... plus an
// embedded VTIMEZONE). ical.js resolves that to a true absolute instant, so an
// event authored in another zone lands at the right wall-clock time once the
// app renders it in the machine's local zone. Local events have no TZID to
// resolve, so they keep using `rrule`.

import ICAL from "ical.js";
import type { EventOccurrence, UnifiedEvent } from "../../types";
import type { CalDavCalendar } from "../settings";
import { allDayIso, allDayWallDate, nextWallDate } from "../format";

/** Safety cap so a pathological RRULE can't spin forever. */
const MAX_OCCURRENCES = 750;

/**
 * Teach ical.js about the timezones a calendar-data blob defines, so TZID
 * references inside it resolve. Registrations are process-global and keyed by
 * TZID, which is exactly the sharing we want.
 */
function registerTimezones(comp: ICAL.Component): void {
  for (const vt of comp.getAllSubcomponents("vtimezone")) {
    const tzid = vt.getFirstPropertyValue("tzid") as unknown as string | null;
    if (!tzid || ICAL.TimezoneService.has(tzid)) continue;
    try {
      ICAL.TimezoneService.register(new ICAL.Timezone(vt));
    } catch {
      /* a malformed VTIMEZONE shouldn't sink the whole calendar */
    }
  }
}

/** The series master — the VEVENT without a RECURRENCE-ID. */
function masterVevent(comp: ICAL.Component): ICAL.Component | null {
  const vevents = comp.getAllSubcomponents("vevent");
  if (vevents.length === 0) return null;
  return vevents.find((v) => !v.getFirstPropertyValue("recurrence-id")) ?? vevents[0];
}

function readRrule(ve: ICAL.Component): string | null {
  const prop = ve.getFirstPropertyValue("rrule");
  if (!prop) return null;
  const text = String(prop);
  return text.replace(/^RRULE:/i, "") || null;
}

function readExdates(ve: ICAL.Component): string | null {
  const out: string[] = [];
  for (const prop of ve.getAllProperties("exdate")) {
    for (const value of prop.getValues()) {
      const time = value as unknown as ICAL.Time;
      if (typeof time?.toJSDate === "function") out.push(time.toJSDate().toISOString());
    }
  }
  return out.length ? JSON.stringify(out) : null;
}

/**
 * The zone DTSTART was authored in, if it has one worth keeping. All-day
 * (VALUE=DATE), floating and already-UTC times have nothing to preserve.
 */
function readTzid(start: ICAL.Time | null): string | null {
  if (!start || start.isDate) return null;
  const tzid = start.zone?.tzid;
  if (!tzid || tzid === "floating" || tzid === "UTC" || tzid === "Z") return null;
  return tzid;
}

function readCategories(ve: ICAL.Component): string | null {
  const cats = ve.getAllProperties("categories").flatMap((p) => p.getValues() as unknown as string[]);
  return cats.length ? JSON.stringify(cats) : null;
}

/** Build the UnifiedEvent for a remote VEVENT master. */
function toUnified(
  ve: ICAL.Component,
  event: ICAL.Event,
  cal: CalDavCalendar,
  href: string,
  etag: string | undefined,
): UnifiedEvent {
  const allDay = event.startDate?.isDate ?? false;
  return {
    source: "caldav",
    calendarId: cal.id,
    id: event.uid || href,
    href,
    etag,
    color: cal.color,
    summary: event.summary || "(untitled)",
    description: event.description || null,
    location: event.location || null,
    // All-day: keep it a floating wall date so it can't drift across timezones
    // (see lib/format.ts). Timed: a true absolute instant, TZID already resolved.
    dtstart: event.startDate
      ? allDay ? floatingWallDate(event.startDate) : event.startDate.toJSDate().toISOString()
      : new Date().toISOString(),
    dtend: event.endDate
      ? allDay ? floatingWallDate(event.endDate) : event.endDate.toJSDate().toISOString()
      : null,
    tzid: readTzid(event.startDate ?? null),
    all_day: allDay ? 1 : 0,
    rrule: readRrule(ve),
    exdates: readExdates(ve),
    status: (ve.getFirstPropertyValue("status") as unknown as string) || "CONFIRMED",
    categories: readCategories(ve),
  };
}

/**
 * Parse one CalDAV calendar resource and expand it into the occurrences that
 * overlap [windowStart, windowEnd]. Returns [] for anything unparseable — one
 * bad event should never blank out the calendar.
 */
export function expandRemoteEvent(
  calendarData: string,
  href: string,
  etag: string | undefined,
  cal: CalDavCalendar,
  windowStart: Date,
  windowEnd: Date,
): EventOccurrence[] {
  let comp: ICAL.Component;
  try {
    comp = new ICAL.Component(ICAL.parse(calendarData));
  } catch {
    return [];
  }

  registerTimezones(comp);
  const ve = masterVevent(comp);
  if (!ve) return [];

  let event: ICAL.Event;
  try {
    event = new ICAL.Event(ve);
  } catch {
    return [];
  }
  if (!event.startDate) return [];

  const unified = toUnified(ve, event, cal, href, etag);

  if (!event.isRecurring()) {
    const start = event.startDate.toJSDate();
    const end = event.endDate ? event.endDate.toJSDate() : null;
    const effectiveEnd = end ?? start;
    if (effectiveEnd >= windowStart && start <= windowEnd) {
      return [{ event: unified, start, end, isRecurringInstance: false }];
    }
    return [];
  }

  const out: EventOccurrence[] = [];
  try {
    // Start iterating from the series start; ical.js applies EXDATE for us.
    const iterator = event.iterator();
    for (let i = 0; i < MAX_OCCURRENCES; i++) {
      const next = iterator.next();
      if (!next) break;
      const details = event.getOccurrenceDetails(next);
      const start = details.startDate.toJSDate();
      if (start > windowEnd) break;
      const end = details.endDate ? details.endDate.toJSDate() : null;
      if ((end ?? start) >= windowStart) {
        out.push({ event: unified, start, end, isRecurringInstance: true });
      }
    }
    return out;
  } catch {
    // Malformed rule — show the series master rather than dropping the event.
    const start = event.startDate.toJSDate();
    const end = event.endDate ? event.endDate.toJSDate() : null;
    const effectiveEnd = end ?? start;
    if (effectiveEnd >= windowStart && start <= windowEnd) {
      return [{ event: unified, start, end, isRecurringInstance: false }];
    }
    return [];
  }
}

// ---------------------------------------------------------------------------
// Serialization (for PUT)
// ---------------------------------------------------------------------------

/**
 * The zone we can honestly write an event in, or null for "use UTC".
 *
 * RFC 5545 requires the VTIMEZONE definition to travel with any TZID
 * reference, and we don't ship a timezone database — so we can only emit a
 * TZID for a zone that's registered in ICAL.TimezoneService. Reads register
 * every VTIMEZONE they see, so any event we fetched can be written back in its
 * own zone; anything else (a brand-new event, a zone we've never read) falls
 * back to the UTC encoding rather than throwing.
 */
function writableZone(ev: UnifiedEvent): ICAL.Timezone | null {
  if (ev.all_day || !ev.tzid) return null;
  try {
    if (!ICAL.TimezoneService.has(ev.tzid)) return null;
    const zone = ICAL.TimezoneService.get(ev.tzid);
    return zone?.component ? zone : null;
  } catch {
    return null;
  }
}

/**
 * Write a timed property (DTSTART/DTEND/EXDATE) either as the instant in UTC,
 * or — when we have the zone — as wall clock plus TZID. The distinction only
 * matters for recurring events: RFC 5545 expands an RRULE in DTSTART's frame,
 * so a UTC DTSTART pins a 9am weekly series to an instant and drifts it an
 * hour across a DST change, while TZID keeps it at 9am.
 */
function addTimed(
  comp: ICAL.Component,
  name: string,
  d: Date,
  zone: ICAL.Timezone | null,
): void {
  const utc = ICAL.Time.fromJSDate(d, true);
  if (!zone) {
    comp.addPropertyWithValue(name, utc);
    return;
  }
  const prop = comp.addPropertyWithValue(name, utc.convertToZone(zone));
  prop.setParameter("tzid", zone.tzid);
}

/**
 * Render a UnifiedEvent as a one-VEVENT VCALENDAR.
 *
 * Timed events keep the zone they were authored in when we know it (`tzid` +
 * an embedded VTIMEZONE), and otherwise fall back to UTC — unambiguous, and
 * all we can say about an event whose zone we never saw. All-day events are
 * written as VALUE=DATE.
 */
export function buildCalendarData(ev: UnifiedEvent): string {
  const vcal = new ICAL.Component("vcalendar");
  vcal.addPropertyWithValue("version", "2.0");
  vcal.addPropertyWithValue("prodid", "-//Sekunda//CalDAV//EN");

  const zone = writableZone(ev);
  // Clone: addSubcomponent reparents, and the registered zone is shared.
  if (zone) vcal.addSubcomponent(new ICAL.Component(structuredClone(zone.component.toJSON())));

  const ve = new ICAL.Component("vevent");
  vcal.addSubcomponent(ve);

  ve.addPropertyWithValue("uid", ev.id);
  ve.addPropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(), true));
  ve.addPropertyWithValue("summary", ev.summary || "(untitled)");
  if (ev.description) ve.addPropertyWithValue("description", ev.description);
  if (ev.location) ve.addPropertyWithValue("location", ev.location);
  if (ev.status) ve.addPropertyWithValue("status", ev.status);

  if (ev.all_day) {
    // Slice the stored wall date straight through — no Date round-trip, so the
    // VALUE=DATE we write can't shift a day under the machine's timezone.
    const start = allDayWallDate(ev.dtstart);
    ve.addPropertyWithValue("dtstart", ICAL.Time.fromDateString(start));
    // DTEND is exclusive for all-day events: default to the day after DTSTART.
    const end = ev.dtend ? allDayWallDate(ev.dtend) : nextWallDate(start);
    ve.addPropertyWithValue("dtend", ICAL.Time.fromDateString(end));
  } else {
    addTimed(ve, "dtstart", new Date(ev.dtstart), zone);
    if (ev.dtend) addTimed(ve, "dtend", new Date(ev.dtend), zone);
  }

  if (ev.rrule) {
    try {
      ve.addPropertyWithValue("rrule", ICAL.Recur.fromString(ev.rrule.replace(/^RRULE:/i, "")));
    } catch {
      /* skip an unparseable rule rather than refusing to save at all */
    }
  }

  if (ev.exdates) {
    try {
      for (const iso of JSON.parse(ev.exdates) as string[]) {
        const d = new Date(iso);
        if (isNaN(d.getTime())) continue;
        // EXDATE must match DTSTART's value type and zone, or it may fail to
        // suppress the occurrence and the skipped event comes back.
        if (ev.all_day) ve.addPropertyWithValue("exdate", ICAL.Time.fromDateString(allDayWallDate(iso)));
        else addTimed(ve, "exdate", d, zone);
      }
    } catch {
      /* ignore malformed exdates */
    }
  }

  if (ev.categories) {
    try {
      const cats = JSON.parse(ev.categories) as string[];
      if (Array.isArray(cats) && cats.length) ve.addPropertyWithValue("categories", cats.join(","));
    } catch {
      /* ignore malformed categories */
    }
  }

  return vcal.toString();
}

/** A VALUE=DATE ICAL.Time -> our floating all-day dtstart (`yyyy-MM-ddT00:00:00`).
 *  Reads the calendar-date components directly (never toJSDate, which resolves
 *  to a local-midnight instant) so the wall date survives any timezone. */
function floatingWallDate(t: ICAL.Time): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return allDayIso(`${t.year}-${pad(t.month)}-${pad(t.day)}`);
}
