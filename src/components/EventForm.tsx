import { useEffect, useState } from "react";
import { AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { UnifiedEvent } from "../types";
import { LOCAL_CALENDAR_ID } from "../types";
import { allLinkTargets } from "../db";
import {
  createEvent, updateEvent, deleteEvent, skipOccurrence, listCalendars, getCalendar,
} from "../lib/calendars";
import { Button, Modal, CATEGORY_COLORS } from "./ui";
import { TagEditor, LinksPanel, PeoplePanel, LinkTarget } from "./ItemMeta";
import { toLocalInput, toDateInput, fromLocalInput, allDayIsoFromDate } from "../lib/format";
import { describeRrule, RRULE_PRESETS } from "../lib/recurrence";

export default function EventForm({
  event, calendarId, defaultStart, occurrenceDate, onClose, onSaved,
}: {
  event: UnifiedEvent | null;          // null = create
  calendarId?: string;                 // target calendar for new events
  defaultStart?: Date;                 // prefill for new events
  occurrenceDate?: Date;               // the specific instance clicked (for exdate)
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const start0 = event ? new Date(event.dtstart) : defaultStart ?? new Date();
  const end0 = event?.dtend ? new Date(event.dtend) : new Date(start0.getTime() + 60 * 60 * 1000);

  const [summary, setSummary] = useState(event?.summary ?? "");
  const [description, setDescription] = useState(event?.description ?? "");
  const [location, setLocation] = useState(event?.location ?? "");
  const [allDay, setAllDay] = useState(event?.all_day === 1);
  const [start, setStart] = useState(start0);
  const [end, setEnd] = useState(end0);
  const [rrule, setRrule] = useState<string | null>(event?.rrule ?? null);
  const [customRrule, setCustomRrule] = useState(
    event?.rrule && !RRULE_PRESETS.some((p) => p.value === event.rrule) ? event.rrule : "",
  );
  const [color, setColor] = useState(event?.color ?? CATEGORY_COLORS[0]);
  const [category, setCategory] = useState<string>(() => {
    try { return event?.categories ? (JSON.parse(event.categories)[0] ?? "") : ""; } catch { return ""; }
  });
  const [targets, setTargets] = useState<LinkTarget[]>([]);
  const [error, setError] = useState("");
  const isCustom = customRrule !== "" || (rrule != null && !RRULE_PRESETS.some((p) => p.value === rrule));

  const calendars = listCalendars().filter((c) => !c.readOnly || c.id === event?.calendarId);
  // The calendar is fixed once an event exists: moving between calendars means
  // recreating it elsewhere, which would silently drop a local event's tags,
  // links and people. Delete-and-recreate is the deliberate manual path.
  const [targetCalendar, setTargetCalendar] = useState(
    event?.calendarId ?? calendarId ?? LOCAL_CALENDAR_ID,
  );
  const activeCalendar = getCalendar(targetCalendar);
  const isLocal = (event?.source ?? activeCalendar?.source) === "local";
  const readOnly = !!(event && getCalendar(event.calendarId)?.readOnly);

  useEffect(() => { void allLinkTargets().then(setTargets); }, []);

  // Changing the start shifts the end to keep the same duration (min 1 hour),
  // so the end can never land before the start.
  function updateStart(ns: Date) {
    const prevDurationMs = end.getTime() - start.getTime();
    const durationMs = prevDurationMs > 0 ? prevDurationMs : 60 * 60 * 1000;
    setStart(ns);
    setEnd(new Date(ns.getTime() + durationMs));
  }

  // Keep end from being set before start.
  function updateEnd(ne: Date) {
    setEnd(ne <= start ? new Date(start.getTime() + 60 * 60 * 1000) : ne);
  }

  /** Run a write, surfacing failures (offline, 412 conflict) in the dialog
   * instead of closing as if it had worked. */
  async function attempt(action: () => Promise<void>) {
    setError("");
    try {
      await action();
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function save() {
    const effectiveRrule = isCustom ? (customRrule.trim() || null) : rrule;
    const draft = {
      summary: summary.trim() || t("common.untitledParen"),
      description: description || null,
      location: location || null,
      dtstart: allDay ? allDayIsoFromDate(start) : start.toISOString(),
      dtend: allDay ? null : end.toISOString(),
      all_day: allDay ? 1 : 0,
      rrule: effectiveRrule,
      exdates: event?.exdates ?? null,
      status: event?.status ?? "CONFIRMED",
      categories: category ? JSON.stringify([category]) : null,
      // Remote events take their colour from the calendar, not the event.
      color: isLocal ? color : (activeCalendar?.color ?? null),
    };
    await attempt(async () => {
      if (event) await updateEvent(event, draft);
      else await createEvent(targetCalendar, draft);
    });
  }

  async function excludeThisOccurrence() {
    if (!event || !occurrenceDate) return;
    await attempt(() => skipOccurrence(event, occurrenceDate));
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={event ? t("event.edit") : t("event.new")}
      footer={
        <>
          {event && !readOnly && (
            <Button variant="danger" onClick={() => void attempt(() => deleteEvent(event))}>
              {event.rrule ? t("event.deleteSeries") : t("common.delete")}
            </Button>
          )}
          {event?.rrule && occurrenceDate && !readOnly && (
            <Button onClick={excludeThisOccurrence}>{t("event.skipDay")}</Button>
          )}
          {!readOnly && <Button variant="primary" onClick={save}>{t("common.save")}</Button>}
        </>
      }
    >
      <div className="space-y-3">
        {error && (
          <p className="flex items-start gap-1.5 rounded-lg bg-red-50 p-2.5 text-sm text-red-600 dark:bg-red-950/40">
            <AlertCircle size={15} className="mt-0.5 shrink-0" /> {error}
          </p>
        )}
        {readOnly && (
          <p className="rounded-lg bg-neutral-100 p-2.5 text-sm text-neutral-500 dark:bg-neutral-700/50">
{t("event.readOnly")}
          </p>
        )}

        <input
          autoFocus
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder={t("event.titlePlaceholder")}
          className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-lg dark:border-neutral-600 dark:bg-neutral-700"
        />

        <label className="block text-sm">
          <span className="mb-1 block text-xs text-neutral-500">{t("event.calendar")}</span>
          <select
            value={targetCalendar}
            disabled={!!event}
            onChange={(e) => setTargetCalendar(e.target.value)}
            className="w-full rounded border border-neutral-200 px-2 py-1.5 disabled:opacity-60 dark:border-neutral-600 dark:bg-neutral-700"
          >
            {calendars.map((cal) => (
              <option key={cal.id} value={cal.id}>{cal.name}</option>
            ))}
          </select>
          {event && (
            <span className="mt-1 block text-xs text-neutral-400">
{t("event.calendarLocked")}
            </span>
          )}
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="accent-blue-600" />
          {t("event.allDay")}
        </label>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-neutral-500">{t("event.start")}</span>
            {allDay ? (
              <input type="date" value={toDateInput(start)} onChange={(e) => updateStart(new Date(e.target.value + "T00:00"))} className="w-full rounded border border-neutral-200 px-2 py-1.5 dark:border-neutral-600 dark:bg-neutral-700" />
            ) : (
              <input type="datetime-local" value={toLocalInput(start)} onChange={(e) => updateStart(new Date(fromLocalInput(e.target.value)))} className="w-full rounded border border-neutral-200 px-2 py-1.5 dark:border-neutral-600 dark:bg-neutral-700" />
            )}
          </label>
          {!allDay && (
            <label className="text-sm">
              <span className="mb-1 block text-xs text-neutral-500">{t("event.end")}</span>
              <input type="datetime-local" value={toLocalInput(end)} onChange={(e) => updateEnd(new Date(fromLocalInput(e.target.value)))} className="w-full rounded border border-neutral-200 px-2 py-1.5 dark:border-neutral-600 dark:bg-neutral-700" />
            </label>
          )}
        </div>

        <label className="block text-sm">
          <span className="mb-1 block text-xs text-neutral-500">{t("event.repeat")}</span>
          <select
            value={isCustom ? "__custom__" : (rrule ?? "__none__")}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "__custom__") { setCustomRrule(customRrule || "FREQ=WEEKLY;BYDAY=MO,WE,FR"); setRrule(null); }
              else { setCustomRrule(""); setRrule(v === "__none__" ? null : v); }
            }}
            className="w-full rounded border border-neutral-200 px-2 py-1.5 dark:border-neutral-600 dark:bg-neutral-700"
          >
            {RRULE_PRESETS.map((p) => (
              <option key={p.key} value={p.value ?? "__none__"}>{t(p.key)}</option>
            ))}
            <option value="__custom__">{t("recurrence.custom")}</option>
          </select>
        </label>
        {isCustom && (
          <div>
            <input
              value={customRrule}
              onChange={(e) => setCustomRrule(e.target.value)}
              placeholder="FREQ=WEEKLY;BYDAY=MO,WE,FR"
              className="w-full rounded border border-neutral-200 px-2 py-1.5 font-mono text-xs dark:border-neutral-600 dark:bg-neutral-700"
            />
            <p className="mt-1 text-xs text-neutral-400">{describeRrule(customRrule)}</p>
          </div>
        )}

        <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder={t("event.location")} className="w-full rounded-lg border border-neutral-200 px-3 py-1.5 text-sm dark:border-neutral-600 dark:bg-neutral-700" />
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("event.description")} rows={2} className="w-full rounded-lg border border-neutral-200 px-3 py-1.5 text-sm dark:border-neutral-600 dark:bg-neutral-700" />

        {/* Wraps below `md`: the eight swatches plus the category field don't
            fit a phone-width dialog on one line. */}
        <div className="flex flex-wrap items-center gap-3">
          <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder={t("event.category")} className="min-w-[8rem] flex-1 rounded-lg border border-neutral-200 px-3 py-1.5 text-sm dark:border-neutral-600 dark:bg-neutral-700" />
          {isLocal ? (
            <div className="flex flex-wrap gap-1">
              {CATEGORY_COLORS.map((c) => (
                <button key={c} onClick={() => setColor(c)} className={`h-6 w-6 rounded-full ${color === c ? "ring-2 ring-offset-1 ring-neutral-500" : ""}`} style={{ background: c }} />
              ))}
            </div>
          ) : (
            <span className="flex shrink-0 items-center gap-1.5 text-xs text-neutral-400">
              <span className="h-4 w-4 rounded-full" style={{ background: activeCalendar?.color ?? "#3b82f6" }} />
  {t("event.calendarColour")}
            </span>
          )}
        </div>

        {/* Tags, people and links are rows in SQLite keyed by a local event id,
            so they only apply to events in the built-in calendar. */}
        {event && event.source === "local" && (
          <>
            <hr className="border-neutral-200 dark:border-neutral-700" />
            <TagEditor type="event" id={event.id} />
            <PeoplePanel type="event" id={event.id} />
            <LinksPanel type="event" id={event.id} targets={targets} />
          </>
        )}
        {event && event.source !== "local" && (
          <p className="border-t border-neutral-200 pt-3 text-xs text-neutral-400 dark:border-neutral-700">
{t("event.localOnlyMeta", { calendar: getCalendar(LOCAL_CALENDAR_ID)?.name })}
          </p>
        )}
      </div>
    </Modal>
  );
}
