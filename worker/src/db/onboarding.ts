/**
 * The welcome content a brand-new space is seeded with: one reminder, one note
 * and one calendar event, all dated to the day the account was created. Built
 * as raw INSERTs so they join the registration batch — one atomic write, no
 * extra round-trips.
 *
 * Everything is dated in the user's *local* day. The server has no timezone of
 * its own, so the client sends `Date.getTimezoneOffset()`; without it (a
 * non-browser caller) we fall back to UTC. This is the same westward-shift the
 * rest of the app is careful about — a UTC midnight reads as the previous day
 * for anyone west of UTC.
 */

export interface SeedContext {
  spaceId: string;
  /** ISO instant the account was created (users.created_at). */
  now: string;
  /** Client `Date.getTimezoneOffset()` in minutes (UTC − local); 0 if unknown. */
  tzOffsetMinutes: number;
}

const NOTE_BODY = `Welcome to Sekunda — your calendar, reminders, notes and people in one place.

## The basics
- **Today** is your dashboard: the day's schedule, what's due, and quick notes at a glance.
- **Calendar**, **Reminders**, **Notes** and **People** each have their own section in the sidebar.
- Everything connects: attach people to events, link a note to a reminder, and tag anything.

## Getting set up
- Connect your Apple Calendar in **Settings → Calendars** so your events show up here.
- Add your OpenAI API key in **Settings** to switch on the assistant and your daily "Your day" briefing.

## The assistant
Ask it about your schedule, or have it create and update items for you — by text or by voice.

You can delete this note whenever you like.`;

/**
 * The three welcome rows as prepared statements, ready to append to the
 * registration batch. Column lists are explicit so table defaults
 * (`status`, `sequence`, `completed`, …) fill the rest.
 */
export function seedWelcomeStatements(
  db: D1Database,
  ctx: SeedContext,
): D1PreparedStatement[] {
  const { spaceId, now, tzOffsetMinutes: off } = ctx;

  // Read the local wall-clock day out of the UTC creation instant.
  const local = new Date(new Date(now).getTime() - off * 60000);
  const y = local.getUTCFullYear();
  const mo = local.getUTCMonth();
  const d = local.getUTCDate();
  // The UTC instant for a given local wall-clock time on the creation day —
  // the same value the client stores (local time + offset back to UTC).
  const at = (h: number, mi: number) =>
    new Date(Date.UTC(y, mo, d, h, mi) + off * 60000).toISOString();
  const noon = at(12, 0); // a due time that reads as "today" without arriving overdue
  // All-day events store a FLOATING wall date (no zone), so the date can't drift
  // across timezones — mirrors the client (lib/format.ts allDayIso, EventForm).
  const pad = (n: number) => String(n).padStart(2, "0");
  const allDayStart = `${y}-${pad(mo + 1)}-${pad(d)}T00:00:00`;

  return [
    // Reminder: "Tell everyone about Sekunda".
    db
      .prepare(
        `INSERT INTO reminders (id, space_id, title, notes, due_at, priority,
                                created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .bind(
        crypto.randomUUID(), spaceId, "Tell everyone about Sekunda", null,
        noon, 0, now, now,
      ),
    // Note: "How Sekunda works", pinned so it stays at the top.
    db
      .prepare(
        `INSERT INTO notes (id, space_id, title, body, pinned, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .bind(crypto.randomUUID(), spaceId, "How Sekunda works", NOTE_BODY, 1, now, now),
    // Event: "Organize my life", all-day on the creation day.
    db
      .prepare(
        `INSERT INTO events (id, space_id, summary, description, location, dtstart,
                             dtend, all_day, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind(
        crypto.randomUUID(), spaceId, "Organize my life", null, null, allDayStart,
        null, 1, "CONFIRMED", now, now,
      ),
  ];
}
