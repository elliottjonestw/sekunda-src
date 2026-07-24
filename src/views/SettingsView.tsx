import { ReactNode, useEffect, useRef, useState } from "react";
import {
  Eye, EyeOff, Check, CalendarDays, ExternalLink, Loader2, AlertCircle,
  Sparkles, Mic, Languages, Database, Download, Upload, LucideIcon,
  Trash2, Volume2, MapPin, X, ChevronUp, ChevronDown,
  UserCog, MailCheck, MailWarning, LayoutGrid, Rss, Inbox,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  getSettings, saveSettings, getCalendarSettings, saveCalendarSettings,
  getMailSettings, saveMailSettings,
  MIN_SPEECH_RATE, MAX_SPEECH_RATE, clampSpeechRate,
  MIN_SUMMARY_MAX_AGE_HOURS, MAX_SUMMARY_MAX_AGE_HOURS, clampSummaryMaxAge,
  MIN_RSS_ITEMS, MAX_RSS_ITEMS, MAX_FEEDS, clampRssItemCount, OPENAI_MODELS,
  type AppSettings, type CalDavAccount, type TtsEngine,
  type TemperatureUnit, type WeatherLocation, type StockSymbol, type RssFeed,
} from "../lib/settings";
import { fetchFeed, normalizeFeedUrl, hostOf, invalidateFeed } from "../lib/rss";
import {
  LANGUAGES, SYSTEM_LANGUAGE, changeLanguage, matchSystemLanguage, currentLanguage,
} from "../lib/i18n";
import {
  applyTheme, systemTheme, THEME_PREFERENCES, type ThemePreference,
} from "../lib/theme";
import { searchPlaces, type PlaceResult } from "../lib/weather";
import { searchSymbols, MAX_WATCHLIST, type SymbolResult } from "../lib/stocks";
import {
  hasVoiceFor, listVoices, previewVoice, previewNaturalVoice, getLastNaturalError,
  type VoiceOption,
} from "../lib/voice";
import { OPENAI_VOICES, DEFAULT_OPENAI_VOICE } from "../lib/openaiTts";
import { discoverAccount } from "../lib/caldav/discovery";
import { invalidateCache, listCalendars, setCalendarVisible, LOCAL_CALENDAR_NAME } from "../lib/calendars";
import { LOCAL_CALENDAR_ID } from "../types";
import {
  getOpenAiKey, setOpenAiKey, getCalDavPassword, setCalDavPassword,
  getMailPassword, setMailPassword,
} from "../lib/secrets";
import { clearMailCache, icloudAccount, listFolders } from "../lib/mail";
import { isTauri } from "../lib/platform";
import { exportBackup, importBackup } from "../lib/backup";
import { clearAllData, newId } from "../db";
import { deleteAccount, resendVerification } from "../lib/auth";
import { getCachedSession } from "../lib/authStore";
import { ApiError, OfflineError } from "../lib/api";
import { Button } from "../components/ui";

// Where each credential is issued AND revoked. Both are linked from the field
// that holds them: these secrets sit in plaintext on the device, so the user's
// ability to revoke a lost one is a real part of the mitigation, not a
// convenience — see the header of lib/secrets.ts.
const APPLE_PASSWORD_URL = "https://account.apple.com/account/manage";
const OPENAI_KEYS_URL = "https://platform.openai.com/api-keys";

type Section = "general" | "account" | "widgets" | "assistant" | "voice" | "calendars" | "mail" | "data";

const SECTIONS: { id: Section; labelKey: `settings.sections.${Section}`; icon: LucideIcon }[] = [
  { id: "general", labelKey: "settings.sections.general", icon: Languages },
  { id: "account", labelKey: "settings.sections.account", icon: UserCog },
  { id: "widgets", labelKey: "settings.sections.widgets", icon: LayoutGrid },
  { id: "assistant", labelKey: "settings.sections.assistant", icon: Sparkles },
  { id: "voice", labelKey: "settings.sections.voice", icon: Mic },
  { id: "calendars", labelKey: "settings.sections.calendars", icon: CalendarDays },
  { id: "mail", labelKey: "settings.sections.mail", icon: Inbox },
  { id: "data", labelKey: "settings.sections.data", icon: Database },
];

export default function SettingsView() {
  const { t } = useTranslation();
  const [section, setSection] = useState<Section>("general");

  // The AI settings live here rather than in the panes so switching sections
  // doesn't unmount the inputs and throw away unsaved edits.
  const initial = getSettings();
  const [draft, setDraft] = useState<AppSettings>(initial);
  // The API key is state of its own rather than a field of the draft: it isn't
  // part of AppSettings any more (see lib/secrets.ts), and keeping it separate
  // is what stops a future `saveSettings(draft)` from carrying a credential.
  const [apiKey, setApiKey] = useState(getOpenAiKey());
  const [saved, setSaved] = useState(false);
  const patch = (p: Partial<AppSettings>) => setDraft((d) => ({ ...d, ...p }));

  // Field by field, not `saveSettings(draft)`: the draft is a whole AppSettings,
  // so spreading it would let this button write back the General pane's values
  // as they were when this view mounted. A new field on these panes must be
  // added here too, or Save silently ignores it.
  function save() {
    setOpenAiKey(apiKey);
    saveSettings({
      openaiModel: draft.openaiModel.trim() || "gpt-5-nano",
      sttModel: draft.sttModel.trim() || "whisper-1",
      ttsEngine: draft.ttsEngine,
      ttsModel: draft.ttsModel.trim() || "gpt-4o-mini-tts",
      openaiVoice: draft.openaiVoice,
      speechRate: clampSpeechRate(draft.speechRate),
      preferredVoices: draft.preferredVoices,
      summaryThrottle: draft.summaryThrottle,
      webSearch: draft.webSearch,
      summaryMaxAgeHours: clampSummaryMaxAge(draft.summaryMaxAgeHours),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    // Column below `md` (the section nav becomes a strip above the pane), row
    // from `md` — the original two-pane layout, unchanged.
    <div className="flex h-full flex-col md:flex-row">
      <aside className="shrink-0 border-b border-neutral-200 p-3 dark:border-neutral-700 md:w-48 md:border-b-0 md:border-r">
        <h3 className="mb-2 text-xs font-semibold uppercase text-neutral-400">{t("settings.title")}</h3>
        <div className="flex gap-2 overflow-x-auto md:block">
        {SECTIONS.map((s) => {
          const Icon = s.icon;
          return (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`flex w-auto shrink-0 items-center gap-2 whitespace-nowrap rounded px-2 py-1.5 text-sm md:w-full md:whitespace-normal ${
                section === s.id ? "bg-blue-100 dark:bg-blue-900/40" : "hover:bg-neutral-100 dark:hover:bg-neutral-700"
              }`}
            >
              <Icon size={16} className="shrink-0 text-neutral-500" />
              <span className="min-w-0 truncate">{t(s.labelKey)}</span>
            </button>
          );
        })}
        </div>
        {/* Advice that belongs beside the panes, not above them: on a phone it
            would push the first setting off the screen. */}
        <p className="mt-4 hidden px-2 text-xs leading-relaxed text-neutral-400 md:block">
          {t("settings.storedLocally")}
        </p>
      </aside>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-8">
        <div className="mx-auto max-w-2xl">
          {section === "general" && <GeneralSettings />}
          {section === "account" && <AccountSettings />}
          {section === "widgets" && <WidgetSettings />}
          {section === "assistant" && (
            <AssistantSettings
              draft={draft} patch={patch} apiKey={apiKey} setApiKey={setApiKey}
              onSave={save} saved={saved}
            />
          )}
          {section === "voice" && (
            <VoiceSettings
              draft={draft} patch={patch} apiKey={apiKey} setApiKey={setApiKey}
              onSave={save} saved={saved}
            />
          )}
          {section === "calendars" && <CalendarSettingsPane />}
          {section === "mail" && <MailSettingsPane />}
          {section === "data" && <DataSettings />}
          {/* The sidebar's footnote, which below `md` follows the pane rather
              than sitting above it and pushing the first setting off screen. */}
          <p className="mt-8 text-xs leading-relaxed text-neutral-400 md:hidden">
            {t("settings.storedLocally")}
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------
function PaneHeader({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-6">
      <h1 className="mb-1 text-2xl font-bold">{title}</h1>
      <p className="text-sm leading-relaxed text-neutral-500">{children}</p>
    </div>
  );
}

const INPUT_CLASS =
  "w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-blue-400 dark:border-neutral-600 dark:bg-neutral-800";

function Field({
  label, hint, children,
}: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-5">
      <label className="mb-1.5 block text-sm font-medium">{label}</label>
      {children}
      {hint && <p className="mt-1.5 text-xs leading-relaxed text-neutral-400">{hint}</p>}
    </div>
  );
}

/** Password-style input with a reveal toggle. */
function SecretInput({
  value, onChange, placeholder, mono = true,
}: { value: string; onChange: (v: string) => void; placeholder: string; mono?: boolean }) {
  const { t } = useTranslation();
  const [reveal, setReveal] = useState(false);
  return (
    <div className="relative">
      <input
        type={reveal ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className={`${INPUT_CLASS} pr-10 ${mono ? "font-mono" : ""}`}
      />
      <button
        type="button"
        onClick={() => setReveal((v) => !v)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600"
        aria-label={reveal ? t("settings.hide") : t("settings.show")}
      >
        {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  );
}

/** An inline link out to the browser. `openUrl` rather than an <a>: a packaged
 *  build must not navigate the webview away from the app. */
function ExternalLinkButton({ url, label }: { url: string; label: string }) {
  return (
    <button
      type="button"
      onClick={() => void openUrl(url)}
      className="inline-flex items-center gap-1 text-blue-500 hover:underline"
    >
      {label} <ExternalLink size={11} />
    </button>
  );
}

function SaveRow({ onSave, saved }: { onSave: () => void; saved: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 border-t border-neutral-200 pt-5 dark:border-neutral-700">
      <Button variant="primary" onClick={onSave}>{t("common.save")}</Button>
      {saved && (
        <span className="flex items-center gap-1 text-sm text-green-600">
          <Check size={16} /> {t("settings.saved")}
        </span>
      )}
    </div>
  );
}

function Notice({ tone, children }: { tone: "error" | "info"; children: ReactNode }) {
  const styles = tone === "error"
    ? "bg-red-50 text-red-600 dark:bg-red-950/40"
    : "bg-neutral-100 text-neutral-500 dark:bg-neutral-700/50";
  return (
    <p className={`flex items-start gap-1.5 rounded-lg p-3 text-sm leading-relaxed ${styles}`}>
      {tone === "error" && <AlertCircle size={15} className="mt-0.5 shrink-0" />}
      <span>{children}</span>
    </p>
  );
}

interface PaneProps {
  draft: AppSettings;
  patch: (p: Partial<AppSettings>) => void;
  /** The OpenAI key, carried separately from the draft — see lib/secrets.ts. */
  apiKey: string;
  setApiKey: (v: string) => void;
  onSave: () => void;
  saved: boolean;
}

// ---------------------------------------------------------------------------
// General (language)
// ---------------------------------------------------------------------------
function GeneralSettings() {
  const { t } = useTranslation();
  const [language, setLanguage] = useState(getSettings().language);
  const [theme, setTheme] = useState(getSettings().theme);

  // Applied immediately rather than on a Save button: the whole point of a
  // language picker is seeing the result, and there's nothing to validate.
  function pick(value: string) {
    setLanguage(value);
    saveSettings({ language: value });
    void changeLanguage(value);
  }

  // Same rule as the language: applied on change, not on Save. There is
  // nothing to validate, and the result *is* the preview.
  function pickTheme(value: ThemePreference) {
    setTheme(value);
    saveSettings({ theme: value });
    applyTheme(value);
  }

  const systemMatch = LANGUAGES.find((l) => l.code === matchSystemLanguage(navigator.language || "en"));
  const themeLabel = { system: "themeSystem", light: "themeLight", dark: "themeDark" } as const;

  return (
    <>
      <PaneHeader title={t("settings.general.title")}>
        {t("settings.general.description")}
      </PaneHeader>

      <Field label={t("settings.general.language")} hint={t("settings.general.languageHint")}>
        <select
          value={language}
          onChange={(e) => pick(e.target.value)}
          className={INPUT_CLASS}
        >
          <option value={SYSTEM_LANGUAGE}>
            {t("settings.general.systemOption", { language: systemMatch?.nativeName ?? "English" })}
          </option>
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>{l.nativeName}</option>
          ))}
        </select>
      </Field>

      <Field label={t("settings.general.appearance")} hint={t("settings.general.appearanceHint")}>
        <select
          value={theme}
          onChange={(e) => pickTheme(e.target.value as ThemePreference)}
          className={INPUT_CLASS}
        >
          {THEME_PREFERENCES.map((p) => (
            <option key={p} value={p}>
              {p === "system"
                // Name what the OS is currently asking for, so "system" isn't
                // an unexplained third state.
                ? t("settings.general.themeSystem", { theme: t(`settings.general.${themeLabel[systemTheme()]}`) })
                : t(`settings.general.${themeLabel[p]}`)}
            </option>
          ))}
        </select>
      </Field>

    </>
  );
}

// ---------------------------------------------------------------------------
// Widgets — what the Today page's cards show
//
// Its own section rather than a tail on General, because these four settings
// have nothing to do with how the app is displayed and everything to do with
// one page's contents. They also share a property nothing in General has: they
// FOLLOW THE ACCOUNT (see the cloud-sync note in lib/settings.ts), so the pane
// says so once rather than repeating it per field.
//
// Every editor here saves on change rather than behind a Save button, the same
// rule the language and theme pickers follow: there is nothing to validate that
// the pickers haven't already validated, and the result is the preview.
// ---------------------------------------------------------------------------
function WidgetSettings() {
  const { t } = useTranslation();
  const [location, setLocation] = useState(getSettings().weatherLocation);
  const [unit, setUnit] = useState(getSettings().temperatureUnit);
  const [watchlist, setWatchlist] = useState(getSettings().watchlist);
  const [feeds, setFeeds] = useState(getSettings().rssFeeds);
  const [itemCount, setItemCount] = useState(getSettings().rssItemCount);

  return (
    <>
      <PaneHeader title={t("settings.widgets.title")}>
        {t("settings.widgets.description")}
      </PaneHeader>

      <Field label={t("settings.widgets.weatherLocation")} hint={t("settings.widgets.weatherHint")}>
        <WeatherLocationPicker
          location={location}
          onPick={(loc) => { setLocation(loc); saveSettings({ weatherLocation: loc }); }}
        />
      </Field>

      {/* Only worth asking once there's weather to show. */}
      {location && (
        <Field label={t("settings.widgets.temperatureUnit")}>
          <select
            value={unit}
            onChange={(e) => {
              const next = e.target.value as TemperatureUnit;
              setUnit(next);
              saveSettings({ temperatureUnit: next });
            }}
            className={INPUT_CLASS}
          >
            <option value="celsius">{t("settings.widgets.celsius")}</option>
            <option value="fahrenheit">{t("settings.widgets.fahrenheit")}</option>
          </select>
        </Field>
      )}

      <Field label={t("settings.widgets.watchlist")} hint={t("settings.widgets.watchlistHint")}>
        <WatchlistEditor
          watchlist={watchlist}
          onChange={(next) => { setWatchlist(next); saveSettings({ watchlist: next }); }}
        />
      </Field>

      <Field label={t("settings.widgets.feeds")} hint={t("settings.widgets.feedsHint")}>
        <FeedEditor
          feeds={feeds}
          onChange={(next) => { setFeeds(next); saveSettings({ rssFeeds: next }); }}
        />
      </Field>

      {/* Only worth asking once there's something to count. */}
      {!!feeds.length && (
        <Field label={t("settings.widgets.rssItemCount")} hint={t("settings.widgets.rssItemCountHint")}>
          <input
            type="number"
            min={MIN_RSS_ITEMS}
            max={MAX_RSS_ITEMS}
            value={itemCount}
            onChange={(e) => setItemCount(Number(e.target.value))}
            // Clamped on blur, not on change: clamping mid-typing turns a
            // half-typed "10" into "1" and then fights the user for the "0".
            onBlur={() => {
              const next = clampRssItemCount(itemCount);
              setItemCount(next);
              saveSettings({ rssItemCount: next });
            }}
            className={`${INPUT_CLASS} w-24`}
          />
        </Field>
      )}
    </>
  );
}

/**
 * The Today feed card's subscriptions: add by URL, reorder, remove.
 *
 * Adding FETCHES the feed before accepting it, which is why this has a busy
 * state and an error notice rather than just appending a string. Two things
 * come of that round-trip: the channel's real title, so the list and the card
 * can name the source, and an immediate answer to the commonest mistake —
 * pasting a site's home page instead of its feed. Storing an unverified URL
 * would defer that failure to the Today page, where it can only appear as a
 * card that quietly shows less than it should.
 *
 * Reordering is ▲/▼ buttons, not drag — HTML5 drag does not work in this
 * webview, confirmed everywhere it was tried.
 */
/** Why an add failed. A map rather than a built key, so every one of these is
 *  checked against the catalog at compile time. */
const FEED_ERRORS = {
  invalid: "settings.widgets.feedInvalid",
  duplicate: "settings.widgets.feedDuplicate",
  unreachable: "settings.widgets.feedUnreachable",
} as const;

function FeedEditor({
  feeds, onChange,
}: { feeds: RssFeed[]; onChange: (next: RssFeed[]) => void }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<"invalid" | "unreachable" | "duplicate" | null>(null);

  // Aborts the previous check when a new one starts, so a fast double-Enter
  // can't add the earlier feed after the later one.
  const ctlRef = useRef<AbortController | null>(null);
  useEffect(() => () => ctlRef.current?.abort(), []);

  const full = feeds.length >= MAX_FEEDS;

  async function add() {
    const normalized = normalizeFeedUrl(url);
    if (!normalized) { setFailed("invalid"); return; }
    if (feeds.some((f) => f.url === normalized)) { setFailed("duplicate"); return; }

    ctlRef.current?.abort();
    const ctl = new AbortController();
    ctlRef.current = ctl;
    setBusy(true);
    setFailed(null);
    try {
      const feed = await fetchFeed(normalized, ctl.signal);
      onChange([...feeds, { id: newId(), url: normalized, title: feed.title || hostOf(normalized) }]);
      setUrl("");
    } catch {
      if (ctl.signal.aborted) return;
      setFailed("unreachable");
    } finally {
      if (!ctl.signal.aborted) setBusy(false);
    }
  }

  function move(index: number, delta: number) {
    const to = index + delta;
    if (to < 0 || to >= feeds.length) return;
    const next = [...feeds];
    [next[index], next[to]] = [next[to], next[index]];
    onChange(next);
  }

  function remove(feed: RssFeed) {
    // Drop the cached articles too, so re-adding the feed later doesn't show
    // whatever was current when it was removed.
    invalidateFeed(feed.url);
    onChange(feeds.filter((f) => f.id !== feed.id));
  }

  return (
    <div>
      {!!feeds.length && (
        <ul className="mb-2 overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-600">
          {feeds.map((f, i) => (
            <li
              key={f.id}
              className="flex items-center gap-2 border-b border-neutral-100 px-3 py-2 last:border-0 dark:border-neutral-700"
            >
              <Rss size={14} className="shrink-0 text-neutral-400" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{f.title}</div>
                <div className="truncate text-xs text-neutral-400">{hostOf(f.url)}</div>
              </div>
              <button
                onClick={() => move(i, -1)}
                disabled={i === 0}
                className="text-neutral-400 hover:text-blue-500 disabled:opacity-30 disabled:hover:text-neutral-400"
                aria-label={t("settings.widgets.moveUp")}
                title={t("settings.widgets.moveUp")}
              >
                <ChevronUp size={15} />
              </button>
              <button
                onClick={() => move(i, 1)}
                disabled={i === feeds.length - 1}
                className="text-neutral-400 hover:text-blue-500 disabled:opacity-30 disabled:hover:text-neutral-400"
                aria-label={t("settings.widgets.moveDown")}
                title={t("settings.widgets.moveDown")}
              >
                <ChevronDown size={15} />
              </button>
              <button
                onClick={() => remove(f)}
                className="text-neutral-400 hover:text-red-500"
                aria-label={t("settings.widgets.removeFeed")}
                title={t("settings.widgets.removeFeed")}
              >
                <X size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {full ? (
        <p className="text-xs text-neutral-400">
          {t("settings.widgets.feedsFull", { count: MAX_FEEDS })}
        </p>
      ) : (
        <div className="flex gap-2">
          <input
            value={url}
            onChange={(e) => { setUrl(e.target.value); setFailed(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
            placeholder={t("settings.widgets.feedPlaceholder")}
            spellCheck={false}
            autoComplete="off"
            className={INPUT_CLASS}
          />
          <Button onClick={() => void add()} disabled={busy || !url.trim()}>
            {busy ? t("common.loading") : t("settings.widgets.addFeed")}
          </Button>
        </div>
      )}

      {failed && <div className="mt-2"><Notice tone="error">{t(FEED_ERRORS[failed])}</Notice></div>}
    </div>
  );
}

/**
 * The Today ticker's symbols: search, add, reorder, remove.
 *
 * Reordering is ▲/▼ buttons, not drag — HTML5 drag does not work in this
 * webview, confirmed in every place it was tried. Buttons are also the only
 * version of this that a keyboard can reach.
 *
 * Search is explicit (button or Enter) rather than as-you-type, same as the
 * place picker: this asks a third-party service a question, and firing one
 * request per keystroke to set a value once is rude to it and pointless for us.
 */
function WatchlistEditor({
  watchlist, onChange,
}: { watchlist: StockSymbol[]; onChange: (next: StockSymbol[]) => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SymbolResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // Aborts the previous search when a new one starts, so a fast double-Enter
  // can't land the earlier results over the later ones.
  const ctlRef = useRef<AbortController | null>(null);
  useEffect(() => () => ctlRef.current?.abort(), []);

  const full = watchlist.length >= MAX_WATCHLIST;

  async function search() {
    if (!query.trim()) return;
    ctlRef.current?.abort();
    const ctl = new AbortController();
    ctlRef.current = ctl;
    setBusy(true);
    setFailed(false);
    try {
      setResults(await searchSymbols(query, ctl.signal));
    } catch {
      // Aborted requests are expected on a re-search; only a real failure flips
      // to the error notice.
      if (ctl.signal.aborted) return;
      setResults(null);
      setFailed(true);
    } finally {
      if (!ctl.signal.aborted) setBusy(false);
    }
  }

  function add(hit: SymbolResult) {
    // Adding the same ticker twice would fetch it twice and draw it twice.
    if (full || watchlist.some((s) => s.symbol === hit.symbol)) return;
    onChange([...watchlist, { symbol: hit.symbol, name: hit.name }]);
    setResults(null);
    setQuery("");
  }

  function move(index: number, delta: number) {
    const to = index + delta;
    if (to < 0 || to >= watchlist.length) return;
    const next = [...watchlist];
    [next[index], next[to]] = [next[to], next[index]];
    onChange(next);
  }

  return (
    <div>
      {!!watchlist.length && (
        <ul className="mb-2 overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-600">
          {watchlist.map((s, i) => (
            <li
              key={s.symbol}
              className="flex items-center gap-2 border-b border-neutral-100 px-3 py-2 last:border-0 dark:border-neutral-700"
            >
              <div className="min-w-0 flex-1">
                <span className="text-sm font-medium">{s.symbol}</span>
                <span className="ml-2 truncate text-xs text-neutral-400">{s.name}</span>
              </div>
              <button
                onClick={() => move(i, -1)}
                disabled={i === 0}
                className="text-neutral-400 hover:text-blue-500 disabled:opacity-30 disabled:hover:text-neutral-400"
                aria-label={t("settings.widgets.moveUp")}
                title={t("settings.widgets.moveUp")}
              >
                <ChevronUp size={15} />
              </button>
              <button
                onClick={() => move(i, 1)}
                disabled={i === watchlist.length - 1}
                className="text-neutral-400 hover:text-blue-500 disabled:opacity-30 disabled:hover:text-neutral-400"
                aria-label={t("settings.widgets.moveDown")}
                title={t("settings.widgets.moveDown")}
              >
                <ChevronDown size={15} />
              </button>
              <button
                onClick={() => onChange(watchlist.filter((w) => w.symbol !== s.symbol))}
                className="text-neutral-400 hover:text-red-500"
                aria-label={t("settings.widgets.removeSymbol")}
                title={t("settings.widgets.removeSymbol")}
              >
                <X size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {full ? (
        <p className="text-xs text-neutral-400">
          {t("settings.widgets.watchlistFull", { count: MAX_WATCHLIST })}
        </p>
      ) : (
        <div className="flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void search(); }}
            placeholder={t("settings.widgets.watchlistPlaceholder")}
            className={INPUT_CLASS}
          />
          <Button onClick={() => void search()} disabled={busy || !query.trim()}>
            {busy ? t("common.loading") : t("settings.widgets.searchSymbol")}
          </Button>
        </div>
      )}

      {failed && <div className="mt-2"><Notice tone="error">{t("settings.widgets.symbolSearchFailed")}</Notice></div>}
      {results?.length === 0 && <p className="mt-2 text-xs text-neutral-400">{t("settings.widgets.noSymbols")}</p>}
      {!!results?.length && (
        <ul className="mt-2 overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-600">
          {results.map((r) => {
            const already = watchlist.some((s) => s.symbol === r.symbol);
            return (
              <li key={`${r.symbol}|${r.exchange}`}>
                <button
                  onClick={() => add(r)}
                  disabled={already}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-50 disabled:opacity-40 dark:hover:bg-neutral-700/50"
                >
                  <span className="font-medium">{r.symbol}</span>
                  <span className="min-w-0 flex-1 truncate text-neutral-400">{r.name}</span>
                  <span className="shrink-0 text-xs text-neutral-400">{r.exchange}</span>
                  {already && <Check size={14} className="shrink-0 text-green-600" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Place search for the weather tile. Resolves a typed name to coordinates once,
 * here, so the Today tile never geocodes — it just has a latitude and longitude.
 *
 * Search is explicit (button or Enter) rather than as-you-type: this is a
 * third-party service being asked a question, and firing one per keystroke to
 * set a value once is rude to it and pointless for us.
 */
function WeatherLocationPicker({
  location, onPick,
}: { location: WeatherLocation | null; onPick: (loc: WeatherLocation | null) => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlaceResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  // Aborts the previous search when a new one starts, so a fast double-Enter
  // can't land the earlier results over the later ones. Lives across renders so
  // the cleanup can abort on unmount too.
  const ctlRef = useRef<AbortController | null>(null);
  useEffect(() => () => ctlRef.current?.abort(), []);

  async function search() {
    if (!query.trim()) return;
    ctlRef.current?.abort();
    const ctl = new AbortController();
    ctlRef.current = ctl;
    setBusy(true);
    setFailed(false);
    try {
      setResults(await searchPlaces(query, currentLanguage(), ctl.signal));
    } catch (e) {
      // Aborted requests are expected on a re-search; only a real failure flips
      // to the error notice.
      if (ctl.signal.aborted) return;
      setResults(null);
      setFailed(true);
    } finally {
      if (!ctl.signal.aborted) setBusy(false);
    }
  }

  /** "Taipei, Taiwan" / "Springfield, Illinois, United States". */
  const describe = (p: PlaceResult) => [p.name, p.admin, p.country].filter(Boolean).join(", ");

  if (location) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-600">
        <MapPin size={15} className="shrink-0 text-blue-500" />
        <span className="flex-1 truncate text-sm">
          {[location.name, location.country].filter(Boolean).join(", ")}
        </span>
        <button
          onClick={() => { onPick(null); setResults(null); setQuery(""); }}
          className="text-neutral-400 hover:text-red-500"
          aria-label={t("settings.widgets.clearLocation")}
          title={t("settings.widgets.clearLocation")}
        >
          <X size={15} />
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void search(); }}
          placeholder={t("settings.widgets.weatherPlaceholder")}
          className={INPUT_CLASS}
        />
        <Button onClick={() => void search()} disabled={busy || !query.trim()}>
          {busy ? t("common.loading") : t("settings.widgets.searchPlace")}
        </Button>
      </div>

      {failed && <div className="mt-2"><Notice tone="error">{t("settings.widgets.placeSearchFailed")}</Notice></div>}
      {results?.length === 0 && <p className="mt-2 text-xs text-neutral-400">{t("settings.widgets.noPlaces")}</p>}
      {!!results?.length && (
        <ul className="mt-2 overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-600">
          {results.map((p) => (
            <li key={`${p.latitude},${p.longitude}`}>
              <button
                onClick={() => onPick({ name: p.name, country: p.country, latitude: p.latitude, longitude: p.longitude })}
                className="w-full px-3 py-2 text-left text-sm hover:bg-neutral-50 dark:hover:bg-neutral-700/50"
              >
                {describe(p)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Assistant
// ---------------------------------------------------------------------------
function AssistantSettings({ draft, patch, apiKey, setApiKey, onSave, saved }: PaneProps) {
  const { t } = useTranslation();
  return (
    <>
      <PaneHeader title={t("settings.sections.assistant")}>
        {t("settings.assistant.description")}
      </PaneHeader>

      <OpenAiFields draft={draft} patch={patch} apiKey={apiKey} setApiKey={setApiKey} />

      <SummaryThrottleFields draft={draft} patch={patch} />

      <SaveRow onSave={onSave} saved={saved} />
    </>
  );
}

/**
 * How long the Today briefing is held before a change to the day rewrites it.
 *
 * Lives with the assistant rather than on the Today page because it's a spend
 * control, not a layout one — that card is the only request the app makes
 * without being asked.
 *
 * The hours field keeps its own text so a half-typed value ("", "1") isn't
 * clamped out from under the cursor; the draft only takes a number it can use.
 */
function SummaryThrottleFields({ draft, patch }: Pick<PaneProps, "draft" | "patch">) {
  const { t } = useTranslation();
  const [hours, setHours] = useState(String(draft.summaryMaxAgeHours));

  return (
    <Field label={t("settings.assistant.summaryThrottle")} hint={t("settings.assistant.summaryThrottleHint")}>
      <label className="flex cursor-pointer items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={draft.summaryThrottle}
          onChange={(e) => patch({ summaryThrottle: e.target.checked })}
          className="h-4 w-4 accent-blue-600"
        />
        <span>{t("settings.assistant.summaryThrottleLabel")}</span>
      </label>

      {draft.summaryThrottle && (
        <div className="mt-3 flex items-center gap-2">
          <input
            type="number"
            min={MIN_SUMMARY_MAX_AGE_HOURS}
            max={MAX_SUMMARY_MAX_AGE_HOURS}
            value={hours}
            onChange={(e) => {
              setHours(e.target.value);
              const n = Number(e.target.value);
              if (e.target.value.trim() && Number.isFinite(n)) {
                patch({ summaryMaxAgeHours: clampSummaryMaxAge(n) });
              }
            }}
            onBlur={() => setHours(String(draft.summaryMaxAgeHours))}
            className={`${INPUT_CLASS} w-24`}
          />
          <span className="text-sm text-neutral-500">{t("settings.assistant.summaryHours")}</span>
        </div>
      )}
    </Field>
  );
}

function OpenAiFields({
  draft, patch, apiKey, setApiKey,
}: Pick<PaneProps, "draft" | "patch" | "apiKey" | "setApiKey">) {
  const { t } = useTranslation();
  return (
    <>
      <Field
        label={t("settings.assistant.apiKey")}
        hint={
          <>
            {t("settings.assistant.apiKeyHint")}{" "}
            {/* The key is plaintext on this device and unscoped at OpenAI's
                end, so the honest mitigations are the user's: a key used for
                nothing else, and a spend limit. Say so where they enter it. */}
            {t("settings.assistant.apiKeyScopeHint")}{" "}
            <ExternalLinkButton url={OPENAI_KEYS_URL} label={t("settings.assistant.manageKeys")} />
          </>
        }
      >
        <SecretInput
          value={apiKey}
          onChange={setApiKey}
          placeholder="sk-…"
        />
      </Field>

      <Field
        label={t("settings.assistant.model")}
        hint={t("settings.assistant.modelHint")}
      >
        <select
          value={draft.openaiModel}
          onChange={(e) => patch({ openaiModel: e.target.value })}
          className={`${INPUT_CLASS} font-mono`}
        >
          {/* A model typed in before this became a dropdown — or set on another
              device with a newer build — must stay selected rather than silently
              snapping to whatever the first option happens to be. */}
          {!(OPENAI_MODELS as readonly string[]).includes(draft.openaiModel) && (
            <option value={draft.openaiModel}>{draft.openaiModel}</option>
          )}
          {OPENAI_MODELS.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </Field>

      <Field
        label={t("settings.assistant.webSearch")}
        hint={t("settings.assistant.webSearchHint")}
      >
        <label className="flex cursor-pointer items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={draft.webSearch}
            onChange={(e) => patch({ webSearch: e.target.checked })}
            className="h-4 w-4 accent-blue-600"
          />
          <span>{t("settings.assistant.webSearchLabel")}</span>
        </label>
      </Field>
    </>
  );
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------
function VoiceSettings({ draft, patch, onSave, saved }: PaneProps) {
  const { t, i18n } = useTranslation();
  const natural = draft.ttsEngine === "openai";
  // Spoken replies fall back to OS voices, which macOS ships on demand — if the
  // language's voice isn't installed the reply is simply silent, with nothing
  // in the UI to explain why. Check and say so.
  const [voiceMissing, setVoiceMissing] = useState(false);
  useEffect(() => {
    let live = true;
    void hasVoiceFor(i18n.language).then((ok) => { if (live) setVoiceMissing(!ok); });
    return () => { live = false; };
  }, [i18n.language]);
  // Natural voices degrade to a system voice on any network trouble. That's
  // deliberately quiet at speaking time, so report it here instead.
  const naturalError = natural ? getLastNaturalError() : null;

  return (
    <>
      <PaneHeader title={t("settings.sections.voice")}>
        {t("settings.voice.description")}
      </PaneHeader>

      {voiceMissing && (
        <div className="mb-5">
          <Notice tone="error">
            {t("settings.voice.noVoice", { language: i18n.language })}
          </Notice>
        </div>
      )}

      {naturalError && (
        <div className="mb-5">
          <Notice tone="error">
            {t("settings.voice.naturalFailed", { detail: naturalError })}
          </Notice>
        </div>
      )}

      <Field
        label={t("settings.voice.engine")}
        hint={t(natural ? "settings.voice.engineHintOpenai" : "settings.voice.engineHintSystem")}
      >
        <select
          value={draft.ttsEngine}
          onChange={(e) => patch({ ttsEngine: e.target.value as TtsEngine })}
          className={INPUT_CLASS}
        >
          <option value="openai">{t("settings.voice.engineOpenai")}</option>
          <option value="system">{t("settings.voice.engineSystem")}</option>
        </select>
      </Field>

      <Field
        label={t("settings.voice.rate")}
        hint={t("settings.voice.rateHint")}
      >
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={MIN_SPEECH_RATE}
            max={MAX_SPEECH_RATE}
            step={0.05}
            value={draft.speechRate}
            onChange={(e) => patch({ speechRate: Number(e.target.value) })}
            className="flex-1 accent-blue-500"
            aria-label={t("settings.voice.rate")}
          />
          <span className="w-12 shrink-0 text-right text-sm tabular-nums text-neutral-500">
            {draft.speechRate.toFixed(2).replace(/\.?0+$/, "")}×
          </span>
          {draft.speechRate !== 1 && (
            <Button onClick={() => patch({ speechRate: 1 })}>
              {t("settings.voice.rateReset")}
            </Button>
          )}
        </div>
      </Field>

      {natural ? (
        <NaturalVoicePicker
          lang={i18n.language}
          rate={draft.speechRate}
          value={draft.openaiVoice}
          onChange={(id) => patch({ openaiVoice: id })}
        />
      ) : (
        // System voices are per-language by nature — one voice speaks one
        // language, and an English voice handed Chinese text is silent — so
        // this is the one place the setting can't be unified.
        LANGUAGES.map((l) => (
          <VoicePicker
            key={l.code}
            lang={l.code}
            language={l.nativeName}
            rate={draft.speechRate}
            value={draft.preferredVoices[l.code] ?? ""}
            onChange={(uri) =>
              patch({ preferredVoices: { ...draft.preferredVoices, [l.code]: uri } })}
          />
        ))
      )}

      <Field
        label={t("settings.voice.sttModel")}
        hint={<>{t("settings.voice.sttHint")} <code>whisper-1</code> / <code>gpt-4o-transcribe</code></>}
      >
        <input
          value={draft.sttModel}
          onChange={(e) => patch({ sttModel: e.target.value })}
          placeholder="whisper-1"
          spellCheck={false}
          className={`${INPUT_CLASS} font-mono`}
        />
      </Field>

      {natural && (
        <Field
          label={t("settings.voice.ttsModel")}
          hint={<>{t("settings.voice.sttHint")} <code>gpt-4o-mini-tts</code> / <code>tts-1</code></>}
        >
          <input
            value={draft.ttsModel}
            onChange={(e) => patch({ ttsModel: e.target.value })}
            placeholder="gpt-4o-mini-tts"
            spellCheck={false}
            className={`${INPUT_CLASS} font-mono`}
          />
        </Field>
      )}

      <div className="mb-5">
        <Notice tone="info">
          {t(natural ? "settings.voice.privacyNoteOpenai" : "settings.voice.privacyNote")}
        </Notice>
      </div>

      <SaveRow onSave={onSave} saved={saved} />
    </>
  );
}

/** Select + preview button, shared by both engines' pickers. */
function VoiceRow({
  label, hint, value, onChange, onPreview, children,
}: {
  label: string; hint: ReactNode; value: string;
  onChange: (v: string) => void; onPreview: () => void; children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Field label={label} hint={hint}>
      <div className="flex gap-2">
        <select value={value} onChange={(e) => onChange(e.target.value)} className={INPUT_CLASS}>
          {children}
        </select>
        <Button onClick={onPreview}>
          <Volume2 size={16} />
          {t("settings.voice.preview")}
        </Button>
      </div>
    </Field>
  );
}

/** Neural-voice chooser for one language. */
function NaturalVoicePicker({
  lang, rate, value, onChange,
}: { lang: string; rate: number; value: string; onChange: (id: string) => void }) {
  const { t } = useTranslation();
  const [error, setError] = useState("");
  const selected = OPENAI_VOICES.find((v) => v.id === value)?.id ?? "";
  const fallbackName =
    OPENAI_VOICES.find((v) => v.id === DEFAULT_OPENAI_VOICE)?.name ?? DEFAULT_OPENAI_VOICE;

  return (
    <>
      <VoiceRow
        label={t("settings.voice.naturalVoice")}
        hint={t("settings.voice.naturalHint")}
        value={selected}
        onChange={onChange}
        onPreview={() => {
          setError("");
          previewNaturalVoice(lang, selected || DEFAULT_OPENAI_VOICE, rate)
            .catch((e) => setError(e instanceof Error ? e.message : String(e)));
        }}
      >
        <option value="">{t("settings.voice.defaultVoice", { name: fallbackName })}</option>
        {OPENAI_VOICES.map((v) => (
          <option key={v.id} value={v.id}>{v.name}</option>
        ))}
      </VoiceRow>
      {error && (
        <div className="mb-5">
          <Notice tone="error">{t("settings.voice.naturalFailed", { detail: error })}</Notice>
        </div>
      )}
    </>
  );
}

/**
 * System-voice chooser for one language. The default ("best available") is
 * deliberately an option rather than a hidden fallback: it keeps working when
 * the user later downloads a better voice, which the stored URI wouldn't.
 */
function VoicePicker({
  lang, language, rate, value, onChange,
}: {
  lang: string; language: string; rate: number;
  value: string; onChange: (uri: string) => void;
}) {
  const { t } = useTranslation();
  const [voices, setVoices] = useState<VoiceOption[]>([]);

  useEffect(() => {
    let live = true;
    void listVoices(lang).then((v) => { if (live) setVoices(v); });
    return () => { live = false; };
  }, [lang]);

  if (!voices.length) return null;

  // The saved voice can vanish if the user removes it in System Settings.
  const selected = voices.find((v) => v.uri === value)?.uri ?? "";

  return (
    <VoiceRow
      label={t("settings.voice.outputVoice", { language })}
      hint={t("settings.voice.voiceHint")}
      value={selected}
      onChange={onChange}
      onPreview={() => previewVoice(lang, selected || voices[0].uri, rate)}
    >
      <option value="">{t("settings.voice.bestAvailable")}</option>
      {voices.map((v) => (
        <option key={v.uri} value={v.uri}>
          {v.name} · {t(`settings.voice.quality.${v.quality}`)}
        </option>
      ))}
    </VoiceRow>
  );
}

// ---------------------------------------------------------------------------
// Calendars (CalDAV / iCloud)
// ---------------------------------------------------------------------------
function CalendarSettingsPane() {
  const { t } = useTranslation();
  const stored = getCalendarSettings();
  const [username, setUsername] = useState(stored.account?.username ?? "");
  const [password, setPassword] = useState(getCalDavPassword());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  // Bumped after any change so the calendar list re-reads from settings.
  const [, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);

  const settings = getCalendarSettings();
  const connected = !!settings.account;
  const calendars = listCalendars();
  const remoteCount = calendars.filter((c) => c.source !== "local").length;
  // An account with no password: what signing out and back in leaves behind,
  // since `clearSecrets` forgets the credential but the account — a name and a
  // calendar list, no secret — survives. Without a word here, the calendars
  // simply fail to load and the pane still claims to be connected.
  const needsPassword = connected && !getCalDavPassword();

  /**
   * Discovery authenticates, and `basicAuth` takes the password from storage
   * rather than from the account object, so it has to be written BEFORE the
   * attempt and put back if the attempt fails. Restoring on failure is what
   * stops a typo from silently knocking out a working connection.
   */
  async function connect() {
    setBusy(true);
    setError("");
    setStatus("");
    const previous = getCalDavPassword();
    try {
      setCalDavPassword(password);
      const draft: CalDavAccount = {
        provider: "icloud",
        username: username.trim(),
        calendars: [],
      };
      const account = await discoverAccount(draft, settings.account?.calendars);
      saveCalendarSettings({ account });
      invalidateCache();
      setStatus(t("settings.calendars.found", { count: account.calendars.length }));
      refresh();
    } catch (e) {
      setCalDavPassword(previous);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function disconnect() {
    if (!window.confirm(t("settings.calendars.confirmDisconnect"))) return;
    saveCalendarSettings({ account: null, defaultCalendarId: LOCAL_CALENDAR_ID });
    setCalDavPassword("");
    invalidateCache();
    setPassword("");
    setStatus("");
    setError("");
    refresh();
  }

  return (
    <>
      <PaneHeader title={t("settings.sections.calendars")}>
        {t("settings.calendars.description")}
      </PaneHeader>

      {/* --- Account --------------------------------------------------- */}
      <section className="mb-8 rounded-xl border border-neutral-200 p-5 dark:border-neutral-700">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
            {t("settings.calendars.account")}
          </h2>
          {connected && !needsPassword && (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-green-50 px-2.5 py-0.5 text-xs font-medium text-green-700 dark:bg-green-950/40 dark:text-green-400">
              <Check size={12} /> {t("settings.calendars.connected")}
            </span>
          )}
        </div>

        {needsPassword && (
          <div className="mb-4">
            <Notice tone="error">{t("settings.calendars.passwordCleared")}</Notice>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-sm font-medium">{t("settings.calendars.appleId")}</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="you@icloud.com"
              spellCheck={false}
              autoComplete="off"
              className={INPUT_CLASS}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">{t("settings.calendars.appPassword")}</label>
            <SecretInput
              value={password}
              onChange={setPassword}
              placeholder="xxxx-xxxx-xxxx-xxxx"
            />
          </div>
        </div>

        <p className="mt-3 text-xs leading-relaxed text-neutral-400">
          {t("settings.calendars.passwordHint")}{" "}
          {/* An app-specific password is account-wide, not calendar-scoped, and
              it sits in plaintext on this device — so the page that issues it,
              which is also the page that revokes it, belongs right here. */}
          {t("settings.calendars.passwordScopeHint")}{" "}
          <ExternalLinkButton url={APPLE_PASSWORD_URL} label={t("settings.calendars.appleIdSettings")} />
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-neutral-200 pt-4 dark:border-neutral-700">
          <Button variant="primary" onClick={() => void connect()}>
            {busy ? (
              <span className="flex items-center gap-1.5">
                <Loader2 size={15} className="animate-spin" /> {t("settings.calendars.connecting")}
              </span>
            ) : connected ? t("settings.calendars.reconnect") : t("settings.calendars.connect")}
          </Button>
          {connected && <Button onClick={disconnect}>{t("settings.calendars.disconnect")}</Button>}
          {status && (
            <span className="flex items-center gap-1 text-sm text-green-600">
              <Check size={16} /> {status}
            </span>
          )}
        </div>

        {error && <div className="mt-3"><Notice tone="error">{error}</Notice></div>}
      </section>

      {/* --- Calendar list --------------------------------------------- */}
      <section className="mb-8 rounded-xl border border-neutral-200 p-5 dark:border-neutral-700">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          {t("settings.calendars.visible")}
        </h2>
        <p className="mb-4 text-xs text-neutral-400">
          {t("settings.calendars.visibleHint")}
        </p>

        <div className="space-y-0.5">
          {calendars.map((cal) => (
            <label
              key={cal.id}
              className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-700/40"
            >
              <input
                type="checkbox"
                checked={cal.visible}
                onChange={(e) => { setCalendarVisible(cal.id, e.target.checked); refresh(); }}
                className="h-4 w-4 accent-blue-600"
              />
              <span
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ background: cal.color ?? "#3b82f6" }}
              />
              <span className="min-w-0 truncate">{cal.name}</span>
              {cal.source === "local" && (
                <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-700 dark:text-neutral-400">{t("settings.calendars.builtIn")}</span>
              )}
              {cal.readOnly && (
                <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500 dark:bg-neutral-700 dark:text-neutral-400">{t("settings.calendars.readOnly")}</span>
              )}
            </label>
          ))}
        </div>

        {!connected && (
          <p className="mt-3 text-xs text-neutral-400">
            {t("settings.calendars.connectPrompt")}
          </p>
        )}
        {connected && remoteCount === 0 && (
          <p className="mt-3 text-xs text-neutral-400">
            {t("settings.calendars.noneFound")}
          </p>
        )}
      </section>

      {/* --- Default --------------------------------------------------- */}
      <section className="rounded-xl border border-neutral-200 p-5 dark:border-neutral-700">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          {t("settings.calendars.defaultCalendar")}
        </h2>
        <p className="mb-4 text-xs leading-relaxed text-neutral-400">
          {t("settings.calendars.defaultHint", { calendar: LOCAL_CALENDAR_NAME })}
        </p>
        <select
          value={settings.defaultCalendarId}
          onChange={(e) => { saveCalendarSettings({ defaultCalendarId: e.target.value }); refresh(); }}
          className={INPUT_CLASS}
        >
          {calendars.filter((c) => !c.readOnly).map((cal) => (
            <option key={cal.id} value={cal.id}>{cal.name}</option>
          ))}
        </select>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Mail (IMAP / iCloud)
//
// Independent of the AppSettings draft, exactly like the calendar pane above:
// it reads and writes its own bucket (`getMailSettings`) and its own secret, so
// nothing about a mail account can reach the cloud settings sync or a backup.
// ---------------------------------------------------------------------------
function MailSettingsPane() {
  const { t } = useTranslation();
  const stored = getMailSettings();
  const [username, setUsername] = useState(stored.account?.username ?? "");
  const [password, setPassword] = useState(getMailPassword());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);

  const settings = getMailSettings();
  const account = settings.account;
  const connected = !!account;
  // Same state the calendar pane names: signing out clears the credential and
  // leaves the account behind, so without a word here the inbox simply stops
  // answering while the pane still claims to be connected.
  const needsPassword = connected && !getMailPassword();
  // One Apple app-specific password covers Mail and Calendar, so someone who
  // has already connected calendars should not have to go and generate a
  // second one — or dig the first out of wherever they saved it.
  const calendarPassword = getCalDavPassword();
  const canReuse = !password && !!calendarPassword;

  async function connect() {
    setBusy(true);
    setError("");
    setStatus("");
    const previous = getMailPassword();
    try {
      // Written BEFORE the attempt because `mail/client.ts` reads the password
      // from storage rather than off the account — and put back on failure, so
      // a typo can't silently knock out a working connection.
      setMailPassword(password);
      // Connecting a different account under the same app: nothing remembered
      // about the old one can be allowed to answer for the new one.
      clearMailCache();
      const draft = icloudAccount(username);
      const folders = await listFolders(draft);
      saveMailSettings({ account: { ...draft, folders, connectedAt: new Date().toISOString() } });
      setStatus(t("settings.mail.found", { count: folders.length }));
      refresh();
    } catch (e) {
      setMailPassword(previous);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function disconnect() {
    if (!window.confirm(t("settings.mail.confirmDisconnect"))) return;
    saveMailSettings({ account: null });
    // Alongside forgetting the password, and for the same reason. The cache is
    // in memory, so it has no storage key to scope it away — without this, mail
    // from a disconnected inbox stays readable until the app is quit.
    clearMailCache();
    setMailPassword("");
    setPassword("");
    setStatus("");
    setError("");
    refresh();
  }

  return (
    <>
      <PaneHeader title={t("settings.sections.mail")}>
        {t("settings.mail.description")}
      </PaneHeader>

      <section className="mb-8 rounded-xl border border-neutral-200 p-5 dark:border-neutral-700">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
            {t("settings.mail.account")}
          </h2>
          {connected && !needsPassword && (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-green-50 px-2.5 py-0.5 text-xs font-medium text-green-700 dark:bg-green-950/40 dark:text-green-400">
              <Check size={12} /> {t("settings.mail.connected")}
            </span>
          )}
        </div>

        {needsPassword && (
          <div className="mb-4">
            <Notice tone="error">{t("settings.mail.passwordCleared")}</Notice>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-sm font-medium">{t("settings.mail.appleId")}</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="you@icloud.com"
              spellCheck={false}
              autoComplete="off"
              className={INPUT_CLASS}
            />
            {/* The one rule that differs from the calendar pane, so it is said
                where it is needed: CalDAV authenticates any address on the
                Apple ID, IMAP wants the @icloud.com one. Identical credentials
                otherwise, which is exactly what makes the failure confusing. */}
            <p className="mt-1.5 text-xs leading-relaxed text-neutral-400">
              {t("settings.mail.appleIdHint")}
            </p>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium">{t("settings.mail.appPassword")}</label>
            <SecretInput
              value={password}
              onChange={setPassword}
              placeholder="xxxx-xxxx-xxxx-xxxx"
            />
            {canReuse && (
              <button
                type="button"
                onClick={() => setPassword(calendarPassword)}
                className="mt-1.5 text-xs text-blue-500 hover:underline"
              >
                {t("settings.mail.reuseCalendarPassword")}
              </button>
            )}
          </div>
        </div>

        <p className="mt-3 text-xs leading-relaxed text-neutral-400">
          {t("settings.mail.passwordHint")}{" "}
          {t("settings.calendars.passwordScopeHint")}{" "}
          <ExternalLinkButton url={APPLE_PASSWORD_URL} label={t("settings.calendars.appleIdSettings")} />
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-neutral-200 pt-4 dark:border-neutral-700">
          <Button variant="primary" onClick={() => void connect()}>
            {busy ? (
              <span className="flex items-center gap-1.5">
                <Loader2 size={15} className="animate-spin" /> {t("settings.mail.connecting")}
              </span>
            ) : connected ? t("settings.mail.reconnect") : t("settings.mail.connect")}
          </Button>
          {connected && <Button onClick={disconnect}>{t("settings.mail.disconnect")}</Button>}
          {status && (
            <span className="flex items-center gap-1 text-sm text-green-600">
              <Check size={16} /> {status}
            </span>
          )}
        </div>

        {error && <div className="mt-3"><Notice tone="error">{error}</Notice></div>}
      </section>

      <section className="mb-8 rounded-xl border border-neutral-200 p-5 dark:border-neutral-700">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          {t("settings.mail.access")}
        </h2>
        <p className="mb-4 text-xs leading-relaxed text-neutral-400">
          {t("settings.mail.readOnlyHint")}
        </p>
        {/* Said in the pane, not only in a comment: on the web the user's mail
            and their password pass through our Worker, and someone deciding
            whether to connect an inbox is entitled to know that before they do
            rather than after. The desktop app talks to Apple directly. */}
        <Notice tone="info">
          {isTauri() ? t("settings.mail.directNote") : t("settings.mail.relayNote")}
        </Notice>
        {connected && account.folders.length > 0 && (
          <p className="mt-3 text-xs text-neutral-400">
            {t("settings.mail.mailboxes", { list: account.folders.map((f) => f.label ?? f.name).join(", ") })}
          </p>
        )}
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Account (email confirmation, deletion)
// ---------------------------------------------------------------------------

/**
 * The identity pane, as opposed to the data pane below it.
 *
 * The distinction matters and the two are deliberately kept apart: "clear all
 * data" empties a space that still belongs to you, while "delete account"
 * removes the account, the space and the membership. Putting the second next to
 * the first, under the same heading, is how someone reaches for the wrong one.
 */
function AccountSettings() {
  const { t } = useTranslation();
  // The cached session, read once per mount. It is a display value — the server
  // re-decides everything — and the only paths that change it (confirming an
  // address, deleting the account) reload the page afterwards.
  const session = getCachedSession();
  const [busy, setBusy] = useState<"verify" | "delete" | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");

  async function doResend() {
    setError("");
    setStatus("");
    if (!session) return;
    setBusy("verify");
    try {
      await resendVerification(session.user.email);
      setStatus(t("settings.account.verificationSent"));
    } catch (e) {
      setError(messageFor(e, t("auth.offline")));
    }
    setBusy(null);
  }

  async function doDelete() {
    setError("");
    setStatus("");
    if (!session) return;
    // Two gates, not one. The password proves it's the account's owner and not
    // whoever found the laptop unlocked; the confirm proves the click was
    // meant. Neither alone is enough for something with no undo.
    if (!window.confirm(t("settings.account.confirmDelete"))) return;

    setBusy("delete");
    try {
      // Derives argon2id from the typed password, so this takes a moment.
      await deleteAccount(session.user.email, password);
      // Everything this device knew is gone; a reload lands on the login
      // screen with no session to restore.
      window.location.reload();
    } catch (e) {
      setError(messageFor(e, t("auth.offline")));
      setBusy(null);
    }
  }

  if (!session) return null;
  const verified = session.user.email_verified;

  return (
    <>
      <PaneHeader title={t("settings.account.title")}>
        {t("settings.account.description")}
      </PaneHeader>

      <section className="mb-6 rounded-xl border border-neutral-200 p-5 dark:border-neutral-700">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          {t("settings.account.emailHeading")}
        </h2>
        <p className="mb-3 text-sm font-medium">{session.user.email}</p>

        {verified ? (
          <p className="flex items-center gap-1.5 text-sm text-green-600">
            <MailCheck size={16} /> {t("settings.account.emailVerified")}
          </p>
        ) : (
          <>
            <p className="mb-3 flex items-start gap-1.5 text-xs leading-relaxed text-amber-700 dark:text-amber-500">
              <MailWarning size={15} className="mt-0.5 shrink-0" />
              <span>{t("settings.account.emailUnverifiedHint")}</span>
            </p>
            <Button disabled={busy !== null} onClick={() => void doResend()}>
              {busy === "verify" ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 size={15} className="animate-spin" /> {t("settings.account.sending")}
                </span>
              ) : (
                t("settings.account.resendVerification")
              )}
            </Button>
          </>
        )}

        {status && (
          <div className="mt-3 flex items-center gap-1 text-sm text-green-600">
            <Check size={16} /> {status}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-red-200 p-5 dark:border-red-900/60">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">
          {t("settings.account.deleteHeading")}
        </h2>
        <p className="mb-4 text-xs leading-relaxed text-neutral-400">
          {t("settings.account.deleteHint")}
        </p>

        <Field label={t("settings.account.confirmWithPassword")}>
          <SecretInput
            value={password}
            onChange={setPassword}
            placeholder={t("auth.password")}
            mono={false}
          />
        </Field>

        <Button
          variant="danger"
          // The password is required by the server too; disabling here just
          // avoids spending an argon2id derivation on an empty string.
          disabled={busy !== null || password.length === 0}
          onClick={() => void doDelete()}
        >
          {busy === "delete" ? (
            <span className="flex items-center gap-1.5">
              <Loader2 size={15} className="animate-spin" /> {t("settings.account.deleting")}
            </span>
          ) : (
            <span className="flex items-center gap-1.5"><Trash2 size={15} /> {t("settings.account.deleteButton")}</span>
          )}
        </Button>

        {error && <div className="mt-3"><Notice tone="error">{error}</Notice></div>}
      </section>
    </>
  );
}

/** Offline is worth its own message here — both actions in this pane need the
 *  network, and "something went wrong" for a dropped connection sends people
 *  looking for a bug that isn't there. */
function messageFor(e: unknown, offline: string): string {
  if (e instanceof OfflineError) return offline;
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Data (backup / restore)
// ---------------------------------------------------------------------------
function DataSettings() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<"export" | "import" | "reset" | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  async function doExport() {
    setBusy("export");
    setError("");
    setStatus("");
    try {
      const path = await exportBackup();
      if (path) setStatus(t("settings.data.exported"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function doImport() {
    setError("");
    setStatus("");
    // Destructive: replaces everything currently in the app.
    if (!window.confirm(t("settings.data.confirmImport"))) return;
    setBusy("import");
    try {
      const result = await importBackup();
      if (result) {
        // The reload below wipes any status message, so a partial restore has to
        // be reported with something modal. Images are the only part that can be
        // skipped (the daily upload budget); their notes came back intact.
        if (result.imagesSkipped > 0) {
          window.alert(t("settings.data.imagesSkipped", { count: result.imagesSkipped }));
        }
        // Reload so every view re-reads the DB and the restored language applies.
        window.location.reload();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  async function doReset() {
    setError("");
    setStatus("");
    // Permanent: wipes every user table. No undo.
    if (!window.confirm(t("settings.data.confirmReset"))) return;
    setBusy("reset");
    try {
      await clearAllData();
      // Reload so every view re-reads the now-empty DB and the assistant chat,
      // reminder poller and deep-link targets all reset to a clean state.
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  }

  return (
    <>
      <PaneHeader title={t("settings.data.title")}>
        {t("settings.data.description")}
      </PaneHeader>

      <section className="mb-6 rounded-xl border border-neutral-200 p-5 dark:border-neutral-700">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          {t("settings.data.exportHeading")}
        </h2>
        <p className="mb-4 text-xs leading-relaxed text-neutral-400">
          {t("settings.data.exportHint")}
        </p>
        <Button variant="primary" disabled={busy !== null} onClick={() => void doExport()}>
          {busy === "export" ? (
            <span className="flex items-center gap-1.5">
              <Loader2 size={15} className="animate-spin" /> {t("settings.data.exporting")}
            </span>
          ) : (
            <span className="flex items-center gap-1.5"><Download size={15} /> {t("settings.data.exportButton")}</span>
          )}
        </Button>
        {status && (
          <div className="mt-3 flex items-center gap-1 text-sm text-green-600">
            <Check size={16} /> {status}
          </div>
        )}
      </section>

      <section className="mb-6 rounded-xl border border-neutral-200 p-5 dark:border-neutral-700">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          {t("settings.data.importHeading")}
        </h2>
        <p className="mb-4 text-xs leading-relaxed text-neutral-400">
          {t("settings.data.importHint")}
        </p>
        <Button disabled={busy !== null} onClick={() => void doImport()}>
          {busy === "import" ? (
            <span className="flex items-center gap-1.5">
              <Loader2 size={15} className="animate-spin" /> {t("settings.data.importing")}
            </span>
          ) : (
            <span className="flex items-center gap-1.5"><Upload size={15} /> {t("settings.data.importButton")}</span>
          )}
        </Button>
      </section>

      <section className="rounded-xl border border-red-200 p-5 dark:border-red-900/60">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">
          {t("settings.data.resetHeading")}
        </h2>
        <p className="mb-4 text-xs leading-relaxed text-neutral-400">
          {t("settings.data.resetHint")}
        </p>
        <Button variant="danger" disabled={busy !== null} onClick={() => void doReset()}>
          {busy === "reset" ? (
            <span className="flex items-center gap-1.5">
              <Loader2 size={15} className="animate-spin" /> {t("settings.data.resetting")}
            </span>
          ) : (
            <span className="flex items-center gap-1.5"><Trash2 size={15} /> {t("settings.data.resetButton")}</span>
          )}
        </Button>
      </section>

      {error && <div className="mt-3"><Notice tone="error">{error}</Notice></div>}
    </>
  );
}
