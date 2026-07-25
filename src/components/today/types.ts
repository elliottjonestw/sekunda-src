// The Today page's widget contract.
//
// A widget is one file exporting one `TodayWidget`. It fetches its own data,
// renders its own card, and knows nothing about its neighbours — so adding one
// can't disturb the others, and a widget that throws is contained by the error
// boundary the page wraps around each of them.

import type { ComponentType } from "react";
import type { GoTo } from "../../types";

/** Everything a widget is given. Deliberately small — anything else it fetches. */
export interface TodayWidgetProps {
  /** The day on show, at local midnight. Not necessarily today. */
  day: Date;
  /** Whether `day` is today. "Overdue" only means anything when it is. */
  viewingToday: boolean;
  /**
   * Bumped after any mutation anywhere on the page. Widgets include it in their
   * fetch deps so ticking a reminder refreshes the cards that care, and it busts
   * the shared per-day cache so they don't re-read what was just changed.
   */
  revision: number;
  /** Call after mutating data, so the page (and other widgets) refresh. */
  onChange: () => void;
  /** Navigate into another view, optionally deep-linking to an item. */
  goTo: GoTo;
}

/**
 * Label keys for the layout editor. A closed union rather than a free string so
 * a widget can't name a key that doesn't exist — `t()` checks it at compile time.
 * Add the key to `today.*` in both catalogs, then add it here.
 */
export type WidgetLabelKey =
  | "today.summary"
  | "today.schedule"
  | "today.dueToday"
  | "today.weatherCard"
  | "today.stocksCard"
  | "today.pinnedNotes"
  | "today.recentNotes"
  | "today.birthdays"
  | "today.rssCard";

export interface TodayWidget {
  /**
   * Stable, persisted in the user's layout. NEVER rename one: the id is how a
   * saved arrangement finds its card, so renaming resets that widget's position
   * for everyone who has customised the page.
   */
  id: string;
  /** Name shown in the layout editor. */
  labelKey: WidgetLabelKey;
  Component: ComponentType<TodayWidgetProps>;
}
