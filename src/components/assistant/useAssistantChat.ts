// The assistant's turn and voice lifecycle, shared by the two surfaces that run
// a conversation: the full Assistant page and the floating popup.
//
// This lives in a hook, not a component, because both surfaces must behave
// identically — the speech hold-back, the release-before-mic-opened race, the
// per-turn AbortController and the show_items de-duping are all load-bearing
// and a second copy would drift. The surfaces are views over this state; none
// of them should reimplement deliver().
//
// It is called ONCE, in App, and the resulting object is passed to whichever
// surface is on screen. Calling it per-surface meant navigating from the popup
// to the assistant page unmounted the running turn: the cleanup below aborted
// it and deliver() drops the cancelled user message, so "Open in Assistant"
// right after sending looked like the chat had reset. A single instance also
// makes the window-level hold-to-talk listener structurally unable to double
// up, rather than relying on the two surfaces never overlapping.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { askAssistant, ChatMessage, type ConfirmDeleteRequest } from "../../lib/ai";
import { hasOpenAiKey } from "../../lib/secrets";
import {
  startRecording, transcribe, speak, stopSpeaking, isSpeechSupported, isRecordingSupported, Recording,
} from "../../lib/voice";
import type { ItemRef } from "../../types";
import type { MailMessageSummary } from "../../lib/mail";

/** A chat message plus the items the assistant chose to show alongside it, and
 *  any emails it read in full (mail has no ItemRef — no row to reload — so the
 *  summary is carried directly, as NavTarget.mail does).
 *  ai.ts strips everything but role/content before calling the API, so the
 *  extra fields never reach the model. `uiId` is a client-only stable key so
 *  MessageList doesn't have to fall back to array-index keys (which reorder
 *  badly when an aborted user turn is sliced off the end mid-transcript). */
export type UiMessage = ChatMessage & { items?: ItemRef[]; mail?: MailMessageSummary[]; uiId: number };

/**
 * How long to wait for speech to begin before showing the reply anyway.
 * Generous: a slow synthesis round-trip should still get the timing right, and
 * this only exists so a pathological hang can't lose the text entirely.
 */
const SPEECH_START_TIMEOUT_MS = 10000;

// Monotonic counter for UiMessage.uiId, so each bubble has a stable identity
// independent of its position in the array.
let nextUiId = 1;

export interface UseAssistantChat {
  messages: UiMessage[];
  /** Owned by App so navigating to an item and back doesn't wipe the conversation. */
  setMessages: (m: UiMessage[]) => void;
  /**
   * Whether hold-Space-to-talk is live. The page passes true; the popup passes
   * its open state, so holding Space while it's collapsed to a button doesn't
   * start a recording nobody can see.
   */
  spaceEnabled?: boolean;
}

export function useAssistantChat({ messages, setMessages, spaceEnabled = true }: UseAssistantChat) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);   // assistant thinking / transcribing
  const [status, setStatus] = useState("");
  const [recording, setRecording] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Running OpenAI token total for the current conversation, across both typed
  // and spoken turns (the chat rounds always count; transcription only when the
  // STT model reports usage). Reset by clear(), so it tracks the visible chat.
  const [tokenCount, setTokenCount] = useState(0);
  const addUsage = (total: number) => setTokenCount((c) => c + total);
  const recRef = useRef<Recording | null>(null);
  const startingRef = useRef(false);     // startRecording() is in flight
  const stopPendingRef = useRef(false);  // released before recording began
  // AbortController for the in-flight assistant turn, so the user can stop a
  // runaway model instead of waiting on MAX_TOOL_ROUNDS.
  const abortRef = useRef<AbortController | null>(null);
  // Set while a finished reply is being held back waiting for speech to start.
  // Calling it prints the reply immediately; see deliver().
  const revealRef = useRef<(() => void) | null>(null);
  // Tears down whatever deliver() set up while waiting for speech to start,
  // WITHOUT showing the held-back reply. Used by clear(), where re-appending
  // the reply would immediately undo the clear. (stopVoice instead calls
  // revealRef, which DOES show the reply — Stop should never cost the text.)
  const discardRef = useRef<(() => void) | null>(null);

  // The pending delete-confirmation card. While set, the agentic loop is paused
  // inside a delete tool awaiting the user's decision. The Promise resolver is
  // held in a ref so resolveConfirm (a button click) and the abort paths (Stop,
  // unmount) can both settle the same pending Promise — the loop must never
  // hang on a confirm that nothing resolves.
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmDeleteRequest | null>(null);
  const confirmResolverRef = useRef<((approved: boolean) => void) | null>(null);
  function resolveConfirm(approved: boolean) {
    confirmResolverRef.current?.(approved);
    confirmResolverRef.current = null;
    setPendingConfirm(null);
  }

  const voiceOutput = isSpeechSupported();

  // Stop any speech and release the mic when the app tears down (this lives in
  // App, so it no longer fires on navigation). Without it, a reload mid-
  // recording leaves the MediaRecorder + getUserMedia stream alive and the mic
  // indicator stuck on. Note the abort: any surface that ever calls this hook
  // itself will cancel its own in-flight turn on unmount — that's the bug that
  // put the hook up in App.
  useEffect(() => () => {
    stopSpeaking();
    // discard the held-back reply (if any) without printing it — the surface is
    // going away, so showing the reply into state nothing will render is wasted
    // work, and on a popup that reopens later it would pop in unexpectedly.
    discardRef.current?.();
    // Settle a pending delete-confirmation before aborting: confirmBeforeDelete
    // throws AbortError on an already-aborted signal, but resolving here too
    // guarantees the Promise never outlives the component regardless of timing.
    confirmResolverRef.current?.(false);
    confirmResolverRef.current = null;
    setPendingConfirm(null);
    abortRef.current?.abort();
    recRef.current?.cancel();
    recRef.current = null;
  }, []);

  // Hold-to-talk: press and hold Space to record, release to send. Refs keep
  // the listener stable while always calling the latest closures (so stopMic
  // sees the current `messages`), which registering once with fresh functions
  // via deps would not guarantee.
  const startMicRef = useRef<() => void>(() => {});
  const stopMicRef = useRef<() => void>(() => {});
  startMicRef.current = () => void startMic();
  stopMicRef.current = () => void stopMic();
  const spaceHeld = useRef(false);
  // Mirrors spaceHeld for rendering: the hint has to name the right way to
  // stop, and a ref alone wouldn't re-render it.
  const [heldBySpace, setHeldBySpace] = useState(false);
  useEffect(() => {
    if (!spaceEnabled) return;
    // Don't hijack Space from text fields, buttons, or links — it must still
    // type a space or activate the focused control there.
    const isInteractive = (el: EventTarget | null) => {
      const n = el as HTMLElement | null;
      return !!n && (/^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(n.tagName) || n.isContentEditable);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || spaceHeld.current) return;
      if (isInteractive(e.target) || isInteractive(document.activeElement)) return;
      if (!isRecordingSupported()) return;
      e.preventDefault(); // Space would otherwise scroll the chat.
      spaceHeld.current = true;
      setHeldBySpace(true);
      startMicRef.current();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !spaceHeld.current) return;
      e.preventDefault();
      spaceHeld.current = false;
      setHeldBySpace(false);
      stopMicRef.current();
    };
    // Blur (e.g. app loses focus mid-hold) must release, or we'd never get keyup.
    const onBlur = () => { if (spaceHeld.current) { spaceHeld.current = false; setHeldBySpace(false); stopMicRef.current(); } };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      // Closing the popup mid-hold must release the key, or the next open
      // starts with spaceHeld stuck true and the first press does nothing.
      if (spaceHeld.current) { spaceHeld.current = false; setHeldBySpace(false); stopMicRef.current(); }
    };
  }, [spaceEnabled]);

  const busy = loading || recording;

  /** Core turn: append the user text, run the assistant, optionally speak the reply. */
  async function deliver(text: string, spoken: boolean) {
    const q = text.trim();
    if (!q) return;
    setError(null);
    const next: UiMessage[] = [...messages, { role: "user", content: q, uiId: nextUiId++ }];
    setMessages(next);
    setInput("");
    setLoading(true);
    setStatus(t("status.thinking"));
    // A fresh controller per turn. Aborting it cancels the in-flight fetch and
    // any pending round before it starts.
    const controller = new AbortController();
    abortRef.current = controller;
    // show_items can fire more than once in a turn (and once more from the
    // card-recovery round), so collect, de-dupe, and attach the whole set to
    // the reply once it arrives. Same key the cards render with.
    const shown: ItemRef[] = [];
    const seen = new Set<string>();
    // Emails the assistant read in full this turn, de-duped by mailbox|uid (the
    // only key that identifies a message), shown as cards beneath the reply.
    const shownMail: MailMessageSummary[] = [];
    const seenMail = new Set<string>();
    try {
      const reply = await askAssistant(next, {
        onStatus: setStatus,
        signal: controller.signal,
        onUsage: addUsage,
        onItems: (items) => {
          for (const it of items) {
            const key = `${it.type}:${it.id}:${it.occurrenceStart ?? ""}`;
            if (seen.has(key)) continue;
            seen.add(key);
            shown.push(it);
          }
        },
        onMail: (msg) => {
          const key = `${msg.mailbox}|${msg.uid}`;
          if (seenMail.has(key)) return;
          seenMail.add(key);
          shownMail.push(msg);
        },
        // The delete gate. Returns a Promise that hangs until the user clicks
        // Delete/Cancel on the confirmation card — which is exactly the pause
        // the agentic loop needs. Abort safety: stopAssistant() and the unmount
        // cleanup both abort the controller, and confirmBeforeDelete in ai.ts
        // throws AbortError when the signal is already aborted, so this Promise
        // is settled one way or another on every path.
        onConfirmDelete: (req) =>
          new Promise<boolean>((resolve) => {
            // A previous confirm somehow left its resolver dangling — settle it
            // first so the new one is the only one pending.
            confirmResolverRef.current?.(false);
            confirmResolverRef.current = resolve;
            setPendingConfirm(req);
          }),
      });
      const showReply = () =>
        setMessages([...next, {
          role: "assistant", content: reply, items: shown.length ? shown : undefined,
          mail: shownMail.length ? shownMail : undefined,
          uiId: nextUiId++,
        }]);

      if (spoken && voiceOutput) {
        // Hold the text back until the voice actually starts. Natural voices
        // need a network round-trip to synthesise, so printing the reply on
        // arrival left it sitting on screen for a second or two of silence
        // before being read out — as if the app were reading it back to you.
        setSpeaking(true);
        setStatus(t("status.speaking"));
        await new Promise<void>((resolve) => {
          const release = () => {
            window.clearTimeout(timer);
            revealRef.current = null;
            discardRef.current = null;
            resolve();
          };
          // Backstop: never let a speech problem swallow the reply. voice.ts
          // guarantees onStart fires even when it can't speak, so this only
          // covers something pathological — but "reply never appears" is far
          // too high a price for a timing nicety.
          const timer = window.setTimeout(() => { showReply(); release(); }, SPEECH_START_TIMEOUT_MS);
          // Stopping mid-wait should show the text immediately, not strand it
          // until the backstop fires.
          revealRef.current = () => { showReply(); release(); };
          // Clearing the conversation should throw the held-back reply away,
          // not print it into the just-emptied transcript.
          discardRef.current = release;
          speak(reply, {
            onStart: () => { showReply(); release(); },
            onEnd: () => { setSpeaking(false); },
          });
        });
      } else {
        showReply();
      }
    } catch (e) {
      // A user cancel is not an error to surface — they asked for it.
      if ((e as Error)?.name === "AbortError" || controller.signal.aborted) {
        // Drop the cancelled user turn so it doesn't sit there with no reply.
        setMessages(next.slice(0, -1));
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      abortRef.current = null;
      setLoading(false);
      // Defensive: a confirm card should never outlive the turn it gated. If
      // one is still showing here (e.g. an error path bypassed the resolver),
      // dismiss it so it can't linger over the next turn.
      if (confirmResolverRef.current) {
        confirmResolverRef.current = null;
        setPendingConfirm(null);
      }
    }
  }

  /** Cancel an in-flight assistant turn (Stop button). No-op if nothing running. */
  function stopAssistant() {
    // If a delete confirmation is on screen, decline it as part of the stop —
    // the turn is being cancelled, so the pending delete must not run.
    confirmResolverRef.current?.(false);
    confirmResolverRef.current = null;
    setPendingConfirm(null);
    abortRef.current?.abort();
  }

  function submitTyped() {
    if (busy || !input.trim()) return;
    void deliver(input, false);
  }

  /** Begin recording. No-op if already recording, starting, or busy. */
  async function startMic() {
    if (recRef.current || startingRef.current || loading) return;
    setError(null);
    if (!isRecordingSupported()) { setError(t("assistant.micUnavailable")); return; }
    // Voice input transcribes via OpenAI, so it needs an OpenAI key.
    if (!hasOpenAiKey()) { setError(t("assistant.voiceNeedsKey")); return; }
    stopSpeaking();
    revealRef.current?.();
    setSpeaking(false);
    startingRef.current = true;
    stopPendingRef.current = false;
    try {
      const rec = await startRecording();
      // Push-to-talk released before the mic actually opened: there's no usable
      // audio, so discard it rather than leaving a recording no one can stop.
      if (stopPendingRef.current) {
        stopPendingRef.current = false;
        try { await rec.stop(); } catch { /* nothing to keep */ }
        return;
      }
      recRef.current = rec;
      setRecording(true);
    } catch (e) {
      setError(e instanceof Error ? t("assistant.micError", { message: e.message }) : t("assistant.micDenied"));
    } finally {
      startingRef.current = false;
    }
  }

  /** Stop recording → transcribe → send (spoken reply for voice turns). */
  async function stopMic() {
    // Released mid-startup: tell startMic to abort once the mic opens.
    if (startingRef.current && !recRef.current) { stopPendingRef.current = true; return; }
    const rec = recRef.current;
    if (!rec) return;
    recRef.current = null;
    setRecording(false);
    setLoading(true);
    setStatus(t("assistant.transcribing"));
    // The controller covers the transcription fetch; deliver() creates its own
    // for the chat phase. One ref so Stop works in both.
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const blob = await rec.stop();
      const text = await transcribe(blob, controller.signal, addUsage);
      abortRef.current = null;
      setLoading(false);
      if (!text) { setError(t("assistant.notHeard")); return; }
      await deliver(text, true);
    } catch (e) {
      abortRef.current = null;
      setLoading(false);
      // User cancelled the transcription: don't surface it as an error.
      if (!((e as Error)?.name === "AbortError" || controller.signal.aborted)) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }

  /** Mic button: click to start recording, click again to stop. */
  function toggleMic() {
    if (recRef.current) void stopMic();
    else void startMic();
  }

  function stopVoice() {
    stopSpeaking();
    // Stopping the voice must never cost the text: if the reply is still being
    // held for speech to begin, show it now.
    revealRef.current?.();
    setSpeaking(false);
  }

  /**
   * Throw away an in-progress recording without transcribing it, and silence
   * any reply being read aloud.
   *
   * For a surface that can be dismissed while still mounted (the popup, which
   * collapses to a button): the unmount cleanup doesn't run, so without this a
   * recording started before the close keeps the mic open with nothing on
   * screen to stop it. An in-flight *text* turn is deliberately left alone —
   * its answer is still worth having when the window is reopened.
   */
  function cancelInput() {
    stopSpeaking();
    revealRef.current?.();
    setSpeaking(false);
    stopPendingRef.current = true;   // covers a start still in flight
    recRef.current?.cancel();
    recRef.current = null;
    setRecording(false);
  }

  /** Clear the conversation and any error, silencing a reply mid-sentence. */
  function clear() {
    setMessages([]);
    setError(null);
    setTokenCount(0);
    stopSpeaking();
    // If a reply is being held for speech-to-start, throw it away rather than
    // letting the pending reveal/timer re-append it into the emptied transcript.
    discardRef.current?.();
    setSpeaking(false);
  }

  return {
    // Re-exported so a surface needs only the `chat` object: the transcript and
    // the lifecycle that produces it always come from the same instance.
    messages,
    input, setInput,
    loading, status, recording, speaking, heldBySpace, error, setError, busy,
    voiceOutput, tokenCount,
    // The pending delete-confirmation (null when none). MessageList renders this
    // as a card at the foot of the transcript; resolveConfirm dismisses it and
    // unblocks the delete tool that's awaiting it.
    pendingConfirm, resolveConfirm,
    deliver, submitTyped, stopAssistant, toggleMic, stopVoice, cancelInput, clear,
  };
}

/** What the surfaces receive. One instance, created in App. */
export type AssistantChat = ReturnType<typeof useAssistantChat>;
