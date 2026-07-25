import { useTranslation } from "react-i18next";
import { Bell } from "lucide-react";
import { CardShell, CardEmpty } from "./CardShell";
import { useAsync } from "./useAsync";
import { loadReminders } from "./dayData";
import { reminderWhen, dueRemindersFor } from "./derive";
import type { TodayWidget, TodayWidgetProps } from "./types";
import { toggleReminder } from "../../db";
import { isOverdue, fmtMonthDay } from "../../lib/format";

function Due({ day, viewingToday, revision, onChange, goTo }: TodayWidgetProps) {
  const { t: tr } = useTranslation();
  const reminders = useAsync(() => loadReminders(revision), [revision]);

  const dueReminders = dueRemindersFor(reminders.data ?? [], day, viewingToday);
  // Only a skeleton before the first result — ticking something off reloads
  // the list, and blanking the card mid-click would be its own bug.
  const first = reminders.loading && !reminders.data;

  return (
    <CardShell
      title={viewingToday ? tr("today.dueToday") : tr("today.dueOn", { date: fmtMonthDay(day) })}
      onHeaderClick={() => goTo("reminders")}
      loading={first}
      error={reminders.error}
    >
      {dueReminders.length === 0 ? (
        <CardEmpty>{tr("today.nothingDue")}</CardEmpty>
      ) : (
        <>
          {dueReminders.map((r) => {
            const when = reminderWhen(r, day);
            return (
              <div key={r.id} className="flex items-center gap-2 py-1">
                <input
                  type="checkbox"
                  className="accent-blue-600"
                  aria-label={r.title}
                  onChange={async () => {
                    try { await toggleReminder(r.id, true); onChange(); }
                    catch (e) { console.error("toggleReminder failed", e); }
                  }}
                />
                <Bell size={14} className="shrink-0 text-neutral-400" />
                <span className="truncate">{r.title}</span>
                {!r.rrule && when && isOverdue(when.toISOString()) && (
                  <span className="text-xs text-red-500">{tr("today.overdue")}</span>
                )}
              </div>
            );
          })}
        </>
      )}
    </CardShell>
  );
}

export const dueWidget: TodayWidget = {
  id: "due",
  labelKey: "today.dueToday",
  Component: Due,
};
