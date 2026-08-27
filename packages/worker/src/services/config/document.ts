/// <reference types="@cloudflare/workers-types" />

/**
 * `GET /<product>/config/document` — the signed config document (WIRE-CONTRACT-V3 §2.2).
 *
 * The other half of the fused `GET /<p>/config`. It carries the shared envelope, the product's
 * catalog version, and the merged `config` + `secrets` maps. It carries NO licence fields at
 * all — no `licenseId`, no `profile`, no `entitlements` — and that absence is not cosmetic:
 *
 * ── D-08, ON THE WIRE ───────────────────────────────────────────────────────────────────────
 *
 * A product may enable Config with License DISABLED. Its devices are registered and hold real
 * tokens; there is no licence behind them and there never will be. Such a product still gets
 * config documents, which is only implementable if three things hold together, and all three
 * are load-bearing here:
 *
 *   1. authentication is `core.validateDeviceToken` — token → device, no licence involved
 *      (`services/license/auth.ts` documents the split);
 *   2. the payload merge tolerates a null licence (`core/payload.ts` — the tier, licence
 *      profiles and licence overrides simply contribute no layer);
 *   3. NO BUILD GATE. Version/channel enforcement is a licence grant (D-20) and lives on
 *      `/license/document`; a product with no licence service has no window to be outside of,
 *      and gating settings distribution on one would make the two services inseparable again.
 *
 * `graceUntil` still comes from the licence's `max_offline_days` when there is a licence, and
 * from the product default when there is not — the offline window is a property of the
 * DOCUMENT, and a config-only install is entitled to one.
 */

import type { ConfigDoc } from "@plrs/protocol/config";
import { sha256Base64Url } from "@plrs/jws";
import type { Env, Db } from "../../core/platform.js";
import { bearer } from "../../core/platform.js";
import type { Product } from "../../core/products.js";
import { ErrorCode, methodNotAllowed, wireError } from "../../core/errors.js";
import {
  deviceMetadata,
  touchDeviceMetadata,
  validateDeviceToken,
} from "../../core/devices.js";
import { signDoc } from "../../core/signing.js";

// The payload resolution and the envelope stamper moved to `core/documents.ts` when offline
// bundles landed (§7): a bundle carries a config document alongside (or instead of) a license
// document, so Core has to be able to build one, and Core may not import a service. Re-exported
// here so this module's own call sites — and `services/config/index.ts`'s barrel — are
// unchanged.
export {
  buildConfigDoc,
  resolveConfigPayload,
  type BuildConfigDocInput,
  type ConfigPayload,
} from "../../core/documents.js";
import { buildConfigDoc, resolveConfigPayload } from "../../core/documents.js";

/** A strong ETag over the config content, excluding the per-request timestamps. Independent of
 *  the license document's tag (§5), so a licence change no longer forces a settings refetch. */
export async function configDocETag(doc: ConfigDoc): Promise<string> {
  const material = JSON.stringify({
    iss: doc.iss,
    aud: doc.aud,
    deviceId: doc.deviceId,
    schemaVersion: doc.schemaVersion,
    config: doc.config,
    secrets: doc.secrets,
  });
  const tag = await sha256Base64Url(new TextEncoder().encode(material));
  return `"${tag}"`;
}

export async function handleConfigDocument(
  req: Request,
  env: Env,
  db: Db,
  product: Product,
  now: number,
): Promise<Response> {
  if (req.method !== "GET") return methodNotAllowed();

  // Device authentication ONLY — see the D-08 note at the top of this file.
  const valid = await validateDeviceToken(env, db, product, bearer(req), now);
  if ("error" in valid) return wireError(401, ErrorCode.Unauthorized);

  await touchDeviceMetadata(db, valid.device, deviceMetadata(req), now);

  const payload = await resolveConfigPayload(
    db,
    env,
    product.slug,
    valid.license,
    valid.device,
    now,
  );
  if (!payload) {
    return wireError(500, "catalog_unavailable", {
      message: "active catalog could not validate the config payload",
    });
  }

  const doc = buildConfigDoc({
    aud: product.slug,
    deviceId: valid.device.device_id,
    now,
    maxOfflineDays:
      valid.license?.max_offline_days ?? product.defaultMaxOfflineDays,
    schemaVersion: product.schemaVersion,
    payload,
  });

  const etag = await configDocETag(doc);
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }
  const jws = await signDoc(
    doc,
    product.signingKeyPem,
    product.signingKid,
    "plrs-config+jws",
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
