import { Hono } from "hono";
import {
  cloudSettingsPatchSchema,
  customFieldCreateSchema,
  customFieldReorderSchema,
  eventCreateSchema,
  eventQuerySchema,
  eventUpdateSchema,
  itemTypeSchema,
  linkCreateSchema,
  noteCreateSchema,
  noteImageCreateSchema,
  noteQuerySchema,
  noteUpdateSchema,
  personCreateSchema,
  personQuerySchema,
  personUpdateSchema,
  reminderCreateSchema,
  reminderQuerySchema,
  reminderUpdateSchema,
  tagAttachSchema,
} from "@secondbrain/shared";
import type { AppEnv } from "../env";
import { ApiError, badRequest, notFound } from "../http";
import { enforceRateLimit } from "../rateLimit";
import { QUOTA_LIMITS, consumeDailyQuota } from "../db/quota";
import { requireAuth } from "../middleware/auth";
import { authorize } from "../authorize";
import {
  createReminder,
  deleteReminder,
  getReminder,
  listReminders,
  updateReminder,
} from "../db/reminders";
import {
  createPerson,
  deleteCustomFieldDef,
  deletePerson,
  ensureCustomField,
  getPerson,
  listCustomFields,
  listPeople,
  reorderCustomFields,
  updatePerson,
} from "../db/people";
import {
  createEvent,
  deleteEvent,
  getEvent,
  listEvents,
  updateEvent,
} from "../db/events";
import {
  createNote,
  deleteNote,
  getNote,
  listNotes,
  updateNote,
} from "../db/notes";
import {
  createNoteImage,
  deleteNoteImageBlobs,
  getNoteImageBytes,
  getNoteImageRow,
} from "../db/images";
import { getSpaceSettings, updateSpaceSettings } from "../db/settings";
import { clearSpaceData, exportTablePage, importTableRows } from "../db/backup";
import {
  createLink,
  deleteLink,
  itemIdsForTag,
  linksForItem,
  listTags,
  removeItemRelations,
  tagItem,
  tagsForItem,
  untagItem,
} from "../db/relations";

/**
 * Space-scoped domain routes: `/v1/spaces/:spaceId/(reminders|events|…)`.
 *
 * The space in the PATH — not inferred from the token — is what makes
 * `authorize` unmissable and sharing a straight extension: a second member of a
 * space calls the same URL, and only their membership row differs. Every
 * handler here calls `authorize` before any db helper; that is the rule the
 * whole tenancy model rests on.
 */
export const spaces = new Hono<AppEnv>();

// Identity on every route below; the space check is per-handler because it
// needs the action (read vs write).
spaces.use("/spaces/:spaceId/*", requireAuth());

/**
 * One cap across every domain route, and one insertion point for all of them.
 *
 * This runs AFTER requireAuth, which is what lets it key on the user id rather
 * than the address: two people behind one router get their own budget, and the
 * shared-NAT problem that forces the auth limiters to be lenient does not
 * apply here at all.
 *
 * It is middleware rather than a call in each handler for the reason that
 * matters most about ~90 routes — a per-handler check is a rule someone has to
 * remember, and this one guards the entire read/write surface of the database.
 * A new route added below inherits it without doing anything.
 *
 * The number is generous on purpose (see wrangler.toml): this is aimed at a
 * runaway effect loop or a stolen token walking a space, not at a fast user.
 */
spaces.use("/spaces/:spaceId/*", async (c, next) => {
  await enforceRateLimit(
    c.env.SPACE_LIMIT,
    `space:${c.get("userId")}`,
    "Too many requests. Wait a moment and try again.",
  );
  await next();
});

const spaceId = (c: { req: { param: (k: string) => string } }) => c.req.param("spaceId");

// ---------------------------------------------------------------------------
// Settings that follow the account (Settings → Widgets)
//
// Only the keys in CLOUD_SETTING_KEYS are accepted — the schema is what rejects
// anything else, and that rejection is the guarantee that no client, present or
// future, can push the OpenAI key or the iCloud password here. A patch with an
// unknown key is a 400, not a silent drop: a client sending one has a bug worth
// hearing about, and failing quietly is how a secret ends up half-synced.
// ---------------------------------------------------------------------------

spaces.get("/spaces/:spaceId/settings", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  return c.json(await getSpaceSettings(c.env.DB, spaceId(c)));
});

spaces.patch("/spaces/:spaceId/settings", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const body = await c.req.json().catch(() => null);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("Expected a JSON object.");
  }
  const patch = cloudSettingsPatchSchema.parse(body);
  return c.json(await updateSpaceSettings(c.env.DB, spaceId(c), patch));
});

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

spaces.get("/spaces/:spaceId/reminders", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  const query = reminderQuerySchema.parse(
    Object.fromEntries(new URL(c.req.url).searchParams),
  );
  const { rows, partial } = await listReminders(c.env.DB, spaceId(c), query);
  c.header("X-Partial-Match", partial ? "1" : "0");
  return c.json(rows);
});

spaces.post("/spaces/:spaceId/reminders", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const input = reminderCreateSchema.parse(await c.req.json());
  return c.json(await createReminder(c.env.DB, spaceId(c), input), 201);
});

spaces.get("/spaces/:spaceId/reminders/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  const row = await getReminder(c.env.DB, spaceId(c), c.req.param("id"));
  if (!row) throw notFound("No such reminder.");
  return c.json(row);
});

spaces.patch("/spaces/:spaceId/reminders/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const body = await c.req.json().catch(() => null);
  if (body === null || typeof body !== "object") throw badRequest("Expected a JSON object.");
  const patch = reminderUpdateSchema.parse(body);
  return c.json(await updateReminder(c.env.DB, spaceId(c), c.req.param("id"), patch));
});

spaces.delete("/spaces/:spaceId/reminders/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  await deleteReminder(c.env.DB, spaceId(c), c.req.param("id"));
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Custom-field labels (declared before /people/:id so "custom-fields" is never
// read as a person id)
// ---------------------------------------------------------------------------

spaces.get("/spaces/:spaceId/custom-fields", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  return c.json(await listCustomFields(c.env.DB, spaceId(c)));
});

spaces.post("/spaces/:spaceId/custom-fields", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const { label } = customFieldCreateSchema.parse(await c.req.json());
  return c.json(await ensureCustomField(c.env.DB, spaceId(c), label), 201);
});

spaces.post("/spaces/:spaceId/custom-fields/reorder", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const { ids } = customFieldReorderSchema.parse(await c.req.json());
  await reorderCustomFields(c.env.DB, spaceId(c), ids);
  return c.body(null, 204);
});

spaces.delete("/spaces/:spaceId/custom-fields/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  await deleteCustomFieldDef(c.env.DB, spaceId(c), c.req.param("id"));
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

spaces.get("/spaces/:spaceId/people", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  const query = personQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
  return c.json(await listPeople(c.env.DB, spaceId(c), query));
});

spaces.post("/spaces/:spaceId/people", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const input = personCreateSchema.parse(await c.req.json());
  return c.json(await createPerson(c.env.DB, spaceId(c), input), 201);
});

spaces.get("/spaces/:spaceId/people/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  const row = await getPerson(c.env.DB, spaceId(c), c.req.param("id"));
  if (!row) throw notFound("No such person.");
  return c.json(row);
});

spaces.patch("/spaces/:spaceId/people/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const body = await c.req.json().catch(() => null);
  if (body === null || typeof body !== "object") throw badRequest("Expected a JSON object.");
  const patch = personUpdateSchema.parse(body);
  return c.json(await updatePerson(c.env.DB, spaceId(c), c.req.param("id"), patch));
});

spaces.delete("/spaces/:spaceId/people/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  await deletePerson(c.env.DB, spaceId(c), c.req.param("id"));
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Events (the built-in calendar; CalDAV lives only on the client)
// ---------------------------------------------------------------------------

spaces.get("/spaces/:spaceId/events", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  const query = eventQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
  return c.json(await listEvents(c.env.DB, spaceId(c), query));
});

spaces.post("/spaces/:spaceId/events", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const input = eventCreateSchema.parse(await c.req.json());
  return c.json(await createEvent(c.env.DB, spaceId(c), input), 201);
});

spaces.get("/spaces/:spaceId/events/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  const row = await getEvent(c.env.DB, spaceId(c), c.req.param("id"));
  if (!row) throw notFound("No such event.");
  return c.json(row);
});

spaces.patch("/spaces/:spaceId/events/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const body = await c.req.json().catch(() => null);
  if (body === null || typeof body !== "object") throw badRequest("Expected a JSON object.");
  const patch = eventUpdateSchema.parse(body);
  return c.json(await updateEvent(c.env.DB, spaceId(c), c.req.param("id"), patch));
});

spaces.delete("/spaces/:spaceId/events/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  await deleteEvent(c.env.DB, spaceId(c), c.req.param("id"));
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Notes (markdown + trigram FTS). Images arrive in M4b.
// ---------------------------------------------------------------------------

spaces.get("/spaces/:spaceId/notes", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  const query = noteQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
  return c.json(await listNotes(c.env.DB, spaceId(c), query));
});

spaces.post("/spaces/:spaceId/notes", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const input = noteCreateSchema.parse(await c.req.json());
  return c.json(await createNote(c.env.DB, spaceId(c), input), 201);
});

spaces.get("/spaces/:spaceId/notes/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  const row = await getNote(c.env.DB, spaceId(c), c.req.param("id"));
  if (!row) throw notFound("No such note.");
  return c.json(row);
});

spaces.patch("/spaces/:spaceId/notes/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const body = await c.req.json().catch(() => null);
  if (body === null || typeof body !== "object") throw badRequest("Expected a JSON object.");
  const patch = noteUpdateSchema.parse(body);
  return c.json(await updateNote(c.env.DB, spaceId(c), c.req.param("id"), patch));
});

spaces.delete("/spaces/:spaceId/notes/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  // deleteNote removes the note + its image ROWS and returns the blob keys;
  // purge the values too, so a deleted note leaves nothing behind in KV.
  const keys = await deleteNote(c.env.DB, spaceId(c), c.req.param("id"));
  await deleteNoteImageBlobs(c.env.IMAGES, keys);
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Note images (bytes in KV, metadata in D1)
// ---------------------------------------------------------------------------

spaces.post("/spaces/:spaceId/notes/:noteId/images", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");

  // Its own cap, far tighter than SPACE_LIMIT, because this is the only route
  // in the API that spends the scarcest quota in the whole stack: KV's free
  // tier allows 1,000 WRITES a day — an order of magnitude below D1's 100k row
  // writes — and one upload is one write. The per-minute binding stops a burst;
  // the daily budget below is the only thing that can stop a slow drain,
  // since a binding's window tops out at 60 seconds.
  const userId = c.get("userId");
  await enforceRateLimit(
    c.env.UPLOAD_LIMIT,
    `img:${userId}`,
    "Too many image uploads. Wait a moment and try again.",
  );
  // No `Retry-After` on this one, and that omission is load-bearing rather than
  // an oversight: the burst limit above carries one, so its absence is how a
  // caller tells "wait a minute" from "wait until tomorrow". A backup restore
  // uploads images in a tight loop and reads exactly that distinction — it
  // sleeps through the first and gives up on the second (`restoreNoteImages` in
  // src/db.ts). A day-long Retry-After would be honest and useless.
  if (!(await consumeDailyQuota(c.env.DB, `img:${userId}`, QUOTA_LIMITS.imageUploads))) {
    throw new ApiError(
      "rate_limited",
      "You've added a lot of images today. Try again tomorrow.",
    );
  }

  const input = noteImageCreateSchema.parse(await c.req.json());
  const meta = await createNoteImage(
    c.env.DB, c.env.IMAGES, spaceId(c), c.req.param("noteId"), input,
  );
  return c.json(meta, 201);
});

spaces.get("/spaces/:spaceId/images/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  const row = await getNoteImageRow(c.env.DB, spaceId(c), c.req.param("id"));
  if (!row) throw notFound("No such image.");
  const bytes = await getNoteImageBytes(c.env.IMAGES, row);
  if (!bytes) throw notFound("Image bytes are missing.");

  // Dimensions ride in headers so the client can size the <img> before decode
  // without a second round-trip; they're in exposeHeaders so a browser build
  // can read them. An image is immutable for its id, so it caches hard.
  c.header("Content-Type", row.mime);
  c.header("X-Image-Width", String(row.width));
  c.header("X-Image-Height", String(row.height));
  c.header("Cache-Control", "private, max-age=31536000, immutable");
  return c.body(bytes);
});

// ---------------------------------------------------------------------------
// Tags + links (cross-cutting). `:type` is validated against the ItemType enum
// so a bad path segment is a 400, not an SQL surprise.
// ---------------------------------------------------------------------------

const itemType = (c: { req: { param: (k: string) => string } }) =>
  itemTypeSchema.parse(c.req.param("type"));

spaces.get("/spaces/:spaceId/tags", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  return c.json(await listTags(c.env.DB, spaceId(c)));
});

spaces.get("/spaces/:spaceId/tags/:name/item-ids", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  const type = itemTypeSchema.parse(new URL(c.req.url).searchParams.get("type"));
  const ids = await itemIdsForTag(c.env.DB, spaceId(c), type, c.req.param("name"));
  return c.json(ids);
});

spaces.get("/spaces/:spaceId/items/:type/:id/tags", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  return c.json(await tagsForItem(c.env.DB, spaceId(c), itemType(c), c.req.param("id")));
});

spaces.post("/spaces/:spaceId/items/:type/:id/tags", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const { name } = tagAttachSchema.parse(await c.req.json());
  return c.json(await tagItem(c.env.DB, spaceId(c), itemType(c), c.req.param("id"), name), 201);
});

spaces.delete("/spaces/:spaceId/items/:type/:id/tags/:tagId", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  await untagItem(c.env.DB, spaceId(c), itemType(c), c.req.param("id"), c.req.param("tagId"));
  return c.body(null, 204);
});

spaces.get("/spaces/:spaceId/items/:type/:id/links", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  return c.json(await linksForItem(c.env.DB, spaceId(c), itemType(c), c.req.param("id")));
});

// Deletes every tag and link touching an item — called when the item itself is
// deleted (the item's own row is removed by its domain endpoint).
spaces.delete("/spaces/:spaceId/items/:type/:id/relations", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  await removeItemRelations(c.env.DB, spaceId(c), itemType(c), c.req.param("id"));
  return c.body(null, 204);
});

spaces.post("/spaces/:spaceId/links", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const input = linkCreateSchema.parse(await c.req.json());
  return c.json(await createLink(c.env.DB, spaceId(c), input), 201);
});

spaces.delete("/spaces/:spaceId/links/:id", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  await deleteLink(c.env.DB, spaceId(c), c.req.param("id"));
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Backup: logical export/import, and the destructive "clear all data" wipe.
//
// Logical rather than a platform dump because `wrangler d1 export` refuses a
// database containing virtual tables and `notes_fts` is one. Paginated one
// table at a time because the free plan caps CPU at 10 ms per request, and
// serializing a whole account in one response is precisely the shape that
// breaks once a user's data grows. The client walks the tables.
// ---------------------------------------------------------------------------

spaces.get("/spaces/:spaceId/export/:table", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "read");
  const url = new URL(c.req.url);
  const limit = Math.min(Number(url.searchParams.get("limit")) || 500, 1000);
  try {
    return c.json(
      await exportTablePage(
        c.env.DB, spaceId(c), c.req.param("table"), url.searchParams.get("cursor"), limit,
      ),
    );
  } catch {
    throw badRequest("Unknown table.");
  }
});

// Additive: the client clears first, then posts each table. A restore is
// therefore several requests, and the client is responsible for ordering them —
// which is safe because the schema has no foreign keys at all (see CLAUDE.md).
spaces.post("/spaces/:spaceId/import/:table", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const body = await c.req.json().catch(() => null);
  if (!body || !Array.isArray(body.rows)) throw badRequest("Expected { rows: [...] }.");
  if (body.rows.length > 1000) throw badRequest("Too many rows in one batch (max 1000).");
  try {
    const inserted = await importTableRows(c.env.DB, spaceId(c), c.req.param("table"), body.rows);
    return c.json({ inserted });
  } catch (err) {
    throw badRequest(err instanceof Error ? err.message : "Invalid rows.");
  }
});

// Wipes the space's content. Membership and the space itself survive — this is
// "empty my account", not "delete my account".
spaces.post("/spaces/:spaceId/data/clear", async (c) => {
  await authorize(c.env.DB, c.get("userId"), spaceId(c), "write");
  const keys = await clearSpaceData(c.env.DB, spaceId(c));
  await deleteNoteImageBlobs(c.env.IMAGES, keys);
  return c.body(null, 204);
});
