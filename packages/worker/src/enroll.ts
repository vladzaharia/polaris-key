/// <reference types="@cloudflare/workers-types" />

// `POST /<product>/enroll` — the keyless "always free" path.
//
// A product that mainly wants signed settings distribution shouldn't have to gate every
// install behind a license key or a sign-in. Enrolment auto-issues a license bound to the
// machine's hwid and hands back the same shape `/activate` does, so every SDK reuses its
// existing activation result type with no new client plumbing.
//
// Lives in its own module rather than in licensing.ts, which is already long and owns the
// key-redemption hot path.

import type { Env } from "./env.js";
import type { Db } from "./db/types.js";
import type { Product } from "./product.js";
import { errorResponse, ErrorCode, json, methodNotAllowed } from "./http.js";
import { randomId } from "./crypto.js";
import { clientIp, rateLimitOk } from "./rateLimit.js";
import { allowsAnonymousEnroll, computeHwid } from "./fingerprint.js";
import {
  appendAudit,
  getLicense,
  getLicenseByEnrollHwid,
  getTier,
  insertLicense,
  type LicenseRow,
} from "./repo.js";
import {
  authorizationError,
  deviceMetadata,
  readFingerprint,
  shapeDevice,
  shapeLicense,
} from "./licensing.js";
import { authorizeDevice } from "./licenseCore.js";
import { HEADER_DEVICE } from "@polaris-key/protocol";

/**
 * Locate or mint the free license for this machine.
 *
 * The uniqueness of one-license-per-machine is enforced by `idx_licenses_enroll_hwid`, not by
 * this read-then-write. If two enrolments race, the loser's INSERT violates the index and we
 * re-read the winner's row — so a burst of concurrent first-runs still converges on a single
 * license instead of silently minting duplicates.
 */
async function locateOrMintLicense(
  db: Db,
  product: Product,
  hwid: string,
  tierId: string,
  now: number,
): Promise<LicenseRow | null> {
  const existing = await getLicenseByEnrollHwid(db, product.slug, hwid);
  if (existing) return existing;

  const licenseId = randomId("lic");
  try {
    await insertLicense(db, {
      product: product.slug,
      id: licenseId,
      status: "active",
      sub: null,
      // Deliberately anonymous: docProfile() already tolerates null name/email and renders
      // empty strings, so the signed doc needs no special case.
      name: null,
      email: null,
      groups_json: null,
      tier_id: tierId,
      activated_at: now,
      expires_at: null,
      max_offline_days: null,
      overrides_json: JSON.stringify({
        config: {},
        secrets: {},
        entitlements: {},
      }),
      channels_json: null,
      min_version: null,
      max_version: null,
      origin: "enroll",
      enroll_hwid: hwid,
      modified_by: "enroll",
      modified_at: now,
    });
  } catch {
    // Almost certainly the unique-index violation above. Re-read rather than surfacing a
    // 500: the caller's intent ("give me the license for this machine") is satisfiable.
    return getLicenseByEnrollHwid(db, product.slug, hwid);
  }

  await appendAudit(db, {
    product: product.slug,
    id: randomId("aud"),
    at: now,
    actor_sub: null,
    actor_name: null,
    actor_email: null,
    action: "license.enroll",
    target_kind: "license",
    target_id: licenseId,
    parent_id: null,
    summary: `Auto-issued a ${tierId} license for a new machine`,
  });
  return getLicense(db, product.slug, licenseId);
}

/** POST /<product>/enroll — auto-issue a license for this machine and authorize the device. */
export async function handleEnroll(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  if (req.method !== "POST") return methodNotAllowed();

  const policy = product.autoIssue;
  // 404 rather than 403: a product that hasn't opted in shouldn't advertise that the route
  // exists at all.
  if (!allowsAnonymousEnroll(policy) || !policy.tierId) {
    return errorResponse(
      404,
      ErrorCode.EnrollDisabled,
      "enrollment is disabled",
    );
  }

  if (policy.rateLimitPerHour > 0) {
    const ok = await rateLimitOk(
      env,
      product.slug,
      {
        bucket: "enroll",
        id: clientIp(req),
        limit: policy.rateLimitPerHour,
        windowSec: 3600,
      },
      now,
    );
    if (!ok)
      return errorResponse(429, "rate_limited", "too many enrollment attempts");
  }

  const deviceId = req.headers.get(HEADER_DEVICE);
  if (!deviceId)
    return errorResponse(400, ErrorCode.BadRequest, "missing device id");

  const tier = await getTier(db, product.slug, policy.tierId);
  if (!tier) {
    // The policy names a tier that no longer exists — fail closed rather than issuing a
    // license with entitlements nobody configured.
    return errorResponse(
      404,
      ErrorCode.EnrollDisabled,
      "enrollment is disabled",
    );
  }

  const fingerprint = await readFingerprint(req);
  // Dedupe is only possible with a fingerprint. Without one every install would mint its own
  // license, which is exactly the farming case the policy exists to bound — so an anonymous
  // enrolment requires one regardless of the tier's enforcement mode.
  if (!fingerprint) {
    return errorResponse(
      403,
      ErrorCode.FingerprintRequired,
      "enrollment requires a hardware fingerprint",
    );
  }
  const hwid = await computeHwid(fingerprint.components);

  const license = await locateOrMintLicense(
    db,
    product,
    hwid,
    policy.tierId,
    now,
  );
  if (!license)
    return errorResponse(500, "enroll_failed", "could not issue a license");

  const authorized = await authorizeDevice(
    env,
    db,
    product,
    license,
    deviceId,
    now,
    { ...deviceMetadata(req), fingerprint },
  );
  if ("error" in authorized) return authorizationError(authorized);

  return json({
    token: authorized.token,
    schemaVersion: product.schemaVersion,
    device: shapeDevice(authorized.device, deviceId),
    license: shapeLicense(license),
  });
}
