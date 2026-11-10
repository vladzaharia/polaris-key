/// <reference types="@cloudflare/workers-types" />

/**
 * The key return on the card (WIRE-CONTRACT-V5 §12.4.2; plans/LK-SKIP.md §6):
 *
 *   POST /api/signin/requests/:handle/key   {key}  ->  {redirect}
 *
 * A person sent to the card by an app, who holds a licence key, returns to the app on that licence
 * without an account. The route reads no session. It needs the `__Host-pk_req` binder of the
 * browser that started the request, a request that recorded `key_return=allow`, and the key. The
 * code it issues names the key by its peppered hash and the licence, no account and no scope;
 * `token` binds the device.
 *
 * ── THE KEY IS IN THE BODY ONLY ─────────────────────────────────────────────────────────────
 *
 * Never in a URL, the redirect, the request or code record, a log or the audit. The code holds
 * `keyHash`, the peppered hash D1 already stores; it cannot be presented as a key.
 *
 * ── THE ORDER OF REFUSALS (none consumes anything) ──────────────────────────────────────────
 *
 *   1. Method `POST`, else 405. Cross-origin: 404. Not JSON, over 1 KiB, or not a JSON object:
 *      400 `invalid_request`.
 *   2. `identityKeyReturn`, 10 a minute per client network, charged before any lookup and failing
 *      closed: 429 with `retryAfter`.
 *   3. 404, always in one shape: no live request for this binder (or Identity off), no
 *      `authz.keyReturn` (a device-code request never has one), the launch gate off, License off.
 *   4. `identityKeyReturnRequest`, 5 per handle in 600 s (keyed by the handle's peppered hash):
 *      429.
 *   5. A malformed key is 422 `bad_request`. A key of another product, an unknown or inactive
 *      key, a missing licence, or a licence that is not usable is 401 `unauthorized` (the answers
 *      of `POST /api/key/preview`, and of `license/activate` for an unusable licence).
 *   6. A licence in an account: 403 `license_owned` with `signInUrl`, whatever
 *      `identity.keyEntryRefusals` says. An owned licence never moves by key through the card.
 *   7. Refusals on and `used >= limit`: 403 `key_entry_limit` with `keyEntries` and `manageUrl`.
 *   8. `takeSignInRequest`: one atomic consume, so a lost race is 404. Then the code.
 *
 * Seats are not checked here: the device is unknown until `token`. The portal switches are not
 * read, because this is an activation, not a claim.
 */

import { appendAudit } from "../../../core/audit.js";
import { ErrorCode } from "../../../core/errors.js";
import { hashKey, productFromKey, randomId } from "../../../platform/crypto.js";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { SettingsRegistry } from "../../../core/settings/registry.js";
import { launchGateOn } from "../../../core/settings/platformRead.js";
import { clientNetwork, rateLimitOk } from "../../../core/rateLimit.js";
import {
  hasJsonContentType,
  isSameOriginRequest,
  readTextCapped,
} from "../../../core/accounts/browserRequestGuard.js";
import { getKey, getLicense } from "../../../core/licensing/store.js";
import { licenseUsable } from "../../../core/devices.js";
import {
  keyEntryRefusalsOn,
  keyEntryState,
} from "../../../core/licensing/keyEntries.js";
import {
  buildManageUrl,
  buildSignInUrl,
} from "../../../core/licensing/manageUrl.js";
import { cardJson } from "../card/http.js";
import { issuerOf } from "./authorize.js";
import { issueAuthorizationCode } from "./code.js";
import { takeSignInRequest } from "./request.js";
import { takeNativeOnce, withLoopbackRequest } from "./pushedStore.js";
import { liveRequest } from "./routes.js";

/** 10 a minute per client network, charged before any lookup. */
export const KEY_RETURN_RATE = {
  bucket: "identityKeyReturn",
  limit: 10,
  windowSec: 60,
};

/** 5 per request handle in 600 s (the handle's own lifetime), keyed by its peppered hash. */
export const KEY_RETURN_REQUEST_RATE = {
  bucket: "identityKeyReturnRequest",
  limit: 5,
  windowSec: 600,
};

/** The body is `{key}`: a key is 5 + slug + 1 + 22 characters, so 1 KiB is generous. */
export const KEY_RETURN_BODY_MAX_BYTES = 1024;

const NOT_FOUND = (): Response => cardJson({ error: ErrorCode.NotFound }, 404);
const refuse = (status: number, error: string, extra?: object): Response =>
  cardJson({ error, ...extra }, status);

function rateLimited(retryAfter: number): Response {
  const res = refuse(429, "rate_limited", { retryAfter });
  res.headers.set("retry-after", String(retryAfter));
  return res;
}

/** The body as a JSON object, or `null`: not JSON, too large, or not an object. */
async function readKeyBody(
  req: Request,
): Promise<Record<string, unknown> | null> {
  if (!hasJsonContentType(req)) return null;
  let raw: string | null;
  try {
    raw = await readTextCapped(req, KEY_RETURN_BODY_MAX_BYTES);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** `POST /api/signin/requests/:handle/key`. */
export async function handleSignInKeyReturn(
  req: Request,
  env: Env,
  db: Db,
  handle: string,
  now: number,
  settings?: SettingsRegistry,
): Promise<Response> {
  // 1. Method, origin, then the body's shape.
  if (req.method !== "POST") return refuse(405, "method_not_allowed");
  if (!isSameOriginRequest(req)) return NOT_FOUND();
  const body = await readKeyBody(req);
  if (body === null) return refuse(400, ErrorCode.InvalidRequest);

  // 2. The network's budget, before any lookup.
  if (
    !(await rateLimitOk(
      env,
      "_portal",
      { ...KEY_RETURN_RATE, id: clientNetwork(req) },
      now,
    ))
  )
    return rateLimited(KEY_RETURN_RATE.windowSec);

  // 3. One shape for every "no": the request, the opt-in, the gate and License.
  const live = await liveRequest(env, db, req, handle, now);
  if (!live?.record.authz?.keyReturn) return NOT_FOUND();
  if (!(await launchGateOn(env, db, "launch.identityKeyReturn")))
    return NOT_FOUND();
  const { product } = live;
  if (!product.services.license.enabled) return NOT_FOUND();

  // 4. This request's own budget.
  if (
    !(await rateLimitOk(
      env,
      "_portal",
      {
        ...KEY_RETURN_REQUEST_RATE,
        id: await hashKey(handle, env.KEY_HASH_PEPPER),
      },
      now,
    ))
  )
    return rateLimited(KEY_RETURN_REQUEST_RATE.windowSec);

  // 5. The key: the preview's answers.
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const slug = productFromKey(key);
  if (!slug) return refuse(422, ErrorCode.BadRequest);
  const unauthorized = (): Response => refuse(401, ErrorCode.Unauthorized);
  if (slug !== product.slug) return unauthorized();
  const keyHash = await hashKey(key, env.KEY_HASH_PEPPER);
  const keyRow = await getKey(db, product.slug, keyHash);
  if (!keyRow || keyRow.status !== "active") return unauthorized();
  const license = await getLicense(db, product.slug, keyRow.license_id);
  if (!license || !licenseUsable(license, now)) return unauthorized();

  // 6. A licence in an account never moves by key through the card.
  if ((license.account_id ?? null) !== null)
    return refuse(403, ErrorCode.LicenseOwned, {
      signInUrl: await buildSignInUrl(env, db, req, product),
    });

  // 7. The key-entry limit, as `license/activate` would refuse a new device. The card cannot see
  // the device, so an enrolled device on a full licence is refused here although `license/activate`
  // would admit it.
  const keyEntries = await keyEntryState(
    { env, db, ...(settings ? { registry: settings } : {}) },
    product,
    license.id,
  );
  if (
    keyEntries &&
    keyEntries.used >= keyEntries.limit &&
    (await keyEntryRefusalsOn(env, db))
  ) {
    const manageUrl = await buildManageUrl(env, db, req, product, {
      kind: "key_entry_limit",
    });
    return refuse(403, ErrorCode.KeyEntryLimit, {
      keyEntries,
      ...(manageUrl !== undefined ? { manageUrl } : {}),
    });
  }

  // 8. One press, one code. A lost race finds the request gone.
  const record = await takeSignInRequest(env, req, handle, now);
  if (!record?.authz) return NOT_FOUND();
  if (!(await takeNativeOnce(env, record, now))) return NOT_FOUND();
  const { authz } = record;
  await appendAudit(db, {
    product: product.slug,
    id: randomId("aud"),
    at: now,
    actor_sub: null,
    actor_name: null,
    actor_email: null,
    action: "signin.key",
    target_kind: "license",
    target_id: license.id,
    parent_id: null,
    summary: `Returned to ${authz.clientId} (${record.kind}) on a license key`,
  });
  const code = await issueAuthorizationCode(
    env,
    {
      kind: "key",
      product: product.slug,
      clientId: authz.clientId,
      redirectUri: authz.redirectUri,
      // Empty on purpose: a `token` that predates this route resolves no account and answers
      // `invalid_grant`.
      accountId: "",
      subject: "",
      scope: [],
      choice: null,
      licenseId: license.id,
      keyHash,
      nonce: authz.nonce,
      licenseChoice: authz.licenseChoice,
      ...(record.native ? { deviceId: record.native.deviceId } : {}),
    },
    authz.codeChallenge,
  );
  const target = new URL(authz.redirectUri);
  target.searchParams.set("code", code);
  if (authz.state !== null) target.searchParams.set("state", authz.state);
  target.searchParams.set("iss", issuerOf(req, product));
  return cardJson({
    redirect: withLoopbackRequest(target.toString(), record, handle),
  });
}
