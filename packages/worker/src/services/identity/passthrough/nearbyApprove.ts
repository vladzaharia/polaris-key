/// <reference types="@cloudflare/workers-types" />

/**
 * `POST /<p>/identity/nearby/approve` (I-40.5; WIRE-CONTRACT-V5 §12.11.5): the signed-in device M
 * decides a request the new device D started. THIS FILE HOLDS THE CHECKS, THE DENIAL AND THE
 * `choose` ANSWER; THE BIND IS I-40.6 (the seam is marked below).
 *
 *   ← {request, signKey, agreeKey, decision: "approve" | "deny", choice?, proof}, M's bearer
 *   → 204                                  a denial (sticky)
 *   → 200 {status: "choose", choices}      a choice is due; nothing is written
 *
 * ── THE ORDER OF CHECKS ─────────────────────────────────────────────────────────────────────
 *
 *   the three gates (each off state is `404 not_found`, even for a malformed body), the body's
 *   shape (a `choice` other than `{kind:"license", licenseId}` or `{kind:"create"}` is
 *   `400 bad_request`), M's bearer, M's budget, M signed in (`403 account_required`), M's
 *   registered signing key (`409 device_keys_required`), the `nearby-approve` proof over the
 *   handle (`400 invalid_grant`, one body), THEN the request: unknown, expired, decided or another
 *   product's is `404 not_found`; M's own request is the same `404`; keys that differ from the
 *   start's are the same `404` and count an attempt, the third ending the request; a client
 *   network other than the start's is `403 not_nearby` and leaves the request open.
 *
 * The handle's address carries the product, so another product's handle is simply absent.
 *
 * ── PROXIMITY ───────────────────────────────────────────────────────────────────────────────
 *
 * The approver's `clientNetwork` (IPv4 exact, IPv6 /64, an IPv4-mapped IPv6 address as its IPv4) is
 * hashed with the same pepper as `start`'s and compared with the stored `netHash`; no raw address
 * is kept.
 *
 * ── BUDGETS ─────────────────────────────────────────────────────────────────────────────────
 *
 * 10 a minute per M device, charged on every call that reaches the check; 5 an hour per subject,
 * charged on decisions only (a denial, or an attempt to bind), never on a `choose` answer or on a
 * refusal before the request is found. Both fail closed.
 */

import type {
  LicenseChoiceView,
  NearbyApproveRequest,
  NearbyApproveResponse,
  NearbyChoiceInput,
} from "@polaris-key/protocol/identity";
import { NEARBY_REQUEST_PATTERN } from "@polaris-key/protocol/identity";
import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import type { Product } from "../../../core/products.js";
import { appendAudit } from "../../../core/audit.js";
import { randomId } from "../../../platform/crypto.js";
import { ErrorCode, json, wireError } from "../../../core/errors.js";
import { rateLimitOk } from "../../../core/rateLimit.js";
import { deviceSignKey } from "../../../core/devices/keys.js";
import { verifyDeviceProof } from "../../../core/devices/proof.js";
import { deviceHolder, deviceOf } from "../attach.js";
import { gatedBody } from "./nearbyStart.js";
import { licenseChoiceView, offerFor } from "./choice.js";
import {
  claimNearby,
  decideNearby,
  mismatchNearby,
  nearbyNetHash,
  nearbyRef,
  readNearby,
  type NearbyRequestRecord,
} from "./nearbyStore.js";

/** 10 a minute per approving device, failing closed (§12.11.5 rule 12). */
export const NEARBY_APPROVE_RATE = {
  bucket: "identityNearbyApprove",
  limit: 10,
  windowSec: 60,
} as const;
/** 5 an hour per subject, charged on decisions only (Q9), failing closed. */
export const NEARBY_APPROVE_SUBJECT_RATE = {
  bucket: "identityNearbyApproveSubject",
  limit: 5,
  windowSec: 3600,
} as const;

/** The handle, two keys, a proof and a choice. */
const MAX_BODY = 4 * 1024;
const FIELD_MAX = 1024;
const HANDLE = new RegExp(NEARBY_REQUEST_PATTERN);

/** Unknown, expired, decided, another product's, M's own, or keys that differ: one answer. */
const notFoundNested = (): Response => wireError(404, ErrorCode.NotFound);

/** The body, or null when it is not exactly the documented shape. */
function parseBody(r: Record<string, unknown>): NearbyApproveRequest | null {
  const { request, signKey, agreeKey, decision, choice, proof } = r;
  const text = (v: unknown): v is string =>
    typeof v === "string" && v.length <= FIELD_MAX;
  if (
    !text(request) ||
    !HANDLE.test(request) ||
    !text(signKey) ||
    !text(agreeKey) ||
    !text(proof) ||
    (decision !== "approve" && decision !== "deny")
  )
    return null;
  let picked: NearbyChoiceInput | undefined;
  if (choice !== undefined) {
    if (!choice || typeof choice !== "object" || Array.isArray(choice))
      return null;
    const c = choice as Record<string, unknown>;
    const members = Object.keys(c).sort().join(",");
    if (c.kind === "create" && members === "kind") picked = { kind: "create" };
    else if (
      c.kind === "license" &&
      members === "kind,licenseId" &&
      text(c.licenseId) &&
      c.licenseId !== ""
    )
      picked = { kind: "license", licenseId: c.licenseId };
    else return null;
  }
  return {
    request,
    signKey,
    agreeKey,
    decision,
    proof,
    ...(picked ? { choice: picked } : {}),
  };
}

/**
 * Whether the person on M must choose before D can be bound: the licence service is on and the
 * account's offer is anything but "nothing" or "exactly one candidate with a free seat" (§12.11.5
 * rule 7). `create` is never silent, so a policy grant with no free candidate is a choice too.
 */
async function choiceDue(
  cx: { env: Env; db: Db; product: Product; now: number },
  accountId: string,
  deviceId: string,
): Promise<boolean> {
  if (!cx.product.services.license.enabled) return false;
  const offer = await offerFor(cx, accountId, deviceId);
  const free = offer.candidates.filter((c) => c.state === "free").length;
  if (free === 1) return false;
  return offer.candidates.length > 0 || offer.keep || offer.create;
}

/** The method, the gates and the shape. */
const gatedApproval = (req: Request, env: Env, db: Db, product: Product) =>
  gatedBody(req, env, db, product, MAX_BODY, parseBody);

export async function handleNearbyApprove(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  // 1. The gates, then the shape (§12.11.5 rule 13: an off route is 404 even for a bad body).
  const body = await gatedApproval(req, env, db, product);
  if (body instanceof Response) return body;

  // 3. M's bearer, then its budget.
  const auth = await deviceOf(req, env, db, product, now);
  if (auth instanceof Response) return auth;
  const { deviceId: approver, valid } = auth;
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { ...NEARBY_APPROVE_RATE, id: approver },
      now,
    ))
  )
    return wireError(429, "rate_limited");

  // 4. M is signed in on the product, and has a registered signing key.
  const holder = await deviceHolder(
    env,
    db,
    product.slug,
    valid.device.subject,
    now,
  );
  if (holder === "unavailable") return wireError(503, "unavailable");
  if (!holder) return wireError(403, ErrorCode.AccountRequired);
  const approverKey = await deviceSignKey(db, product.slug, approver);
  if (approverKey === null) return wireError(409, ErrorCode.DeviceKeysRequired);

  // 5. The proof, by M's registered key; one body for every cause.
  if (
    !(await verifyDeviceProof({
      purpose: "nearby-approve",
      product: product.slug,
      deviceId: approver,
      value: body.request,
      tokenHash: "-",
      signKey: approverKey,
      sig: body.proof,
    }))
  )
    return wireError(400, ErrorCode.InvalidGrant);

  // 6. The request.
  const ref = await nearbyRef(env, product.slug, body.request);
  if (!ref) return notFoundNested();
  const rec: NearbyRequestRecord | null = await readNearby(env, ref);
  if (!rec || rec.product !== product.slug) return notFoundNested();
  if (rec.state === "approved" || rec.state === "denied")
    return notFoundNested();
  if (rec.deviceId === approver) return notFoundNested();

  // The keys M sends are the ones D started with (learned from D's authenticated VOUCH_REQ).
  if (body.signKey !== rec.signKey || body.agreeKey !== rec.agreeKey) {
    await mismatchNearby(env, ref);
    return notFoundNested();
  }

  // 7. Proximity: the approver's network, hashed as `start`'s was.
  if ((await nearbyNetHash(env, req)) !== rec.netHash)
    return wireError(403, "not_nearby");

  // 8. A denial: charged on the subject, then final.
  if (body.decision === "deny") {
    if (
      !(await rateLimitOk(
        env,
        product.slug,
        { ...NEARBY_APPROVE_SUBJECT_RATE, id: holder.subject },
        now,
      ))
    )
      return wireError(429, "rate_limited");
    const claimed = await claimNearby(env, ref, approver, now);
    if (!claimed.ok) return notFoundNested();
    const decided = await decideNearby(env, ref, approver, { deny: true }, now);
    if (!decided.ok) return notFoundNested();
    await appendAudit(db, {
      product: product.slug,
      id: randomId("aud"),
      at: now,
      actor_sub: holder.subject,
      actor_name: null,
      actor_email: null,
      action: "identity.nearby.denied",
      target_kind: "device",
      target_id: rec.deviceId,
      parent_id: null,
      summary: `A nearby sign-in was denied${rec.label ? ` for ${rec.label}` : ""} (via nearby)`,
    });
    return new Response(null, {
      status: 204,
      headers: { "cache-control": "no-store" },
    });
  }

  // 9. An approval with no `choice` while one is due: answer the candidates, write nothing, and
  // charge nothing (Q9).
  if (
    body.choice === undefined &&
    (await choiceDue({ env, db, product, now }, holder.accountId, rec.deviceId))
  ) {
    const choices: LicenseChoiceView = await licenseChoiceView(
      { env, db, product, now },
      req,
      holder.accountId,
      { deviceId: rec.deviceId },
    );
    const out: NearbyApproveResponse = { status: "choose", choices };
    return json(out);
  }

  // 10. I-40.6: the bind goes here. Claim the request (`claimNearby`), charge
  // NEARBY_APPROVE_SUBJECT_RATE, bind (`license`, `create`, licence-less or the silent single),
  // register D's keys, apply the consent rule, decide (`decideNearby`), audit, email, and answer
  // `200 {status: "approved", deviceLabel}`. Until then an approval that is not a `choose` is
  // refused with nothing written and the request left open.
  return wireError(503, "unavailable");
}
