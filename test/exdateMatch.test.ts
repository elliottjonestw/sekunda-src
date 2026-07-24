import assert from "node:assert/strict";
import { test } from "node:test";
import { exdateMatches, sameDay } from "../src/lib/exdate";

/**
 * EXDATE ↔ occurrence matching. Guards against reverting timed matching to
 * day-granularity, which silently dropped *every* sub-daily instance sharing
 * the skipped day (a whole day of an HOURLY series), and mismatched at DST for
 * non-UTC users. Timed = exact instant; all-day = calendar day.
 */

test("timed events match by exact instant, not by day", () => {
  const occ2am = new Date("2026-07-24T02:00:00");
  const occ3am = new Date("2026-07-24T03:00:00");
  const ex = new Date(occ2am.toISOString()); // what skipOccurrence stores

  // The skipped instant is suppressed…
  assert.equal(exdateMatches(ex, occ2am, false), true);
  // …but a sibling instance the same day is NOT — the bug this fixes.
  assert.equal(exdateMatches(ex, occ3am, false), false);
  // Day-granularity would have wrongly matched both.
  assert.equal(sameDay(ex, occ3am), true);
});

test("all-day events match by calendar day", () => {
  // Both sides are local midnight of the same wall date.
  const occ = new Date("2026-07-24T00:00:00");
  const ex = new Date("2026-07-24T00:00:00");
  assert.equal(exdateMatches(ex, occ, true), true);

  const nextDay = new Date("2026-07-25T00:00:00");
  assert.equal(exdateMatches(ex, nextDay, true), false);
});

test("a near-miss instant does not suppress a timed occurrence", () => {
  const occ = new Date("2026-07-24T09:00:00");
  const offByAMinute = new Date("2026-07-24T09:01:00");
  assert.equal(exdateMatches(offByAMinute, occ, false), false);
});
