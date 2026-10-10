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
 *      (`services/license/auth.ts` documents the split) — and the licence is asked about only
 *      when the product runs License (R1, below);
 *   2. the payload merge tolerates a null licence (`core/licensing/payload.ts` — the tier, licence
 *      profiles and licence overrides simply contribute no layer);
 *   3. NO BUILD GATE. Version/channel enforcement is a licence grant (D-20) and lives on
 *      `/license/document`; a product with no licence service has no window to be outside of,
 *      and gating settings distribution on one would make the two services inseparable again.
 *
 * `graceUntil` still comes from the licence's `max_offline_days` when there is a licence, and
 * from the product default when there is not — the offline window is a property of the
 * DOCUMENT, and a config-only install is entitled to one. For a device R1 (below) binds to its
 * licence, the window also ends no later than the licence's expiry when the product clamps grace
 * (LX-07, `core/licensing/graceClamp.ts`): its secrets stop with the licence offline as well as online.
 *
 * ── R1: A LICENSED PRODUCT'S SECRETS STOP WITH THE LICENCE ─────────────────────────────────
 *
 * The document carries the product's secrets. Taking Core's device-only answer for EVERY product
 * meant a device whose licence an operator had disabled, or that had expired, kept receiving
 * them — a rotated key included — for as long as its token lived. So when the product runs
 * License and the device is BOUND to a licence (`license_id` is not `NO_LICENSE_ID`), that
 * licence must still be usable (Core's `licenseUsable`, the predicate License itself applies; a
 * deleted row is not usable). Otherwise the answer is `401` with the code `license_unusable`,
 * before the ETag comparison, so such a device is never told its copy is current.
 *
 * Two kinds of device are NOT refused, because neither was ever granted the document by a
 * licence: every device of a product with License off (D-08), and a KEYLESS device of a licensed
 * product — one registered under an `open` or `requires-identity` policy, which holds a token
 * with no licence behind it and still fetches config documents (the concepts page promises it).
 *
 * That last case is where this differs from `coreDeviceAllowed` (Core's `/devices` surfaces) and
 * the edge-mint guard, which require a usable licence of EVERY device once License is on, keyless
 * ones included. Those surfaces manage seats and mint third-party credentials; this one only
 * withdraws what a lapsed licence used to grant, so it keys off the binding rather than the flag
 * alone, and does not reuse that predicate.
 *
 * Why 401 and not 403: a 403 on a document is the build gate's status, and every SDK reads it as
 * a version or channel block. A 401 is what `/license/document` already answers for the same
 * licence, so a client takes its one re-acquire (`POST /license/token`, which refuses an
 * unusable licence too) and lands on `revoked`, the state that is actually true. The code still
 * says which refusal it was.
 */

import type { ConfigDoc } from "@polaris-key/protocol/config";
import { sha256Base64Url } from "@polaris-key/jws";
import type { Env } from "../../platform/env.js";
import type { Db } from "../../db/types.js";
import { bearer } from "../../platform/http.js";
import type { Product } from "../../core/products.js";
import { ErrorCode, methodNotAllowed, wireError } from "../../core/errors.js";
import {
  deviceMetadata,
  licenseUsable,
  NO_LICENSE_ID,
  touchDeviceMetadata,
  validateDeviceToken,
} from "../../core/devices.js";
import { rateLimitOk } from "../../core/rateLimit.js";
import { isStrictJsonError, signDoc } from "../../core/signing.js";

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
import { graceClampFor } from "../../core/licensing/graceClamp.js";
import { licenseOfflineDays } from "../../core/licensing/entitlements.js";
import type { SettingsRegistry } from "../../core/settings/registry.js";

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
  /** ST-04's settings registry (`ServiceContext.settings`): LX-07's grace clamp is resolved by it. */
  settings?: SettingsRegistry,
): Promise<Response> {
  if (req.method !== "GET") return methodNotAllowed();

  // Device authentication — see the D-08 note at the top of this file.
  const valid = await validateDeviceToken(env, db, product, bearer(req), now);
  if ("error" in valid) return wireError(401, ErrorCode.Unauthorized);
  // ...plus, on a product that runs License, a usable licence for a device bound to one (R1,
  // above). A keyless device has nothing to have lapsed.
  const licenseBound =
    product.services.license.enabled &&
    valid.device.license_id !== NO_LICENSE_ID;
  if (licenseBound && !licenseUsable(valid.license, now))
    return wireError(401, ErrorCode.LicenseUnusable);

  // A per-device ceiling well above any SDK's schedule.
  if (
    !(await rateLimitOk(
      env,
      product.slug,
      {
        bucket: "configDocument",
        id: valid.device.device_id,
        limit: 120,
        windowSec: 60,
      },
      now,
    ))
  )
    return wireError(429, "rate_limited");

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

  const maxOfflineDays = licenseOfflineDays(valid.license, product);
  const doc = buildConfigDoc({
    aud: product.slug,
    deviceId: valid.device.device_id,
    now,
    maxOfflineDays,
    // LX-07: only the licence R1 binds the device to clamps its window.
    clampGraceTo: licenseBound
      ? await graceClampFor(
          { env, db, registry: settings },
          product.slug,
          valid.license,
          now,
          maxOfflineDays,
        )
      : null,
    schemaVersion: product.schemaVersion,
    payload,
  });

  const etag = await configDocETag(doc);
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { etag } });
  }
  let jws: string;
  try {
    jws = await signDoc(
      doc,
      product.signingKeyPem,
      product.signingKid,
      "pkey-config+jws",
    );
  } catch (e) {
    // The catalog prune drops a flagged config or secret value before this point, so only a
    // value the prune cannot see reaches the guard (plans/P3-01.md §2.2). Refuse with the
    // route's nested body, never an unhandled throw.
    if (!isStrictJsonError(e)) throw e;
    return wireError(500, ErrorCode.DocumentNotRepresentable);
  }
  return new Response(jws, {
    status: 200,
    headers: {
      "content-type": "application/jwt",
      etag,
      "cache-control": "no-store",
    },
  });
}
