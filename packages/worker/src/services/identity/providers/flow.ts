/**
 * The login card's provider sign-in routes (I-06): root portal paths under the reserved `login`
 * slug, platform-level and never behind a product's Identity toggle (owner, 2026-10-04).
 *
 *   GET  /login/<provider>              start: record the flow, 302 to the provider
 *   GET  /login/google/callback         Google's redirect (code, state, iss)
 *   POST /login/apple/callback          Apple's form_post (code, state, user?)
 *   GET  /login/steam/callback          Steam's OpenID 2.0 positive assertion (state in return_to)
 *   POST /login/apple/notifications     Apple's server-to-server events
 *
 * **The flow.** One record per sign-in in the single-use store (`provider-flow`), addressed by the
 * peppered hash of its `state` (so a listing is inert, as for the portal's own flows) and
 * consumed atomically by the first callback that presents it. It records which provider it was
 * started for, and a callback on another provider's path is refused: per-provider redirect URIs
 * plus that check are the mix-up defence, with RFC 9207 `iss` on top where the provider sends it.
 *
 * **Browser binding without a Lax cookie.** Apple's form_post is a cross-site top-level POST, on
 * which a `SameSite=Lax` cookie is not sent, so the flow is FOUND by `state` alone, server-side.
 * The flow is still BOUND to the browser that started it: start sets `__Host-pkey_signin`, a
 * random value whose hash the record holds, as `SameSite=None; Secure; HttpOnly` with a ten-minute
 * life, which every browser sends on a top-level navigation, cross-site POST included. A callback
 * whose cookie does not match is refused, so an attacker cannot complete their own provider sign-in
 * in a victim's browser (login CSRF, which would hand the victim's later licence activations to
 * the attacker's account). The cookie carries no session and opens nothing by itself.
 *
 * **The hand-off.** A verified identity goes to I-07's `beginProviderSignIn` with the provider's
 * email, whether the provider verified it, and the provider's name and picture. It signs a known
 * account with a confirmed email in at once (an account session from `startAccountSession`) and
 * otherwise opens the email gate (email confirmation, join offer, first-consent name).
 *
 * **Connect (PX-W12).** Account → Sign-in methods → Connect starts the same flow from a signed-in
 * session (`POST /api/me/methods/<provider>/start`, `startProviderConnect`): the record also
 * carries `purpose: "connect"`, the account, the session row and its sign-in time. The provider
 * returns to the SAME registered callback, which then never signs anyone in: it checks the session
 * row is still live, narrows the provider's email claim exactly as a sign-in does
 * (`providerVouchesForEmail`, and never verified when another account already uses the address),
 * and hands the identity to I-05's `linkIdentity`, which applies the step-up (the session's
 * sign-in no older than 5 minutes), refuses a method another account holds (`link_conflict`),
 * audits, fires LX-26's verified-email hook and emails every verified address. The browser lands
 * on `#/account/methods` with `connected=<provider>` or `error=<code>`. The record holds the
 * account because Apple's form_post carries no Lax session cookie; the binding cookie still ties
 * the callback to the browser that started it.
 */

import { hashKey } from "../../../platform/crypto.js";
import { pkceChallenge } from "../../../platform/pkce.js";
import {
  PORTAL_SIGNIN_RETURN_TO,
  safeReturnTo,
} from "../../../platform/returnTo.js";
import { randomToken } from "../../../platform/random.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { clientNetwork, rateLimitOk } from "../../../core/rateLimit.js";
import { readCappedText } from "../../../core/readCapped.js";
import { identityEnabled } from "../../../core/accounts/identityGate.js";
import type { SettingsRegistry } from "../../../core/settings/registry.js";
import { PRODUCT_SLUG_RE } from "@polaris-key/manifest";
import {
  artefactRef,
  consumeArtefact,
  getArtefact,
  putArtefact,
  type ArtefactRef,
} from "../../../core/singleUse.js";
import { beginProviderSignIn } from "../card/gate.js";
import { importProfile } from "../card/profile.js";
import { linkIdentity } from "../accounts/links.js";
import { accountUsingEmail } from "../accounts/repo.js";
import { providerVouchesForEmail } from "./vouch.js";
import { productTerms } from "../productTerms.js";
import { htmlError, signInPage } from "../portal/auth.js";
import { appSecurityHeaders as portalSecurityHeaders } from "../../../platform/securityHeaders.js";
import { portalAuthCapabilities } from "../portal/repo.js";
import {
  appleAuthorizeUrl,
  completeAppleSignIn,
  verifyAppleNotification,
  type AppleNotificationType,
} from "./apple.js";
import {
  isSignInProviderKind,
  resolveSignInClient,
  type SignInProviderKind,
} from "./config.js";
import { discoverProvider, ProviderVerifyError } from "./discovery.js";
import { completeGoogleSignIn, googleAuthorizeUrl } from "./google.js";
import { ProviderNetworkError, type ProviderFetch } from "./net.js";
import {
  clearAppleLinkFlag,
  flagAppleLink,
  type AppleLinkFlag,
} from "./linkFlags.js";
import { completeSteamSignIn, steamAuthorizeUrl } from "./steam.js";
import type { ProviderSignInResult } from "./types.js";

const FLOW_TTL_SECONDS = 600;
const FORM_MAX_BYTES = 16 * 1024;

/** The browser-binding cookie. `__Host-`: Secure, Path=/, no Domain. */
export const SIGNIN_BIND_COOKIE = "__Host-pkey_signin";

const PROVIDER_LABEL: Record<SignInProviderKind, string> = {
  google: "Google",
  apple: "Apple",
  steam: "Steam",
};

/** The method each provider's callback arrives with. */
const CALLBACK_METHOD: Record<SignInProviderKind, "GET" | "POST"> = {
  google: "GET",
  apple: "POST",
  steam: "GET",
};

export interface SignInFlowRecord {
  provider: SignInProviderKind;
  nonce: string;
  /** Google only: the PKCE verifier. */
  verifier?: string;
  /** The exact redirect URI (OIDC) or `openid.return_to` (Steam) this flow sent. */
  redirectUri: string;
  returnTo?: string;
  /**
   * I-09: the product the sign-in comes through, when the card was opened for one
   * (`/signin?product=<slug>`, the `signInUrl` of `license_owned`) and that product's Identity is
   * on. The callback hands it, with the product's terms, to the email gate.
   */
  product?: string;
  /** Peppered hash of the browser-binding cookie's value. */
  bindingHash: string;
  /** PX-W12: a Connect from Account → Sign-in methods, not a sign-in. */
  purpose?: "connect";
  /** Connect only: the signed-in account, its session row, and when that session signed in. */
  accountId?: string;
  sessionIdHash?: string;
  authenticatedAt?: number;
}

/** Where a Connect lands: the account page's sign-in methods (PX-W12). */
export const CONNECT_LANDING = "/#/account/methods";

/** Single-use store address of a provider flow, by its `state`. Exported for tests. */
export async function signInFlowKey(
  env: Env,
  state: string,
): Promise<ArtefactRef> {
  return artefactRef(
    "provider-flow",
    await hashKey(state, env.KEY_HASH_PEPPER),
  );
}

/** Test seam: the outbound fetch every provider call uses. */
export interface ProviderRouteOptions {
  now: number;
  fetch?: ProviderFetch;
  /** The settings registry (ST-04), from the composition root: a product's terms resolve through it. */
  settings?: SettingsRegistry;
}

/**
 * I-09: the product a sign-in start names (`?product=<slug>`), kept only when it is a product slug
 * of a product whose Identity is on; anything else is ignored and the sign-in is a plain portal one.
 */
async function signInProduct(
  db: Db,
  raw: string | null,
): Promise<string | null> {
  if (!raw || !PRODUCT_SLUG_RE.test(raw)) return null;
  return (await identityEnabled(db, raw)) ? raw : null;
}

function bindCookie(value: string): string {
  return [
    `${SIGNIN_BIND_COOKIE}=${value}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=None",
    `Max-Age=${FLOW_TTL_SECONDS}`,
  ].join("; ");
}

function clearBindCookie(): string {
  return [
    `${SIGNIN_BIND_COOKIE}=`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=None",
    "Max-Age=0",
  ].join("; ");
}

function readBindCookie(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SIGNIN_BIND_COOKIE) return rest.join("=") || null;
  }
  return null;
}

function redirect(
  location: string,
  status: 302 | 303,
  cookies: string[],
): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, {
    status,
    headers: portalSecurityHeaders(headers),
  });
}

function json(body: unknown, status: number): Response {
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
 * The provider URL and the flow record for one start, before the binding is set. `null` when
 * the provider cannot be reached or does not offer what the flow needs.
 */
async function buildProviderFlow(
  env: Env,
  kind: SignInProviderKind,
  origin: string,
  returnTo: string | undefined,
  opts: ProviderRouteOptions,
): Promise<{
  state: string;
  location: string;
  record: SignInFlowRecord;
} | null> {
  const client = await resolveSignInClient(env, kind);
  if (!client) return null;
  const state = randomToken(24);
  const nonce = randomToken(24);
  try {
    if (client.kind === "steam") {
      // Steam carries no state parameter of its own: ours rides in the signed return URL.
      const redirectUri = `${origin}/login/steam/callback?state=${state}`;
      return {
        state,
        location: steamAuthorizeUrl({ returnTo: redirectUri, realm: origin }),
        record: {
          provider: kind,
          nonce,
          redirectUri,
          returnTo,
          bindingHash: "",
        },
      };
    }
    const redirectUri = `${origin}/login/${kind}/callback`;
    const discovered = await discoverProvider(client.kind, {
      fetch: opts.fetch,
    });
    if (client.kind === "google") {
      const verifier = randomToken(32);
      return {
        state,
        location: googleAuthorizeUrl(client, discovered, {
          redirectUri,
          state,
          nonce,
          codeChallenge: await pkceChallenge(verifier),
        }),
        record: {
          provider: kind,
          nonce,
          verifier,
          redirectUri,
          returnTo,
          bindingHash: "",
        },
      };
    }
    if (!discovered.responseModes.includes("form_post")) {
      throw new ProviderVerifyError("apple does not offer form_post");
    }
    return {
      state,
      location: appleAuthorizeUrl(client, discovered, {
        redirectUri,
        state,
        nonce,
      }),
      record: { provider: kind, nonce, redirectUri, returnTo, bindingHash: "" },
    };
  } catch {
    return null;
  }
}

/** Bind a built flow to this browser and store it: the binding cookie to set. */
async function storeProviderFlow(
  env: Env,
  built: { state: string; record: SignInFlowRecord },
): Promise<string> {
  const binding = randomToken(32);
  built.record.bindingHash = await hashKey(binding, env.KEY_HASH_PEPPER);
  await putArtefact(
    env,
    await signInFlowKey(env, built.state),
    JSON.stringify(built.record),
    FLOW_TTL_SECONDS,
  );
  return bindCookie(binding);
}

/** `GET /login/<provider>`. */
export async function handleProviderStart(
  req: Request,
  env: Env,
  db: Db,
  kind: SignInProviderKind,
  opts: ProviderRouteOptions,
): Promise<Response> {
  if (req.method !== "GET") return htmlError(405, "Method not allowed.");
  const ok = await rateLimitOk(
    env,
    "_portal",
    {
      bucket: "portalProviderStart",
      id: clientNetwork(req),
      limit: 20,
      windowSec: 60,
    },
    opts.now,
  );
  if (!ok) return signInPage.tooMany();
  const caps = await portalAuthCapabilities(db);
  if (!caps.portalEnabled) return signInPage.off();
  const label = PROVIDER_LABEL[kind];
  const client = await resolveSignInClient(env, kind);
  if (!client) return signInPage.off();

  const url = new URL(req.url);
  const rawReturnTo = url.searchParams.get("return_to");
  const returnTo = safeReturnTo(req, rawReturnTo, PORTAL_SIGNIN_RETURN_TO);
  if (rawReturnTo && !returnTo) return htmlError(400, "Invalid return URL.");

  const built = await buildProviderFlow(env, kind, url.origin, returnTo, opts);
  if (!built) return signInPage.unavailable(label);
  const product = await signInProduct(db, url.searchParams.get("product"));
  if (product) built.record.product = product;
  const cookie = await storeProviderFlow(env, built);
  return redirect(built.location, 302, [cookie]);
}

/** The signed-in caller of a Connect (`portal/methods.ts` resolved it). */
export interface ConnectCaller {
  accountId: string;
  sessionIdHash: string;
  /** When the session signed in (`portalSessionAuthenticatedAt`). */
  authenticatedAt: number;
}

/**
 * `POST /api/me/methods/<provider>/start` (PX-W12): a Connect from a signed-in session. Answers
 * the provider URL for the browser to open (JSON, since the SPA calls it with `fetch`), and sets
 * the binding cookie. The session's step-up is checked here by the caller and again, by
 * `linkIdentity`, when the provider comes back.
 */
export async function startProviderConnect(
  req: Request,
  env: Env,
  kind: SignInProviderKind,
  caller: ConnectCaller,
  opts: ProviderRouteOptions,
): Promise<Response> {
  const client = await resolveSignInClient(env, kind);
  if (!client) {
    return json(
      {
        error: "auth_method_disabled",
        message: `${PROVIDER_LABEL[kind]} isn't available here.`,
      },
      404,
    );
  }
  const origin = new URL(req.url).origin;
  const built = await buildProviderFlow(env, kind, origin, undefined, opts);
  if (!built) {
    return json(
      {
        error: "unavailable",
        message: `We couldn't reach ${PROVIDER_LABEL[kind]}. Try again in a moment.`,
      },
      503,
    );
  }
  built.record.purpose = "connect";
  built.record.accountId = caller.accountId;
  built.record.sessionIdHash = caller.sessionIdHash;
  built.record.authenticatedAt = caller.authenticatedAt;
  const cookie = await storeProviderFlow(env, built);
  const res = json(
    { redirect: built.location, expiresIn: FLOW_TTL_SECONDS },
    200,
  );
  res.headers.append("set-cookie", cookie);
  return res;
}

/** The callback's parameters, from the query (GET) or the capped form body (Apple's POST). */
async function callbackParams(
  req: Request,
  kind: SignInProviderKind,
): Promise<URLSearchParams | null> {
  if (CALLBACK_METHOD[kind] === "GET") return new URL(req.url).searchParams;
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    return null;
  }
  try {
    const text = await readCappedText(
      req as unknown as Response,
      FORM_MAX_BYTES,
      () => new Error("form too large"),
    );
    return new URLSearchParams(text);
  } catch {
    return null;
  }
}

/** `GET|POST /login/<provider>/callback`. */
export async function handleProviderCallback(
  req: Request,
  env: Env,
  db: Db,
  kind: SignInProviderKind,
  opts: ProviderRouteOptions,
): Promise<Response> {
  if (req.method !== CALLBACK_METHOD[kind]) {
    return htmlError(405, "Method not allowed.");
  }
  const ok = await rateLimitOk(
    env,
    "_portal",
    {
      bucket: "portalProviderCallback",
      id: clientNetwork(req),
      limit: 20,
      windowSec: 60,
    },
    opts.now,
  );
  if (!ok) return signInPage.tooMany();
  const caps = await portalAuthCapabilities(db);
  if (!caps.portalEnabled) return signInPage.off();
  const label = PROVIDER_LABEL[kind];

  const params = await callbackParams(req, kind);
  if (!params) return htmlError(400, "This sign-in response was malformed.");
  // Steam's state rides in the return URL's own query, beside the openid.* fields.
  const state = params.get("state");
  if (!state) return signInPage.tookTooLong();
  // Atomic and single-use: of two racing callbacks for one state, one gets the flow. A
  // cancelled or failed provider response still burns it.
  // Read first, check the mix-up and the binding, and only then consume, so a
  // callback from another browser (or provider) cannot burn the flow of the one that started it.
  const flowKey = await signInFlowKey(env, state);
  const raw = await getArtefact(env, flowKey);
  if (!raw) return signInPage.tookTooLong();
  let flow: SignInFlowRecord;
  try {
    flow = JSON.parse(raw) as SignInFlowRecord;
  } catch {
    return signInPage.tookTooLong();
  }
  // Mix-up defence: a state minted for one provider is never redeemed on another's callback.
  if (flow.provider !== kind) {
    return signInPage.tookTooLong();
  }
  const binding = readBindCookie(req);
  if (
    !binding ||
    (await hashKey(binding, env.KEY_HASH_PEPPER)) !== flow.bindingHash
  ) {
    return htmlError(
      400,
      "This sign-in was started in another browser. Start again here.",
    );
  }
  if (!(await consumeArtefact(env, flowKey))) return signInPage.tookTooLong();
  if (params.get("error") || params.get("openid.mode") === "cancel") {
    // The h1 without its full stop, then Sign in again (htmlError's default on a 400).
    return htmlError(400, `Sign in with ${label} was cancelled`);
  }

  let result: ProviderSignInResult;
  try {
    result = await completeProvider(env, kind, flow, params, opts);
  } catch (err) {
    if (err instanceof ProviderNetworkError) {
      return signInPage.unavailable(label);
    }
    return signInPage.unverified();
  }

  if (kind === "apple") {
    // Signing in again with Apple is a fresh consent: a revoked-consent flag no longer holds.
    await clearAppleLinkFlag(
      db,
      { subject: result.identity.subject },
      "consent_revoked",
      opts.now,
    );
  }
  if (flow.purpose === "connect") {
    return completeProviderConnect(req, env, db, kind, flow, result, opts.now);
  }
  // I-07's seam: a known account with a confirmed email signs in at once (one account session,
  // `startAccountSession`); a first sign-in opens the email gate. Either way no session is minted
  // here.
  const handedOff = await beginProviderSignIn(
    req,
    env,
    db,
    {
      identity: result.identity,
      profile: {
        name: result.profile.firstConsentName ?? result.profile.displayName,
        pictureUrl: result.profile.avatarUrl,
      },
      hostedDomain: result.hostedDomain ?? null,
      returnTo: flow.returnTo ?? null,
      // I-09: a sign-in the card started for a product goes through it, with its terms. The
      // toggle is read again here: Identity turned off while the person was at the provider
      // makes it a plain portal sign-in.
      product:
        flow.product && (await identityEnabled(db, flow.product))
          ? {
              slug: flow.product,
              terms: await productTerms(
                { env, db, registry: opts.settings },
                flow.product,
              ),
            }
          : null,
    },
    opts.now,
  );
  const headers = new Headers(handedOff.headers);
  headers.append("set-cookie", clearBindCookie());
  // 303 after Apple's POST, so the browser follows with a GET.
  const status =
    kind === "apple" && handedOff.status === 302 ? 303 : handedOff.status;
  return new Response(handedOff.body, { status, headers });
}

/** Where a Connect ends: the methods section, with its outcome in the hash route's query. */
function connectLanding(
  kind: SignInProviderKind,
  outcome: { ok: true } | { error: string },
): Response {
  const qs =
    "ok" in outcome
      ? `connected=${kind}`
      : `error=${encodeURIComponent(outcome.error)}&method=${kind}`;
  // 303 after Apple's POST, so the browser follows with a GET.
  const headers = new Headers({
    location: `${CONNECT_LANDING}?${qs}`,
    "cache-control": "no-store",
  });
  headers.append("set-cookie", clearBindCookie());
  return new Response(null, {
    status: kind === "apple" ? 303 : 302,
    headers: portalSecurityHeaders(headers),
  });
}

/**
 * The end of a Connect (PX-W12): link the verified identity to the account that started it,
 * through I-05's link engine. Never signs anyone in and never opens the email gate.
 */
async function completeProviderConnect(
  req: Request,
  env: Env,
  db: Db,
  kind: SignInProviderKind,
  flow: SignInFlowRecord,
  result: ProviderSignInResult,
  now: number,
): Promise<Response> {
  const accountId = flow.accountId;
  if (!accountId || !flow.sessionIdHash || flow.authenticatedAt === undefined) {
    return connectLanding(kind, { error: "signin_expired" });
  }
  // The session that started it must still be live: signing out cancels a Connect in flight.
  const session = await db.first<{
    account_id: string;
    revoked_at: number | null;
    expires_at: number;
  }>(
    "SELECT account_id, revoked_at, expires_at FROM account_sessions WHERE id_hash = ?",
    flow.sessionIdHash,
  );
  if (
    !session ||
    session.account_id !== accountId ||
    session.revoked_at !== null ||
    session.expires_at <= now
  ) {
    return connectLanding(kind, { error: "signin_expired" });
  }
  // The provider's email claim, narrowed exactly as a sign-in narrows it, and never verified when
  // another account already uses the address: no address is verified on two accounts.
  const email = result.identity.email ?? null;
  const vouched = providerVouchesForEmail(
    result.identity,
    result.hostedDomain ?? null,
  );
  const emailVerified =
    vouched &&
    email !== null &&
    !(await accountUsingEmail(db, email, accountId));
  const linked = await linkIdentity(
    { db, env, now, origin: new URL(req.url).origin },
    { accountId, authenticatedAt: flow.authenticatedAt },
    { ...result.identity, emailVerified },
  );
  if (!linked.ok) return connectLanding(kind, { error: linked.error });
  if (!linked.already) {
    // The provider's name and picture become choices in the profile editor (PX-W16); a value the
    // account never set follows the new method, an explicit one never moves.
    await importProfile(
      env,
      db,
      {
        accountId,
        linkId: linked.link.id,
        profile: {
          name: result.profile.firstConsentName ?? result.profile.displayName,
          pictureUrl: result.profile.avatarUrl,
        },
        fill: "refresh",
      },
      now,
    ).catch(() => undefined);
  }
  return connectLanding(kind, { ok: true });
}

async function completeProvider(
  env: Env,
  kind: SignInProviderKind,
  flow: SignInFlowRecord,
  params: URLSearchParams,
  opts: ProviderRouteOptions,
): Promise<ProviderSignInResult> {
  const client = await resolveSignInClient(env, kind);
  if (!client) throw new ProviderVerifyError(`${kind} is not configured`);
  if (client.kind === "steam") {
    return completeSteamSignIn(
      client,
      params,
      { returnTo: flow.redirectUri, nowSec: opts.now },
      { fetch: opts.fetch },
    );
  }
  const code = params.get("code");
  if (!code) throw new ProviderVerifyError("no authorization code");
  const discovered = await discoverProvider(client.kind, { fetch: opts.fetch });
  if (client.kind === "google") {
    if (!flow.verifier) throw new ProviderVerifyError("flow has no verifier");
    return completeGoogleSignIn(
      client,
      discovered,
      {
        code,
        iss: params.get("iss"),
        redirectUri: flow.redirectUri,
        codeVerifier: flow.verifier,
        nonce: flow.nonce,
      },
      { fetch: opts.fetch },
    );
  }
  return completeAppleSignIn(
    client,
    discovered,
    {
      code,
      iss: params.get("iss"),
      redirectUri: flow.redirectUri,
      nonce: flow.nonce,
      user: params.get("user"),
    },
    { fetch: opts.fetch, nowSec: opts.now },
  );
}

const NOTIFICATION_FLAG: Record<AppleNotificationType, AppleLinkFlag | null> = {
  "consent-revoked": "consent_revoked",
  "account-delete": "account_deleted",
  "email-disabled": "email_disabled",
  "email-enabled": null,
};

/** `POST /login/apple/notifications`: Apple's server-to-server events. */
export async function handleAppleNotifications(
  req: Request,
  env: Env,
  db: Db,
  opts: ProviderRouteOptions,
): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const ok = await rateLimitOk(
    env,
    "_portal",
    {
      bucket: "appleNotifications",
      id: clientNetwork(req),
      limit: 120,
      windowSec: 60,
    },
    opts.now,
  );
  if (!ok) return json({ error: "rate_limited" }, 429);
  const client = await resolveSignInClient(env, "apple");
  if (!client) return json({ error: "not_found" }, 404);
  let payload: unknown;
  try {
    const text = await readCappedText(
      req as unknown as Response,
      FORM_MAX_BYTES,
      () => new Error("too large"),
    );
    payload = (JSON.parse(text) as { payload?: unknown }).payload;
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  if (typeof payload !== "string") return json({ error: "bad_request" }, 400);
  let event: Awaited<ReturnType<typeof verifyAppleNotification>>;
  try {
    const discovered = await discoverProvider("apple", { fetch: opts.fetch });
    event = await verifyAppleNotification(client, discovered, payload, {
      fetch: opts.fetch,
    });
  } catch (err) {
    if (err instanceof ProviderNetworkError) {
      // Apple retries on a non-2xx: let it, rather than dropping an event we could not check.
      return json({ error: "unavailable" }, 503);
    }
    return json({ error: "unauthorized" }, 401);
  }
  const flag = NOTIFICATION_FLAG[event.type];
  const linkId = flag
    ? await flagAppleLink(db, event.sub, flag, opts.now)
    : await clearAppleLinkFlag(
        db,
        { subject: event.sub },
        "email_disabled",
        opts.now,
      );
  return json({ ok: true, matched: linkId !== null }, 200);
}

/** Route `/login/<provider>[/<step>]`. Unknown providers and steps are the page's not-found. */
export async function handleProviderSignInPath(
  req: Request,
  env: Env,
  db: Db,
  path: string,
  opts: ProviderRouteOptions,
): Promise<Response> {
  const m = path.match(/^\/login\/([a-z]+)(?:\/(callback|notifications))?$/);
  const kind = m?.[1];
  if (!m || !isSignInProviderKind(kind)) {
    return signInPage.off();
  }
  switch (m[2]) {
    case undefined:
      return handleProviderStart(req, env, db, kind, opts);
    case "callback":
      return handleProviderCallback(req, env, db, kind, opts);
    case "notifications":
      if (kind === "apple") return handleAppleNotifications(req, env, db, opts);
  }
  return signInPage.off();
}
