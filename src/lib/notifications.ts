// Native OS notifications for due reminders.
//
// The desktop notification plugin has no reliable cross-platform "schedule this
// for later" API, so we poll from the running app: every minute we look for
// reminders whose alert time has passed and fire a notification once.
// Fully offline; no network involved.

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import i18next from "i18next";
import { listReminders } from "../db";
import { isTauri } from "./platform";

const CHECK_INTERVAL_MS = 60_000;
// Ids we've already notified this session, so we don't nag every minute.
const notified = new Set<string>();

/**
 * Clear the "already notified" memory.
 *
 * The demo reset wipes every reminder row and reseeds fresh ones, so any
 * id the poller remembers firing this session no longer refers to the same
 * item (and may not refer to any item). Without this, a reseeded reminder
 * sharing an id with one that already fired would silently never ring again
 * for the rest of the session.
 */
export function resetNotificationState(): void {
  notified.clear();
}

export async function ensureNotificationPermission(): Promise<boolean> {
  // Native notifications are a Tauri plugin whose IPC command doesn't exist on
  // the web build, so `isPermissionGranted()` throws ("Cannot read properties
  // of undefined (reading 'invoke')") there. Browsers can't offer this anyway;
  // report "granted" so the reminders view doesn't show a permission banner for
  // a feature that isn't applicable. Same guard `startReminderPoller` uses.
  if (!isTauri()) return true;
  let granted = await isPermissionGranted();
  if (!granted) {
    const perm = await requestPermission();
    granted = perm === "granted";
  }
  return granted;
}

async function checkDue(): Promise<void> {
  const granted = await isPermissionGranted();
  if (!granted) return;

  const now = Date.now();

  const reminders = await listReminders();
  for (const r of reminders) {
    if (r.completed) continue;
    const at = r.remind_at || r.due_at;
    if (!at) continue;
    const t = new Date(at).getTime();
    const key = `reminder:${r.id}:${at}`;
    if (t <= now && !notified.has(key)) {
      notified.add(key);
      sendNotification({ title: i18next.t("itemType.reminder"), body: r.title });
    }
  }
}

let timer: number | null = null;

/** Start the background poller. Safe to call once at app startup. */
export function startReminderPoller(): void {
  // Native notifications are a Tauri plugin. On the web build its IPC command
  // doesn't exist, so `isPermissionGranted()` would throw on every tick — an
  // unhandled rejection each minute, for a feature browsers can't offer anyway.
  if (!isTauri()) return;
  if (timer !== null) return;
  void checkDue();
  timer = window.setInterval(() => void checkDue(), CHECK_INTERVAL_MS);
}
