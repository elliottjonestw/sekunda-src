import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft, ChevronRight, Plus, Repeat, Square, Upload, Download,
  Layers, Loader2, CloudOff,
} from "lucide-react";
import { addDays, addMonths, addWeeks } from "date-fns";
import { useTranslation } from "react-i18next";
import type { TodoRow, EventOccurrence, UnifiedEvent } from "../types";
import { listTodos } from "../db";
import {
  getOccurrences, listCalendars, setCalendarVisible, invalidateCache,
  defaultCalendarId, type CalendarInfo,
} from "../lib/calendars";
import {
  startOfMonth, endOfMonth, startOfWeek, endOfWeek, startOfDay, endOfDay,
  isSameDay, isToday, fmtTime, fmtHour, fmtDate, fmtMonthYear, fmtFullDate,
  fmtWeekdayShort, weekdayNames,
} from "../lib/format";
import { exportCalendar, importCalendar } from "../lib/ics";
import { Button } from "../components/ui";
import EventForm from "../components/EventForm";
import { useFirstLoad, firstLoadScreen, SlowLoad } from "../components/ViewGate";

type ViewMode = "month" | "week" | "day";
const HOUR_PX = 48;

export default function CalendarView(
  { onChange, openEventId, openEventStart }:
  { onChange: () => void; openEventId?: string; openEventStart?: string },
) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<ViewMode>("month");
  // Start on the target's month when navigated to a specific occurrence: the
  // effect below can only match events the visible window actually loaded, and
  // a search hit is routinely months from today.
  const [cursor, setCursor] = useState(() => {
    const at = openEventStart ? new Date(openEventStart) : null;
    return at && !isNaN(at.getTime()) ? at : new Date();
  });
  const [occurrences, setOccurrences] = useState<EventOccurrence[]>([]);
  const [todos, setTodos] = useState<TodoRow[]>([]);
  const [editing, setEditing] = useState<{ event: UnifiedEvent | null; calendarId?: string; start?: Date; occ?: Date } | null>(null);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [calendars, setCalendars] = useState<CalendarInfo[]>(() => listCalendars());
  const [showFilter, setShowFilter] = useState(false);
  // Bumped to force a refetch after a write; the window itself is unchanged.
  const [nonce, setNonce] = useState(0);

  // Visible window depends on mode.
  const [winStart, winEnd] = useMemo<[Date, Date]>(() => {
    if (mode === "month") return [startOfWeek(startOfMonth(cursor)), endOfWeek(endOfMonth(cursor))];
    if (mode === "week") return [startOfWeek(cursor), endOfWeek(cursor)];
    return [startOfDay(cursor), endOfDay(cursor)];
  }, [mode, cursor]);

  // Remote calendars are fetched per visible window, so this runs on every
  // navigation. `seq` discards out-of-order responses when the user pages
  // faster than the network answers.
  const seq = useRef(0);
  const load = async () => {
    const mine = ++seq.current;
    setLoading(true);
    const [{ occurrences: occs, errors: errs }, allTodos] = await Promise.all([
      getOccurrences(winStart, winEnd),
      listTodos(),
    ]);
    if (seq.current !== mine) return; // a newer window won
    setOccurrences(occs);
    setErrors(errs);
    setTodos(allTodos.filter((t) => t.due_at && !t.completed));
    setLoading(false);
  };
  // The first fetch blocks the grid — a month drawn empty and then filled in is
  // the flicker this removes. Paging to another month keeps the old one on
  // screen behind the toolbar spinner instead. `getOccurrences` fails soft, so
  // reaching the retry panel means the local read itself failed.
  const gate = useFirstLoad(load, [winStart, winEnd, nonce]);

  const reload = () => { invalidateCache(); setCalendars(listCalendars()); setNonce((n) => n + 1); };
  const bump = () => { reload(); onChange(); };

  // Open a specific event when navigated here with a target (e.g. from Today).
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !openEventId || occurrences.length === 0) return;
    // One recurring id has many occurrences in a window, so prefer the day we
    // were sent to before falling back to the first one.
    const mine = occurrences.filter((o) => o.event.id === openEventId);
    const at = openEventStart ? new Date(openEventStart) : null;
    const match =
      (at && !isNaN(at.getTime()) ? mine.find((o) => isSameDay(o.start, at)) : undefined) ?? mine[0];
    if (match) {
      opened.current = true;
      setEditing({ event: match.event, occ: match.start });
    }
  }, [occurrences, openEventId, openEventStart]);

  async function doExport() {
    try {
      const path = await exportCalendar();
      setMsg(path ? t("calendar.exportedTo", { path }) : "");
    } catch (e) {
      setMsg("");
      setErrors([e instanceof Error ? e.message : String(e)]);
    }
  }
  async function doImport() {
    try {
      const n = await importCalendar();
      setMsg(t("calendar.imported", { count: n }));
      bump();
    } catch (e) {
      setErrors([e instanceof Error ? e.message : String(e)]);
    }
  }

  const move = (dir: number) => {
    if (mode === "month") setCursor((c) => addMonths(c, dir));
    else if (mode === "week") setCursor((c) => addWeeks(c, dir));
    else setCursor((c) => addDays(c, dir));
  };

  const title =
    mode === "month" ? fmtMonthYear(cursor)
    : mode === "week" ? t("calendar.weekOf", { date: fmtDate(startOfWeek(cursor)) })
    : fmtFullDate(cursor);

  const blocked = firstLoadScreen(gate);
  if (blocked) return blocked;

  return (
    <div className="flex h-full flex-col">
      <SlowLoad state={gate} />
      {/* Toolbar. Below `md` it wraps: the date and its arrows on one line,
          the mode switch and actions on the next. The right-hand group keeps
          `md:flex-1 justify-end`, which reproduces the desktop row exactly. */}
      <div className="flex flex-wrap items-center justify-between gap-y-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-700 md:flex-nowrap md:px-4 md:py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button onClick={() => setCursor(new Date())}>{t("nav.today")}</Button>
          <Button variant="ghost" onClick={() => move(-1)} aria-label={t("calendar.previous")}><ChevronLeft size={18} /></Button>
          <Button variant="ghost" onClick={() => move(1)} aria-label={t("calendar.next")}><ChevronRight size={18} /></Button>
          <h2 className="ml-2 min-w-0 truncate text-base font-semibold md:text-lg">{title}</h2>
        </div>
        <div className="flex w-full items-center justify-end gap-1 md:w-auto md:flex-1">
          {loading && <Loader2 size={15} className="mr-1 animate-spin text-neutral-400" />}
          {(["month", "week", "day"] as ViewMode[]).map((m) => (
            <Button key={m} variant={mode === m ? "primary" : "ghost"} onClick={() => setMode(m)}>
              {t(`calendar.mode.${m}`)}
            </Button>
          ))}

          {/* Per-calendar visibility — view them individually or together. */}
          <div className="relative">
            <Button variant="ghost" onClick={() => setShowFilter((v) => !v)} aria-label={t("settings.sections.calendars")}>
              <Layers size={16} />
            </Button>
            {showFilter && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowFilter(false)} />
                <div className="absolute right-0 top-full z-20 mt-1 w-56 rounded-lg border border-neutral-200 bg-white p-2 shadow-lg dark:border-neutral-700 dark:bg-neutral-800">
                  <div className="px-1 pb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-400">{t("settings.sections.calendars")}</div>
                  {calendars.map((cal) => (
                    <label key={cal.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-700/50">
                      <input
                        type="checkbox"
                        checked={cal.visible}
                        onChange={(e) => { setCalendarVisible(cal.id, e.target.checked); reload(); }}
                        className="accent-blue-600"
                      />
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: cal.color ?? "#3b82f6" }} />
                      <span className="truncate">{cal.name}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>

          <Button variant="primary" className="ml-1" onClick={() => setEditing({ event: null, calendarId: defaultCalendarId(), start: cursor })}><span className="flex items-center gap-1"><Plus size={16} /> {t("itemType.event")}</span></Button>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {mode === "month" ? (
          <MonthGrid
            winStart={winStart}
            cursor={cursor}
            occurrences={occurrences}
            todos={todos}
            onNewEvent={(d) => setEditing({ event: null, calendarId: defaultCalendarId(), start: d })}
            onOpen={(occ) => setEditing({ event: occ.event, occ: occ.start })}
          />
        ) : (
          <TimeGrid
            days={eachDay(winStart, winEnd)}
            occurrences={occurrences}
            todos={todos}
            onNewEvent={(d) => setEditing({ event: null, calendarId: defaultCalendarId(), start: d })}
            onOpen={(occ) => setEditing({ event: occ.event, occ: occ.start })}
          />
        )}
      </div>

      {/* Bottom bar — ICS import/export, shown across all calendar views.
          The buttons sit on the LEFT and the status keeps right-hand padding:
          the assistant's floating button owns the bottom-right corner, and it
          would otherwise cover Export outright and clip a long export path. */}
      <div className="flex items-center justify-between gap-3 border-t border-neutral-200 py-2 pl-3 pr-20 pb-[max(0.5rem,env(safe-area-inset-bottom))] dark:border-neutral-700 md:pb-2 md:pl-4">
        <div className="flex shrink-0 gap-2">
          <Button onClick={doImport}><span className="flex items-center gap-1.5"><Upload size={15} /> {t("calendar.importIcs")}</span></Button>
          <Button onClick={doExport}><span className="flex items-center gap-1.5"><Download size={15} /> {t("calendar.exportIcs")}</span></Button>
        </div>
        <div className="flex min-w-0 items-center justify-end gap-3">
          {errors.length > 0 && (
            <span
              className="flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-400"
              title={errors.join("\n")}
            >
              <CloudOff size={12} /> {t("calendar.someUnavailable")}
            </span>
          )}
          <span className="truncate text-xs text-neutral-400" title={msg}>{msg}</span>
        </div>
      </div>

      {editing && (
        <EventForm
          event={editing.event}
          calendarId={editing.calendarId}
          defaultStart={editing.start}
          occurrenceDate={editing.occ}
          onClose={() => setEditing(null)}
          onSaved={bump}
        />
      )}
    </div>
  );
}

function eachDay(start: Date, end: Date): Date[] {
  const days: Date[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  return days;
}

// ---------------------------------------------------------------------------
// Month grid
// ---------------------------------------------------------------------------
function MonthGrid({
  winStart, cursor, occurrences, todos, onNewEvent, onOpen,
}: {
  winStart: Date;
  cursor: Date;
  occurrences: EventOccurrence[];
  todos: TodoRow[];
  onNewEvent: (d: Date) => void;
  onOpen: (occ: EventOccurrence) => void;
}) {
  const { t: tr } = useTranslation();
  const days = eachDay(winStart, addDays(winStart, 41)); // 6 weeks

  return (
    <div className="grid grid-cols-7 border-t border-neutral-200 dark:border-neutral-700">
      {weekdayNames().map((d) => (
        <div key={d} className="truncate border-b border-r border-neutral-200 bg-neutral-50 px-1 py-1 text-center text-[11px] font-semibold text-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 md:px-2 md:text-xs">{d}</div>
      ))}
      {days.map((day) => {
        const dayOccs = occurrences.filter((o) => isSameDay(o.start, day));
        const dayTodos = todos.filter((t) => t.due_at && isSameDay(new Date(t.due_at), day));
        const inMonth = day.getMonth() === cursor.getMonth();
        return (
          <div
            key={day.toISOString()}
            onDoubleClick={() => onNewEvent(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9))}
            className={`min-h-[64px] min-w-0 border-b border-r border-neutral-200 p-0.5 dark:border-neutral-700 md:min-h-[96px] md:p-1 ${inMonth ? "" : "bg-neutral-50/60 dark:bg-neutral-900/40"}`}
          >
            <div className={`mb-1 text-right text-xs ${isToday(day) ? "font-bold text-blue-600" : "text-neutral-400"}`}>
              {isToday(day) ? <span className="rounded-full bg-blue-600 px-1.5 py-0.5 text-white">{day.getDate()}</span> : day.getDate()}
            </div>
            <div className="space-y-0.5">
              {dayOccs.map((o, i) => (
                <button
                  key={o.event.id + i}
                  onClick={() => onOpen(o)}
                  className="flex w-full items-center gap-0.5 rounded px-1 py-0.5 text-left text-[10px] text-white md:text-xs"
                  style={{ background: o.event.color ?? "#3b82f6" }}
                  title={o.event.summary}
                >
                  <span className="truncate">{o.event.all_day ? "" : fmtTime(o.start) + " "}{o.event.summary}</span>
                  {o.isRecurringInstance && <Repeat size={10} className="shrink-0 opacity-90" />}
                </button>
              ))}
              {dayTodos.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center gap-1 truncate rounded border border-dashed border-neutral-400 px-1 py-0.5 text-[10px] text-neutral-500 md:text-xs"
                  title={`${tr("itemType.todo")}: ${t.title}`}
                >
                  <Square size={10} className="shrink-0" /> <span className="truncate">{t.title}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Week / Day time grid
// ---------------------------------------------------------------------------
function TimeGrid({
  days, occurrences, todos, onNewEvent, onOpen,
}: {
  days: Date[];
  occurrences: EventOccurrence[];
  todos: TodoRow[];
  onNewEvent: (d: Date) => void;
  onOpen: (occ: EventOccurrence) => void;
}) {
  const hours = Array.from({ length: 24 }, (_, i) => i);
  // Week mode below `md` is wider than the viewport (see the day columns), and
  // the sticky hour gutter can only stick inside its containing block — so that
  // block has to span the whole scrollable width, not the visible 375px. Day
  // mode has a single column that should fill the screen, so it keeps `w-full`.
  const scrolls = days.length > 1;

  // Column widths must match between the header row and the body row so the
  // two line up; keep this identical in both places.
  const dayColClass = `flex-1 border-l border-neutral-200 dark:border-neutral-700 ${scrolls ? "min-w-[6rem] md:min-w-0" : ""}`;
  // The hour gutter is pinned while the week scrolls sideways below `md` — the
  // times are the only thing that makes a scrolled-to column readable.
  // `md:static` restores the plain column once every day fits without scrolling.
  const gutterClass = "sticky left-0 w-10 shrink-0 bg-neutral-50 dark:bg-neutral-900 md:static md:w-14 md:bg-transparent";

  return (
    // Header and body are SEPARATE rows on purpose. The hour gutter and every
    // day's hour grid then share one vertical origin (the top of the body row),
    // so an event's `top` lines up with its hour label. The header must not live
    // inside the day column above the grid: its height is variable (weekday +
    // date, plus any all-day events/todos), and a fixed spacer over the gutter
    // could never match it — which slid every timed event down by that mismatch.
    <div className={scrolls ? "w-max md:w-full" : ""}>
      {/* header row — sticks to the top as the body scrolls under it. `flex`
          stretches every day header to the tallest, so all grids below start
          at the same y even when only some days carry all-day items. */}
      <div className="sticky top-0 z-30 flex">
        {/* corner above the gutter: also pinned left so it covers the gutter
            while the week scrolls sideways */}
        <div className={`${gutterClass} sticky top-0 z-10`} />
        <div className="flex flex-1">
          {days.map((day) => {
            const allDayOccs = occurrences.filter((o) => isSameDay(o.start, day) && o.event.all_day);
            const dayTodos = todos.filter((t) => t.due_at && isSameDay(new Date(t.due_at), day));
            return (
              <div key={day.toISOString()} className={`${dayColClass} border-b bg-white py-1 text-center text-sm dark:bg-neutral-900 ${isToday(day) ? "text-blue-600" : ""}`}>
                <div className="font-semibold">{fmtWeekdayShort(day)}</div>
                <div className="text-lg">{day.getDate()}</div>
                {(allDayOccs.length > 0 || dayTodos.length > 0) && (
                  <div className="space-y-0.5 px-1 pt-1">
                    {allDayOccs.map((o, i) => (
                      <button key={i} onClick={() => onOpen(o)} className="block w-full truncate rounded px-1 text-xs text-white" style={{ background: o.event.color ?? "#3b82f6" }}>{o.event.summary}</button>
                    ))}
                    {dayTodos.map((t) => (
                      <div key={t.id} className="flex items-center gap-1 truncate rounded border border-dashed border-neutral-400 px-1 text-xs text-neutral-500"><Square size={10} className="shrink-0" /> <span className="truncate">{t.title}</span></div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* body row — hour gutter + day grids, all sharing the same top */}
      <div className="flex">
        <div className={`${gutterClass} z-20`}>
          {hours.map((h) => (
            <div key={h} style={{ height: HOUR_PX }} className="relative -top-2 pr-1 text-right text-xs text-neutral-400">
              {h === 0 ? "" : fmtHour(h)}
            </div>
          ))}
        </div>

        <div className="flex flex-1">
          {days.map((day) => {
            const dayOccs = occurrences.filter((o) => isSameDay(o.start, day) && !o.event.all_day);
            return (
              // Seven columns in 375px would be 45px each. Below `md` a day
              // keeps a legible minimum and the grid scrolls sideways instead;
              // `md:min-w-0` hands the width back to flex-1 on desktop.
              <div key={day.toISOString()} className={dayColClass}>
                <div className="relative overflow-hidden" style={{ height: 24 * HOUR_PX }}>
                  {hours.map((h) => (
                    <div
                      key={h}
                      onClick={() => onNewEvent(new Date(day.getFullYear(), day.getMonth(), day.getDate(), h))}
                      style={{ height: HOUR_PX }}
                      className="border-b border-neutral-100 hover:bg-blue-50/50 dark:border-neutral-800 dark:hover:bg-blue-900/20"
                    />
                  ))}
                  {dayOccs.map((o, i) => {
                    const startMin = o.start.getHours() * 60 + o.start.getMinutes();
                    const durMin = o.end ? Math.max((o.end.getTime() - o.start.getTime()) / 60000, 30) : 60;
                    const height = (durMin / 60) * HOUR_PX;
                    const showTime = height >= 34; // hide the time line when the block is too short to fit it
                    return (
                      <button
                        key={i}
                        onClick={() => onOpen(o)}
                        className="absolute left-1 right-1 flex flex-col overflow-hidden rounded px-1 py-0.5 text-left leading-tight text-white"
                        style={{ top: (startMin / 60) * HOUR_PX, height, background: o.event.color ?? "#3b82f6" }}
                        title={`${o.event.summary} · ${fmtTime(o.start)}`}
                      >
                        <span className="flex items-center gap-0.5 truncate text-[11px] font-medium"><span className="truncate">{o.event.summary}</span>{o.isRecurringInstance && <Repeat size={9} className="shrink-0" />}</span>
                        {showTime && <span className="truncate text-[10px] opacity-80">{fmtTime(o.start)}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
