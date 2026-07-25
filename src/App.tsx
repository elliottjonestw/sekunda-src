import { useEffect, useState } from "react";
import { Home, Calendar, Bell, ListChecks, StickyNote, NotebookPen, Users, Search, Brain, Sparkles, Settings as SettingsIcon, LogOut, Menu, Inbox, LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import TodayView from "./views/TodayView";
import CalendarView from "./views/CalendarView";
import RemindersView from "./views/RemindersView";
import TodosView from "./views/TodosView";
import NotesView from "./views/NotesView";
import DiaryView from "./views/DiaryView";
import MailView from "./views/MailView";
import PeopleView from "./views/PeopleView";
import SearchView from "./views/SearchView";
import AssistantView from "./views/AssistantView";
import AssistantPopup from "./components/assistant/AssistantPopup";
import { useAssistantChat, type UiMessage } from "./components/assistant/useAssistantChat";
import SettingsView from "./views/SettingsView";
import type { NavTarget } from "./types";
import type { MailMessageSummary } from "./lib/mail";
import { startReminderPoller } from "./lib/notifications";
import { syncSettingsFromCloud, hasMailAccount, MAIL_ACCOUNT_EVENT } from "./lib/settings";
import { isAssistantConfigured } from "./lib/secrets";
import { logout } from "./lib/auth";
import { applyTheme, watchSystemTheme } from "./lib/theme";
import { getCachedSession } from "./lib/authStore";

type View = "today" | "calendar" | "reminders" | "todos" | "notes" | "diary" | "people" | "mail" | "assistant" | "search" | "settings";

// Secret keystroke: hold Shift + 8 + 9 together anywhere in the app to open the
// "load demo data" prompt. Keys are matched by physical code so it works
// regardless of what Shift+8/9 types on the user's layout.

type NavId = Exclude<View, "search" | "settings">;

const NAV: { id: NavId; icon: LucideIcon }[] = [
  { id: "today", icon: Home },
  { id: "calendar", icon: Calendar },
  { id: "mail", icon: Inbox },
  { id: "reminders", icon: Bell },
  { id: "todos", icon: ListChecks },
  { id: "notes", icon: StickyNote },
  { id: "diary", icon: NotebookPen },
  { id: "people", icon: Users },
  { id: "assistant", icon: Sparkles },
];

export default function App() {
  const { t } = useTranslation();
  const [view, setView] = useState<View>("today");
  // Mail is the one page that isn't always there: with no inbox connected it
  // has nothing to show, so it stays out of the sidebar rather than leading to
  // an empty page that has to explain itself. Recomputed on the event
  // `saveMailSettings` fires, so connecting an inbox reveals it immediately
  // rather than on the next navigation.
  const [mailConnected, setMailConnected] = useState(hasMailAccount);
  const [search, setSearch] = useState("");
  const [ready, setReady] = useState(false);
  // A specific item to open when navigating into a view (e.g. clicking a note
  // on the Today dashboard opens that note). Consumed by the view on mount and
  // cleared on any other navigation so it never mis-fires later.
  const [noteTarget, setNoteTarget] = useState<string | null>(null);
  const [diaryTarget, setDiaryTarget] = useState<string | null>(null);
  const [calTarget, setCalTarget] = useState<string | null>(null);
  // The occurrence to open, so the calendar can jump to its month first.
  const [calTargetStart, setCalTargetStart] = useState<string | null>(null);
  const [todoTarget, setTodoTarget] = useState<string | null>(null);
  const [reminderTarget, setReminderTarget] = useState<string | null>(null);
  const [personTarget, setPersonTarget] = useState<string | null>(null);
  // Mail carries the whole summary, not an id — a message has no row to reload
  // from, so the search result itself is what the reader opens.
  const [mailTarget, setMailTarget] = useState<MailMessageSummary | null>(null);
  // The assistant conversation lives here, not in AssistantView: clicking an
  // item card navigates away, which would otherwise unmount the chat and lose it.
  const [chatMessages, setChatMessages] = useState<UiMessage[]>([]);
  // Whether the floating chat window is expanded. Deliberately not persisted:
  // a chat window that reopens itself on every launch is worse than one click.
  const [popupOpen, setPopupOpen] = useState(false);
  // Below `md` the sidebar is an off-canvas drawer rather than a column: at
  // 375px a 208px rail leaves no room for the view beside it. At `md` and up
  // the drawer classes are overridden back to the static sidebar, so this flag
  // has no effect on the desktop layout at all.
  const [navOpen, setNavOpen] = useState(false);
  // The turn/voice lifecycle lives here for the same reason the transcript
  // does, only more so: the popup unmounts when you navigate to the assistant
  // page, and a hook instance owned by the popup took its in-flight turn with
  // it — the unmount cleanup aborted the request, and deliver() drops the
  // cancelled user message, so "Open in Assistant" right after sending wiped
  // what you'd just typed. One instance in App means the handoff is pure
  // navigation: the message, the thinking indicator and the reply all survive.
  // Space-to-talk follows whichever surface is actually on screen.
  const chat = useAssistantChat({
    messages: chatMessages,
    setMessages: setChatMessages,
    spaceEnabled: isAssistantConfigured() && (view === "assistant" || popupOpen),
  });

  useEffect(() => {
    const onMailAccount = () => {
      const connected = hasMailAccount();
      setMailConnected(connected);
      // Disconnecting happens in Settings, so this is belt-and-braces — but a
      // page whose sidebar entry has just gone must not stay on screen.
      // Functional form because this listener is registered once and would
      // otherwise close over the first `view`.
      if (!connected) setView((v) => (v === "mail" ? "today" : v));
    };
    window.addEventListener(MAIL_ACCOUNT_EVENT, onMailAccount);
    return () => window.removeEventListener(MAIL_ACCOUNT_EVENT, onMailAccount);
  }, []);

  // Read once per render rather than held in state: AuthGate remounts this
  // whole tree on a different user, so it cannot go stale underneath us.
  const account = getCachedSession();

  async function signOut() {
    await logout();
    // A full reload is the simplest correct reset. Every module-scoped cache in
    // the app — dayData's revision counter, the notification poller's fired
    // set, the assistant transcript — would otherwise survive into the next
    // session, and enumerating them is a list that silently grows.
    window.location.reload();
  }

  // Each view reloads its own data after mutations and on mount; switching
  // views remounts the next one, so no global refresh signal is needed.
  const bump = () => {};

  // Single entry point for view changes. Resets any pending open-target unless
  // one is passed for this navigation.
  function navigate(v: View, target?: NavTarget) {
    setNoteTarget(target?.noteId ?? null);
    setDiaryTarget(target?.diaryDate ?? null);
    setCalTarget(target?.eventId ?? null);
    setCalTargetStart(target?.eventStart ?? null);
    setTodoTarget(target?.todoId ?? null);
    setReminderTarget(target?.reminderId ?? null);
    setPersonTarget(target?.personId ?? null);
    setMailTarget(target?.mail ?? null);
    setSearch("");
    setView(v);
    setNavOpen(false);
  }

  /** Clear every pending open-target (search box, plain nav). */
  function clearTargets() {
    setNoteTarget(null); setDiaryTarget(null); setCalTarget(null); setCalTargetStart(null);
    setTodoTarget(null); setReminderTarget(null); setPersonTarget(null);
    setMailTarget(null);
  }

  // No database to open any more — the data lives behind the API, and the
  // AuthGate above this component has already established a session by the
  // time it mounts. All that's left is to start the reminder poller.
  useEffect(() => {
    startReminderPoller();
    // The Widgets settings follow the account, so this pulls them into the
    // local bucket once per sign-in (AuthGate remounts this per user). NOT
    // awaited before `setReady`: it never throws, and blocking the whole app on
    // a settings round-trip would trade a working offline launch for a weather
    // location arriving a second earlier. A widget reading the old value for
    // that second re-renders when the day's revision next bumps.
    void syncSettingsFromCloud();
    setReady(true);
  }, []);

  // Settings are scoped per account, so the theme main.tsx applied at boot was
  // read from whichever bucket was current then — signing in can change it.
  // AuthGate remounts this component per user, which makes mount the moment to
  // re-apply. The subscription keeps "system" live while the app is open.
  useEffect(() => {
    applyTheme();
    return watchSystemTheme();
  }, []);


  if (!ready) {
    return <div className="flex h-full items-center justify-center text-neutral-400">{t("common.loading")}</div>;
  }

  // One search box, rendered in the sidebar on desktop and in the mobile top
  // bar. Only ever one of the two is visible, so they can share the state.
  const searchBox = (
    <div className="relative">
      <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
      <input
        value={search}
        onChange={(e) => { clearTargets(); setSearch(e.target.value); setView(e.target.value ? "search" : "today"); }}
        placeholder={t("app.searchPlaceholder")}
        className="w-full rounded-lg border border-neutral-200 py-1.5 pl-8 pr-3 text-sm outline-none focus:border-blue-400 dark:border-neutral-600 dark:bg-neutral-800"
      />
    </div>
  );

  return (
    // Column on a phone (top bar above the view, sidebar out of flow), row from
    // `md` — which is the original layout, unchanged.
    <div className="flex h-full flex-col md:flex-row">
      {/* Mobile top bar. The drawer holds the navigation, so this only needs
          the toggle and the search field; `md:hidden` keeps it off desktop. */}
      <header className="flex shrink-0 items-center gap-2 border-b border-neutral-200 bg-white px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))] dark:border-neutral-700 dark:bg-neutral-900 md:hidden">
        <button
          onClick={() => setNavOpen(true)}
          aria-label={t("app.openMenu")}
          className="rounded-lg p-2 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          <Menu size={20} />
        </button>
        <div className="min-w-0 flex-1">{searchBox}</div>
      </header>

      {/* The drawer's scrim. Rendered only while open, and only below `md`. */}
      {navOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden
        />
      )}

      {/* Sidebar */}
      <nav
        className={`fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 flex-col overflow-y-auto border-r border-neutral-200 bg-white pt-[env(safe-area-inset-top)] transition-transform duration-200 dark:border-neutral-700 dark:bg-neutral-900 md:static md:z-auto md:w-52 md:translate-x-0 md:overflow-visible md:pt-0 md:transition-none ${
          navOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center gap-2 px-4 py-4 text-lg font-bold">
          <Brain size={22} className="shrink-0 text-blue-600" />
          <span className="min-w-0 truncate">{t("app.name")}</span>
        </div>
        {/* The mobile top bar already carries the search field. */}
        <div className="hidden px-2 md:block">
          <div className="mb-3">{searchBox}</div>
        </div>
        <div className="flex-1 space-y-0.5 px-2">
          {NAV.filter((n) => n.id !== "mail" || mailConnected).map((n) => {
            const Icon = n.icon;
            return (
              <button
                key={n.id}
                onClick={() => navigate(n.id)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${
                  view === n.id ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
                }`}
              >
                <Icon size={18} className="shrink-0" />
                <span className="min-w-0 truncate">{t(`nav.${n.id}`)}</span>
              </button>
            );
          })}
        </div>
        {/* Account row. Signing out unmounts the whole tree via AuthGate,
            which is what clears the assistant transcript and aborts any turn
            in flight — both correct when someone else may be about to sign in. */}
        <div className="border-t border-neutral-200 px-4 py-2 dark:border-neutral-700">
          <p className="truncate text-xs text-neutral-500" title={account?.user.email}>
            {account?.user.email}
          </p>
          <button
            onClick={signOut}
            className="mt-1 flex items-center gap-1.5 text-xs font-medium text-neutral-500 hover:text-red-600"
          >
            <LogOut size={13} className="shrink-0" />
            {t("auth.signOut")}
          </button>
        </div>

        <div className="px-2 pb-[max(0.25rem,env(safe-area-inset-bottom))] pt-1 md:pb-1">
          <button
            onClick={() => navigate("settings")}
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${
              view === "settings" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
            }`}
          >
            <SettingsIcon size={18} className="shrink-0" />
            <span className="min-w-0 truncate">{t("nav.settings")}</span>
          </button>
        </div>
      </nav>

      {/* Main */}
      {/* `min-h-0` matters only in the mobile column layout, where the view
          must scroll inside what's left below the top bar rather than push it
          off screen. In the `md` row layout it changes nothing. */}
      <main className="min-h-0 flex-1 overflow-hidden bg-neutral-50 dark:bg-neutral-900">
        {view === "today" && <TodayView onChange={bump} goTo={(v, target) => navigate(v as View, target)} />}
        {view === "calendar" && <CalendarView onChange={bump} openEventId={calTarget ?? undefined} openEventStart={calTargetStart ?? undefined} />}
        {view === "reminders" && <RemindersView onChange={bump} initialId={reminderTarget ?? undefined} />}
        {view === "todos" && <TodosView onChange={bump} initialId={todoTarget ?? undefined} />}
        {view === "notes" && <NotesView onChange={bump} initialId={noteTarget ?? undefined} />}
        {view === "diary" && <DiaryView onChange={bump} initialDate={diaryTarget ?? undefined} />}
        {view === "people" && <PeopleView onChange={bump} initialId={personTarget ?? undefined} />}
        {view === "mail" && <MailView target={mailTarget ?? undefined} />}
        {view === "assistant" && (
          <AssistantView
           
            chat={chat}
            goTo={(v, target) => navigate(v as View, target)}
          />
        )}
        {view === "settings" && <SettingsView />}
        {view === "search" && <SearchView query={search} goTo={(v, target) => navigate(v as View, target)} />}
      </main>

      {/* The floating chat window: outside <main> so navigating to an item card
          leaves it open, and so it floats above whatever view is mounted.
          Hidden on the assistant page (it *is* the assistant page there) and
          when there's no model configured — a button on every page that only
          says "go to Settings" is noise. isAssistantConfigured() reads
          localStorage, so it's recomputed on each render rather than held in
          state; a view change after adding a key is enough to reveal it. */}
      {view !== "assistant" && isAssistantConfigured() && (
        <AssistantPopup
          chat={chat}
          goTo={(v, target) => navigate(v as View, target)}
          open={popupOpen}
          setOpen={setPopupOpen}
        />
      )}

    </div>
  );
}
