import { z } from "zod";

/**
 * The wire shape of domain rows, and the schemas that validate writes.
 *
 * The row types intentionally mirror the SQLite rows byte for byte — integer
 * 0/1 for booleans, `null` for absent — so the client's row types are these
 * types re-exported, and every downstream component (`ItemCard`, the Today
 * widgets, `ai.ts`) keeps working without a translation layer. The server
 * returns rows in exactly this shape; `db.ts` passes them straight through.
 */

// ---------------------------------------------------------------------------
// Rows (server → client)
// ---------------------------------------------------------------------------

export interface ReminderRow {
  id: string;
  title: string;
  notes: string | null;
  due_at: string | null;
  remind_at: string | null;
  rrule: string | null;
  priority: number;
  completed: number;
  completed_at: string | null;
  sequence: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface NoteRow {
  id: string;
  title: string | null;
  body: string | null;
  pinned: number;
  /** 'note' | 'diary'. A diary entry is a note keyed by a calendar day. */
  kind: string;
  /** A diary entry's day, a floating wall date ('YYYY-MM-DD'); null for notes. */
  entry_date: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface EventRow {
  id: string;
  summary: string;
  description: string | null;
  location: string | null;
  dtstart: string;              // ISO 8601
  dtend: string | null;
  all_day: number;              // 0 | 1
  rrule: string | null;         // RFC 5545
  exdates: string | null;       // JSON array of ISO dates
  status: string;               // CONFIRMED | TENTATIVE | CANCELLED
  categories: string | null;    // JSON array
  color: string | null;
  sequence: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface PersonRow {
  id: string;
  full_name: string;
  given_name: string | null;
  family_name: string | null;
  additional_names: string | null;
  honorific_prefix: string | null;
  honorific_suffix: string | null;
  nickname: string | null;
  emails: string | null;         // JSON [{type,value,primary?}]
  phones: string | null;         // JSON [{type,value,primary?}]
  addresses: string | null;      // JSON [{type,street,...}]
  organization: string | null;
  title: string | null;
  birthday: string | null;       // ISO date
  urls: string | null;           // JSON [{type,value}]
  notes: string | null;
  photo: string | null;          // data URI / URL
  custom_fields: string | null;  // JSON [{label,value}]
  favorite: number;
  sequence: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface CustomFieldDef {
  id: string;
  label: string;
  position: number;
}

/** The item kinds that can be tagged and linked. A note's ROW may still be
 *  local (until M4), but its tags and links live in D1 like everything else —
 *  item_tags/links only store (type, id) strings. */
export const ITEM_TYPES = ["event", "reminder", "note", "person"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export interface TagRow {
  id: string;
  name: string;
}

export interface LinkRow {
  id: string;
  source_type: ItemType;
  source_id: string;
  target_type: ItemType;
  target_id: string;
  created_at: string | null;
}

// ---------------------------------------------------------------------------
// Shared field validators
// ---------------------------------------------------------------------------

/** A client-generated UUID. Ids are minted on the client so a write retried
 *  over a flaky network is idempotent on its id rather than creating a
 *  duplicate — the one decision that makes mobile retries safe. */
const idSchema = z.string().uuid();
const isoOrNull = z.string().datetime({ offset: true }).nullable();
/** SQLite booleans are 0/1; kept as such on the wire so rows round-trip. */
const boolInt = z.union([z.literal(0), z.literal(1)]);
const priority = z.number().int().min(0).max(3);
/** A bounded JSON-or-plain text column (exdates, categories, person emails …).
 *  Validated only as text — its internal shape is the client's concern. */
const jsonText = z.string().max(100_000).nullable();

// ---------------------------------------------------------------------------
// Reminders — an absent key means "leave alone", an explicit `null` means
// "clear". `undefined` cannot survive `JSON.stringify`, so the two are
// distinguished by key PRESENCE, never by value nullishness — the Worker
// inspects which keys arrived.
// ---------------------------------------------------------------------------

const reminderFields = {
  title: z.string().trim().min(1).max(1000),
  notes: z.string().max(100_000).nullable(),
  due_at: isoOrNull,
  remind_at: isoOrNull,
  rrule: z.string().max(1000).nullable(),
  priority,
  completed: boolInt,
  completed_at: isoOrNull,
};

export const reminderCreateSchema = z.object({ id: idSchema, ...reminderFields });

export const reminderUpdateSchema = z.object({
  title: reminderFields.title.optional(),
  notes: reminderFields.notes.optional(),
  due_at: reminderFields.due_at.optional(),
  remind_at: reminderFields.remind_at.optional(),
  rrule: reminderFields.rrule.optional(),
  priority: reminderFields.priority.optional(),
  completed: reminderFields.completed.optional(),
  completed_at: reminderFields.completed_at.optional(),
});

export const reminderQuerySchema = z.object({
  q: z.string().max(200).optional(),
  completed: z.enum(["0", "1"]).optional(),
});

export type ReminderCreate = z.infer<typeof reminderCreateSchema>;
export type ReminderUpdate = z.infer<typeof reminderUpdateSchema>;
export type ReminderQuery = z.infer<typeof reminderQuerySchema>;

// ---------------------------------------------------------------------------
// Events (iCalendar VEVENT shape). This is the LOCAL ("Sekunda") calendar
// only — CalDAV calendars are never stored here, so they need no schema.
// dtstart carries the start; all_day/rrule/exdates carry the recurrence.
//
// Timed events store an absolute instant; ALL-DAY events store a FLOATING
// wall-clock datetime (no `Z`, no offset) so the calendar date is
// timezone-independent — see lib/format.ts allDayIso. `{ local: true }` is what
// admits that zoneless form; `isoOrNull` (reminders) stays strict because
// those are always instants.
// ---------------------------------------------------------------------------

const eventDateTime = z.string().datetime({ offset: true, local: true });

const eventFields = {
  summary: z.string().max(2000),
  description: z.string().max(100_000).nullable(),
  location: z.string().max(2000).nullable(),
  dtstart: eventDateTime,
  dtend: eventDateTime.nullable(),
  all_day: boolInt,
  rrule: z.string().max(2000).nullable(),
  exdates: jsonText,
  status: z.string().max(40),
  categories: jsonText,
  color: z.string().max(32).nullable(),
};

export const eventCreateSchema = z.object({ id: idSchema, ...eventFields });

export const eventUpdateSchema = z.object({
  summary: eventFields.summary.optional(),
  description: eventFields.description.optional(),
  location: eventFields.location.optional(),
  dtstart: eventFields.dtstart.optional(),
  dtend: eventFields.dtend.optional(),
  all_day: eventFields.all_day.optional(),
  rrule: eventFields.rrule.optional(),
  exdates: eventFields.exdates.optional(),
  status: eventFields.status.optional(),
  categories: eventFields.categories.optional(),
  color: eventFields.color.optional(),
});

export const eventQuerySchema = z.object({ q: z.string().max(200).optional() });

export type EventCreate = z.infer<typeof eventCreateSchema>;
export type EventUpdate = z.infer<typeof eventUpdateSchema>;
export type EventQuery = z.infer<typeof eventQuerySchema>;

// ---------------------------------------------------------------------------
// Notes (markdown). title/body nullable; images are `sbimg:<id>` refs in the
// body, stored separately (see the note-image schemas below).
// ---------------------------------------------------------------------------

// A diary entry's day: a floating wall date, no time and no zone, so it stays
// the same calendar day in every timezone (same reasoning as all-day events).
const noteKind = z.enum(["note", "diary"]);
const entryDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD").nullable();

const noteFields = {
  title: z.string().max(2000).nullable(),
  body: z.string().max(1_000_000).nullable(),
  pinned: boolInt,
  // Optional on the wire, defaulted server-side: an existing client that knows
  // nothing of diary keeps creating plain notes with no change.
  kind: noteKind.default("note"),
  entry_date: entryDate.default(null),
};

export const noteCreateSchema = z.object({ id: idSchema, ...noteFields });

export const noteUpdateSchema = z.object({
  title: noteFields.title.optional(),
  body: noteFields.body.optional(),
  pinned: noteFields.pinned.optional(),
  entry_date: entryDate.optional(),
});

// `kind` filters list/search to notes or diary; absent means both (global search).
export const noteQuerySchema = z.object({
  q: z.string().max(200).optional(),
  kind: noteKind.optional(),
});

export type NoteCreate = z.infer<typeof noteCreateSchema>;
export type NoteUpdate = z.infer<typeof noteUpdateSchema>;
export type NoteQuery = z.infer<typeof noteQuerySchema>;

// ---------------------------------------------------------------------------
// Note images. Bytes live in Workers KV (D1 caps a row at 2 MB); D1 holds only
// metadata. Uploaded as base64 in JSON — images are downscaled small first, and
// base64 round-trips fine through the bridge.
// ---------------------------------------------------------------------------

export interface NoteImageMeta {
  id: string;
  note_id: string;
  mime: string;
  width: number;
  height: number;
  byte_size: number;
  created_at: string;
}

export const noteImageCreateSchema = z.object({
  id: idSchema,
  mime: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  /** base64, no data: prefix. ~2.7 MB base64 ≈ 2 MB bytes — an order of
   *  magnitude under KV's 25 MB value cap, and well above what a downscaled
   *  note image produces. */
  data: z.string().min(1).max(4_000_000),
  width: z.number().int().min(1).max(20000),
  height: z.number().int().min(1).max(20000),
});

export type NoteImageCreate = z.infer<typeof noteImageCreateSchema>;

// ---------------------------------------------------------------------------
// People (vCard-shaped). Multi-value fields are JSON strings, validated only as
// bounded text here — their internal shape is the client's concern.
// ---------------------------------------------------------------------------

/**
 * A person's photo is a data URI. Bounded well under D1's 2 MB row cap so a
 * whole person row can't blow the limit — PhotoPicker downscales before this,
 * and full-size images belong in blob storage (a later concern), not a row
 * column.
 */
const photoText = z.string().max(1_400_000).nullable();

const personFields = {
  // Empty is allowed on purpose: the People UI creates a blank contact and then
  // lets the user fill it in, so the first write has no name yet. The row is
  // still NOT NULL — "" satisfies it, as it did locally.
  full_name: z.string().trim().max(500),
  given_name: z.string().max(500).nullable(),
  family_name: z.string().max(500).nullable(),
  additional_names: z.string().max(500).nullable(),
  honorific_prefix: z.string().max(100).nullable(),
  honorific_suffix: z.string().max(100).nullable(),
  nickname: z.string().max(500).nullable(),
  emails: jsonText,
  phones: jsonText,
  addresses: jsonText,
  organization: z.string().max(500).nullable(),
  title: z.string().max(500).nullable(),
  birthday: z.string().max(40).nullable(),
  urls: jsonText,
  notes: z.string().max(100_000).nullable(),
  photo: photoText,
  custom_fields: jsonText,
  favorite: boolInt,
};

export const personCreateSchema = z.object({ id: idSchema, ...personFields });

export const personUpdateSchema = z.object(
  Object.fromEntries(
    Object.entries(personFields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()]),
  ),
) as z.ZodObject<{ [K in keyof typeof personFields]: z.ZodOptional<(typeof personFields)[K]> }>;

export const personQuerySchema = z.object({ q: z.string().max(200).optional() });

export type PersonCreate = z.infer<typeof personCreateSchema>;
export type PersonUpdate = z.infer<typeof personUpdateSchema>;
export type PersonQuery = z.infer<typeof personQuerySchema>;

// ---------------------------------------------------------------------------
// Global custom-field labels (shared across all people in a space)
// ---------------------------------------------------------------------------

/** Ensure-a-label: idempotent by label (case-insensitive), so no client id. */
export const customFieldCreateSchema = z.object({
  label: z.string().trim().min(1).max(200),
});

export const customFieldReorderSchema = z.object({
  ids: z.array(idSchema).max(500),
});

export type CustomFieldCreate = z.infer<typeof customFieldCreateSchema>;

// ---------------------------------------------------------------------------
// Tags + links (cross-cutting; keyed by item_type + item_id)
// ---------------------------------------------------------------------------

export const itemTypeSchema = z.enum(ITEM_TYPES);

/** Attach a tag to an item by name — ensure-then-link, idempotent. */
export const tagAttachSchema = z.object({
  name: z.string().trim().min(1).max(200),
});

export const linkCreateSchema = z.object({
  source_type: itemTypeSchema,
  source_id: idSchema,
  target_type: itemTypeSchema,
  target_id: idSchema,
});

export type LinkCreate = z.infer<typeof linkCreateSchema>;

// ---------------------------------------------------------------------------
// Cloud-synced settings (Settings → Widgets)
//
// Most settings stay in localStorage, per device and per account. These few
// follow the account instead, because they are answers the user shouldn't have
// to give again on a new machine: where they are, what they hold, what they
// read.
//
// CLOUD_SETTING_KEYS IS A SECURITY BOUNDARY, not a convenience list. Both sides
// import it — the client will only upload a key on it, and the route rejects
// any key off it — so the OpenAI API key, the iCloud app-specific password and
// anything else secret CANNOT reach the server through this endpoint even from
// a client that tries. Before adding a key, ask whether the value is a secret;
// if it is, the answer is no. See worker/migrations/0006_space_settings.sql.
// ---------------------------------------------------------------------------

export const CLOUD_SETTING_KEYS = [
  "weatherLocation",
  "temperatureUnit",
  "watchlist",
  "rssFeeds",
  "rssItemCount",
] as const;

export type CloudSettingKey = (typeof CLOUD_SETTING_KEYS)[number];

const cloudSettingKeySchema = z.enum(CLOUD_SETTING_KEYS);

/**
 * A partial write: only the keys present are touched, and a key set to null is
 * deleted. Values are opaque JSON — their shapes belong to the client, and the
 * Worker only stores and returns them.
 *
 * `z.unknown()` is deliberate. Validating `watchlist` here would mean the
 * server has to be redeployed before a client can add a field to a widget's
 * settings, for no gain: nothing server-side reads these, and a value that
 * fails the client's own shape check is dropped on read the same way a stale
 * localStorage blob is.
 */
export const cloudSettingsPatchSchema = z.record(cloudSettingKeySchema, z.unknown());

export type CloudSettingsPatch = z.infer<typeof cloudSettingsPatchSchema>;
