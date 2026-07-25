// One clickable row representing an item, shared by search results and the
// assistant's chat cards.
//
// Two exports, because the two callers know different amounts:
//   ItemCard    — presentational. Search already has the rows in hand.
//   ItemRefCard — takes an ItemRef and loads the item itself.
//
// The assistant variant deliberately loads the row rather than rendering what
// the model wrote about it: the card then shows the real stored values (and
// stays right if the item changed), instead of re-parsing prose. Times go
// through lib/format so they render correctly in every locale.

import { useEffect, useState } from "react";
import { Calendar, Bell, StickyNote, NotebookPen, Users, LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ItemRef, CardType, NavTarget } from "../types";
import { getReminder, getNote, getPerson } from "../db";
import { getEventByRef, findEventById } from "../lib/calendars";
import { nextOccurrenceFrom } from "../lib/recurrence";
import { fmtDate, fmtDateTime, isOverdue, startOfDay } from "../lib/format";

export const ITEM_ICON: Record<CardType, LucideIcon> = {
  event: Calendar, reminder: Bell, note: StickyNote, diary: NotebookPen, person: Users,
};

/** Which view opens each item type. */
export const VIEW_FOR: Record<CardType, string> = {
  event: "calendar", reminder: "reminders", note: "notes", diary: "diary", person: "people",
};

/** The nav target that opens this item's detail once its view has mounted. */
export function targetFor(
  { type, id, occurrenceStart, diaryDate }: { type: CardType; id: string; occurrenceStart?: string; diaryDate?: string },
): NavTarget {
  switch (type) {
    case "event": return { eventId: id, eventStart: occurrenceStart };
    case "reminder": return { reminderId: id };
    case "note": return { noteId: id };
    // The Diary view opens by day, not by row id (an entry IS a date).
    case "diary": return { diaryDate };
    case "person": return { personId: id };
  }
}

export interface ItemCardProps {
  type: CardType;
  label: string;
  sub?: string;
  /** Completed reminder: dimmed and struck through. */
  done?: boolean;
  /** Past due and not done: the subtitle turns red. */
  overdue?: boolean;
  onClick?: () => void;
}

export function ItemCard({ type, label, sub, done, overdue, onClick }: ItemCardProps) {
  const { t } = useTranslation();
  const Icon = ITEM_ICON[type];
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg border border-neutral-200 px-3 py-2 text-left hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
    >
      <Icon size={18} className="shrink-0 text-neutral-500" />
      <span className="flex-1 min-w-0">
        <span className={`block truncate font-medium ${done ? "text-neutral-400 line-through" : ""}`}>{label}</span>
        {sub && (
          <span className={`block truncate text-xs ${overdue && !done ? "text-red-500" : "text-neutral-400"}`}>
            {sub}
          </span>
        )}
      </span>
      <span className="shrink-0 text-xs text-neutral-400">{t(`itemType.${type}`)}</span>
    </button>
  );
}

/** The card's display fields, resolved from the stored row. */
interface Loaded {
  label: string;
  sub: string;
  done: boolean;
  overdue: boolean;
}

async function load(ref: ItemRef, t: (k: any, o?: any) => string): Promise<Loaded | null> {
  switch (ref.type) {
    case "event": {
      // A remote event has no SQLite row, so this goes through calendars.ts.
      const ev = ref.calendarId
        ? await getEventByRef(ref.calendarId, ref.id)
        : await findEventById(ref.id);
      if (!ev) return null;
      // Recurring series share one id across occurrences; occurrenceStart picks
      // the instance being discussed, so the card shows that date, not the first.
      const start = ref.occurrenceStart ?? ev.dtstart;
      return { label: ev.summary, sub: fmtDateTime(start), done: false, overdue: false };
    }
    case "reminder": {
      const r = await getReminder(ref.id);
      if (!r) return null;
      // Recurring reminders store the series' base time; show the current
      // occurrence (from start of today) instead of the day it was created,
      // and never flag a repeating reminder overdue — it recurs by design.
      const base = r.remind_at ?? r.due_at;
      const when = r.rrule ? nextOccurrenceFrom(base, r.rrule, startOfDay(new Date())) : (base ? new Date(base) : null);
      const iso = when ? when.toISOString() : null;
      return {
        label: r.title,
        sub: iso ? t("card.due", { when: fmtDateTime(iso) }) : "",
        done: !!r.completed,
        overdue: !r.completed && !r.rrule && isOverdue(iso),
      };
    }
    case "note": {
      const n = await getNote(ref.id);
      if (!n) return null;
      return {
        label: n.title || t("common.untitled"),
        sub: (n.body ?? "").replace(/\s+/g, " ").slice(0, 80),
        done: false, overdue: false,
      };
    }
    case "diary": {
      // A diary entry is a note row keyed by its day; the day is the identity, so
      // it always shows even when the entry has a title.
      const n = await getNote(ref.id);
      if (!n || n.kind !== "diary") return null;
      const date = n.entry_date ? fmtDate(new Date(`${n.entry_date}T00:00:00`)) : "";
      const title = n.title?.trim();
      return {
        label: title || date || t("common.untitled"),
        sub: title ? date : (n.body ?? "").replace(/\s+/g, " ").slice(0, 80),
        done: false, overdue: false,
      };
    }
    case "person": {
      const p = await getPerson(ref.id);
      if (!p) return null;
      return { label: p.full_name, sub: p.organization || p.nickname || "", done: false, overdue: false };
    }
  }
}

/**
 * A card for an item the assistant cited. Renders nothing if the item has since
 * been deleted — a stale card is worse than no card.
 */
export function ItemRefCard({ item, onOpen }: { item: ItemRef; onOpen?: (item: ItemRef) => void }) {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState<Loaded | null>(null);

  // The subtitle is built here rather than at render, so it has to be rebuilt
  // when the language changes — dates and "Due …" are both locale-dependent.
  useEffect(() => {
    let live = true;
    void load(item, t).then((d) => { if (live) setData(d); });
    return () => { live = false; };
  }, [item.type, item.id, item.calendarId, item.occurrenceStart, i18n.language]);

  if (!data) return null;
  return (
    <ItemCard
      type={item.type}
      label={data.label}
      sub={data.sub}
      done={data.done}
      overdue={data.overdue}
      onClick={onOpen ? () => onOpen(item) : undefined}
    />
  );
}
