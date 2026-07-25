-- Diary lives in the `notes` table, not a table of its own.
--
-- A diary entry is a markdown document with a title, a body and images —
-- exactly what a note already is — so it reuses the whole notes stack: the
-- trigram FTS index, the note_images bytes-in-KV pipeline, tags, links and
-- backup. The only thing a diary adds is that entries are keyed by a calendar
-- DAY (typically one per day, browsed by date) rather than being free-floating.
-- Two columns carry that:
--
--   * `kind` discriminates 'note' from 'diary'. Every existing reader
--     (Notes view, the Notes Today widget, the assistant's note tools) filters
--     to kind = 'note' so the two never leak into each other's lists; the Diary
--     view and the diary tools filter to 'diary'. Global search deliberately
--     spans both. DEFAULT 'note' backfills every existing row correctly, so
--     there is nothing to migrate.
--
--   * `entry_date` is the day an entry belongs to, a FLOATING wall date
--     ('YYYY-MM-DD', no time, no zone) for the same reason all-day events are
--     floating (lib/format.ts): a diary dated 2026-07-25 must stay the 25th in
--     every timezone, which an instant cannot promise. NULL for ordinary notes.
--
-- notes_fts needs no change: it indexes title/body only, and the INSERT/UPDATE/
-- DELETE triggers reference columns by name, so adding two is transparent to it.

ALTER TABLE notes ADD COLUMN kind TEXT NOT NULL DEFAULT 'note';  -- 'note' | 'diary'
ALTER TABLE notes ADD COLUMN entry_date TEXT;                    -- 'YYYY-MM-DD' for diary, NULL for notes

-- The Diary view lists and looks entries up by (space, kind, date); the partial
-- predicate keeps the index to diary rows only, since notes carry no entry_date.
CREATE INDEX idx_notes_kind_date ON notes(space_id, kind, entry_date);
