// ICS import/export. We use `ical-generator` for export and `ical.js` for
// import — never a hand-rolled iCalendar parser. Because our schema already
// stores RFC 5545 fields (UID, DTSTART, RRULE, SEQUENCE, ...), export is a
// near-direct field mapping, which is the point: it proves the schema is
// standards-compliant and ready for CalDAV sync later.

import ical, { ICalEventStatus } from "ical-generator";
import ICAL from "ical.js";
import i18next from "i18next";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import type { EventRow } from "../types";
import { listEvents, upsertEventWithId, newId, nowIso } from "../db";
import { allDayIso } from "./format";

function mapStatus(status: string): ICalEventStatus | undefined {
  switch (status?.toUpperCase()) {
    case "CONFIRMED": return ICalEventStatus.CONFIRMED;
    case "TENTATIVE": return ICalEventStatus.TENTATIVE;
    case "CANCELLED": return ICalEventStatus.CANCELLED;
    default: return undefined;
  }
}

/** Build an iCalendar string from all events. */
export function eventsToIcs(events: EventRow[]): string {
  const cal = ical({ name: "Sekunda", prodId: { company: "secondbrain", product: "app" } });

  for (const ev of events) {
    const start = new Date(ev.dtstart);
    const end = ev.dtend ? new Date(ev.dtend) : undefined;

    const e = cal.createEvent({
      id: ev.id, // becomes UID
      start,
      end,
      allDay: ev.all_day === 1,
      summary: ev.summary,
      description: ev.description ?? undefined,
      location: ev.location ?? undefined,
      sequence: ev.sequence,
      status: mapStatus(ev.status),
      created: ev.created_at ? new Date(ev.created_at) : undefined,
      lastModified: ev.updated_at ? new Date(ev.updated_at) : undefined,
    });

    if (ev.rrule) {
      const raw = ev.rrule.startsWith("RRULE:") ? ev.rrule : `RRULE:${ev.rrule}`;
      e.repeating(raw);
    }
    if (ev.categories) {
      try {
        const cats = JSON.parse(ev.categories) as string[];
        if (cats.length) e.categories(cats.map((name) => ({ name })));
      } catch { /* ignore malformed categories */ }
    }
  }

  return cal.toString();
}

/** Export all events to a .ics file chosen via the native save dialog. */
export async function exportCalendar(): Promise<string | null> {
  const events = await listEvents();
  const ics = eventsToIcs(events);
  const path = await save({
    title: i18next.t("calendar.exportTitle"),
    defaultPath: "second-brain.ics",
    filters: [{ name: "iCalendar", extensions: ["ics"] }],
  });
  if (!path) return null;
  await writeTextFile(path, ics);
  return path;
}

/**
 * Import events from a user-selected .ics file. Existing events with a matching
 * UID are updated; new UIDs are inserted. Returns the number imported.
 */
export async function importCalendar(): Promise<number> {
  const path = await open({
    title: i18next.t("calendar.importIcs"),
    multiple: false,
    filters: [{ name: "iCalendar", extensions: ["ics"] }],
  });
  if (!path || Array.isArray(path)) return 0;
  const text = await readTextFile(path);
  return importIcsText(text);
}

/** Parse an ICS string with ical.js and upsert its VEVENTs. Exported for tests. */
export async function importIcsText(text: string): Promise<number> {
  const jcal = ICAL.parse(text);
  const comp = new ICAL.Component(jcal);
  const vevents = comp.getAllSubcomponents("vevent");
  let count = 0;

  for (const ve of vevents) {
    const ev = new ICAL.Event(ve);
    const uid = ev.uid || undefined;
    const isAllDay = ev.startDate?.isDate ?? false;

    const rruleProp = ve.getFirstPropertyValue("rrule");
    const rrule = rruleProp ? (rruleProp as any).toString() : null;

    // All-day values are floating wall dates (timezone-independent); timed
    // values are absolute instants. `isDate` distinguishes them per property.
    const pad = (n: number) => String(n).padStart(2, "0");
    const icalIso = (t: any): string =>
      t?.isDate ? allDayIso(`${t.year}-${pad(t.month)}-${pad(t.day)}`) : t.toJSDate().toISOString();

    const exdateProps = ve.getAllProperties("exdate");
    const exdates = exdateProps.map((p) => icalIso(p.getFirstValue()));

    const categories = ve
      .getAllProperties("categories")
      .flatMap((p) => p.getValues() as string[]);

    // Preserve the incoming UID as the primary key (stable for CalDAV);
    // mint one only if the file omitted it.
    const id = uid || newId();

    await upsertEventWithId(id, {
      summary: ev.summary || i18next.t("common.untitledParen"),
      description: ev.description || null,
      location: ev.location || null,
      dtstart: ev.startDate ? icalIso(ev.startDate) : nowIso(),
      dtend: ev.endDate ? icalIso(ev.endDate) : null,
      all_day: isAllDay ? 1 : 0,
      rrule,
      exdates: exdates.length ? JSON.stringify(exdates) : null,
      status: (ve.getFirstPropertyValue("status") as string) || "CONFIRMED",
      categories: categories.length ? JSON.stringify(categories) : null,
      color: null,
    });
    count++;
  }

  return count;
}
