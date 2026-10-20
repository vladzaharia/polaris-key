/// <reference types="@cloudflare/workers-types" />

import {
  authorizationUrl,
  discover,
  issuerRelyingParty,
  newFlowSecrets,
  type DiscoveredIssuer,
  type RelyingParty,
} from "../../../core/oidc/client.js";
import { hashKey } from "../../../platform/crypto.js";
import { type Env } from "../../../platform/env.js";
import {
  PRODUCT_SIGNIN_RETURN_TO,
  safeReturnTo,
} from "../../../platform/returnTo.js";
import { randomToken } from "../../../platform/random.js";
import type { Db } from "../../../db/types.js";
import { type Product } from "../../../core/products.js";
import { errorResponse } from "../../../core/errors.js";
import { clientNetwork } from "../../../core/rateLimit.js";
import { isValidClientDeviceId } from "../../../core/devices.js";
import { binderSetCookie } from "../licenseChoice.js";
import { platformSignInEnded } from "../accounts/platformMigration.js";
import { putArtefact } from "../../../core/singleUse.js";
import {
  FLOW_TTL_SECONDS,
  type FlowRecord,
  flowKey,
  rateLimited,
  redirectUriAllowed,
  resolveOidcConfig,
} from "./config.js";
import { platformSignInEndedPage } from "./pages.js";

// ── HTTP handlers ────────────────────────────────────────────────────────────
export async function beginAuthFlow(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  returnTo?: string,
  deviceId?: string,
  viaDeviceCode = false,
  opts: {
    /** `/auth/start`: the request is the browser that will sign in, so it gets the binder. */
    browser?: boolean;
    deviceName?: string;
    /** I-37: the DeviceConfirm page's display data, stored beside the flow. */
    startedAt?: number;
    startPlace?: { country: string | null; label: string | null };
  } = {},
): Promise<
  | {
      ok: true;
      state: string;
      authorizeUrl: string;
      redirectUri: string;
      /** I-26: the binder cookie to set on the browser, when one was minted. */
      binderCookie?: string;
    }
  | Response
> {
  // The id the sign-in will bind is client-claimed; refuse a malformed one
  // (and every server-minted `browser:<licence>` id) before it enters the flow record.
  if (deviceId !== undefined && !isValidClientDeviceId(deviceId))
    return errorResponse(400, "bad_request", "malformed device id");
  const oidc = await resolveOidcConfig(env, db, product);
  if (oidc instanceof Response) return oidc;
  // I-17: past the sunset nobody is sent to the platform IdP only to be refused on the way back.
  // The browser gets the page; a device-code client the answer it already gets when this
  // product's sign-in is off (`disabled`), so nothing new crosses the device wire.
  if (
    (oidc.row.provider ?? "platform") === "platform" &&
    platformSignInEnded(env, Math.floor(Date.now() / 1000))
  ) {
    return opts.browser
      ? platformSignInEndedPage()
      : errorResponse(404, "disabled", "platform sign-in has ended");
  }
  // I-30: the one relying-party client discovers the issuer (no hard-coded Pocket ID paths).
  const rp = legacyRelyingParty(oidc);
  let discovered: DiscoveredIssuer;
  try {
    discovered = await discover(rp);
  } catch {
    return errorResponse(502, "oidc_error", "issuer discovery failed");
  }
  const { state, nonce, verifier, challenge } = await newFlowSecrets();
  // §R1: the callback moved under the service namespace with the rest of Identity. This is the
  // value the IdP must have REGISTERED — `redirectUriAllowed` below refuses anything else the
  // moment `redirect_uris_json` is set — so an operator upgrading a product with a custom (or
  // strictly-configured platform) IdP re-registers `…/<p>/identity/auth/callback` and updates
  // the `oidc.redirectUris` block in its `.pkey/product` manifest. Pre-launch, so there is
  // no dual-registration window to keep: one spelling, computed in exactly one place.
  const redirectUri = `${new URL(req.url).origin}/${product.slug}/identity/auth/callback`;
  if (!redirectUriAllowed(oidc.row, redirectUri)) {
    return errorResponse(400, "bad_request", "redirect_uri not allow-listed");
  }
  const flow: FlowRecord = { verifier, nonce, redirectUri, returnTo, deviceId };
  if (viaDeviceCode) flow.viaDeviceCode = true;
  if (opts.deviceName) flow.deviceName = opts.deviceName;
  if (opts.startedAt !== undefined) flow.startedAt = opts.startedAt;
  if (opts.startPlace) flow.startPlace = opts.startPlace;
  // I-26: only a `provider: platform` product can reach the licence chooser, so only its flows
  // carry a binder; a custom-IdP product's sign-in is byte-identical to before.
  let binderCookie: string | undefined;
  if ((oidc.row.provider ?? "platform") === "platform")
    flow.binderEligible = true;
  // Every browser flow, whatever the issuer, is bound to the browser that started it;
  // the callback refuses any other browser (login CSRF / session fixation).
  if (opts.browser) {
    const binder = randomToken(32);
    flow.binder = await hashKey(binder, env.KEY_HASH_PEPPER);
    binderCookie = binderSetCookie(binder, FLOW_TTL_SECONDS);
  }
  await putArtefact(
    env,
    await flowKey(env, product.slug, state),
    JSON.stringify(flow),
    FLOW_TTL_SECONDS,
  );

  return {
    ok: true,
    state,
    authorizeUrl: authorizationUrl(discovered, rp, {
      redirectUri,
      scope: "openid email profile groups",
      state,
      nonce,
      codeChallenge: challenge,
    }),
    redirectUri,
    ...(binderCookie ? { binderCookie } : {}),
  };
}

/** The resolved product IdP as a relying party of the one client (its allowlist: the issuer's
 *  host; a custom issuer already passed `OIDC_ISSUER_ALLOWLIST` in `resolveOidcConfig`). */
export function legacyRelyingParty(oidc: {
  issuer: string;
  clientId: string;
  clientSecret?: string | null;
}): RelyingParty {
  return issuerRelyingParty("product-idp", oidc);
}

/** GET /<product>/identity/auth/start — begin PKCE, redirect to the IdP authorize endpoint. */
export async function handleAuthStart(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
): Promise<Response> {
  const limited = await rateLimited(
    env,
    product,
    Math.floor(Date.now() / 1000),
    { bucket: "authStart", id: clientNetwork(req), limit: 60, windowSec: 60 },
  );
  if (limited) return limited;
  const rawReturnTo = new URL(req.url).searchParams.get("return_to");
  const returnTo = safeReturnTo(req, rawReturnTo, PRODUCT_SIGNIN_RETURN_TO);
  if (rawReturnTo && !returnTo)
    return errorResponse(400, "bad_request", "return_to not allowed");
  const flow = await beginAuthFlow(
    req,
    env,
    db,
    product,
    returnTo,
    undefined,
    false,
    { browser: true },
  );
  if (flow instanceof Response) return flow;
  const headers = new Headers({ location: flow.authorizeUrl });
  if (flow.binderCookie) headers.append("set-cookie", flow.binderCookie);
  return new Response(null, { status: 302, headers });
}
