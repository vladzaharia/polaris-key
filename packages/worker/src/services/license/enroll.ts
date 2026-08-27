/// <reference types="@cloudflare/workers-types" />

// `POST /<product>/license/enroll` — the keyless "always free" path.
//
// A product that mainly wants signed settings distribution shouldn't have to gate every
// install behind a license key or a sign-in. Enrolment auto-issues a license bound to the
// machine's hwid and hands back the same shape `/license/activate` does, so every SDK reuses
// its existing activation result type with no new client plumbing.
//
// Moved verbatim from `src/enroll.ts` under the v3 namespace (§R1). It stays in its own module
// rather than joining `activation.ts`, which owns the key-redemption hot path.

import type { Env, Db } from "../../core/platform.js";
import type { Product } from "../../core/products.js";
import {
  errorResponse,
  ErrorCode,
  json,
  methodNotAllowed,
} from "../../core/errors.js";
import { randomId } from "../../core/platform.js";
import { clientIp, rateLimitOk } from "../../core/rateLimit.js";
import {
  allowsAnonymousEnroll,
  computeEnrollHwid,
} from "../../core/fingerprint.js";
import {
  appendAudit,
  getLicense,
  getLicenseByEnrollHwid,
  getTier,
  insertLicense,
  type LicenseRow,
  type TierRow,
} from "../../core/data.js";
import { authorizationError, shapeLicense } from "./activation.js";
import {
  deviceMetadata,
  readFingerprint,
  shapeDevice,
} from "../../core/devices.js";
import { authorizeDevice, tierExpiresAt } from "./authz.js";
import { HEADER_DEVICE } from "@plrs/protocol/core";

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
  tier: TierRow,
  now: number,
): Promise<LicenseRow | "claimed" | null> {
  const existing = await getLicenseByEnrollHwid(db, product.slug, hwid);
  if (existing) {
    // R3-05 — the machine's free license is now bound for good: `claimEnrolledLicense` and the
    // OIDC merge arm no longer clear `enroll_hwid`, so this row may be one that has since been
    // claimed by an identity or retired by a merge. Returning it would hand an ANONYMOUS
    // caller a license that now carries somebody's identity and (post-claim) their tier, which
    // is a strictly worse outcome than the re-enrolment loop R3-05 describes. This machine has
    // had its free license; the caller signs in to reach it.
    const stillAnonymous =
      existing.origin === "enroll" &&
      existing.sub === null &&
      existing.status === "active";
    return stillAnonymous ? existing : "claimed";
  }

  const licenseId = randomId("lic");
  // R3-06 — the tier's expiry policy applies here exactly as it does on every other path
  // that assigns a tier. This used to be a hardcoded `null`, so a tier configured as a
  // time-boxed trial issued PERMANENT licenses through `/enroll` — the one path where the
  // license is free and unauthenticated, i.e. where the time box matters most.
  const expiresAt = tierExpiresAt(tier, now);
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
      tier_id: tier.id,
      activated_at: now,
      expires_at: expiresAt,
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
    // 500: the caller's intent ("give me the license for this machine") is satisfiable — but
    // only if the winner of the race is still an anonymous enrolled row (R3-05).
    const winner = await getLicenseByEnrollHwid(db, product.slug, hwid);
    if (!winner) return null;
    return winner.origin === "enroll" && winner.sub === null
      ? winner
      : "claimed";
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
    summary: `Auto-issued a ${tier.id} license for a new machine`,
  });
  return getLicense(db, product.slug, licenseId);
}

/** POST /<product>/license/enroll — auto-issue a license for this machine and authorize the
 *  device. */
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
  // R3-03 — the dedupe key covers a FIXED projection (the anchor), not "whatever was sent".
  // Using computeHwid here meant each of the 127 reachable component subsets of one machine
  // hashed to a different "machine" and earned its own free license. A submission with no
  // anchor is undedupable by construction, so it is refused rather than minted.
  const hwid = await computeEnrollHwid(fingerprint.components);
  if (!hwid) {
    return errorResponse(
      403,
      ErrorCode.FingerprintRequired,
      "enrollment requires a machine anchor in the hardware fingerprint",
    );
  }

  const license = await locateOrMintLicense(db, product, hwid, tier, now);
  if (license === "claimed") {
    // R3-05: this machine's free license already exists but belongs to an identity now (or was
    // retired into one by a merge). Say so plainly rather than minting a second one.
    return errorResponse(
      403,
      ErrorCode.EnrollClaimed,
      "this machine's free license has been claimed; sign in to use it",
    );
  }
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
