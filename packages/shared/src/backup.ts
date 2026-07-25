/**
 * The set of tables a backup covers, shared so the client's file format and the
 * Worker's export/import endpoints can never disagree about what "all my data"
 * means. A table missing from one side would silently not be backed up, or
 * silently not be restored — a data-loss bug with no error to notice.
 *
 * `notes_fts` is absent on purpose: it is a virtual FTS mirror maintained by
 * triggers over `notes`, so it rebuilds itself on import. Writing to it
 * directly corrupts the index.
 *
 * `note_images` IS included, so a backup round-trips the bytes a note's
 * `sbimg:` reference points at — without it a restore leaves every image in
 * every note broken. Only the metadata rows travel through the table endpoints;
 * the bytes ride along separately (see worker/src/db/backup.ts).
 *
 * Identity/tenancy tables (`users`, `spaces`, `space_members`, `sessions`) are
 * deliberately absent: a backup carries a user's *content*, not their account.
 * Restoring one into a different account has to work, which it can't if the
 * file also claims to own the account rows.
 */
export const DATA_TABLES = [
  "tags", "item_tags", "links", "events", "reminders",
  "notes", "note_images", "people", "person_custom_fields",
] as const;

export type DataTable = (typeof DATA_TABLES)[number];
