// Data access layer. The public facade the whole UI calls; its function
// signatures are the app's contract.
//
// Every domain is served by the Cloudflare Worker (see lib/api.ts). The
// migration is complete: no SQLite engine, no tauri-plugin-sql, no local
// schema. The exported signatures are unchanged from when they read a local
// file, which is what let the views, calendars.ts and ai.ts migrate without
// being rewritten.

import { v4 as uuid } from "uuid";
import type {
  EventRow,
  ReminderRow,
  TodoRow,
  NoteRow,
  ListRow,
  TagRow,
  LinkRow,
  PersonRow,
  ItemType,
} from "./types";
import { DATA_TABLES } from "@secondbrain/shared";
import type { TodoCreate, TodoUpdate, ReminderCreate, CustomFieldDef, DataTable } from "@secondbrain/shared";
import { apiRequest, apiGetBinary, ApiError, OfflineError } from "./lib/api";
import { getCurrentSpaceId } from "./lib/authStore";
import { networkFirst } from "./lib/cache";

// Ranking helpers now live in @secondbrain/shared so the Worker runs the same
// code (one copy of the phrasing-bug fix CLAUDE.md documents). Re-exported here
// because ai.ts and SearchView import them from db. db.ts itself no longer
// searches locally, so it doesn't use them directly.
export { queryTerms, escapeLike, anyTermClause, matchQuery } from "@secondbrain/shared";

/** Build a space-scoped API path, or throw if no session is active. The throw
 *  is a programmer-error guard: the AuthGate guarantees a session before any
 *  view that calls these mounts. */
function spacePath(suffix: string): string {
  const spaceId = getCurrentSpaceId();
  if (!spaceId) throw new Error("No active space — not signed in.");
  return `/v1/spaces/${spaceId}${suffix}`;
}

// isTauri lives in lib/platform.ts (so the API client can use it without a
// cycle) and is re-exported here for the callers that import it from db.
export { isTauri } from "./lib/platform";

export function newId(): string {
  return uuid();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Trim and Unicode-normalize user text used as an identity key.
 *
 * macOS IMEs and pasted text can produce NFD (`e` + combining acute) where
 * typing gives NFC (single `é`). SQLite compares those byte-wise, so without
 * this the same-looking tag or label becomes two rows — `tags.name` is UNIQUE
 * under binary collation, and ensureTag matches exactly.
 */
export function normalizeKey(s: string): string {
  return s.normalize("NFC").trim();
}

/**
 * Locale-aware sort for display lists.
 *
 * SQLite has no COLLATE UNICODE without the ICU extension (not compiled in), so
 * `ORDER BY name` is code-point order and COLLATE NOCASE folds ASCII only —
 * which puts "Ärzte" after "Zebra" and sorts Chinese by codepoint. Sorting in
 * JS with Intl.Collator is the practical fix.
 */
export function collator(): Intl.Collator {
  return new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
}

function byName<T>(rows: T[], key: (row: T) => string): T[] {
  const c = collator();
  return [...rows].sort((a, b) => c.compare(key(a), key(b)));
}

// ---------------------------------------------------------------------------
// Events — the built-in calendar, served by the Worker (M3c). CalDAV calendars
// are unaffected: calendars.ts still fetches those live and merges them with
// these. Only calendars.ts and ai.ts call these helpers (architecture rule 3).
// ---------------------------------------------------------------------------
export async function listEvents(): Promise<EventRow[]> {
  return networkFirst(`events:${getCurrentSpaceId()}`, () =>
    apiRequest<EventRow[]>(spacePath("/events")),
  );
}

export async function getEvent(id: string): Promise<EventRow | undefined> {
  try {
    return await apiRequest<EventRow>(spacePath(`/events/${id}`));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return undefined;
    throw e;
  }
}

export type EventInput = Omit<
  EventRow,
  "id" | "sequence" | "created_at" | "updated_at"
> & { id?: string };

/** The writable event fields, in one place so create and update agree. */
function eventBody(input: EventInput): Omit<EventInput, "id"> {
  const { id: _id, ...fields } = input;
  return fields;
}

export async function upsertEvent(input: EventInput): Promise<string> {
  if (input.id) {
    await apiRequest<EventRow>(spacePath(`/events/${input.id}`), { method: "PATCH", body: eventBody(input) });
    return input.id;
  }
  const id = newId();
  await apiRequest<EventRow>(spacePath("/events"), { method: "POST", body: { id, ...eventBody(input) } });
  return id;
}

/**
 * Insert-or-update an event while preserving a caller-supplied id (= iCal UID),
 * for ICS import. Create-with-id when new, PATCH when it exists.
 */
export async function upsertEventWithId(id: string, input: EventInput): Promise<void> {
  if (await getEvent(id)) {
    await apiRequest<EventRow>(spacePath(`/events/${id}`), { method: "PATCH", body: eventBody(input) });
    return;
  }
  await apiRequest<EventRow>(spacePath("/events"), { method: "POST", body: { id, ...eventBody(input) } });
}

/** Add an EXDATE (excluded ISO date) to a recurring event. Read-modify-write:
 *  the server has no exdate-append endpoint, and this isn't a hot path. */
export async function addExdate(eventId: string, iso: string): Promise<void> {
  const ev = await getEvent(eventId);
  if (!ev) return;
  const list: string[] = ev.exdates ? JSON.parse(ev.exdates) : [];
  if (list.includes(iso)) return;
  list.push(iso);
  await apiRequest<EventRow>(spacePath(`/events/${eventId}`), {
    method: "PATCH",
    body: { exdates: JSON.stringify(list) },
  });
}

export async function deleteEvent(id: string): Promise<void> {
  await apiRequest<void>(spacePath(`/events/${id}`), { method: "DELETE" });
  await removeItemRelations("event", id); // links/tags still local until M3d
}

// ---------------------------------------------------------------------------
// Reminders — served by the Worker (M3). Same remote pattern as todos/lists.
// ---------------------------------------------------------------------------
export async function listReminders(): Promise<ReminderRow[]> {
  return networkFirst(`reminders:${getCurrentSpaceId()}`, () =>
    apiRequest<ReminderRow[]>(spacePath("/reminders")),
  );
}

export async function getReminder(id: string): Promise<ReminderRow | undefined> {
  try {
    return await apiRequest<ReminderRow>(spacePath(`/reminders/${id}`));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return undefined;
    throw e;
  }
}

export type ReminderInput = Omit<
  ReminderRow,
  "id" | "sequence" | "created_at" | "updated_at"
> & { id?: string };

export async function upsertReminder(input: ReminderInput): Promise<string> {
  // Not annotated ReminderUpdate: that would widen every field to optional and
  // break the create body's required shape. The values are all concrete.
  const fields = {
    title: input.title,
    notes: input.notes,
    due_at: input.due_at,
    remind_at: input.remind_at,
    rrule: input.rrule,
    priority: input.priority,
    completed: input.completed as 0 | 1,
    completed_at: input.completed_at,
    linked_todo_id: input.linked_todo_id,
  };
  if (input.id) {
    await apiRequest<ReminderRow>(spacePath(`/reminders/${input.id}`), { method: "PATCH", body: fields });
    return input.id;
  }
  const id = newId();
  await apiRequest<ReminderRow>(spacePath("/reminders"), {
    method: "POST",
    body: { id, ...fields } satisfies ReminderCreate,
  });
  return id;
}

export async function toggleReminder(id: string, completed: boolean): Promise<void> {
  await apiRequest<ReminderRow>(spacePath(`/reminders/${id}`), {
    method: "PATCH",
    body: { completed: completed ? 1 : 0, completed_at: completed ? nowIso() : null },
  });
}

export async function deleteReminder(id: string): Promise<void> {
  await apiRequest<void>(spacePath(`/reminders/${id}`), { method: "DELETE" });
  await removeItemRelations("reminder", id); // links/tags still local until M3d
}

// ---------------------------------------------------------------------------
// Lists + Todos — served by the Cloudflare Worker (M2). Signatures unchanged.
//
// Reads go through networkFirst: fresh from the server when online, the last
// snapshot when offline. Writes have no offline fallback by design — they throw
// OfflineError, which the UI surfaces as "can't save, you're offline". Client-
// generated ids (newId) make every create idempotent on retry.
// ---------------------------------------------------------------------------

export async function listLists(): Promise<ListRow[]> {
  const rows = await networkFirst(`lists:${getCurrentSpaceId()}`, () =>
    apiRequest<ListRow[]>(spacePath("/lists")),
  );
  // Sort client-side with Intl.Collator: D1 has no ICU, so the server's
  // ORDER BY name is only a stable default, not locale-correct.
  return byName(rows, (l) => l.name);
}

export async function upsertList(input: Partial<ListRow> & { name: string }): Promise<string> {
  const name = normalizeKey(input.name);
  if (input.id) {
    await apiRequest<ListRow>(spacePath(`/lists/${input.id}`), {
      method: "PATCH",
      body: { name, color: input.color ?? null },
    });
    return input.id;
  }
  const id = newId();
  await apiRequest<ListRow>(spacePath("/lists"), {
    method: "POST",
    body: { id, name, color: input.color ?? null },
  });
  return id;
}

export async function deleteList(id: string): Promise<void> {
  // The server rehomes this list's todos onto a survivor and refuses to delete
  // the last one (409). The old local guard "silently do nothing if it's the
  // last list" is gone on purpose — a refusal the UI can report beats a delete
  // that looks like it worked and didn't.
  await apiRequest<void>(spacePath(`/lists/${id}`), { method: "DELETE" });
}

/**
 * Formerly seeded Personal/Work into local SQLite. The Worker now creates both
 * (with per-space UUID ids) when an account registers, so this is a no-op kept
 * only so existing callers — the demo seeder — still compile. The "always at
 * least one list" invariant now lives in registration and the server's
 * last-list delete refusal.
 */
export async function ensureDefaultLists(): Promise<void> {
  /* no-op: lists are provisioned server-side at registration */
}

export async function listTodos(): Promise<TodoRow[]> {
  return networkFirst(`todos:${getCurrentSpaceId()}`, () =>
    apiRequest<TodoRow[]>(spacePath("/todos")),
  );
}

export async function getTodo(id: string): Promise<TodoRow | undefined> {
  try {
    return await apiRequest<TodoRow>(spacePath(`/todos/${id}`));
  } catch (e) {
    // A missing todo is `undefined` here, matching the old SELECT-returns-empty
    // contract; anything else (offline, auth) still throws.
    if (e instanceof ApiError && e.status === 404) return undefined;
    throw e;
  }
}

export type TodoInput = Omit<
  TodoRow,
  "id" | "sequence" | "created_at" | "updated_at"
> & { id?: string };

export async function upsertTodo(input: TodoInput): Promise<string> {
  if (input.id) {
    // A full-field PATCH: the caller (TodosView, ai.ts) has already merged, so
    // every field is present and this replaces them. The partial-merge
    // machinery still applies — absent keys would be left alone — it just
    // happens that none are absent here.
    const patch: TodoUpdate = {
      title: input.title,
      notes: input.notes,
      list_id: input.list_id,
      due_at: input.due_at,
      priority: input.priority,
      completed: input.completed as 0 | 1,
      completed_at: input.completed_at,
      parent_todo_id: input.parent_todo_id,
      position: input.position,
    };
    await apiRequest<TodoRow>(spacePath(`/todos/${input.id}`), { method: "PATCH", body: patch });
    return input.id;
  }
  const id = newId();
  const body: TodoCreate = {
    id,
    title: input.title,
    notes: input.notes,
    list_id: input.list_id,
    due_at: input.due_at,
    priority: input.priority,
    completed: input.completed as 0 | 1,
    completed_at: input.completed_at,
    parent_todo_id: input.parent_todo_id,
    position: input.position,
  };
  await apiRequest<TodoRow>(spacePath("/todos"), { method: "POST", body });
  return id;
}

export async function toggleTodo(id: string, completed: boolean): Promise<void> {
  await apiRequest<TodoRow>(spacePath(`/todos/${id}`), {
    method: "PATCH",
    body: { completed: completed ? 1 : 0, completed_at: completed ? nowIso() : null },
  });
}

export async function reorderTodos(ids: string[]): Promise<void> {
  await apiRequest<void>(spacePath("/todos/reorder"), { method: "POST", body: { ids } });
}

export async function deleteTodo(id: string): Promise<void> {
  await apiRequest<void>(spacePath(`/todos/${id}`), { method: "DELETE" });
  // Links and tags for this todo still live in local SQLite until M3, so they
  // are cleaned up here; the server already removed the todo and its subtasks.
  await removeItemRelations("todo", id);
}

// ---------------------------------------------------------------------------
// Notes — served by the Worker (M4), including the trigram FTS search. Image
// bytes live in Workers KV behind the same API (M4b).
// ---------------------------------------------------------------------------
/** Notes and diary entries share the `notes` table, discriminated by `kind`.
 *  Defaulting to "note" means every existing caller (the Notes view, link
 *  targets, the assistant's note tools) keeps seeing only notes with no change;
 *  the Diary view passes "diary". */
export async function listNotes(kind: "note" | "diary" = "note"): Promise<NoteRow[]> {
  return networkFirst(`notes:${kind}:${getCurrentSpaceId()}`, () =>
    apiRequest<NoteRow[]>(spacePath(`/notes?kind=${kind}`)),
  );
}

export async function getNote(id: string): Promise<NoteRow | undefined> {
  try {
    return await apiRequest<NoteRow>(spacePath(`/notes/${id}`));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return undefined;
    throw e;
  }
}

export type NoteInput = Omit<NoteRow, "id" | "kind" | "entry_date" | "created_at" | "updated_at"> & {
  id?: string;
  /** 'note' by default; 'diary' for a diary entry. Immutable after creation. */
  kind?: "note" | "diary";
  /** A diary entry's day (floating 'YYYY-MM-DD'). Set on create; patched only
   *  when explicitly provided so an ordinary note save never touches it. */
  entry_date?: string | null;
};

export async function upsertNote(input: NoteInput): Promise<string> {
  const fields = { title: input.title, body: input.body, pinned: input.pinned as 0 | 1 };
  if (input.id) {
    const patch: Record<string, unknown> = { ...fields };
    if (input.entry_date !== undefined) patch.entry_date = input.entry_date;
    await apiRequest<NoteRow>(spacePath(`/notes/${input.id}`), { method: "PATCH", body: patch });
    return input.id;
  }
  const id = newId();
  await apiRequest<NoteRow>(spacePath("/notes"), {
    method: "POST",
    body: { id, ...fields, kind: input.kind ?? "note", entry_date: input.entry_date ?? null },
  });
  return id;
}

export async function deleteNote(id: string): Promise<void> {
  // The server deletes the note, its image rows, and the stored bytes in one go.
  await apiRequest<void>(spacePath(`/notes/${id}`), { method: "DELETE" });
  await removeItemRelations("note", id);
}

// --- Note images -------------------------------------------------------------
// Referenced from the note body as `sbimg:<id>`. Editing a reference out of the
// markdown deliberately does NOT delete the row: saves are debounced mid-edit,
// so cutting an image to paste it lower down would destroy it between
// keystrokes. Rows are reclaimed when the whole note goes.

export async function insertNoteImage(
  noteId: string,
  img: { mime: string; data: string; width: number; height: number },
): Promise<string> {
  const id = newId();
  await putNoteImage(noteId, id, img);
  return id;
}

/** Upload image bytes under a CALLER-CHOSEN id. Restore needs this: the note
 *  body references `sbimg:<id>`, so an image that comes back with a fresh id is
 *  an image the note can no longer find. The upload is idempotent on the id, so
 *  a retried restore overwrites rather than duplicating. */
export async function putNoteImage(
  noteId: string,
  id: string,
  img: { mime: string; data: string; width: number; height: number },
): Promise<void> {
  await apiRequest<unknown>(spacePath(`/notes/${noteId}/images`), {
    method: "POST",
    body: { id, mime: img.mime, data: img.data, width: img.width, height: img.height },
  });
}

/** Blob → base64, chunked. `String.fromCharCode(...bytes)` on a 300 KB image
 *  spreads 300k arguments and blows the call stack. */
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** The bytes + dimensions for a `sbimg:` reference, fetched (authenticated) from
 *  the Worker, which reads them from KV. Undefined when the image is gone or
 *  the device is offline — NoteImage shows its missing/placeholder chip. */
export async function getNoteImage(
  id: string,
): Promise<{ mime: string; blob: Blob; width: number; height: number } | undefined> {
  try {
    const { blob, headers } = await apiGetBinary(spacePath(`/images/${id}`));
    return {
      mime: blob.type,
      blob,
      width: Number(headers.get("X-Image-Width")) || 0,
      height: Number(headers.get("X-Image-Height")) || 0,
    };
  } catch (e) {
    if (e instanceof OfflineError) return undefined;
    if (e instanceof ApiError && e.status === 404) return undefined;
    throw e;
  }
}

// searchRows (the local term-search-over-a-table helper) is gone: todos,
// reminders and events all search server-side now, each ranking with the same
// shared matchQuery. Notes keep their own FTS path (still local until M4).

/** Global-search helpers: one row per match, ranked, no filters. */
export async function searchReminders(query: string): Promise<ReminderRow[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    return await apiRequest<ReminderRow[]>(spacePath(`/reminders?q=${encodeURIComponent(q)}`));
  } catch (e) {
    if (e instanceof OfflineError) return [];
    throw e;
  }
}

/** Remote search (M2). The server ranks with the same shared helpers, so the
 *  result order matches the other search paths. Offline it degrades to empty
 *  rather than throwing — the global search bar just omits todos until the
 *  network returns, which reads better than a whole-search error. */
export async function searchTodos(query: string): Promise<TodoRow[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    return await apiRequest<TodoRow[]>(spacePath(`/todos?q=${encodeURIComponent(q)}`));
  } catch (e) {
    if (e instanceof OfflineError) return [];
    throw e;
  }
}

/** Built-in-calendar events only, ranked server-side. The remote (CalDAV) half
 *  is windowed and lives in calendars.ts. Offline degrades to empty. */
export async function searchEventRows(query: string): Promise<EventRow[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    return await apiRequest<EventRow[]>(spacePath(`/events?q=${encodeURIComponent(q)}`));
  } catch (e) {
    if (e instanceof OfflineError) return [];
    throw e;
  }
}

/**
 * Full-text search over notes (M4). The trigram-FTS-or-LIKE decision now lives
 * server-side (worker/src/db/notes.ts); both paths AND the terms and agree, and
 * the LIKE path still carries sub-3-character queries (most Chinese words).
 * Offline degrades to empty, like the other searches.
 */
/** Full-text note search. `kind` scopes to notes or diary; omitting it spans
 *  both, which is what the global search bar wants. */
export async function searchNotes(query: string, kind?: "note" | "diary"): Promise<NoteRow[]> {
  const q = query.trim();
  if (!q) return [];
  const scope = kind ? `&kind=${kind}` : "";
  try {
    return await apiRequest<NoteRow[]>(spacePath(`/notes?q=${encodeURIComponent(q)}${scope}`));
  } catch (e) {
    if (e instanceof OfflineError) return [];
    throw e;
  }
}

// --- Diary -------------------------------------------------------------------
// Diary entries are `notes` rows with kind='diary', keyed by a calendar day.
// One entry per day: helpers here find-or-create by `entry_date` so a day never
// ends up with two entries.

/** Every diary entry, newest day first. */
export function listDiary(): Promise<NoteRow[]> {
  return listNotes("diary");
}

/** The diary entry for a given day ('YYYY-MM-DD'), or undefined if none yet. */
export async function getDiaryByDate(date: string): Promise<NoteRow | undefined> {
  const entries = await listDiary();
  return entries.find((e) => e.entry_date === date);
}

/**
 * Find-or-create the diary entry for a day, then apply a partial patch to it.
 * Idempotent on the date, so "add to today's diary" never spawns a duplicate.
 * Returns the entry id.
 */
export async function upsertDiaryEntry(
  date: string,
  fields: { title?: string | null; body?: string | null },
): Promise<string> {
  const existing = await getDiaryByDate(date);
  if (existing) {
    await upsertNote({
      id: existing.id,
      title: fields.title !== undefined ? fields.title : existing.title,
      body: fields.body !== undefined ? fields.body : existing.body,
      pinned: existing.pinned as 0 | 1,
    });
    return existing.id;
  }
  return upsertNote({ kind: "diary", entry_date: date, pinned: 0, title: fields.title ?? null, body: fields.body ?? null });
}

// ---------------------------------------------------------------------------
// People (contacts, vCard-modeled). Attach to any item via `links`, tag via
// `item_tags` — both already accept item_type 'person', no schema change.
// ---------------------------------------------------------------------------
export async function listPeople(): Promise<PersonRow[]> {
  const rows = await networkFirst(`people:${getCurrentSpaceId()}`, () =>
    apiRequest<PersonRow[]>(spacePath("/people")),
  );
  return sortPeople(rows);
}

/** Favourites first, then locale-aware by name. */
function sortPeople(rows: PersonRow[]): PersonRow[] {
  const c = collator();
  return [...rows].sort(
    (a, b) => b.favorite - a.favorite || c.compare(a.full_name, b.full_name),
  );
}

export async function getPerson(id: string): Promise<PersonRow | undefined> {
  try {
    return await apiRequest<PersonRow>(spacePath(`/people/${id}`));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return undefined;
    throw e;
  }
}

/** LIKE search over name/nickname/org and the raw JSON emails/phones text.
 *  The AND-terms logic now lives server-side (db/people.ts). */
export async function searchPeople(query: string): Promise<PersonRow[]> {
  const q = query.trim();
  if (!q) return listPeople();
  try {
    const rows = await apiRequest<PersonRow[]>(spacePath(`/people?q=${encodeURIComponent(q)}`));
    return sortPeople(rows);
  } catch (e) {
    if (e instanceof OfflineError) return [];
    throw e;
  }
}

export type PersonInput = Omit<
  PersonRow,
  "id" | "sequence" | "created_at" | "updated_at"
> & { id?: string };

/** The writable person fields, in one place so create and update agree. */
function personBody(input: PersonInput): Omit<PersonInput, "id"> {
  const { id: _id, ...fields } = input;
  return fields;
}

export async function upsertPerson(input: PersonInput): Promise<string> {
  if (input.id) {
    await apiRequest<PersonRow>(spacePath(`/people/${input.id}`), {
      method: "PATCH",
      body: personBody(input),
    });
    return input.id;
  }
  const id = newId();
  await apiRequest<PersonRow>(spacePath("/people"), {
    method: "POST",
    body: { id, ...personBody(input) },
  });
  return id;
}

/**
 * Insert-or-update a person while preserving a caller-supplied id (= vCard UID),
 * for future .vcf import. Create-with-id when new, PATCH when it exists.
 */
export async function upsertPersonWithId(id: string, input: PersonInput): Promise<void> {
  if (await getPerson(id)) {
    await apiRequest<PersonRow>(spacePath(`/people/${id}`), { method: "PATCH", body: personBody(input) });
    return;
  }
  await apiRequest<PersonRow>(spacePath("/people"), { method: "POST", body: { id, ...personBody(input) } });
}

export async function deletePerson(id: string): Promise<void> {
  await apiRequest<void>(spacePath(`/people/${id}`), { method: "DELETE" });
  await removeItemRelations("person", id); // links/tags still local until M3d
}

// --- Global custom-field labels (shared across all people) -------------------
// The label set is global — a field you add shows on every person. Values stay
// per-person in people.custom_fields, keyed by label. CustomFieldDef lives in
// @secondbrain/shared (the Worker returns it); re-exported for existing callers.
export type { CustomFieldDef } from "@secondbrain/shared";

export async function listCustomFields(): Promise<CustomFieldDef[]> {
  const rows = await networkFirst(`custom_fields:${getCurrentSpaceId()}`, () =>
    apiRequest<CustomFieldDef[]>(spacePath("/custom-fields")),
  );
  // Position wins; the label tiebreak sorts locale-aware (D1 can't). Matches
  // listTags/listPeople.
  const c = collator();
  return [...rows].sort((a, b) => a.position - b.position || c.compare(a.label, b.label));
}

/** Add a global custom-field label if it doesn't already exist. Idempotent by
 *  label server-side, so a retry returns the same def. */
export async function ensureCustomField(label: string): Promise<CustomFieldDef> {
  return apiRequest<CustomFieldDef>(spacePath("/custom-fields"), {
    method: "POST",
    body: { label: normalizeKey(label) },
  });
}

/** Delete a global custom field; the server strips its value from every person
 *  (values first, def last) in one batch. */
export async function deleteCustomFieldDef(id: string): Promise<void> {
  await apiRequest<void>(spacePath(`/custom-fields/${id}`), { method: "DELETE" });
}

export async function reorderCustomFields(ids: string[]): Promise<void> {
  await apiRequest<void>(spacePath("/custom-fields/reorder"), { method: "POST", body: { ids } });
}

// ---------------------------------------------------------------------------
// Tags + Links — served by the Worker (M3d). These key items by (type, id), so
// a note's tags/links live in D1 even though the note ROW is still local until
// M4. removeItemRelations therefore hits the server for every type.
// ---------------------------------------------------------------------------
export async function listTags(): Promise<TagRow[]> {
  const rows = await networkFirst(`tags:${getCurrentSpaceId()}`, () =>
    apiRequest<TagRow[]>(spacePath("/tags")),
  );
  return byName(rows, (t) => t.name);
}

// ensureTag was removed with the M3d migration: a tag only ever exists attached
// to an item, and the server ensures it as part of tagItem. There is no
// standalone "create a tag" flow in the app.

export async function tagItem(name: string, type: ItemType, itemId: string): Promise<void> {
  await apiRequest<TagRow>(spacePath(`/items/${type}/${itemId}/tags`), {
    method: "POST",
    body: { name: normalizeKey(name) },
  });
}

export async function untagItem(tagId: string, type: ItemType, itemId: string): Promise<void> {
  await apiRequest<void>(spacePath(`/items/${type}/${itemId}/tags/${tagId}`), { method: "DELETE" });
}

export async function tagsForItem(type: ItemType, itemId: string): Promise<TagRow[]> {
  const rows = await apiRequest<TagRow[]>(spacePath(`/items/${type}/${itemId}/tags`));
  return byName(rows, (t) => t.name);
}

/** Item ids of a type carrying a tag (by name). Powers the assistant's filters. */
export async function itemIdsForTag(type: ItemType, tagName: string): Promise<string[]> {
  return apiRequest<string[]>(
    spacePath(`/tags/${encodeURIComponent(normalizeKey(tagName))}/item-ids?type=${type}`),
  );
}

export async function createLink(
  sourceType: ItemType,
  sourceId: string,
  targetType: ItemType,
  targetId: string,
): Promise<void> {
  await apiRequest<LinkRow>(spacePath("/links"), {
    method: "POST",
    body: { source_type: sourceType, source_id: sourceId, target_type: targetType, target_id: targetId },
  });
}

export async function deleteLink(id: string): Promise<void> {
  await apiRequest<void>(spacePath(`/links/${id}`), { method: "DELETE" });
}

/** All links touching an item, from either direction. */
export async function linksForItem(type: ItemType, id: string): Promise<LinkRow[]> {
  return apiRequest<LinkRow[]>(spacePath(`/items/${type}/${id}/links`));
}

/**
 * Flat list of every item as a link target (type, id, label).
 *
 * Composed from the already-remote domain lists (each networkFirst-cached) plus
 * a local notes query — notes are the one domain whose rows are still local
 * (until M4). When notes move, the local read is swapped for listNotes() and
 * this becomes a pure composition.
 */
export async function allLinkTargets(): Promise<
  { type: ItemType; id: string; label: string }[]
> {
  const [events, reminders, todos, notes, people] = await Promise.all([
    listEvents(), listReminders(), listTodos(), listNotes(), listPeople(),
  ]);
  return [
    ...events.map((e) => ({ type: "event" as ItemType, id: e.id, label: e.summary })),
    ...reminders.map((r) => ({ type: "reminder" as ItemType, id: r.id, label: r.title })),
    ...todos.map((t) => ({ type: "todo" as ItemType, id: t.id, label: t.title })),
    ...notes.map((n) => ({ type: "note" as ItemType, id: n.id, label: n.title || "(untitled)" })),
    ...people.map((p) => ({ type: "person" as ItemType, id: p.id, label: p.full_name })),
  ];
}

/**
 * Human-readable label for any item, used when rendering links/search.
 *
 * Reuses the per-type remote getters (one request each) for the migrated
 * domains and a local lookup for notes. Links are few per item, so the handful
 * of requests when a detail panel opens is acceptable.
 */
export async function getItemLabel(type: ItemType, id: string): Promise<string> {
  switch (type) {
    case "event": return (await getEvent(id))?.summary || "(untitled)";
    case "reminder": return (await getReminder(id))?.title || "(untitled)";
    case "todo": return (await getTodo(id))?.title || "(untitled)";
    case "person": return (await getPerson(id))?.full_name || "(untitled)";
    case "note": return (await getNote(id))?.title || "(untitled)";
  }
}

// ---------------------------------------------------------------------------
// Full data export / import (backup + restore, see lib/backup.ts)
//
// A backup is every row of every user table, preserved verbatim (ids,
// timestamps, sequence) so a restored account is identical to the original and
// stays CalDAV/CardDAV-syncable. The two secret-bearing settings (OpenAI key,
// CalDAV account) live in localStorage, not here, so they never travel in a
// table dump — backup.ts decides which settings to include.
//
// All of this is server-side now. The rows never existed on this device to
// begin with, and `wrangler d1 export` refuses a database containing virtual
// tables (`notes_fts` is one), so a *logical* export — walking the tables over
// the API — is the only backup that can exist. `space_id` is stripped on the
// way out and re-injected from the caller's own space on the way in, which is
// what lets a backup be restored into a different account.
// ---------------------------------------------------------------------------

// The table list lives in @secondbrain/shared so the client's file format and
// the Worker's endpoints can't disagree about what "all my data" covers.
// Re-exported because backup.ts imports both from here.
export { DATA_TABLES };
export type { DataTable };

type Row = Record<string, unknown>;

/** Pages are bounded by the Worker (max 1000); this is the request size, not a
 *  cap on the export — `exportTables` follows the cursor to the end. */
const EXPORT_PAGE = 500;

/**
 * Read every user table, following each table's cursor to exhaustion.
 *
 * One request per page rather than one for the whole account: the Workers free
 * plan caps CPU at 10 ms per request, and serializing an entire account in one
 * response is the shape that starts failing exactly when a user has enough data
 * to care about losing it.
 */
export async function exportTables(): Promise<Record<DataTable, Row[]>> {
  const out = {} as Record<DataTable, Row[]>;
  for (const table of DATA_TABLES) {
    const rows: Row[] = [];
    let cursor: string | null = null;
    do {
      const qs = new URLSearchParams({ limit: String(EXPORT_PAGE) });
      if (cursor) qs.set("cursor", cursor);
      const page: { rows: Row[]; next_cursor: string | null } = await apiRequest(
        spacePath(`/export/${table}?${qs}`),
      );
      rows.push(...page.rows);
      cursor = page.next_cursor;
    } while (cursor);
    out[table] = rows;
  }

  // Image BYTES are not in any table — they live in KV, behind the per-image
  // endpoint. Without this, a backup carries note_images metadata whose
  // blob_key points at a key that won't exist after a restore, and every image
  // in every note comes back broken. `blob_key` itself is dropped: it is a
  // storage detail the server re-derives, and carrying it is what made a
  // restore fail its NOT NULL constraint.
  out.note_images = await Promise.all(
    out.note_images.map(async (row) => {
      const { blob_key: _blobKey, ...rest } = row;
      const img = await getNoteImage(String(row.id));
      // A missing image is not worth failing the whole backup over — the row is
      // kept so the note still reports what it referenced.
      return img ? { ...rest, data: await blobToBase64(img.blob) } : rest;
    }),
  );
  return out;
}

/**
 * Replace ALL user data with the supplied rows. Destructive: the space is
 * cleared first, then the given rows are inserted with their stored columns, so
 * ids/timestamps/sequence survive a round-trip.
 *
 * The Worker drops columns it doesn't recognize and NFC-normalizes identity
 * keys (tags.name, lists.name, person_custom_fields.label) on insert, so a
 * backup written on a machine whose IME emits NFD can't reintroduce the
 * duplicate-key bug `normalizeKey` exists to prevent. Doing that server-side
 * rather than here is deliberate: there are several clients now, and a
 * client-side-only normalization is unenforceable.
 *
 * Atomicity: a restore is many requests and D1 has no cross-request
 * transaction, so a failure partway through would otherwise leave a half-empty
 * account. We snapshot the current data first and restore it if any step
 * throws — the same guarantee the local implementation gave, just paid for over
 * the network. Rows are validated before anything is cleared.
 */
export async function importTables(
  tables: Partial<Record<DataTable, Row[]>>,
): Promise<number> {
  // Validate BEFORE touching anything, so a malformed file deletes nothing.
  for (const table of DATA_TABLES) {
    for (const row of tables[table] ?? []) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        throw new Error(`Invalid row in backup table "${table}"`);
      }
    }
  }

  const snapshot = await exportTables();
  try {
    return await writeAllTables(tables);
  } catch (err) {
    // Roll the account back to its pre-import state. Best-effort: the original
    // error is the one worth reporting.
    await writeAllTables(snapshot).catch(() => { /* the original error wins */ });
    throw err;
  }
}

/** Clear the space, then upload every table in bounded batches. Returns the
 *  number of images whose BYTES couldn't be uploaded — see `restoreNoteImages`
 *  for why that is a warning and not a failure. */
async function writeAllTables(tables: Partial<Record<DataTable, Row[]>>): Promise<number> {
  await apiRequest<void>(spacePath("/data/clear"), { method: "POST" });
  for (const table of DATA_TABLES) {
    if (table === "note_images") continue; // last, and separately — see below
    const rows = tables[table] ?? [];
    // The Worker rejects batches over 1000 rows; stay well under so one batch
    // is also comfortably inside the CPU budget.
    for (let i = 0; i < rows.length; i += EXPORT_PAGE) {
      await apiRequest<unknown>(spacePath(`/import/${table}`), {
        method: "POST",
        body: { rows: rows.slice(i, i + EXPORT_PAGE) },
      });
    }
  }

  // Images go LAST, after every table that can't fail this way. The upload
  // endpoint is the one rate-limited route in a restore (it spends KV's daily
  // write budget — the tightest quota in the stack), so it is also the one that
  // can stop partway through. Doing it last means everything else has already
  // landed when it does.
  return restoreNoteImages(tables.note_images ?? []);
}

/**
 * Images go back through the ordinary upload endpoint, not the table importer.
 *
 * The bytes have to reach KV, and only the upload path writes them — a raw row
 * insert would produce metadata pointing at nothing, and `blob_key` is NOT NULL
 * besides, so a file that doesn't carry one (any backup taken before the KV
 * migration) fails outright. Going through the upload endpoint means the server
 * derives the key, exactly as it does for a fresh image.
 *
 * This is also what makes a **pre-migration backup restorable**: the old local
 * app stored base64 in a `data` column, which is precisely the field this path
 * wants. A row with no `data` (image bytes already lost) is skipped rather than
 * failing the restore — the note keeps its `sbimg:` reference and renders the
 * missing-image chip, which is honest about what happened.
 *
 * **Rate limits are why this loop is shaped the way it is.** Upload is capped
 * twice (`UPLOAD_LIMIT`, 10/min, and a durable 200/user/day), and a restore is
 * the one thing that legitimately trips both: fifty images arrive in a couple of
 * seconds. So:
 *
 *  - A burst limit is waited out. It carries `Retry-After`, and this is the one
 *    caller in the app that can honestly sleep — the user is already watching a
 *    progress state and the alternative is losing their images.
 *  - The daily budget is not, and deliberately sends no `Retry-After`: nothing
 *    the user can do in this session clears it, so the remaining images are
 *    skipped immediately rather than retried for 24 hours.
 *  - **A rate limit never throws.** It must not fail the restore: the caller's
 *    rollback re-uploads a snapshot through this same endpoint, so a throw would
 *    hit the identical limit on the way back and lose the account entirely.
 *    Skipped images leave the same missing-image chip a lost byte range already
 *    does, and the count comes back so the UI can say so. Anything else — an
 *    offline device, a 500 — still throws and still rolls the restore back;
 *    those are failures the retry can't reason about.
 */
async function restoreNoteImages(rows: Row[]): Promise<number> {
  let skipped = 0;
  let budgetSpent = false;

  for (const row of rows) {
    const data = row.data;
    const noteId = row.note_id;
    if (typeof data !== "string" || !data || typeof noteId !== "string") continue;
    if (budgetSpent) { skipped++; continue; }

    const img = {
      mime: typeof row.mime === "string" ? row.mime : "image/jpeg",
      data,
      width: Number(row.width) || 1,
      height: Number(row.height) || 1,
    };

    // Two attempts: one wait covers a full burst window, and a second refusal
    // means the pace isn't the problem.
    let done = false;
    for (let attempt = 0; attempt < 2 && !done; attempt++) {
      try {
        await putNoteImage(noteId, String(row.id), img);
        done = true;
      } catch (err) {
        if (!(err instanceof ApiError) || err.code !== "rate_limited") throw err;
        const wait = err.retryAfter;
        if (wait === undefined) { budgetSpent = true; break; } // the daily cap
        if (attempt === 0) await sleep(wait * 1000);
      }
    }
    if (!done) skipped++;
  }
  return skipped;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Remove every row of user data in the signed-in account's space, including
 *  the stored image bytes. Settings' "clear all data" uses this; the account
 *  itself survives. */
export async function clearAllData(): Promise<void> {
  await apiRequest<void>(spacePath("/data/clear"), { method: "POST" });
}



/** Remove tags + links referencing an item that is being deleted. Server-side
 *  now (M3d): tags/links live in D1 for every type, notes included. */
async function removeItemRelations(type: ItemType, id: string): Promise<void> {
  await apiRequest<void>(spacePath(`/items/${type}/${id}/relations`), { method: "DELETE" });
}
