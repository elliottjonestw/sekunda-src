import { MAIL_MAX_ATTACHMENT_BYTES } from "@secondbrain/shared";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import type { MailAccount } from "../settings";
import { isTauri } from "../platform";
import { imapCall } from "./client";
import { decodePartBytes } from "./mime";
import { MailError, type MailAttachment } from "./types";

/**
 * Saving one attachment — the only thing this feature does that isn't reading.
 *
 * Except that it *is* reading: fetching a part is `BODY.PEEK` on a subsection
 * of a message, the same command shape the body already uses. The read-only
 * guarantee is a property of the connection (EXAMINE, PEEK) rather than of the
 * op list, so adding this does not touch it. There is still no write path.
 *
 * **Both platforms behind one function**, so `MailView` never branches on
 * platform — the same rule `httpFetch.ts` follows and for the same reason: a
 * view that knows which runtime it is in accumulates more of them.
 *
 * Nothing is fetched until this is called. The size shown next to a chip comes
 * off BODYSTRUCTURE, so the user chooses with the real number in front of them
 * rather than after a download has already happened.
 */

/**
 * The Tauri plugins are imported statically, which is safe HERE and is not safe
 * for `plugin-http`.
 *
 * The difference is what the import *does*. Importing `plugin-http` installs a
 * `fetch` that exists on the web and throws on every call, which is why
 * `httpFetch.ts` resolves it at runtime. `plugin-dialog` and `plugin-fs` only
 * export functions that invoke an IPC command, and the invoke is what fails —
 * so as long as the call sites stay inside `isTauri()`, the web bundle carries
 * two unreachable functions and nothing more. `ics.ts` and `backup.ts` already
 * do exactly this.
 */
async function writeToDisk(filename: string, bytes: Uint8Array): Promise<boolean> {
  if (isTauri()) {
    const path = await save({ defaultPath: filename });
    if (!path) return false; // the user cancelled the dialog; not a failure
    await writeFile(path, bytes);
    return true;
  }

  // The browser has no file system, so the download is an anchor click. The
  // object URL is revoked immediately after: it pins the whole blob in memory
  // until it is, and this blob can be ten megabytes.
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
  return true;
}

/**
 * A filename safe to hand to a save dialog or a `download` attribute.
 *
 * The name comes from the message, which means it comes from whoever sent it.
 * Path separators are the thing that matters — a `filename` of `../../.bashrc`
 * is a real attempt at a real bug — and the leading dots go with them so a
 * traversal can't be rebuilt from what's left. The user still sees and confirms
 * the final name in the native dialog on desktop.
 */
function safeFilename(name: string | null, contentType: string): string {
  const fallback = `attachment.${contentType.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin"}`;
  const cleaned = (name ?? "")
    .replace(/[/\\]/g, "_")
    .replace(/^\.+/, "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .slice(0, 180);
  return cleaned || fallback;
}

/**
 * Fetch one attachment and save it. Returns false if the user cancelled.
 *
 * Refuses rather than truncates, in both places it can: ahead of the request
 * using the size the structure reported, and again after it if the executor
 * says the read hit its cap. A file cut short is a corrupted file that looks
 * like a saved one, which is worse than an error — the user finds out when they
 * try to open it, long after they could have done anything about it.
 */
export async function saveAttachment(
  account: MailAccount,
  mailbox: string,
  uid: number,
  attachment: MailAttachment,
): Promise<boolean> {
  if (!attachment.part) {
    // No part number: the server described this message in a way the structure
    // parser could not read, so there is nothing to ask it for.
    throw new MailError("This attachment can't be downloaded — the mail server didn't describe where it is.");
  }
  if ((attachment.size ?? 0) > MAIL_MAX_ATTACHMENT_BYTES) {
    throw new MailError(
      "This attachment is too large to download here. Open it in Mail or on iCloud.com.",
    );
  }

  const result = await imapCall(account, { op: "part", mailbox, uid, part: attachment.part });
  if (result.op !== "part") throw new MailError("The mail server answered the wrong question.");
  if (result.truncated) {
    throw new MailError(
      "This attachment is too large to download here. Open it in Mail or on iCloud.com.",
    );
  }

  const bytes = decodePartBytes(result.body, attachment.encoding);
  if (bytes.length === 0) {
    throw new MailError("That attachment came back empty.");
  }
  return writeToDisk(safeFilename(attachment.filename, attachment.content_type), bytes);
}
