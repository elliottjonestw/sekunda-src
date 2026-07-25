// Domain types mirroring the SQLite schema (src-tauri/migrations/001_init.sql).
// Booleans are stored as 0/1 integers in SQLite; we expose them as numbers
// at the DB boundary and convert where convenient.

// ItemType lives in @secondbrain/shared (the Worker validates path segments
// against it). Re-exported here since the whole app imports it from "./types".
export type { ItemType } from "@secondbrain/shared";
import type { ItemType } from "@secondbrain/shared";
import type { MailMessageSummary } from "./lib/mail";

/**
 * The kinds an assistant card (and its search-result cousin) can represent.
 *
 * A superset of `ItemType`: a diary entry gets its own card, but it is NOT a
 * tag/link `ItemType` — diary rows tag and link as `note` (see ITEM_TYPES in
 * @secondbrain/shared, the boundary the Worker validates path segments against).
 * So "diary" lives only at the card layer, never in that allowlist.
 */
export type CardType = ItemType | "diary";

/**
 * A pointer to one item, used to render it as a card in the assistant chat.
 *
 * Deliberately *only* identity — never the item's fields. The card loads the
 * current row itself so what it shows is the real data, not whatever the model
 * happened to write. For events, `calendarId` says which calendar the id lives
 * in (remote events have no SQLite row) and `occurrenceStart` picks one
 * instance of a recurring series, whose id is shared by every occurrence. For a
 * diary entry, `diaryDate` is its day — the Diary view opens by date, not id.
 */
export interface ItemRef {
  type: CardType;
  id: string;
  calendarId?: string;
  occurrenceStart?: string; // ISO
  diaryDate?: string; // 'YYYY-MM-DD', diary only
}

/**
 * A specific item to open when navigating into a view — e.g. clicking a note on
 * the Today dashboard, or an assistant card, opens that item rather than the
 * bare list. Each view consumes its own key on mount.
 */
export interface NavTarget {
  noteId?: string;
  /** A diary day ('YYYY-MM-DD') to open in the Diary view — from a global-search
   *  hit or a diary item card. The view seeds its cursor month from it. */
  diaryDate?: string;
  eventId?: string;
  /**
   * ISO start of the occurrence to open. The calendar resolves a target out of
   * the events it has loaded for the *visible* window, so without this a hit
   * from global search — which can be months away — opens nothing at all. It
   * also picks the right instance of a recurring series.
   */
  eventStart?: string;
  todoId?: string;
  reminderId?: string;
  personId?: string;
  /**
   * A message to open in Mail. Unlike every other target this carries the
   * summary itself, not an id: mail has no row and no `ItemRef`, so there is
   * nothing to reload it from — the summary a search already fetched is the
   * freshest thing there is, and it lets the reader open without a refetch.
   * `uid` and `mailbox` live inside it.
   */
  mail?: MailMessageSummary;
}

export type GoTo = (view: string, target?: NavTarget) => void;

// EventRow is defined in @secondbrain/shared (like the other row types).
export type { EventRow } from "@secondbrain/shared";

// ReminderRow is defined in @secondbrain/shared (see TodoRow/ListRow above).
export type { ReminderRow } from "@secondbrain/shared";

// TodoRow and ListRow are defined in @secondbrain/shared so the Worker returns
// exactly the shape the client consumes. Re-exported here because the whole app
// imports its domain types from "./types".
export type { TodoRow, ListRow } from "@secondbrain/shared";

// NoteRow is defined in @secondbrain/shared (the Worker returns it).
export type { NoteRow } from "@secondbrain/shared";

// An image embedded in a note. The markdown in `NoteRow.body` carries only
// `![alt](sbimg:<id>)`; the bytes live in their own table so the note list and
// the FTS index never touch them. See 006_note_images.sql.
export interface NoteImageRow {
  id: string;
  note_id: string;
  mime: string;
  data: string; // base64, no `data:` prefix
  width: number;
  height: number;
  created_at: string;
}

// People (contacts), modeled on vCard 4.0 (RFC 6350). See 003_people.sql.
// Multi-value fields are stored as JSON arrays on the row (parsed at the UI
// boundary), the same pattern events use for exdates/categories.
export interface PersonEmail { type: string; value: string; primary?: boolean }
export interface PersonPhone { type: string; value: string; primary?: boolean }
export interface PersonAddress {
  type: string;
  street?: string;
  city?: string;
  region?: string;
  postal_code?: string;
  country?: string;
}
export interface PersonUrl { type: string; value: string }
/** User-defined data point, e.g. { label: "Eye Color", value: "Blue" }. */
export interface PersonCustomField { label: string; value: string }

// PersonRow (and CustomFieldDef) are defined in @secondbrain/shared so the
// Worker returns exactly the client's shape. The JSON sub-shapes above
// (PersonEmail/Phone/… and PersonCustomField) stay client-only — they describe
// how the client parses the JSON columns, which the server treats as opaque text.
export type { PersonRow, CustomFieldDef } from "@secondbrain/shared";

// TagRow and LinkRow are defined in @secondbrain/shared (the Worker returns
// them). Re-exported here like the other row types.
export type { TagRow, LinkRow } from "@secondbrain/shared";

// Priority levels shared by reminders & todos (iCal-ish: 0 none, 1 low..9 high;
// we keep it simple with 0/1/2/3).
export const PRIORITY = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 } as const;

// ---------------------------------------------------------------------------
// Calendars
//
// Events come from two places: the built-in SQLite calendar (`local`) and any
// CalDAV calendars the user has connected (`caldav`, e.g. iCloud). Remote
// events are fetched live and never stored in SQLite, so `UnifiedEvent` — not
// `EventRow` — is the shape the calendar UI, the aggregator, and the assistant
// work with. `href`/`etag` are the CalDAV resource identity needed to write.
// ---------------------------------------------------------------------------
export type EventSource = "local" | "caldav";

/** The id of the built-in SQLite calendar. */
export const LOCAL_CALENDAR_ID = "local";

export interface UnifiedEvent {
  source: EventSource;
  calendarId: string; // LOCAL_CALENDAR_ID, or a CalDavCalendar.id
  id: string; // local UUID, or the remote event's iCal UID
  href?: string; // CalDAV resource URL — required for PUT/DELETE
  etag?: string; // CalDAV ETag — sent as If-Match on write
  color: string | null; // event colour (local) or calendar colour (remote)
  // RFC 5545 core, same shape/units as the matching EventRow fields.
  summary: string;
  description: string | null;
  location: string | null;
  dtstart: string; // ISO 8601, absolute instant (TZID already resolved)
  dtend: string | null;
  // The zone `dtstart` was authored in, when we know it (remote events only).
  // Purely a write-back hint so a recurring series keeps its wall-clock time —
  // `dtstart` stays an absolute instant and nothing should read this to render.
  tzid?: string | null;
  all_day: number; // 0 | 1
  rrule: string | null;
  exdates: string | null; // JSON array of ISO dates
  status: string;
  categories: string | null; // JSON array
}

// A single concrete occurrence of an event after recurrence expansion.
export interface EventOccurrence {
  event: UnifiedEvent;
  start: Date;
  end: Date | null;
  isRecurringInstance: boolean;
}
