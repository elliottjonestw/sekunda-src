// The first-load gate every data view renders behind.
//
// Views used to mount with `useState([])` and fill in when the API answered,
// so arriving on a page showed an empty list — indistinguishable from "you have
// no reminders" — for as long as the round-trip took. This shows a loading state
// instead, with two rules that keep a user from ever being stranded on it:
//
//  - **A load that fails is a page, not a spinner.** Errors resolve to a retry
//    panel, so a dead network or a 500 ends the wait with something to do.
//  - **A load that never settles gives up blocking.** After SLOW_AFTER_MS the
//    page renders anyway (with a banner while the request is still out), which
//    is exactly the old behaviour — the worst case is what we used to ship,
//    never a spinner that spins forever.
//
// Only the *first* load blocks. A reload after a mutation, or after a filter
// change, keeps the current content on screen — blanking a list on every
// checkbox tick is the flicker this is meant to remove, not cause.

import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Loader2, CloudOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { OfflineError, ApiError } from "../lib/api";
import { Button } from "./ui";

/** How long the first load may block the page before it's shown regardless. */
const SLOW_AFTER_MS = 8000;
/** How long before the spinner itself appears — a fast load shouldn't flash. */
const SPINNER_AFTER_MS = 150;

export type LoadStatus =
  /** First load in flight; the page is blocked. */
  | "loading"
  /** First load overran; the page is shown with a still-loading banner. */
  | "slow"
  | "ready"
  | "failed";

export interface FirstLoad {
  status: LoadStatus;
  error: unknown;
  /** Re-run the load and block the page again. */
  retry: () => void;
}

/**
 * Run a view's load, tracking whether its *first* attempt has landed.
 *
 * Replaces the view's own `useEffect(() => { void reload(); }, deps)` — the
 * load function still owns all the setState, this only watches it settle.
 */
export function useFirstLoad(load: () => Promise<unknown>, deps: unknown[] = []): FirstLoad {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  // Whether the page has been unblocked already, by any route: success,
  // failure, or the slow-load escape hatch.
  const opened = useRef(false);

  useEffect(() => {
    let live = true;
    const first = !opened.current;
    if (first) { setStatus("loading"); setError(null); }

    // The escape hatch. A request that hangs — a proxy swallowing it, a
    // Worker cold-starting badly — must not own the page forever.
    const slow = first
      ? setTimeout(() => {
          if (!live) return;
          opened.current = true;
          setStatus("slow");
        }, SLOW_AFTER_MS)
      : undefined;

    load()
      .then(() => {
        if (!live) return;
        // Cancel the escape hatch: the load settled, so the "still pending after
        // 8s" timer must not fire and flip a ready page into the slow-banner
        // state. Cleanup only clears it on unmount/re-run, so a load that
        // resolves while the view stays mounted needs this here — without it the
        // banner appears 8s after a perfectly successful load and stays until
        // you navigate away.
        clearTimeout(slow);
        opened.current = true;
        setStatus("ready");
      })
      .catch((e) => {
        if (!live) return;
        clearTimeout(slow);
        // A failed *reload* must not blank a page that already has content —
        // views surface those through their own banner.
        if (!first) return;
        opened.current = true;
        setError(e);
        setStatus("failed");
      });

    return () => { live = false; clearTimeout(slow); };
    // `load` is a fresh closure every render; the caller lists what it depends
    // on, exactly as useAsync does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, attempt]);

  const retry = useCallback(() => {
    opened.current = false;
    setAttempt((a) => a + 1);
  }, []);

  return { status, error, retry };
}

/** Turn a load failure into a sentence, given the two localized fallbacks. */
function explain(e: unknown, offline: string, generic: string): string {
  if (e instanceof OfflineError) return offline;
  if (e instanceof ApiError) return e.message;
  return e instanceof Error && e.message ? e.message : generic;
}

/**
 * What to render *instead of* the page, or null when the page should render.
 *
 * Used as an early return, so a view keeps one top-level JSX tree:
 * `const blocked = firstLoadScreen(gate); if (blocked) return blocked;`
 */
export function firstLoadScreen(state: FirstLoad): ReactNode | null {
  if (state.status === "loading") return <ViewLoading />;
  if (state.status === "failed") return <ViewError error={state.error} onRetry={state.retry} />;
  return null;
}

/** The blocking state. Held back briefly so a cached load shows nothing. */
export function ViewLoading() {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShow(true), SPINNER_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!show) return <div className="h-full" />;
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 text-neutral-400"
      role="status"
      aria-live="polite"
    >
      <Loader2 size={26} className="animate-spin" />
      <p className="text-sm">{t("common.loading")}</p>
    </div>
  );
}

/** The dead end, with the one thing that can get out of it. */
export function ViewError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <CloudOff size={28} className="text-neutral-400" />
      <div>
        <p className="font-medium">{t("common.loadFailed")}</p>
        <p className="mt-1 max-w-sm text-sm text-neutral-500">
          {explain(error, t("common.loadOffline"), t("common.loadFailedDetail"))}
        </p>
      </div>
      <Button variant="primary" onClick={onRetry}>{t("common.retry")}</Button>
    </div>
  );
}

/** Shown over a page that was unblocked before its data arrived. Floats, so it
 *  can be dropped anywhere inside a view without disturbing its layout. */
export function SlowLoad({ state }: { state: FirstLoad }) {
  const { t } = useTranslation();
  if (state.status !== "slow") return null;
  return (
    <div className="pointer-events-none fixed left-1/2 top-3 z-40 -translate-x-1/2">
      <div className="flex items-center gap-2 rounded-full bg-neutral-800/90 px-3 py-1.5 text-xs font-medium text-white shadow-lg dark:bg-neutral-700/90">
        <Loader2 size={13} className="animate-spin" />
        {t("common.stillLoading")}
      </div>
    </div>
  );
}
