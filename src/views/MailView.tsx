import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Inbox, Lock, Paperclip, RefreshCw, MailOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getMailSettings } from "../lib/settings";
import {
  DEFAULT_MAILBOX, getMessage, searchMail,
  type MailAddress, type MailMessageDetail, type MailMessageSummary,
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

function senderLabel(from: MailAddress[]): string {
  const first = from[0];
  if (!first) return "";
  return first.name ?? first.address;
}

export default function MailView() {
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

  const [selected, setSelected] = useState<MailMessageSummary | null>(null);
  const [detail, setDetail] = useState<MailMessageDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [loadingDetail, setLoadingDetail] = useState(false);
  // Keyed by mailbox|uid — a uid means nothing on its own, and the mailbox can
  // change underneath it. Lives for the life of the view, not the session, so a
  // long-open reader can't accumulate an inbox in memory.
  const opened = useRef(new Map<string, MailMessageDetail>());

  // The typed query only becomes the searched one after it settles.
  useEffect(() => {
    const id = setTimeout(() => setQuery(typed.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [typed]);

  const load = async () => {
    if (!account) return;
    setError("");
    try {
      const found = await searchMail(account, { mailbox, query: query || undefined, unseen: unreadOnly, limit: 50 });
      setMessages(found.results);
      setTotal(found.total);
      setTruncated(found.truncated);
    } catch (e) {
      // Held in the view rather than thrown at the gate: a failed *filter*
      // should not replace a list that is already on screen with an error page.
      setError(e instanceof Error ? e.message : String(e));
      setMessages([]);
      setTotal(0);
    }
  };

  const gate = useFirstLoad(load, [mailbox, query, unreadOnly]);

  async function open(summary: MailMessageSummary) {
    setSelected(summary);
    setDetailError("");
    const key = `${summary.mailbox}|${summary.uid}`;
    const cached = opened.current.get(key);
    if (cached) { setDetail(cached); return; }
    setDetail(null);
    setLoadingDetail(true);
    try {
      const full = await getMessage(account!, summary.uid, summary.mailbox);
      opened.current.set(key, full);
      setDetail(full);
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingDetail(false);
    }
  }

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

  const folders = account.folders.length > 0
    ? account.folders
    : [{ name: DEFAULT_MAILBOX, delimiter: "/", flags: [] }];

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
              {folders.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
            </select>
            <button
              onClick={gate.retry}
              title={t("mail.refresh")}
              aria-label={t("mail.refresh")}
              className="shrink-0 rounded-lg border border-neutral-200 p-2 text-neutral-500 hover:bg-neutral-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
            >
              <RefreshCw size={15} />
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
          {/* The count is the honest bit: IMAP has no ranking, so this is the
              newest slice of a match set, not the best of it. */}
          {messages.length > 0 && (
            <p className="p-3 text-xs text-neutral-400">
              {truncated ? t("mail.showingNewest", { count: messages.length, total }) : t("mail.showingAll", { count: messages.length })}
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
                    {detail.attachments.map((a, i) => (
                      <span
                        key={`${a.filename ?? "part"}-${i}`}
                        title={a.content_type}
                        className="flex items-center gap-1.5 rounded-lg bg-neutral-100 px-2.5 py-1 text-xs text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
                      >
                        <Paperclip size={12} className="shrink-0" />
                        {a.filename ?? a.content_type}
                        {/* The size is the server's own count, off BODYSTRUCTURE
                            — not "however much of the part survived the fetch",
                            which is what it used to be and was wrong precisely
                            when the attachment was big enough to care about. */}
                        {a.size !== null && (
                          <span className="text-neutral-400 dark:text-neutral-500">{fmtBytes(a.size)}</span>
                        )}
                      </span>
                    ))}
                  </div>
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

      {/* Said once, on the page, rather than only in the source: this reader
          cannot change anything, and a mail client that shows no Delete button
          should explain why rather than look unfinished. */}
      <div className="pointer-events-none absolute bottom-3 right-4 hidden items-center gap-1.5 text-xs text-neutral-400 md:flex">
        {selected ? <Lock size={12} /> : <MailOpen size={12} />} {t("mail.readOnly")}
      </div>
    </div>
  );
}
