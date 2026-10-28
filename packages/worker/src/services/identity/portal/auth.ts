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
import { parseFlowRecord } from "../../../platform/json.js";
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
  consumeArtefact,
  getArtefact,
  putArtefact,
} from "../../../core/singleUse.js";
import { portalIdentityIssuerKey, portalAuthCapabilities } from "./repo.js";
import { type SignInResult } from "../accounts/signIn.js";
import { findLink, rekeyLegacyAccountLinks } from "../accounts/repo.js";
import {
  platformSignInEnded,
  platformSignInPolicy,
  PLATFORM_SIGNIN_ENDED,
} from "../accounts/platformMigration.js";
import { beginProviderSignIn } from "../card/gate.js";
import { identityEnabled } from "../../../core/accounts/identityGate.js";
import type { SettingsRegistry } from "../../../core/settings/registry.js";
import { productTerms, signInProduct } from "../productTerms.js";
import { connectionIdentity } from "../connections/claims.js";
import { autoLinkThroughDomain } from "../connections/autoLink.js";
import {
  completeConnectionTest,
  testFlowOf,
} from "../connections/testSignIn.js";
import {
  PLATFORM_ENV_CONNECTION_ID,
  platformEnvConnection,
} from "../connections/seed.js";
import { accountDisabledPage, emailInUsePage } from "../card/http.js";
import { emailDomain, routeForDomain } from "../../../core/oidc/connections.js";
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

export { portalFlowKey } from "./flowKey.js";
import { portalFlowKey } from "./flowKey.js";

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
  /** B-063: the product the card was opened for (`?product=<slug>`) when its Identity is on, so
   *  the callback hands the email gate that product and its terms (as `providers/flow.ts`). */
  product?: string;
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
  opts: {
    body?: string;
    retry?: boolean;
    /** Where the button goes (default the sign-in page) and what it says. */
    retryHref?: string;
    retryLabel?: string;
  } = {},
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
          ? `<p class="actions"><a class="button" href="${escapeHtml(opts.retryHref ?? "/")}">${escapeHtml(opts.retryLabel ?? "Sign in again")}</a></p>` // signin.again
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
  /**
   * A connection's discovery failed. The heading names the organization. Where the address's
   * domain is enforced there is no other way in: say so and retry the same route; otherwise the
   * button returns to the card.
   */
  connectionUnreachable: (
    label: string,
    opts: { enforcedDomain: string | null; retryHref: string },
  ): Response =>
    htmlError(502, `Can't reach ${label}`, {
      body: opts.enforcedDomain
        ? `<p>${escapeHtml(opts.enforcedDomain)} addresses sign in only through ${escapeHtml(label)}. If it keeps failing, contact its IT help desk.</p>`
        : "<p>Try again, or use a different email.</p>",
      retry: true,
      retryHref: opts.enforcedDomain ? opts.retryHref : "/",
      retryLabel: opts.enforcedDomain ? "Try again" : "Use a different email",
    }),
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
  if (!caps.portalEnabled) {
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
    const hintDomain = loginHint ? emailDomain(loginHint) : null;
    const route = hintDomain
      ? await routeForDomain(db, hintDomain, ["platform"], "customers")
      : null;
    return signInPage.connectionUnreachable(conn.label, {
      enforcedDomain:
        route?.enforced && route.connection.id === conn.id ? hintDomain : null,
      retryHref: `${url.pathname}${url.search}`,
    });
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
  // B-063: a product that is not a slug, or whose Identity is off, is ignored (a plain sign-in).
  const product = await signInProduct(db, url.searchParams.get("product"));
  if (product) flow.product = product;
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
  settings?: SettingsRegistry,
): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  // I-31: a connection test comes back with `error` instead of `code` when the provider refuses.
  if (!state || (!code && !url.searchParams.get("error"))) {
    return htmlError(400, "Missing authorization code.");
  }
  // The callback runs a token exchange and an ID-token verification for anyone who names a
  // `state`, and had no budget while `/login` next door did. Fails CLOSED (`core/rateLimit.ts`):
  // losing the limiter must not silently unmeter a session-minting leg.
  const ok = await rateLimitOk(
    env,
    "_portal",
    {
      bucket: "portalCallback",
      id: clientNetwork(req),
      limit: 20,
      windowSec: 60,
    },
    now,
  );
  if (!ok) return signInPage.tooMany();
  // The binding is checked on a read, BEFORE the atomic single-use consume, so a
  // callback from another browser cannot burn the flow of the one that started it.
  const flowKey = await portalFlowKey(env, state);
  const peeked = await getArtefact(env, flowKey);
  // A console connection test runs whether or not the portal is on (the operator is adding the
  // first connection); an ordinary sign-in needs the portal and single sign-on enabled.
  const isTest =
    peeked !== null && testFlowOf(parseFlowRecord<FlowRecord>(peeked)) !== null;
  if (!isTest) {
    const caps = await portalAuthCapabilities(db);
    if (!caps.portalEnabled) {
      return signInPage.off();
    }
  }
  if (!peeked) return signInPage.tookTooLong();
  // A stored value that does not parse to an object (`null`, a number, garbage) is the same
  // as an expired flow; reading `flow.bindingHash` off it would be a TypeError (500).
  const flow = parseFlowRecord<FlowRecord>(peeked);
  if (!flow) return signInPage.tookTooLong();
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
  const testFlow = testFlowOf(flow);
  if (testFlow) {
    return clearingBinding(
      await completeConnectionTest(env, db, flow, testFlow, {
        code,
        iss: url.searchParams.get("iss"),
        error: url.searchParams.get("error"),
        errorDescription: url.searchParams.get("error_description"),
      }),
    );
  }
  if (!code) return htmlError(400, "Missing authorization code.");
  return clearingBinding(
    await completeConnectionCallback(
      req,
      env,
      db,
      flow,
      { code, iss: url.searchParams.get("iss") },
      now,
      settings,
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
  settings?: SettingsRegistry,
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
  // One form of the subject for the lookup, Q1's auto-link and the sign-in below: trimmed, as
  // `normalizeIdentity` keys every link.
  const subject = identity.sub.trim();
  if (!subject) return signInPage.unverified();
  const issuerKey = portalIdentityIssuerKey(conn.issuer);
  if (conn.source === "env") {
    // A pre-I-01 row still keyed by the literal `oidc` is this IdP's subject: re-key it before
    // the lookup, or the person would get a second account.
    await rekeyLegacyAccountLinks(db, issuerKey);
  }
  const known = await findLink(db, {
    issuerKey,
    tenantScope: "",
    subject,
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
        subject,
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
        subject,
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
      linkAssertion: {
        groups: identity.groups,
        claims: identity.claims,
        connectionId: conn.id,
      },
      amr: [`connection:${conn.id}`],
      returnTo: flow.returnTo ?? null,
      // B-063: a sign-in the card opened for a product goes through it, with its terms. The
      // toggle is read again here (Identity turned off meanwhile makes it a plain sign-in).
      product:
        flow.product && (await identityEnabled(db, flow.product))
          ? {
              slug: flow.product,
              terms: await productTerms(
                { env, db, registry: settings },
                flow.product,
              ),
            }
          : null,
    },
    now,
  );
}

/** An unknown identity whose verified email another account uses, where no join is offered. */

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
  if (req.method === "POST" || req.method === "GET" || req.method === "HEAD") {
    // A bearer-token REDEMPTION endpoint, which had no budget while the start surface that
    // merely sends the mail was capped: the wrong way round, since this is the online oracle.
    // Landing and confirm share it. Fails CLOSED like every other credential leg.
    const ok = await rateLimitOk(
      env,
      "_portal",
      {
        bucket: "portalMagicVerify",
        id: clientNetwork(req),
        limit: 20,
        windowSec: 60,
      },
      now,
    );
    if (!ok) return signInPage.tooMany();
    return req.method === "POST"
      ? handleMagicConfirm(req, env, db, now)
      : handleMagicLanding(req, env, db);
  }
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
