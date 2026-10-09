/**
 * Account → Sign-in methods (PX-W12; PORTAL.md §4.26, §10.2 G27; S-16 §5.1 "Rules").
 *
 *   GET    /api/me/methods                    every sign-in method, grouped, with what each allows
 *   POST   /api/me/methods/<kind>/start       connect one: `google`, `apple`, `steam` (a provider
 *                                             redirect), `email` (a code), `passkey` (I-16's
 *                                             registration challenge)
 *   POST   /api/me/methods/email/verify       the email code: connects the address
 *   DELETE /api/me/methods/<id>               disconnect one (step-up; never the last)
 *
 * A provider's callback is its registered sign-in callback (`/login/<provider>/callback`), which
 * finishes a Connect without signing anyone in (`providers/flow.ts`). A passkey completes on
 * `POST /api/me/passkeys` (I-16).
 *
 * ── RULES (I-05's link engine, `accounts/links.ts`) ────────────────────────────────────────
 *
 *   - Connect and disconnect need a sign-in no older than 5 minutes (step-up), checked when the
 *     change is made: `step_up_required` (401) means sign in again (with a passkey or an email
 *     code) and retry.
 *   - Never orphan: the last sign-in method cannot be removed (`last_link`, 409). The guard is in
 *     the DELETE itself. The account's only email address cannot be removed either while it is
 *     the primary email (`forbidden` with `reason: "only_email"`): notices, passkey enrolment and
 *     the licence claim rules need a verified address. Removing the primary email while another
 *     address exists makes the oldest other address primary.
 *   - A method another account holds is refused (`link_conflict`, 409) and nothing moves; the
 *     page then offers Link an existing account.
 *   - An email is connected only once its code is entered, and the answer to `start` is the same
 *     whatever the address is (nothing is enumerated). A provider's email claim is narrowed as a
 *     sign-in narrows it (`providerVouchesForEmail`), and an address another account already uses
 *     is never stored as verified here. A verified address brings the licences waiting on it
 *     (LX-26, `onAccountEmailVerified`, fired by `linkIdentity`).
 *   - Every change is audited and emailed to every verified address on the account; an email
 *     method is named generically in those notices ("An email address"), and the removed address
 *     is told too.
 *   - Changes share 10 a minute per account (`portalMethodChange`).
 */

import { hashKey, type Db, type Env } from "../../../core/platform.js";
import { clientNetwork, rateLimitOk } from "../../../core/rateLimit.js";
import {
  artefactRef,
  consumeArtefact,
  getArtefact,
  putArtefact,
  updateArtefact,
  type ArtefactRef,
} from "../../../core/singleUse.js";
import {
  checkEmailSend,
  EMAIL_CODE_DIGITS,
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_TTL_SECONDS,
  issueEmailCode,
  verifyEmailCode,
} from "../../../core/emailLimits.js";
import { isApplePrivateRelay } from "../../../core/emailDelivery.js";
import {
  STEP_UP_MAX_AGE_SECONDS,
  isFresh,
  linkIdentity,
  unlinkIdentity,
} from "../accounts/links.js";
import {
  EMAIL_ISSUER,
  PASSKEY_ISSUER,
  accountUsingEmail,
  getAccountRow,
  listLinks,
  type AccountLinkRow,
} from "../accounts/repo.js";
import { listAccountPasskeys } from "../passkeys/repo.js";
import {
  handleAccountPasskeys,
  passkeyAddable,
  passkeyView,
  type PasskeyView,
} from "../passkeys/routes.js";
import {
  configuredSignInProviders,
  isSignInProviderKind,
  SIGNIN_PROVIDER_KINDS,
} from "../providers/config.js";
import { startProviderConnect } from "../providers/flow.js";
import {
  CODE_VERIFY_PER_IP_MINUTE,
  emailUnavailable,
  PORTAL_EMAIL_SCOPE,
} from "../card/emailSignIn.js";
import {
  cardJson,
  originOf,
  parseEmail,
  readJsonObject,
  wrongCodeMessage,
} from "../card/http.js";
import { portalEmailConfigured, sendSignInEmail } from "./email.js";

/** Method changes (connect starts, codes, removals) by one account per minute. */
export const METHOD_CHANGES_PER_ACCOUNT_MINUTE = 10;

/** The signed-in caller, as `portal/api.ts` resolved it. */
export interface MethodsCaller {
  accountId: string;
  /** When this session's holder last signed in (`portalSessionAuthenticatedAt`). */
  authenticatedAt: number;
  /** The session row's key: an email code and a Connect are bound to it. */
  sessionIdHash: string;
}

/** Why a method cannot be removed right now. */
export type RemoveRefusal = "last_link" | "only_email";

export type MethodGroup = "accounts" | "email" | "passkeys";

export interface MethodView {
  id: string;
  kind: string;
  group: MethodGroup;
  /** The method by its own name: "Google", "Steam", "Email", "Passkey". */
  label: string;
  /** The connected identity: a Google address, a Steam persona, an address, a passkey's origin. */
  display: string | null;
  connectedAt: number;
  lastUsedAt: number | null;
  canRemove: boolean;
  reason: RemoveRefusal | null;
  /** What the provider reported since linking (`consent_revoked`, …), or null. */
  flag: string | null;
  /** Apple only: the address is a Hide My Email relay. */
  relay: boolean;
  /** Recognised only inside products of one developer (Game Center, Play Games, …). */
  tenantScoped: boolean;
}

const LABEL: Record<string, string> = {
  email: "Email",
  passkey: "Passkey",
  google: "Google",
  apple: "Apple",
  steam: "Steam",
  gamecenter: "Game Center",
  pgs: "Google Play Games",
  eos: "Epic Online Services",
  oidc: "Single sign-on",
};

function groupOf(link: AccountLinkRow): MethodGroup {
  if (link.issuer_key === EMAIL_ISSUER) return "email";
  if (link.issuer_key === PASSKEY_ISSUER) return "passkeys";
  return "accounts";
}

function profileName(link: AccountLinkRow): string | null {
  const raw = (link as AccountLinkRow & { profile_json?: string | null })
    .profile_json;
  if (!raw) return null;
  try {
    const name = (JSON.parse(raw) as { name?: unknown }).name;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

function displayOf(
  link: AccountLinkRow,
  passkey: PasskeyView | undefined,
): string | null {
  switch (link.kind) {
    case "email":
      return link.subject;
    case "passkey":
      return passkey?.addedFrom ?? null;
    case "google":
    case "apple":
      return link.email ?? link.display_name ?? profileName(link);
    default:
      return link.display_name ?? profileName(link) ?? link.email;
  }
}

/** Whether `link` can go now, given the account's other methods and primary email. */
export function removeRefusal(
  link: AccountLinkRow,
  links: readonly AccountLinkRow[],
  primaryEmail: string | null,
): RemoveRefusal | null {
  if (links.length <= 1) return "last_link";
  if (link.issuer_key === EMAIL_ISSUER && link.subject === primaryEmail) {
    const otherEmails = links.filter(
      (l) => l.issuer_key === EMAIL_ISSUER && l.id !== link.id,
    );
    if (otherEmails.length === 0) return "only_email";
  }
  return null;
}

async function changesAllowed(
  env: Env,
  caller: MethodsCaller,
  now: number,
): Promise<boolean> {
  return rateLimitOk(
    env,
    PORTAL_EMAIL_SCOPE,
    {
      bucket: "portalMethodChange",
      id: caller.accountId,
      limit: METHOD_CHANGES_PER_ACCOUNT_MINUTE,
      windowSec: 60,
    },
    now,
  );
}

function stepUpRequired(): Response {
  return cardJson(
    {
      error: "step_up_required",
      message: "Confirm it's you: sign in again, then try again.",
      maxAgeSeconds: STEP_UP_MAX_AGE_SECONDS,
    },
    401,
  );
}

function fresh(caller: MethodsCaller, now: number): boolean {
  return isFresh(
    { accountId: caller.accountId, authenticatedAt: caller.authenticatedAt },
    now,
  );
}

/** `/api/me/methods…`; `rest` is the path after `methods`. Session and CSRF already checked. */
export async function handleAccountMethods(
  req: Request,
  env: Env,
  db: Db,
  caller: MethodsCaller,
  rest: string[],
  now: number,
): Promise<Response> {
  if (rest.length === 0) {
    if (req.method !== "GET")
      return cardJson({ error: "method_not_allowed" }, 405);
    return cardJson(await methodsView(env, db, caller, now));
  }
  if (rest.length === 2 && rest[0] === "email" && rest[1] === "verify") {
    if (req.method !== "POST")
      return cardJson({ error: "method_not_allowed" }, 405);
    return emailVerify(req, env, db, caller, now);
  }
  if (rest.length === 2 && rest[1] === "start") {
    if (req.method !== "POST")
      return cardJson({ error: "method_not_allowed" }, 405);
    return connectStart(req, env, db, caller, rest[0]!, now);
  }
  if (rest.length === 1 && rest[0]) {
    if (req.method !== "DELETE")
      return cardJson({ error: "method_not_allowed" }, 405);
    return removeMethod(req, env, db, caller, rest[0], now);
  }
  return cardJson({ error: "not_found" }, 404);
}

/** `GET /api/me/methods`: the account's sign-in methods, as the account page lists them. */
export async function methodsView(
  env: Env,
  db: Db,
  caller: MethodsCaller,
  now: number,
): Promise<Record<string, unknown>> {
  const account = await getAccountRow(db, caller.accountId);
  const primaryEmail = account?.primary_email ?? null;
  const links = await listLinks(db, caller.accountId);
  const passkeys = (await listAccountPasskeys(db, caller.accountId)).map(
    passkeyView,
  );
  const passkeyByMethod = new Map(passkeys.map((p) => [p.methodId, p]));
  const methods: MethodView[] = links.map((link) => {
    const reason = removeRefusal(link, links, primaryEmail);
    const pk = passkeyByMethod.get(link.id);
    return {
      id: link.id,
      kind: link.kind,
      group: groupOf(link),
      label: LABEL[link.kind] ?? "Sign-in method",
      display: displayOf(link, pk),
      connectedAt: link.created_at,
      lastUsedAt: pk ? pk.lastUsedAt : link.last_used_at,
      canRemove: reason === null,
      reason,
      flag: link.provider_flag ?? null,
      relay:
        link.kind === "apple" && link.email !== null
          ? isApplePrivateRelay(link.email)
          : false,
      tenantScoped: link.tenant_scope !== "",
    };
  });
  const byId = new Map(methods.map((m) => [m.id, m]));
  const configured = new Set(configuredSignInProviders(env));
  const addable = await passkeyAddable(db, caller.accountId);
  return {
    methods,
    // The primary first, then the others oldest first.
    emails: links
      .filter((l) => l.issuer_key === EMAIL_ISSUER)
      .sort(
        (a, b) =>
          Number(b.subject === primaryEmail) -
            Number(a.subject === primaryEmail) || a.created_at - b.created_at,
      )
      .map((l) => ({
        methodId: l.id,
        email: l.subject,
        primary: l.subject === primaryEmail,
        connectedAt: l.created_at,
        lastUsedAt: l.last_used_at,
        canRemove: byId.get(l.id)?.canRemove ?? false,
        reason: byId.get(l.id)?.reason ?? null,
      })),
    passkeys: passkeys.map((p) => ({
      ...p,
      canRemove: byId.get(p.methodId)?.canRemove ?? false,
      reason: byId.get(p.methodId)?.reason ?? null,
    })),
    // Apple, Google and Steam are always listed (PORTAL.md §4.26); `available` says whether this
    // deploy can connect it.
    providers: SIGNIN_PROVIDER_KINDS.map((kind) => ({
      kind,
      connected: links.some((l) => l.kind === kind),
      available: configured.has(kind),
    })),
    passkey: addable,
    primaryEmail,
    // The Hide My Email notice: an Apple relay address can never match the person's real email.
    hideMyEmail: primaryEmail !== null && isApplePrivateRelay(primaryEmail),
    stepUp: {
      authenticatedAt: caller.authenticatedAt,
      freshUntil: caller.authenticatedAt + STEP_UP_MAX_AGE_SECONDS,
      fresh: fresh(caller, now),
      maxAgeSeconds: STEP_UP_MAX_AGE_SECONDS,
    },
  };
}

/** `POST /api/me/methods/<kind>/start`. */
async function connectStart(
  req: Request,
  env: Env,
  db: Db,
  caller: MethodsCaller,
  kind: string,
  now: number,
): Promise<Response> {
  if (kind === "passkey") {
    // I-16's registration challenge, with its own rules (verified email, step-up, 20 at most).
    return handleAccountPasskeys(req, env, db, caller, ["options"], now);
  }
  if (kind !== "email" && !isSignInProviderKind(kind)) {
    return cardJson({ error: "not_found" }, 404);
  }
  if (!(await changesAllowed(env, caller, now)))
    return cardJson({ error: "rate_limited" }, 429);
  if (!fresh(caller, now)) return stepUpRequired();
  if (kind === "email") return emailStart(req, env, db, caller, now);
  return startProviderConnect(req, env, kind, caller, { now });
}

// ── Email: a code to the address, bound to this session ────────────────────────────────────

interface MethodFlow {
  v: 1;
  rev: number;
  accountId: string;
  email: string;
  attempts: number;
  createdAt: number;
}

async function methodFlowRef(
  env: Env,
  sessionIdHash: string,
): Promise<ArtefactRef> {
  return artefactRef(
    "method-flow",
    await hashKey(`method-flow:${sessionIdHash}`, env.KEY_HASH_PEPPER),
  );
}

async function emailStart(
  req: Request,
  env: Env,
  db: Db,
  caller: MethodsCaller,
  now: number,
): Promise<Response> {
  const body = await readJsonObject(req);
  const email = parseEmail(body?.email);
  if (!email) {
    return cardJson(
      { error: "bad_request", message: "valid email required" },
      422,
    );
  }
  const links = await listLinks(db, caller.accountId);
  if (links.some((l) => l.issuer_key === EMAIL_ISSUER && l.subject === email)) {
    // Already one of this account's own methods: nothing to prove.
    return cardJson({ status: "connected", already: true, email });
  }
  if (!portalEmailConfigured(env)) return emailUnavailable();
  const ref = await methodFlowRef(env, caller.sessionIdHash);
  // Enumeration-safe: the same answer whether the address is free, another account's, or refused
  // a send. Whose it is shows only once the code proved it.
  const { send } = await checkEmailSend(
    env,
    { product: PORTAL_EMAIL_SCOPE, recipient: email, req },
    now,
  );
  if (send) {
    const { code } = await issueEmailCode(
      env,
      { product: PORTAL_EMAIL_SCOPE, recipient: email, flowId: ref.id },
      JSON.stringify({ methodFlow: ref.id }),
    );
    const sent = await sendSignInEmail(
      env,
      db,
      email,
      { code, link: null, purpose: "confirm" },
      now,
    );
    if (sent === "unavailable") return emailUnavailable();
  }
  const flow: MethodFlow = {
    v: 1,
    rev: 0,
    accountId: caller.accountId,
    email,
    attempts: 0,
    createdAt: now,
  };
  await putArtefact(env, ref, JSON.stringify(flow), EMAIL_CODE_TTL_SECONDS);
  return cardJson({
    status: "code_sent",
    email,
    expiresIn: EMAIL_CODE_TTL_SECONDS,
    codeLength: EMAIL_CODE_DIGITS,
  });
}

function codeExpired(): Response {
  return cardJson(
    {
      error: "signin_expired",
      message: "This code has expired. Send a new one.",
    },
    400,
  );
}

/** `POST /api/me/methods/email/verify {code}`. */
async function emailVerify(
  req: Request,
  env: Env,
  db: Db,
  caller: MethodsCaller,
  now: number,
): Promise<Response> {
  // The card's per-IP verify bucket, on top of I-02's per-code and per-recipient limits.
  const allowed = await rateLimitOk(
    env,
    PORTAL_EMAIL_SCOPE,
    {
      bucket: "portalCodeVerify",
      id: clientNetwork(req),
      limit: CODE_VERIFY_PER_IP_MINUTE,
      windowSec: 60,
    },
    now,
  );
  if (!allowed) return cardJson({ error: "rate_limited" }, 429);
  const ref = await methodFlowRef(env, caller.sessionIdHash);
  const raw = await getArtefact(env, ref);
  let flow: MethodFlow | null = null;
  try {
    flow = raw ? (JSON.parse(raw) as MethodFlow) : null;
  } catch {
    flow = null;
  }
  if (!flow || flow.accountId !== caller.accountId) return codeExpired();
  const body = await readJsonObject(req);
  const code = typeof body?.code === "string" ? body.code : "";
  const result = await verifyEmailCode(env, {
    product: PORTAL_EMAIL_SCOPE,
    recipient: flow.email,
    flowId: ref.id,
    code,
    req,
  });
  if (!result.ok) {
    const attempts = flow.attempts + 1;
    await updateArtefact(env, ref, {
      expect: { rev: flow.rev },
      set: { attempts, rev: flow.rev + 1 },
    });
    const triesLeft = Math.max(0, EMAIL_CODE_MAX_ATTEMPTS - attempts);
    return cardJson(
      {
        error: "invalid_code",
        message: wrongCodeMessage(triesLeft),
        triesLeft,
      },
      400,
    );
  }
  // One completion only: of two racing submissions, one gets the flow.
  if (!(await consumeArtefact(env, ref))) return codeExpired();
  // Proven now, so whose it is may be said. An address another account uses (as a method or as
  // its verified primary email) is never verified on this one too.
  if (await accountUsingEmail(db, flow.email, caller.accountId)) {
    return cardJson(
      {
        error: "link_conflict",
        message:
          "Another Polaris Key account uses this email. Link that account instead, or use a different email.",
      },
      409,
    );
  }
  const linked = await linkIdentity(
    { db, env, now, origin: originOf(req) },
    { accountId: caller.accountId, authenticatedAt: caller.authenticatedAt },
    {
      issuerKey: EMAIL_ISSUER,
      subject: flow.email,
      kind: "email",
      email: flow.email,
      emailVerified: true,
    },
  );
  if (!linked.ok) {
    if (linked.error === "step_up_required") return stepUpRequired();
    if (linked.error === "link_conflict") {
      return cardJson(
        {
          error: "link_conflict",
          message:
            "Another Polaris Key account uses this email. Link that account instead, or use a different email.",
        },
        409,
      );
    }
    return cardJson({ error: "not_found" }, 404);
  }
  // An account without a confirmed email (a Steam-only one) takes this address as its primary.
  await db.run(
    `UPDATE accounts SET primary_email = ?, primary_email_verified_at = ?, modified_at = ?
      WHERE id = ? AND (primary_email IS NULL OR primary_email_verified_at IS NULL)`,
    flow.email,
    now,
    now,
    caller.accountId,
  );
  return cardJson(
    {
      status: "connected",
      already: linked.already,
      email: flow.email,
      method: { id: linked.link.id, kind: "email" },
    },
    linked.already ? 200 : 201,
  );
}

// ── Disconnect ──────────────────────────────────────────────────────────────────────────────

/** `DELETE /api/me/methods/<id>`. */
async function removeMethod(
  req: Request,
  env: Env,
  db: Db,
  caller: MethodsCaller,
  methodId: string,
  now: number,
): Promise<Response> {
  if (!(await changesAllowed(env, caller, now)))
    return cardJson({ error: "rate_limited" }, 429);
  const links = await listLinks(db, caller.accountId);
  const link = links.find((l) => l.id === methodId);
  if (!link) return cardJson({ error: "not_found" }, 404);
  // Both guards (`last_link`, `only_email`) and the primary email's promotion are inside the
  // link engine's guarded batch, so two concurrent removals cannot get past them; step-up is
  // checked there too.
  const result = await unlinkIdentity(
    { db, env, now, origin: originOf(req) },
    { accountId: caller.accountId, authenticatedAt: caller.authenticatedAt },
    link.id,
    { emailRule: true },
  );
  if (!result.ok) {
    if (result.error === "step_up_required") return stepUpRequired();
    if (result.error === "only_email") {
      return cardJson(
        {
          error: "forbidden",
          reason: "only_email",
          message:
            "This is your account's only email address. Add another one first, then you can remove it.",
        },
        403,
      );
    }
    if (result.error === "last_link") {
      return cardJson(
        {
          error: "last_link",
          message: `This is your only way to sign in. Connect another one first, then you can remove ${link.kind === "email" ? "this email" : (LABEL[link.kind] ?? "it")}.`,
        },
        409,
      );
    }
    return cardJson({ error: "not_found" }, 404);
  }
  return cardJson({ ok: true, removed: { id: link.id, kind: link.kind } });
}
