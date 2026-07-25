// AI assistant — read-only, tool-calling architecture.
//
// Instead of stuffing the entire dataset into every request (which doesn't
// scale), the model is given a set of read-only *tools* and pulls only the data
// it needs to answer a question. Every tool is filtered, paginated (bounded
// `limit`), and reports a `total` count + `truncated` flag, so large datasets
// never blow the context window. This also lays the groundwork for future
// write tools: adding them is just more entries in TOOLS + executeTool.
//
// Requests go through tauri-plugin-http's fetch (runs in Rust), which bypasses
// the browser CORS restriction that blocks calling api.openai.com from the
// webview.

import { httpFetch as fetch } from "./httpFetch";
import i18next from "i18next";
// Deliberately date-fns' unlocalized `format`, not lib/format's locale-aware
// wrapper: these strings go into the model's prompt, which stays English
// regardless of the UI language. Localizing them would only confuse the model.
import { format, startOfDay } from "date-fns";
// Locale-free numeric/ISO helpers, so importing them here doesn't localize
// anything the model reads.
import { ageFromBirthday, nextBirthday, allDayIsoFromDate } from "./format";
// The daily summary is the one model output shown verbatim to the user, so it
// needs the UI language by name.
import { LANGUAGES, currentLanguage } from "./i18n";
import type { ItemRef, ItemType, UnifiedEvent } from "../types";
import {
  getEvent, listEvents, listNotes, getNote, listReminders, getReminder, listTags, itemIdsForTag, linksForItem, tagsForItem, getItemLabel, searchNotes, queryTerms,
  matchQuery,
  upsertReminder, upsertNote, tagItem, nowIso,
  deleteReminder, deleteNote,
  listDiary, getDiaryByDate, upsertDiaryEntry,
  listPeople, getPerson, searchPeople, upsertPerson, deletePerson, createLink, deleteLink,
  ensureCustomField,
} from "../db";
import { expandEvents } from "./recurrence";
import {
  listCalendars, getCalendar, findCalendarByName, defaultCalendarId, localToUnified,
  getRemoteOccurrences, getEventByRef, findEventById, createEvent as createCalendarEvent,
  updateEvent as updateCalendarEvent, deleteEvent as deleteCalendarEvent,
  type EventDraft,
} from "./calendars";
import { getSettings, getMailSettings, hasMailAccount, type AppSettings } from "./settings";
import { getMessage, listFolders, searchMail, type MailMessageSummary } from "./mail";
import { getOpenAiKey } from "./secrets";
// Same live-fetch path the Today card uses, cache included — an assistant
// question right after that card rendered costs no second request.
import { getDayWeather, isForecastable, englishCondition } from "./weather";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /**
   * For assistant turns: the items that were shown as cards. Stripped from the
   * content sent to the model, but summarised into a reference note (see
   * `shownItemsNote`) so a follow-up like "delete it" resolves to a concrete id
   * instead of forcing the model to guess or re-search.
   */
  items?: ItemRef[];
}

// Internal OpenAI wire-format message (includes tool plumbing the UI never sees).
interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
interface OAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

const PRIORITY = ["none", "low", "medium", "high"];
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_TOOL_ROUNDS = 8; // safety cap on the agentic loop

/**
 * Web search is billed per call, not per token, so the cap that matters is on
 * calls rather than rounds. Two is enough for "check, then check the thing the
 * first result raised" and short of a model that browses.
 */
const MAX_WEB_SEARCHES = 2;

/**
 * The model that answers a `web_search` tool call.
 *
 * It is deliberately NOT the model the user picked. Search models on Chat
 * Completions *always* search and **cannot do function calling**, so one can
 * never be the assistant's own model — the tool loop would stop working. Hence
 * the two-call shape: the user's model decides a search is needed, this one
 * performs it, and its prose comes back as an ordinary tool result.
 *
 * (`gpt-4o-search-preview` and `gpt-4o-mini-search-preview` were the previous
 * generation and shut down 2026-07-23. Don't reintroduce them.)
 */
const WEB_SEARCH_MODEL = "gpt-5-search-api";

function clampLimit(n: unknown): number {
  const v = typeof n === "number" && n > 0 ? Math.floor(n) : DEFAULT_LIMIT;
  return Math.min(v, MAX_LIMIT);
}

function parseDate(s: unknown, endOfDay = false): Date | null {
  if (typeof s !== "string" || !s.trim()) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s.trim());
  const d = new Date(dateOnly ? `${s.trim()}T${endOfDay ? "23:59:59" : "00:00:00"}` : s);
  return isNaN(d.getTime()) ? null : d;
}

/** Coerce a value to an ISO string, or null if absent/invalid. */
function asIso(v: unknown, endOfDay = false): string | null {
  const d = parseDate(v, endOfDay);
  return d ? d.toISOString() : null;
}

/** Coerce a priority value (0–3 or a name) to an integer. */
function asPriority(v: unknown): number {
  if (typeof v === "number") return Math.max(0, Math.min(3, Math.floor(v)));
  const i = PRIORITY.indexOf(String(v ?? "").toLowerCase());
  return i >= 0 ? i : 0;
}

/**
 * Convert a stored timestamp to local-offset ISO for the model.
 *
 * The DB stores UTC, so handing the model a raw column (or `.toISOString()`)
 * meant it read `2026-07-20T01:30:00Z` and told the user "01:30 AM" for an
 * event that is actually at 09:30 in their timezone. The system prompt already
 * requires the model to *send* local-offset ISO; this makes reads symmetric.
 *
 * Date-only values (a vCard birthday) are passed through untouched.
 */
function toLocalIso(value: unknown): any {
  if (typeof value !== "string" || !value) return value ?? null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value; // date-only, no zone
  const d = new Date(value);
  return isNaN(d.getTime()) ? value : format(d, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

/** Datetime columns on the domain rows; birthday is date-only and excluded. */
const DATETIME_FIELDS = [
  "dtstart", "dtend", "due_at", "remind_at", "completed_at", "created_at", "updated_at",
] as const;

/** Copy a row with every datetime column converted to local-offset ISO. */
function rowWithLocalTimes<T extends Record<string, any>>(row: T): T {
  const out: Record<string, any> = { ...row };
  for (const f of DATETIME_FIELDS) {
    if (f in out && out[f] != null) out[f] = toLocalIso(out[f]);
  }
  return out as T;
}

const WRITE_TABLES = { event: "events", reminder: "reminders", note: "notes", person: "people" } as const;

/** The item kinds a delete tool can target. */
export type DeleteType = ItemType;

/**
 * A request for the user to approve a destructive delete.
 *
 * Carries only identity and a human label — never the item's fields — so the
 * confirmation card can describe what will be deleted without the assistant
 * needing to trust model-supplied text. The label is derived from the row the
 * executor just looked up, not from the tool arguments.
 */
export interface ConfirmDeleteRequest {
  type: DeleteType;
  id: string;
  /** Human descriptor: title / summary / full_name. */
  label: string;
  /** Optional secondary line, e.g. the calendar name for a connected event. */
  sub?: string;
}

/**
 * Per-turn context threaded into `executeTool`. Today only the delete executors
 * read it (for the confirmation gate + abort safety); every other tool ignores
 * it. Kept as one object so adding a future cross-cutting concern doesn't mean
 * another positional parameter on every executor.
 */
export interface ToolContext {
  signal?: AbortSignal;
  /**
   * Web searches left in this turn, decremented by `toolWebSearch`. A counter
   * rather than a prompt rule because the prompt can't be relied on for this —
   * same reason `recoverItemCards` exists. Each call is billed per search, so a
   * model that decides to "check a few sources" turns one question into several
   * charges; past the cap the tool returns an error the model can still answer
   * around. Absent means the feature is off for this turn.
   */
  webSearchesLeft?: { n: number };
  /**
   * Same reporter `callChat` uses, so a turn's token tally includes the tokens
   * a tool spent on its own model call. Without it a web search would be free
   * as far as the conversation's counter is concerned.
   */
  onUsage?: (totalTokens: number) => void;
  /**
   * Ask the user to approve a destructive delete. Resolves true to approve,
   * false if the user declined. If unset (a headless/non-UI caller) the gate
   * fails open — preserves today's behaviour rather than deadlocking a caller
   * that has no UI to confirm against.
   */
  onConfirmDelete?: (req: ConfirmDeleteRequest) => Promise<boolean>;
  /**
   * A message the assistant read in full, so the UI can show a card for it —
   * the mail equivalent of `show_items`, but automatic and out-of-band: mail is
   * not an `ItemType`, has no local row, and never goes through `show_items`.
   * Carries the whole summary (not an id) because there is nothing to reload it
   * from, which is what the Mail reader opens on click. Only `get_message` fires
   * it; a bare search shows no card. Absent for a headless caller.
   */
  onMail?: (msg: MailMessageSummary) => void;
}

async function getRowById(table: string, id: unknown): Promise<any | null> {
  if (typeof id !== "string" || !id) return null;
  // Every domain is remote now (M2–M4): a local SELECT would hit an empty table
  // and make existence checks (tag/link/update/delete) report "not found" for
  // items that exist. Events go through calendars.ts, which also covers the
  // connected CalDAV calendars, not just the built-in one.
  switch (table) {
    case "reminders": return (await getReminder(id)) ?? null;
    case "people": return (await getPerson(id)) ?? null;
    case "notes": return (await getNote(id)) ?? null;
    case "events": return (await findEventById(id)) ?? null;
    default: return null;
  }
}

/**
 * `matchQuery` and `anyTermClause` live in db.ts, next to `queryTerms` — the
 * global search bar needs the same ranking, and two copies would drift on
 * exactly the phrasing bugs they exist to prevent. `partial` is reported to
 * the model so it confirms which item was meant instead of acting on a loose
 * match, which is what protects deletes.
 */

/** Told to the model when a search had to fall back to loose matching. */
const PARTIAL_MATCH_NOTE =
  "No item matched every word of the query; these matched some of it, closest first. " +
  "Confirm which one the user means before acting on it.";

/**
 * Parse an event's `categories` (stored as a JSON string like '["Work"]') into
 * the plain labels, for text search. Returns null when there's nothing usable,
 * so matchQuery skips it like it does summary/description.
 */
function categoryLabels(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    const labels = arr.filter((c): c is string => typeof c === "string");
    return labels.length ? labels.join(" ") : null;
  } catch { return null; }
}

/** item_ids that carry a given tag name, for a given item type. */
async function idsForTag(type: string, tagName: string): Promise<Set<string>> {
  // Tags are remote now (M3d). The server resolves item ids for a tag+type.
  return new Set(await itemIdsForTag(type as ItemType, tagName));
}

// ---------------------------------------------------------------------------
// Tool schemas advertised to the model (OpenAI function-calling format)
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_overview",
      description:
        "Get a high-level overview of the user's data: counts of events/reminders/notes, the names of all tags, and the current date/time. Call this first when you need orientation.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_events",
      description:
        "Get calendar events within a date range, across every visible calendar (the built-in one and any connected Apple/CalDAV calendars). Recurring events are expanded into concrete occurrences. If start/end are omitted, defaults to today (from midnight, so earlier events today are included) through the next 30 days. To find something in the PAST, pass an explicit earlier `start` — the default window does not look back beyond today. Connected calendars are always searched by date window — there is no keyword search over their whole history, so widen start/end rather than expecting an unbounded search.",
      parameters: {
        type: "object",
        properties: {
          start: { type: "string", description: "ISO date/datetime for the window start." },
          end: { type: "string", description: "ISO date/datetime for the window end." },
          query: {
            type: "string",
            description:
              "Distinctive keywords to match in the summary/description/location — not the user's whole phrase. " +
              "Prefer \"Alex\" over \"lunch with Alex meeting\": every word must match, so extra words the user " +
              "added (\"meeting\", \"appointment\") shrink the results.",
          },
          calendar: { type: "string", description: "Limit to one calendar by name (see list_calendars)." },
          tag: { type: "string", description: "Tag name (without #). Only events in the built-in calendar carry tags." },
          limit: { type: "integer", description: `Max occurrences (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_calendars",
      description:
        "List every calendar available: the built-in local one plus any connected Apple/CalDAV calendars. Shows which are visible, which are read-only, and which is the default for new events. Call this before creating an event in a named calendar.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_reminders",
      description: "Search reminders with optional filters. Returns compact records including ids.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Distinctive keywords to match in the title or notes — not the user's whole phrase. Every word must " +
              "match, so extra words the user added shrink the results.",
          },
          status: { type: "string", enum: ["all", "active", "completed"], description: "Default 'active'." },
          flagged: { type: "boolean", description: "Only priority > 0 when true." },
          due_before: { type: "string", description: "ISO date/datetime." },
          due_after: { type: "string", description: "ISO date/datetime." },
          tag: { type: "string", description: "Tag name (without #)." },
          limit: { type: "integer", description: `Max results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_notes",
      description:
        "Full-text search over notes by keyword (returns title + body snippet), or the most recent notes when no query is given.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Distinctive keywords for full-text search — not the user's whole phrase. All terms must match, " +
              "so \"Beijing budget\" works where \"the budget note about Beijing\" finds nothing.",
          },
          pinned: { type: "boolean", description: "Only pinned notes when true." },
          limit: { type: "integer", description: `Max results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_diary",
      description:
        "Full-text search over the user's DIARY (journal) entries by keyword, or the most recent entries when no query is given. Each entry belongs to a calendar day. The diary is separate from notes: use this for journaling ('what did I write about my trip', 'my entry last Tuesday'), search_notes for everything else.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Distinctive keywords for full-text search — not the user's whole phrase. All terms must match.",
          },
          limit: { type: "integer", description: `Max results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_diary_entry",
      description:
        "Read the diary entry for a specific day. Returns its title and full body, or that no entry exists yet. Read before writing when the user wants to ADD to a day that may already have an entry — write_diary_entry replaces the fields you pass.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "The day, as YYYY-MM-DD in the user's local timezone." },
        },
        required: ["date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_people",
      description:
        "Search the user's contacts (people). Matches name, nickname, organization, and email/phone text. Returns compact records including ids, emails, phones, addresses, websites, custom fields, and notes. When a birthday is known the record also carries `age` (already worked out for today) and `next_birthday` — use those numbers as given; never recompute an age yourself.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Case-insensitive text to match on name/nickname/org/email/phone." },
          tag: { type: "string", description: "Tag name (without #)." },
          limit: { type: "integer", description: `Max results (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_item",
      description:
        "Fetch the full detail of a single item by type and id, including its tags and any linked items. Use ids returned by the search tools. Events may live in a connected calendar; pass calendar_id when you have it.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["event", "reminder", "note", "person"] },
          id: { type: "string" },
          calendar_id: { type: "string", description: "For events: the calendar_id returned by search_events." },
        },
        required: ["type", "id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_weather",
      description:
        "Get the forecast for the weather location the user set in Settings. One day per call, so a question " +
        "about a weekend takes two calls. Only ~90 days back and 14 days ahead are available. Weather is not " +
        "one of the user's items — never pass it to show_items. Never state a forecast this tool didn't return.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "yyyy-MM-dd. Defaults to today." },
          include_hours: {
            type: "boolean",
            description:
              "Include the hour-by-hour strip for the rest of the day. Only ask for it when the question is " +
              "about a time of day (\"will it rain this afternoon\") — it is a lot of numbers otherwise.",
          },
        },
      },
    },
  },

  // ---- Presentation. Renders cards in the chat; changes no data. ----
  {
    type: "function",
    function: {
      name: "show_items",
      description:
        "Display the given items to the user as cards in the chat. CALL THIS BEFORE you write your reply — it is " +
        "a separate step, and the cards are attached to the reply you write next. The cards show each item's own " +
        "details (title, time, status), so your reply should NOT repeat those details — talk about the items " +
        "naturally instead. List only the items you are actually talking about (at most 8); do not call it for " +
        "items you merely looked at while searching.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["event", "reminder", "note", "diary", "person"] },
                id: { type: "string", description: "The item's id, from a search tool. For a diary entry, the `id` from search_diary or get_diary_entry." },
                calendar_id: { type: "string", description: "For events: the calendar_id returned by search_events." },
                occurrence_start: {
                  type: "string",
                  description:
                    "For events: the `start` of the specific occurrence you mean, copied verbatim from that " +
                    "event's `start` in the search_events results. ALWAYS include it when showing a recurring " +
                    "event (one with `recurring: true`) — the series shares one id across every occurrence, so " +
                    "without it the card shows the wrong date.",
                },
              },
              required: ["type", "id"],
            },
          },
        },
        required: ["items"],
      },
    },
  },

  // ---- Write tools (create / update). No delete tools by design. ----
  {
    type: "function",
    function: {
      name: "create_event",
      description:
        "Create a new calendar event. Goes into the user's default calendar unless `calendar` names another one. Confirm ambiguous details with the user before creating.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string" },
          start: { type: "string", description: "ISO date/datetime (required)." },
          end: { type: "string", description: "ISO datetime; defaults to 1 hour after start." },
          all_day: { type: "boolean" },
          location: { type: "string" },
          description: { type: "string" },
          rrule: { type: "string", description: "RFC 5545 recurrence, e.g. FREQ=WEEKLY;BYDAY=MO,WE,FR." },
          category: { type: "string" },
          calendar: { type: "string", description: "Calendar name; omit to use the user's default calendar." },
        },
        required: ["summary", "start"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_event",
      description:
        "Update fields of an existing event by id, in any calendar. Only include the fields you want to change. Pass calendar_id from search_events when you have it — it avoids searching every calendar for the id.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          calendar_id: { type: "string", description: "The calendar_id returned by search_events." },
          summary: { type: "string" },
          start: { type: "string", description: "ISO date/datetime." },
          end: { type: "string", description: "ISO datetime, or null to clear." },
          all_day: { type: "boolean" },
          location: { type: "string" },
          description: { type: "string" },
          rrule: { type: "string", description: "RFC 5545 recurrence, or null to stop repeating." },
          category: { type: "string" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_reminder",
      description: "Create a new reminder. Confirm ambiguous details with the user before creating.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          due_at: { type: "string", description: "ISO date/datetime." },
          remind_at: { type: "string", description: "ISO datetime for the alert." },
          rrule: { type: "string", description: "RFC 5545 recurrence." },
          priority: { type: "integer" },
          notes: { type: "string" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_reminder",
      description: "Update fields of an existing reminder by id. Only include the fields you want to change. Use completed to mark done/undone.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          due_at: { type: "string", description: "ISO, or null to clear." },
          remind_at: { type: "string", description: "ISO, or null to clear." },
          rrule: { type: "string", description: "RFC 5545, or null to stop repeating." },
          priority: { type: "integer" },
          notes: { type: "string" },
          completed: { type: "boolean" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_note",
      description: "Create a new markdown note.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string", description: "Markdown content." },
          pinned: { type: "boolean" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_note",
      description: "Update fields of an existing note by id. Only include the fields you want to change.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
          pinned: { type: "boolean" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_diary_entry",
      description:
        "Create or update the user's diary (journal) entry for a day. Keyed by date: there is at most one entry per day, so this finds the existing entry or creates it. It REPLACES the title/body you pass and leaves the rest — to append to an existing entry, call get_diary_entry first and pass the combined body. Confirm the wording with the user before writing something they dictated loosely.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "The day, as YYYY-MM-DD in the user's local timezone (usually today unless they say otherwise)." },
          title: { type: "string", description: "Optional short title for the entry." },
          body: { type: "string", description: "Markdown content of the entry." },
        },
        required: ["date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_diary_entry",
      description: "Delete the diary entry for a specific day. Permanent.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "The day, as YYYY-MM-DD." },
        },
        required: ["date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_person",
      description:
        "Create a new contact (person). Multi-value fields are arrays. custom_fields are user-defined label/value pairs (e.g. {label:'Eye color', value:'Blue'}). Confirm ambiguous details first.",
      parameters: {
        type: "object",
        properties: {
          full_name: { type: "string", description: "Display name (required)." },
          given_name: { type: "string" },
          family_name: { type: "string" },
          nickname: { type: "string" },
          organization: { type: "string" },
          title: { type: "string", description: "Job title." },
          birthday: { type: "string", description: "ISO date, e.g. 1990-05-14." },
          notes: { type: "string" },
          emails: { type: "array", items: { type: "object", properties: { type: { type: "string" }, value: { type: "string" } }, required: ["value"] } },
          phones: { type: "array", items: { type: "object", properties: { type: { type: "string" }, value: { type: "string" } }, required: ["value"] } },
          urls: { type: "array", items: { type: "object", properties: { type: { type: "string" }, value: { type: "string" } }, required: ["value"] } },
          addresses: { type: "array", items: { type: "object", properties: { type: { type: "string" }, street: { type: "string" }, city: { type: "string" }, region: { type: "string" }, postal_code: { type: "string" }, country: { type: "string" } } } },
          custom_fields: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" } }, required: ["label", "value"] }, description: "User-defined data points." },
          favorite: { type: "boolean" },
        },
        required: ["full_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_person",
      description:
        "Update fields of an existing contact by id. Only include fields you want to change. Array fields (emails/phones/urls/addresses/custom_fields) REPLACE the existing list — to add one item, fetch the person with get_item first, then send the full merged list.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          full_name: { type: "string" },
          given_name: { type: "string" },
          family_name: { type: "string" },
          nickname: { type: "string" },
          organization: { type: "string" },
          title: { type: "string" },
          birthday: { type: "string", description: "ISO date, or null to clear." },
          notes: { type: "string" },
          emails: { type: "array", items: { type: "object", properties: { type: { type: "string" }, value: { type: "string" } }, required: ["value"] } },
          phones: { type: "array", items: { type: "object", properties: { type: { type: "string" }, value: { type: "string" } }, required: ["value"] } },
          urls: { type: "array", items: { type: "object", properties: { type: { type: "string" }, value: { type: "string" } }, required: ["value"] } },
          addresses: { type: "array", items: { type: "object", properties: { type: { type: "string" }, street: { type: "string" }, city: { type: "string" }, region: { type: "string" }, postal_code: { type: "string" }, country: { type: "string" } } } },
          custom_fields: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" } }, required: ["label", "value"] } },
          favorite: { type: "boolean" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_tag",
      description: "Attach a tag to an item (creating the tag if needed).",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["event", "reminder", "note", "person"] },
          id: { type: "string" },
          tag: { type: "string", description: "Tag name without the leading #." },
        },
        required: ["type", "id", "tag"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "link_items",
      description:
        "Connect any two items with a cross-link (e.g. attach a person to an event, or a note to a reminder). Works both directions. Look up both ids first.",
      parameters: {
        type: "object",
        properties: {
          source_type: { type: "string", enum: ["event", "reminder", "note", "person"] },
          source_id: { type: "string" },
          target_type: { type: "string", enum: ["event", "reminder", "note", "person"] },
          target_id: { type: "string" },
        },
        required: ["source_type", "source_id", "target_type", "target_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "unlink_items",
      description: "Remove a cross-link between two items (either direction). Only removes the link, not the items.",
      parameters: {
        type: "object",
        properties: {
          source_type: { type: "string", enum: ["event", "reminder", "note", "person"] },
          source_id: { type: "string" },
          target_type: { type: "string", enum: ["event", "reminder", "note", "person"] },
          target_id: { type: "string" },
        },
        required: ["source_type", "source_id", "target_type", "target_id"],
      },
    },
  },

  // ---- Delete tools. Destructive & irreversible. Each shows the user a
  // ---- confirmation card carrying the real item; the delete only runs if they
  // ---- click Delete. The model cannot bypass this — it is enforced in code.
  {
    type: "function",
    function: {
      name: "delete_event",
      description: "Permanently delete a calendar event by id, in any calendar. Deletes the whole event/series. The user must approve a confirmation card before it runs; you don't need to ask separately.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          calendar_id: { type: "string", description: "The calendar_id returned by search_events." },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_reminder",
      description: "Permanently delete a reminder by id. The user must approve a confirmation card before it runs; you don't need to ask separately.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_note",
      description: "Permanently delete a note by id. The user must approve a confirmation card before it runs; you don't need to ask separately.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_person",
      description: "Permanently delete a contact (person) by id. Also removes their tags and links. The user must approve a confirmation card before it runs; you don't need to ask separately.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  },
] as const;

/**
 * Appended to `TOOLS` only when Settings → Assistant has web search on, which is
 * why it lives apart from them. Off, the schema is never sent, so the feature
 * costs a user who doesn't want it exactly nothing — not even the ~90 tokens of
 * its own description on every turn.
 *
 * The description carries the "when NOT to" rules as well as the "when to". The
 * default failure here isn't the model refusing to search, it's the model
 * searching for things it already knows or things that are in the user's own
 * data, and each of those is a billed call.
 */
const WEB_SEARCH_TOOL = [
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the public web and get back a short written answer with source links. This is SLOW and COSTS " +
        "MONEY PER CALL, so it is a last resort, not a habit. Use it ONLY when the answer is a current, " +
        "real-world fact you cannot know and the user's own data cannot contain: today's news, a live price or " +
        "score, whether a business is open now, a recent release or event. Do NOT use it for anything about the " +
        "user's own events, reminders, notes or people — search those with the other tools. Do NOT use " +
        "it for the weather (get_weather), for stable general knowledge you already know, for arithmetic or " +
        "dates, or to double-check yourself. If you can answer without it, do. Ask ONE well-formed question per " +
        "call and prefer a single call.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "The question to research, as a complete natural-language question ('what time does the Tate " +
              "Modern close on Sundays') — not bare keywords, and not the user's whole message.",
          },
        },
        required: ["query"],
      },
    },
  },
] as const;

/**
 * Appended to `TOOLS` only when an inbox is connected, for the same reason the
 * web-search schema is conditional: off, it costs a user who hasn't connected
 * mail nothing at all, not even the tokens of its own description.
 *
 * All three are READS. There is no send tool, no delete tool and no
 * mark-as-read tool, and adding one is not an extension of this feature — the
 * mailbox is opened read-only at the protocol level, so a write tool would mean
 * changing the transport on both platforms, deliberately.
 *
 * The descriptions carry two facts the model gets wrong without them: that IMAP
 * search is a filter with no ranking (so "the most relevant email" is not
 * something it can ask for), and that a uid is only meaningful inside its
 * mailbox.
 */
const MAIL_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_mailboxes",
      description:
        "List the mailboxes (folders) in the user's connected iCloud inbox. Use it only when you need a " +
        "mailbox name other than INBOX — searching the inbox needs no call to this. Each result has a " +
        "`name` and a `label`: pass `name` back verbatim as the `mailbox` argument, and say `label` to " +
        "the user.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "search_mail",
      description:
        "Search the user's REAL EMAIL — their connected iCloud inbox — and get back message summaries " +
        "(subject, sender, date, read/unread). Use this for anything about mail: who emailed them, whether " +
        "someone replied, what a company sent, unread messages. Do NOT use search_people for that: People is " +
        "an address book of contacts the user typed in, and most senders are not in it. It searches the " +
        "SERVER, which has NO ranking and no fuzzy matching, so results are simply the most RECENT matches; " +
        "each field's words are matched separately and all must appear. Put a sender's name or address in " +
        "`from` and fall back to `query` if that finds nothing. Summaries carry no body text — call " +
        "get_message when the answer is inside a message.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free text matched against the message, headers first." },
          from: { type: "string", description: "Sender name or address, or part of one." },
          subject: { type: "string", description: "Words in the subject line." },
          since: { type: "string", description: "Only mail on or after this date (YYYY-MM-DD)." },
          before: { type: "string", description: "Only mail before this date (YYYY-MM-DD)." },
          unseen: { type: "boolean", description: "Only unread messages." },
          mailbox: { type: "string", description: "Mailbox name. Defaults to INBOX." },
          limit: { type: "number", description: "Max results (default 25, max 100)." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_message",
      description:
        "Read one message in full: its body text and what was attached. The uid comes from search_mail and " +
        "is ONLY valid in the mailbox it came from — pass that same mailbox back. Attachments are listed by " +
        "name, type and size; you cannot open one and there is no tool that will. If the user wants a " +
        "file, tell them to click it on the Mail page.",
      parameters: {
        type: "object",
        properties: {
          uid: { type: "number", description: "The message's uid, exactly as search_mail returned it." },
          mailbox: { type: "string", description: "The mailbox the uid came from. Defaults to INBOX." },
        },
        required: ["uid"],
      },
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Tool executors (read-only)
// ---------------------------------------------------------------------------
async function toolGetOverview() {
  // Every domain is remote now (M2–M4); count from the fetched lists. The
  // built-in calendar's event count only — connected CalDAV events are a live
  // windowed fetch, not a stored total.
  const [tags, reminders, people, events, notes] = await Promise.all([
    listTags(), listReminders(), listPeople(), listEvents(), listNotes(),
  ]);
  return {
    now: toLocalIso(new Date().toISOString()),
    now_readable: format(new Date(), "EEEE MMMM d, yyyy, h:mm a"),
    counts: {
      // Built-in calendar only; connected CalDAV events aren't counted (they're
      // a live windowed fetch, not a stored total).
      events: events.length,
      reminders: reminders.length,
      reminders_active: reminders.filter((r) => r.completed === 0).length,
      notes: notes.length,
      people: people.length,
    },
    tags: tags.map((t) => t.name),
  };
}

function toolListCalendars() {
  const def = defaultCalendarId();
  return {
    default_calendar: getCalendar(def)?.name,
    calendars: listCalendars().map((c) => ({
      calendar_id: c.id,
      name: c.name,
      source: c.source === "local" ? "built-in" : "apple",
      visible: c.visible,
      read_only: c.readOnly,
      is_default: c.id === def,
    })),
  };
}

async function toolSearchEvents(args: Record<string, unknown>) {
  // Default window starts at midnight, not `new Date()`. Defaulting to "now"
  // hid everything earlier the same day, so asking about a 12:30 lunch at 2pm
  // returned nothing and the assistant reported it didn't exist.
  const start = parseDate(args.start) ?? startOfDay(new Date());
  const end = parseDate(args.end, true) ?? new Date(Date.now() + 30 * 864e5);

  // The built-in calendar is remote now (M3c). Fetch all its events and expand
  // client-side — recurrence expansion is client-side by design (rrule), so the
  // window can't be pushed to the server without re-implementing it, and the
  // single-user dataset is small. Connected calendars are still filtered
  // server-side by the CalDAV time-range query.
  const rows = await listEvents();

  const remote = await getRemoteOccurrences(start, end);
  let occs = [
    ...expandEvents(rows.map(localToUnified), start, end),
    ...remote.occurrences,
  ].sort((a, b) => a.start.getTime() - b.start.getTime());

  if (typeof args.calendar === "string" && args.calendar.trim()) {
    const cal = findCalendarByName(args.calendar);
    if (!cal) {
      return { error: `No calendar named "${args.calendar}". Call list_calendars to see the options.` };
    }
    occs = occs.filter((o) => o.event.calendarId === cal.id);
  }
  let partial = false;
  if (typeof args.query === "string" && args.query.trim()) {
    const m = matchQuery(occs, args.query, (o) => [
      o.event.summary, o.event.description, o.event.location, categoryLabels(o.event.categories),
    ]);
    occs = m.rows;
    partial = m.partial;
  }
  if (typeof args.tag === "string" && args.tag.trim()) {
    const tagIds = await idsForTag("event", args.tag.trim());
    occs = occs.filter((o) => tagIds.has(o.event.id));
  }

  const limit = clampLimit(args.limit);
  return {
    range: { start: toLocalIso(start.toISOString()), end: toLocalIso(end.toISOString()) },
    total: occs.length,
    truncated: occs.length > limit,
    partial_match: partial ? PARTIAL_MATCH_NOTE : undefined,
    // Surfaced so the user can be told which calendars didn't answer rather
    // than being shown a confidently incomplete schedule.
    unavailable_calendars: remote.errors.length ? remote.errors : undefined,
    results: occs.slice(0, limit).map((o) => ({
      id: o.event.id, summary: o.event.summary,
      start: toLocalIso(o.start.toISOString()), end: o.end ? toLocalIso(o.end.toISOString()) : null,
      all_day: !!o.event.all_day, recurring: o.isRecurringInstance,
      location: o.event.location || undefined,
      description: o.event.description || undefined,
      calendar_id: o.event.calendarId,
      calendar: getCalendar(o.event.calendarId)?.name,
    })),
  };
}

/** Locate an event the model referred to by id (+ optional calendar_id). */
async function resolveEvent(args: Record<string, unknown>) {
  const id = typeof args.id === "string" ? args.id : "";
  if (!id) return null;
  const calendarId = typeof args.calendar_id === "string" ? args.calendar_id : "";
  if (calendarId && getCalendar(calendarId)) return getEventByRef(calendarId, id);
  return findEventById(id);
}

async function toolSearchReminders(args: Record<string, unknown>) {
  // Reminders are remote (M3): fetch the list and filter in JS. Tags stay
  // local until M3d.
  let rows: any[] = await listReminders();

  const status = (args.status as string) ?? "active";
  if (status === "active") rows = rows.filter((r) => r.completed === 0);
  else if (status === "completed") rows = rows.filter((r) => r.completed === 1);

  const queryTermList = typeof args.query === "string" ? queryTerms(args.query.trim()) : [];
  if (queryTermList.length > 0) {
    const lowered = queryTermList.map((t) => t.toLowerCase());
    rows = rows.filter((r) => {
      const hay = `${r.title ?? ""} ${r.notes ?? ""}`.toLowerCase();
      return lowered.some((t) => hay.includes(t));
    });
  }
  if (args.flagged === true) rows = rows.filter((r) => r.priority > 0);
  const coalesce = (r: any) => r.remind_at ?? r.due_at ?? null;
  const dueBefore = parseDate(args.due_before, true);
  if (dueBefore) rows = rows.filter((r) => coalesce(r) && coalesce(r) <= dueBefore.toISOString());
  const dueAfter = parseDate(args.due_after);
  if (dueAfter) rows = rows.filter((r) => coalesce(r) && coalesce(r) >= dueAfter.toISOString());

  if (typeof args.tag === "string" && args.tag.trim()) {
    const tagIds = await idsForTag("reminder", args.tag.trim());
    rows = rows.filter((r) => tagIds.has(r.id));
  }

  // completed last, then earliest remind_at/due_at first — the old ORDER BY.
  rows.sort((a, b) =>
    a.completed - b.completed ||
    (coalesce(a) ? 0 : 1) - (coalesce(b) ? 0 : 1) ||
    String(coalesce(a)).localeCompare(String(coalesce(b))),
  );

  const m = queryTermList.length > 0
    ? matchQuery(rows, args.query as string, (r) => [r.title, r.notes])
    : { rows, partial: false };
  const filtered = m.rows;
  const limit = clampLimit(args.limit);
  return {
    total: filtered.length,
    truncated: filtered.length > limit,
    partial_match: m.partial ? PARTIAL_MATCH_NOTE : undefined,
    results: filtered.slice(0, limit).map((r) => ({
      id: r.id, title: r.title, completed: !!r.completed,
      due_at: toLocalIso(r.due_at), remind_at: toLocalIso(r.remind_at), repeats: r.rrule || undefined,
      priority: PRIORITY[r.priority] ?? r.priority, notes: r.notes || undefined,
    })),
  };
}

async function toolSearchNotes(args: Record<string, unknown>) {
  const limit = clampLimit(args.limit);
  const q = typeof args.query === "string" ? args.query.trim() : "";

  // Reuse db.ts's searchNotes (remote FTS) rather than reimplementing the query,
  // so the CJK/short-query handling lives in one place. No query lists all notes
  // via listNotes(). The pinned filter is applied afterwards. Scoped to 'note'
  // so diary entries never surface here — they have their own tools.
  const found: any[] = q ? await searchNotes(q, "note") : await listNotes("note");
  const rows = args.pinned === true ? found.filter((n) => n.pinned === 1) : found;

  return {
    total: rows.length,
    truncated: rows.length > limit,
    results: rows.slice(0, limit).map((n) => ({
      id: n.id, title: n.title || "Untitled", pinned: !!n.pinned,
      snippet: (n.body ?? "").replace(/\s+/g, " ").slice(0, 400),
      updated_at: toLocalIso(n.updated_at),
    })),
  };
}

// --- Mail ------------------------------------------------------------------
//
// Every one of these turns a failure into `{ error }` rather than throwing.
// That is the tool-loop's contract — a thrown error ends the turn, and a dead
// or slow mailbox must never take the assistant down with it — and it is how a
// question that touched mail can still be answered from the user's own data.

/** The connected account, or null. Read per call rather than captured: the user
 *  can disconnect mid-conversation, and the tools are only in the schema
 *  because an account existed when the turn started. */
function mailAccount() {
  return getMailSettings().account;
}

function mailError(e: unknown): { error: string } {
  return { error: e instanceof Error ? e.message : "Could not reach the mail server." };
}

async function toolListMailboxes() {
  const account = mailAccount();
  if (!account) return { error: "No inbox is connected. Tell the user to connect one in Settings → Mail." };
  try {
    const folders = await listFolders(account);
    // Both, on purpose. `name` is the only thing `search_mail` will accept —
    // it is what the server called the mailbox — while `label` is the same
    // name out of IMAP's modified UTF-7, so a folder called 日本語 does not
    // reach the model as `&ZeVnLIqe-` and get described to the user that way.
    return {
      total: folders.length,
      results: folders.map((f) => ({ name: f.name, label: f.label ?? f.name })),
    };
  } catch (e) {
    return mailError(e);
  }
}

async function toolSearchMail(args: Record<string, unknown>) {
  const account = mailAccount();
  if (!account) return { error: "No inbox is connected. Tell the user to connect one in Settings → Mail." };
  try {
    const found = await searchMail(account, {
      mailbox: typeof args.mailbox === "string" ? args.mailbox : undefined,
      query: typeof args.query === "string" ? args.query : undefined,
      from: typeof args.from === "string" ? args.from : undefined,
      subject: typeof args.subject === "string" ? args.subject : undefined,
      since: typeof args.since === "string" ? args.since : undefined,
      before: typeof args.before === "string" ? args.before : undefined,
      unseen: args.unseen === true,
      limit: clampLimit(args.limit),
    });
    return {
      mailbox: found.mailbox,
      total: found.total,
      // Computed, not passed through. `MailSearchResult.truncated` means "the
      // uid list itself was capped", which is about paging in the UI; what the
      // model needs to know is the thing every other read tool's `truncated`
      // says — that it did not see everything that matched.
      truncated: found.total > found.results.length,
      results: found.results.map((m) => ({
        uid: m.uid,
        mailbox: m.mailbox,
        subject: m.subject,
        from: m.from.map((a) => a.name ?? a.address).join(", "),
        from_address: m.from[0]?.address ?? null,
        date: m.date ? toLocalIso(m.date) : null,
        unread: !m.seen,
      })),
    };
  } catch (e) {
    return mailError(e);
  }
}

async function toolGetMessage(args: Record<string, unknown>, ctx: ToolContext = {}) {
  const account = mailAccount();
  if (!account) return { error: "No inbox is connected. Tell the user to connect one in Settings → Mail." };
  const uid = typeof args.uid === "number" ? args.uid : Number(args.uid);
  if (!Number.isInteger(uid) || uid <= 0) return { error: "uid is required, as returned by search_mail." };
  try {
    const msg = await getMessage(account, uid, typeof args.mailbox === "string" ? args.mailbox : undefined);
    // Show the user a card for the message the assistant just read. Only the
    // summary fields — the card reopens it in Mail, it does not re-render the
    // body here. MailMessageDetail is a superset of MailMessageSummary.
    ctx.onMail?.({
      uid: msg.uid, mailbox: msg.mailbox, subject: msg.subject,
      from: msg.from, to: msg.to, date: msg.date,
      seen: msg.seen, flagged: msg.flagged, size: msg.size,
    });
    return {
      uid: msg.uid,
      mailbox: msg.mailbox,
      subject: msg.subject,
      from: msg.from.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", "),
      to: msg.to.map((a) => a.address).join(", "),
      cc: msg.cc.map((a) => a.address).join(", "),
      date: msg.date ? toLocalIso(msg.date) : null,
      unread: !msg.seen,
      body: msg.body,
      body_truncated: msg.body_truncated,
      attachments: msg.attachments.map((a) => ({ filename: a.filename, type: a.content_type })),
    };
  } catch (e) {
    return mailError(e);
  }
}

async function toolGetItem(args: Record<string, unknown>) {
  const type = args.type as string;
  const id = args.id as string;
  // One getter per type rather than a table name interpolated into SQL: there
  // is no local database to query any more, and each of these is the same
  // space-scoped endpoint the UI uses, so the assistant cannot reach a row the
  // signed-in user couldn't.
  const getters: Record<string, (id: string) => Promise<Record<string, any> | undefined>> = {
    event: getEvent, reminder: getReminder, note: getNote, person: getPerson,
  };
  const getter = getters[type];
  if (!getter || !id) return { error: "Provide a valid type (event|reminder|note|person) and id." };

  const item = await getter(id);

  // Events can live in a connected calendar, where there is no local row —
  // and no tags/links, which are keyed on local ids.
  if (!item && type === "event") {
    const remote = await resolveEvent(args);
    if (!remote) return { error: `No event found with id ${id}.` };
    return {
      type,
      item: rowWithLocalTimes(remote as any),
      calendar: getCalendar(remote.calendarId)?.name,
      tags: [],
      linked: [],
      note: "This event is in a connected calendar; tags and links apply to built-in calendar events only.",
    };
  }

  if (!item) return { error: `No ${type} found with id ${id}.` };

  const tags = (await tagsForItem(type as any, id)).map((t) => t.name);
  const links = await linksForItem(type as any, id);
  const linked = await Promise.all(links.map(async (l) => {
    const other = l.source_type === type && l.source_id === id
      ? { t: l.target_type, i: l.target_id }
      : { t: l.source_type, i: l.source_id };
    return { type: other.t, id: other.i, label: await getItemLabel(other.t, other.i) };
  }));

  if (type === "person") {
    return { type, item: { ...rowWithLocalTimes(item), ...birthdayFacts(item.birthday) }, tags, linked };
  }
  return { type, item: rowWithLocalTimes(item), tags, linked };
}

/** Parse a JSON array column back to values, or undefined if empty. */
function parseCol<T>(json: string | null): T[] | undefined {
  if (!json) return undefined;
  try { const v = JSON.parse(json); return Array.isArray(v) && v.length ? v : undefined; } catch { return undefined; }
}

/**
 * Age and next birthday, computed here rather than left to the model. Handed a
 * bare `1986-01-28` it does the subtraction in its head and answers from the
 * year its training data ended in ("36") no matter what today's date the prompt
 * carries. A number in the tool result isn't guessable.
 */
function birthdayFacts(birthday: string | null): { age?: number; next_birthday?: string } {
  if (!birthday) return {};
  const age = ageFromBirthday(birthday);
  const next = nextBirthday(birthday);
  return { age: age ?? undefined, next_birthday: next ?? undefined };
}

async function toolSearchPeople(args: Record<string, unknown>) {
  const q = typeof args.query === "string" ? args.query.trim() : "";
  let rows = q ? await searchPeople(q) : await listPeople();

  // searchPeople ANDs the terms. If that found nobody, retry loosely so a
  // query carrying an extra word ("Sam from accounting") still turns them up.
  // Only on the miss path, and the contacts table is small enough to scan.
  let partial = false;
  if (q && rows.length === 0 && queryTerms(q).length > 1) {
    const m = matchQuery(await listPeople(), q, (p) => [
      p.full_name, p.nickname, p.organization, p.title, p.emails, p.phones,
    ]);
    rows = m.rows;
    partial = m.partial;
  }

  if (typeof args.tag === "string" && args.tag.trim()) {
    const tagIds = await idsForTag("person", args.tag.trim());
    rows = rows.filter((r) => tagIds.has(r.id));
  }
  const limit = clampLimit(args.limit);
  return {
    total: rows.length,
    truncated: rows.length > limit,
    partial_match: partial ? PARTIAL_MATCH_NOTE : undefined,
    results: rows.slice(0, limit).map((p) => ({
      id: p.id,
      full_name: p.full_name,
      nickname: p.nickname || undefined,
      organization: p.organization || undefined,
      title: p.title || undefined,
      birthday: p.birthday || undefined,
      ...birthdayFacts(p.birthday),
      emails: parseCol(p.emails),
      phones: parseCol(p.phones),
      addresses: parseCol(p.addresses),
      websites: parseCol(p.urls),
      custom_fields: parseCol(p.custom_fields),
      notes: p.notes || undefined,
      favorite: !!p.favorite,
    })),
  };
}

/** Cards shown per reply. Enough for "what's on this week", short of a wall. */
const MAX_SHOWN_ITEMS = 8;

/**
 * Presentation tool: hand the UI a list of items to render as cards.
 *
 * Every ref is verified to exist before it's accepted, so a hallucinated id
 * comes back as an error the model can correct rather than a blank card.
 */
/**
 * The forecast for one day at the location in Settings.
 *
 * There is no `location` argument on purpose: the answer is about the place the
 * user configured, and resolving a place named in the message would mean
 * geocoding it and disambiguating the several Springfields it returns.
 */
async function toolGetWeather(args: Record<string, unknown>) {
  const { weatherLocation: loc, temperatureUnit: unit } = getSettings();
  if (!loc) {
    return { error: "No weather location is set. Ask the user to set one in Settings." };
  }

  // Local midnight, built field by field: `new Date("2026-07-22")` parses as UTC
  // and lands on the previous day west of Greenwich.
  let day = startOfDay(new Date());
  if (typeof args.date === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(args.date.trim());
    if (!m) return { error: "date must be yyyy-MM-dd." };
    day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  // Checked before fetching: outside its window the service answers 200 with
  // `{ error: true }`, which reads as success.
  if (!isForecastable(day)) {
    return { error: "No forecast is available for that date — only about 90 days back and 14 days ahead." };
  }

  const w = await getDayWeather(loc, day, unit);
  if (!w) return { error: "The weather service is unavailable right now." };

  const round = (n: number | null) => (n === null ? null : Math.round(n));
  // `current` only describes now, so anything derived from it is meaningful on
  // today alone — hence the `_now` names and the null on any other day.
  const isToday = day.getTime() === startOfDay(new Date()).getTime();
  return {
    place: loc.name,
    date: format(day, "yyyy-MM-dd"),
    // English, like every other string the model reads.
    condition: englishCondition(w.code),
    high: round(w.high),
    low: round(w.low),
    unit: w.unit,
    precipitation_chance: round(w.precipitation),
    temperature_now: isToday ? round(w.now) : null,
    feels_like: round(w.feelsLike),
    humidity_now: isToday ? round(w.humidity) : null,
    wind: round(w.wind),
    wind_unit: w.windUnit,
    uv_index: round(w.uvIndex),
    sunrise: w.sunrise,
    sunset: w.sunset,
    air_quality_now: w.air ? Math.round(w.air.usAqi) : null,
    hours: args.include_hours === true
      ? w.hours.map((h) => ({
          time: h.time,
          temp: Math.round(h.temp),
          condition: englishCondition(h.code),
          precipitation_chance: round(h.precipitation),
        }))
      : undefined,
  };
}

/**
 * Answer one `web_search` call by asking a search model, and hand the prose plus
 * its citations back as the tool result.
 *
 * Two calls rather than one because the shapes are incompatible: a Chat
 * Completions search model always searches and has no function calling, so it
 * can't host the tool loop, and the loop's model can't search. Keeping them
 * separate also keeps the conversation small — what re-enters the main context
 * is this digest, not pages of retrieved text, which is the difference between
 * one search costing a few hundred tokens and costing several thousand on every
 * subsequent round of the turn.
 *
 * Failures return `{ error }` like every other tool rather than throwing: a dead
 * search must leave the model able to say it couldn't look it up, not kill the
 * turn.
 */
async function toolWebSearch(args: Record<string, unknown>, ctx: ToolContext) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return { error: "query is required." };
  if (!ctx.webSearchesLeft) {
    return { error: "Web search is switched off in Settings. Answer without it, or tell the user where to turn it on." };
  }
  if (ctx.webSearchesLeft.n <= 0) {
    return { error: `No searches left this turn (limit ${MAX_WEB_SEARCHES}). Answer with what you already have.` };
  }
  ctx.webSearchesLeft.n -= 1;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${getOpenAiKey()}` },
    body: JSON.stringify({
      model: WEB_SEARCH_MODEL,
      // "low" is the cheapest context size and the right one here: the caller
      // wants a fact to fold into a spoken sentence, not a briefing. The
      // per-call fee is fixed; this bounds the tokens on top of it.
      web_search_options: { search_context_size: "low" },
      messages: [
        {
          role: "system",
          content:
            "Answer the question from current web sources in at most three short sentences of plain prose. " +
            "State the fact and when it was current. No lists, no headings, no preamble. If the sources " +
            "disagree or you cannot find it, say so plainly rather than guessing.",
        },
        { role: "user", content: query },
      ],
    }),
    signal: ctx.signal,
  });
  if (!res.ok) {
    let detail = "";
    try { const err = await res.json(); detail = err?.error?.message ?? ""; } catch { /* body may not be JSON */ }
    return { error: `Web search failed (${res.status}).${detail ? ` ${detail}` : ""}` };
  }

  const data = await res.json();
  const msg = data?.choices?.[0]?.message;
  const answer = typeof msg?.content === "string" ? msg.content.trim() : "";
  if (!answer) return { error: "Web search returned nothing." };
  if (typeof data?.usage?.total_tokens === "number") ctx.onUsage?.(data.usage.total_tokens);

  // `url_citation` annotations are what the search model returns instead of
  // inline links. Deduplicated by URL — the same source is usually cited for
  // several spans of the same answer.
  const seen = new Set<string>();
  const sources: { title: string; url: string }[] = [];
  for (const a of (msg?.annotations ?? []) as any[]) {
    const c = a?.url_citation;
    if (!c?.url || seen.has(c.url)) continue;
    seen.add(c.url);
    sources.push({ title: String(c.title ?? ""), url: String(c.url) });
    if (sources.length >= 5) break;
  }

  return {
    answer,
    sources,
    searched_at: format(new Date(), "yyyy-MM-dd'T'HH:mm:ssXXX"),
    searches_left: ctx.webSearchesLeft.n,
  };
}

/**
 * For recurring events shown without an explicit occurrence, fill in the
 * upcoming occurrence (from the start of today) so the card shows a current
 * date instead of the series' origin.
 *
 * Anchored at start-of-today, not now, so today's earlier events (a 9:30
 * standup viewed at 2pm) still resolve to today. Local events expand via
 * rrule; remote events must go through ical.js, so their occurrences are
 * fetched once and shared. A horizon past a year covers up to yearly repeats;
 * anything with no occurrence in range keeps the series start as a last resort.
 */
async function fillOccurrenceStarts(items: { ref: ItemRef; ev: UnifiedEvent }[]): Promise<void> {
  if (items.length === 0) return;
  const from = startOfDay(new Date());
  const to = new Date(from.getTime() + 366 * 864e5);

  const hasRemote = items.some((it) => it.ev.source !== "local");
  const remote = hasRemote ? (await getRemoteOccurrences(from, to)).occurrences : [];

  for (const { ref, ev } of items) {
    const occs = ev.source === "local"
      ? expandEvents([ev], from, to)
      : remote.filter((o) => o.event.id === ev.id);
    const next = occs.find((o) => o.start.getTime() >= from.getTime());
    if (next) ref.occurrenceStart = next.start.toISOString();
  }
}

async function toolShowItems(
  args: Record<string, unknown>,
  emit?: (items: ItemRef[]) => void,
) {
  const raw = Array.isArray(args.items) ? args.items : null;
  if (!raw || raw.length === 0) return { error: "Provide a non-empty items array." };

  const refs: ItemRef[] = [];
  const missing: string[] = [];
  // Recurring event refs the model didn't pin to an occurrence. Left as-is,
  // their card renders the series' stored start (a weekday standup shows the
  // day the series began, not today), so we resolve the right occurrence below.
  const needOccurrence: { ref: ItemRef; ev: UnifiedEvent }[] = [];

  for (const entry of raw.slice(0, MAX_SHOWN_ITEMS)) {
    if (!entry || typeof entry !== "object") continue;
    const { type, id, calendar_id, occurrence_start } = entry as Record<string, unknown>;
    // "diary" is a card kind, not a WRITE_TABLES/tag ItemType — allow it too.
    if (typeof type !== "string" || !(type === "diary" || type in WRITE_TABLES) || typeof id !== "string" || !id) {
      missing.push(`${String(type)} ${String(id)}`);
      continue;
    }
    if (type === "diary") {
      // A diary entry is a note row; its day (not its id) is how the card routes.
      const entryRow = await getNote(id);
      if (!entryRow || entryRow.kind !== "diary") { missing.push(`diary ${id}`); continue; }
      refs.push({ type: "diary", id, diaryDate: entryRow.entry_date ?? undefined });
      continue;
    }
    if (type === "event") {
      // Events may live in a connected calendar, where there is no SQLite row.
      const ev = await resolveEvent({ id, calendar_id });
      if (!ev) { missing.push(`event ${id}`); continue; }
      const ref: ItemRef = {
        type: "event",
        id,
        // Default to the event's own calendar so the card can fetch it directly
        // rather than scanning every calendar for the id.
        calendarId: typeof calendar_id === "string" ? calendar_id : ev.calendarId,
        occurrenceStart: asIso(occurrence_start) ?? undefined,
      };
      refs.push(ref);
      if (ev.rrule && !ref.occurrenceStart) needOccurrence.push({ ref, ev });
    } else {
      const exists = !!(await getRowById(WRITE_TABLES[type as ItemType], id));
      if (!exists) { missing.push(`${type} ${id}`); continue; }
      refs.push({ type: type as ItemType, id });
    }
  }

  if (refs.length === 0) {
    return { error: `None of those items exist: ${missing.join(", ")}. Look the ids up with a search tool.` };
  }
  await fillOccurrenceStarts(needOccurrence);
  emit?.(refs);
  return {
    ok: true,
    shown: refs.length,
    // Reported rather than silently dropped, so the model can correct itself
    // instead of describing an item the user never sees a card for.
    not_found: missing.length ? missing : undefined,
    omitted: raw.length > MAX_SHOWN_ITEMS ? raw.length - MAX_SHOWN_ITEMS : undefined,
  };
}

// ---------------------------------------------------------------------------
// Tool executors (write: create / update). No delete tools by design; all
// changes are reversible by the user in the UI.
// ---------------------------------------------------------------------------
async function toolCreateEvent(args: Record<string, unknown>) {
  if (typeof args.summary !== "string" || !args.summary.trim()) return { error: "summary is required." };
  const dtstart = asIso(args.start);
  if (!dtstart) return { error: "A valid ISO start is required." };

  // A named calendar wins; otherwise new events land in the user's default.
  let calendarId = defaultCalendarId();
  if (typeof args.calendar === "string" && args.calendar.trim()) {
    const named = findCalendarByName(args.calendar);
    if (!named) {
      return { error: `No calendar named "${args.calendar}". Call list_calendars to see the options.` };
    }
    calendarId = named.id;
  }

  const allDay = args.all_day === true;
  // All-day events store a floating wall date (timezone-independent), taken from
  // the local date of the instant the model sent. Timed events stay instants.
  const start = allDay ? allDayIsoFromDate(new Date(dtstart)) : dtstart;
  const dtend = allDay ? null : (asIso(args.end) ?? new Date(new Date(dtstart).getTime() + 3600e3).toISOString());
  try {
    const id = await createCalendarEvent(calendarId, {
      summary: args.summary.trim(),
      description: typeof args.description === "string" ? args.description : null,
      location: typeof args.location === "string" ? args.location : null,
      dtstart: start, dtend, all_day: allDay ? 1 : 0,
      rrule: typeof args.rrule === "string" ? args.rrule : null,
      exdates: null, status: "CONFIRMED",
      categories: typeof args.category === "string" ? JSON.stringify([args.category]) : null,
      color: null,
    });
    return { ok: true, id, calendar_id: calendarId, calendar: getCalendar(calendarId)?.name };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function toolUpdateEvent(args: Record<string, unknown>) {
  const ev = await resolveEvent(args);
  if (!ev) return { error: `No event found with id ${args.id}.` };

  // Partial merge: "field" in args distinguishes "clear it" from "leave it".
  // Datetimes differ from the other fields: a present-but-unparseable value is
  // a model error, not a "leave it alone" — otherwise the model would think
  // it moved an event that didn't move (matching toolCreateEvent's behavior).
  const patch: Partial<EventDraft> = {};
  if ("summary" in args) patch.summary = String(args.summary);
  if ("description" in args) patch.description = args.description as string | null;
  if ("location" in args) patch.location = args.location as string | null;
  // The event's all-day state after this update decides whether datetimes are
  // stored as floating wall dates (timezone-independent) or absolute instants.
  const allDayTarget = "all_day" in args ? !!args.all_day : ev.all_day === 1;
  if ("all_day" in args) patch.all_day = args.all_day ? 1 : 0;
  if ("start" in args) {
    const iso = asIso(args.start);
    if (!iso) return { error: "A valid ISO start is required." };
    patch.dtstart = allDayTarget ? allDayIsoFromDate(new Date(iso)) : iso;
  } else if (allDayTarget && ev.all_day !== 1) {
    // Turning a timed event all-day with no new start: pin its local wall date.
    patch.dtstart = allDayIsoFromDate(new Date(ev.dtstart));
  }
  if ("end" in args) {
    // `null` is the documented way to clear the end; a present-but-unparseable
    // string is a model error (mirrors the start handling).
    if (args.end === null) {
      patch.dtend = null;
    } else {
      const iso = asIso(args.end);
      if (!iso) return { error: "A valid ISO end is required (pass null to clear)." };
      patch.dtend = allDayTarget ? allDayIsoFromDate(new Date(iso)) : iso;
    }
  }
  if ("rrule" in args) patch.rrule = args.rrule ? String(args.rrule) : null;
  if ("category" in args) patch.categories = args.category ? JSON.stringify([args.category]) : null;

  try {
    await updateCalendarEvent(ev, patch);
    return { ok: true, id: ev.id, calendar: getCalendar(ev.calendarId)?.name };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function toolCreateReminder(args: Record<string, unknown>) {
  if (typeof args.title !== "string" || !args.title.trim()) return { error: "title is required." };
  const id = await upsertReminder({
    title: args.title.trim(),
    notes: typeof args.notes === "string" ? args.notes : null,
    due_at: asIso(args.due_at),
    remind_at: asIso(args.remind_at),
    rrule: typeof args.rrule === "string" ? args.rrule : null,
    priority: asPriority(args.priority),
    completed: 0, completed_at: null,
  });
  return { ok: true, id };
}

async function toolUpdateReminder(args: Record<string, unknown>) {
  const r = await getRowById("reminders", args.id);
  if (!r) return { error: `No reminder found with id ${args.id}.` };
  const completed = "completed" in args ? (args.completed ? 1 : 0) : r.completed;
  await upsertReminder({
    id: r.id,
    title: "title" in args ? String(args.title) : r.title,
    notes: "notes" in args ? (args.notes as string | null) : r.notes,
    due_at: "due_at" in args ? asIso(args.due_at) : r.due_at,
    remind_at: "remind_at" in args ? asIso(args.remind_at) : r.remind_at,
    rrule: "rrule" in args ? (args.rrule ? String(args.rrule) : null) : r.rrule,
    priority: "priority" in args ? asPriority(args.priority) : r.priority,
    completed,
    completed_at: completed ? (r.completed_at ?? nowIso()) : null,
  });
  return { ok: true, id: r.id };
}

async function toolCreateNote(args: Record<string, unknown>) {
  if (typeof args.title !== "string" && typeof args.body !== "string") return { error: "Provide a title and/or body." };
  const id = await upsertNote({
    title: typeof args.title === "string" ? args.title : "Untitled",
    body: typeof args.body === "string" ? args.body : "",
    pinned: args.pinned === true ? 1 : 0,
  });
  return { ok: true, id };
}

async function toolUpdateNote(args: Record<string, unknown>) {
  const n = await getRowById("notes", args.id);
  if (!n) return { error: `No note found with id ${args.id}.` };
  await upsertNote({
    id: n.id,
    title: "title" in args ? (args.title as string | null) : n.title,
    body: "body" in args ? (args.body as string | null) : n.body,
    pinned: "pinned" in args ? (args.pinned ? 1 : 0) : n.pinned,
  });
  return { ok: true, id: n.id };
}

// --- Diary -----------------------------------------------------------------
// Diary entries are notes (kind='diary') keyed by a calendar day. These tools
// keep the day-centric contract the model reasons about; the storage reuse is
// invisible to it. A date is always a floating 'YYYY-MM-DD'.

const DIARY_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function toolSearchDiary(args: Record<string, unknown>) {
  const limit = clampLimit(args.limit);
  const q = typeof args.query === "string" ? args.query.trim() : "";
  const found: any[] = q ? await searchNotes(q, "diary") : await listDiary();
  return {
    total: found.length,
    truncated: found.length > limit,
    results: found.slice(0, limit).map((n) => ({
      id: n.id, date: n.entry_date,
      title: n.title || "",
      snippet: (n.body ?? "").replace(/\s+/g, " ").slice(0, 400),
      updated_at: toLocalIso(n.updated_at),
    })),
  };
}

async function toolGetDiaryEntry(args: Record<string, unknown>) {
  const date = typeof args.date === "string" ? args.date.trim() : "";
  if (!DIARY_DATE.test(date)) return { error: "Provide a date as YYYY-MM-DD." };
  const entry = await getDiaryByDate(date);
  if (!entry) return { date, exists: false };
  return { date, exists: true, id: entry.id, title: entry.title || "", body: entry.body || "" };
}

async function toolWriteDiaryEntry(args: Record<string, unknown>) {
  const date = typeof args.date === "string" ? args.date.trim() : "";
  if (!DIARY_DATE.test(date)) return { error: "Provide a date as YYYY-MM-DD." };
  if (typeof args.title !== "string" && typeof args.body !== "string") return { error: "Provide a title and/or body." };
  // `"field" in args` distinguishes clear-to-null from leave-alone, matching the
  // other write tools; upsertDiaryEntry preserves any field left undefined.
  const id = await upsertDiaryEntry(date, {
    title: "title" in args ? (args.title as string | null) : undefined,
    body: "body" in args ? (args.body as string | null) : undefined,
  });
  return { ok: true, id, date };
}

async function toolDeleteDiaryEntry(args: Record<string, unknown>, ctx: ToolContext) {
  const date = typeof args.date === "string" ? args.date.trim() : "";
  if (!DIARY_DATE.test(date)) return { error: "Provide a date as YYYY-MM-DD." };
  const entry = await getDiaryByDate(date);
  if (!entry) return { error: `No diary entry for ${date}.` };
  if (!(await confirmBeforeDelete(ctx, "note", entry.id, `Diary — ${date}`))) return DENIED;
  await deleteNote(entry.id);
  return { ok: true, deleted: { type: "diary", id: entry.id, date } };
}

async function toolAddTag(args: Record<string, unknown>) {
  const type = args.type as string;
  const id = args.id as string;
  const tag = args.tag as string;
  if (!(type in WRITE_TABLES) || !id || typeof tag !== "string" || !tag.trim()) {
    return { error: "Provide type, id, and a non-empty tag." };
  }
  const existing = await getRowById(WRITE_TABLES[type as ItemType], id);
  if (!existing) return { error: `No ${type} found with id ${id}.` };
  await tagItem(tag.trim().replace(/^#/, ""), type as ItemType, id);
  return { ok: true };
}

// ---- People + generic linking ----
/** Trim a string arg to non-empty, else null (used for "clear" semantics). */
function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
/** Serialize an array arg (of objects) to a JSON column, or null if empty. */
function jsonArrOrNull(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  const items = v.filter((x) => x && typeof x === "object");
  return items.length ? JSON.stringify(items) : null;
}

/** Custom-field labels are global — make sure any the model uses exist as defs. */
async function registerCustomFieldLabels(v: unknown): Promise<void> {
  if (!Array.isArray(v)) return;
  for (const item of v) {
    const label = item && typeof item === "object" ? (item as { label?: unknown }).label : undefined;
    if (typeof label === "string" && label.trim()) await ensureCustomField(label.trim());
  }
}

async function toolCreatePerson(args: Record<string, unknown>) {
  if (typeof args.full_name !== "string" || !args.full_name.trim()) return { error: "full_name is required." };
  await registerCustomFieldLabels(args.custom_fields);
  const id = await upsertPerson({
    full_name: args.full_name.trim(),
    given_name: strOrNull(args.given_name),
    family_name: strOrNull(args.family_name),
    additional_names: null,
    honorific_prefix: null,
    honorific_suffix: null,
    nickname: strOrNull(args.nickname),
    organization: strOrNull(args.organization),
    title: strOrNull(args.title),
    birthday: strOrNull(args.birthday),
    notes: strOrNull(args.notes),
    photo: null,
    emails: jsonArrOrNull(args.emails),
    phones: jsonArrOrNull(args.phones),
    addresses: jsonArrOrNull(args.addresses),
    urls: jsonArrOrNull(args.urls),
    custom_fields: jsonArrOrNull(args.custom_fields),
    favorite: args.favorite === true ? 1 : 0,
  });
  return { ok: true, id };
}

async function toolUpdatePerson(args: Record<string, unknown>) {
  const p = await getRowById("people", args.id);
  if (!p) return { error: `No person found with id ${args.id}.` };
  if ("custom_fields" in args) await registerCustomFieldLabels(args.custom_fields);
  const keepStr = (k: string, cur: string | null) => (k in args ? strOrNull(args[k]) : cur);
  const keepArr = (k: string, cur: string | null) => (k in args ? jsonArrOrNull(args[k]) : cur);
  await upsertPerson({
    id: p.id,
    full_name: "full_name" in args ? (String(args.full_name).trim() || p.full_name) : p.full_name,
    given_name: keepStr("given_name", p.given_name),
    family_name: keepStr("family_name", p.family_name),
    additional_names: p.additional_names,
    honorific_prefix: p.honorific_prefix,
    honorific_suffix: p.honorific_suffix,
    nickname: keepStr("nickname", p.nickname),
    organization: keepStr("organization", p.organization),
    title: keepStr("title", p.title),
    birthday: keepStr("birthday", p.birthday),
    notes: keepStr("notes", p.notes),
    photo: p.photo,
    emails: keepArr("emails", p.emails),
    phones: keepArr("phones", p.phones),
    addresses: keepArr("addresses", p.addresses),
    urls: keepArr("urls", p.urls),
    custom_fields: keepArr("custom_fields", p.custom_fields),
    favorite: "favorite" in args ? (args.favorite ? 1 : 0) : p.favorite,
  });
  return { ok: true, id: p.id };
}

const LINK_TYPES = ["event", "reminder", "note", "person"];

/** Validate a link request and confirm both endpoints exist. */
async function resolveLinkPair(args: Record<string, unknown>) {
  const st = args.source_type as string;
  const si = args.source_id as string;
  const tt = args.target_type as string;
  const ti = args.target_id as string;
  if (!LINK_TYPES.includes(st) || !LINK_TYPES.includes(tt) || typeof si !== "string" || typeof ti !== "string") {
    return { error: "Provide source_type, source_id, target_type, target_id (types: event|reminder|note|person)." as const };
  }
  const s = await getRowById(WRITE_TABLES[st as ItemType], si);
  if (!s) return { error: `No ${st} found with id ${si}.` as const };
  const t = await getRowById(WRITE_TABLES[tt as ItemType], ti);
  if (!t) return { error: `No ${tt} found with id ${ti}.` as const };
  return { st: st as ItemType, si, tt: tt as ItemType, ti };
}

async function toolLinkItems(args: Record<string, unknown>) {
  const r = await resolveLinkPair(args);
  if ("error" in r) return { error: r.error };
  const existing = await linksForItem(r.st, r.si);
  const dup = existing.some((l) =>
    (l.target_type === r.tt && l.target_id === r.ti) || (l.source_type === r.tt && l.source_id === r.ti));
  if (dup) return { ok: true, note: "Those items were already linked." };
  await createLink(r.st, r.si, r.tt, r.ti);
  return { ok: true };
}

async function toolUnlinkItems(args: Record<string, unknown>) {
  const r = await resolveLinkPair(args);
  if ("error" in r) return { error: r.error };
  const links = await linksForItem(r.st, r.si);
  const match = links.find((l) =>
    (l.source_type === r.st && l.source_id === r.si && l.target_type === r.tt && l.target_id === r.ti) ||
    (l.source_type === r.tt && l.source_id === r.ti && l.target_type === r.st && l.target_id === r.si));
  if (!match) return { error: "Those items are not linked." };
  await deleteLink(match.id);
  return { ok: true };
}

// ---- Delete executors (destructive; reuse the same db helpers as the UI) ----
//
// Every delete is gated by `confirmBeforeDelete`: the executor resolves the row
// FIRST (so the confirmation card shows a real label, not whatever the model
// claimed), then awaits the user's decision before touching data. The agentic
// loop pauses naturally on that await — there is no separate pause mechanism.
//
// A user who declines produces `{ denied: true }`, a shape distinct from both
// `{ ok }` and `{ error }`: it tells the model "the user said no" rather than
// "the item wasn't found", so the model stops instead of re-searching.
const DENIED = {
  denied: true as const,
  message:
    "The user declined this deletion in the confirmation card. Do not retry it; " +
    "acknowledge that they cancelled and ask how they'd like to proceed.",
};

async function toolDeleteEvent(args: Record<string, unknown>, ctx: ToolContext) {
  const ev = await resolveEvent(args);
  if (!ev) return { error: `No event found with id ${args.id}.` };
  const calName = getCalendar(ev.calendarId)?.name;
  if (!(await confirmBeforeDelete(ctx, "event", ev.id, ev.summary, calName))) return DENIED;
  try {
    await deleteCalendarEvent(ev);
    return {
      ok: true,
      deleted: {
        type: "event", id: ev.id, summary: ev.summary,
        calendar: calName,
      },
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
async function toolDeleteReminder(args: Record<string, unknown>, ctx: ToolContext) {
  const r = await getRowById("reminders", args.id);
  if (!r) return { error: `No reminder found with id ${args.id}.` };
  if (!(await confirmBeforeDelete(ctx, "reminder", r.id, r.title))) return DENIED;
  await deleteReminder(r.id);
  return { ok: true, deleted: { type: "reminder", id: r.id, title: r.title } };
}
async function toolDeleteNote(args: Record<string, unknown>, ctx: ToolContext) {
  const n = await getRowById("notes", args.id);
  if (!n) return { error: `No note found with id ${args.id}.` };
  if (!(await confirmBeforeDelete(ctx, "note", n.id, n.title ?? "(untitled)"))) return DENIED;
  await deleteNote(n.id);
  return { ok: true, deleted: { type: "note", id: n.id, title: n.title } };
}
async function toolDeletePerson(args: Record<string, unknown>, ctx: ToolContext) {
  const p = await getRowById("people", args.id);
  if (!p) return { error: `No person found with id ${args.id}.` };
  if (!(await confirmBeforeDelete(ctx, "person", p.id, p.full_name))) return DENIED;
  await deletePerson(p.id);
  return { ok: true, deleted: { type: "person", id: p.id, full_name: p.full_name } };
}

/**
 * Ask the user to approve a destructive delete.
 *
 * Returns true unless a confirmation UI is wired AND the user declined. With no
 * `onConfirmDelete` (a headless caller) it fails open to today's behaviour —
 * the server-side space-scoped authorisation remains the final backstop either
 * way. An already-aborted turn throws `AbortError` rather than resolving, so the
 * loop's existing abort handling ends the turn instead of acting on a stale
 * approval after the user hit Stop.
 */
async function confirmBeforeDelete(
  ctx: ToolContext,
  type: DeleteType,
  id: string,
  label: string,
  sub?: string,
): Promise<boolean> {
  if (ctx.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (!ctx.onConfirmDelete) return true;
  return ctx.onConfirmDelete({ type, id, label, sub });
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  // Only show_items uses this: it's how the chosen items reach the UI.
  emitItems?: (items: ItemRef[]) => void,
  // Per-turn context. Only the delete executors read it today (for the
  // confirmation gate); every other tool ignores it.
  ctx: ToolContext = {},
): Promise<unknown> {
  switch (name) {
    // read
    case "get_overview": return toolGetOverview();
    case "search_events": return toolSearchEvents(args);
    case "list_calendars": return toolListCalendars();
    case "search_reminders": return toolSearchReminders(args);
    case "search_notes": return toolSearchNotes(args);
    case "search_diary": return toolSearchDiary(args);
    case "get_diary_entry": return toolGetDiaryEntry(args);
    case "search_people": return toolSearchPeople(args);
    case "get_item": return toolGetItem(args);
    case "get_weather": return toolGetWeather(args);
    case "web_search": return toolWebSearch(args, ctx);
    case "list_mailboxes": return toolListMailboxes();
    case "search_mail": return toolSearchMail(args);
    case "get_message": return toolGetMessage(args, ctx);
    // presentation
    case "show_items": return toolShowItems(args, emitItems);
    // write
    case "create_event": return toolCreateEvent(args);
    case "update_event": return toolUpdateEvent(args);
    case "create_reminder": return toolCreateReminder(args);
    case "update_reminder": return toolUpdateReminder(args);
    case "create_note": return toolCreateNote(args);
    case "update_note": return toolUpdateNote(args);
    case "write_diary_entry": return toolWriteDiaryEntry(args);
    case "create_person": return toolCreatePerson(args);
    case "update_person": return toolUpdatePerson(args);
    case "add_tag": return toolAddTag(args);
    case "link_items": return toolLinkItems(args);
    case "unlink_items": return toolUnlinkItems(args);
    // delete — each goes through confirmBeforeDelete(ctx, …) before touching data
    case "delete_event": return toolDeleteEvent(args, ctx);
    case "delete_reminder": return toolDeleteReminder(args, ctx);
    case "delete_note": return toolDeleteNote(args, ctx);
    case "delete_diary_entry": return toolDeleteDiaryEntry(args, ctx);
    case "delete_person": return toolDeletePerson(args, ctx);
    default: return { error: `Unknown tool: ${name}` };
  }
}

// Human-readable status shown in the UI while a tool runs.
function statusFor(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "get_overview": return i18next.t("status.overview");
    case "search_events": return i18next.t("status.searchEvents");
    case "list_calendars": return i18next.t("status.listCalendars");
    case "search_reminders": return i18next.t("status.searchReminders");
    case "search_notes": return args.query ? i18next.t("status.searchNotesFor", { query: String(args.query) }) : i18next.t("status.searchNotes");
    case "search_diary": return args.query ? i18next.t("status.searchDiaryFor", { query: String(args.query) }) : i18next.t("status.searchDiary");
    case "get_diary_entry": return i18next.t("status.getDiaryEntry");
    case "search_people": return args.query ? i18next.t("status.searchPeopleFor", { query: String(args.query) }) : i18next.t("status.searchPeople");
    case "get_item": return i18next.t("status.getItem");
    case "get_weather": return i18next.t("status.weather");
    case "web_search": return args.query
      ? i18next.t("status.webSearchFor", { query: String(args.query) })
      : i18next.t("status.webSearch");
    case "list_mailboxes": return i18next.t("status.listMailboxes");
    case "search_mail": {
      const q = args.query ?? args.subject ?? args.from;
      return q
        ? i18next.t("status.searchMailFor", { query: String(q) })
        : i18next.t("status.searchMail");
    }
    case "get_message": return i18next.t("status.getMessage");
    case "show_items": return i18next.t("status.showItems");
    case "create_event": return i18next.t("status.createEvent");
    case "update_event": return i18next.t("status.updateEvent");
    case "create_reminder": return i18next.t("status.createReminder");
    case "update_reminder": return i18next.t("status.updateReminder");
    case "create_note": return i18next.t("status.createNote");
    case "update_note": return i18next.t("status.updateNote");
    case "write_diary_entry": return i18next.t("status.writeDiaryEntry");
    case "create_person": return i18next.t("status.createPerson");
    case "update_person": return i18next.t("status.updatePerson");
    case "add_tag": return i18next.t("status.addTag");
    case "link_items": return i18next.t("status.linkItems");
    case "unlink_items": return i18next.t("status.unlinkItems");
    case "delete_event": return i18next.t("status.deleteEvent");
    case "delete_reminder": return i18next.t("status.deleteReminder");
    case "delete_note": return i18next.t("status.deleteNote");
    case "delete_diary_entry": return i18next.t("status.deleteDiaryEntry");
    case "delete_person": return i18next.t("status.deletePerson");
    default: return i18next.t("status.working");
  }
}

const SYSTEM_PROMPT =
  "You are a helpful personal assistant embedded in a local life-management app called Sekunda. " +
  "You help the user with THEIR data — calendar events, reminders, notes, a dated diary (journal), people (contacts), and tags.\n\n" +
  "You can READ, WRITE, and DELETE data:\n" +
  "- Read/lookup tools: get_overview, search_events, list_calendars, search_reminders, search_notes, search_diary, get_diary_entry, search_people, get_item, get_weather.\n" +
  "- Create/update tools: create_event, update_event, create_reminder, " +
  "update_reminder, create_note, update_note, write_diary_entry, create_person, update_person, add_tag.\n" +
  "- Linking tools: link_items / unlink_items connect any two items (e.g. attach a person to an event, " +
  "or a note to a reminder). People are contacts with emails/phones/addresses, a birthday, and user-defined " +
  "custom_fields (label/value, e.g. 'Eye color: Blue').\n" +
  "- Delete tools: delete_event, delete_reminder, delete_note, delete_diary_entry, delete_person.\n" +
  "- The DIARY is a private journal keyed by day (one entry per date), separate from notes. Use the diary tools " +
  "for journaling ('what did I do last weekend', 'add to today's diary'); use write_diary_entry with a YYYY-MM-DD " +
  "date (default today). Diary entries can be shown as cards with show_items (type \"diary\", the id from a diary " +
  "search) just like any other item.\n" +
  "- Presentation: show_items displays items to the user as cards. Call it BEFORE writing a reply that talks " +
  "about specific items.\n\n" +
  "Calendars:\n" +
  "- The user may have several calendars: the built-in local one plus any Apple/iCloud calendars they have " +
  "connected. search_events covers every visible calendar at once, and you can view, edit and delete events in " +
  "all of them. Use list_calendars to see the names.\n" +
  "- New events go in the user's DEFAULT calendar unless they name a different one (\"put it in my Work " +
  "calendar\") — pass that name as the `calendar` argument to create_event. Don't ask which calendar for every " +
  "event; the default is the right answer unless they say otherwise.\n" +
  "- Events in connected calendars have no tags, links or attached people — those apply to the built-in " +
  "calendar only. If a tool reports `unavailable_calendars`, mention in passing that you couldn't reach that " +
  "calendar (\"I couldn't get to your Work calendar, but…\") rather than implying you saw the whole schedule.\n\n" +
  "Weather:\n" +
  "- get_weather answers for the ONE location the user set in Settings. You cannot look up another city; if " +
  "they ask about somewhere else, say so and point them at Settings.\n" +
  "- Always call it — never answer from memory, and never guess a forecast the tool didn't return.\n" +
  "- It covers one day per call and only about 90 days back and 14 days ahead.\n" +
  "- The forecast is not one of the user's items, so it never goes to show_items.\n\n" +
  "How to answer:\n" +
  "- Your replies are often read aloud by a text-to-speech voice, so write the way a person would SAY it: one " +
  "or two short sentences of ordinary prose.\n" +
  "- BUT keep numbers as digits — never spell them out as words. Phone numbers, times, dates, prices and codes " +
  "go in normal readable form (+1 555-010-2020, 3pm, $50, Jul 21), NOT \"plus one five five five…\". The " +
  "sentence around them can sound spoken; the number itself must be readable at a glance.\n" +
  "- NEVER use tables, bullet points, numbered lists, headings, or bold field labels like \"**Time:**\". Do not " +
  "recite an item's every field.\n" +
  "- Lead with the answer. Don't open with a preamble like \"You have the following events\" or \"Here is what I " +
  "found\" — just say it: \"You've got three things today — standup at nine thirty, then lunch with Sam.\"\n" +
  "- Mention the count and whatever actually matters (what's soon, what clashes, what's overdue). The cards " +
  "carry the details, so leave times, locations and ids out of the prose unless they're the point of the answer.\n" +
  "- Showing items is a SEPARATE STEP THAT COMES FIRST. Whenever your reply will talk about specific items, " +
  "call show_items with those items and write nothing else in that step; then write your reply, and the cards " +
  "will appear beneath it. If you looked something up because the user asked about it, show it — never describe " +
  "items without showing them.\n" +
  "- The cards appear on their own, so never announce them. Do not write \"let me show you the details\", " +
  "\"here they are\" or \"I'll pull those up\" — just answer, having already called show_items.\n" +
  "- When the user asks a yes/no or judgement question (\"am I free Thursday?\"), answer THAT question rather " +
  "than dumping the schedule you used to work it out.\n\n" +
  "Guidelines:\n" +
  "- ALWAYS look before answering. When the user asks anything about their own data — schedule, reminders, " +
  "notes, contacts, \"when/what/where/do I have…\", \"when should I…\" — search for it yourself in the " +
  "same turn, THEN answer. Never say you don't have the information, and never ask permission to look (\"Would " +
  "you like me to check?\") — just check. Only state that something doesn't exist after a search has actually " +
  "come back empty. A question that sounds like it could be general knowledge (\"when should I take my " +
  "vitamins?\") is almost always about the user's own reminder/note — search first.\n" +
  "- Note bodies may contain image references written as ![alt](sbimg:<id>). Those ids point at stored image " +
  "data — never invent one, and when rewriting a note with update_note, keep any existing reference exactly as " +
  "it is or the image is lost from the note. Read the alt text if it helps; don't read the reference aloud.\n" +
  "- A bare YouTube URL on its own line in a note body is an embedded video. Keep it on its own line and " +
  "unaltered when rewriting a note — turning it into [a labelled link](url) stops it playing.\n" +
  "- Never assume or invent data. To update, tag, link, or delete an " +
  "existing item, find its id with a search tool before calling the write/delete tool. To add one entry to a " +
  "person's array field (email/phone/custom field), fetch them with get_item first, then send the full merged list " +
  "to update_person.\n" +
  "- Prefer specific, filtered queries (by date range, tag, or keyword). If a tool reports `truncated: true`, " +
  "narrow your filters rather than assuming you've seen everything; if you still report a partial answer, say so " +
  "in passing (\"there are more, but the next few are…\").\n" +
  "- Before creating or updating, make sure the request is clear. If key details are ambiguous (which item, what " +
  "date/time), ask a brief clarifying question instead of guessing. For clearly-specified requests, just " +
  "do it.\n" +
  "- DELETION IS PERMANENT AND CANNOT BE UNDONE. Every delete tool shows the user a confirmation card with the exact " +
  "item, and ONLY runs if they click Delete — this is enforced for you, so you do not need to ask for separate " +
  "verbal confirmation before calling a delete tool. Just identify the right item and call the tool; the card is " +
  "the confirmation. Never delete more than the user asked for: when a request is broad or could match multiple " +
  "items, list what you found and delete them one at a time. If a delete returns { \"denied\": true }, the user " +
  "declined the card — stop, acknowledge that they cancelled, and do NOT retry the same delete.\n" +
  "- Interpret relative dates/times (\"tomorrow at 3pm\", \"next Friday\") against the current date, and pass concrete " +
  "ISO 8601 values to the tools.\n" +
  "- After making changes, confirm what you did in one short sentence (\"Added lunch with Sam tomorrow at one.\") " +
  "and show the item.";

/**
 * Appended to the system prompt only when web search is on, alongside the tool
 * schema — a rule about a tool the model hasn't been given is just tokens.
 *
 * It repeats the "don't" list from the schema on purpose. The schema is read
 * when the model is choosing a tool; this is read while it's deciding whether it
 * needs one at all, and the expensive mistake happens at that earlier point.
 */
const WEB_SEARCH_PROMPT =
  "\n\nWeb search:\n" +
  "- You have web_search, but treat it as a last resort: it is slow and each call costs the user money.\n" +
  "- Search ONLY for current real-world facts that cannot be in the user's data and that you cannot reliably " +
  "know: today's news, live prices or scores, opening hours, recent releases or results.\n" +
  "- Never search for the user's own events, reminders, notes or people; never for the weather " +
  "(get_weather covers it); never for stable general knowledge, arithmetic or dates; never merely to " +
  "double-check something you already know.\n" +
  `- At most ${MAX_WEB_SEARCHES} searches per turn. Prefer one.\n` +
  "- When you do search, say in passing where it came from (\"according to the BBC…\") so the user knows the " +
  "answer came off the web. Don't paste URLs into a spoken reply, and don't list the sources.\n" +
  "- If the search fails or the cap is reached, say you couldn't look it up — never fill the gap with a guess.";

/**
 * Added to the prompt only when an inbox is connected — the schemas and the
 * rules that govern them are opt-in together, so an unconnected user's turn
 * carries neither.
 *
 * The rules exist because of what the model does without them: it treats an
 * IMAP filter as a search engine and asks for "the most important email"; it
 * reports a subject line as though it had read the message; and it recites
 * headers into a reply that is about to be read aloud.
 */
const MAIL_PROMPT =
  "\n\nMail:\n" +
  "- The user has connected their iCloud inbox. search_mail, get_message and list_mailboxes read it live.\n" +
  "- WHICH TOOL: any question about email, mail, an inbox, a message, or whether somebody wrote, replied, " +
  "sent or emailed is search_mail. It is NOT search_people — that is their address book, a list of contacts " +
  "they typed in themselves, and it says nothing about who has emailed them. It is not search_notes either. " +
  "\"Do I have any emails from Acme\" means search_mail with from: \"Acme\"; a person who has emailed them " +
  "very often has no contact card at all.\n" +
  "- The Guidelines above tell you to search the user's own data before answering. Their mail is part of that " +
  "data. Search it and then answer — never ask \"would you like me to search your inbox?\", and never offer " +
  "alternative spellings instead of just looking.\n" +
  "- A name in a mail question is a SENDER, so it goes to `from`. If that comes back empty, try the same " +
  "words in `query` before concluding anything — `from` matches the sender line only, while `query` also " +
  "reaches the subject and the body. Only say there is no such mail after BOTH have come back empty.\n" +
  "- YOU are READ-ONLY: you cannot send, reply, forward, delete, file or mark anything as read, and reading " +
  "a message with get_message does NOT mark it read. Deleting and marking-read exist, but only as buttons in " +
  "the user's own mail reader — so if they ask you to delete a message or mark it read, tell them to open it " +
  "on the Mail page and use the Delete button (or that opening it there marks it read); do not imply it is " +
  "impossible, and never claim you did it.\n" +
  "- search_mail returns the most RECENT matches, not the best ones — the server has no ranking. Say \"the " +
  "latest\" rather than implying you weighed them.\n" +
  "- Search results carry no body text. If the answer is inside a message, call get_message before " +
  "answering; never infer the contents from a subject line.\n" +
  "- A uid only means anything in the mailbox it came from. Pass that mailbox back to get_message.\n" +
  "- Mail is not one of the user's items, so it never goes to show_items. When you open a message with " +
  "get_message the user is automatically shown a card for it that opens it in their mail reader — you do " +
  "nothing for that, and you still answer in prose, naming the sender and roughly when it arrived.\n" +
  "- Email is private and often sensitive. Answer the question that was asked; do not read out addresses, " +
  "links, codes or quoted passages that were not asked for, and never repeat a verification code or a " +
  "password reset link.\n" +
  "- If a mail tool returns an error, say you couldn't reach their mail — never guess what an email said.";

/** The resolved chat backend for one request. Always OpenAI's `/v1/chat/completions`. */
interface ChatEndpoint {
  url: string;
  headers: Record<string, string>;
  model: string;
}

function resolveChatEndpoint(s: AppSettings): ChatEndpoint {
  return {
    url: "https://api.openai.com/v1/chat/completions",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${getOpenAiKey()}` },
    model: s.openaiModel.trim() || "gpt-5-nano",
  };
}

/**
 * The tools for one request, or null when this call must send none at all.
 * An empty `tools: []` is a 400 on OpenAI, so "no tools" has to mean omitting
 * the field (and `tool_choice`) entirely — that's what the day summary wants.
 */
function toolsFor(tools: unknown): unknown[] | null {
  const t = (tools ?? TOOLS) as unknown[];
  return Array.isArray(t) && t.length === 0 ? null : t;
}

/**
 * The gpt-5 family rejects any `temperature` other than the default with a 400
 * ("Unsupported value"), so the field has to be *omitted*, not clamped to 1 —
 * and a hard 400 on every turn is what the model dropdown would otherwise ship.
 * The cost is that the card-recovery round can't cool to 0 on those models; it
 * still narrows the toolset, which is the load-bearing half.
 *
 * Note this is now the *default* path, since the default model is gpt-5-nano:
 * the 0.6 below is what a gpt-4* model gets, not what most turns run at. If
 * replies start reading stiff, that's the reason — fix it in the prompt's
 * "How to answer" block, which governs tone on every model.
 */
function supportsTemperature(model: string): boolean {
  return !/^gpt-5/.test(model.trim());
}

async function callChat(
  ep: ChatEndpoint,
  messages: OAIMessage[],
  // The card-recovery round narrows the toolset and cools the temperature; it's
  // a pure tool call, where sampling variety is the problem rather than the point.
  // onUsage reports this call's OpenAI token total so a conversation can tally
  // what it has spent. Every round of a turn (plus the card-recovery round) runs
  // through here, so a single hook makes the whole turn count itself.
  opts: { tools?: unknown; temperature?: number; signal?: AbortSignal; onUsage?: (totalTokens: number) => void } = {},
) {
  const tools = toolsFor(opts.tools);
  const res = await fetch(ep.url, {
    method: "POST",
    headers: ep.headers,
    body: JSON.stringify({
      model: ep.model,
      messages,
      ...(tools ? { tools, tool_choice: "auto" } : {}),
      // Warmer than the 0.2 this used when replies were data dumps: the prompt now
      // asks for natural spoken-sounding prose, which 0.2 renders stiff and formulaic.
      ...(supportsTemperature(ep.model) ? { temperature: opts.temperature ?? 0.6 } : {}),
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    let detail = "";
    try { const err = await res.json(); detail = err?.error?.message ?? JSON.stringify(err); }
    catch { detail = await res.text(); }
    throw new Error(i18next.t("errors.assistant", { status: res.status, detail }));
  }
  const data = await res.json();
  if (typeof data?.usage?.total_tokens === "number") opts.onUsage?.(data.usage.total_tokens);
  return data;
}

/** Just the show_items schema, for the recovery round below. */
const SHOW_ITEMS_TOOL = TOOLS.filter((t) => t.function.name === "show_items");

/**
 * Did this tool result contain something the user might want to see a card for?
 * Covers the read tools' `results`, get_item's `item`, and the create/update
 * tools' `{ ok, id }`.
 */
function returnedItems(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.results)) return r.results.length > 0;
  if (r.item) return true;
  return r.ok === true && typeof r.id === "string";
}

/**
 * Second chance at cards when the model wrote its reply without calling
 * show_items — which it still does maybe half the time, however the prompt is
 * worded, because writing prose and calling a tool compete for the same step.
 *
 * This asks *only* for the refs; the reply the user already has is never
 * regenerated, so a recovery round can't degrade the prose. Failures are
 * swallowed: cards are an enhancement, and a good answer must not be lost
 * because a cosmetic follow-up call failed.
 */
async function recoverItemCards(
  ep: ChatEndpoint,
  messages: OAIMessage[],
  emit: (items: ItemRef[]) => void,
  signal?: AbortSignal,
  onUsage?: (totalTokens: number) => void,
): Promise<void> {
  const ask: OAIMessage[] = [
    ...messages,
    {
      role: "system",
      content:
        "Your last reply went to the user without calling show_items, so no cards were displayed. If that " +
        "reply referred to specific items, call show_items now with exactly those items, using ids from the " +
        "tool results above. If it referred to no specific item, reply with the single word NONE.",
    },
  ];
  try {
    const data = await callChat(ep, ask, { tools: SHOW_ITEMS_TOOL, temperature: 0, signal, onUsage });
    const msg = data?.choices?.[0]?.message as OAIMessage | undefined;
    // The prompt asks the model to reply "NONE" when the answer referred to no
    // specific item — which arrives as plain content with no tool_calls, so the
    // loop below simply has nothing to iterate. Either outcome is fine: cards
    // only appear when the model actually calls show_items.
    for (const call of msg?.tool_calls ?? []) {
      if (call.function.name !== "show_items") continue;
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { continue; }
      await toolShowItems(args, emit);
    }
  } catch {
    /* no cards this turn; the answer still stands */
  }
}

export interface AskOptions {
  onStatus?: (text: string) => void;
  /**
   * Items the model chose to show, as they're chosen. A callback rather than a
   * return value so the refs still reach the UI if a later round throws.
   * May fire more than once per turn; treat each batch as an addition.
   */
  onItems?: (items: ItemRef[]) => void;
  /**
   * A message the assistant read in full this turn, so a card can be shown for
   * it. Fires once per `get_message`; may fire more than once a turn. Mail has
   * no `ItemRef` (no row to reload), so this carries the summary itself — the
   * same thing the Mail reader opens. A bare `search_mail` does not fire it.
   */
  onMail?: (msg: MailMessageSummary) => void;
  /** Abort the in-flight turn. Checked between rounds and passed to fetch. */
  signal?: AbortSignal;
  /**
   * OpenAI's `total_tokens` for each chat call this turn makes, as it makes them
   * — a turn can be several tool rounds plus a card-recovery round, so this fires
   * once per round. Treat each value as an addition to the running total.
   */
  onUsage?: (totalTokens: number) => void;
  /**
   * Gate every `delete_*` tool on explicit user approval. When set, the agentic
   * loop awaits this before each delete and only proceeds on `true`. This is the
   * defence against indirect prompt injection driving destructive calls: no
   * text in the model's context can authorise a delete — only the user can.
   *
   * The Promise MUST resolve for the turn to continue. A caller that aborts the
   * turn (Stop, unmount) is responsible for resolving it (typically `false`) so
   * the loop doesn't hang; `confirmBeforeDelete` also throws `AbortError` when
   * `signal` is already aborted, which the loop's existing handling catches.
   */
  onConfirmDelete?: (req: ConfirmDeleteRequest) => Promise<boolean>;
}

/**
 * Summarise the cards shown for one assistant turn into a note the model reads
 * on the next turn, so references like "it" / "that one" / "the lunch" resolve
 * to a concrete id without a fresh search.
 *
 * Labels are a best-effort *local* lookup — no network, since this runs on
 * every turn. A remote event resolves to "(untitled)" but still carries its
 * id/calendar_id/occurrence_start, which is what the model needs to act; the
 * user-facing title is also right there in the assistant's own prior text.
 */
async function shownItemsNote(items: ItemRef[]): Promise<string> {
  const lines = await Promise.all(items.map(async (it) => {
    let label = "";
    try {
      // Diary isn't an ItemType getItemLabel knows; its label is title-or-day.
      if (it.type === "diary") {
        const n = await getNote(it.id);
        label = n?.title?.trim() || n?.entry_date || "";
      } else {
        label = await getItemLabel(it.type, it.id);
      }
    } catch { /* best-effort */ }
    const parts = [`${it.type} "${label || "?"}"`, `id=${it.id}`];
    if (it.calendarId) parts.push(`calendar_id=${it.calendarId}`);
    if (it.occurrenceStart) parts.push(`occurrence_start=${it.occurrenceStart}`);
    if (it.diaryDate) parts.push(`date=${it.diaryDate}`);
    return `- ${parts.join(", ")}`;
  }));
  return (
    "[Cards shown to the user for the previous reply. If the user now refers to one without naming it " +
    "(\"it\", \"that\", \"the lunch one\"), resolve the reference to these ids rather than searching again. " +
    "The usual confirm-before-deleting rule still applies.]\n" + lines.join("\n")
  );
}

/**
 * Ask the assistant a question. Runs an agentic loop: the model may call
 * read-only tools (possibly several rounds) before producing a final answer.
 */
export async function askAssistant(history: ChatMessage[], opts: AskOptions = {}): Promise<string> {
  const settings = getSettings();
  const ep = resolveChatEndpoint(settings);
  if (!ep.model || !getOpenAiKey()) {
    throw new Error(i18next.t("errors.notConfigured"));
  }

  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  const localIso = format(now, "yyyy-MM-dd'T'HH:mm:ssXXX"); // e.g. 2026-07-20T14:30:00+08:00
  // Stated as a fact first and placed at the TOP of the system prompt. Buried at
  // the bottom and worded only as a scheduling rule, this was obeyed when
  // creating events yet ignored for arithmetic: asked a 1986 contact's age the
  // model answered from its training cutoff, not from today.
  const dateContext =
    `TODAY'S DATE IS ${format(now, "EEEE, MMMM d, yyyy")}. The current local time is ` +
    `${format(now, "h:mm a")} in the user's timezone (${tz}, ISO ${localIso}).\n` +
    `- Your training data ends well before today. You do NOT know what year it is from memory — the date ` +
    `above is the only correct source, and it overrides any sense you have of the current year.\n` +
    `- Use it for ALL date arithmetic: ages, \"how long ago\", \"how many days until\", whether something is ` +
    `past or upcoming. Someone born in 1986 is ${format(now, "yyyy")} minus 1986 years old, not the age you ` +
    `would guess.\n` +
    `- Interpret every date and clock time the user mentions (\"10am\", \"today\", \"tomorrow\", \"next Friday\", ` +
    `\"in 2 hours\") in this local timezone, using the correct current year.\n` +
    `- When passing datetimes to tools, write ISO 8601 with the user's local UTC offset (like ${localIso}). ` +
    `Do NOT use UTC or a trailing \"Z\" — that would save the event at the wrong hour.\n\n`;

  // Only role/content go to the model — never the UiMessage `items`. But an
  // assistant turn that showed cards gets a system note after it recording
  // which items those were, so the next user message can refer to them.
  // Both the schema and its prompt rules are opt-in together: off, this turn
  // carries neither, so the feature costs nothing to leave switched off.
  const webSearch = settings.webSearch;
  // Mail is gated on a connected account rather than a setting: the account IS
  // the opt-in, and there is nothing for the tools to read without one.
  const mail = hasMailAccount();
  const turnTools = [
    ...TOOLS,
    ...(webSearch ? WEB_SEARCH_TOOL : []),
    ...(mail ? MAIL_TOOLS : []),
  ];

  const messages: OAIMessage[] = [{
    role: "system",
    content: dateContext + SYSTEM_PROMPT + (webSearch ? WEB_SEARCH_PROMPT : "") + (mail ? MAIL_PROMPT : ""),
  }];
  for (const m of history) {
    messages.push({ role: m.role, content: m.content });
    if (m.role === "assistant" && m.items && m.items.length > 0) {
      messages.push({ role: "system", content: await shownItemsNote(m.items) });
    }
  }

  // Repeated last, next to the question being answered: the top-of-prompt copy
  // is a long way from the generation point once a conversation has some
  // history, and the current year is exactly what gets lost over that distance.
  messages.push({
    role: "system",
    content: `Reminder: today is ${format(now, "EEEE, MMMM d, yyyy")}. Base every date calculation on it.`,
  });

  // Tracked across rounds to decide whether the reply is missing its cards.
  let showedItems = false; // show_items ran and accepted at least one item
  let sawItems = false;    // some tool surfaced an item worth showing

  // Per-turn context for the tool executors. Today only the delete tools read
  // it: `onConfirmDelete` is the gate that pauses the loop until the user
  // approves, and `signal` lets a pending confirm throw AbortError on Stop.
  const toolCtx: ToolContext = {
    signal: opts.signal,
    onConfirmDelete: opts.onConfirmDelete,
    onUsage: opts.onUsage,
    onMail: opts.onMail,
    // Absent when the feature is off, which is what makes a model that invents
    // the tool name anyway get a clean "it's switched off" rather than a search.
    webSearchesLeft: webSearch ? { n: MAX_WEB_SEARCHES } : undefined,
  };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // A user cancel between rounds aborts cleanly rather than starting another
    // network call that will be thrown away.
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const data = await callChat(ep, messages, { tools: turnTools, signal: opts.signal, onUsage: opts.onUsage });
    const msg = data?.choices?.[0]?.message as OAIMessage | undefined;
    if (!msg) throw new Error(i18next.t("errors.emptyResponse"));

    messages.push(msg);

    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) {
      if (!msg.content) throw new Error(i18next.t("errors.emptyResponse"));
      // The model looked items up and then talked about them without showing
      // them. Ask once for just the refs, leaving the reply text alone.
      if (!showedItems && sawItems && opts.onItems) {
        opts.onStatus?.(statusFor("show_items", {}));
        await recoverItemCards(ep, messages, opts.onItems, opts.signal, opts.onUsage);
      }
      return msg.content;
    }

    // Execute each requested tool and feed results back.
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { /* leave empty */ }
      opts.onStatus?.(statusFor(call.function.name, args));
      let result: unknown;
      try { result = await executeTool(call.function.name, args, opts.onItems, toolCtx); }
      catch (e) { result = { error: e instanceof Error ? e.message : String(e) }; }
      // A show_items that rejected every id doesn't count — leave recovery open.
      if (call.function.name === "show_items") {
        if ((result as { ok?: boolean })?.ok) showedItems = true;
      } else if (returnedItems(result)) {
        sawItems = true;
      }
      messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: JSON.stringify(result) });
    }
  }

  throw new Error(i18next.t("errors.tooManySteps"));
}

// --- Daily summary (Today view) ----------------------------------------------
//
// Deliberately NOT the agentic loop. The Today view has already loaded exactly
// the day's data, so re-searching for it would cost several rounds to arrive at
// facts we're holding — this is one tool-free call that only turns a digest we
// build into prose. Everything the model would otherwise compute (overdue,
// ages, "in 3 days") is computed by the caller and handed over as a fact.

/** One day's facts, already resolved by the caller. Times are local-offset ISO. */
export interface DaySummaryInput {
  /**
   * The day being summarised, as `yyyy-MM-dd`. The Today view can step to any
   * date, so this is not necessarily today — the prompt uses it to choose past,
   * present or future tense, which the model gets wrong left to its own devices.
   */
  date: string;
  /** Occurrences falling on the day, in start order. */
  events: { title: string; start: string; all_day: boolean; location?: string | null }[];
  /** Reminders due on the day (or still open from before). */
  reminders: { title: string; due: string | null; overdue: boolean }[];
  /** Birthdays today and soon. `age` is the age they turn, computed in TS. */
  birthdays: { name: string; date: string; in_days: number; age: number | null }[];
  /**
   * That day's forecast, if a weather location is set and the day is within the
   * forecastable window. Condition text is English (see `englishCondition`) —
   * it goes to the model, not the screen.
   */
  weather?: {
    place: string;
    condition: string;
    high: number;
    low: number;
    unit: string;
    precipitation: number | null;
    /** Apparent temperature — often the one worth mentioning, not the air temp. */
    feels_like: number | null;
    /** US AQI, when the day is today and the reading came back. */
    air_quality: number | null;
  } | null;
}

/**
 * Does this day have anything at all worth summarising? Weather deliberately
 * doesn't count: the forecast has its own tile, and a briefing that exists only
 * to restate it would be a paid request to say what's already on screen.
 */
export function hasDayContent(input: DaySummaryInput): boolean {
  // Weather alone is enough: the briefing can stand on a forecast (it calls out
  // rain, storms, hot/cold days and air quality when those would change what
  // the user does), so an empty calendar on a sunny day still has something to
  // say. Without this, adding the assistant key on a quiet day made the card
  // vanish outright — the setup prompt it replaced had more presence than that.
  return (
    input.events.length > 0 || input.reminders.length > 0 ||
    input.birthdays.length > 0 || !!input.weather
  );
}

/** Model-facing clock time. Unlocalized on purpose, like every other prompt string. */
function digestTime(iso: string | null, allDay = false): string {
  if (allDay) return "all day";
  if (!iso) return "no time";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "no time" : format(d, "h:mm a");
}

/** The day's facts as compact lines. Empty sections are omitted, not sent as "none". */
function dayDigest(input: DaySummaryInput): string {
  const parts: string[] = [];
  if (input.events.length) {
    parts.push("EVENTS:\n" + input.events.map((e) =>
      `- ${e.title || "(untitled)"} at ${digestTime(e.start, e.all_day)}` +
      (e.location ? ` (${e.location})` : "")).join("\n"));
  }
  if (input.reminders.length) {
    parts.push("REMINDERS:\n" + input.reminders.map((r) =>
      `- ${r.title} at ${digestTime(r.due)}${r.overdue ? " [OVERDUE]" : ""}`).join("\n"));
  }
  if (input.birthdays.length) {
    parts.push("BIRTHDAYS:\n" + input.birthdays.map((b) => {
      // Relative to the day being described, not to today — the view can be
      // showing any date, so "TODAY" would be a lie on all the others.
      const when = b.in_days === 0
        ? "ON THIS DAY"
        : b.in_days === 1 ? "the day after" : `${b.in_days} days after this day`;
      // The age is given, never derived — the model reaches for its training
      // cutoff year the moment it has to subtract one (see dateContext).
      return `- ${b.name}, ${when}${b.age === null ? "" : `, turning ${b.age}`}`;
    }).join("\n"));
  }
  if (input.weather) {
    const w = input.weather;
    parts.push(
      `WEATHER in ${w.place}: ${w.condition}, high ${Math.round(w.high)}${w.unit}, ` +
      `low ${Math.round(w.low)}${w.unit}` +
      (w.precipitation === null ? "" : `, ${w.precipitation}% chance of precipitation`) +
      (w.feels_like === null ? "" : `, feels like ${Math.round(w.feels_like)}${w.unit}`) +
      (w.air_quality === null ? "" : `, air quality index ${Math.round(w.air_quality)} (US AQI)`),
    );
  }
  return parts.join("\n\n");
}

const DAY_SUMMARY_PROMPT =
  "You write a short briefing about ONE DAY for the user of a personal life-management app, from the data " +
  "below. It is displayed at the top of their Today page.\n\n" +
  "How to write it:\n" +
  "- Two or three sentences of ordinary prose, as if you were telling them over coffee. Under 60 words.\n" +
  "- NEVER use bullet points, lists, headings, tables or bold labels. Prose only.\n" +
  "- Lead with the shape of the day, then what matters most: what's first, what clashes, what's overdue, " +
  "whose birthday it is. Don't recite every item — the tiles below already list them.\n" +
  "- If there are no events, reminders or birthdays, the day is a quiet one: say so in a line, " +
  "and if weather is given treat it as the day's main thing rather than the usual 'mention only if it " +
  "matters' rule — a calm forecast is worth a sentence when there is nothing else on.\n" +
  "- Keep times and numbers as readable digits (9:30am, 3 reminders), never spelled out as words.\n" +
  "- If weather is given, mention it ONLY when it would change what they do — rain or snow, a storm, a " +
  "notably hot or cold day, poor air quality (US AQI over 100), or plans that look outdoor. Prefer the " +
  "feels-like temperature to the air temperature when they differ much, since that's what going outside " +
  "is actually like. Tie it to the day (\"take a coat for that 6pm walk\") instead of reciting a forecast, " +
  "and say nothing about ordinary weather; it has its own tile.\n" +
  "- Address the user as \"you\". No preamble like \"Here is your summary\" and no sign-off.\n" +
  "- Only use what's in the data. Never invent an item, a time, or a person.";

/**
 * One-paragraph briefing for the Today page.
 *
 * Callers should check `hasDayContent` first — a day with nothing in it (no
 * events, tasks, reminders, birthdays or forecast) has nothing to say and
 * shouldn't cost a request. Throws like any other assistant call; the Today
 * view treats a failure as "no summary" rather than an error banner, since this
 * is an enhancement over tiles that already show the same data.
 */
export async function summarizeDay(input: DaySummaryInput, signal?: AbortSignal): Promise<string> {
  const settings = getSettings();
  const ep = resolveChatEndpoint(settings);
  if (!ep.model || !getOpenAiKey()) {
    throw new Error(i18next.t("errors.notConfigured"));
  }

  const now = new Date();
  // The summary is user-facing, so unlike every other model-facing string here
  // it has to come back in the UI language.
  const lang = LANGUAGES.find((l) => l.code === currentLanguage());
  // Local midnight, not `new Date("yyyy-MM-dd")` — that parses as UTC and lands
  // on the previous day for anyone west of Greenwich.
  const day = new Date(`${input.date}T00:00:00`);
  const offsetDays = Math.round(
    (startOfDay(day).getTime() - startOfDay(now).getTime()) / 86400000,
  );
  // Which day is being described, and in what tense. The view can step to any
  // date, and a briefing about next Tuesday written in the present tense ("you
  // have standup at 9:30") reads as if it were happening now.
  const whichDay = offsetDays === 0
    ? "You are describing TODAY. Write in the present tense."
    : offsetDays === 1
      ? "You are describing TOMORROW, not today. Write in the future tense."
      : offsetDays === -1
        ? "You are describing YESTERDAY, not today. Write in the past tense."
        : offsetDays > 0
          ? `You are describing ${format(day, "EEEE, MMMM d, yyyy")}, which is ${offsetDays} days from ` +
            "today. Write in the future tense and name the day, since it is not today."
          : `You are describing ${format(day, "EEEE, MMMM d, yyyy")}, which is ${-offsetDays} days ago. ` +
            "Write in the past tense and name the day, since it is not today.";
  const messages: OAIMessage[] = [
    {
      role: "system",
      content:
        `TODAY IS ${format(now, "EEEE, MMMM d, yyyy")} and the time is now ${format(now, "h:mm a")}. ` +
        "Your training data ends well before today; the date above is the only correct source, and every " +
        "\"overdue\", age and day-count in the data has already been worked out for you — use them as given " +
        `and do no date arithmetic of your own.\n\n${whichDay}\n\n` +
        DAY_SUMMARY_PROMPT +
        `\n- Write the summary in ${lang?.nativeName ?? "English"}.`,
    },
    { role: "user", content: dayDigest(input) },
  ];

  const data = await callChat(ep, messages, { tools: [], temperature: 0.6, signal });
  const text = (data?.choices?.[0]?.message as OAIMessage | undefined)?.content;
  if (!text?.trim()) throw new Error(i18next.t("errors.emptyResponse"));
  return text.trim();
}
