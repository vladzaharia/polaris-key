/**
 * Passkeys on key.plrs.im (I-16; S-16 §5.4 items 7, 14 and 17; PORTAL.md §4.1, §4.10, §4.26):
 * the login card's passkey sign-in and the account settings' passkeys.
 *
 *   POST   /api/signin/passkey/options   a sign-in challenge for this browser (pre-auth)
 *   POST   /api/signin/passkey/verify    the assertion: signs in once per challenge
 *   GET    /api/me/passkeys              the account's passkeys, and whether one can be added
 *   POST   /api/me/passkeys/options      a registration challenge (verified email + step-up)
 *   POST   /api/me/passkeys              the attestation: adds the passkey
 *   DELETE /api/me/passkeys/<id>         remove one (step-up; never the last sign-in method)
 *
 * The `/api/me/…` routes are dispatched by `portal/api.ts` after its session and CSRF checks.
 *
 * ── RULES ───────────────────────────────────────────────────────────────────────────────────
 *
 *   - **Enrolment only after email verification** (S-16 §5.1, "Recovery"): an account adds a
 *     passkey only once it has a verified primary email, so a passkey is never its only way back
 *     in. A first sign-in through the email gate has one by construction; the post-sign-in nudge
 *     (I-07's `nudge`) reads `canAdd` here to offer "Add a passkey".
 *   - **Platform-level** (owner, 2026-10-04): no product's Identity toggle is read. A passkey
 *     sign-in during app passthrough only opens the account session; the passthrough's own app
 *     consent ("Continue to <App>", D22) still follows the first time.
 *   - **A passkey never creates an account.** Sign-in goes through `signIn` with `linkedOnly`.
 *   - **Adding and removing are account changes**: a sign-in no older than 5 minutes (step-up),
 *     an audit row, and a notice to every verified address (I-05's link engine). Removing the last
 *     sign-in method is refused (`last_link`).
 *   - **One random account-level user handle** (`accounts.passkey_user_handle`), never the account
 *     id: one "Polaris Key" entry per authenticator.
 */

import type { Db, Env } from "../../../core/platform.js";
import { clientIp, rateLimitOk } from "../../../core/rateLimit.js";
import {
  PASSKEY_FLOW_COOKIE,
  accountRealmCookie,
  clearAccountRealmCookie,
  readCookie,
} from "../../../core/accountCookies.js";
import { signIn } from "../accounts/signIn.js";
import { PASSKEY_ISSUER, findLink, getAccountRow } from "../accounts/repo.js";
import {
  STEP_UP_MAX_AGE_SECONDS,
  isFresh,
  methodLabel,
  unlinkIdentity,
} from "../accounts/links.js";
import { portalAudit, portalAuthCapabilities } from "../portal/repo.js";
import { sendSecurityNotice } from "../portal/email.js";
import { signInMethodAddedNotice } from "../portal/notices.js";
import { browserLabel, randomSecret } from "../portal/accountSessions.js";
import { finishSignIn } from "../card/finish.js";
import { cardJson, safeReturnTo } from "../card/http.js";
import {
  MAX_PASSKEYS_PER_ACCOUNT,
  accountUserHandle,
  findPasskey,
  insertPasskey,
  listAccountPasskeys,
  parseDetails,
  parseTransports,
  recordPasskeyUse,
  type PasskeyRow,
} from "./repo.js";
import {
  PASSKEY_CEREMONY_TTL_SECONDS,
  assertionUserHandle,
  parseAuthenticationResponse,
  parseRegistrationResponse,
  passkeyRelyingParty,
  putCeremony,
  registerCeremonyRef,
  registrationOptions,
  signInCeremonyRef,
  signInOptions,
  takeCeremony,
  verifyAssertion,
  verifyRegistration,
  type RelyingParty,
} from "./webauthn.js";

/** The rate-limit scope of platform (account) sign-in, as for the email card. */
const PORTAL_SCOPE = "_portal";
/** Passkey sign-in requests (options and verify) from one client address per minute. */
export const PASSKEY_SIGNIN_PER_IP_MINUTE = 30;
/** Passkey changes (options, add, remove) by one account per minute. */
export const PASSKEY_CHANGES_PER_ACCOUNT_MINUTE = 10;
/** The largest request body a passkey route reads (an attestation is a few KiB). */
const MAX_BODY_BYTES = 128 * 1024;

const clearPasskeyFlow = (): string =>
  clearAccountRealmCookie(PASSKEY_FLOW_COOKIE);

/** The body as a JSON object (`{}` when empty), or `null` when it is not one or is too large. */
async function readBoundedJson(
  req: Request,
): Promise<Record<string, unknown> | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return null;
  }
  if (raw.length > MAX_BODY_BYTES) return null;
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function unavailable(): Response {
  return cardJson(
    {
      error: "auth_method_disabled",
      message: "Passkey sign-in is unavailable here.",
    },
    404,
  );
}

function expired(cookies: string[] = [clearPasskeyFlow()]): Response {
  return cardJson(
    {
      error: "signin_expired",
      message: "This passkey request has expired. Start again.",
    },
    400,
    cookies,
  );
}

/** Every failed passkey sign-in answers this one shape, whatever failed (enumeration safety:
 *  no answer says which account, which check or whether the key matched). `unknownCredential`
 *  says only that no account here holds this credential id, so the card can tell the browser to
 *  forget it (`PublicKeyCredential.signalUnknownCredential`). */
function refused(unknownCredential = false): Response {
  return cardJson(
    {
      error: "unauthorized",
      message:
        "That passkey didn't work. Try again, or use another way to sign in.",
      ...(unknownCredential ? { unknownCredential: true } : {}),
    },
    401,
    [clearPasskeyFlow()],
  );
}

// ── The login card ──────────────────────────────────────────────────────────────────────────

async function signInAllowed(
  req: Request,
  env: Env,
  db: Db,
  now: number,
): Promise<Response | RelyingParty> {
  if (req.method !== "POST")
    return cardJson({ error: "method_not_allowed" }, 405);
  const allowed = await rateLimitOk(
    env,
    PORTAL_SCOPE,
    {
      bucket: "portalPasskey",
      id: clientIp(req),
      limit: PASSKEY_SIGNIN_PER_IP_MINUTE,
      windowSec: 60,
    },
    now,
  );
  if (!allowed) return cardJson({ error: "rate_limited" }, 429);
  const caps = await portalAuthCapabilities(db);
  if (!caps.portalEnabled) return unavailable();
  return passkeyRelyingParty(env, req) ?? unavailable();
}

/** `POST /api/signin/passkey/options {returnTo?}`: a challenge bound to this browser. */
export async function handlePasskeySignInOptions(
  req: Request,
  env: Env,
  db: Db,
  now: number,
): Promise<Response> {
  const rp = await signInAllowed(req, env, db, now);
  if (rp instanceof Response) return rp;
  const body = await readBoundedJson(req);
  if (!body)
    return cardJson({ error: "bad_request", message: "invalid json" }, 400);
  const returnTo = safeReturnTo(req, body.returnTo);
  if (body.returnTo !== undefined && body.returnTo !== null && !returnTo) {
    return cardJson(
      { error: "bad_request", message: "invalid return URL" },
      400,
    );
  }
  const options = await signInOptions(rp);
  const secret = randomSecret(32);
  await putCeremony(env, await signInCeremonyRef(env, secret), {
    v: 1,
    purpose: "signin",
    challenge: options.challenge,
    rpId: rp.id,
    createdAt: now,
    ...(returnTo ? { returnTo } : {}),
  });
  return cardJson({ options, expiresIn: PASSKEY_CEREMONY_TTL_SECONDS }, 200, [
    accountRealmCookie(
      PASSKEY_FLOW_COOKIE,
      secret,
      PASSKEY_CEREMONY_TTL_SECONDS,
    ),
  ]);
}

/** `POST /api/signin/passkey/verify {response}`: the assertion, once per challenge. */
export async function handlePasskeySignInVerify(
  req: Request,
  env: Env,
  db: Db,
  now: number,
): Promise<Response> {
  const rp = await signInAllowed(req, env, db, now);
  if (rp instanceof Response) return rp;
  const secret = readCookie(req.headers.get("cookie"), PASSKEY_FLOW_COOKIE);
  if (!secret) return expired();
  // Taken BEFORE anything is checked: whatever happens next, this challenge is spent, so a
  // response verifies at most once and a failed try needs a new challenge.
  const ceremony = await takeCeremony(
    env,
    await signInCeremonyRef(env, secret),
    "signin",
  );
  if (!ceremony || ceremony.rpId !== rp.id) return expired();
  const body = await readBoundedJson(req);
  const response = parseAuthenticationResponse(body?.response);
  if (!response) {
    return cardJson(
      { error: "bad_request", message: "invalid passkey response" },
      400,
      [clearPasskeyFlow()],
    );
  }

  const passkey = await findPasskey(db, response.id);
  if (!passkey) return refused(true);
  if (passkey.rp_id !== rp.id) return refused();
  // Discoverable sign-in names no account up front, so the handle must come back and must be
  // the one this credential was created under (WebAuthn §7.2 step 6).
  if (assertionUserHandle(response) !== passkey.user_handle) return refused();
  const link = await findLink(db, {
    issuerKey: PASSKEY_ISSUER,
    tenantScope: "",
    subject: passkey.credential_id,
  });
  if (!link || link.account_id !== passkey.account_id) return refused();

  const verdict = await verifyAssertion({
    response,
    challenge: ceremony.challenge,
    rp,
    passkey,
    transports: parseTransports(passkey.transports_json),
  });
  if (!verdict.ok) {
    if (verdict.reason === "counter") {
      // The credential's own key signed this, with a counter that went backwards: two copies of
      // one authenticator. Refused, and recorded for the account's audit trail.
      await portalAudit(db, {
        accountId: passkey.account_id,
        action: "account.passkey.counter_regressed",
        targetKind: "link",
        targetId: link.id,
        summary:
          "Refused a passkey sign-in: its signature counter went backwards",
        now,
      });
    }
    return refused();
  }
  if (!(await recordPasskeyUse(db, passkey, verdict, now))) return refused();

  const result = await signIn(
    db,
    {
      issuerKey: PASSKEY_ISSUER,
      subject: passkey.credential_id,
      kind: "passkey",
      amr: ["passkey"],
    },
    now,
    { linkedOnly: true },
  );
  if (result.status !== "signed_in" || result.account.status !== "active") {
    return cardJson(
      {
        error: "forbidden",
        message: "This account can't sign in. Contact Polaris Key support.",
      },
      403,
      [clearPasskeyFlow()],
    );
  }
  const finished = await finishSignIn(
    env,
    db,
    req,
    result.account,
    {
      amr: ["passkey"],
      action: "portal.login.passkey",
      summary: "Signed in with a passkey",
    },
    now,
  );
  return cardJson(
    {
      status: "signed_in",
      next: ceremony.returnTo ?? "/",
      nudge: finished.nudge,
    },
    200,
    [finished.cookie, clearPasskeyFlow()],
  );
}

// ── Account settings (I-11's page, PX-W12's methods) ────────────────────────────────────────

/** The signed-in caller, as `portal/api.ts` resolved it. */
export interface PasskeyCaller {
  accountId: string;
  /** When this session's holder last signed in (`portalSessionAuthenticatedAt`). */
  authenticatedAt: number;
  /** The session row's key: a registration ceremony is bound to it. */
  sessionIdHash: string;
}

export interface PasskeyView {
  /** The credential id (base64url): the path segment that removes it. */
  id: string;
  /** Its sign-in method's id (`account_links`), as the methods list names it. */
  methodId: string;
  createdAt: number;
  lastUsedAt: number | null;
  transports: string[];
  /** Synced across the person's devices (a multi-device credential), when known. */
  synced: boolean | null;
  /** The authenticator model's AAGUID, when the browser disclosed it. */
  aaguid: string | null;
  /** The browser it was added from ("Safari on iOS"), when known. */
  addedFrom: string | null;
}

type AddRefusal = "email_unverified" | "limit";

/** Why the account cannot add a passkey right now, or `null` when it can. */
async function addRefusal(
  db: Db,
  accountId: string,
): Promise<AddRefusal | null> {
  const account = await getAccountRow(db, accountId);
  if (!account?.primary_email || account.primary_email_verified_at === null) {
    return "email_unverified";
  }
  const held = await listAccountPasskeys(db, accountId);
  return held.length >= MAX_PASSKEYS_PER_ACCOUNT ? "limit" : null;
}

function refusalResponse(reason: AddRefusal): Response {
  return cardJson(
    reason === "email_unverified"
      ? {
          error: "forbidden",
          reason,
          message:
            "Confirm an email address first. Then you can add a passkey.",
        }
      : {
          error: "forbidden",
          reason,
          message: `You can have up to ${MAX_PASSKEYS_PER_ACCOUNT} passkeys. Remove one to add another.`,
        },
    403,
  );
}

function stepUpRequired(): Response {
  return cardJson(
    {
      error: "step_up_required",
      message: "Sign in again to confirm it's you, then try again.",
      maxAgeSeconds: STEP_UP_MAX_AGE_SECONDS,
    },
    401,
  );
}

function fresh(caller: PasskeyCaller, now: number): boolean {
  return isFresh(
    { accountId: caller.accountId, authenticatedAt: caller.authenticatedAt },
    now,
  );
}

async function changesAllowed(
  env: Env,
  caller: PasskeyCaller,
  now: number,
): Promise<boolean> {
  return rateLimitOk(
    env,
    PORTAL_SCOPE,
    {
      bucket: "portalPasskeyChange",
      id: caller.accountId,
      limit: PASSKEY_CHANGES_PER_ACCOUNT_MINUTE,
      windowSec: 60,
    },
    now,
  );
}

/** `/api/me/passkeys…`; `rest` is the path after `passkeys`. Session and CSRF already checked. */
export async function handleAccountPasskeys(
  req: Request,
  env: Env,
  db: Db,
  caller: PasskeyCaller,
  rest: string[],
  now: number,
): Promise<Response> {
  if (rest.length === 0 && req.method === "GET") {
    return listPasskeys(db, caller);
  }
  if (rest.length === 0 && req.method === "POST") {
    return addPasskey(req, env, db, caller, now);
  }
  if (rest.length === 1 && rest[0] === "options") {
    if (req.method !== "POST")
      return cardJson({ error: "method_not_allowed" }, 405);
    return registrationStart(req, env, db, caller, now);
  }
  if (rest.length === 1 && rest[0]) {
    if (req.method !== "DELETE")
      return cardJson({ error: "method_not_allowed" }, 405);
    return removePasskey(req, env, db, caller, rest[0], now);
  }
  if (rest.length === 0) return cardJson({ error: "method_not_allowed" }, 405);
  return cardJson({ error: "not_found" }, 404);
}

/** One passkey as the settings list shows it (also PX-W12's methods list). */
export function passkeyView(r: PasskeyRow & { link_id: string }): PasskeyView {
  const details = parseDetails(r.details_json);
  return {
    id: r.credential_id,
    methodId: r.link_id,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    transports: parseTransports(r.transports_json),
    synced:
      details.deviceType === undefined
        ? null
        : details.deviceType === "multiDevice",
    aaguid: typeof details.aaguid === "string" ? details.aaguid : null,
    addedFrom: typeof details.addedFrom === "string" ? details.addedFrom : null,
  };
}

/** Whether the account can add a passkey now, and why not (PX-W12's methods list reads it). */
export async function passkeyAddable(
  db: Db,
  accountId: string,
): Promise<{ canAdd: boolean; reason: AddRefusal | null }> {
  const reason = await addRefusal(db, accountId);
  return { canAdd: reason === null, reason };
}

async function listPasskeys(db: Db, caller: PasskeyCaller): Promise<Response> {
  const rows = await listAccountPasskeys(db, caller.accountId);
  const passkeys: PasskeyView[] = rows.map(passkeyView);
  const reason = await addRefusal(db, caller.accountId);
  return cardJson({ passkeys, canAdd: reason === null, reason });
}

/** `POST /api/me/passkeys/options`: a registration challenge for this session. */
async function registrationStart(
  req: Request,
  env: Env,
  db: Db,
  caller: PasskeyCaller,
  now: number,
): Promise<Response> {
  if (!(await changesAllowed(env, caller, now)))
    return cardJson({ error: "rate_limited" }, 429);
  const rp = passkeyRelyingParty(env, req);
  if (!rp) return unavailable();
  const refusal = await addRefusal(db, caller.accountId);
  if (refusal) return refusalResponse(refusal);
  if (!fresh(caller, now)) return stepUpRequired();
  const account = await getAccountRow(db, caller.accountId);
  const handle = await accountUserHandle(db, caller.accountId);
  // `addRefusal` just read a verified primary email on this row; it is the authenticator's label.
  if (!account?.primary_email || !handle) {
    return refusalResponse("email_unverified");
  }
  const held = await listAccountPasskeys(db, caller.accountId);
  const options = await registrationOptions(
    rp,
    {
      handle,
      name: account.primary_email,
      displayName: account.display_name ?? account.primary_email,
    },
    held.map((p) => ({
      id: p.credential_id,
      transports: parseTransports(p.transports_json),
    })),
  );
  await putCeremony(env, await registerCeremonyRef(env, caller.sessionIdHash), {
    v: 1,
    purpose: "register",
    challenge: options.challenge,
    rpId: rp.id,
    createdAt: now,
    accountId: caller.accountId,
    userHandle: handle,
  });
  return cardJson({ options, expiresIn: PASSKEY_CEREMONY_TTL_SECONDS });
}

/** `POST /api/me/passkeys {response}`: the attestation for this session's challenge. */
async function addPasskey(
  req: Request,
  env: Env,
  db: Db,
  caller: PasskeyCaller,
  now: number,
): Promise<Response> {
  if (!(await changesAllowed(env, caller, now)))
    return cardJson({ error: "rate_limited" }, 429);
  const rp = passkeyRelyingParty(env, req);
  if (!rp) return unavailable();
  const ceremony = await takeCeremony(
    env,
    await registerCeremonyRef(env, caller.sessionIdHash),
    "register",
  );
  if (
    !ceremony ||
    ceremony.accountId !== caller.accountId ||
    ceremony.rpId !== rp.id
  ) {
    return expired([]);
  }
  // The account may have changed since the challenge: re-check the rules on the way in.
  const refusal = await addRefusal(db, caller.accountId);
  if (refusal) return refusalResponse(refusal);
  if (!fresh(caller, now)) return stepUpRequired();
  const body = await readBoundedJson(req);
  const response = parseRegistrationResponse(body?.response);
  if (!response) {
    return cardJson(
      { error: "bad_request", message: "invalid passkey response" },
      400,
    );
  }
  const verdict = await verifyRegistration({
    response,
    challenge: ceremony.challenge,
    rp,
  });
  if (!verdict.ok) {
    return cardJson(
      {
        error: "bad_request",
        message: "That passkey couldn't be added. Try again.",
      },
      400,
    );
  }
  const inserted = await insertPasskey(
    db,
    {
      accountId: caller.accountId,
      credentialId: verdict.credentialId,
      publicKey: verdict.publicKey,
      counter: verdict.counter,
      transports: verdict.transports,
      rpId: rp.id,
      userHandle: ceremony.userHandle,
      details: {
        aaguid: verdict.aaguid,
        deviceType: verdict.deviceType,
        backedUp: verdict.backedUp,
        addedFrom: browserLabel(req.headers.get("user-agent")),
      },
    },
    now,
  );
  if (inserted === "conflict") {
    return cardJson(
      {
        error: "link_conflict",
        message: "That passkey is already in use. Try another one.",
      },
      409,
    );
  }
  await portalAudit(db, {
    accountId: caller.accountId,
    action: "account.link.add",
    targetKind: "link",
    targetId: inserted.linkId,
    summary: "Connected passkey",
    now,
  });
  const account = await getAccountRow(db, caller.accountId);
  await sendSecurityNotice(
    env,
    db,
    caller.accountId,
    account?.primary_email,
    signInMethodAddedNotice({
      method: methodLabel({ kind: "passkey", email: null, subject: "" }),
      origin: rp.origin,
    }),
    now,
  );
  const added = (await listAccountPasskeys(db, caller.accountId)).find(
    (p) => p.credential_id === verdict.credentialId,
  );
  return cardJson(
    {
      ok: true,
      passkey: added
        ? {
            id: added.credential_id,
            methodId: added.link_id,
            createdAt: added.created_at,
          }
        : {
            id: verdict.credentialId,
            methodId: inserted.linkId,
            createdAt: now,
          },
    },
    201,
  );
}

/** `DELETE /api/me/passkeys/<id>`: I-05's guarded unlink of the passkey's sign-in method. */
async function removePasskey(
  req: Request,
  env: Env,
  db: Db,
  caller: PasskeyCaller,
  credentialId: string,
  now: number,
): Promise<Response> {
  if (!(await changesAllowed(env, caller, now)))
    return cardJson({ error: "rate_limited" }, 429);
  const held = (await listAccountPasskeys(db, caller.accountId)).find(
    (p) => p.credential_id === credentialId,
  );
  if (!held) return cardJson({ error: "not_found" }, 404);
  const origin =
    passkeyRelyingParty(env, req)?.origin ?? new URL(req.url).origin;
  const result = await unlinkIdentity(
    { db, env, now, origin },
    { accountId: caller.accountId, authenticatedAt: caller.authenticatedAt },
    held.link_id,
  );
  if (result.ok) return cardJson({ ok: true });
  if (result.error === "step_up_required") return stepUpRequired();
  if (result.error === "last_link") {
    return cardJson(
      {
        error: "last_link",
        message:
          "This is your only way to sign in. Add another one first, then you can remove this passkey.",
      },
      409,
    );
  }
  return cardJson({ error: "not_found" }, 404);
}
