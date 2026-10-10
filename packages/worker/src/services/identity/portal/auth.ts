import { isSameOriginRequest } from "../../../core/accounts/browserRequestGuard.js";
import {
  authorizationUrl,
  discover,
  newFlowSecrets,
  redeemAuthorizationCode,
} from "../../../core/oidc/client.js";
import {
  audienceCovers,
  connectionRelyingParty,
  openConnectionSecret,
  resolveConnection,
  verifiedDomains,
  type Connection,
} from "../../../core/oidc/connections.js";
import { strictEmail } from "../../../core/strictEmail.js";
import { brandedHtmlSecurityHeaders } from "../../../core/securityHeaders.js";
import { escapeHtml } from "../../../platform/html.js";
import { hashKey } from "../../../platform/crypto.js";
import { isSameOriginNavigation } from "../../../platform/http.js";
import {
  PORTAL_SIGNIN_RETURN_TO,
  safeReturnTo,
} from "../../../platform/returnTo.js";
import { randomToken } from "../../../platform/random.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { clientNetwork, rateLimitOk } from "../../../core/rateLimit.js";
import {
  artefactRef,
  consumeArtefact,
  getArtefact,
  putArtefact,
  type ArtefactRef,
} from "../../../core/singleUse.js";
import {
  portalIdentityIssuerKey,
  rekeyLegacyPortalIdentities,
  portalAuthCapabilities,
} from "./repo.js";
import { type SignInResult } from "../accounts/signIn.js";
import { findLink, rekeyLegacyAccountLinks } from "../accounts/repo.js";
import {
  platformSignInEnded,
  platformSignInPolicy,
  PLATFORM_SIGNIN_ENDED,
} from "../accounts/platformMigration.js";
import { beginProviderSignIn } from "../card/gate.js";
import { connectionIdentity } from "../connections/claims.js";
import { autoLinkThroughDomain } from "../connections/autoLink.js";
import {
  PLATFORM_ENV_CONNECTION_ID,
  platformEnvConnection,
} from "../connections/seed.js";
import { accountDisabledPage } from "../card/http.js";
import { buildPortalClearCookie, portalSessionFromRequest } from "./session.js";
import { revokeSessionByHash, sessionIdHash } from "./accountSessions.js";
import {
  handleMagicConfirm,
  handleMagicLanding,
  handleSigninEmailStart,
} from "../card/emailSignIn.js";

export { portalMagicKey } from "../card/emailSignIn.js";
import { appSecurityHeaders as portalSecurityHeaders } from "../../../core/securityHeaders.js";
import { renderBrandPage } from "../../../core/brandHtml.js";
import {
  LINK_FLOW_COOKIE,
  PORTAL_SSO_COOKIE,
  accountRealmCookie,
  clearAccountRealmCookie,
  readCookie,
} from "../../../core/accounts/accountCookies.js";

const FLOW_TTL_SECONDS = 600;

/**
 * Single-use store address (`core/singleUse.ts`, I-02) of an in-flight portal OIDC sign-in,
 * by its `state`. Both portal credentials live there rather than in KV because KV `get` then
 * `delete` is not atomic (G15): two racing callbacks, or two clicks on one magic link, could
 * both be served. The store's `consume` hands a record out at most once.
 *
 * R12-04: both portal credentials (the OIDC `state` and the magic-link token) used to be the
 * key name verbatim, so a listing alone was a credential dump: a live `state` beside its PKCE
 * `verifier`, and a working magic-link token beside the victim's email. The address is the
 * secret's hash under `KEY_HASH_PEPPER`, so a listing stays inert.
 *
 * Exported for tests that plant or inspect a flow record.
 */
export async function portalFlowKey(
  env: Env,
  state: string,
): Promise<ArtefactRef> {
  return artefactRef("portal-flow", await hashKey(state, env.KEY_HASH_PEPPER));
}

interface FlowRecord {
  verifier: string;
  nonce: string;
  redirectUri: string;
  returnTo?: string;
  /** I-30: the connection the flow was started through (absent on a pre-I-30 flow: the seeded
   *  platform connection, whose redirect URI it shares). */
  connectionId?: string;
  /** I-17: the peppered hash of the `__Host-pkey_sso` cookie `/login` set on the browser that
   *  started the flow. `/callback` completes only in that browser. */
  bindingHash?: string;
}

/**
 * A sign-in error page: the branded, script-free shell (`core/brandHtml.ts`) with no surface
 * label (SIGN-IN.md §3.13, D-32). `heading` is a hard-coded literal, escaped anyway; `body` is
 * TRUSTED markup. **Sign in again** is offered where one can help (by default on a 400, 401 or
 * 502).
 */
export function htmlError(
  status: number,
  heading: string,
  opts: { body?: string; retry?: boolean } = {},
): Response {
  const retry =
    opts.retry ?? (status === 400 || status === 401 || status === 502);
  return new Response(
    renderBrandPage({
      title: "Sign in",
      heading,
      body:
        (opts.body ?? "") +
        (retry
          ? `<p class="actions"><a class="button" href="${escapeHtml("/")}">Sign in again</a></p>` // signin.again
          : ""),
    }),
    {
      status,
      headers: brandedHtmlSecurityHeaders(
        new Headers({
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        }),
      ),
    },
  );
}

/**
 * The Worker sign-in pages of SIGN-IN.md §3.13, shared by the platform-OIDC and the provider
 * sign-ins. No "OIDC" or "portal" in UI copy.
 */
export const signInPage = {
  /** Too many attempts: no button, the wait is the advice. */
  tooMany: (): Response =>
    htmlError(429, "Too many sign-in attempts", {
      body: "<p>Wait a minute, then try again.</p>",
    }),
  /** Sign-in is off (no product context on these routes): `signin.off.any`. */
  off: (): Response =>
    htmlError(404, "Sign-in is unavailable. Try again later.", {
      retry: false,
    }),
  /** The provider round trip's state expired or is unknown (D-31: not called a link). */
  tookTooLong: (): Response => htmlError(400, "This sign-in took too long"),
  /** The provider failed or is unreachable. */
  unavailable: (provider?: string): Response =>
    htmlError(
      502,
      provider
        ? `${provider} sign-in isn't working right now`
        : "Sign-in isn't working right now",
      { body: "<p>Try another way to sign in.</p>" },
    ),
  /** The identity could not be verified. */
  unverified: (): Response =>
    htmlError(401, "We couldn't confirm that sign-in"),
  /** The account is disabled: **Sign in with another account**, back to where the sign-in was
   *  headed (`returnTo`, already checked) or the sign-in page (`card/http.ts`). */
  accountDisabled: (returnTo?: string | null): Response =>
    accountDisabledPage({ signInHref: returnTo }),
  /** I-17: the platform IdP no longer signs this person in (past the sunset, or
   *  `operators-only` for a subject that never moved). **Sign in again** goes to the card. */
  platformEnded: (): Response =>
    htmlError(403, PLATFORM_SIGNIN_ENDED.heading, {
      body: `<p>${escapeHtml(PLATFORM_SIGNIN_ENDED.body)}</p>`,
      retry: true,
    }),
};

function authJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: portalSecurityHeaders(
      new Headers({
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      }),
    ),
  });
}

/**
 * `GET /login`: the platform's single sign-on, which is the env-seeded platform connection
 * (I-30; plans/I-27.md §2.3 "Pocket ID": the seeded row is the connection's only source).
 */
export async function handlePortalLogin(
  req: Request,
  env: Env,
  db: Db,
  now: number = Math.floor(Date.now() / 1000),
): Promise<Response> {
  return handleConnectionLogin(req, env, db, PLATFORM_ENV_CONNECTION_ID, now);
}

/** The connection a customer-facing flow may use, or `null` (an unknown, disabled, product or
 *  operators-only connection: the card never offers one). */
async function customerConnection(
  env: Env,
  db: Db,
  id: string,
  now: number,
): Promise<Connection | null> {
  const conn =
    id === PLATFORM_ENV_CONNECTION_ID
      ? await platformEnvConnection(env, db, now)
      : await resolveConnection(db, id);
  if (!conn || conn.status !== "active" || conn.scope !== "platform") {
    return null;
  }
  return audienceCovers(conn.audience, "customers") ? conn : null;
}

/** I-17's switch applies to the env-seeded connection only (the platform IdP it was written for). */
function platformPolicyEnded(conn: Connection, env: Env, now: number): boolean {
  return conn.source === "env" && platformSignInEnded(env, now);
}

/**
 * `GET /login/sso/<id>` (I-30): start a sign-in through a platform connection. The one
 * relying-party client discovers the issuer; the flow (`state`, nonce, PKCE verifier, the
 * connection) is stored single-use and bound to this browser; `login_hint` is passed on when it
 * is an address.
 */
export async function handleConnectionLogin(
  req: Request,
  env: Env,
  db: Db,
  connectionId: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<Response> {
  const ok = await rateLimitOk(
    env,
    "_portal",
    { bucket: "portalLogin", id: clientNetwork(req), limit: 20, windowSec: 60 },
    now,
  );
  if (!ok) return signInPage.tooMany();
  const caps = await portalAuthCapabilities(db);
  if (!caps.portalEnabled || !caps.oidcEnabled) {
    return signInPage.off();
  }
  const conn = await customerConnection(env, db, connectionId, now);
  if (!conn) return signInPage.off();
  // I-17: past the sunset nobody is sent to the platform IdP only to be refused on the way back.
  if (platformPolicyEnded(conn, env, now)) return signInPage.platformEnded();

  const url = new URL(req.url);
  const rawReturnTo = url.searchParams.get("return_to");
  const returnTo = safeReturnTo(req, rawReturnTo, PORTAL_SIGNIN_RETURN_TO);
  if (rawReturnTo && !returnTo) return htmlError(400, "Invalid return URL.");
  const loginHint = strictEmail(url.searchParams.get("login_hint"));

  const rp = connectionRelyingParty(conn, null);
  let discovered;
  try {
    discovered = await discover(rp);
  } catch {
    return signInPage.unavailable();
  }
  const { state, nonce, verifier, challenge } = await newFlowSecrets();
  const redirectUri = `${url.origin}/callback`;
  // I-17: the flow is bound to this browser. The IdP returns by a top-level GET, which carries a
  // `SameSite=Lax` cookie, so the callback can require it (login CSRF, and a planted join offer).
  const binding = randomToken(32);
  const flow: FlowRecord = {
    verifier,
    nonce,
    redirectUri,
    returnTo,
    connectionId: conn.id,
    bindingHash: await hashKey(binding, env.KEY_HASH_PEPPER),
  };
  await putArtefact(
    env,
    await portalFlowKey(env, state),
    JSON.stringify(flow),
    FLOW_TTL_SECONDS,
  );
  const scope = conn.claimMap.groups
    ? "openid email profile groups"
    : "openid email profile";
  return new Response(null, {
    status: 302,
    headers: portalSecurityHeaders(
      new Headers({
        location: authorizationUrl(discovered, rp, {
          redirectUri,
          scope,
          state,
          nonce,
          codeChallenge: challenge,
          extra: loginHint ? { login_hint: loginHint } : undefined,
        }),
        "set-cookie": accountRealmCookie(
          PORTAL_SSO_COOKIE,
          binding,
          FLOW_TTL_SECONDS,
        ),
        "cache-control": "no-store",
      }),
    ),
  });
}

/** `res` with the spent single sign-on binding cleared (I-17). */
function clearingBinding(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.append("set-cookie", clearAccountRealmCookie(PORTAL_SSO_COOKIE));
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/** `GET /callback`: the one redirect URI of every connection; `state` names the flow. */
export async function handlePortalCallback(
  req: Request,
  env: Env,
  db: Db,
  now: number,
): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return htmlError(400, "Missing authorization code.");
  const caps = await portalAuthCapabilities(db);
  if (!caps.portalEnabled || !caps.oidcEnabled) {
    return signInPage.off();
  }
  // The binding is checked on a read, BEFORE the atomic single-use consume, so a
  // callback from another browser cannot burn the flow of the one that started it.
  const flowKey = await portalFlowKey(env, state);
  const peeked = await getArtefact(env, flowKey);
  if (!peeked) return signInPage.tookTooLong();
  let flow: FlowRecord;
  try {
    flow = JSON.parse(peeked) as FlowRecord;
  } catch {
    return signInPage.tookTooLong();
  }
  // I-17: only the browser that started the flow may finish it. Without this, anyone could hand
  // a victim the callback URL of their own sign-in: the victim's browser would get the
  // attacker's session (login CSRF) or the attacker's email gate, whose join the victim's own
  // proof would complete onto the victim's account. Refused generically before the code is
  // exchanged; a flow without a binding (minted before this check) is refused too.
  const binding = readCookie(req.headers.get("cookie"), PORTAL_SSO_COOKIE);
  if (
    !binding ||
    !flow.bindingHash ||
    (await hashKey(binding, env.KEY_HASH_PEPPER)) !== flow.bindingHash
  ) {
    return signInPage.unverified();
  }
  // Atomic and single-use: of two racing callbacks for one `state`, one gets the flow.
  if (!(await consumeArtefact(env, flowKey))) return signInPage.tookTooLong();
  return clearingBinding(
    await completeConnectionCallback(
      req,
      env,
      db,
      flow,
      { code, iss: url.searchParams.get("iss") },
      now,
    ),
  );
}

/**
 * The rest of `/callback`, once the flow is known to be this browser's (I-30; plans/I-27.md
 * §2.3 "The rewritten `/callback`"): the one client redeems the code; the env-seeded connection
 * applies I-17's `platformSignInPolicy` first; Q1's auto-link may attach a new identity to the
 * one account that verified its address; every identity then goes through
 * `beginProviderSignIn`, so an address the connection does not vouch for reaches the email gate,
 * never an email-less account.
 */
async function completeConnectionCallback(
  req: Request,
  env: Env,
  db: Db,
  flow: FlowRecord,
  response: { code: string; iss: string | null },
  now: number,
): Promise<Response> {
  const conn = await customerConnection(
    env,
    db,
    flow.connectionId ?? PLATFORM_ENV_CONNECTION_ID,
    now,
  );
  if (!conn) return signInPage.off();
  const policy =
    conn.source === "env"
      ? platformSignInPolicy(env, now)
      : ({ kind: "as-before" } as const);
  // I-17: a flow started before the sunset is not completed after it (the flow is spent above).
  if (policy.kind === "ended") return signInPage.platformEnded();

  const rp = connectionRelyingParty(
    conn,
    await openConnectionSecret(env, db, conn.id),
  );
  let claims;
  try {
    ({ claims } = await redeemAuthorizationCode(rp, {
      code: response.code,
      iss: response.iss,
      redirectUri: flow.redirectUri,
      codeVerifier: flow.verifier,
      nonce: flow.nonce,
    }));
  } catch (err) {
    return err instanceof Error && err.name === "OidcNetworkError"
      ? signInPage.unavailable()
      : signInPage.unverified();
  }

  const identity = connectionIdentity(
    conn,
    claims,
    await verifiedDomains(db, conn.id),
  );
  if (!identity.sub.trim()) return signInPage.unverified();
  const issuerKey = portalIdentityIssuerKey(conn.issuer);
  if (conn.source === "env") {
    // A pre-I-01 row still keyed by the literal `oidc` is this IdP's subject: re-key it before
    // the lookup, or the person would get a second account (until I-28 removes the helpers).
    await rekeyLegacyPortalIdentities(db, issuerKey);
    await rekeyLegacyAccountLinks(db, issuerKey);
  }
  const known = await findLink(db, {
    issuerKey,
    tenantScope: "",
    subject: identity.sub.trim(),
  });
  // I-17's `operators-only`: an unknown subject is refused.
  if (!known && policy.kind === "claim" && policy.linkedOnly) {
    return signInPage.platformEnded();
  }
  if (!known && identity.email && identity.emailVerified) {
    await autoLinkThroughDomain(
      env,
      db,
      {
        connection: conn,
        issuerKey,
        subject: identity.sub.trim(),
        email: identity.email,
        displayName: identity.displayName,
        origin: new URL(req.url).origin,
      },
      now,
    );
  }
  return beginProviderSignIn(
    req,
    env,
    db,
    {
      identity: {
        issuerKey,
        subject: identity.sub,
        kind: "oidc",
        email: identity.email,
        emailVerified: identity.emailVerified,
        displayName: identity.displayName,
        amr: [`connection:${conn.id}`],
      },
      profile: {
        name: identity.displayName,
        pictureUrl: identity.pictureUrl,
      },
      connection: {
        id: conn.id,
        label: conn.label,
        birthdate: identity.birthdate,
      },
      linkAssertion: { groups: identity.groups, claims: identity.claims },
      amr: [`connection:${conn.id}`],
      returnTo: flow.returnTo ?? null,
    },
    now,
  );
}

/** An unknown identity whose verified email another account uses, where no join is offered. */
function emailInUsePage(): Response {
  return htmlError(
    409,
    "A Polaris Key account already uses this email address. Sign in with the method you used before. Adding another sign-in method to an account is not available yet; until it is, contact the product's support if you can no longer use that method.",
  );
}

/**
 * The page a sign-in that did not complete answers with. A join offer (an unknown identity whose
 * verified email another account already uses) is never resolved silently: the login card (I-07)
 * offers to join once the person proves the other account; until it lands, the page says so and
 * names nobody.
 */
export function signInRefusal(
  result: SignInResult,
  /** Where the sign-in was headed (already checked): the disabled page's way on. */
  returnTo?: string | null,
): Response | null {
  switch (result.status) {
    case "signed_in":
      return result.account.status === "active"
        ? null
        : signInPage.accountDisabled(returnTo);
    case "join_offer":
      return emailInUsePage();
    case "refused":
      return result.reason === "account_disabled"
        ? signInPage.accountDisabled(returnTo)
        : signInPage.unverified();
  }
}

/**
 * `POST /api/magic/start`: the pre-I-07 name of the login card's email start, kept as an alias
 * (a cached older portal bundle still calls it). Same handler, same answers: a code and a magic
 * link bound to this browser (`card/emailSignIn.ts`).
 */
export async function handleMagicStart(
  req: Request,
  env: Env,
  db: Db,
  now: number = Math.floor(Date.now() / 1000),
): Promise<Response> {
  return handleSigninEmailStart(req, env, db, now);
}

/**
 * `/magic/verify`: the magic link's landing page (I-07). `GET` consumes NOTHING, so a mail
 * scanner or link prefetcher cannot burn the link; the page's button `POST`s the token back,
 * which completes the sign-in in the browser that asked, or confirms that browser's sign-in when
 * opened anywhere else (`card/emailSignIn.ts`).
 */
export async function handleMagicVerify(
  req: Request,
  env: Env,
  db: Db,
  now: number,
): Promise<Response> {
  if (req.method === "POST") return handleMagicConfirm(req, env, db, now);
  if (req.method === "GET" || req.method === "HEAD")
    return handleMagicLanding(req, env, db);
  return new Response("Method Not Allowed", {
    status: 405,
    headers: portalSecurityHeaders(
      new Headers({ allow: "GET, POST", "cache-control": "no-store" }),
    ),
  });
}

/**
 * `POST /logout` (preferred) or a same-origin top-level `GET` navigation.
 *
 * R1-03: this used to be an unconditional `GET` that returned a clearing `Set-Cookie` with no
 * token of any kind, and the portal cookie is `SameSite=Lax` — so
 * `<img src="https://key.plrs.im/logout">` on any site was a working logout-CSRF. `POST` is
 * the correct method and is accepted unconditionally — and the portal SPA now uses it: the
 * sign-out control in `packages/admin/src/portal/App.tsx` is a form POST, not a link. `GET`
 * survives only as a compatibility bridge for a browser holding a cached older bundle, and
 * even then it is constrained to a genuine same-origin top-level navigation, which refuses
 * both the `<img>` and the cross-site-link shapes. It can be dropped once no stale bundles
 * are in circulation.
 */
export async function handlePortalLogout(
  req: Request,
  env?: Env,
  db?: Db,
  now: number = Math.floor(Date.now() / 1000),
): Promise<Response> {
  // A cross-site form POST must not sign the visitor out.
  if (
    req.method === "POST"
      ? !isSameOriginRequest(req)
      : !isSameOriginNavigation(req)
  ) {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: portalSecurityHeaders(
        new Headers({ "cache-control": "no-store" }),
      ),
    });
  }
  // I-07: signing out ends this browser's server-side session too, so the cookie is dead even
  // if it was copied before the clearing `Set-Cookie` arrived.
  if (env && db) {
    const session = await portalSessionFromRequest(env, req, now);
    if (session?.sid) {
      await revokeSessionByHash(db, await sessionIdHash(env, session.sid), now);
    }
  }
  const headers = new Headers({
    location: "/",
    "set-cookie": buildPortalClearCookie(),
    "cache-control": "no-store",
  });
  // PX-W12: a Link an existing account flow in this browser ends with the session.
  headers.append("set-cookie", clearAccountRealmCookie(LINK_FLOW_COOKIE));
  return new Response(null, {
    status: 302,
    headers: portalSecurityHeaders(headers),
  });
}
