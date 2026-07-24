import { sign, verify } from "hono/jwt";
import { randomBytes, sha256Base64, toBase64Url } from "./crypto";
import { unauthorized } from "../http";

/**
 * Access tokens are stateless JWTs; refresh tokens are opaque random strings
 * stored hashed in D1.
 *
 * The split is what keeps the free tier viable: verifying an access token is
 * an HMAC with no database round-trip, so the ~105 ms D1 hop is paid only on
 * the refresh path (every 15 minutes) rather than on every request.
 */

/** 15 minutes. Short enough that a leaked access token expires before it's
 *  much use; long enough that refreshes are rare. */
export const ACCESS_TTL_SECONDS = 15 * 60;

/** 60 days of inactivity before a device has to sign in again. Each refresh
 *  issues a new token with a new 60-day window, so an active device never
 *  gets logged out. */
const REFRESH_TTL_SECONDS = 60 * 24 * 60 * 60;

export interface AccessClaims {
  sub: string;
  exp: number;
}

/**
 * Pinned explicitly on both sign and verify.
 *
 * Verifying with whatever algorithm the token's own header claims is the
 * classic JWT failure — it lets an attacker re-sign a token under an algorithm
 * we never intended, `none` being the worst case. Naming it here means the
 * header is checked against our expectation rather than obeyed.
 */
const JWT_ALG = "HS256" as const;

export async function signAccessToken(secret: string, userId: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ACCESS_TTL_SECONDS;
  return sign({ sub: userId, exp }, secret, JWT_ALG);
}

/** Returns the user id, or throws `unauthorized`. */
export async function verifyAccessToken(secret: string, token: string): Promise<string> {
  try {
    const claims = (await verify(token, secret, JWT_ALG)) as unknown as AccessClaims;
    if (!claims?.sub) throw new Error("no subject");
    return claims.sub;
  } catch {
    // Deliberately opaque: expired, malformed and wrong-signature are all the
    // same to a caller, and distinguishing them tells an attacker which part
    // of a forged token to fix.
    throw unauthorized("Your session has expired. Sign in again.");
  }
}

export interface IssuedRefresh {
  token: string;
  sessionId: string;
  familyId: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  family_id: string;
  replaced_by: string | null;
  expires_at: string;
  revoked_at: string | null;
}

/** Issue a brand-new refresh token starting a new family (i.e. a fresh login). */
export async function createSession(
  db: D1Database,
  userId: string,
  deviceLabel: string | null,
): Promise<IssuedRefresh> {
  const draft = await draftSession(db, userId, crypto.randomUUID(), deviceLabel);
  await db.batch([draft.insert]);
  return draft.issued;
}

/** A session ready to insert but not yet written: the prepared INSERT, the
 *  plaintext token to return to the caller, and the id (which `rotateSession`
 *  binds into the consume UPDATE's `replaced_by` *before* running the insert).
 *
 *  `db` is needed only to build the prepared statement; nothing is written here.
 *  Split out of `createSession` so rotation can mint the replacement's id first,
 *  win the atomic consume, and only then commit the insert — see the docstring
 *  on `rotateSession` for why those two are sequenced rather than batched. */
async function draftSession(
  db: D1Database,
  userId: string,
  familyId: string,
  deviceLabel: string | null,
): Promise<{ insert: D1PreparedStatement; issued: IssuedRefresh; sessionId: string }> {
  const token = toBase64Url(randomBytes(32));
  const id = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + REFRESH_TTL_SECONDS * 1000);

  const insert = db
    .prepare(
      `INSERT INTO sessions (id, user_id, family_id, token_hash, device_label,
                             expires_at, created_at, last_used_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .bind(
      id, userId, familyId, await sha256Base64(token), deviceLabel,
      expires.toISOString(), now.toISOString(), now.toISOString(),
    );

  return { insert, issued: { token, sessionId: id, familyId }, sessionId: id };
}

/**
 * Exchange a refresh token for a new one, rotating it.
 *
 * Rotation gives theft detection for free. Each token is single-use: once
 * exchanged, its row records `replaced_by`. If a token that has already been
 * rotated is presented again, there are two copies in circulation — the
 * legitimate device and an attacker — and there is no way to tell which is
 * which. The safe response is to revoke the whole family, forcing a real
 * sign-in that the attacker cannot complete without the password.
 *
 * The consume is a single conditional UPDATE ... RETURNING, so two requests
 * racing on the same token cannot both win: the second UPDATE matches no rows.
 * This is the same atomic shape `consumePasswordReset` and
 * `consumeEmailVerification` use for the same reason — a SELECT-then-check-
 * then-write here would let both racers observe `replaced_by IS NULL` before
 * either wrote, minting two sessions and never tripping the reuse detector.
 *
 * The replacement is inserted only *after* the consume wins, never batched with
 * it. A batch runs every statement regardless of whether the conditional
 * UPDATE matched, so batching would insert a working orphan token on a lost
 * race — exactly the double-issue the rotation exists to prevent. The cost of
 * sequencing is a crash window: if the process dies between the consume and
 * the insert, the old token is spent and no replacement was issued, so the
 * device has to sign in again. That is the safe direction — a one-time
 * annoyance beats a second session that defeats theft detection.
 */
export async function rotateSession(
  db: D1Database,
  presentedToken: string,
): Promise<{ refresh: IssuedRefresh; userId: string }> {
  const hash = await sha256Base64(presentedToken);

  // First, the cases that need to READ the row before deciding: an unknown
  // token (no row) and a presented-again token (reuse). The atomic UPDATE below
  // cannot distinguish "this token was just consumed by the winner of the race"
  // from "this token never existed" — both match zero rows — so reuse detection
  // needs a lookup of its own.
  const lookedUp = await db
    .prepare(
      "SELECT id, user_id, family_id, replaced_by, revoked_at FROM sessions WHERE token_hash = ?",
    )
    .bind(hash)
    .first<SessionRow>();

  if (!lookedUp) throw unauthorized("Session not recognised. Sign in again.");

  if (lookedUp.replaced_by || lookedUp.revoked_at) {
    await revokeFamily(db, lookedUp.family_id);
    throw unauthorized("Session reuse detected. All sessions were signed out.");
  }

  // Mint the replacement's id/token up front so its id can be written into the
  // consume UPDATE's `replaced_by`. The INSERT is held back until the consume
  // wins — see the docstring for why this is sequenced, not batched.
  const draft = await draftSession(db, lookedUp.user_id, lookedUp.family_id, null);
  const now = new Date();

  // The race is decided here, atomically: `WHERE replaced_by IS NULL AND
  // revoked_at IS NULL` means the loser of two concurrent rotations matches no
  // rows. `expires_at > ?` folds the expiry check into the same atomic decision
  // so an expiry that laps between the lookup above and this write can't mint a
  // session off a now-expired token. `RETURNING` carries the winner's data back
  // without a second read.
  const consumed = await db
    .prepare(
      `UPDATE sessions
          SET replaced_by = ?, last_used_at = ?
        WHERE id = ? AND replaced_by IS NULL AND revoked_at IS NULL AND expires_at > ?
        RETURNING user_id`,
    )
    .bind(draft.sessionId, now.toISOString(), lookedUp.id, now.toISOString())
    .first<{ user_id: string }>();

  if (!consumed) {
    // We lost the race. The token was consumed, revoked, or expired between the
    // lookup and the UPDATE. The lookup already ruled out a prior reuse, so the
    // realistic cause is a concurrent rotation winning the race; either way the
    // safe answer is "sign in again" rather than issuing a second replacement.
    throw unauthorized("Your session has expired. Sign in again.");
  }

  // Won the race — now the replacement can be issued. Its row already has a
  // parent pointing at it (`replaced_by` above), so this completes the chain.
  await db.batch([draft.insert]);
  return { refresh: draft.issued, userId: consumed.user_id };
}

export async function revokeFamily(db: D1Database, familyId: string): Promise<void> {
  await db
    .prepare("UPDATE sessions SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL")
    .bind(new Date().toISOString(), familyId)
    .run();
}

/** Sign out one device. Unknown tokens succeed silently — logout must not
 *  double as a probe for whether a token is valid. */
export async function revokeByToken(db: D1Database, presentedToken: string): Promise<void> {
  const hash = await sha256Base64(presentedToken);
  const row = await db
    .prepare("SELECT family_id FROM sessions WHERE token_hash = ?")
    .bind(hash)
    .first<{ family_id: string }>();
  if (row) await revokeFamily(db, row.family_id);
}
