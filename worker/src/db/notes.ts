import {
  escapeLike,
  queryTerms,
  type NoteCreate,
  type NoteQuery,
  type NoteRow,
  type NoteUpdate,
} from "@secondbrain/shared";
import { notFound } from "../http";

/**
 * All SQL touching `notes`. Every statement binds `space_id`. The notes_fts
 * trigram index is kept in sync by triggers (migration 0001), so writes here
 * never touch it directly.
 */

const COLUMNS = "id, title, body, pinned, kind, entry_date, created_at, updated_at";

/** Shortest query the trigram tokenizer can answer (see the notes_fts comment
 *  in 0001). Below this, most CJK words included, we fall back to LIKE. */
const TRIGRAM_MIN = 3;

export async function listNotes(
  db: D1Database,
  spaceId: string,
  query: NoteQuery,
): Promise<NoteRow[]> {
  if (query.q && query.q.trim()) return searchNotes(db, spaceId, query.q, query.kind);
  // Diary entries are ordered by the day they belong to; notes by recency. When
  // no kind is given (global search never lists), fall back to the note order.
  const order = query.kind === "diary"
    ? "entry_date DESC, updated_at DESC"
    : "pinned DESC, updated_at DESC";
  const where = query.kind ? "space_id = ? AND kind = ?" : "space_id = ?";
  const params = query.kind ? [spaceId, query.kind] : [spaceId];
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM notes WHERE ${where} ORDER BY ${order}`)
    .bind(...params)
    .all<NoteRow>();
  return results;
}

/**
 * Two search paths, matching the local implementation exactly. FTS5 (ranked)
 * when the trigram index can answer, plain LIKE otherwise. The LIKE path is not
 * merely a fallback — it is the ONLY thing that can match sub-3-character
 * queries, which for Chinese is most of them. Both AND the terms.
 *
 * Every path filters `notes.space_id` — the FTS table carries no tenancy, so
 * the join back to notes is what stops one tenant's search seeing another's
 * note text. That predicate is why this lives in one function.
 */
async function searchNotes(
  db: D1Database,
  spaceId: string,
  rawQuery: string,
  kind?: string,
): Promise<NoteRow[]> {
  const q = rawQuery.trim();
  const terms = queryTerms(q);
  if (terms.length === 0) return [];

  // A kind filter is an extra AND on notes.kind, appended in both paths. Absent,
  // the search spans notes and diary alike (the global search bar).
  const kindClause = kind ? " AND kind = ?" : "";
  const kindParam = kind ? [kind] : [];

  const canUseFts = terms.every((t) => [...t].length >= TRIGRAM_MIN);
  if (canUseFts) {
    const match = terms.map((t) => `"${t}"`).join(" AND ");
    try {
      const { results } = await db
        .prepare(
          `SELECT ${COLUMNS.split(", ").map((c) => `n.${c}`).join(", ")}
           FROM notes n JOIN notes_fts f ON f.rowid = n.rowid
           WHERE notes_fts MATCH ? AND n.space_id = ?${kind ? " AND n.kind = ?" : ""}
           ORDER BY rank`,
        )
        .bind(match, spaceId, ...kindParam)
        .all<NoteRow>();
      return results;
    } catch {
      // Fall through to LIKE on any FTS parse error.
    }
  }

  const clause = terms.map(() => "(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')").join(" AND ");
  const params = terms.flatMap((t) => [`%${escapeLike(t)}%`, `%${escapeLike(t)}%`]);
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM notes WHERE space_id = ?${kindClause} AND ${clause} ORDER BY updated_at DESC`)
    .bind(spaceId, ...kindParam, ...params)
    .all<NoteRow>();
  return results;
}

export async function getNote(db: D1Database, spaceId: string, id: string): Promise<NoteRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM notes WHERE id = ? AND space_id = ?`)
    .bind(id, spaceId)
    .first<NoteRow>();
}

export async function createNote(db: D1Database, spaceId: string, input: NoteCreate): Promise<NoteRow> {
  const existing = await getNote(db, spaceId, input.id);
  if (existing) return existing; // idempotent on client id

  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO notes (id, space_id, title, body, pinned, kind, entry_date, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .bind(input.id, spaceId, input.title, input.body, input.pinned, input.kind, input.entry_date, now, now)
    .run();

  const row = await getNote(db, spaceId, input.id);
  if (!row) throw new Error("note vanished immediately after insert");
  return row;
}

const PATCHABLE = ["title", "body", "pinned", "entry_date"] as const;

export async function updateNote(
  db: D1Database,
  spaceId: string,
  id: string,
  patch: NoteUpdate,
): Promise<NoteRow> {
  const existing = await getNote(db, spaceId, id);
  if (!existing) throw notFound("No such note.");

  const sets: string[] = [];
  const params: unknown[] = [];
  for (const col of PATCHABLE) {
    if (col in patch) {
      sets.push(`${col} = ?`);
      params.push((patch as Record<string, unknown>)[col]);
    }
  }
  sets.push("updated_at = ?");
  params.push(new Date().toISOString(), id, spaceId);

  await db
    .prepare(`UPDATE notes SET ${sets.join(", ")} WHERE id = ? AND space_id = ?`)
    .bind(...params)
    .run();

  const row = await getNote(db, spaceId, id);
  if (!row) throw notFound("No such note.");
  return row;
}

/**
 * Delete a note. Its image rows are removed in the same batch; the KV values
 * they point at are deleted by the route (KV isn't part of a D1 batch). Returns
 * the blob keys the caller must purge.
 */
export async function deleteNote(db: D1Database, spaceId: string, id: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT blob_key FROM note_images WHERE note_id = ? AND space_id = ?")
    .bind(id, spaceId)
    .all<{ blob_key: string }>();

  await db.batch([
    db.prepare("DELETE FROM note_images WHERE note_id = ? AND space_id = ?").bind(id, spaceId),
    db.prepare("DELETE FROM notes WHERE id = ? AND space_id = ?").bind(id, spaceId),
  ]);

  return results.map((r) => r.blob_key);
}
