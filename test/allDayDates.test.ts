import assert from "node:assert/strict";
import { test } from "node:test";
import { allDayIso, allDayIsoFromDate, allDayWallDate, nextWallDate } from "../src/lib/format";
import { buildCalendarData, expandRemoteEvent } from "../src/lib/caldav/ical";
import type { CalDavCalendar } from "../src/lib/settings";
import type { UnifiedEvent } from "../src/types";

/**
 * All-day events store a FLOATING wall-clock date (`yyyy-MM-ddT00:00:00`, no
 * `Z`/offset) so the calendar date is timezone-independent and never drifts a
 * day on write-back. This pins that: it is the guard against anyone "fixing" it
 * back into a UTC instant (which shifted the date for every non-UTC user) or
 * into a naive `dtstart.slice(0,10)` of a UTC instant (which shifted it for
 * every user east of UTC — the exact regression the review proposed).
 *
 * These assertions are timezone-independent by construction — run the file
 * under `TZ=Asia/Tokyo` or `TZ=Pacific/Honolulu` and they still pass.
 */

const cal: CalDavCalendar = {
  id: "https://example.com/cal/",
  name: "Test",
  color: null,
} as CalDavCalendar;

function allDayEvent(dtstart: string, dtend: string | null = null, extra: Partial<UnifiedEvent> = {}): UnifiedEvent {
  return {
    source: "caldav",
    calendarId: cal.id,
    id: "evt-1",
    href: "https://example.com/cal/evt-1.ics",
    color: null,
    summary: "All day",
    description: null,
    location: null,
    dtstart,
    dtend,
    all_day: 1,
    rrule: null,
    exdates: null,
    status: "CONFIRMED",
    categories: null,
    ...extra,
  };
}

test("format helpers derive a stable wall date", () => {
  assert.equal(allDayIso("2026-07-24"), "2026-07-24T00:00:00");
  // A floating stored value is sliced verbatim, independent of the local zone.
  assert.equal(allDayWallDate("2026-07-24T00:00:00"), "2026-07-24");
  // A legacy `…Z` instant (authored as local midnight) is read in local time.
  assert.equal(allDayWallDate(new Date("2026-07-24T00:00:00").toISOString()), "2026-07-24");
  // The local wall date of any instant on July 24 is July 24.
  assert.equal(allDayIsoFromDate(new Date("2026-07-24T12:34:00")), "2026-07-24T00:00:00");
  assert.equal(nextWallDate("2026-07-24"), "2026-07-25");
  assert.equal(nextWallDate("2026-12-31"), "2027-01-01");
});

test("buildCalendarData writes VALUE=DATE unchanged, no timezone shift", () => {
  const ics = buildCalendarData(allDayEvent("2026-07-24T00:00:00"));
  assert.match(ics, /DTSTART;VALUE=DATE:20260724/);
  // DTEND is exclusive: the day after DTSTART when none is stored.
  assert.match(ics, /DTEND;VALUE=DATE:20260725/);
});

test("all-day EXDATE shares DTSTART's floating value type", () => {
  const ev = allDayEvent("2026-07-24T00:00:00", "2026-07-25T00:00:00", {
    rrule: "FREQ=DAILY",
    exdates: JSON.stringify(["2026-07-26T00:00:00"]),
  });
  const ics = buildCalendarData(ev);
  assert.match(ics, /EXDATE;VALUE=DATE:20260726/);
  assert.doesNotMatch(ics, /EXDATE[^\n]*T\d{6}Z/); // never a UTC datetime
});

test("remote all-day round-trips through parse -> build without drifting", () => {
  const resource = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:evt-1",
    "DTSTART;VALUE=DATE:20260724",
    "DTEND;VALUE=DATE:20260725",
    "SUMMARY:All day",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  const occs = expandRemoteEvent(
    resource,
    "https://example.com/cal/evt-1.ics",
    undefined,
    cal,
    new Date("2026-07-01T00:00:00Z"),
    new Date("2026-08-01T00:00:00Z"),
  );
  assert.equal(occs.length, 1);
  const ev = occs[0].event;
  assert.equal(ev.all_day, 1);
  assert.equal(allDayWallDate(ev.dtstart), "2026-07-24");
  assert.match(buildCalendarData(ev), /DTSTART;VALUE=DATE:20260724/);
});
