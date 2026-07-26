import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft, Ban, Check, ChevronDown, Copy, Download, Inbox, Link2, Loader2, Paperclip,
  RefreshCw, Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { MAIL_MAX_ATTACHMENT_BYTES } from "@secondbrain/shared";
import { getMailSettings, saveMailSettings, type MailFolder } from "../lib/settings";
import {
  byDateDescending, DEFAULT_MAILBOX, deleteMessage, getMessage, listFolders, loadHeaders, mailboxStatus,
  markSeen, moveToInbox, moveToJunk, peekMessage, resolveJunkMailbox, resolveTrashMailbox, saveAttachment,
  searchMail, splitQuoted,
  type MailAddress, type MailAttachment, type MailboxStatus, type MailLink, type MailMessageDetail,
  type MailMessageSummary,
} from "../lib/mail";
import { fmtBytes, fmtDateTime } from "../lib/format";
import { isTauri } from "../lib/platform";
import { Button } from "../components/ui";
import { useFirstLoad, firstLoadScreen, SlowLoad } from "../components/ViewGate";

/**
 * The mail reader.
 *
 * Unlike every other view in this app, NOTHING here is backed by a row. There
 * is no mail table, no id in our namespace and no cache on disk: each list is a
 * live IMAP query and each message is fetched when you open it. So the two
 * habits the other views can afford — reload on every keystroke, remount and
 * refetch freely — are exactly what this must not do. A query here costs a TLS
 * handshake and a round-trip to Apple.
 *
 * Three consequences, all deliberate:
 *   - **The search box is debounced and only searched on settle** (the same
 *     trap `searchEvents` documents for CalDAV: a keystroke is a network call).
 *   - **Opened messages are remembered for the life of the view**, so clicking
 *     back and forth between two messages doesn't re-fetch either.
 *   - **A small, named set of writes: mark-as-read, delete and move.** Opening a
 *     message marks it read (`markSeen`); the toolbar has Delete (to Trash, or
 *     an expunge from Trash) and Move to Junk / Move to Inbox. All are UI-only —
 *     the assistant builds none of these ops, so asking it to read mail never
 *     changes a flag. There is still no reply and no send.
 *
 * The one thing here that renders sender-controlled data as anything other than
 * inert text is the LINK LIST, and it renders it as data rather than as markup:
 * see `MessageLinks` and `safeLink` in `mime.ts`. The body itself is still plain
 * text with nothing in it clickable.
 */

/** Long enough that typing a word is one query, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 500;

/** Messages per page. Each one is a round-trip to Apple, which is why the next
 *  page is a button rather than a scroll position. */
const PAGE_SIZE = 50;

function senderLabel(from: MailAddress[]): string {
  const first = from[0];
  if (!first) return "";
  return first.name ?? first.address;
}

/**
 * One button in the open-message toolbar.
 *
 * A single style so Delete — and the actions still to come (Move to Junk,
 * Summarize, Reply) — read as one row rather than a pile of one-off buttons.
 * `danger` is the destructive tint (Delete); `busy` swaps the icon for a
 * spinner. The label collapses to icon-only below `sm`, where the pane is
 * narrow, but stays in the accessible name.
 */
function ToolbarButton({
  icon, label, onClick, disabled = false, danger = false, busy = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  busy?: boolean;
}) {
  const tone = danger
    ? "text-neutral-600 hover:bg-red-50 hover:text-red-600 dark:text-neutral-300 dark:hover:bg-red-950/40 dark:hover:text-red-400"
    : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors disabled:opacity-50 ${tone}`}
    >
      {busy ? <Loader2 size={15} className="animate-spin" /> : icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

/** Above this many, the link list arrives collapsed. A sign-in mail has one or
 *  two and wants them in sight; a newsletter has forty and doesn't. */
const LINKS_SHOWN_UNCOLLAPSED = 6;

/**
 * Open a link out of a message — in the USER'S BROWSER, never in here.
 *
 * This webview holds the signed-in session, and a message body is written by a
 * stranger. Same call and same reasoning as `RssWidget` and `YouTubeEmbed`. It
 * is also why a link is a `<button>` rather than an `<a href>`: in the packaged
 * app an anchor navigates the webview itself away from the application.
 *
 * The url is safe by construction — `safeLink` in `mime.ts` built it, so it is
 * already parsed, already http/https/mailto, already credential-free. On the
 * web `window.open` would happily run a `javascript:` url in this origin, which
 * is why that filter lives at parse time and not here.
 */
function openLink(url: string): void {
  if (isTauri()) void openUrl(url);
  else window.open(url, "_blank", "noopener");
}

/**
 * One link: where it really goes, what the sender called it, and the address.
 *
 * The HOST leads, in the strongest type in the row, because it is the only part
 * of a link that decides where the request lands and the only part the sender
 * cannot dress up — `MailLink.host` comes from `URL.hostname`, so a display
 * name of "apple.com" over a link to `evil.com` shows `evil.com` here, and an
 * IDN homograph shows its punycode. The sender's own words sit beside it,
 * clearly secondary, and the full address is underneath. Never the label alone:
 * hiding the address is the entire phishing surface this feature could add.
 */
function LinkRow({ link, index }: { link: MailLink; index: number }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard permission. The address is on screen to be read either way.
    }
  }

  return (
    <li className="flex items-start gap-1">
      <span className="w-5 shrink-0 pt-2 text-right text-xs tabular-nums text-neutral-400">{index}</span>
      <button
        onClick={() => openLink(link.url)}
        title={t("mail.openLink")}
        className="min-w-0 flex-1 rounded-lg px-2 py-1.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        <span className="flex items-baseline gap-2">
          <span className="shrink-0 truncate text-sm font-medium text-blue-700 dark:text-blue-400">
            {link.host}
          </span>
          {link.label && (
            <span className="min-w-0 flex-1 truncate text-xs text-neutral-500">{link.label}</span>
          )}
        </span>
        <span className="mt-0.5 block truncate text-xs text-neutral-400">{link.url}</span>
      </button>
      <button
        onClick={() => void copy()}
        title={copied ? t("mail.copied") : t("mail.copyLink")}
        aria-label={copied ? t("mail.copied") : t("mail.copyLink")}
        className="mt-1 shrink-0 rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </li>
  );
}

/**
 * The links a message offered, as a list rather than as clickable body text.
 *
 * This is the whole point of the feature and the reason it is safe. The body
 * still renders as inert plain text; what changes is that `htmlToText` no
 * longer *destroys* the hrefs it flattens — an `<a href="…/verify?token=…">Verify
 * your email</a> used to become three words with no way back to the address,
 * which made HTML-only sign-in mail unusable rather than merely plain.
 *
 * Numbers line up with the `[n]` markers left in the body, so "Verify" can be
 * told from the footer's "Privacy policy" in a message carrying forty of them.
 * Rows past the last marker had no anchor to mark: bare URLs spelled out in the
 * text, and links that lived only in an alternative part the body didn't
 * come from.
 */
function MessageLinks({ links }: { links: MailLink[] }) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(links.length > LINKS_SHOWN_UNCOLLAPSED);
  if (links.length === 0) return null;

  return (
    <section className="mt-6 rounded-xl border border-neutral-200 p-2 dark:border-neutral-700">
      <button
        onClick={() => setCollapsed(!collapsed)}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800"
      >
        <Link2 size={14} className="shrink-0 text-neutral-400" />
        <span className="flex-1">{t("mail.links", { count: links.length })}</span>
        <ChevronDown
          size={15}
          className={`shrink-0 text-neutral-400 transition-transform ${collapsed ? "" : "rotate-180"}`}
        />
      </button>
      {!collapsed && (
        <>
          <ul className="mt-1 space-y-0.5">
            {links.map((link, i) => <LinkRow key={link.url} link={link} index={i + 1} />)}
          </ul>
          <p className="mt-2 px-2 pb-1 text-xs text-neutral-400">{t("mail.linksNote")}</p>
        </>
      )}
    </section>
  );
}

/**
 * The message text, with the thread underneath it folded away.
 *
 * PLAIN TEXT, deliberately. `mime.ts` has already flattened any HTML part, and
 * what lands here is never fed to a markdown renderer or
 * `dangerouslySetInnerHTML`: a message body is arbitrary markup written by a
 * stranger, and this webview holds the user's session. The body's own text is
 * not made clickable either — links are offered separately, with their real
 * destination shown, which is the difference between reading a link and being
 * invited to trust one.
 *
 * The split is DISPLAY only: `detail.body` still holds the whole message, so
 * search reaches the trail and the assistant still has the earlier context.
 */
function MessageBody({ body }: { body: string }) {
  const { t } = useTranslation();
  const [showQuoted, setShowQuoted] = useState(false);
  const { visible, quoted } = useMemo(() => splitQuoted(body), [body]);

  return (
    <>
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
        {visible || t("mail.noBody")}
      </p>
      {quoted && (
        <>
          <button
            onClick={() => setShowQuoted(!showQuoted)}
            aria-expanded={showQuoted}
            className="mt-3 rounded-lg bg-neutral-100 px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700"
          >
            {showQuoted ? t("mail.hideQuoted") : t("mail.showQuoted")}
          </button>
          {showQuoted && (
            <p className="mt-2 whitespace-pre-wrap break-words border-l-2 border-neutral-200 pl-3 text-sm leading-relaxed text-neutral-500 dark:border-neutral-700">
              {quoted}
            </p>
          )}
        </>
      )}
    </>
  );
}

/**
 * The list's "still loading this mailbox" row.
 *
 * Held back briefly — like `ViewGate`'s `ViewLoading` — so switching to a
 * mailbox already in the cache resolves before the spinner ever paints, and
 * only a real network wait shows it. This is what a switch shows *instead* of
 * "Nothing in this mailbox.", which would otherwise read as an answer before
 * the question has been asked.
 */
function MailboxLoading() {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setShow(true), 150);
    return () => clearTimeout(id);
  }, []);
  if (!show) return null;
  return (
    <p className="flex items-center gap-2 p-4 text-sm text-neutral-400" role="status" aria-live="polite">
      <Loader2 size={15} className="animate-spin" /> {t("mail.loadingMailbox")}
    </p>
  );
}

export default function MailView({ target }: { target?: MailMessageSummary }) {
  const { t } = useTranslation();
  const account = getMailSettings().account;

  const [mailbox, setMailbox] = useState(DEFAULT_MAILBOX);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState<MailMessageSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState("");
  // A list-level load flag, separate from the first-load gate (which only blocks
  // the very first arrival on the page). Every later `load` — a mailbox switch,
  // a filter change — sets it, so an empty list can tell "still loading" from
  // "genuinely nothing here" instead of showing the empty text over both.
  const [loading, setLoading] = useState(false);
  // The uid list is a SNAPSHOT, taken once per search and paged over. That is
  // what makes paging safe against mail arriving mid-session, and it is a
  // property of uids rather than luck: uids ascend with arrival, so a new
  // message is always above the window being paged, never inside it. Offset
  // paging is what duplicates and skips rows.
  const [uids, setUids] = useState<number[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  // What the server last said about this mailbox, to compare a later STATUS
  // against. Seeded free of charge by the search's own EXAMINE.
  //
  // It carries the filter it was taken under, because a focus event can land
  // between changing mailbox and that mailbox's search returning — comparing
  // the new mailbox's numbers against the old one's would read as "everything
  // changed" at best and prepend another mailbox's mail at worst.
  const status = useRef<(MailboxStatus & { key: string }) | null>(null);
  const filterKey = `${mailbox}|${query}|${unreadOnly}`;
  const [folders, setFolders] = useState<MailFolder[]>(account?.folders ?? []);

  const [selected, setSelected] = useState<MailMessageSummary | null>(null);
  const [detail, setDetail] = useState<MailMessageDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  /** The part number currently downloading, or "" — one at a time, because the
   *  op is a login and a multi-megabyte read and firing several is a way to
   *  spend a rate-limit budget by double-clicking. */
  const [downloading, setDownloading] = useState("");
  const [downloadError, setDownloadError] = useState("");
  /** The toolbar action in flight, or null — one at a time across every action,
   *  so a double-click (or clicking Delete then Junk) can't fire two moves at
   *  the same message. Carries the uid so the spinner lands on the right button. */
  const [busy, setBusy] = useState<{ uid: number; action: "delete" | "junk" | "inbox" } | null>(null);
  const [actionError, setActionError] = useState("");

  // The typed query only becomes the searched one after it settles.
  useEffect(() => {
    const id = setTimeout(() => setQuery(typed.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [typed]);

  const load = async (refresh = false) => {
    if (!account) return;
    setError("");
    setLoading(true);
    try {
      const found = await searchMail(account, {
        mailbox, query: query || undefined, unseen: unreadOnly, limit: PAGE_SIZE, refresh,
      });
      setMessages(found.results);
      setUids(found.uids);
      setTotal(found.total);
      setTruncated(found.truncated);
      status.current = { ...found.status, key: filterKey };
      // A cached list is not a validated one — nothing about serving it from
      // memory knows whether mail arrived since. So the STATUS check runs, and
      // runs only here: a result that just came off the network has, by
      // definition, already asked.
      if (found.cached) void checkForNewMail();
    } catch (e) {
      // Held in the view rather than thrown at the gate: a failed *filter*
      // should not replace a list that is already on screen with an error page.
      setError(e instanceof Error ? e.message : String(e));
      setMessages([]);
      setUids([]);
      setTotal(0);
      status.current = null;
    } finally {
      setLoading(false);
    }
  };

  const gate = useFirstLoad(load, [mailbox, query, unreadOnly]);

  /**
   * The next page: headers for uids we already hold.
   *
   * One small fetch, never a second search — the server has already told us
   * which messages match, and asking again would make it re-evaluate the query
   * against the whole mailbox to produce a list we have in a variable.
   */
  async function loadOlder() {
    if (!account || loadingMore) return;
    setLoadingMore(true);
    setError("");
    try {
      const next = uids.slice(messages.length, messages.length + PAGE_SIZE);
      const older = await loadHeaders(account, next, mailbox);
      // Appended, not merged: `uids` is newest-first and so is each page, so
      // concatenation is already in order. A message deleted since the snapshot
      // comes back missing, which is a gap and never a wrong row.
      setMessages((current) => [...current, ...older]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingMore(false);
    }
  }

  /**
   * Has anything arrived while we weren't looking?
   *
   * `STATUS` is one cheap command carrying no message data, and it answers
   * *exactly* what a cache TTL can only guess at. Unchanged `uidnext` and
   * `messages` mean the list on screen is provably current — no fetch at all.
   * A moved `uidnext` costs one narrow search of just the new uid range, never
   * a re-search of the mailbox.
   *
   * **On focus, never on a timer.** STATUS still needs a connection and a
   * login, so a poll every N seconds is a login every N seconds forever,
   * including while nobody is looking — the same objection that keeps the Today
   * summary off a timer.
   */
  async function checkForNewMail() {
    const previous = status.current;
    if (!account || !previous || previous.key !== filterKey) return;
    try {
      const now = await mailboxStatus(account, mailbox);
      // Another filter change may have landed while STATUS was in flight; the
      // answer is about a mailbox nobody is looking at any more.
      if (status.current?.key !== previous.key) return;
      status.current = { ...now, key: filterKey };

      // UIDVALIDITY moved: every uid on this screen now names a *different*
      // message, so the list is not stale, it is meaningless. `mailboxStatus`
      // has already dropped the cache for this mailbox; this re-searches into
      // the empty space that leaves. No comparison of counts could detect it,
      // which is the whole reason it is plumbed through the executors.
      if (previous.uidvalidity && now.uidvalidity && now.uidvalidity !== previous.uidvalidity) {
        await load();
        return;
      }

      if (now.uidnext === previous.uidnext && now.messages === previous.messages) {
        // Provably current, including the unread dots — unless something was
        // read in another client, which moves neither of those two.
        if (previous.unseen === null || now.unseen === previous.unseen) return;
        await load();
        return;
      }
      // Everything except a clean arrival goes back to the search. A deletion,
      // arrivals mixed with deletions, or a server that never told us a
      // `uidnext` to count from cannot be expressed as "fetch the new uids" —
      // correctness over cleverness on the rare path. Note the zero check is
      // load-bearing: without it, `uidMin: 0` is no filter at all, and the
      // first page would be prepended to the list it is already the top of.
      if (previous.uidnext === 0 || now.uidnext <= previous.uidnext || now.messages < previous.messages) {
        await load();
        return;
      }

      const found = await searchMail(account, {
        mailbox, query: query || undefined, unseen: unreadOnly,
        uidMin: previous.uidnext, limit: PAGE_SIZE,
      });
      if (status.current?.key !== previous.key) return;
      if (found.uids.length === 0) return; // new mail, none of it matching this filter
      // More arrivals than one page: prepending the uids without their headers
      // would put the paging offset out of step with the list, so the rare case
      // reloads instead. `loadOlder` slices `uids` at `messages.length`, and
      // that only holds while the two stay in lockstep.
      if (found.uids.length > found.results.length) {
        await load();
        return;
      }
      // Re-sort by DATE after merging, not just prepend: a message *moved* into
      // this mailbox (Move to Inbox) has a fresh high uid but an old Date, so it
      // is a new arrival by uid yet belongs lower down by date. The uid snapshot
      // stays uid-ordered (highest first) for paging; only the display sorts by
      // date, exactly as the first page already does.
      setMessages((current) => byDateDescending([...found.results, ...current]));
      setUids((current) => [...found.uids, ...current]);
      setTotal((current) => current + found.uids.length);
    } catch {
      // A freshness check is a nicety. Failing it must not put an error over a
      // list that is on screen and readable.
    }
  }

  // Mount and refocus, and nothing else. `gate` already covers the first load,
  // so this only ever runs against a list that is already showing.
  useEffect(() => {
    const onFocus = () => { void checkForNewMail(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  });

  /**
   * Re-LIST the mailboxes on mount.
   *
   * A folder created in Apple Mail used to need a trip to Settings and a
   * Reconnect before it appeared here, because the list was only ever written
   * at connect time. It is still cached in settings — the picker must render
   * before the network answers — but the cache is now refreshed rather than
   * frozen. Failure is silent: the cached list is what was already going to be
   * shown.
   */
  useEffect(() => {
    if (!account) return;
    let live = true;
    void listFolders(account)
      .then((found) => {
        if (!live || found.length === 0) return;
        setFolders(found);
        saveMailSettings({ account: { ...account, folders: found } });
      })
      .catch(() => { /* the cached list stands */ });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * The refresh button, which bypasses the cache rather than merely re-running
   * the load.
   *
   * Without the bypass it would re-serve exactly what is already on screen,
   * which is the one thing a refresh button must not do. It is also the only
   * escape hatch from a freshness check that is wrong for any reason we didn't
   * anticipate, so it goes all the way to the server every time.
   */
  async function hardRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await load(true);
    } finally {
      setRefreshing(false);
    }
  }

  /**
   * Fetch one attachment and hand it to the platform's save path.
   *
   * The refusals — no part number, too large, truncated — live in
   * `saveAttachment` rather than here, so the assistant would get them too if it
   * ever gained this (it does not: a tool that pulls 10 MB into a chat turn has
   * no use for bytes it cannot read).
   */
  async function download(message: MailMessageDetail, attachment: MailAttachment, id: string) {
    if (downloading) return;
    setDownloading(id);
    setDownloadError("");
    try {
      await saveAttachment(account!, message.mailbox, message.uid, attachment);
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloading("");
    }
  }

  /**
   * Mark the opened message read — the reader's one automatic write.
   *
   * Optimistic: the unread dot and the bold subject clear the instant the
   * message is opened, in the list and in the header, and the server write runs
   * in the background. A failed write is swallowed on purpose — a flag that
   * didn't stick must never surface an error over a message the user is reading,
   * and the next STATUS/refresh will correct the dot. Deliberately separate from
   * `getMessage`, which the assistant also calls: reading mail aloud leaves it
   * unread.
   */
  function markRead(summary: MailMessageSummary) {
    if (summary.seen) return;
    const seenNow = { seen: true };
    setSelected((current) => (current?.uid === summary.uid ? { ...current, ...seenNow } : current));
    setMessages((current) => current.map((m) => (m.uid === summary.uid && m.mailbox === summary.mailbox ? { ...m, ...seenNow } : m)));
    setDetail((current) => (current?.uid === summary.uid ? { ...current, ...seenNow } : current));
    void markSeen(account!, summary.uid, summary.mailbox).catch(() => {
      /* a flag that didn't take is a cosmetic dot; the next STATUS corrects it */
    });
  }

  async function open(summary: MailMessageSummary) {
    setSelected(summary);
    setDetailError("");
    setDownloadError("");
    setActionError("");
    markRead(summary);
    // Asked synchronously, because `getMessage` is async even on a hit: showing
    // a loading state and replacing it in the next tick is a flicker on every
    // click between two already-read messages. The view keeps no cache of its
    // own any more — that one helped only this page, where `cache.ts` behind
    // `mailbox.ts` also serves the assistant.
    const held = peekMessage(account!, summary.uid, summary.mailbox);
    if (held) { setDetail(held); return; }
    setDetail(null);
    setLoadingDetail(true);
    try {
      setDetail(await getMessage(account!, summary.uid, summary.mailbox));
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingDetail(false);
    }
  }

  /** Drop a message from the list snapshot after it has moved out of the
   *  mailbox (deleted or filed). Keeps `messages`/`uids`/`total` in step so
   *  paging stays correct, and closes the now-empty message pane. */
  function removeFromList(summary: MailMessageSummary) {
    setMessages((current) => current.filter((m) => !(m.uid === summary.uid && m.mailbox === summary.mailbox)));
    setUids((current) => current.filter((u) => u !== summary.uid));
    setTotal((current) => Math.max(0, current - 1));
    setSelected(null);
    setDetail(null);
  }

  /**
   * Delete the open message — moved to Trash, reversible.
   *
   * Confirmed first (`window.confirm` works in this WKWebView; `window.prompt`
   * does not — see CLAUDE.md), then removed from the list snapshot. The confirm
   * wording is stronger when the message is already in Trash, where the delete
   * op expunges it for good.
   */
  async function remove(summary: MailMessageSummary) {
    if (busy) return;
    const inTrash = summary.mailbox === resolveTrashMailbox(account!);
    if (!window.confirm(t(inTrash ? "mail.deleteConfirmPermanent" : "mail.deleteConfirm"))) return;
    setBusy({ uid: summary.uid, action: "delete" });
    setActionError("");
    try {
      await deleteMessage(account!, summary.uid, summary.mailbox);
      removeFromList(summary);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  /**
   * File the open message into another folder.
   *
   * No confirmation, unlike delete: a move is reversible (the message is in the
   * other folder, not gone) and low-stakes, which is how Apple Mail treats it
   * too. Shared by Move to Junk and Move to Inbox.
   */
  async function runMove(summary: MailMessageSummary, action: "junk" | "inbox", move: () => Promise<void>) {
    if (busy) return;
    setBusy({ uid: summary.uid, action });
    setActionError("");
    try {
      await move();
      removeFromList(summary);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const moveJunk = (summary: MailMessageSummary) =>
    runMove(summary, "junk", () => moveToJunk(account!, summary.uid, summary.mailbox));
  const moveInbox = (summary: MailMessageSummary) =>
    runMove(summary, "inbox", () => moveToInbox(account!, summary.uid, summary.mailbox));

  // Open a specific message when navigated here with a target — a hit from the
  // global search bar, which searches the inbox. Only fires once, so it can't
  // re-open after the user has closed it. The summary carries its own mailbox,
  // so the list behind the message is put on the right folder too.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !target || !account) return;
    opened.current = true;
    if (target.mailbox !== mailbox) setMailbox(target.mailbox);
    void open(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  // Disconnecting while this view is open. The sidebar entry goes at the same
  // time, so this is only ever seen for the instant before navigation.
  if (!account) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <p className="max-w-sm text-sm text-neutral-500">{t("mail.connectPrompt")}</p>
      </div>
    );
  }

  const blocked = firstLoadScreen(gate);
  if (blocked) return blocked;

  const picker = folders.length > 0
    ? folders
    : [{ name: DEFAULT_MAILBOX, label: DEFAULT_MAILBOX, delimiter: "/", flags: [] }];
  const hasOlder = messages.length < uids.length;

  return (
    <div className="relative flex h-full">
      <SlowLoad state={gate} />

      {/* Message list. Below `md` the panes take turns owning the screen, the
          same rule Notes and People follow — a 384px list beside a message
          leaves neither readable on a phone. */}
      <aside className={`w-full shrink-0 flex-col border-r border-neutral-200 dark:border-neutral-700 md:flex md:w-96 ${selected ? "hidden" : "flex"}`}>
        <div className="space-y-2 border-b border-neutral-200 p-3 dark:border-neutral-700">
          <div className="flex items-center gap-2">
            <select
              value={mailbox}
              onChange={(e) => {
                // Clear the list on a mailbox switch so the loading state shows
                // instead of the previous folder's mail (or, worse, its empty
                // text read as this folder's). A filter change keeps its list —
                // the debounce means it is about to be replaced, not emptied.
                setMailbox(e.target.value);
                setSelected(null); setDetail(null);
                setMessages([]); setUids([]); setTotal(0);
                setLoading(true);
              }}
              className="min-w-0 flex-1 rounded-lg border border-neutral-200 px-2 py-1.5 text-sm outline-none focus:border-blue-400 dark:border-neutral-600 dark:bg-neutral-800"
            >
              {/* `label` is the decoded name; `value` stays exactly what the
                  server called the mailbox, because that is what goes back. */}
              {picker.map((f) => <option key={f.name} value={f.name}>{f.label ?? f.name}</option>)}
            </select>
            <button
              onClick={() => void hardRefresh()}
              disabled={refreshing}
              title={t("mail.refresh")}
              aria-label={t("mail.refresh")}
              className="shrink-0 rounded-lg border border-neutral-200 p-2 text-neutral-500 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
            >
              <RefreshCw size={15} className={refreshing ? "animate-spin" : undefined} />
            </button>
          </div>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={t("mail.searchPlaceholder")}
            className="w-full rounded-lg border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-blue-400 dark:border-neutral-600 dark:bg-neutral-800"
          />
          <label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-500">
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(e) => setUnreadOnly(e.target.checked)}
              className="h-3.5 w-3.5 accent-blue-600"
            />
            {t("mail.unreadOnly")}
          </label>
        </div>

        <div className="flex-1 overflow-y-auto">
          {error && (
            <p className="m-3 rounded-lg bg-red-50 p-3 text-sm leading-relaxed text-red-600 dark:bg-red-950/40">{error}</p>
          )}
          {/* Loading beats empty: a mailbox mid-load has no answer yet, so the
              "nothing here" text would be a wrong one. Only once the load has
              settled with zero results is the list genuinely empty. */}
          {!error && messages.length === 0 && loading && <MailboxLoading />}
          {!error && messages.length === 0 && !loading && (
            <p className="p-4 text-sm text-neutral-400">{query || unreadOnly ? t("mail.noMatches") : t("mail.empty")}</p>
          )}
          {messages.map((m) => (
            <button
              key={`${m.mailbox}|${m.uid}`}
              onClick={() => void open(m)}
              className={`block w-full border-b border-neutral-100 px-3 py-2 text-left dark:border-neutral-800 ${
                selected?.uid === m.uid ? "bg-blue-50 dark:bg-blue-900/30" : "hover:bg-neutral-50 dark:hover:bg-neutral-800"
              }`}
            >
              <div className="flex items-baseline gap-2">
                {!m.seen && <span className="h-2 w-2 shrink-0 rounded-full bg-blue-500" aria-hidden />}
                <span className={`min-w-0 flex-1 truncate text-sm ${m.seen ? "" : "font-semibold"}`}>
                  {senderLabel(m.from) || t("mail.unknownSender")}
                </span>
                <span className="shrink-0 text-xs text-neutral-400">
                  {m.date ? fmtDateTime(m.date) : ""}
                </span>
              </div>
              <div className={`truncate text-sm ${m.seen ? "text-neutral-500" : "text-neutral-800 dark:text-neutral-200"}`}>
                {m.subject}
              </div>
            </button>
          ))}
          {/* An explicit button, deliberately not infinite scroll: each page is
              a TLS handshake, a login and a round-trip to Apple, and a
              scroll-triggered fetch would fire them by accident. */}
          {hasOlder && (
            <div className="p-3">
              <Button onClick={() => void loadOlder()} disabled={loadingMore}>
                {loadingMore ? t("common.loading") : t("mail.loadOlder")}
              </Button>
            </div>
          )}
          {/* The count is the honest bit: IMAP has no ranking, so this is the
              newest slice of a match set, not the best of it — and `truncated`
              now means the mailbox is deeper than we will page, not merely
              deeper than one page. */}
          {messages.length > 0 && (
            <p className="px-3 pb-3 text-xs text-neutral-400">
              {truncated
                ? t("mail.showingCapped", { count: messages.length, total })
                : hasOlder
                  ? t("mail.showingOf", { count: messages.length, total })
                  : t("mail.showingAll", { count: messages.length })}
            </p>
          )}
        </div>
      </aside>

      {/* Message */}
      <section className={`min-w-0 flex-1 flex-col overflow-y-auto md:flex ${selected ? "flex" : "hidden"}`}>
        {!selected && (
          <div className="flex h-full items-center justify-center p-8 text-center">
            <p className="flex items-center gap-2 text-sm text-neutral-400">
              <Inbox size={16} /> {t("mail.selectPrompt")}
            </p>
          </div>
        )}

        {selected && (
          <div className="mx-auto w-full max-w-3xl p-4 md:p-8">
            {/* The message toolbar. Delete and Move to Junk live here today;
                Summarize and Reply will slot in beside them. Back sits at the far
                left below `md`, where the list is hidden behind the message and
                there is nowhere else to return from. */}
            <div className="mb-4 flex items-center gap-1 border-b border-neutral-200 pb-3 dark:border-neutral-700">
              <div className="md:hidden">
                <ToolbarButton
                  icon={<ArrowLeft size={15} />}
                  label={t("common.back")}
                  onClick={() => { setSelected(null); setDetail(null); }}
                />
              </div>
              <ToolbarButton
                icon={<Trash2 size={15} />}
                label={t("mail.delete")}
                onClick={() => void remove(selected)}
                disabled={busy !== null}
                busy={busy?.action === "delete" && busy.uid === selected.uid}
                danger
              />
              {/* Hidden when the message is already in Junk — moving it there
                  again is a no-op the server would reject. */}
              {selected.mailbox !== resolveJunkMailbox(account) && (
                <ToolbarButton
                  icon={<Ban size={15} />}
                  label={t("mail.junk")}
                  onClick={() => void moveJunk(selected)}
                  disabled={busy !== null}
                  busy={busy?.action === "junk" && busy.uid === selected.uid}
                />
              )}
              {/* Shown only for a junked or deleted message — the way back to
                  the Inbox. Elsewhere there is nothing to restore. */}
              {(selected.mailbox === resolveJunkMailbox(account) || selected.mailbox === resolveTrashMailbox(account)) && (
                <ToolbarButton
                  icon={<Inbox size={15} />}
                  label={t("mail.moveToInbox")}
                  onClick={() => void moveInbox(selected)}
                  disabled={busy !== null}
                  busy={busy?.action === "inbox" && busy.uid === selected.uid}
                />
              )}
            </div>

            {actionError && (
              <p className="mb-4 rounded-lg bg-red-50 p-3 text-sm leading-relaxed text-red-600 dark:bg-red-950/40">{actionError}</p>
            )}

            <h1 className="mb-2 text-xl font-bold leading-snug">{selected.subject}</h1>
            <div className="mb-4 space-y-0.5 border-b border-neutral-200 pb-4 text-sm text-neutral-500 dark:border-neutral-700">
              <p className="truncate">
                {selected.from.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ")}
              </p>
              {detail && detail.to.length > 0 && (
                <p className="truncate">{t("mail.to")}: {detail.to.map((a) => a.address).join(", ")}</p>
              )}
              {detail && detail.cc.length > 0 && (
                <p className="truncate">{t("mail.cc")}: {detail.cc.map((a) => a.address).join(", ")}</p>
              )}
              <p>{selected.date ? fmtDateTime(selected.date) : ""}</p>
            </div>

            {loadingDetail && <p className="text-sm text-neutral-400">{t("common.loading")}</p>}
            {detailError && (
              <p className="rounded-lg bg-red-50 p-3 text-sm leading-relaxed text-red-600 dark:bg-red-950/40">{detailError}</p>
            )}

            {detail && (
              <>
                {detail.attachments.length > 0 && (
                  <div className="mb-4 flex flex-wrap gap-2">
                    {/* Buttons, but nothing is fetched until one is clicked —
                        the size beside each name comes off BODYSTRUCTURE, so
                        the choice is made with the real number in view rather
                        than after ten megabytes have already moved. */}
                    {detail.attachments.map((a, i) => {
                      const id = `${a.part ?? i}`;
                      const busy = downloading === id;
                      const canSave = !!a.part && (a.size ?? 0) <= MAIL_MAX_ATTACHMENT_BYTES;
                      return (
                        <button
                          key={id}
                          onClick={() => void download(detail, a, id)}
                          disabled={!canSave || busy}
                          title={canSave ? t("mail.download") : t("mail.attachmentTooLarge")}
                          className="flex items-center gap-1.5 rounded-lg bg-neutral-100 px-2.5 py-1 text-xs text-neutral-500 enabled:hover:bg-neutral-200 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-neutral-800 dark:text-neutral-400 dark:enabled:hover:bg-neutral-700"
                        >
                          {busy
                            ? <Loader2 size={12} className="shrink-0 animate-spin" />
                            : canSave
                              ? <Download size={12} className="shrink-0" />
                              : <Paperclip size={12} className="shrink-0" />}
                          <span className="max-w-[16rem] truncate">{a.filename ?? a.content_type}</span>
                          {a.size !== null && (
                            <span className="text-neutral-400 dark:text-neutral-500">{fmtBytes(a.size)}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
                {downloadError && (
                  <p className="mb-4 rounded-lg bg-red-50 p-3 text-sm leading-relaxed text-red-600 dark:bg-red-950/40">
                    {downloadError}
                  </p>
                )}
                {/* Keyed on the message so the quoted-text and link toggles
                    start closed on every message, rather than carrying the last
                    one's state across. */}
                <MessageBody key={`body|${detail.mailbox}|${detail.uid}`} body={detail.body} />
                {detail.body_truncated && (
                  <p className="mt-4 text-xs text-neutral-400">{t("mail.truncated")}</p>
                )}
                {/* Below the body, because it is a reading aid for it — and
                    still listed when the body was cut, since the links were
                    harvested from the full text before the cap. */}
                <MessageLinks key={`links|${detail.mailbox}|${detail.uid}`} links={detail.links} />
                {detail.attachments.length > 0 && (
                  <p className="mt-4 text-xs text-neutral-400">{t("mail.attachmentsHint")}</p>
                )}
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
