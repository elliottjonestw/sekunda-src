import { ICLOUD_IMAP, type MailCriteria, type MailOp, type MailOpResult } from "@secondbrain/shared";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../platform";
import { apiRequest, ApiError, OfflineError } from "../api";
import { getMailPassword } from "../secrets";
import type { MailAccount } from "../settings";
import { MailError } from "./types";

/**
 * The transport decision for mail, and the only place the mail password is read.
 *
 * It mirrors `caldav/client.ts` — the same two paths for the same reason — with
 * one difference that shapes everything else: IMAP is a stateful TCP protocol,
 * and neither a browser nor `tauri-plugin-http` can open a socket. So:
 *
 *   * **Desktop** invokes a custom Rust command (`imap_op`), which opens TLS to
 *     iCloud itself. Nothing touches our server. This is the only custom
 *     command in the app, and it exists because there was no plugin that could
 *     do it.
 *   * **Web** posts the same op envelope to the Worker's `/v1/mail` route,
 *     which speaks IMAP over `cloudflare:sockets`. The user's password and
 *     their mail pass through our Worker in plaintext — the same trade already
 *     accepted for connected calendars, and `worker/src/routes/mail.ts`
 *     documents what keeps it tolerable.
 *
 * The credential is read HERE and nowhere else, which is what lets a
 * `MailAccount` be passed around, serialized and put in localStorage without
 * carrying a secret with it.
 */

/** Everything about an op except who is asking — filled in below. */
export type MailRequest =
  | { op: "list" }
  | { op: "search"; mailbox: string; criteria: MailCriteria; limit: number }
  | { op: "headers"; mailbox: string; uids: number[] }
  | { op: "status"; mailbox: string }
  | { op: "fetch"; mailbox: string; uid: number }
  | { op: "part"; mailbox: string; uid: number; part: string }
  | { op: "mark_seen"; mailbox: string; uid: number; seen: boolean }
  | { op: "delete"; mailbox: string; uid: number; trash: string };

export async function imapCall(account: MailAccount, request: MailRequest): Promise<MailOpResult> {
  const password = getMailPassword();
  if (!password) {
    // Distinguished from a rejection on purpose: this is what signing out and
    // back in leaves behind (`clearSecrets` forgets the credential, the account
    // survives), and "wrong password" would send the user looking for the wrong
    // problem.
    throw new MailError("Your app-specific password isn't stored on this device. Enter it again in Settings.");
  }

  const op = {
    host: account.host || ICLOUD_IMAP.host,
    port: account.port || ICLOUD_IMAP.port,
    user: account.username,
    pass: password,
    ...request,
  } as MailOp;

  if (isTauri()) {
    // `invoke` is imported statically — unlike `tauri-plugin-http`, which
    // `httpFetch` must resolve at runtime. The difference is what the import
    // *does*: the plugin's module registers a fetch that silently exists and
    // then throws on the web, whereas `core.js` is already in the web bundle
    // (every Tauri plugin this app imports pulls it in) and `invoke` is only
    // reached inside this branch. A dynamic import here would buy nothing and
    // cost a build warning about a chunk that cannot be split.
    try {
      return await invoke<MailOpResult>("imap_op", { op });
    } catch (e) {
      // A command rejection arrives as a plain string, not an Error.
      throw new MailError(typeof e === "string" ? e : e instanceof Error ? e.message : "Could not reach the mail server.");
    }
  }

  try {
    return await apiRequest<MailOpResult>("/v1/mail", { method: "POST", body: op });
  } catch (e) {
    if (e instanceof OfflineError) {
      throw new MailError("You're offline. Mail is read live from iCloud, so it needs a connection.");
    }
    // The relay reports Apple's refusals as 400s carrying a usable message —
    // see the note in routes/mail.ts about why they are not 401s.
    if (e instanceof ApiError) throw new MailError(e.message);
    throw new MailError("Could not reach the mail server.");
  }
}
