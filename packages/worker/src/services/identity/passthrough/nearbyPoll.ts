/// <reference types="@cloudflare/workers-types" />

/**
 * `POST /<p>/identity/nearby/poll` (I-40.7; WIRE-CONTRACT-V5 §12.11.5 rule 10): the new device D
 * collects the outcome of its request, and its credential.
 *
 *   ← {request, proof}, `X-PKey-Device`
 *   → 200 {status: "pending"}                         undecided (a claimed request is pending too)
 *   → 200 {status: "error", reason: "access_denied"}  a denial (sticky)
 *   → 200 {status: "timeout"}                         unknown, expired, collected, or D was removed or rebound
 *   → 200 TokenResponse                               once
 *   → 429 {status: "slow_down", interval}             inside the interval
 *   → 503 {error: "unavailable"} + Retry-After        a storage failure; the request is kept
 *   → 400 invalid_grant                               one body for a wrong proof or a wrong device
 *
 * ── THE ORDER OF CHECKS ─────────────────────────────────────────────────────────────────────
 *
 *   the three gates (an off route is `404`, even for a malformed body), the body's shape, the
 *   coarse per-network budget, the device header, the request (absent: `timeout`), the
 *   `nearby-poll` proof by the key `start` recorded and the device `start` named, the poll slot (a
 *   compare-and-set on `lastPollAt`), THEN the answer from the state.
 *
 * ── THE CREDENTIAL ──────────────────────────────────────────────────────────────────────────
 *
 * Approval stored only the hash of D's credential. The poll replaces it with a new one in a single
 * conditional update that names that hash, so of any number of polls one receives the token and
 * the stored hash stops validating at the same statement. The request is then dropped; if the
 * drop fails, the recorded hash no longer matches the device and a later poll answers `timeout`.
 * Everything that can fail is done before the swap, so a failure never costs D its token while
 * the request is gone.
 */

import { SingleUseUnavailableError } from "../../../core/singleUse.js";
import {
  DEVICE_POLL_DENIED,
  NEARBY_POLL_INTERVAL_SECONDS,
  NEARBY_REQUEST_PATTERN,
  type NearbyPollRequest,
  type NearbyPollResponse,
} from "@polaris-key/protocol/identity";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { Product } from "../../../core/products.js";
import { ErrorCode, json, wireError } from "../../../core/errors.js";
import { NO_LICENSE_ID, swapDeviceCredential } from "../../../core/devices.js";
import { getDevice } from "../../../core/devices/store.js";
import { verifyDeviceProof } from "../../../core/devices/proof.js";
import { consentedClaims } from "../../../core/accounts/contactEmail.js";
import { deviceHolder } from "../attach.js";
import { resolveScope } from "./authorize.js";
import { tokenBody } from "./token.js";
import { gatedDeviceBody } from "./nearbyStart.js";
import {
  dropNearby,
  nearbyRef,
  readNearby,
  takeNearbyPollSlot,
  type NearbyRequestRecord,
} from "./nearbyStore.js";

/** The coarse ceiling: 60 a minute per client network, failing closed (§12.11.5 rule 12). */
export const NEARBY_POLL_RATE = {
  bucket: "identityNearbyPoll",
  limit: 60,
  windowSec: 60,
} as const;

/** The handle and a proof. */
const MAX_BODY = 2 * 1024;
const FIELD_MAX = 1024;
const HANDLE = new RegExp(NEARBY_REQUEST_PATTERN);

const noStore = { "cache-control": "no-store", pragma: "no-cache" };
const answer = (body: NearbyPollResponse, status = 200): Response =>
  json(body, { status, headers: noStore });
const timeout = (): Response => answer({ status: "timeout" });

/** A storage failure: nothing was consumed, so the same poll may be repeated after the interval. */
function unavailable(): Response {
  return json(
    { error: "unavailable", message: "try again" },
    {
      status: 503,
      headers: {
        ...noStore,
        "retry-after": String(NEARBY_POLL_INTERVAL_SECONDS),
      },
    },
  );
}

/** The request store could not be reached: a retryable `503`, never a terminal `timeout`. */
function storeDown(e: unknown): Response {
  if (e instanceof SingleUseUnavailableError) return unavailable();
  throw e;
}

/** The body, or null when it is not exactly the documented shape. */
function parseBody(r: Record<string, unknown>): NearbyPollRequest | null {
  const { request, proof } = r;
  if (
    typeof request !== "string" ||
    request.length > FIELD_MAX ||
    !HANDLE.test(request) ||
    typeof proof !== "string" ||
    proof.length > FIELD_MAX
  )
    return null;
  return { request, proof };
}

/** The scope D's token carries: what the app asks, narrowed to the standing consent's claims. */
async function consentedScope(
  db: Db,
  product: Product,
  accountId: string,
): Promise<string[]> {
  const grant = await db.first<{ claims_json: string }>(
    "SELECT claims_json FROM account_product_grants WHERE account_id = ? AND product = ?",
    accountId,
    product.slug,
  );
  const claims = consentedClaims(grant?.claims_json);
  return (resolveScope(undefined, product) ?? []).filter((c) => claims.has(c));
}

export async function handleNearbyPoll(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  // 1. The gates, then the shape (an off route is 404 even for a bad body); 2. the coarse budget
  // per client network; 3. X-PKey-Device.
  const cx = { req, env, db, product, now };
  const got = await gatedDeviceBody(cx, MAX_BODY, parseBody, NEARBY_POLL_RATE);
  if (got instanceof Response) return got;
  const { body, deviceId } = got;

  // 4. The request. Absent, expired, collected or ended: `timeout`.
  const ref = await nearbyRef(env, product.slug, body.request);
  if (!ref) return timeout();
  let rec: NearbyRequestRecord | null;
  try {
    rec = await readNearby(env, ref);
  } catch (e) {
    return storeDown(e);
  }
  if (!rec || rec.product !== product.slug) return timeout();

  // 5. The proof, by the key `start` recorded, for the device `start` named. One body for either.
  if (
    rec.deviceId !== deviceId ||
    !(await verifyDeviceProof({
      purpose: "nearby-poll",
      product: product.slug,
      deviceId,
      value: body.request,
      tokenHash: "-",
      signKey: rec.signKey,
      sig: body.proof,
    }))
  )
    return wireError(400, ErrorCode.InvalidGrant);

  // 6. The poll slot: inside the interval, then a compare-and-set so of two polls racing one proceeds.
  const slowDown = (): Response =>
    answer(
      { status: "slow_down", interval: NEARBY_POLL_INTERVAL_SECONDS },
      429,
    );
  if (
    rec.lastPollAt !== undefined &&
    now - rec.lastPollAt < NEARBY_POLL_INTERVAL_SECONDS
  )
    return slowDown();
  let slot: Awaited<ReturnType<typeof takeNearbyPollSlot>>;
  try {
    slot = await takeNearbyPollSlot(env, ref, rec.lastPollAt, now);
  } catch (e) {
    return storeDown(e);
  }
  if (!slot.ok) return slot.record ? slowDown() : timeout();

  // 7. The answer from the state.
  const cur = slot.record;
  if (cur.state === "denied")
    return answer({ status: "error", reason: DEVICE_POLL_DENIED });
  if (cur.state !== "approved") return answer({ status: "pending" });
  return collect(env, db, product, ref, cur, now);
}

/** An approved request: swap D's credential once and answer it. */
async function collect(
  env: Env,
  db: Db,
  product: Product,
  ref: NonNullable<Awaited<ReturnType<typeof nearbyRef>>>,
  rec: NearbyRequestRecord,
  now: number,
): Promise<Response> {
  let out: Response | null = null;
  try {
    const device = await getDevice(db, product.slug, rec.deviceId);
    const held = rec.tokenHash ? rec.tokenHash : null;
    const bound =
      device !== null &&
      held !== null &&
      device.status === "authorized" &&
      device.token_hash === held &&
      !!rec.subject &&
      device.subject === rec.subject &&
      device.license_id === (rec.licenseId ?? NO_LICENSE_ID);
    // Removed, rebound or replaced since the approval: nothing to hand over.
    if (!bound || !device || !held || !rec.subject) {
      await dropNearby(env, ref);
      return timeout();
    }
    // Everything that can fail is read before the swap. The scope is the standing consent's.
    const holder = await deviceHolder(
      env,
      db,
      product.slug,
      device.subject,
      now,
    );
    if (holder === "unavailable") return unavailable();
    if (!holder) {
      await dropNearby(env, ref);
      return timeout();
    }
    const scope = await consentedScope(db, product, holder.accountId);
    const ready = await tokenBody(
      db,
      product,
      device.device_id,
      scope,
      rec.subject,
      {
        ok: true,
        token: "",
        device: { ...device, last_seen: now },
        licenseId: device.license_id,
      },
    );

    const swapped = await swapDeviceCredential(
      env,
      db,
      product,
      device,
      held,
      now,
    );
    if (!swapped) {
      // Another poll won, or the device changed under this one.
      await dropNearby(env, ref);
      return timeout();
    }
    out = answer({ ...ready, access_token: swapped.token });
  } catch {
    return unavailable();
  }
  try {
    await dropNearby(env, ref);
  } catch {
    // The recorded hash no longer matches the device, so a later poll answers `timeout`.
  }
  return out;
}
