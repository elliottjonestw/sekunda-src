import { useEffect, useMemo, useRef, useState } from "react";
import { Bell, Trash2, Inbox, CalendarClock, Flag, CheckCircle2, LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ReminderRow } from "../types";
import {
  listReminders, upsertReminder, toggleReminder, deleteReminder, allLinkTargets,
} from "../db";
import { Button, Modal, PriorityFlag, priorityKey } from "../components/ui";
import { TagEditor, LinksPanel, PeoplePanel, LinkTarget } from "../components/ItemMeta";
import { fmtDateTime, isOverdue, toLocalInput, fromLocalInput } from "../lib/format";
import { describeRrule, RRULE_PRESETS } from "../lib/recurrence";
import { ensureNotificationPermission } from "../lib/notifications";
import { useFirstLoad, firstLoadScreen, SlowLoad } from "../components/ViewGate";

type Filter = "all" | "scheduled" | "flagged" | "completed";

const FILTERS: { id: Filter; icon: LucideIcon }[] = [
  { id: "all", icon: Inbox },
  { id: "scheduled", icon: CalendarClock },
  { id: "flagged", icon: Flag },
  { id: "completed", icon: CheckCircle2 },
];

function matchesFilter(r: ReminderRow, f: Filter): boolean {
  switch (f) {
    case "scheduled": return !r.completed && !!(r.remind_at || r.due_at);
    case "flagged": return !r.completed && r.priority > 0;
    case "completed": return r.completed === 1;
    default: return !r.completed;
  }
}

export default function RemindersView({ onChange, initialId }: { onChange: () => void; initialId?: string }) {
  const { t } = useTranslation();
  const [reminders, setReminders] = useState<ReminderRow[]>([]);
  const [editing, setEditing] = useState<ReminderRow | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [notifOk, setNotifOk] = useState(true);

  const reload = async () => setReminders(await listReminders());
  // Blocks the page until the first list arrives — an empty list and "you have
  // no reminders" look identical. Later reloads leave what's on screen alone.
  const gate = useFirstLoad(reload, []);
  useEffect(() => { void ensureNotificationPermission().then(setNotifOk); }, []);
  const bump = () => { void reload(); onChange(); };

  // Open a specific reminder when navigated here with a target (e.g. from an
  // assistant card). Only fires once, so it can't re-open after the user closes it.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !initialId || reminders.length === 0) return;
    const match = reminders.find((r) => r.id === initialId);
    if (match) {
      opened.current = true;
      setEditing(match);
    }
  }, [reminders, initialId]);

  async function add() {
    if (!newTitle.trim()) return;
    await upsertReminder({
      title: newTitle.trim(), notes: null, due_at: null, remind_at: null,
      rrule: null, priority: 0, completed: 0, completed_at: null,
    });
    setNewTitle("");
    bump();
  }

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, scheduled: 0, flagged: 0, completed: 0 };
    for (const f of ["all", "scheduled", "flagged", "completed"] as Filter[]) {
      c[f] = reminders.filter((r) => matchesFilter(r, f)).length;
    }
    return c;
  }, [reminders]);

  const visible = reminders.filter((r) => matchesFilter(r, filter));

  const blocked = firstLoadScreen(gate);
  if (blocked) return blocked;

  return (
    // Column below `md` (the filters become a strip above the list), row from
    // `md` — the original two-pane layout, unchanged.
    <div className="flex h-full flex-col md:flex-row">
      <SlowLoad state={gate} />
      {/* Filter sidebar (Apple Reminders-style smart lists). Below `md` it lies
          down into a horizontally scrolling strip so the list keeps the width. */}
      <aside className="shrink-0 border-b border-neutral-200 p-3 dark:border-neutral-700 md:w-48 md:border-b-0 md:border-r">
        <h3 className="mb-2 text-xs font-semibold uppercase text-neutral-400">{t("nav.reminders")}</h3>
        <div className="flex gap-2 overflow-x-auto md:block">
        {FILTERS.map((f) => {
          const Icon = f.icon;
          return (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`flex w-auto shrink-0 items-center justify-between gap-2 whitespace-nowrap rounded px-2 py-1.5 text-sm md:w-full md:whitespace-normal ${
                filter === f.id ? "bg-blue-100 dark:bg-blue-900/40" : "hover:bg-neutral-100 dark:hover:bg-neutral-700"
              }`}
            >
              <span className="flex min-w-0 items-center gap-2"><Icon size={16} className="shrink-0 text-neutral-500" /> <span className="truncate">{t(`reminders.filter.${f.id}`)}</span></span>
              <span className="text-xs text-neutral-400">{counts[f.id]}</span>
            </button>
          );
        })}
        </div>
      </aside>

      {/* Reminder list */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto max-w-2xl">
          {!notifOk && (
            <div className="mb-3 rounded-lg bg-amber-100 px-3 py-2 text-sm text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
              {t("reminders.notificationsOff")}
            </div>
          )}
          <div className="mb-4 flex gap-2">
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder={t("reminders.addPlaceholder")}
              className="flex-1 rounded-lg border border-neutral-200 px-3 py-2 outline-none focus:border-blue-400 dark:border-neutral-600 dark:bg-neutral-800"
            />
            <Button variant="primary" onClick={add}>{t("common.add")}</Button>
          </div>

          <div className="space-y-1">
            {visible.map((r) => (
              <div key={r.id} className="group flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-800">
                <input type="checkbox" checked={r.completed === 1} onChange={async (e) => { await toggleReminder(r.id, e.target.checked); bump(); }} className="h-4 w-4 accent-blue-600" />
                <button onClick={() => setEditing(r)} className={`flex-1 text-left ${r.completed ? "text-neutral-400 line-through" : ""}`}>
                  <div>{r.title}</div>
                  {(r.remind_at || r.due_at) && (
                    <div className={`flex items-center gap-1 text-xs ${isOverdue(r.remind_at || r.due_at) && !r.completed && !r.rrule ? "text-red-500" : "text-neutral-400"}`}>
                      {r.remind_at ? <><Bell size={12} /> {fmtDateTime(r.remind_at)}</> : <>{t("reminders.due", { when: fmtDateTime(r.due_at) })}</>}
                      {r.rrule && ` · ${describeRrule(r.rrule)}`}
                    </div>
                  )}
                </button>
                <PriorityFlag priority={r.priority} />
                <button
                  onClick={async (e) => { e.stopPropagation(); if (confirm(t("reminders.confirmDelete", { title: r.title }))) { await deleteReminder(r.id); bump(); } }}
                  className="hidden text-neutral-400 hover:text-red-500 group-hover:block"
                  title={t("reminders.deleteReminder")}
                ><Trash2 size={15} /></button>
              </div>
            ))}
            {visible.length === 0 && <p className="py-8 text-center text-sm text-neutral-400">{t("reminders.empty")}</p>}
          </div>
        </div>
      </div>

      {editing && <ReminderDetail reminder={editing} onClose={() => setEditing(null)} onSaved={bump} />}
    </div>
  );
}

function ReminderDetail({ reminder, onClose, onSaved }: { reminder: ReminderRow; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(reminder.title);
  const [notes, setNotes] = useState(reminder.notes ?? "");
  const [due, setDue] = useState(reminder.due_at ? toLocalInput(new Date(reminder.due_at)) : "");
  const [remind, setRemind] = useState(reminder.remind_at ? toLocalInput(new Date(reminder.remind_at)) : "");
  const [priority, setPriority] = useState(reminder.priority);
  const [rrule, setRrule] = useState<string | null>(reminder.rrule);
  const [targets, setTargets] = useState<LinkTarget[]>([]);

  useEffect(() => { void allLinkTargets().then(setTargets); }, []);

  async function save() {
    await upsertReminder({
      id: reminder.id, title: title.trim() || t("common.untitledParen"), notes: notes || null,
      due_at: due ? fromLocalInput(due) : null,
      remind_at: remind ? fromLocalInput(remind) : null,
      rrule, priority, completed: reminder.completed, completed_at: reminder.completed_at,
    });
    onSaved();
    onClose();
  }

  return (
    <Modal
      open onClose={onClose} title={t("itemType.reminder")}
      footer={
        <>
          <Button variant="danger" onClick={async () => { await deleteReminder(reminder.id); onSaved(); onClose(); }}>{t("common.delete")}</Button>
          <Button variant="primary" onClick={save}>{t("common.save")}</Button>
        </>
      }
    >
      <div className="space-y-3">
        <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-600 dark:bg-neutral-700" />
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t("reminders.notesPlaceholder")} rows={2} className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm dark:border-neutral-600 dark:bg-neutral-700" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-neutral-500">{t("reminders.dueLabel")}</span>
            <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className="w-full rounded border border-neutral-200 px-2 py-1.5 dark:border-neutral-600 dark:bg-neutral-700" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-neutral-500">{t("reminders.alertAt")}</span>
            <input type="datetime-local" value={remind} onChange={(e) => setRemind(e.target.value)} className="w-full rounded border border-neutral-200 px-2 py-1.5 dark:border-neutral-600 dark:bg-neutral-700" />
          </label>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-neutral-500">{t("reminders.priority")}</span>
            <select value={priority} onChange={(e) => setPriority(Number(e.target.value))} className="w-full rounded border border-neutral-200 px-2 py-1.5 dark:border-neutral-600 dark:bg-neutral-700">
              {[0, 1, 2, 3].map((i) => <option key={i} value={i}>{t(priorityKey(i))}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-neutral-500">{t("event.repeat")}</span>
            <select value={rrule ?? "__none__"} onChange={(e) => setRrule(e.target.value === "__none__" ? null : e.target.value)} className="w-full rounded border border-neutral-200 px-2 py-1.5 dark:border-neutral-600 dark:bg-neutral-700">
              {RRULE_PRESETS.map((p) => <option key={p.key} value={p.value ?? "__none__"}>{t(p.key)}</option>)}
            </select>
          </label>
        </div>

        <hr className="border-neutral-200 dark:border-neutral-700" />
        <TagEditor type="reminder" id={reminder.id} />
        <PeoplePanel type="reminder" id={reminder.id} />
        <LinksPanel type="reminder" id={reminder.id} targets={targets} />
      </div>
    </Modal>
  );
}
