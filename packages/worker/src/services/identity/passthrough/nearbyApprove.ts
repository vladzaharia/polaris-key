/// <reference types="@cloudflare/workers-types" />

/**
 * `POST /<p>/identity/nearby/approve` (I-40.5; WIRE-CONTRACT-V5 §12.11.5): the signed-in device M
 * decides a request the new device D started: the checks, a denial, the `choose` answer and
 * (I-40.6) the bind.
 *
 *   ← {request, signKey, agreeKey, decision: "approve" | "deny", choice?, proof}, M's bearer
 *   → 204                                  a denial (sticky)
 *   → 200 {status: "choose", choices}      a choice is due; nothing is written
 *   → 200 {status: "approved", deviceLabel} D is bound; its credential is stored as a hash
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
import {
  agreeKeyHeldElsewhere,
  DeviceKeysConflictError,
  DeviceKeysInvalidError,
  deviceSignKey,
} from "../../../core/devices/keys.js";
import { registerDeviceKeys } from "../../../core/devices/registerKeys.js";
import { getDevice } from "../../../core/devices/store.js";
import { NO_LICENSE_ID } from "../../../core/devices.js";
import { erasureVerdict } from "../../../core/accounts/erasureFence.js";
import { sendNotice } from "../../../core/notify/send.js";
import { appDeviceApprovedNotice } from "../../../core/notify/templates.js";
import { getAccountRow } from "../accounts/repo.js";
import { askedScopeHash, CONSENT_PROFILE_CLAIMS } from "./routes.js";
import { bindChoice, type BindRefusal, type BindResult } from "./bind.js";
import { bindWithoutChoice } from "./token.js";
import { verifyDeviceProof } from "../../../core/devices/proof.js";
import { deviceHolder, deviceOf } from "../attach.js";
import { SingleUseUnavailableError } from "../../../core/singleUse.js";
import { gatedBody } from "./nearbyStart.js";
import { licenseChoiceView, offerFor } from "./choice.js";
import {
  claimNearby,
  decideNearby,
  dropNearby,
  mismatchNearby,
  hasClientNetwork,
  nearbyNetHash,
  nearbyRef,
  readNearby,
  releaseNearby,
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
  try {
    return await decideApproval(req, env, db, product, now);
  } catch (e) {
    // The request store could not be reached: the request is kept, M may retry (§12.11.5 rule 10).
    if (e instanceof SingleUseUnavailableError)
      return wireError(503, "unavailable");
    throw e;
  }
}

async function decideApproval(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  // 1. The gates, then the shape (§12.11.5 rule 13: an off route is 404 even for a bad body).
  const body = await gatedApproval(req, env, db, product);
  if (body instanceof Response) return body;

  // Proximity needs a client network: with none, two callers would compare equal, so refuse.
  if (!hasClientNetwork(req)) return wireError(403, "not_nearby");

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

  // 7. Proximity: the approver's network, hashed as `start`'s was. Before the key comparison, so
  // a caller on another network cannot spend the request's mismatch budget.
  if ((await nearbyNetHash(env, req)) !== rec.netHash)
    return wireError(403, "not_nearby");

  // The keys M sends are the ones D started with (learned from D's authenticated VOUCH_REQ).
  if (body.signKey !== rec.signKey || body.agreeKey !== rec.agreeKey) {
    await mismatchNearby(env, ref);
    return notFoundNested();
  }

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
    await auditNearby(
      db,
      product.slug,
      now,
      holder.subject,
      "denied",
      rec,
      null,
    );
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

  // 10. The bind (§12.11.5 rules 6 to 9), in this order:
  //   a. claim the request (pending to claimed by M; a claim 30 s old may be retaken) and charge
  //      the subject's budget, now that M is attempting to bind;
  //   b. D's held signing key and agreeKey, against the store as it is now;
  //   c. bind: the sent `license` or `create`, else the one free candidate, else licence-less;
  //   d. register D's keys through Core;
  //   e. the consent rule;
  //   f. decide (claimed by M to approved), keeping only the hash of D's credential;
  //   g. audit and email.
  // A refusal M can retry puts the request back to pending; one that can never succeed ends it.
  const claimed = await claimNearby(env, ref, approver, now);
  if (!claimed.ok) return notFoundNested();
  const retry = async (res: Response): Promise<Response> => {
    await releaseNearby(env, ref, approver);
    return res;
  };
  const end = async (res: Response): Promise<Response> => {
    await dropNearby(env, ref);
    return res;
  };
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      { ...NEARBY_APPROVE_SUBJECT_RATE, id: holder.subject },
      now,
    ))
  )
    return retry(wireError(429, "rate_limited"));

  const account = await getAccountRow(db, holder.accountId);
  if (
    !account ||
    account.status !== "active" ||
    (await erasureVerdict(env, now, account.id)) !== "clear"
  )
    return end(notFoundNested());

  // b. The keys the request carries lived up to 300 s: re-run the held-key rule and the
  // agreeKey check now.
  const heldSignKey = await deviceSignKey(db, product.slug, rec.deviceId);
  if (
    (heldSignKey !== null && heldSignKey !== rec.signKey) ||
    (await agreeKeyHeldElsewhere(db, product.slug, rec.agreeKey, rec.deviceId))
  )
    return end(wireError(400, ErrorCode.DeviceKeysInvalid));
  // A credential that appeared on D's id after `start` was not proven there: never take it over.
  const existing = await getDevice(db, product.slug, rec.deviceId);
  // A device already bound to M's own subject is a resumed bind (an earlier attempt by this
  // person stopped part-way), not a credential from someone else.
  if (
    existing?.token_hash &&
    !rec.proven &&
    existing.subject !== holder.subject
  )
    return end(notFoundNested());

  // c. Bind.
  const bcx = { req, env, db, product, now };
  const who = {
    accountId: account.id,
    subject: holder.subject,
    email: account.primary_email,
  };
  const device = {
    id: rec.deviceId,
    metadata: {
      userAgent: null,
      platform: rec.meta.platform ?? null,
      arch: rec.meta.arch ?? null,
      appVersion: rec.meta.appVersion ?? null,
      sdkName: rec.meta.sdkName ?? null,
      sdkVersion: rec.meta.sdkVersion ?? null,
    },
    label: rec.label,
    held: null,
  };
  let bound: BindResult;
  try {
    if (body.choice) {
      bound = await bindChoice(bcx, who, device, body.choice);
    } else {
      const free = product.services.license.enabled
        ? (await offerFor(bcx, account.id, rec.deviceId)).candidates.filter(
            (c) => c.state === "free",
          )
        : [];
      bound =
        free.length === 1 && free[0]
          ? await bindChoice(bcx, who, device, {
              kind: "license",
              licenseId: free[0].licenseId,
            })
          : await bindWithoutChoice(bcx, who, device, false, rec.proven);
    }
  } catch (e) {
    await releaseNearby(env, ref, approver);
    throw e;
  }
  if (!bound.ok) return retry(refusal(bound.refusal));

  // d. D's keys.
  try {
    await registerDeviceKeys(
      { db, env, now },
      product.slug,
      rec.deviceId,
      { signKey: rec.signKey, agreeKey: rec.agreeKey },
      undefined,
      heldSignKey,
    );
  } catch (e) {
    if (
      e instanceof DeviceKeysInvalidError ||
      e instanceof DeviceKeysConflictError
    )
      return end(wireError(400, ErrorCode.DeviceKeysInvalid));
    throw e;
  }

  // e. The tap is D's consent: a standing consent stands, and with none the asked scope is
  // granted now.
  await grantConsent(db, product, account.id, holder.subject, now);

  // f. Decide. The credential minted above is kept as its hash only.
  const decided = await decideNearby(
    env,
    ref,
    approver,
    {
      approve: {
        approvedBy: approver,
        subject: holder.subject,
        licenseId: bound.licenseId === NO_LICENSE_ID ? null : bound.licenseId,
        tokenHash: bound.device.token_hash ?? "",
      },
    },
    now,
  );
  if (!decided.ok) return notFoundNested();

  // g. Audit, then the notice to the primary address.
  await auditNearby(
    db,
    product.slug,
    now,
    holder.subject,
    "approved",
    rec,
    bound.licenseId === NO_LICENSE_ID ? null : bound.licenseId,
  );
  try {
    await sendNotice(
      env,
      db,
      account.primary_email,
      appDeviceApprovedNotice({
        deviceLabel: rec.label,
        productName: product.name,
        productSlug: product.slug,
        origin: new URL(req.url).origin,
      }),
      now,
    );
  } catch {
    // The device is bound; a notice that cannot go out never undoes it.
  }
  const out: NearbyApproveResponse = {
    status: "approved",
    deviceLabel: rec.label,
  };
  return json(out);
}

/** A bind refusal as this route answers it: nested, with the retry data beside the code. */
function refusal(r: BindRefusal): Response {
  switch (r.reason) {
    case "device_limit":
      return wireError(403, "device_limit", {
        limit: r.limit,
        deviceCount: r.deviceCount,
        ...(r.manageUrl !== undefined ? { manageUrl: r.manageUrl } : {}),
      });
    case "rate_limited":
      return wireError(429, "rate_limited", { retryAfter: r.retryAfter });
    case "license_choice_required":
      return wireError(409, ErrorCode.LicenseChoiceRequired);
    case "not_found":
      return wireError(404, ErrorCode.NotFound);
    case "unavailable":
      return wireError(503, "unavailable");
    case "fingerprint_required":
      return wireError(403, "fingerprint_required");
    case "hardware_mismatch":
      return wireError(409, "hardware_mismatch");
    default:
      // unauthorized, not_entitled, license_owned, key_entry_limit
      return wireError(403, "not_entitled");
  }
}

/**
 * The consent row for D's token (Q5): none is written when one stands; otherwise the asked scope
 * is recorded and audited with `via: nearby`.
 */
async function grantConsent(
  db: Db,
  product: Product,
  accountId: string,
  subject: string,
  now: number,
): Promise<void> {
  const standing = await db.first<{ n: number }>(
    "SELECT 1 AS n FROM account_product_grants WHERE account_id = ? AND product = ?",
    accountId,
    product.slug,
  );
  if (standing) return;
  const granted = [...CONSENT_PROFILE_CLAIMS];
  const scopeHash = await askedScopeHash(product);
  await db.batch([
    {
      sql: `INSERT INTO account_product_grants
              (account_id, product, claims_json, granted_at, modified_at, scope_hash)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (account_id, product) DO NOTHING`,
      params: [
        accountId,
        product.slug,
        JSON.stringify(granted),
        now,
        now,
        scopeHash,
      ],
    },
  ]);
  await appendAudit(db, {
    product: product.slug,
    id: randomId("aud"),
    at: now,
    actor_sub: subject,
    actor_name: null,
    actor_email: null,
    action: "signin.consent.granted",
    target_kind: "product",
    target_id: product.slug,
    parent_id: null,
    summary: `Granted ${granted.join(", ")} to the app (scope ${scopeHash}) (via nearby)`,
  });
}

/** The audit row of a decision: the device by id, the label only, never a handle, key or token. */
function auditNearby(
  db: Db,
  product: string,
  now: number,
  subject: string,
  outcome: "approved" | "denied",
  rec: NearbyRequestRecord,
  licenseId: string | null,
): Promise<void> {
  return appendAudit(db, {
    product,
    id: randomId("aud"),
    at: now,
    actor_sub: subject,
    actor_name: null,
    actor_email: null,
    action: `identity.nearby.${outcome}`,
    target_kind: "device",
    target_id: rec.deviceId,
    parent_id: licenseId,
    summary: `A nearby sign-in was ${outcome}${rec.label ? ` for ${rec.label}` : ""} (via nearby)`,
  });
}
