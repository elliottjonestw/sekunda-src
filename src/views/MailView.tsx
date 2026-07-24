import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, Inbox, Loader2, Paperclip, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MAIL_MAX_ATTACHMENT_BYTES } from "@secondbrain/shared";
import { getMailSettings, saveMailSettings, type MailFolder } from "../lib/settings";
import {
  DEFAULT_MAILBOX, getMessage, listFolders, loadHeaders, mailboxStatus, peekMessage,
  saveAttachment, searchMail,
  type MailAddress, type MailAttachment, type MailboxStatus, type MailMessageDetail,
  type MailMessageSummary,
} from "../lib/mail";
import { fmtBytes, fmtDateTime } from "../lib/format";
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
 *   - **There are no actions.** No delete, no archive, no mark-as-read, no
 *     reply — the connection is opened read-only at the protocol level, so the
 *     absence of buttons here matches what the server would allow anyway.
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

  // The typed query only becomes the searched one after it settles.
  useEffect(() => {
    const id = setTimeout(() => setQuery(typed.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [typed]);

  const load = async (refresh = false) => {
    if (!account) return;
    setError("");
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
      setMessages((current) => [...found.results, ...current]);
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

  async function open(summary: MailMessageSummary) {
    setSelected(summary);
    setDetailError("");
    setDownloadError("");
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
              onChange={(e) => { setMailbox(e.target.value); setSelected(null); setDetail(null); }}
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
          {!error && messages.length === 0 && (
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
            <div className="mb-4 flex items-center gap-2 md:hidden">
              <Button onClick={() => { setSelected(null); setDetail(null); }}>
                <span className="flex items-center gap-1.5"><ArrowLeft size={15} /> {t("common.back")}</span>
              </Button>
            </div>

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
                {/* PLAIN TEXT, deliberately. `mime.ts` has already converted any
                    HTML part, and what lands here is never fed to a markdown
                    renderer or `dangerouslySetInnerHTML`: a message body is
                    arbitrary markup written by a stranger, and this webview
                    holds the user's session. Links are not made clickable for
                    the same reason — a mail link is the phishing surface. */}
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {detail.body || t("mail.noBody")}
                </p>
                {detail.body_truncated && (
                  <p className="mt-4 text-xs text-neutral-400">{t("mail.truncated")}</p>
                )}
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
