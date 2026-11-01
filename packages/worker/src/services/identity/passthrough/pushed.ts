/// <reference types="@cloudflare/workers-types" />

/**
 * `POST /<p>/identity/request`, the pushed authorization request (RFC 9126; WIRE-CONTRACT-V5
 * §12.12; plans/I-15.md §2).
 *
 * A native app sends the parameters `authorize` takes, with a native `redirect_uri` (loopback, a
 * registered scheme or a claimed HTTPS path), the device label and an optional `return_uri`, and
 * gets a `request_uri` to open `authorize` with. The same checks as `authorize` run here
 * (`buildAuthz`), so a request that gets a URI is one `authorize` would have accepted. The answer
 * is flat (RFC 6749 §5.2 shape), `no-store`, and carries no CORS headers: only a native client
 * calls this.
 *
 *   method, rate limit (30 a minute per client network), form body, `client_id`, the device id,
 *   rate limit (10 a minute per device id), `redirect_uri` (native classes only), the shared
 *   `authorize` checks, `return_uri`, then the record is stored (`pushedStore.ts`).
 */

import { HEADER_DEVICE } from "@polaris-key/protocol/core";
import { PUSHED_REQUEST_TTL_SECONDS } from "@polaris-key/protocol/identity";
import { normalizeDeviceLabel } from "@polaris-key/client-core";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { Product } from "../../../core/products.js";
import type { SettingsRegistry } from "../../../core/settings/registry.js";
import { ErrorCode, methodNotAllowed } from "../../../core/errors.js";
import { clientNetwork, rateLimitOk } from "../../../core/rateLimit.js";
import { isValidClientDeviceId } from "../../../core/devices.js";
import { buildAuthz } from "./authorize.js";
import { redirectRegistrationOf, validateRedirectUri } from "./redirectUri.js";
import { putPushed } from "./pushedStore.js";
import { oauth, readForm } from "./token.js";

/** `request` writes one record: 30 a minute per client network, 10 per device id; both fail closed. */
export const REQUEST_RATE = {
  bucket: "identityRequest",
  limit: 30,
  windowSec: 60,
};
export const REQUEST_DEVICE_RATE = {
  bucket: "identityRequestDevice",
  limit: 10,
  windowSec: 60,
};

export async function handlePushedRequest(ctx: {
  req: Request;
  env: Env;
  db: Db;
  product: Product;
  now: number;
  settings?: SettingsRegistry;
}): Promise<Response> {
  const { req, env, db, product, now } = ctx;
  if (req.method !== "POST") return methodNotAllowed();
  const limited = (rate: { windowSec: number }): Response =>
    oauth(429, "rate_limited", undefined, { retryAfter: rate.windowSec });
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { ...REQUEST_RATE, id: clientNetwork(req) },
      now,
    ))
  )
    return limited(REQUEST_RATE);

  const form = await readForm(req);
  if (!form)
    return oauth(
      400,
      ErrorCode.InvalidRequest,
      "A form-encoded body is required.",
    );
  if (form.get("client_id") !== product.slug)
    return oauth(401, ErrorCode.InvalidClient);
  const deviceId = req.headers.get(HEADER_DEVICE);
  if (!deviceId || !isValidClientDeviceId(deviceId))
    return oauth(400, ErrorCode.InvalidRequest, "X-PKey-Device is required.");
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { ...REQUEST_DEVICE_RATE, id: deviceId },
      now,
    ))
  )
    return limited(REQUEST_DEVICE_RATE);

  const registration = await redirectRegistrationOf(
    { env, db, ...(ctx.settings ? { registry: ctx.settings } : {}) },
    product,
  );
  const verdict = validateRedirectUri(
    registration,
    form.get("redirect_uri"),
    "native",
  );
  if (!verdict.ok || verdict.redirect === "web")
    return oauth(400, ErrorCode.RedirectUriMismatch);

  const built = await buildAuthz(
    { env, db, product },
    (n) => form.get(n),
    verdict.uri,
  );
  if (!built.ok) return oauth(400, built.error);

  // `return_uri` is a registered scheme's redirect URI: it brings the app forward, never a code.
  let returnUri: string | null = null;
  const rawReturn = form.get("return_uri");
  if (rawReturn !== undefined) {
    const r = validateRedirectUri(registration, rawReturn, "native");
    if (!r.ok || r.redirect !== "scheme")
      return oauth(
        400,
        ErrorCode.InvalidRequest,
        "return_uri must be a registered scheme's redirect URI.",
      );
    returnUri = r.uri;
  }

  let requestUri: string;
  try {
    requestUri = await putPushed(
      env,
      product.slug,
      {
        authz: built.authz,
        redirect: verdict.redirect,
        deviceId,
        deviceLabel: normalizeDeviceLabel(form.get("device_name")),
        returnUri,
      },
      now,
    );
  } catch {
    return oauth(503, "server_error");
  }
  const res = new Response(
    JSON.stringify({
      request_uri: requestUri,
      expires_in: PUSHED_REQUEST_TTL_SECONDS,
    }),
    { status: 201, headers: { "content-type": "application/json" } },
  );
  res.headers.set("cache-control", "no-store");
  res.headers.set("pragma", "no-cache");
  return res;
}
