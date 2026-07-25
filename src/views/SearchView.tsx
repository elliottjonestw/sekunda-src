import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CloudOff, Mail, NotebookPen } from "lucide-react";
import type { ItemType, GoTo } from "../types";
import { searchNotes, searchPeople, searchReminders, searchTodos } from "../db";
import { searchEvents, listCalendars, getCalendar } from "../lib/calendars";
import { getMailSettings } from "../lib/settings";
import { searchMail, type MailAddress, type MailMessageSummary } from "../lib/mail";
import { fmtDate, fmtDateTime, startOfDay, endOfDay } from "../lib/format";
import { ItemCard, VIEW_FOR, targetFor } from "../components/ItemCard";
import { Button } from "../components/ui";

interface Hit {
  type: ItemType;
  id: string;
  label: string;
  sub: string;
  /** Events only — needed to re-fetch a remote event and to open the right
   *  occurrence of a recurring series. */
  calendarId?: string;
  occurrenceStart?: string;
}

/**
 * How far either side of today connected calendars are searched, in months.
 *
 * CalDAV has no keyword search — the only server-side filter is a time-range —
 * so remote results exist only inside a window, and the user is told which one.
 * The steps widen rather than reset, and lean backwards: people search for
 * things they've half-forgotten, which are usually behind them.
 */
const WINDOW_STEPS: { back: number; ahead: number }[] = [
  { back: 12, ahead: 12 },
  { back: 36, ahead: 24 },
  { back: 120, ahead: 60 },
];

/**
 * Mail is searched on its own, slower clock.
 *
 * A mail keystroke is a TLS handshake and a login to iCloud — the same cost
 * `MailView` debounces 500ms for — so it must not ride the 250ms beat the local
 * sources use. It is also inbox-only (IMAP SEARCH is per-mailbox and has no
 * ranking, so this is the newest slice of a match set, never the best of it)
 * and gated on a connected account, so a user without mail pays nothing.
 */
const MAIL_DEBOUNCE_MS = 500;
const MAIL_SEARCH_LIMIT = 25;

function senderLabel(from: MailAddress[]): string {
  const first = from[0];
  if (!first) return "";
  return first.name ?? first.address;
}

/** Whole days, so the window is stable between keystrokes and hits the 60s
 *  per-calendar cache in calendars.ts instead of refetching on every character. */
function windowFor(step: number): [Date, Date] {
  const { back, ahead } = WINDOW_STEPS[Math.min(step, WINDOW_STEPS.length - 1)];
  const from = new Date();
  from.setMonth(from.getMonth() - back);
  const to = new Date();
  to.setMonth(to.getMonth() + ahead);
  return [startOfDay(from), endOfDay(to)];
}

export default function SearchView({ query, goTo }: { query: string; goTo: GoTo }) {
  const { t } = useTranslation();
  const [hits, setHits] = useState<Hit[]>([]);
  // Diary entries live in the notes table but route to the Diary view by date,
  // and they aren't an ItemType (no card), so they get their own hit list.
  const [diaryHits, setDiaryHits] = useState<{ id: string; date: string; label: string; sub: string }[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);

  // Only worth naming a window when something is actually searched by one.
  const hasRemote = useMemo(
    () => listCalendars().some((c) => c.source === "caldav" && c.visible),
    [],
  );
  const [winStart, winEnd] = useMemo(() => windowFor(step), [step]);

  // Mail is a separate source with a separate lifecycle: a connected account,
  // its own slower debounce, and an error that must be surfaced independently
  // (a dead inbox must not blank the local results).
  const mailAccount = useMemo(() => getMailSettings().account, []);
  const [mailHits, setMailHits] = useState<MailMessageSummary[]>([]);
  const [mailError, setMailError] = useState("");
  const [mailLoading, setMailLoading] = useState(false);

  useEffect(() => {
    if (!mailAccount) return;
    const q = query.trim();
    if (!q) { setMailHits([]); setMailError(""); setMailLoading(false); return; }

    setMailLoading(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          // Inbox-only: no `mailbox`, so `searchMail` defaults to INBOX.
          const found = await searchMail(mailAccount, { query: q, limit: MAIL_SEARCH_LIMIT });
          if (cancelled) return;
          setMailError("");
          setMailHits(found.results);
        } catch (e) {
          if (cancelled) return;
          setMailError(e instanceof Error ? e.message : String(e));
          setMailHits([]);
        } finally {
          if (!cancelled) setMailLoading(false);
        }
      })();
    }, MAIL_DEBOUNCE_MS);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, mailAccount]);

  useEffect(() => {
    const q = query.trim();
    if (!q) { setHits([]); setDiaryHits([]); setErrors([]); setLoading(false); return; }

    // Debounced because a keystroke can now cost a CalDAV round-trip.
    setLoading(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const [events, reminders, todos, noteRows, people] = await Promise.all([
          searchEvents(q, winStart, winEnd),
          searchReminders(q),
          searchTodos(q),
          // No kind filter: this is the one place notes and diary are searched
          // together, then split by kind so each routes to the right view.
          searchNotes(q),
          searchPeople(q),
        ]);
        if (cancelled) return;

        const notes = noteRows.filter((n) => n.kind !== "diary");
        setDiaryHits(
          noteRows
            .filter((n) => n.kind === "diary" && n.entry_date)
            .map((n) => ({
              id: n.id,
              date: n.entry_date as string,
              label: fmtDate(new Date(`${n.entry_date}T00:00:00`)),
              sub: n.title?.trim() || (n.body ?? "").slice(0, 60),
            })),
        );

        setErrors(events.errors);
        setHits([
          ...events.hits.map((h) => {
            const cal = getCalendar(h.event.calendarId);
            const when = fmtDateTime(h.start.toISOString());
            return {
              type: "event" as ItemType,
              id: h.event.id,
              label: h.event.summary,
              // Which calendar it came from matters here in a way it doesn't
              // elsewhere: results from several calendars interleave by date.
              sub: cal && cal.source === "caldav" ? `${when} · ${cal.name}` : when,
              calendarId: h.event.calendarId,
              occurrenceStart: h.start.toISOString(),
            };
          }),
          ...reminders.map((r) => ({ type: "reminder" as ItemType, id: r.id, label: r.title, sub: r.due_at ? t("card.due", { when: fmtDateTime(r.due_at) }) : "" })),
          ...todos.map((td) => ({ type: "todo" as ItemType, id: td.id, label: td.title, sub: td.due_at ? t("card.due", { when: fmtDateTime(td.due_at) }) : "" })),
          ...notes.map((n) => ({ type: "note" as ItemType, id: n.id, label: n.title || t("common.untitled"), sub: (n.body ?? "").slice(0, 60) })),
          ...people.map((p) => ({ type: "person" as ItemType, id: p.id, label: p.full_name || t("people.newContact"), sub: p.organization || p.nickname || "" })),
        ]);
        setLoading(false);
      })();
    }, 250);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, winStart, winEnd, t]);

  const canWiden = step < WINDOW_STEPS.length - 1;
  const nothing = hits.length === 0 && diaryHits.length === 0 && mailHits.length === 0;
  const busy = loading || mailLoading;

  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto p-4 md:p-6">
      <h1 className="mb-4 text-xl font-bold">{t("search.resultsFor", { query })}</h1>
      {query.trim() === "" ? (
        <p className="text-neutral-400">{t("search.prompt")}</p>
      ) : (
        <>
          {errors.length > 0 && (
            <p className="mb-3 flex items-start gap-2 text-sm text-amber-600 dark:text-amber-500">
              <CloudOff size={15} className="mt-0.5 shrink-0" />
              <span>{t("search.calendarsUnavailable", { names: errors.join("; ") })}</span>
            </p>
          )}
          {mailError && (
            <p className="mb-3 flex items-start gap-2 text-sm text-amber-600 dark:text-amber-500">
              <CloudOff size={15} className="mt-0.5 shrink-0" />
              <span>{t("search.mailUnavailable", { error: mailError })}</span>
            </p>
          )}
          {nothing ? (
            <p className="text-neutral-400">{busy ? t("search.searching") : t("search.noMatches")}</p>
          ) : (
            <div className="space-y-1">
              {hits.map((h) => (
                // One recurring id has many starts; keying on id alone would
                // collapse them into a single row.
                <ItemCard
                  key={`${h.type}|${h.id}|${h.occurrenceStart ?? ""}`}
                  type={h.type}
                  label={h.label}
                  sub={h.sub}
                  onClick={() => goTo(VIEW_FOR[h.type], targetFor(h))}
                />
              ))}
              {/* Diary entries route to the Diary view by date, not through
                  ItemCard (they aren't an ItemType), so they get their own row. */}
              {diaryHits.map((d) => (
                <button
                  key={`diary|${d.id}`}
                  onClick={() => goTo("diary", { diaryDate: d.date })}
                  className="flex w-full items-center gap-3 rounded-lg border border-neutral-200 px-3 py-2 text-left hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
                >
                  <NotebookPen size={18} className="shrink-0 text-neutral-500" />
                  <span className="flex-1 min-w-0">
                    <span className="block truncate font-medium">{d.label}</span>
                    {d.sub && <span className="block truncate text-xs text-neutral-400">{d.sub}</span>}
                  </span>
                  <span className="shrink-0 text-xs text-neutral-400">{t("nav.diary")}</span>
                </button>
              ))}
              {/* Mail isn't an ItemType — it has no row, no tags, no links — so
                  it can't go through ItemCard. It gets its own row that opens
                  the message in the Mail reader, carrying the summary itself. */}
              {mailHits.map((m) => (
                <button
                  key={`mail|${m.mailbox}|${m.uid}`}
                  onClick={() => goTo("mail", { mail: m })}
                  className="flex w-full items-center gap-3 rounded-lg border border-neutral-200 px-3 py-2 text-left hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
                >
                  <Mail size={18} className="shrink-0 text-neutral-500" />
                  <span className="flex-1 min-w-0">
                    <span className="block truncate font-medium">{m.subject || t("common.untitled")}</span>
                    <span className="block truncate text-xs text-neutral-400">
                      {[senderLabel(m.from), m.date ? fmtDateTime(m.date) : ""].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-neutral-400">{t("itemType.email")}</span>
                </button>
              ))}
            </div>
          )}
          {mailAccount && mailHits.length > 0 && (
            <p className="mt-3 text-xs text-neutral-500">{t("search.mailNote")}</p>
          )}
          {hasRemote && (
            <div className="mt-6 flex items-center gap-3 border-t border-neutral-200 pt-3 text-xs text-neutral-500 dark:border-neutral-700">
              <span>{t("search.remoteWindow", { from: fmtDate(winStart), to: fmtDate(winEnd) })}</span>
              {canWiden && (
                <Button variant="ghost" onClick={() => setStep((s) => s + 1)}>
                  {t("search.widen")}
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
