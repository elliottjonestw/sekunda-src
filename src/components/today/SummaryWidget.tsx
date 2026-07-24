// The AI briefing.
//
// The one widget with real dependencies on what the others show: it describes
// the day's events, due items, birthdays and weather. Under self-contained
// fetching it loads those itself and states the dependency openly, rather than
// reading a sibling's state — and the shared cache in `dayData` means asking
// costs no extra queries.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, RotateCw } from "lucide-react";
import { CardShell } from "./CardShell";
import { useAsync } from "./useAsync";
import {
  loadEvents, loadTodos, loadReminders, loadPeople, loadWeather,
  weatherLocation, temperatureUnit,
} from "./dayData";
import { dueTodosFor, dueRemindersFor, reminderWhen, upcomingBirthdays } from "./derive";
import type { TodayWidget, TodayWidgetProps } from "./types";
import { summarizeDay, hasDayContent, type DaySummaryInput } from "../../lib/ai";
import { englishCondition, isForecastable } from "../../lib/weather";
import { summaryMaxAgeMs, scopedCacheKey } from "../../lib/settings";
import { isAssistantConfigured } from "../../lib/secrets";
import { currentLanguage } from "../../lib/i18n";
import { isOverdue, ageFromBirthday, toDateInput } from "../../lib/format";

const PRIORITY_NAMES = ["none", "low", "medium", "high"];
/** How far ahead the summary looks for birthdays. The tile shows 30 days, but a
 *  briefing about *today* only cares about the ones nearly here. */
const BIRTHDAY_HORIZON_DAYS = 7;

// Versioned like the weather cache: the cached value is prose built from a
// `DaySummaryInput`, so a build that changes that shape (or the prompt, or the
// model) must retire what earlier builds wrote rather than serve stale text.
// v2 also changed the key and the value's shape — see below.
const CACHE_KEY = "secondbrain.daySummary.v2";
/** How many days' summaries to keep. Enough to step around a week and back
 *  without paying for any of it twice; small enough to stay a tidy blob. */
const CACHE_MAX = 20;

/**
 * One written briefing, kept under a *day* key (`language|date`) rather than
 * under its own fact signature.
 *
 * Keying by day is what makes the age throttle possible at all: the entry a
 * changed day has to be compared against is "the briefing this day already has",
 * which a signature-keyed cache can't find. `sig` still rides along so an exact
 * fact match is always reusable regardless of age, and `at` is when it was
 * written.
 */
interface SummaryEntry {
  sig: string;
  text: string;
  at: number;
}

type SummaryCache = Record<string, SummaryEntry>;

function isEntry(v: unknown): v is SummaryEntry {
  const e = v as SummaryEntry | null;
  return !!e && typeof e.sig === "string" && typeof e.text === "string" && typeof e.at === "number";
}

function readCache(): SummaryCache {
  try {
    const raw = JSON.parse(localStorage.getItem(scopedCacheKey(CACHE_KEY)) || "null");
    if (!raw || typeof raw !== "object") return {};
    // Drop anything an older/newer shape wrote, same as the weather cache.
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => isEntry(v))) as SummaryCache;
  } catch {
    return {}; // an unreadable cache is just a miss
  }
}

function writeCache(dayKey: string, entry: SummaryEntry): void {
  try {
    const cache = readCache();
    // Re-inserting moves an entry to the end, so the oldest *untouched* one is
    // what falls off the front.
    delete cache[dayKey];
    cache[dayKey] = entry;
    const keys = Object.keys(cache);
    for (const k of keys.slice(0, Math.max(0, keys.length - CACHE_MAX))) delete cache[k];
    localStorage.setItem(scopedCacheKey(CACHE_KEY), JSON.stringify(cache));
  } catch {
    /* the cache is an optimisation, never a failure */
  }
}

/**
 * Ask for the briefing, cached against a signature of the day's facts.
 *
 * Keyed on the facts plus the UI language: navigating back to Today, stepping
 * between days, or ticking something off elsewhere and returning must not spend
 * a request re-saying the same thing.
 *
 * A real change to the day regenerates it — but only once the standing briefing
 * is older than `summaryMaxAgeMs()` (6 hours by default, off in Settings for
 * anyone who'd rather have it always current). This is the app's only request
 * the user didn't ask for, and without the hold, a morning of ticking todos off
 * buys a rewrite per tick. Age is checked when the facts change or the card
 * mounts, not on a timer: nothing is billed while nobody is looking.
 *
 * A failure isn't worth shouting about — the other cards carry the same
 * information — so it degrades to a quiet "couldn't write one" line.
 */
function useDaySummary(input: DaySummaryInput, ready: boolean) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  // The effect keys off the signature string, not the freshly-built object,
  // which is a new identity on every render.
  const latest = useRef(input);
  latest.current = input;

  const configured = isAssistantConfigured();
  // `ready` gates the REQUEST, not the card. Any mutation puts every input back
  // into loading for a moment; letting that hide the card would make it vanish
  // and reappear on every checkbox tick. Prose already on screen keeps it up.
  const show = configured && (hasDayContent(input) || !!text);
  const lang = currentLanguage();
  const sig = ready && configured && hasDayContent(input)
    ? `${lang}|${JSON.stringify(input)}`
    : "";
  const dayKey = `${lang}|${input.date}`;

  useEffect(() => {
    if (!sig) return;
    // A manual refresh (nonce > 0) deliberately ignores the cache.
    const cached = nonce === 0 ? readCache()[dayKey] : undefined;
    // Same facts: always reusable. Different facts: reusable while the standing
    // briefing is still inside the throttle window.
    if (cached && (cached.sig === sig || Date.now() - cached.at < summaryMaxAgeMs())) {
      setText(cached.text);
      setFailed(false);
      return;
    }
    const ctl = new AbortController();
    let live = true;
    // Drop the previous day's prose before fetching — leaving it up would show
    // a confident summary of a day the user has already stepped away from.
    setText(null);
    setLoading(true);
    setFailed(false);
    void summarizeDay(latest.current, ctl.signal)
      .then((t) => {
        if (!live) return;
        setText(t);
        writeCache(dayKey, { sig, text: t, at: Date.now() });
      })
      .catch(() => { if (live) { setText(null); setFailed(true); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; ctl.abort(); };
  }, [sig, dayKey, nonce]);

  return { show, text, loading, failed, refresh: () => setNonce((n) => n + 1) };
}

function Summary({ day, viewingToday, revision }: TodayWidgetProps) {
  const { t: tr } = useTranslation();
  const location = weatherLocation();
  const unit = temperatureUnit();

  const events = useAsync(() => loadEvents(day, revision), [day.getTime(), revision]);
  const todos = useAsync(() => loadTodos(revision), [revision]);
  const reminders = useAsync(() => loadReminders(revision), [revision]);
  const people = useAsync(() => loadPeople(revision), [revision]);
  const weather = useAsync(
    () => (location && isForecastable(day)
      ? loadWeather(location, day, unit, revision)
      : Promise.resolve(null)),
    [day.getTime(), revision, unit, location?.latitude, location?.longitude],
  );

  const dueTodos = dueTodosFor(todos.data ?? [], day, viewingToday);
  const dueReminders = dueRemindersFor(reminders.data ?? [], day, viewingToday);
  const birthdays = upcomingBirthdays(people.data ?? [], BIRTHDAY_HORIZON_DAYS, day);

  // Every fact the briefing may state is resolved here — occurrence times,
  // overdue flags, the age each person turns — so the model only has to write
  // prose. It notoriously gets ages and date arithmetic wrong on its own.
  const input: DaySummaryInput = {
    date: toDateInput(day),
    events: (events.data ?? []).map((o) => ({
      title: o.event.summary,
      start: o.start.toISOString(),
      all_day: !!o.event.all_day,
      location: o.event.location,
    })),
    reminders: dueReminders.map((r) => {
      const when = reminderWhen(r, day);
      return {
        title: r.title,
        due: when ? when.toISOString() : null,
        overdue: !r.rrule && !!when && isOverdue(when.toISOString()),
      };
    }),
    todos: dueTodos.map((t) => ({
      title: t.title,
      due: t.due_at,
      priority: PRIORITY_NAMES[t.priority] ?? "none",
      overdue: isOverdue(t.due_at),
    })),
    birthdays: birthdays.map((b) => {
      // The age they turn = their age *on the birthday itself*, which is what
      // ageFromBirthday returns for that date. Asking for it as of today and
      // adding one is wrong whenever the day on show isn't today.
      const on = new Date(day);
      on.setDate(on.getDate() + b.days);
      const age = b.person.birthday ? ageFromBirthday(b.person.birthday, on) : null;
      return {
        name: b.person.full_name || tr("people.newContact"),
        date: b.dateLabel,
        in_days: b.days,
        age,
      };
    }),
    // English condition text, like every other string the model reads.
    // Numbers are rounded here (not just in the prompt) so the summary's cache
    // signature is stable against the live jitter in `now`/`feels_like`/AQI —
    // a tenth of a degree would otherwise bust the cache and re-bill the same
    // summary every refresh. Whole units are the resolution the prose uses.
    weather: weather.data && location
      ? {
          place: location.name,
          condition: englishCondition(weather.data.code),
          high: Math.round(weather.data.high),
          low: Math.round(weather.data.low),
          unit: weather.data.unit,
          precipitation: weather.data.precipitation !== null ? Math.round(weather.data.precipitation) : null,
          feels_like: weather.data.feelsLike !== null ? Math.round(weather.data.feelsLike) : null,
          air_quality: weather.data.air ? Math.round(weather.data.air.usAqi) : null,
        }
      : null,
  };

  // Every input must have settled first. Writing the briefing before the
  // forecast lands would change the signature when it arrives and pay for a
  // second one saying nearly the same thing — and this request is billed.
  const ready = !events.loading && !todos.loading && !reminders.loading
    && !people.loading && !weather.loading;
  const summary = useDaySummary(input, ready);

  // With no assistant key, the card can't write anything — but rather than
  // vanish (a new account would never learn the feature exists), it shows what
  // it's for and how to switch it on, plus the reminder that Edit hides it.
  if (!isAssistantConfigured()) {
    return (
      <CardShell
        title={tr("today.summary")}
        icon={<Sparkles size={14} className="text-blue-500" />}
      >
        <div className="space-y-2 text-sm text-neutral-500 dark:text-neutral-400">
          <p>{tr("today.summaryIntro")}</p>
          <p>{tr("today.summarySetup")}</p>
          <p className="text-xs text-neutral-400">{tr("today.summaryHideHint")}</p>
        </div>
      </CardShell>
    );
  }

  // Configured but nothing to say (an empty day) means no card at all rather
  // than an empty one.
  if (!summary.show) return null;

  return (
    <CardShell
      title={tr("today.summary")}
      icon={<Sparkles size={14} className="text-blue-500" />}
      action={
        <button
          onClick={summary.refresh}
          disabled={summary.loading}
          title={tr("today.refreshSummary")}
          aria-label={tr("today.refreshSummary")}
          className="rounded p-1 text-neutral-400 hover:text-blue-500 disabled:opacity-50"
        >
          <RotateCw size={14} className={summary.loading ? "animate-spin" : ""} />
        </button>
      }
      loading={summary.loading && !summary.text}
      skeletonLines={2}
    >
      {summary.failed ? (
        <p className="text-sm text-neutral-400">{tr("today.summaryFailed")}</p>
      ) : (
        <p className="text-sm leading-relaxed">{summary.text}</p>
      )}
    </CardShell>
  );
}

export const summaryWidget: TodayWidget = {
  id: "summary",
  labelKey: "today.summary",
  Component: Summary,
};
