import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Plus, CalendarDays } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { NoteRow } from "../types";
import { listDiary, upsertNote, searchNotes, allLinkTargets } from "../db";
import { Button } from "../components/ui";
import { releaseNoteImages } from "../components/NoteImage";
import MarkdownDocEditor from "../components/MarkdownDocEditor";
import { LinkTarget } from "../components/ItemMeta";
import { useFirstLoad, firstLoadScreen, SlowLoad } from "../components/ViewGate";
import {
  toDateInput, fmtFullDate, fmtMonthYear, weekdayNames, startOfWeek,
} from "../lib/format";

/** A floating diary date ('YYYY-MM-DD') -> a local Date at midnight. Parsing a
 *  zoneless datetime is local in every engine, so the day never shifts. */
function parseWallDate(date: string): Date {
  return new Date(`${date}T00:00:00`);
}

/** The 42-cell (6-week) grid of the month containing `cursor`, starting on the
 *  locale's first weekday — a stable size so the layout doesn't jump. */
function monthGrid(cursor: Date): Date[] {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = startOfWeek(first);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

export default function DiaryView({ onChange, initialDate }: { onChange: () => void; initialDate?: string }) {
  const { t } = useTranslation();
  const today = toDateInput(new Date());
  const [entries, setEntries] = useState<NoteRow[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>(initialDate ?? today);
  const [cursor, setCursor] = useState<Date>(parseWallDate(initialDate ?? today));
  const [query, setQuery] = useState("");
  const [targets, setTargets] = useState<LinkTarget[]>([]);

  const reload = async () => {
    const list = query.trim() ? await searchNotes(query, "diary") : await listDiary();
    setEntries(list);
    setTargets(await allLinkTargets());
  };
  // Only the first load blocks the page; searching keeps the current list up.
  const gate = useFirstLoad(reload, [query]);

  useEffect(() => releaseNoteImages, []);

  const bump = () => { void reload(); onChange(); };

  // Days that already have an entry, for the calendar dots.
  const daysWithEntry = useMemo(
    () => new Set(entries.map((e) => e.entry_date).filter((d): d is string => !!d)),
    [entries],
  );

  const selected = entries.find((e) => e.entry_date === selectedDate) ?? null;

  function pickDate(date: string) {
    setSelectedDate(date);
    setQuery(""); // leaving search returns to the calendar's context
  }

  async function startEntry() {
    const id = await upsertNote({ kind: "diary", entry_date: selectedDate, title: "", body: "", pinned: 0 });
    await reload();
    // The entry now exists for selectedDate; `selected` resolves on next render.
    void id;
    onChange();
  }

  const grid = monthGrid(cursor);
  const cursorMonth = cursor.getMonth();

  const blocked = firstLoadScreen(gate);
  if (blocked) return blocked;

  return (
    <div className="flex h-full">
      <SlowLoad state={gate} />
      {/* Left pane: calendar + entry list. Below `md` it yields the screen to
          the editor once a day is being written, like NotesView's two panes. */}
      <aside className={`w-full shrink-0 flex-col border-r border-neutral-200 dark:border-neutral-700 md:flex md:w-72 ${selected ? "hidden" : "flex"}`}>
        <div className="space-y-3 border-b border-neutral-200 p-3 dark:border-neutral-700">
          <Button variant="primary" className="w-full" onClick={() => { setCursor(parseWallDate(today)); pickDate(today); }}>
            <span className="flex items-center justify-center gap-1.5"><Plus size={16} /> {t("diary.todayEntry")}</span>
          </Button>

          {/* Mini month calendar */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <button
                onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
                aria-label={t("diary.prevMonth")}
                className="rounded p-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-700"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-sm font-medium">{fmtMonthYear(cursor)}</span>
              <button
                onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
                aria-label={t("diary.nextMonth")}
                className="rounded p-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-700"
              >
                <ChevronRight size={16} />
              </button>
            </div>
            <div className="grid grid-cols-7 gap-0.5 text-center text-[0.65rem] text-neutral-400">
              {weekdayNames().map((w, i) => <div key={i} className="py-0.5">{w}</div>)}
            </div>
            <div className="grid grid-cols-7 gap-0.5">
              {grid.map((d) => {
                const iso = toDateInput(d);
                const inMonth = d.getMonth() === cursorMonth;
                const isSelected = iso === selectedDate;
                const isToday = iso === today;
                const has = daysWithEntry.has(iso);
                return (
                  <button
                    key={iso}
                    onClick={() => pickDate(iso)}
                    className={`relative aspect-square rounded text-xs ${
                      isSelected
                        ? "bg-blue-600 text-white"
                        : inMonth
                          ? "text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-700"
                          : "text-neutral-300 hover:bg-neutral-100 dark:text-neutral-600 dark:hover:bg-neutral-800"
                    } ${isToday && !isSelected ? "ring-1 ring-blue-400" : ""}`}
                  >
                    {d.getDate()}
                    {has && (
                      <span
                        className={`absolute bottom-0.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full ${
                          isSelected ? "bg-white" : "bg-blue-500"
                        }`}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("diary.searchPlaceholder")}
            className="w-full rounded-lg border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-blue-400 dark:border-neutral-600 dark:bg-neutral-800"
          />
        </div>

        {/* Entry list, newest day first. */}
        <div className="flex-1 overflow-y-auto">
          {entries.map((n) => (
            <button
              key={n.id}
              onClick={() => n.entry_date && pickDate(n.entry_date)}
              className={`block w-full border-b border-neutral-100 px-3 py-2 text-left dark:border-neutral-800 ${
                selectedDate === n.entry_date ? "bg-blue-50 dark:bg-blue-900/30" : "hover:bg-neutral-50 dark:hover:bg-neutral-800"
              }`}
            >
              <div className="truncate font-medium">
                {n.entry_date ? fmtFullDate(parseWallDate(n.entry_date)) : t("common.untitled")}
              </div>
              <div className="truncate text-xs text-neutral-400">
                {n.title?.trim() || (n.body ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || t("notes.noContent")}
              </div>
            </button>
          ))}
          {entries.length === 0 && <p className="p-4 text-sm text-neutral-400">{query.trim() ? t("notes.noneFound") : t("diary.empty")}</p>}
        </div>
      </aside>

      {/* Right pane: the selected day's entry, or an invitation to start one. */}
      <div className={`flex-1 overflow-y-auto ${selected ? "" : "hidden md:block"}`}>
        {selected ? (
          <MarkdownDocEditor
            key={selected.id}
            note={selected}
            targets={targets}
            onChanged={bump}
            onDeleted={() => bump()}
            onBack={() => setSelectedDate("")}
            showPin={false}
            header={
              <div className="flex items-center gap-2 text-sm font-semibold text-blue-600 dark:text-blue-400">
                <CalendarDays size={16} />
                {fmtFullDate(parseWallDate(selectedDate))}
              </div>
            }
            titlePlaceholder={t("diary.titlePlaceholder")}
            confirmDelete={t("diary.confirmDelete")}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-neutral-400">
            {selectedDate ? (
              <>
                <p>{t("diary.noEntry", { date: fmtFullDate(parseWallDate(selectedDate)) })}</p>
                <Button variant="primary" onClick={startEntry}>
                  <span className="flex items-center gap-1.5"><Plus size={16} /> {t("diary.startWriting")}</span>
                </Button>
              </>
            ) : (
              t("diary.selectDay")
            )}
          </div>
        )}
      </div>
    </div>
  );
}
