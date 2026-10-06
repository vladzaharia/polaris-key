/**
 * The email gate: the required interstitial on a first provider sign-in (I-07; S-16 owner
 * decisions "confirm the email on first provider sign-in" and "email confirmation offers to join
 * accounts"; PORTAL.md §4.29, G31).
 *
 * ── THE SEAM ────────────────────────────────────────────────────────────────────────────────
 *
 * A provider front door (Apple, Google and Steam with I-06; the platform identities with I-13 and
 * I-14; passthrough with I-08) verifies its credential its own way and calls
 * `beginProviderSignIn` with the verified identity, what the provider said about the person
 * (`ImportedProfile`), and the product context. That call either signs in at once (a known link
 * whose account already confirmed an email and accepted any required terms) or opens a gate: a
 * server-held record in I-02's single-use store, named by a secret in a host-only cookie
 * (`__Host-pkey_gate`, 15 minutes), and redirects to the card, which renders the step from
 * `GET /api/signin/confirm-email`. NO account row and NO session exist until the gate passes.
 *
 * ── THE RULES ───────────────────────────────────────────────────────────────────────────────
 *
 *   - It runs once per account: an account with a confirmed email never sees it again, whichever
 *     method it later uses (Terms aside: a product's new terms version asks again).
 *   - The email is prefilled from the provider, an Apple private-relay address included, and can
 *     be switched to a typed one. A PROVIDER-VERIFIED address is accepted without a code (owner,
 *     2026-10-04): Apple's always (relay included), and Google's only when `email_verified` is
 *     true AND the address is `@gmail.com`/`@googlemail.com` or the token's `hd` claim equals the
 *     address's domain (Workspace; lead decision 2026-10-06, `providerVouchesForEmail`). A typed
 *     address, or a provider address that is not vouched for, gets a 6-digit code on I-02's
 *     store, bound to this gate. Steam and other providers with no email start with an empty
 *     field.
 *   - Terms: when the product requires them, the gate does not pass until this version is ticked;
 *     acceptances are stored per account, product and version (`account_terms_acceptances`,
 *     `accounts/terms.ts`, PX-W15), and a new version asks again.
 *   - The confirmed email becomes the account's primary email and an email sign-in method.
 *   - If the confirmed email already belongs to another account (known only AFTER it was proven,
 *     so nothing is enumerated), the gate stops with `email_in_use` and OFFERS to join. It never
 *     joins silently and never by email match: both identities must be proven in one session.
 *     The provider identity is proven by this gate; the other account by a code to that address
 *     only when the address is an active email sign-in method on that account, or else by a fresh
 *     (5-minute) account session for it in this browser, from any of its methods. Joining links a
 *     new identity to that account (`linkIdentity`), or merges when the identity already had an
 *     account (`mergeAccounts`, D21: the existing account survives). Declining is choosing a
 *     different email.
 */

import {
  hashKey,
  randomId,
  type Db,
  type Env,
} from "../../../core/platform.js";
import {
  artefactRef,
  consumeArtefact,
  deleteArtefact,
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
  EMAIL_GATE_COOKIE,
  accountRealmCookie,
  clearAccountRealmCookie,
  readCookie,
} from "../../../core/accountCookies.js";
import { portalAudit } from "../portal/repo.js";
import { portalEmailConfigured, sendSignInEmail } from "../portal/email.js";
import {
  checkAccountSession,
  randomSecret,
} from "../portal/accountSessions.js";
import {
  portalSessionAuthenticatedAt,
  portalSessionFromRequest,
} from "../portal/session.js";
import {
  normalizeIdentity,
  signIn,
  type VerifiedIdentity,
} from "../accounts/signIn.js";
import {
  EMAIL_ISSUER,
  accountUsingEmail,
  findLink,
  getAccountRow,
  insertLink,
  normalizeEmail,
  resolveAccount,
  touchAccountSignIn,
  touchLink,
  type AccountRow,
} from "../accounts/repo.js";
import { isFresh, linkIdentity } from "../accounts/links.js";
import {
  recordTermsAcceptance,
  termsAccepted,
  type TermsRequirement,
} from "../accounts/terms.js";
import { mergeAccounts } from "../accounts/merge.js";
import { providerVouchesForEmail } from "../providers/vouch.js";
import { clientIp, rateLimitOk } from "../../../core/rateLimit.js";
import {
  CODE_VERIFY_PER_IP_MINUTE,
  emailUnavailable,
  PORTAL_EMAIL_SCOPE,
} from "./emailSignIn.js";
import { finishSignIn } from "./finish.js";
import {
  cardJson,
  cardPage,
  cardRedirect,
  originOf,
  parseEmail,
  readJsonObject,
  signInAgainAction,
  wrongCodeMessage,
} from "./http.js";
import { fetchProviderPicture } from "./avatars.js";
import {
  importProfile,
  sanitizeDisplayName,
  sanitizeLocale,
  type ImportedProfile,
} from "./profile.js";

/** How long a gate waits for the person. */
export const GATE_TTL_SECONDS = 15 * 60;
/** Where a front door sends the browser once a gate is open: the card renders the step. */
export const EMAIL_GATE_LANDING = "/?signin=confirm-email";

export type { TermsRequirement };
export { providerVouchesForEmail };

/** What a provider front door hands the gate. */
export interface ProviderSignIn {
  identity: VerifiedIdentity;
  profile?: ImportedProfile;
  product?: {
    slug: string;
    tenantScopes?: readonly string[];
    terms?: TermsRequirement | null;
  } | null;
  /** Google only: the signed `hd` claim (the Workspace domain), for `providerVouchesForEmail`. */
  hostedDomain?: string | null;
  /** Where to go afterwards: a same-origin path the front door already checked. */
  returnTo?: string | null;
  /** I-08's passthrough request handle, opaque here and handed back when the gate passes. */
  request?: string | null;
}

type Identity = NonNullable<ReturnType<typeof normalizeIdentity>>;

interface GateRecord {
  v: 1;
  rev: number;
  createdAt: number;
  identity: Identity;
  profile: ImportedProfile;
  product: string | null;
  tenantScopes: string[];
  terms: TermsRequirement | null;
  returnTo: string | null;
  request: string | null;
  /** The identity's own account, when it already has one (with no confirmed email). */
  accountId: string | null;
  /** The account already confirmed an email: only Terms are asked. */
  emailConfirmed: boolean;
  stage: "choose" | "code_sent" | "join_offer";
  pendingEmail: string | null;
  confirmedEmail: string | null;
  confirmedBy: "provider" | "code" | null;
  /** The name the person typed (an explicit choice), if any. */
  name: string | null;
  attempts: number;
  /** INTERNAL: the account the confirmed email belongs to. Never answered to anyone. */
  joinAccountId: string | null;
  /** When the code to an active email method of `joinAccountId` proved that account. */
  otherProvenAt: number | null;
}

async function gateRefFor(env: Env, secret: string): Promise<ArtefactRef> {
  return artefactRef(
    "signin-gate",
    await hashKey(`signin-gate:${secret}`, env.KEY_HASH_PEPPER),
  );
}

async function currentGate(
  env: Env,
  req: Request,
): Promise<{ ref: ArtefactRef; gate: GateRecord } | null> {
  const secret = readCookie(req.headers.get("cookie"), EMAIL_GATE_COOKIE);
  if (!secret) return null;
  const ref = await gateRefFor(env, secret);
  const raw = await getArtefact(env, ref);
  if (!raw) return null;
  try {
    return { ref, gate: JSON.parse(raw) as GateRecord };
  } catch {
    return null;
  }
}

/** Change a gate's fields atomically (a stale revision does not apply). */
async function updateGate(
  env: Env,
  ref: ArtefactRef,
  gate: GateRecord,
  set: Partial<GateRecord>,
): Promise<GateRecord | null> {
  const next = { ...set, rev: gate.rev + 1 };
  const out = await updateArtefact(env, ref, {
    expect: { rev: gate.rev },
    set: next as Record<string, unknown>,
  });
  return out.ok ? { ...gate, ...next } : null;
}

const clearGate = (): string => clearAccountRealmCookie(EMAIL_GATE_COOKIE);

function gateExpired(): Response {
  return cardJson(
    {
      error: "signin_expired",
      message: "This sign-in has expired. Start again.",
    },
    400,
    [clearGate()],
  );
}

/** A provider sign-in this card refuses (SIGN-IN.md §3.13): the heading, then **Sign in again**. */
function refusedPage(status: number, heading: string): Response {
  return cardPage(status, {
    title: "Sign in",
    heading,
    body: signInAgainAction(),
  });
}

/** "We couldn't confirm that sign-in" (SIGN-IN.md §3.13, Not verified). */
const unverifiedPage = (): Response =>
  refusedPage(401, "We couldn't confirm that sign-in");

/** "This account can't sign in" (SIGN-IN.md §3.13, Account disabled). */
function accountDisabledPage(): Response {
  return cardPage(403, {
    title: "Sign in",
    heading: "This account can't sign in",
    body: "<p>Contact Polaris Key support.</p>",
  });
}

/** Whether the account still has to accept `terms` (no row for this version yet). */
async function needsTerms(
  db: Db,
  account: AccountRow | null,
  product: string | null,
  terms: TermsRequirement | null,
): Promise<boolean> {
  if (!terms || !product) return false;
  if (!account) return true;
  return !(await termsAccepted(db, account.id, product, terms.version));
}

/**
 * The provider front doors' one entry (I-06, I-08, I-13, I-14). Answers the redirect the front
 * door returns: straight to `returnTo` with an account session when no gate is needed, or to the
 * card's gate step with the gate cookie set. A refusal is a branded page.
 */
export async function beginProviderSignIn(
  req: Request,
  env: Env,
  db: Db,
  input: ProviderSignIn,
  now: number,
): Promise<Response> {
  // The provider's assertion counts only where it vouches for the address today: everything
  // downstream (the gate's fast path, the link's stored `email_verified`, which feeds the licence
  // claim rules) sees an address Google does not vouch for as unverified. The Google module
  // already narrowed it; this re-check is a no-op there and covers every other front door.
  const identity: VerifiedIdentity = {
    ...input.identity,
    emailVerified: providerVouchesForEmail(input.identity, input.hostedDomain),
  };
  const id = normalizeIdentity(identity);
  if (!id || id.kind === "email") {
    return unverifiedPage();
  }
  const scopes = [...(input.product?.tenantScopes ?? [])];
  if (id.tenantScope !== "" && !scopes.includes(id.tenantScope)) {
    return unverifiedPage();
  }
  const product = input.product?.slug ?? null;
  const terms = input.product?.terms ?? null;
  const profile: ImportedProfile = input.profile ?? {};
  const link = await findLink(db, {
    issuerKey: id.issuerKey,
    tenantScope: id.tenantScope,
    subject: id.subject,
  });
  let account: AccountRow | null = null;
  if (link) {
    account = await resolveAccount(db, link.account_id, now);
    if (!account || account.status !== "active") {
      return accountDisabledPage();
    }
    const emailConfirmed = account.primary_email_verified_at !== null;
    if (emailConfirmed && !(await needsTerms(db, account, product, terms))) {
      const result = await signIn(db, identity, now, {
        product: product ? { slug: product, tenantScopes: scopes } : undefined,
      });
      if (result.status !== "signed_in") {
        return accountDisabledPage();
      }
      await importProfile(
        env,
        db,
        {
          accountId: result.account.id,
          linkId: result.linkId,
          profile,
          fill: "refresh",
        },
        now,
      );
      const fresh =
        (await getAccountRow(db, result.account.id)) ?? result.account;
      const finished = await finishSignIn(
        env,
        db,
        req,
        fresh,
        {
          amr: [id.kind],
          action: `portal.login.${id.kind}`,
          summary: `Signed in with ${id.kind}`,
        },
        now,
      );
      return cardRedirect(input.returnTo ?? "/", [finished.cookie]);
    }
  }
  const secret = randomSecret(32);
  const ref = await gateRefFor(env, secret);
  const gate: GateRecord = {
    v: 1,
    rev: 0,
    createdAt: now,
    identity: id,
    profile: {
      name: sanitizeDisplayName(profile.name) ?? id.displayName,
      pictureUrl:
        typeof profile.pictureUrl === "string" ? profile.pictureUrl : null,
      locale: sanitizeLocale(profile.locale),
    },
    product,
    tenantScopes: scopes,
    terms,
    returnTo: input.returnTo ?? null,
    request: input.request ?? null,
    accountId: account?.id ?? null,
    emailConfirmed: account?.primary_email_verified_at != null,
    stage: "choose",
    pendingEmail: null,
    confirmedEmail: null,
    confirmedBy: null,
    name: null,
    attempts: 0,
    joinAccountId: null,
    otherProvenAt: null,
  };
  await putArtefact(env, ref, JSON.stringify(gate), GATE_TTL_SECONDS);
  return cardRedirect(EMAIL_GATE_LANDING, [
    accountRealmCookie(EMAIL_GATE_COOKIE, secret, GATE_TTL_SECONDS),
  ]);
}

/** The card's view of a gate. Carries no account id and nothing about another account. */
async function gateView(db: Db, gate: GateRecord): Promise<unknown> {
  const productName = gate.product
    ? ((
        await db.first<{ name: string | null }>(
          "SELECT name FROM products WHERE slug = ?",
          gate.product,
        )
      )?.name ?? gate.product)
    : null;
  const providerEmail = gate.identity.email;
  return {
    status: "gate",
    provider: gate.identity.kind,
    stage: gate.stage,
    expiresAt: gate.createdAt + GATE_TTL_SECONDS,
    emailRequired: !gate.emailConfirmed,
    email: {
      provider: providerEmail,
      providerVerified: Boolean(providerEmail && gate.identity.emailVerified),
      relay: providerEmail ? isApplePrivateRelay(providerEmail) : false,
      pending: gate.pendingEmail,
      confirmed: gate.confirmedEmail,
    },
    profile: {
      name: gate.name ?? gate.profile.name ?? null,
      nameExplicit: gate.name !== null,
      picture: gate.profile.pictureUrl
        ? "/api/signin/confirm-email/picture"
        : null,
      locale: gate.profile.locale ?? null,
    },
    terms: gate.terms,
    product: gate.product ? { slug: gate.product, name: productName } : null,
    ...(gate.stage === "join_offer"
      ? {
          join: {
            email: gate.confirmedEmail,
            proven: gate.otherProvenAt !== null,
          },
        }
      : {}),
  };
}

/** Every `/api/signin/confirm-email…` route. `rest` is what follows `confirm-email`. */
export async function handleEmailGate(
  req: Request,
  env: Env,
  db: Db,
  rest: string[],
  now: number,
): Promise<Response> {
  const found = await currentGate(env, req);
  if (!found) return gateExpired();
  const { ref, gate } = found;
  const [action] = rest;
  if (action === undefined) {
    if (req.method === "GET") return cardJson(await gateView(db, gate));
    if (req.method === "POST") return gateChoose(req, env, db, ref, gate, now);
    return cardJson({ error: "method_not_allowed" }, 405);
  }
  if (rest.length !== 1) return cardJson({ error: "not_found" }, 404);
  if (action === "picture" && req.method === "GET") return gatePicture(gate);
  if (req.method !== "POST")
    return cardJson({ error: "method_not_allowed" }, 405);
  switch (action) {
    case "verify":
      return gateVerify(req, env, db, ref, gate, now);
    case "join":
      return gateJoin(req, env, db, ref, gate, now);
    case "cancel":
      await deleteArtefact(env, ref).catch(() => undefined);
      return cardJson({ status: "cancelled" }, 200, [clearGate()]);
    default:
      return cardJson({ error: "not_found" }, 404);
  }
}

/** The provider's picture, proxied for the gate (copied to R2 only once the gate passes). */
async function gatePicture(gate: GateRecord): Promise<Response> {
  const url = gate.profile.pictureUrl;
  const picture = url ? await fetchProviderPicture(url) : null;
  if (!picture) return cardJson({ error: "not_found" }, 404);
  return new Response(picture.bytes, {
    status: 200,
    headers: {
      "content-type": picture.contentType,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

/** `POST /api/signin/confirm-email {choice, email?, name?, termsVersion?}`. */
async function gateChoose(
  req: Request,
  env: Env,
  db: Db,
  ref: ArtefactRef,
  gate: GateRecord,
  now: number,
): Promise<Response> {
  const body = await readJsonObject(req);
  if (!body)
    return cardJson({ error: "bad_request", message: "invalid json" }, 400);
  if (gate.terms && body.termsVersion !== gate.terms.version) {
    return cardJson(
      {
        error: "terms_required",
        message: "Agree to the terms to continue.",
        terms: gate.terms,
      },
      400,
    );
  }
  const typedName = sanitizeDisplayName(body.name);
  const name =
    typedName && typedName !== (gate.profile.name ?? null) ? typedName : null;
  if (gate.emailConfirmed) {
    const named = await updateGate(env, ref, gate, { name });
    if (!named) return gateExpired();
    return gatePass(req, env, db, ref, named, null, now);
  }
  const providerEmail = gate.identity.email;
  const providerVerified = Boolean(
    providerEmail && gate.identity.emailVerified,
  );
  let email: string | null;
  if (body.choice === "provider") {
    if (!providerEmail) {
      return cardJson(
        { error: "bad_request", message: "this provider shared no email" },
        400,
      );
    }
    email = providerEmail;
  } else if (body.choice === "typed") {
    email = parseEmail(body.email);
    if (!email) {
      return cardJson(
        { error: "bad_request", message: "valid email required" },
        422,
      );
    }
  } else {
    return cardJson(
      { error: "bad_request", message: "choice must be provider or typed" },
      400,
    );
  }
  // The owner's fast path: an address the provider asserted as verified needs no code of ours.
  if (providerVerified && email === providerEmail) {
    const chosen = await updateGate(env, ref, gate, {
      name,
      confirmedEmail: email,
      confirmedBy: "provider",
      pendingEmail: null,
    });
    if (!chosen) return gateExpired();
    return gateConfirmed(req, env, db, ref, chosen, now);
  }
  if (!portalEmailConfigured(env)) return emailUnavailable();
  // Enumeration-safe: the same answer whether the address is known, unknown or refused a send.
  const { send } = await checkEmailSend(
    env,
    { product: PORTAL_EMAIL_SCOPE, recipient: email, req },
    now,
  );
  if (send) {
    const { code } = await issueEmailCode(
      env,
      { product: PORTAL_EMAIL_SCOPE, recipient: email, flowId: ref.id },
      JSON.stringify({ gate: ref.id }),
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
  const pending = await updateGate(env, ref, gate, {
    name,
    stage: "code_sent",
    pendingEmail: email,
    confirmedEmail: null,
    confirmedBy: null,
    attempts: 0,
    joinAccountId: null,
    otherProvenAt: null,
  });
  if (!pending) return gateExpired();
  return cardJson({
    status: "code_sent",
    email,
    expiresIn: EMAIL_CODE_TTL_SECONDS,
    codeLength: EMAIL_CODE_DIGITS,
  });
}

/** `POST /api/signin/confirm-email/verify {code}`. */
async function gateVerify(
  req: Request,
  env: Env,
  db: Db,
  ref: ArtefactRef,
  gate: GateRecord,
  now: number,
): Promise<Response> {
  if (gate.stage !== "code_sent" || !gate.pendingEmail) {
    return cardJson({ error: "bad_request", message: "no code was sent" }, 400);
  }
  // Same per-IP bucket as the email card's verify: defence in depth on top of I-02's
  // per-code and per-recipient attempt limits.
  const allowed = await rateLimitOk(
    env,
    PORTAL_EMAIL_SCOPE,
    {
      bucket: "portalCodeVerify",
      id: clientIp(req),
      limit: CODE_VERIFY_PER_IP_MINUTE,
      windowSec: 60,
    },
    now,
  );
  if (!allowed) return cardJson({ error: "rate_limited" }, 429);
  const body = await readJsonObject(req);
  const code = typeof body?.code === "string" ? body.code : "";
  const result = await verifyEmailCode(env, {
    product: PORTAL_EMAIL_SCOPE,
    recipient: gate.pendingEmail,
    flowId: ref.id,
    code,
  });
  if (!result.ok) {
    const attempts = gate.attempts + 1;
    await updateGate(env, ref, gate, { attempts });
    return cardJson(
      {
        error: "invalid_code",
        message: wrongCodeMessage(
          Math.max(0, EMAIL_CODE_MAX_ATTEMPTS - attempts),
        ),
        triesLeft: Math.max(0, EMAIL_CODE_MAX_ATTEMPTS - attempts),
      },
      400,
    );
  }
  const confirmed = await updateGate(env, ref, gate, {
    confirmedEmail: gate.pendingEmail,
    confirmedBy: "code",
    pendingEmail: null,
  });
  if (!confirmed) return gateExpired();
  return gateConfirmed(req, env, db, ref, confirmed, now);
}

/** Whether `email` is an active email sign-in method of `accountId`. */
async function isEmailMethodOf(
  db: Db,
  accountId: string,
  email: string,
): Promise<boolean> {
  const link = await findLink(db, {
    issuerKey: EMAIL_ISSUER,
    tenantScope: "",
    subject: email,
  });
  return link?.account_id === accountId;
}

/** An email was proven: offer to join if it is another account's, else pass the gate. */
async function gateConfirmed(
  req: Request,
  env: Env,
  db: Db,
  ref: ArtefactRef,
  gate: GateRecord,
  now: number,
): Promise<Response> {
  const email = gate.confirmedEmail!;
  const other = await accountUsingEmail(db, email, gate.accountId);
  if (other) {
    // Known only now, after the address was proven: nothing was enumerated.
    const proven =
      gate.confirmedBy === "code" && (await isEmailMethodOf(db, other, email));
    const offered = await updateGate(env, ref, gate, {
      stage: "join_offer",
      joinAccountId: other,
      otherProvenAt: proven ? now : null,
    });
    if (!offered) return gateExpired();
    return cardJson(
      {
        error: "email_in_use",
        message:
          "A Polaris Key account already uses this email. Join this sign-in to that account, or use a different email.",
        email,
        proven,
      },
      409,
    );
  }
  return gatePass(req, env, db, ref, gate, email, now);
}

/** The gate passes: the account is created or completed, and the session opens. */
async function gatePass(
  req: Request,
  env: Env,
  db: Db,
  ref: ArtefactRef,
  gate: GateRecord,
  email: string | null,
  now: number,
): Promise<Response> {
  // One completion only: of two racing submissions, one gets the gate.
  if (!(await consumeArtefact(env, ref))) return gateExpired();
  const id = gate.identity;
  const key = {
    issuerKey: id.issuerKey,
    tenantScope: id.tenantScope,
    subject: id.subject,
  };
  let accountId: string;
  let linkId: string;
  let created = false;
  if (gate.accountId) {
    const account = await getAccountRow(db, gate.accountId);
    const link = await findLink(db, key);
    if (!account || account.status !== "active" || !link) {
      return gateRefused(403, ACCOUNT_DISABLED);
    }
    if (email) {
      const added = await addEmailMethod(db, account.id, email, now);
      if (!added) return emailTaken();
      await db.run(
        `UPDATE accounts SET primary_email = ?, primary_email_verified_at = ?, modified_at = ?
          WHERE id = ?`,
        email,
        now,
        now,
        account.id,
      );
    }
    await touchLink(
      db,
      link.id,
      {
        email: id.email,
        emailVerified: id.emailVerified,
        displayName: id.displayName,
      },
      now,
    );
    await touchAccountSignIn(db, account.id, now);
    accountId = account.id;
    linkId = link.id;
  } else {
    if (!email) return gateRefused(400, "Confirm an email to continue.");
    const made = await createAccount(db, gate, email, now);
    if (!made) return emailTaken();
    accountId = made.accountId;
    linkId = made.linkId;
    created = true;
  }
  return completeGate(req, env, db, gate, { accountId, linkId, created }, now);
}

/**
 * Make the account a new provider identity gets, with the confirmed email as its first method.
 * One atomic batch: the account, its email method and the provider link go in together or not at
 * all. The links' UNIQUE key decides a race (another account taking the address, or the identity
 * linked elsewhere meanwhile): the batch fails and leaves nothing behind, so no row is ever
 * removed to undo it.
 */
async function createAccount(
  db: Db,
  gate: GateRecord,
  email: string,
  now: number,
): Promise<{ accountId: string; linkId: string } | null> {
  const id = gate.identity;
  const key = {
    issuerKey: id.issuerKey,
    tenantScope: id.tenantScope,
    subject: id.subject,
  };
  if (await accountUsingEmail(db, email)) return null;
  if (await findLink(db, key)) return null;
  // A provider address the person did not choose, already verified on another account, is kept
  // on the link as unverified, so no address is verified on two accounts.
  const providerEmailVerified =
    id.emailVerified &&
    id.email !== null &&
    (id.email === email || !(await accountUsingEmail(db, id.email)));
  const accountId = randomId("acct");
  const linkId = randomId("lnk");
  const normalized = normalizeEmail(email);
  const linkSql = `INSERT INTO account_links
       (id, account_id, issuer_key, tenant_scope, subject, kind, email, email_verified,
        display_name, amr_json, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  try {
    await db.batch([
      {
        sql: `INSERT INTO accounts
                (id, status, primary_email, primary_email_verified_at, display_name,
                 created_at, modified_at, last_sign_in_at)
              VALUES (?, 'active', ?, ?, ?, ?, ?, ?)`,
        params: [
          accountId,
          normalized,
          now,
          gate.name ?? gate.profile.name ?? id.displayName ?? normalized,
          now,
          now,
          now,
        ],
      },
      {
        sql: linkSql,
        params: [
          randomId("lnk"),
          accountId,
          EMAIL_ISSUER,
          "",
          normalized,
          "email",
          normalized,
          1,
          null,
          null,
          now,
          now,
        ],
      },
      {
        sql: linkSql,
        params: [
          linkId,
          accountId,
          key.issuerKey,
          key.tenantScope,
          key.subject,
          id.kind,
          id.email ? normalizeEmail(id.email) : null,
          providerEmailVerified ? 1 : 0,
          id.displayName,
          id.amr ? JSON.stringify(id.amr) : null,
          now,
          now,
        ],
      },
    ]);
  } catch {
    return null;
  }
  await portalAudit(db, {
    accountId,
    action: "account.create",
    targetKind: "account",
    targetId: accountId,
    summary: `Account created by a ${id.kind} sign-in`,
    now,
  });
  return { accountId, linkId };
}

/** Add `email` as an email sign-in method of `accountId`. False when another account holds it. */
async function addEmailMethod(
  db: Db,
  accountId: string,
  email: string,
  now: number,
): Promise<boolean> {
  await insertLink(
    db,
    accountId,
    {
      issuerKey: EMAIL_ISSUER,
      tenantScope: "",
      subject: email,
      kind: "email",
      email,
      emailVerified: true,
      displayName: null,
      amr: null,
    },
    now,
  );
  return isEmailMethodOf(db, accountId, email);
}

function emailTaken(): Response {
  return cardJson(
    {
      error: "email_in_use",
      message:
        "A Polaris Key account already uses this email. Start again to join it or use a different email.",
    },
    409,
    [clearGate()],
  );
}

/** The JSON refusal's message for a disabled account (SIGN-IN.md §3.13). */
const ACCOUNT_DISABLED =
  "This account can't sign in. Contact Polaris Key support.";

function gateRefused(status: number, message: string): Response {
  return cardJson({ error: "forbidden", message }, status, [clearGate()]);
}

/** Terms, profile, audit and the session: the end of every passed gate. */
async function completeGate(
  req: Request,
  env: Env,
  db: Db,
  gate: GateRecord,
  done: {
    accountId: string;
    linkId: string;
    created: boolean;
    joined?: boolean;
  },
  now: number,
): Promise<Response> {
  if (gate.terms && gate.product) {
    await recordTermsAcceptance(
      db,
      done.accountId,
      gate.product,
      gate.terms,
      now,
    );
  }
  await importProfile(
    env,
    db,
    {
      accountId: done.accountId,
      linkId: done.linkId,
      profile: gate.profile,
      explicitName: gate.name,
      fill: done.created ? "new" : "refresh",
    },
    now,
  );
  const account = await getAccountRow(db, done.accountId);
  if (!account) return gateRefused(403, ACCOUNT_DISABLED);
  const finished = await finishSignIn(
    env,
    db,
    req,
    account,
    {
      amr: [gate.identity.kind],
      action: `portal.login.${gate.identity.kind}`,
      summary: done.joined
        ? `Signed in with ${gate.identity.kind} and joined it to this account`
        : `Signed in with ${gate.identity.kind} after confirming the email`,
    },
    now,
  );
  return cardJson(
    {
      status: "signed_in",
      next: gate.returnTo ?? "/",
      nudge: finished.nudge,
      ...(done.joined ? { joined: true } : {}),
      ...(gate.request ? { request: gate.request } : {}),
    },
    200,
    [finished.cookie, clearGate()],
  );
}

/** `POST /api/signin/confirm-email/join`: take the offer, with proof of both identities. */
async function gateJoin(
  req: Request,
  env: Env,
  db: Db,
  ref: ArtefactRef,
  gate: GateRecord,
  now: number,
): Promise<Response> {
  if (gate.stage !== "join_offer" || !gate.joinAccountId) {
    return cardJson(
      { error: "bad_request", message: "there is nothing to join" },
      400,
    );
  }
  const other = gate.joinAccountId;
  // Proof of the other account: the code to its active email method (fresh), or a fresh account
  // session for it in this browser, from any of its methods. Never the email match alone.
  let otherAt: number | null =
    gate.otherProvenAt !== null &&
    isFresh({ accountId: other, authenticatedAt: gate.otherProvenAt }, now)
      ? gate.otherProvenAt
      : null;
  if (otherAt === null) {
    const session = await portalSessionFromRequest(env, req, now);
    const live = session
      ? await checkAccountSession(env, db, session, now)
      : null;
    if (session && live?.accountId === other) {
      const at = portalSessionAuthenticatedAt(session);
      if (isFresh({ accountId: other, authenticatedAt: at }, now)) otherAt = at;
    }
  }
  if (otherAt === null) {
    return cardJson(
      {
        error: "step_up_required",
        message:
          "Sign in to the Polaris Key account that uses this email, then join.",
      },
      403,
    );
  }
  if (!(await consumeArtefact(env, ref))) return gateExpired();
  const ctx = { db, env, now, origin: originOf(req) };
  const proof = { accountId: other, authenticatedAt: otherAt };
  if (!gate.accountId) {
    const linked = await linkIdentity(ctx, proof, gate.identity);
    if (!linked.ok) {
      return linked.error === "link_conflict"
        ? cardJson({ error: "link_conflict" }, 409, [clearGate()])
        : linked.error === "step_up_required"
          ? cardJson({ error: "step_up_required" }, 403, [clearGate()])
          : gateRefused(403, ACCOUNT_DISABLED);
    }
    return completeGate(
      req,
      env,
      db,
      gate,
      {
        accountId: other,
        linkId: linked.link.id,
        created: false,
        joined: true,
      },
      now,
    );
  }
  // Both sides are accounts: a merge under I-05's rules; the email's account survives (D21).
  const merged = await mergeAccounts(ctx, {
    survivor: proof,
    absorbed: { accountId: gate.accountId, authenticatedAt: gate.createdAt },
  });
  if (!merged.ok) {
    return merged.reason === "step_up_required"
      ? cardJson(
          {
            error: "step_up_required",
            message: "Sign in again with both accounts to join them.",
          },
          403,
          [clearGate()],
        )
      : gateRefused(403, "These accounts can't be joined.");
  }
  const link = await findLink(db, {
    issuerKey: gate.identity.issuerKey,
    tenantScope: gate.identity.tenantScope,
    subject: gate.identity.subject,
  });
  if (!link) return gateRefused(403, ACCOUNT_DISABLED);
  return completeGate(
    req,
    env,
    db,
    gate,
    { accountId: other, linkId: link.id, created: false, joined: true },
    now,
  );
}
