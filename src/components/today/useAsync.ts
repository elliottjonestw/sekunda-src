import { useEffect, useRef, useState } from "react";
import { useTodayBarrier } from "./loadBarrier";

export interface AsyncState<T> {
  /** The last successful value. Kept across reloads — see below. */
  data: T | undefined;
  /** A load is in flight. `data` may still hold the previous result. */
  loading: boolean;
  error: unknown;
}

/**
 * Load something async, for a widget that owns its own data.
 *
 * Two deliberate behaviours:
 *
 * - **The previous value survives a reload.** Ticking a reminder bumps `revision`,
 *   which re-runs every dependent load; blanking `data` first would flash the
 *   card to a skeleton on every checkbox click. This is also why the page
 *   doesn't use Suspense, which has no way to keep showing stale content
 *   without `startTransition` discipline in every widget.
 * - **Late results are dropped, not applied.** Stepping days fires a new load
 *   before the old one settles; without the guard the slower response would
 *   overwrite the newer day's data.
 *
 * Errors are returned, never thrown — a widget renders its own failure state
 * inside its card. Throwing would hit the boundary and replace the whole card,
 * which is the right response to a *bug*, not to a network blip.
 *
 * The *opening* load is also reported to the Today page's `LoadBarrier`, so the
 * page can block until every widget's first fetch lands rather than drawing its
 * frame around a grid of skeletons. Only the first load counts — a reload from a
 * mutation or a day step keeps the page on screen. Outside Today the barrier is
 * null and this is inert.
 */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({
    data: undefined,
    loading: true,
    error: null,
  });
  const barrier = useTodayBarrier();
  // True only for the very first effect run, so a day step or revision bump
  // re-runs the load without re-registering with the barrier. Survives Strict
  // Mode's double-invoke because a ref persists across it.
  const first = useRef(true);

  useEffect(() => {
    let live = true;
    // Register the opening load exactly once; `end` is idempotent, so the
    // settle below can call it freely.
    const end = first.current && barrier ? barrier.begin() : null;
    first.current = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    load()
      .then((data) => { if (live) setState({ data, loading: false, error: null }); })
      .catch((error) => { if (live) setState((s) => ({ ...s, loading: false, error })); })
      // Success or failure, the page has waited long enough on this widget.
      .finally(() => { end?.(); });
    return () => { live = false; };
    // The caller lists what the load depends on; `load` itself is a fresh
    // closure every render and would re-run forever if included.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}
