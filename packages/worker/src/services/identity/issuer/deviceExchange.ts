/**
 * The device exchange, D6 (I-21.13; V5 §12.13.10; threat IS-11). A product's own app trades its
 * device token for a 600 s access token its developer's backend can verify (SP-68):
 * `POST /<p>/identity/token`, grant `urn:ietf:params:oauth:grant-type:token-exchange`,
 * `client_id` = the product slug, `subject_token` = the caller's own `pkeyt_`,
 * `subject_token_type` `urn:polaris-key:token-type:device`, `requested_token_type`
 * `urn:ietf:params:oauth:token-type:access_token`.
 *
 * ── WHAT IT NEVER DOES ──────────────────────────────────────────────────────────────────────
 *
 * It never yields more than the device token already is: no refresh token, no `id_token`, no
 * `openid` (the own client is refused it everywhere else), no `auth_time`, no `pkey:entitlements`
 * and an empty `scope`. The access token's `sub` is the device's pairwise subject, its
 * `client_id` the slug, its `aud` the issuer. A registered client never gets here (`token.ts` routes
 * it to `unauthorized_client`).
 *
 * ── THE CHECKS, IN ORDER ────────────────────────────────────────────────────────────────────
 *
 *   1. Served only while Identity is on (the registry has established it) AND the issuer is served;
 *      else the subject token type is unknown: `400 invalid_request`, as §12.11.7 answers one.
 *   2. Shape: `client_id`, `requested_token_type` and `subject_token` present, no `actor_token` or
 *      `actor_token_type`, `X-PKey-Device` well formed (all `invalid_request`; a `client_id` that
 *      is not the slug is `invalid_client`). `scope`, `audience` and `resource` are ignored.
 *   3. The budget, 10 a minute per device id, failing closed (the per-network budget ran before).
 *   4. One `invalid_grant` for every refusal of the credential: the subject token is not a live
 *      device token of this product, is not the one `X-PKey-Device` names, or the device holds no
 *      sign-in (a bound pairwise subject whose account is active and not erased).
 */

import {
  ACCESS_TOKEN_TYPE,
  ACCESS_TOKEN_TYP,
  ISSUER_TOKEN_TTL_SECONDS,
  type AccessTokenExchangeResponse,
} from "@polaris-key/protocol/identity";
import { HEADER_DEVICE } from "@polaris-key/protocol/core";
import { ErrorCode } from "../../../core/errors.js";
import { rateLimitOk } from "../../../core/rateLimit.js";
import {
  isValidClientDeviceId,
  validateDeviceToken,
} from "../../../core/devices.js";
import type { Product } from "../../../core/products.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { randomToken } from "../../../platform/random.js";
import { deviceHolder } from "../attach.js";
import { oauth } from "../passthrough/oauthHttp.js";
import { TOKEN_DEVICE_RATE } from "../passthrough/token.js";
import { signIssuerJwt } from "./keys.js";
import { issuerServed } from "./served.js";

export async function handleDeviceExchange(cx: {
  req: Request;
  env: Env;
  db: Db;
  product: Product;
  now: number;
  form: ReadonlyMap<string, string>;
}): Promise<Response> {
  const { req, env, db, product, now, form } = cx;
  if (!(await issuerServed(db, product.slug)))
    return oauth(
      400,
      ErrorCode.InvalidRequest,
      "subject_token_type is not supported.",
    );
  const clientId = form.get("client_id");
  if (!clientId)
    return oauth(400, ErrorCode.InvalidRequest, "client_id is required.");
  if (clientId !== product.slug) return oauth(401, ErrorCode.InvalidClient);
  if (form.has("actor_token") || form.has("actor_token_type"))
    return oauth(
      400,
      ErrorCode.InvalidRequest,
      "An actor token is not served.",
    );
  if (form.get("requested_token_type") !== ACCESS_TOKEN_TYPE)
    return oauth(
      400,
      ErrorCode.InvalidRequest,
      "requested_token_type must be an access token.",
    );
  const subjectToken = form.get("subject_token");
  if (!subjectToken)
    return oauth(400, ErrorCode.InvalidRequest, "subject_token is required.");
  const deviceId = req.headers.get(HEADER_DEVICE);
  if (!deviceId || !isValidClientDeviceId(deviceId))
    return oauth(400, ErrorCode.InvalidRequest, "X-PKey-Device is required.");
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { ...TOKEN_DEVICE_RATE, id: deviceId },
      now,
    ))
  )
    return oauth(429, "rate_limited", undefined, {
      retryAfter: TOKEN_DEVICE_RATE.windowSec,
    });

  const valid = await validateDeviceToken(env, db, product, subjectToken, now, {
    deviceId,
  });
  if ("error" in valid) return oauth(400, ErrorCode.InvalidGrant);
  const holder = await deviceHolder(
    env,
    db,
    product.slug,
    valid.device.subject,
    now,
  );
  if (holder === "unavailable") return oauth(503, "erasure_ledger_unavailable");
  if (holder === null) return oauth(400, ErrorCode.InvalidGrant);

  const issuer = `${new URL(req.url).origin}/${product.slug}/identity`;
  const accessToken = await signIssuerJwt(
    env,
    db,
    product.slug,
    ACCESS_TOKEN_TYP,
    {
      iss: issuer,
      sub: holder.subject,
      aud: issuer,
      client_id: product.slug,
      iat: now,
      exp: now + ISSUER_TOKEN_TTL_SECONDS,
      jti: randomToken(16),
      scope: "",
    },
    now,
  );
  const body: AccessTokenExchangeResponse = {
    access_token: accessToken,
    issued_token_type: ACCESS_TOKEN_TYPE,
    token_type: "Bearer",
    expires_in: ISSUER_TOKEN_TTL_SECONDS,
    scope: "",
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      pragma: "no-cache",
    },
  });
}
