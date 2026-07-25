import { Hono } from "hono";
import { mailOpSchema, ICLOUD_IMAP } from "@secondbrain/shared";
import type { AppEnv } from "../env";
import { badRequest } from "../http";
import { requireAuth } from "../middleware/auth";
import { enforceRateLimit } from "../rateLimit";
import { ImapError, runImapOp } from "../imap";

/**
 * An IMAP relay for the WEB build only. The desktop app never touches this —
 * `src-tauri/src/mail.rs` opens its own TLS socket to iCloud from Rust, so on
 * desktop nothing about the user's mail passes through our infrastructure.
 *
 * Unlike `/v1/dav` this is NOT a pass-through: IMAP is a stateful socket
 * protocol, not a request/response one, so there is no upstream request to
 * forward. The Worker is a full IMAP client (`../imap.ts`) that the browser
 * drives one op at a time.
 *
 * ---------------------------------------------------------------------------
 * PRIVACY: READ THIS BEFORE EXTENDING IT
 * ---------------------------------------------------------------------------
 * Every request through here carries the user's **iCloud app-specific password**
 * and returns **the contents of their email**. TLS terminates at this Worker, so
 * both are visible to it in memory. Email is the more sensitive of the two
 * relays this app runs — a calendar says where you will be, an inbox says
 * everything else, including the password-reset links for every other service
 * the person uses.
 *
 * That trade was accepted so mail works in the browser at all, on the same
 * terms as `routes/dav.ts`, and every property that makes it tolerable is
 * copied from there and must be preserved:
 *
 *   - **Nothing is stored.** No D1 write, no KV write, and above all no
 *     logging. `[observability]` is on in wrangler.toml: a single
 *     `console.log` of a request or a response here would put the credential
 *     and the mail into Cloudflare's log retention. Errors are re-raised as
 *     flat messages for the same reason — never with the op attached.
 *   - **It is not an open relay.** A session is required, and the host must be
 *     iCloud's IMAP endpoint on its own port. Without that check this is an
 *     SSRF tool with a socket API, which is strictly worse than one with
 *     `fetch`: it can reach non-HTTP services on any port.
 *   - **Reads are read-only at the protocol level; writes are a small named set.**
 *     Read ops open mailboxes with EXAMINE and fetch with BODY.PEEK, so the
 *     server refuses any mutation on those paths regardless of this code. The
 *     write ops, added deliberately for the reader UI, are `mark_seen`
 *     (`UID STORE \Seen`), `delete` (`UID MOVE` to Trash, or an expunge from
 *     Trash) and `move` (`UID MOVE` to a named folder — Move to Junk today).
 *     Each issues exactly one constrained mutation and takes no arbitrary flag or
 *     command from the caller. There is still no send path, and the assistant
 *     builds none of these ops. Adding another write is a deliberate change, not
 *     an extension.
 *   - **It is rate-limited per user** (`MAIL_LIMIT`), keyed by user id rather
 *     than IP because identity exists here. One op is one TLS handshake and one
 *     round-trip to Apple; the budget is set well above reading a mailbox and
 *     well below anything that could grind an Apple account into a lockout.
 *
 * Known hardening still owed, same as the calendar relay: the credential lives
 * in the browser's localStorage on the published origin, where any XSS reads
 * it. The relay does not change that, and the web build's CSP is what narrows
 * it.
 */
export const mail = new Hono<AppEnv>();

mail.use("/mail", requireAuth());

/** Only iCloud's IMAP endpoint, on its own port. The single check that stops
 *  this being a general-purpose socket for anyone with a session. */
function isAllowedTarget(host: string, port: number): boolean {
  return host.toLowerCase() === ICLOUD_IMAP.host && port === ICLOUD_IMAP.port;
}

mail.post("/mail", async (c) => {
  // Ahead of parsing and ahead of the socket, so a refused request never puts
  // the credential on the wire.
  await enforceRateLimit(
    c.env.MAIL_LIMIT,
    `mail:${c.get("userId")}`,
    "Too many mail requests. Wait a moment and try again.",
  );

  const parsed = mailOpSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw badRequest("Expected a mail op { host, port, user, pass, op, … }.");
  const op = parsed.data;

  if (!isAllowedTarget(op.host, op.port)) throw badRequest("That mail server is not relayed.");

  try {
    return c.json(await runImapOp(op));
  } catch (e) {
    // Deliberately not logged, and deliberately not wrapped with any of the op:
    // the message a caller sees is the whole of what leaves this function.
    //
    // A REJECTED IMAP SIGN-IN IS A 400, NOT A 401. `lib/api.ts` treats 401 as
    // "our access token lapsed": it refreshes and replays the request. On this
    // route that would silently attempt the same bad password against Apple a
    // second time — the fastest way to walk an Apple ID into a lockout — and
    // present it to the user as a session problem. Apple's rejection is a fact
    // about the request body, which is exactly what 400 means here.
    if (e instanceof ImapError) throw badRequest(e.message);
    throw badRequest("Could not reach the mail server.");
  }
});
