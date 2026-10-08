import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  ALLOWED_ID_TOKEN_ALGS,
  ID_TOKEN_CLOCK_TOLERANCE,
  ID_TOKEN_MAX_AGE,
} from "../idToken.js";
import {
  brandedHtmlSecurityHeaders,
  escapeHtml,
  hashKey,
  isSameOriginNavigation,
  pkcePair,
  platformOidcConfig,
  PORTAL_SIGNIN_RETURN_TO,
  randomToken,
  safeReturnTo,
  type Db,
  type Env,
} from "../../../core/platform.js";
import { clientIp, rateLimitOk } from "../../../core/rateLimit.js";
import {
  artefactRef,
  consumeArtefact,
  putArtefact,
  type ArtefactRef,
} from "../../../core/singleUse.js";
import {
  portalIdentityIssuerKey,
  rekeyLegacyPortalIdentities,
  portalAuthCapabilities,
  portalAudit,
  recordLinkGroups,
  syncAccountLicenseLinks,
} from "./repo.js";
import { signIn, type SignInResult } from "../accounts/signIn.js";
import { rekeyLegacyAccountLinks } from "../accounts/repo.js";
import {
  claimPlatformSubject,
  platformSignInEnded,
  PLATFORM_SIGNIN_ENDED,
} from "../accounts/platformMigration.js";
import { beginProviderSignIn } from "../card/gate.js";
import { buildPortalClearCookie, portalSessionFromRequest } from "./session.js";
import {
  revokeSessionByHash,
  sessionIdHash,
  startAccountSession,
} from "./accountSessions.js";
import {
  handleMagicConfirm,
  handleMagicLanding,
  handleSigninEmailStart,
} from "../card/emailSignIn.js";

export { portalMagicKey } from "../card/emailSignIn.js";
import { portalSecurityHeaders } from "./headers.js";
import { renderBrandPage } from "../../../core/brandHtml.js";
import {
  LINK_FLOW_COOKIE,
  PORTAL_SSO_COOKIE,
  accountRealmCookie,
  clearAccountRealmCookie,
  readCookie,
} from "../../../core/accountCookies.js";

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
  /** The account is disabled. */
  accountDisabled: (): Response =>
    htmlError(403, "This account can't sign in", {
      body: "<p>Contact Polaris Key support.</p>",
    }),
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

function mapClaims(payload: Record<string, unknown>): {
  sub: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
  groups?: string[];
} {
  const email =
    typeof payload.email === "string" ? payload.email.toLowerCase() : undefined;
  const emailVerified = payload.email_verified === true;
  const name =
    (typeof payload.name === "string" && payload.name) ||
    [payload.given_name, payload.family_name]
      .filter((s) => typeof s === "string")
      .join(" ")
      .trim() ||
    (emailVerified ? email : "");
  return {
    sub: String(payload.sub ?? ""),
    email,
    emailVerified,
    name: name || undefined,
    // PX-W10: kept so Discover can evaluate a product's `groupRoleMap` for this account. The
    // same filter the product sign-in applies (`oidc.ts` `mapClaims`): strings only; no claim
    // at all is "not known", not "no groups".
    groups: Array.isArray(payload.groups)
      ? payload.groups.filter((g): g is string => typeof g === "string")
      : undefined,
  };
}

async function issueRedirectSession(
  env: Env,
  db: Db,
  req: Request,
  account: {
    id: string;
    display_name: string | null;
    primary_email: string | null;
  },
  amr: readonly string[],
  now: number,
  location: string,
): Promise<Response> {
  // I-07: every sign-in opens a server-side account session the cookie names (revocable).
  const { cookie } = await startAccountSession(
    env,
    db,
    { account, req, amr },
    now,
  );
  return new Response(null, {
    status: 302,
    headers: {
      ...Object.fromEntries(
        portalSecurityHeaders(
          new Headers({
            location,
            "set-cookie": cookie,
            "cache-control": "no-store",
          }),
        ),
      ),
    },
  });
}

export async function handlePortalLogin(
  req: Request,
  env: Env,
  db: Db,
  now: number = Math.floor(Date.now() / 1000),
): Promise<Response> {
  const ok = await rateLimitOk(
    env,
    "_portal",
    { bucket: "portalLogin", id: clientIp(req), limit: 20, windowSec: 60 },
    now,
  );
  if (!ok) return signInPage.tooMany();
  const caps = await portalAuthCapabilities(db);
  if (!caps.portalEnabled || !caps.oidcEnabled) {
    return signInPage.off();
  }
  const cfg = platformOidcConfig(env);
  if (!cfg) return signInPage.off();
  // I-17: past the sunset nobody is sent to the platform IdP only to be refused on the way back.
  if (platformSignInEnded(env, now)) return signInPage.platformEnded();

  const url = new URL(req.url);
  const rawReturnTo = url.searchParams.get("return_to");
  const returnTo = safeReturnTo(req, rawReturnTo, PORTAL_SIGNIN_RETURN_TO);
  if (rawReturnTo && !returnTo) return htmlError(400, "Invalid return URL.");

  const state = randomToken(16);
  const nonce = randomToken(16);
  const { verifier, challenge } = await pkcePair();
  const redirectUri = `${url.origin}/callback`;
  // I-17: the flow is bound to this browser. Pocket ID returns by a top-level GET, which carries a
  // `SameSite=Lax` cookie, so the callback can require it (login CSRF, and a planted join offer).
  const binding = randomToken(32);
  const flow: FlowRecord = {
    verifier,
    nonce,
    redirectUri,
    returnTo,
    bindingHash: await hashKey(binding, env.KEY_HASH_PEPPER),
  };
  await putArtefact(
    env,
    await portalFlowKey(env, state),
    JSON.stringify(flow),
    FLOW_TTL_SECONDS,
  );

  const authorize = new URL(`${cfg.issuer.replace(/\/$/, "")}/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", cfg.clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", "openid email profile groups");
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("nonce", nonce);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  return new Response(null, {
    status: 302,
    headers: portalSecurityHeaders(
      new Headers({
        location: authorize.toString(),
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
  // Atomic and single-use: of two racing callbacks for one `state`, one gets the flow.
  const raw = await consumeArtefact(env, await portalFlowKey(env, state));
  if (!raw) return signInPage.tookTooLong();
  let flow: FlowRecord;
  try {
    flow = JSON.parse(raw) as FlowRecord;
  } catch {
    return signInPage.tookTooLong();
  }
  // I-17: only the browser that started the flow may finish it. Without this, anyone could hand
  // a victim the callback URL of their own sign-in: the victim's browser would get the
  // attacker's session (login CSRF) or, in `claim` mode, the attacker's email gate, whose join
  // the victim's own proof would complete onto the victim's account. Refused generically before
  // the code is exchanged; a flow without a binding (minted before this check) is refused too.
  const binding = readCookie(req.headers.get("cookie"), PORTAL_SSO_COOKIE);
  if (
    !binding ||
    !flow.bindingHash ||
    (await hashKey(binding, env.KEY_HASH_PEPPER)) !== flow.bindingHash
  ) {
    return signInPage.unverified();
  }
  return clearingBinding(
    await completePortalCallback(req, env, db, flow, code, now),
  );
}

/** The rest of `/callback`, once the flow is known to be this browser's. */
async function completePortalCallback(
  req: Request,
  env: Env,
  db: Db,
  flow: FlowRecord,
  code: string,
  now: number,
): Promise<Response> {
  const cfg = platformOidcConfig(env);
  if (!cfg) return signInPage.off();
  // I-17: a flow started before the sunset is not completed after it (the flow is spent above).
  if (platformSignInEnded(env, now)) return signInPage.platformEnded();
  const tokenRes = await fetch(
    `${cfg.issuer.replace(/\/$/, "")}/api/oidc/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: flow.redirectUri,
        client_id: cfg.clientId,
        code_verifier: flow.verifier,
        ...(cfg.clientSecret ? { client_secret: cfg.clientSecret } : {}),
      }),
    },
  );
  if (!tokenRes.ok) return signInPage.unavailable();
  const tokens = (await tokenRes.json()) as { id_token?: string };
  if (!tokens.id_token) return signInPage.unavailable();

  const jwks = createRemoteJWKSet(
    new URL(`${cfg.issuer.replace(/\/$/, "")}/.well-known/jwks.json`),
  );
  let claims: Record<string, unknown>;
  try {
    const verified = await jwtVerify(tokens.id_token, jwks, {
      issuer: cfg.issuer,
      audience: cfg.clientId,
      algorithms: ALLOWED_ID_TOKEN_ALGS,
      // Freshness is ours to enforce: `exp` is entirely the IdP's choice, so a token minted
      // long before this exchange must not be replayable into a sign-in (R8-05d).
      clockTolerance: ID_TOKEN_CLOCK_TOLERANCE,
      maxTokenAge: ID_TOKEN_MAX_AGE,
    });
    claims = verified.payload as Record<string, unknown>;
    if (typeof claims.nonce !== "string" || claims.nonce !== flow.nonce) {
      throw new Error("nonce mismatch");
    }
  } catch {
    return signInPage.unverified();
  }

  const identity = mapClaims(claims);
  if (!identity.sub) return signInPage.unverified();
  // I-17: with `PLATFORM_OIDC_MIGRATION` on, the claim decides (it re-keys and signs in itself);
  // off (the default), the sign-in below is exactly what it was.
  const claim = await claimPlatformSubject(
    db,
    env,
    {
      issuer: cfg.issuer,
      sub: identity.sub,
      email: identity.email ?? null,
      emailVerified: identity.emailVerified,
      displayName: identity.name ?? null,
      groups: identity.groups,
    },
    now,
  );
  let result: SignInResult;
  switch (claim.status) {
    case "off": {
      // Keyed by issuer (S-16 G14). Re-key any pre-I-01 rows first, so the lookup finds them.
      const issuerKey = portalIdentityIssuerKey(cfg.issuer);
      await rekeyLegacyPortalIdentities(db, issuerKey);
      await rekeyLegacyAccountLinks(db, issuerKey);
      // I-05: every front door ends in one `signIn(verifiedIdentity)`.
      result = await signIn(
        db,
        {
          issuerKey,
          subject: identity.sub,
          kind: "oidc",
          email: identity.emailVerified ? identity.email : null,
          emailVerified: Boolean(identity.emailVerified && identity.email),
          displayName: identity.name ?? null,
        },
        now,
      );
      break;
    }
    case "ended":
      return signInPage.platformEnded();
    case "join_offer":
      // The email step (I-07's gate) offers the join: nothing is written until the person proves
      // the account that uses the address in this browser and confirms (S-16, owner 2026-10-04).
      return beginProviderSignIn(
        req,
        env,
        db,
        { identity: claim.identity, returnTo: flow.returnTo ?? null },
        now,
      );
    case "ambiguous":
      // More than one account uses the address: nothing is offered (the same page as before).
      return emailInUsePage();
    default:
      result = claim.result;
  }
  const refused = signInRefusal(result);
  if (refused) return refused;
  const signedIn = result as Extract<SignInResult, { status: "signed_in" }>;
  const account = signedIn.account;
  // PX-W10: the platform IdP's `groups` claim, kept on this link for Discover (NULL = not sent).
  await recordLinkGroups(db, signedIn.linkId, identity.groups);
  await syncAccountLicenseLinks(db, account.id, now);
  await portalAudit(db, {
    accountId: account.id,
    action: "portal.login.oidc",
    summary: "Signed in with OIDC",
    now,
  });
  return issueRedirectSession(
    env,
    db,
    req,
    account,
    ["oidc"],
    now,
    flow.returnTo ?? "/",
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
export function signInRefusal(result: SignInResult): Response | null {
  switch (result.status) {
    case "signed_in":
      return result.account.status === "active"
        ? null
        : signInPage.accountDisabled();
    case "join_offer":
      return emailInUsePage();
    case "refused":
      return result.reason === "account_disabled"
        ? signInPage.accountDisabled()
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
  if (req.method !== "POST" && !isSameOriginNavigation(req)) {
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
