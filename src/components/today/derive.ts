// Day-scoping rules shared by more than one widget.
//
// The due card shows these items and the summary describes them, so the rules
// live here rather than in either — two copies would drift, and the briefing
// would start describing a day the card doesn't show.

import type { ReminderRow, PersonRow } from "../../types";
import { startOfDay, isSameDay, isOverdue, fmtMonthDay, fmtRelativeDays, parseBirthday } from "../../lib/format";
import { nextOccurrenceFrom } from "../../lib/recurrence";

/**
 * Effective due time for a reminder on the day being viewed: the occurrence
 * falling on or after that day for a recurring series, or the stored base
 * otherwise. Mirrors ItemCard so a daily 8am reminder shows that day's 8am, not
 * the day the series was created. Returns null if it has no time at all.
 */
export function reminderWhen(r: ReminderRow, day: Date): Date | null {
  const base = r.remind_at || r.due_at;
  if (!base) return null;
  if (r.rrule) return nextOccurrenceFrom(base, r.rrule, startOfDay(day));
  return new Date(base);
}

/**
 * Reminders to show against `day`.
 *
 * Overdue is a fact about *now*, so it only pulls extra items onto the day when
 * that day is today. Any other date shows exactly what falls on it.
 */
export function dueRemindersFor(reminders: ReminderRow[], day: Date, viewingToday: boolean): ReminderRow[] {
  return reminders.filter((r) => {
    if (r.completed) return false;
    const when = reminderWhen(r, day);
    if (!when) return false;
    // Recurring reminders recur by design — never treat them as overdue. They
    // show when their occurrence lands on the day; a one-off past reminder shows
    // on today because it's genuinely overdue. Matches ItemCard's reminder branch.
    if (r.rrule) return isSameDay(when, day);
    return isSameDay(when, day) || (viewingToday && isOverdue(when.toISOString()));
  });
}

export interface UpcomingBirthday {
  person: PersonRow;
  days: number;
  dateLabel: string;
  awayLabel: string;
}

/** People whose birthday (month/day, any year) falls within `within` days of
 * `from`, soonest first. Compares on month/day only, ignoring the stored year. */
export function upcomingBirthdays(people: PersonRow[], within: number, from: Date): UpcomingBirthday[] {
  const today = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const out: UpcomingBirthday[] = [];
  for (const person of people) {
    if (!person.birthday) continue;
    // Reuse the single birthday parser so this stays consistent with the People
    // view's read of the same field — including vCard `--05-14` (unknown year),
    // which a local yyyy-mm-dd regex here would silently drop.
    const parsed = parseBirthday(person.birthday);
    if (!parsed) continue;
    const { month, day } = parsed;
    // A Feb 29 birthday on a non-leap year would otherwise roll over to Mar 1
    // (JS Date overflows the day-of-month). Cap to the last day of the month so
    // it lands on Feb 28 that year — the usual convention.
    const inYear = (year: number): Date => {
      const lastDay = new Date(year, month, 0).getDate(); // day 0 of next month
      return new Date(year, month - 1, Math.min(day, lastDay));
    };
    let next = inYear(today.getFullYear());
    if (next < today) next = inYear(today.getFullYear() + 1);
    const days = Math.round((next.getTime() - today.getTime()) / 86400000);
    if (days > within) continue;
    out.push({
      person,
      days,
      // Year is a placeholder — fmtMonthDay renders month/day only. 2000 (not
      // 1970) so a Feb 29 birthday still resolves to a real date.
      dateLabel: fmtMonthDay(new Date(2000, month - 1, day)),
      awayLabel: fmtRelativeDays(days),
    });
  }
  return out.sort((a, b) => a.days - b.days);
}
