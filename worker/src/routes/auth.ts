import { Hono } from "hono";
import {
  DEFAULT_KDF_PARAMS,
  deleteAccountSchema,
  forgotPasswordSchema,
  kdfChallengeSchema,
  loginSchema,
  normalizeEmail,
  normalizeKey,
  refreshSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  type KdfChallenge,
  type KdfParams,
  type RegisterResult,
  type Session,
  type TokenPair,
} from "@secondbrain/shared";
import type { AppEnv, Bindings } from "../env";
import { ApiError, badRequest, conflict, unauthorized } from "../http";
import {
  computeVerifier,
  decoyKdfSalt,
  randomBytes,
  timingSafeEqual,
  toBase64,
} from "../auth/crypto";
import {
  ACCESS_TTL_SECONDS,
  createSession,
  revokeByToken,
  rotateSession,
  signAccessToken,
} from "../auth/tokens";
import {
  assertNotLocked,
  clearBucket,
  clientIp,
  emailBucket,
  ipBucket,
  recordFailure,
} from "../auth/throttle";
import {
  createUserWithSpace,
  findUserByEmail,
  findUserById,
  listMemberships,
  type UserRow,
} from "../db/users";
import { seedWelcomeStatements } from "../db/onboarding";
import {
  applyNewPassword,
  consumeEmailVerification,
  consumePasswordReset,
  issueEmailVerification,
  issuePasswordReset,
} from "../db/recovery";
import { deleteAccount } from "../db/account";
import { deleteNoteImageBlobs } from "../db/images";
import {
  EmailNotConfigured,
  MailBudgetExhausted,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "../auth/email";
import { enforceRateLimit } from "../rateLimit";
import {
  turnstileRequired,
  turnstileRequiredForRegister,
  verifyTurnstile,
} from "../auth/turnstile";
import { requireAuth } from "../middleware/auth";

export const auth = new Hono<AppEnv>();

/**
 * The message every IP-keyed limiter on this router returns.
 *
 * One string for all of them, and deliberately vague. These endpoints are the
 * ones that must not leak: a 429 whose wording differs between "the address
 * you asked about" and "the address you came from" tells a caller which bucket
 * they filled, and on an endpoint like `/auth/kdf` — which answers for every
 * address precisely so membership can't be tested — that would hand back the
 * oracle the decoy salt exists to deny.
 */
const TOO_MANY = "Too many attempts. Wait a minute and try again.";

/** Secrets are typed optional so M0 could deploy before they existed. From
 *  here on their absence is a deployment fault, not a request fault. */
function requireSecret(env: Bindings, name: "JWT_SECRET" | "AUTH_PEPPER"): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not configured for this environment`);
  return v;
}

async function sessionFor(db: D1Database, user: UserRow): Promise<Session> {
  return {
    user: {
      id: user.id,
      email: user.email,
      created_at: user.created_at,
      email_verified: user.email_verified_at !== null,
    },
    spaces: await listMemberships(db, user.id),
  };
}

async function issueTokens(
  env: Bindings,
  user: UserRow,
  deviceLabel: string | null,
): Promise<TokenPair> {
  const refresh = await createSession(env.DB, user.id, deviceLabel);
  return {
    access_token: await signAccessToken(requireSecret(env, "JWT_SECRET"), user.id),
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refresh.token,
    session: await sessionFor(env.DB, user),
  };
}

/**
 * Step 1 of login: the KDF parameters for an address.
 *
 * Answers for every address, including ones with no account — a 404 here would
 * let anyone test an email list for membership. Unknown addresses get a decoy
 * salt derived deterministically from the address, so repeat probes agree with
 * each other the way a real account's would.
 *
 * The response is genuinely public information: the salt and parameters are
 * needed by any client before it can derive anything, which is why the stored
 * verifier has its own separate, server-generated salt.
 */
auth.post("/auth/kdf", async (c) => {
  const { email } = kdfChallengeSchema.parse(await c.req.json());
  const emailNorm = normalizeEmail(email);

  // Keyed by IP, never by the address asked about: a per-address key here
  // would make the limiter itself an enumeration oracle, since a caller could
  // tell a hot bucket from a cold one. This endpoint had no limit of any kind,
  // and it is a D1 read that anyone can call without an account.
  await enforceRateLimit(c.env.AUTH_LIMIT, `kdf:${clientIp(c.req.raw)}`, TOO_MANY);

  const user = await findUserByEmail(c.env.DB, emailNorm);
  if (user) {
    return c.json<KdfChallenge>({
      kdf_salt: user.kdf_salt,
      kdf_params: JSON.parse(user.kdf_params) as KdfParams,
    });
  }
  return c.json<KdfChallenge>({
    kdf_salt: await decoyKdfSalt(requireSecret(c.env, "AUTH_PEPPER"), emailNorm),
    kdf_params: DEFAULT_KDF_PARAMS,
  });
});

/**
 * Create an account and its personal space.
 *
 * The client generates its own KDF salt here rather than fetching one, which
 * keeps registration to a single round-trip. A client choosing a poor salt only
 * weakens its own account, and the server-generated `verifier_salt` guarantees
 * per-user uniqueness at the layer that is actually stored.
 */
auth.post("/auth/register", async (c) => {
  const body = registerSchema.parse(await c.req.json());
  const emailNorm = normalizeEmail(body.email);
  const pepper = requireSecret(c.env, "AUTH_PEPPER");

  const ip = clientIp(c.req.raw);

  // Three defences stack on this endpoint, and they are not redundant — each
  // catches what the others structurally cannot:
  //
  //   1. REGISTER_LIMIT, below. Absorbs a burst in-colo for about a
  //      millisecond, before any D1 read or argon2 work happens. Cannot bound
  //      anything longer than a minute.
  //   2. Turnstile, now required regardless of Origin. Costs a bot a real
  //      challenge per account rather than an HTTP request.
  //   3. The daily mail budget inside sendEmail. The only one of the three
  //      that can actually protect a per-day provider quota.
  //
  // `assertNotLocked` is NOT one of them, despite appearances: it only reads
  // locks that `recordFailure` sets, and nothing on a successful registration
  // ever records a failure. It is retained because a client already locked out
  // for password guessing should not be able to pivot to making accounts.
  await enforceRateLimit(c.env.REGISTER_LIMIT, `reg:${ip}`, TOO_MANY);
  // Registration also draws on the shared per-minute MAIL budget, the same one
  // /auth/password/forgot and the resend endpoints spend. It is charged here,
  // before the account exists, rather than next to the waitUntil below: by the
  // time the mail is queued the user has been created, and refusing then would
  // 429 a registration that actually succeeded.
  await enforceRateLimit(c.env.EMAIL_LIMIT, `register-ip:${ip}`, TOO_MANY);
  await assertNotLocked(c.env.DB, [ipBucket(ip)]);

  // Bot check, before the expensive verifier hash. Required for EVERY origin
  // here, unlike login — a caller that sends no Origin header is the exact
  // shape of the abuse this endpoint attracts, so exempting it would exempt
  // the attacker. See turnstileRequiredForRegister for the desktop caveat and
  // the TURNSTILE_ALLOW_NATIVE escape hatch. Skipped entirely when
  // TURNSTILE_SECRET_KEY is unset.
  if (turnstileRequiredForRegister(c.env, c.req.raw)) {
    const ok = await verifyTurnstile(c.env.TURNSTILE_SECRET_KEY!, body.turnstile_token, c.req.raw);
    if (!ok) throw badRequest("Captcha check failed. Please try again.");
  }

  // Registration DOES reveal whether an address is taken. That is unavoidable
  // — the account cannot be created — and it is the one place where the
  // enumeration trade-off falls the other way, because silently succeeding
  // would strand the user with an account they cannot access.
  if (await findUserByEmail(c.env.DB, emailNorm)) {
    throw conflict("An account with that email already exists.");
  }

  const verifierSalt = toBase64(randomBytes(16));
  let verifierHash: string;
  try {
    verifierHash = await computeVerifier(pepper, verifierSalt, body.derived_key);
  } catch {
    throw badRequest("derived_key must be valid base64.");
  }

  const spaceId = crypto.randomUUID();
  const user: UserRow = {
    id: crypto.randomUUID(),
    email: normalizeKey(body.email),
    email_norm: emailNorm,
    kdf_salt: body.kdf_salt,
    kdf_params: JSON.stringify(body.kdf_params),
    verifier_salt: verifierSalt,
    verifier_hash: verifierHash,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    email_verified_at: null,
  };

  await createUserWithSpace(
    c.env.DB,
    {
      id: user.id,
      email: user.email,
      emailNorm,
      kdfSalt: user.kdf_salt,
      kdfParams: user.kdf_params,
      verifierSalt,
      verifierHash,
      spaceId,
      spaceName: normalizeKey(body.space_name ?? "Personal"),
      now: user.created_at,
    },
    seedWelcomeStatements(c.env.DB, {
      spaceId,
      now: user.created_at,
      tzOffsetMinutes: body.tz_offset ?? 0,
    }),
  );

  // Confirmation mail is fire-and-forget, after the response is decided.
  // Registration must not fail because Resend had a blip: the account exists,
  // and if the mail never arrives the user hits "resend" from the sign-in
  // screen (the public resend endpoint below). Failing registration on a
  // transient mail error would strand an account that was successfully created.
  c.executionCtx.waitUntil(sendVerification(c.env, user, ip).catch(() => {}));

  // No tokens. A confirmed address is required to sign in (see /auth/login), so
  // logging the user in here would be a hole straight through that gate. The
  // client shows "check your inbox" and routes to sign-in.
  return c.json<RegisterResult>({ email: user.email, verification_required: true }, 201);
});

/** Mint a verification token and mail it. Throws; every caller decides whether
 *  that matters to the response. */
async function sendVerification(env: Bindings, user: UserRow, ip: string): Promise<void> {
  const token = await issueEmailVerification(env.DB, user.id, user.email_norm);
  await sendVerificationEmail(env, user.email, token, ip);
}

/**
 * Step 2 of login: exchange a derived key for tokens.
 *
 * Unknown address and wrong password are the same response, and both do the
 * same amount of work — an unknown address still runs a verifier computation
 * against a throwaway value, so the two paths cannot be told apart by timing.
 */
auth.post("/auth/login", async (c) => {
  const body = loginSchema.parse(await c.req.json());
  const emailNorm = normalizeEmail(body.email);
  const pepper = requireSecret(c.env, "AUTH_PEPPER");

  // The durable throttle below counts FAILURES, so it never sees a caller who
  // supplies correct credentials over and over — and that caller still costs a
  // D1 read, an argon2 verification and a session-row WRITE per request. This
  // is what bounds that.
  await enforceRateLimit(c.env.AUTH_LIMIT, `login:${clientIp(c.req.raw)}`, TOO_MANY);

  const buckets = [emailBucket(emailNorm), ipBucket(clientIp(c.req.raw))];
  await assertNotLocked(c.env.DB, buckets);

  // Bot check before any account lookup or verifier work. Independent of
  // whether the address exists, so it is not an enumeration oracle. Web-only
  // and per-origin; the desktop app and unset-secret environments skip it.
  if (turnstileRequired(c.env, c.req.raw)) {
    const ok = await verifyTurnstile(c.env.TURNSTILE_SECRET_KEY!, body.turnstile_token, c.req.raw);
    if (!ok) throw badRequest("Captcha check failed. Please try again.");
  }

  const user = await findUserByEmail(c.env.DB, emailNorm);

  let ok = false;
  try {
    const salt = user?.verifier_salt ?? (await decoyKdfSalt(pepper, emailNorm));
    const candidate = await computeVerifier(pepper, salt, body.derived_key);
    ok = user ? timingSafeEqual(candidate, user.verifier_hash) : false;
  } catch {
    throw badRequest("derived_key must be valid base64.");
  }

  if (!user || !ok) {
    await recordFailure(c.env.DB, buckets);
    throw unauthorized("That email or password is incorrect.");
  }

  // The password was right, so the failed-attempt count is cleared before any
  // further decision — an unconfirmed address is not a bad credential and must
  // not count toward a lockout.
  await clearBucket(c.env.DB, emailBucket(emailNorm));

  // The gate. A correct password is not enough; the address must be confirmed.
  // This is reachable only by someone who already knows the password (i.e. the
  // account's owner), so it reveals verification state to nobody else and is
  // not an enumeration oracle. The distinct code is what lets the client offer
  // a resend instead of showing "wrong password".
  if (!user.email_verified_at) {
    throw new ApiError(
      "email_unverified",
      "Confirm your email address before signing in — check your inbox for the link.",
    );
  }

  return c.json<TokenPair>(
    await issueTokens(c.env, user, body.device_label ?? null),
  );
});

/** Rotate a refresh token. See rotateSession for the theft-detection rule. */
auth.post("/auth/refresh", async (c) => {
  const body = refreshSchema.parse(await c.req.json());

  // Keyed by IP because the token is the only identity available and it has
  // not been validated yet — keying on an unverified secret would let a caller
  // pick their own bucket. A client refreshes once per 15 minutes per device,
  // so the cap is far above any real household.
  await enforceRateLimit(c.env.SESSION_LIMIT, `refresh:${clientIp(c.req.raw)}`, TOO_MANY);

  const { refresh, userId } = await rotateSession(c.env.DB, body.refresh_token);

  const user = await findUserById(c.env.DB, userId);
  if (!user) throw unauthorized("Account no longer exists.");

  return c.json<TokenPair>({
    access_token: await signAccessToken(requireSecret(c.env, "JWT_SECRET"), user.id),
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refresh.token,
    session: await sessionFor(c.env.DB, user),
  });
});

/** Sign out. Always 204, even for an unrecognised token — logout must not
 *  double as a way to test whether a token is valid. */
auth.post("/auth/logout", async (c) => {
  const body = refreshSchema.parse(await c.req.json());

  // Always 204 means this is a free, unauthenticated D1 write for anyone who
  // finds it. The cap costs a real sign-out nothing — one per device.
  await enforceRateLimit(c.env.SESSION_LIMIT, `logout:${clientIp(c.req.raw)}`, TOO_MANY);

  await revokeByToken(c.env.DB, body.refresh_token);
  return c.body(null, 204);
});

/**
 * The caller's identity and the spaces they can reach.
 *
 * The client calls this on launch to decide whether a stored session is still
 * good, and it is the only place the space list is authoritative — a client
 * must never infer its own membership from a cached token.
 */
auth.get("/auth/me", requireAuth(), async (c) => {
  const user = await findUserById(c.env.DB, c.get("userId"));
  if (!user) throw unauthorized("Account no longer exists.");
  return c.json<Session>(await sessionFor(c.env.DB, user));
});

// ---------------------------------------------------------------------------
// Password reset
//
// The reset path is the one place where the "the server never sees a password"
// design could quietly be abandoned, and isn't. A token does not authorise a
// password change; it authorises replacing this account's KDF salt, params and
// verifier with values the CLIENT computed from the new password. The wire
// carries a derived key on the way in, exactly as registration does.
// ---------------------------------------------------------------------------

/** Every outcome of "ask for a reset link" — success, unknown address, mail
 *  provider down, mail not configured — returns this. See the schema comment:
 *  a response that varies is an account-existence oracle, and the failure modes
 *  leak just as loudly as the success. */
const RESET_SENT = {
  message: "If that address has an account, a reset link is on its way.",
} as const;

auth.post("/auth/password/forgot", async (c) => {
  const { email } = forgotPasswordSchema.parse(await c.req.json());
  const emailNorm = normalizeEmail(email);

  // Both keys, because they stop different things: the address key stops one
  // mailbox being flooded (mail we pay for, and a nuisance the recipient
  // can't switch off), the IP key stops one client walking an address list to
  // see which ones bounce.
  const limitMessage = "Too many reset requests. Wait a minute and try again.";
  await enforceRateLimit(c.env.EMAIL_LIMIT, `reset:${emailNorm}`, limitMessage);
  await enforceRateLimit(c.env.EMAIL_LIMIT, `reset-ip:${clientIp(c.req.raw)}`, limitMessage);

  // A locked account is not told it is locked here — that would be the oracle
  // by another route. It simply gets no mail, and the lock expires.
  const user = await findUserByEmail(c.env.DB, emailNorm);
  if (!user) return c.json(RESET_SENT);

  // Mail is sent inline rather than in waitUntil so a provider failure can be
  // *counted*: without the key configured this is a permanent condition the
  // operator needs to see, and a swallowed error in a background task is how
  // "reset does nothing" survives for months.
  try {
    const token = await issuePasswordReset(c.env.DB, user.id);
    await sendPasswordResetEmail(c.env, user.email, token, clientIp(c.req.raw));
  } catch (err) {
    // Logged without the address: [observability] is on, and an email address
    // in log retention is exactly the data this endpoint refuses to confirm.
    //
    // `budget` separates "today's mail allowance is spent" from a provider or
    // config failure. It is the signal that someone is working the sign-up or
    // reset forms, and without it that shows up as an ordinary mail error.
    console.error("password reset mail failed", {
      requestId: c.get("requestId"),
      configured: !(err instanceof EmailNotConfigured),
      budget: err instanceof MailBudgetExhausted,
    });
  }

  return c.json(RESET_SENT);
});

/**
 * Redeem a reset token.
 *
 * `bad_request` for unknown, expired and already-used alike. Telling them apart
 * would tell someone holding a stale link whether the account is real and
 * whether a fresher link is worth hunting for.
 */
auth.post("/auth/password/reset", async (c) => {
  const body = resetPasswordSchema.parse(await c.req.json());
  const pepper = requireSecret(c.env, "AUTH_PEPPER");

  const userId = await consumePasswordReset(c.env.DB, body.token);
  if (!userId) throw badRequest("That reset link is no longer valid. Request a new one.");

  const verifierSalt = toBase64(randomBytes(16));
  let verifierHash: string;
  try {
    verifierHash = await computeVerifier(pepper, verifierSalt, body.derived_key);
  } catch {
    throw badRequest("derived_key must be valid base64.");
  }

  await applyNewPassword(c.env.DB, userId, {
    kdfSalt: body.kdf_salt,
    kdfParams: JSON.stringify(body.kdf_params),
    verifierSalt,
    verifierHash,
  });

  // The failed-login lock is cleared too: someone who has just proved control
  // of the mailbox should not be held out by the guesses that made them reset.
  const user = await findUserById(c.env.DB, userId);
  if (user) await clearBucket(c.env.DB, emailBucket(user.email_norm));

  // No tokens issued. Every session was revoked a moment ago, including any
  // the attacker held, and handing this request a fresh one would mean a
  // stolen reset link is itself a login. The client signs in normally.
  //
  // What a reset does NOT do is kill an access token already in flight: those
  // are stateless JWTs, checked with an HMAC and no database read, which is the
  // trade that keeps ~105 ms of D1 off every request. So an attacker holding
  // one keeps read/write access for up to its remaining 15 minutes, and cannot
  // extend it — their refresh token is dead. Closing that window means a
  // session lookup per request or a revocation list in KV; it has not been
  // judged worth it, but it is a known bound, not an oversight.
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

/** Anonymous on purpose: the link is opened wherever the mail was read, which
 *  is routinely a device with no session. The token is the credential. */
auth.post("/auth/email/verify", async (c) => {
  const { token } = verifyEmailSchema.parse(await c.req.json());
  const ok = await consumeEmailVerification(c.env.DB, token);
  if (!ok) throw badRequest("That confirmation link is no longer valid.");
  return c.body(null, 204);
});

/**
 * Ask for another confirmation link WITHOUT signing in.
 *
 * This is the escape hatch for the login gate: a user who never confirmed
 * can't sign in, so the resend they need can't sit behind auth. It is
 * therefore oracle-safe in exactly the way `/auth/password/forgot` is — one
 * response for a confirmed address, an unconfirmed one, and one with no
 * account — and rate-limited on the same mail budget. An already-confirmed
 * address is a silent no-op: no mail, same response.
 */
const VERIFY_SENT = {
  message: "If that address needs confirming, a new link is on its way.",
} as const;

auth.post("/auth/email/verify/resend", async (c) => {
  const { email } = resendVerificationSchema.parse(await c.req.json());
  const emailNorm = normalizeEmail(email);

  const limitMessage = "Too many requests. Wait a minute and try again.";
  await enforceRateLimit(c.env.EMAIL_LIMIT, `verify-email:${emailNorm}`, limitMessage);
  await enforceRateLimit(c.env.EMAIL_LIMIT, `verify-ip:${clientIp(c.req.raw)}`, limitMessage);

  const user = await findUserByEmail(c.env.DB, emailNorm);
  if (user && !user.email_verified_at) {
    try {
      await sendVerification(c.env, user, clientIp(c.req.raw));
    } catch (err) {
      // Same discipline as forgot: log without the address, since a mail
      // failure here must not become an existence signal or a logged PII line.
      console.error("verification resend mail failed", {
        requestId: c.get("requestId"),
        configured: !(err instanceof EmailNotConfigured),
        budget: err instanceof MailBudgetExhausted,
      });
    }
  }

  return c.json(VERIFY_SENT);
});

/** Send another link to the signed-in account's own address. Authenticated,
 *  so this cannot be used to mail anyone who has not asked for it. Retained for
 *  completeness; with the login gate in place a signed-in user is already
 *  confirmed, so this is effectively a no-op in the current UI. */
auth.post("/auth/email/verify/send", requireAuth(), async (c) => {
  const user = await findUserById(c.env.DB, c.get("userId"));
  if (!user) throw unauthorized("Account no longer exists.");
  if (user.email_verified_at) return c.body(null, 204);

  await enforceRateLimit(
    c.env.EMAIL_LIMIT,
    `verify:${user.id}`,
    "Too many requests. Wait a minute and try again.",
  );

  try {
    await sendVerification(c.env, user, clientIp(c.req.raw));
  } catch (err) {
    if (err instanceof EmailNotConfigured) {
      throw new ApiError("internal", "Email isn't set up on this server yet.");
    }
    // This endpoint is authenticated, so it is not an enumeration oracle and
    // can afford to say what happened — unlike the public resend above, which
    // must answer identically for every address.
    if (err instanceof MailBudgetExhausted) {
      throw new ApiError("rate_limited", "Too many emails sent today. Try again tomorrow.");
    }
    throw new ApiError("internal", "Couldn't send that email. Try again shortly.");
  }
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Account deletion
// ---------------------------------------------------------------------------

/**
 * Delete the caller's account and everything in it, permanently.
 *
 * Re-authentication, not merely a valid session: an access token lives fifteen
 * minutes and this is the only irreversible operation in the API. The client
 * re-derives a key from a freshly typed password, which is why this takes a
 * `derived_key` and not a confirmation flag.
 *
 * The verifier check is throttled through the same buckets as login. Without
 * it this endpoint is an unmetered password oracle for anyone holding a stolen
 * access token — cheaper to attack than login, because it needs no email.
 */
auth.post("/auth/account/delete", requireAuth(), async (c) => {
  const body = deleteAccountSchema.parse(await c.req.json());
  const pepper = requireSecret(c.env, "AUTH_PEPPER");

  const user = await findUserById(c.env.DB, c.get("userId"));
  if (!user) throw unauthorized("Account no longer exists.");

  const buckets = [emailBucket(user.email_norm), ipBucket(clientIp(c.req.raw))];
  await assertNotLocked(c.env.DB, buckets);

  let ok = false;
  try {
    const candidate = await computeVerifier(pepper, user.verifier_salt, body.derived_key);
    ok = timingSafeEqual(candidate, user.verifier_hash);
  } catch {
    throw badRequest("derived_key must be valid base64.");
  }

  if (!ok) {
    await recordFailure(c.env.DB, buckets);
    throw unauthorized("That password is incorrect.");
  }

  const blobKeys = await deleteAccount(c.env.DB, user.id);
  // After the rows are gone, so the worst outcome is unreferenced bytes rather
  // than rows pointing at bytes that aren't there. KV is not transactional and
  // deletes have their own daily counter, so this is one call per image.
  await deleteNoteImageBlobs(c.env.IMAGES, blobKeys);

  return c.body(null, 204);
});
