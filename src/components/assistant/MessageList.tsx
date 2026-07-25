// The scrolling transcript: bubbles, the item cards the assistant cited, the
// thinking row and the error box. Shared by the Assistant page and the popup so
// a card renders identically in both — in particular the key, which includes
// the occurrence: a recurring series shares one id across occurrences, and
// keying on id alone collapses them into a single card.

import { useEffect, useRef, ReactNode } from "react";
import { Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";
import { Button } from "../ui";
import { ItemRefCard, VIEW_FOR, targetFor } from "../ItemCard";
import { MailCard } from "../MailCard";
import ConfirmDeleteCard from "./ConfirmDeleteCard";
import type { ConfirmDeleteRequest } from "../../lib/ai";
import type { GoTo } from "../../types";
import type { UiMessage } from "./useAssistantChat";

export default function MessageList({
  messages, goTo, loading, status, error, onStop, empty, compact = false,
  pendingConfirm, onResolveConfirm,
}: {
  messages: UiMessage[];
  goTo: GoTo;
  loading: boolean;
  status: string;
  error: string | null;
  onStop: () => void;
  /** Shown in place of the transcript when there are no messages yet. */
  empty?: ReactNode;
  /** Tighter padding and no centred column, for the popup. */
  compact?: boolean;
  /** A delete the assistant is waiting for the user to approve, or null. */
  pendingConfirm?: ConfirmDeleteRequest | null;
  /** Delivers the user's decision on the pending delete confirmation. */
  onResolveConfirm?: (approved: boolean) => void;
}) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the user is parked at the bottom of the transcript. While they've
  // scrolled up to read history we don't yank them back down on every status
  // flip — only auto-scroll while they're following along.
  const pinnedToBottom = useRef(true);
  const prevLen = useRef(messages.length);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // Threshold accounts for sub-pixel rounding and the smooth-scroll-in-flight
    // case where we haven't quite reached the bottom yet.
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
  };

  useEffect(() => {
    // The user just sent a message themselves: re-pin and follow it down even
    // if they'd scrolled up to quote something. New assistant content (a reply,
    // cited cards) still respects pinnedToBottom so reading history is quiet.
    const grew = messages.length > prevLen.current;
    const userTurn = grew && messages[messages.length - 1]?.role === "user";
    prevLen.current = messages.length;
    if (userTurn) pinnedToBottom.current = true;
    if (!pinnedToBottom.current) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  return (
    // min-h-0 so this actually shrinks and scrolls inside the popup's
    // max-height column instead of pushing the composer off-screen.
    <div ref={scrollRef} onScroll={onScroll} className={`min-h-0 flex-1 overflow-y-auto ${compact ? "p-3" : "p-4 md:p-6"}`}>
      <div className={compact ? "space-y-3" : "mx-auto max-w-2xl space-y-4"}>
        {messages.length === 0 && empty}

        {messages.map((m) => (
          <div key={m.uiId}>
            <div className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${
                  m.role === "user"
                    ? "bg-blue-600 text-white"
                    : "bg-white text-neutral-800 shadow-sm ring-1 ring-neutral-200 dark:bg-neutral-800 dark:text-neutral-100 dark:ring-neutral-700"
                }`}
              >
                {m.role === "assistant" ? (
                  <div className="prose prose-sm max-w-none dark:prose-invert">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                  </div>
                ) : (
                  <span className="whitespace-pre-wrap">{m.content}</span>
                )}
              </div>
            </div>
            {/* Outside the bubble so the cards get the full column width.
                A recurring series shares one id, so the occurrence is part of the key. */}
            {((m.items && m.items.length > 0) || (m.mail && m.mail.length > 0)) && (
              <div className="mt-2 space-y-1">
                {m.items?.map((it) => (
                  <ItemRefCard
                    key={`${it.type}:${it.id}:${it.occurrenceStart ?? ""}`}
                    item={it}
                    onOpen={(r) => goTo(VIEW_FOR[r.type], targetFor(r))}
                  />
                ))}
                {/* Emails the assistant read in full. Mail has no ItemRef, so
                    the summary is carried directly and the card opens it in the
                    Mail reader — the same NavTarget.mail global search uses. */}
                {m.mail?.map((msg) => (
                  <MailCard
                    key={`mail|${msg.mailbox}|${msg.uid}`}
                    msg={msg}
                    onClick={() => goTo("mail", { mail: msg })}
                  />
                ))}
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 rounded-2xl bg-white px-4 py-2.5 text-sm text-neutral-400 shadow-sm ring-1 ring-neutral-200 dark:bg-neutral-800 dark:ring-neutral-700">
              <Sparkles size={14} className="animate-pulse text-blue-400" />{" "}
              {/* While a delete confirmation is on screen, the per-tool status
                  ("Deleting a note…") would be a lie — nothing is being deleted
                  yet. The accurate state is "waiting for you to confirm". */}
              {pendingConfirm ? t("status.confirmDelete") : status}
            </div>
            <Button variant="ghost" onClick={onStop}>{t("common.cancel")}</Button>
          </div>
        )}

        {/* A pending delete confirmation. Rendered only while a delete tool is
            awaiting the user's decision, and dismissed the moment they resolve
            it — so it is not part of any persisted message. Pinned to the foot
            of the transcript (after the status row) so it is the live prompt. */}
        {pendingConfirm && onResolveConfirm && (
          <ConfirmDeleteCard req={pendingConfirm} onResolve={onResolveConfirm} />
        )}

        {error && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
