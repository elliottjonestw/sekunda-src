import assert from "node:assert/strict";
import { test } from "node:test";
import { toDateInput } from "../src/lib/format";

/**
 * A diary entry's `entry_date` is a FLOATING wall date ('YYYY-MM-DD', no time,
 * no zone) — the same discipline all-day events use (see allDayDates.test.ts).
 * It is stored and returned verbatim by the Worker and never round-tripped
 * through a UTC instant, so it can't drift a day when the viewer changes
 * timezone. The one place it becomes a Date is display: DiaryView parses it as
 * `new Date("<date>T00:00:00")`, which every engine reads as LOCAL midnight, so
 * `toDateInput` of that Date must be the same date again.
 *
 * These assertions are timezone-independent by construction — run under
 * `TZ=Asia/Tokyo` or `TZ=Pacific/Honolulu` and they still pass.
 */

/** Mirror of DiaryView's parseWallDate: a floating day -> local midnight. */
function parseWallDate(date: string): Date {
  return new Date(`${date}T00:00:00`);
}

test("a diary date survives the display round-trip in any timezone", () => {
  for (const date of ["2026-07-25", "2026-01-01", "2026-12-31", "2026-03-08"]) {
    assert.equal(toDateInput(parseWallDate(date)), date);
  }
});

test("today's date input is a bare YYYY-MM-DD", () => {
  // The Diary view keys 'today' off toDateInput(new Date()), never
  // toISOString().slice(0,10), which would shift the day westward.
  assert.match(toDateInput(new Date()), /^\d{4}-\d{2}-\d{2}$/);
});
