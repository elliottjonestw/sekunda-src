import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";

/**
 * Contains one widget's crash.
 *
 * Without this, every card renders in one tree and a throw anywhere blanks the
 * whole Today page — which is exactly what happened when the weather card read
 * `.length` off a field a stale cache entry didn't have. A widget is allowed to
 * fail; it is not allowed to take the calendar and reminder cards down with it.
 *
 * This catches *render* bugs. A failed network call isn't one — widgets surface
 * those through `useAsync`'s `error` inside their own card, which keeps the
 * header and layout intact.
 */
class Boundary extends Component<
  { label: string; message: string; resetKey: unknown; children: ReactNode },
  { failed: boolean; resetKey: unknown }
> {
  state = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  // Reset a crash when something the caller considers a "fresh start" changes
  // (the day being viewed, the data revision). Without this a card that threw
  // while rendering for day N stays crashed for day M: `key` at the call site
  // is the stable widget id, so the boundary doesn't remount on day changes.
  static getDerivedStateFromProps(props: { resetKey: unknown }, state: { failed: boolean; resetKey: unknown }) {
    if (state.failed && props.resetKey !== state.resetKey) {
      return { failed: false, resetKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The card is gone from the page either way; without this the cause is gone
    // from the console too.
    console.error(`Today widget "${this.props.label}" failed to render`, error, info);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-800">
        <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          <AlertTriangle size={14} className="text-amber-500" />
          {this.props.label}
        </div>
        <p className="py-2 text-sm text-neutral-400">{this.props.message}</p>
      </div>
    );
  }
}

/** Translated wrapper — the boundary itself is a class and can't use hooks. */
export function CardBoundary({
  label, resetKey, children,
}: { label: string; resetKey: unknown; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    // Remounting on label change is fine and useful: switching language or
    // widget gives a failed card a fresh attempt.
    <Boundary label={label} message={t("today.cardCrashed")} resetKey={resetKey}>{children}</Boundary>
  );
}
