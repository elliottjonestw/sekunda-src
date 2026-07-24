// EXDATE ↔ occurrence matching for the LOCAL recurrence path (lib/recurrence.ts).
//
// Split out from recurrence.ts for the same reason worker/src/imapParse.ts is
// split from imap.ts: recurrence.ts imports `rrule`, whose CJS/ESM shape can't
// be loaded by the `node --test` harness, so the pure decision lives here where
// a test can reach it (test/exdateMatch.test.ts).

/** Same calendar day (local) — how an all-day EXDATE matches an occurrence. */
export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Does an EXDATE suppress this occurrence?
 *
 * Timed events match by exact instant: `skipOccurrence` stores the very
 * occurrence Date that expansion produced, and re-expansion is deterministic,
 * so the instants are identical. Day-granularity here was lossy — a sub-daily
 * (HOURLY/MINUTELY) series lost *every* instance sharing that day, not the one
 * skipped, and a UTC-stored occurrence compared as a local wall day mismatched
 * at DST boundaries for non-UTC users. All-day events have no meaningful time,
 * so they keep the calendar-day comparison (both sides are local midnight).
 */
export function exdateMatches(exdate: Date, occStart: Date, allDay: boolean): boolean {
  return allDay ? sameDay(exdate, occStart) : exdate.getTime() === occStart.getTime();
}
