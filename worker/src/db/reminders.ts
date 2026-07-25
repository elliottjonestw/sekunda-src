import {
  anyTermClause,
  matchQuery,
  queryTerms,
  type ReminderCreate,
  type ReminderQuery,
  type ReminderRow,
  type ReminderUpdate,
} from "@secondbrain/shared";
import { notFound } from "../http";

/**
 * All SQL touching `reminders`. Every statement binds `space_id`. Reminders
 * have no manual ordering (no reorder), and carry remind_at / rrule.
 */

const COLUMNS = `id, title, notes, due_at, remind_at, rrule, priority, completed,
                 completed_at, sequence, created_at, updated_at`;

export async function listReminders(
  db: D1Database,
  spaceId: string,
  query: ReminderQuery,
): Promise<{ rows: ReminderRow[]; partial: boolean }> {
  if (query.q && query.q.trim()) return searchReminders(db, spaceId, query.q);

  const filters = ["space_id = ?"];
  const params: unknown[] = [spaceId];
  if (query.completed) {
    filters.push("completed = ?");
    params.push(Number(query.completed));
  }

  const { results } = await db
    .prepare(
      `SELECT ${COLUMNS} FROM reminders WHERE ${filters.join(" AND ")}
       ORDER BY completed ASC, due_at IS NULL, due_at ASC`,
    )
    .bind(...params)
    .all<ReminderRow>();
  return { rows: results, partial: false };
}

async function searchReminders(
  db: D1Database,
  spaceId: string,
  q: string,
): Promise<{ rows: ReminderRow[]; partial: boolean }> {
  const terms = queryTerms(q.trim());
  if (terms.length === 0) return { rows: [], partial: false };
  const { clause, params } = anyTermClause(terms, ["title", "notes"]);
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM reminders WHERE space_id = ? AND ${clause}`)
    .bind(spaceId, ...params)
    .all<ReminderRow>();
  return matchQuery(results, q, (r) => [r.title, r.notes]);
}

export async function getReminder(
  db: D1Database,
  spaceId: string,
  id: string,
): Promise<ReminderRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM reminders WHERE id = ? AND space_id = ?`)
    .bind(id, spaceId)
    .first<ReminderRow>();
}

export async function createReminder(
  db: D1Database,
  spaceId: string,
  input: ReminderCreate,
): Promise<ReminderRow> {
  const existing = await getReminder(db, spaceId, input.id);
  if (existing) return existing; // idempotent on client-supplied id

  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO reminders (id, space_id, title, notes, due_at, remind_at, rrule,
         priority, completed, completed_at, sequence,
         created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)`,
    )
    .bind(
      input.id, spaceId, input.title, input.notes, input.due_at, input.remind_at,
      input.rrule, input.priority, input.completed, input.completed_at,
      now, now,
    )
    .run();

  const row = await getReminder(db, spaceId, input.id);
  if (!row) throw new Error("reminder vanished immediately after insert");
  return row;
}

const PATCHABLE = [
  "title", "notes", "due_at", "remind_at", "rrule",
  "priority", "completed", "completed_at",
] as const;

export async function updateReminder(
  db: D1Database,
  spaceId: string,
  id: string,
  patch: ReminderUpdate,
): Promise<ReminderRow> {
  const existing = await getReminder(db, spaceId, id);
  if (!existing) throw notFound("No such reminder.");

  const sets: string[] = [];
  const params: unknown[] = [];
  for (const col of PATCHABLE) {
    if (col in patch) {
      sets.push(`${col} = ?`);
      params.push((patch as Record<string, unknown>)[col]);
    }
  }
  sets.push("sequence = sequence + 1", "updated_at = ?");
  params.push(new Date().toISOString(), id, spaceId);

  await db
    .prepare(`UPDATE reminders SET ${sets.join(", ")} WHERE id = ? AND space_id = ?`)
    .bind(...params)
    .run();

  const row = await getReminder(db, spaceId, id);
  if (!row) throw notFound("No such reminder.");
  return row;
}

export async function deleteReminder(db: D1Database, spaceId: string, id: string): Promise<void> {
  await db.prepare("DELETE FROM reminders WHERE id = ? AND space_id = ?").bind(id, spaceId).run();
}
