import type { DataTable } from "@secondbrain/shared";
import { DATA_TABLES, normalizeKey } from "@secondbrain/shared";

/**
 * Logical export/import of a space's user data, and the destructive wipe behind
 * Settings' "clear all data".
 *
 * Why logical rather than a platform dump: `wrangler d1 export` cannot export a
 * database containing virtual tables, and `notes_fts` is one. A backup has to
 * be something that walks the tables itself — which is what this is.
 *
 * Why paginated, one table per request, rather than one endpoint returning
 * everything: the Workers free plan caps CPU at 10 ms per request. Serializing a
 * whole account in one response is exactly the shape that blows that, and it
 * would fail only once a user's data got large — the worst possible time. The
 * client walks the tables and assembles the file.
 *
 * Image BYTES are not in here. They live in KV, and the client re-fetches them
 * through the ordinary `GET /images/:id` endpoint that already streams one
 * image per request, then embeds them in the backup file. That keeps this
 * module's responses uniformly small and reuses a path that is already
 * tenancy-checked.
 *
 * Every statement is space-scoped, and `table` is only ever one of DATA_TABLES —
 * it is interpolated into SQL (a bound parameter cannot name a table), so the
 * allowlist is what makes that safe. Never widen it to an arbitrary string.
 */

function assertTable(table: string): DataTable {
  const t = DATA_TABLES.find((d) => d === table);
  if (!t) throw new Error(`Unknown table: ${table}`);
  return t;
}

/** Real column names on a table, so an unknown key in a backup file is dropped
 *  rather than throwing — and so no arbitrary JSON key reaches the SQL string. */
async function columnsOf(db: D1Database, table: DataTable): Promise<Set<string>> {
  const { results } = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return new Set(results.map((c) => c.name));
}

/**
 * Columns holding an identity key compared under binary collation. They are
 * NFC-normalized on insert exactly as the ordinary write paths do, so a backup
 * written on a machine whose IME emits NFD can't reintroduce the duplicate-tag
 * bug `normalizeKey` exists to prevent.
 */
const IDENTITY_KEY_COLS: Partial<Record<DataTable, string>> = {
  tags: "name",
  person_custom_fields: "label",
};

export interface ExportPage {
  table: DataTable;
  rows: Record<string, unknown>[];
  /** Pass back as `cursor` for the next page; null when the table is exhausted. */
  next_cursor: string | null;
}

/**
 * One page of a table, ordered by rowid so the cursor is stable and cheap.
 *
 * `space_id` is stripped from every row. A backup is then portable between
 * accounts — restoring into a fresh account is the whole point of having one —
 * and the importer injects the caller's own space, which means a crafted file
 * can never write into somebody else's.
 */
export async function exportTablePage(
  db: D1Database,
  spaceId: string,
  tableName: string,
  cursor: string | null,
  limit: number,
): Promise<ExportPage> {
  const table = assertTable(tableName);
  const after = cursor ? Number(cursor) : 0;

  const { results } = await db
    .prepare(
      `SELECT rowid AS _rowid, * FROM ${table}
        WHERE space_id = ? AND rowid > ?
        ORDER BY rowid LIMIT ?`,
    )
    .bind(spaceId, after, limit + 1)
    .all<Record<string, unknown>>();

  const page = results.slice(0, limit);
  const hasMore = results.length > limit;
  const lastRowid = page.length ? page[page.length - 1]._rowid : null;

  for (const row of page) {
    delete row._rowid;
    delete row.space_id;
  }

  return {
    table,
    rows: page,
    next_cursor: hasMore && lastRowid != null ? String(lastRowid) : null,
  };
}

/**
 * Insert a batch of rows into one table of this space.
 *
 * Rows are inserted with their stored columns, so ids, timestamps and
 * `sequence` survive a round-trip — which is what keeps a restored calendar
 * CalDAV-compatible. `INSERT OR REPLACE` makes a retried batch idempotent
 * rather than a duplicate-key failure on a flaky network.
 */
export async function importTableRows(
  db: D1Database,
  spaceId: string,
  tableName: string,
  rows: Record<string, unknown>[],
): Promise<number> {
  const table = assertTable(tableName);
  if (rows.length === 0) return 0;

  const allowed = await columnsOf(db, table);
  const identityCol = IDENTITY_KEY_COLS[table];

  const statements = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`Invalid row in "${table}"`);
    }
    // space_id is never taken from the file — it is the caller's own space.
    const cols = Object.keys(row).filter((c) => c !== "space_id" && allowed.has(c));
    if (!cols.length) continue;

    const params = cols.map((c) =>
      c === identityCol && row[c] != null ? normalizeKey(String(row[c])) : row[c],
    );

    statements.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO ${table} (space_id, ${cols.join(",")})
           VALUES (?, ${cols.map(() => "?").join(",")})`,
        )
        .bind(spaceId, ...params),
    );
  }

  if (!statements.length) return 0;
  // One batch, not a loop: every D1 query is a round-trip to the primary
  // (~105 ms measured), so a per-row loop would make a restore take minutes.
  await db.batch(statements);
  return statements.length;
}

/**
 * Delete every domain row in the space. Returns the image blob keys the caller
 * must then purge from KV — the same contract `deleteNote` uses, because KV
 * isn't part of a D1 batch.
 *
 * `notes_fts` is deliberately absent: it is a virtual FTS mirror maintained by
 * triggers, so deleting the `notes` rows empties it. Touching it directly
 * corrupts the index.
 */
export async function clearSpaceData(db: D1Database, spaceId: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT blob_key FROM note_images WHERE space_id = ?")
    .bind(spaceId)
    .all<{ blob_key: string }>();

  await db.batch(
    DATA_TABLES.map((t) => db.prepare(`DELETE FROM ${t} WHERE space_id = ?`).bind(spaceId)),
  );

  return results.map((r) => r.blob_key);
}
