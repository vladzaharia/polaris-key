/// <reference types="@cloudflare/workers-types" />

/**
 * `GET /<product>/license/document` — the signed license document (WIRE-CONTRACT-V3 §2.1).
 *
 * One of the two halves the fused `GET /<p>/config` became. This one carries GRANTS and nothing
 * else: the shared envelope, the licence id, the signed greeting, and `entitlements` — which
 * D-20 makes the ONLY carrier of grant data. No config values, no secrets; those ride the
 * config document, which a product may fetch without ever enabling this service (D-08).
 *
 * ── WHY THE BUILD GATE IS HERE ──────────────────────────────────────────────────────────────
 *
 * Channel/version enforcement lives on this route and on `/<p>/identity/session` (§5, D-20), and
 * nowhere else. It has to be somewhere a grant is being handed out, because the window and the
 * entitled channel set ARE grants — they arrive as enforced entitlements on this very document.
 * Putting it on the config document instead would mean a build outside its window could not
 * read its settings, which is a support incident rather than a security control: the point of
 * blocking an out-of-window build is to stop it CLAIMING A LICENCE, not to blind it.
 *
 * The refusal is `403` with the nested v3 body plus a top-level `allowedRange`, which is what
 * the client turns into a `version-too-old` / `channel-not-entitled` gate state without needing
 * a document at all.
 */

import type { LicenseDoc } from "@polaris-key/protocol/license";
import { sha256Base64Url } from "@polaris-key/jws";
import type { Env, Db } from "../../core/platform.js";
import { bearer } from "../../core/platform.js";
import type { Product } from "../../core/products.js";
import { ErrorCode, methodNotAllowed, wireError } from "../../core/errors.js";
import { deviceMetadata, touchDeviceMetadata } from "../../core/devices.js";
import { signDoc } from "../../core/signing.js";
import { HEADER_CHANNEL, HEADER_VERSION } from "@polaris-key/protocol/core";
import { requireLicensedDevice } from "./auth.js";
import { docProfile } from "./authz.js";
import { resolveEntitlements } from "./entitlements.js";
import { checkBuildGate, type GateResult } from "./gate.js";

// The envelope stamper moved to `core/documents.ts` when offline bundles landed (§7): one bundle
// carries a license document AND a config document, so Core has to be able to build both, and a
// service may not import a sibling. Re-exported here so License's own call sites — and anything
// that already imported it from this module — are unchanged. Same move `injectAdminPolicy` and
// `resolveEntitlements` made before it.
export {
  buildLicenseDoc,
  type BuildLicenseDocInput,
} from "../../core/documents.js";
import { buildLicenseDoc } from "../../core/documents.js";

/**
 * A strong ETag over the document CONTENT, excluding the per-request timestamps, so an
 * unchanged licence collapses to the same tag and the client's `If-None-Match` gets a 304.
 *
 * Per-document by construction (§5): the license and config documents carry independent tags,
 * so a config edit no longer forces a licence re-download and vice versa.
 */
export async function licenseDocETag(doc: LicenseDoc): Promise<string> {
  const material = JSON.stringify({
    iss: doc.iss,
    aud: doc.aud,
    deviceId: doc.deviceId,
    licenseId: doc.licenseId,
    profile: doc.profile,
    entitlements: doc.entitlements,
  });
  const tag = await sha256Base64Url(new TextEncoder().encode(material));
  return `"${tag}"`;
}

/**
 * The 403 a blocked build gets (§5, R4).
 *
 * `code` collapses the two version outcomes into `version_blocked`, which is what the contract
 * specifies; `reason` rides alongside it inside the error object so a client can still tell
 * too-old from too-new and render the right sentence. `PolarisErrorBody` types the error object
 * as open for exactly this. `allowedRange` sits at the TOP level, where the contract puts it.
 */
function blockedResponse(gate: GateResult): Response {
  const code =
    gate.reason === "channel-not-entitled"
      ? "channel_not_allowed"
      : "version_blocked";
  return new Response(
    JSON.stringify({
      error: { code, ...(gate.reason ? { reason: gate.reason } : {}) },
      ...(gate.allowedRange ? { allowedRange: gate.allowedRange } : {}),
    }),
    {
      status: 403,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    },
  );
}

export async function handleLicenseDocument(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  if (req.method !== "GET") return methodNotAllowed();

  // Licence usability is required here, unlike on the config document: this route hands out a
  // grant, so a dead licence must not be able to mint one. See `auth.ts` for the split.
  const valid = await requireLicensedDevice(env, db, product, bearer(req), now);
  if ("error" in valid) return wireError(401, ErrorCode.Unauthorized);

  await touchDeviceMetadata(db, valid.device, deviceMetadata(req), now);

  const entitlements = await resolveEntitlements(
    db,
    product.slug,
    valid.license,
    valid.device,
    now,
  );

  const gate = checkBuildGate({
    version: req.headers.get(HEADER_VERSION) ?? "0.0.0",
    channelHeader: req.headers.get(HEADER_CHANNEL) ?? undefined,
    entitlements,
    compatMin: product.compatMin,
    compatMax: product.compatMax,
  });
  if (!gate.ok) return blockedResponse(gate);

  const doc = buildLicenseDoc({
    aud: product.slug,
    deviceId: valid.device.device_id,
    licenseId: valid.license.id,
    now,
    maxOfflineDays:
      valid.license.max_offline_days ?? product.defaultMaxOfflineDays,
    profile: docProfile(valid.license),
    entitlements,
  });

  const etag = await licenseDocETag(doc);
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }
  const jws = await signDoc(
    doc,
    product.signingKeyPem,
    product.signingKid,
    "pkey-license+jws",
  );
  return new Response(jws, {
    status: 200,
    headers: {
      "content-type": "application/jwt",
      etag,
      "cache-control": "no-store",
    },
  });
}
