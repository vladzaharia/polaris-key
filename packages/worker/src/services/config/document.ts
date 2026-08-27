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

import {
  DOC_EXPIRY_SECONDS,
  SECONDS_PER_DAY,
  type ManagedEntry,
} from "@plrs/protocol";
import { ISSUER } from "@plrs/protocol/core";
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
import {
  openManagedPayload,
  prunePayloadAgainstCatalog,
  resolveMergedPayload,
} from "../../core/payload.js";
import type { DeviceRow, LicenseRow } from "../../core/data.js";
import { signDoc } from "../../core/signing.js";

/** The config-owned slice of the merged payload. */
export interface ConfigPayload {
  config: Record<string, ManagedEntry>;
  secrets: Record<string, ManagedEntry>;
}

/**
 * Resolve the config + secrets a device should receive, or `null` when the active catalog
 * exists but cannot be interpreted (the fail-closed arm — see `prunePayloadAgainstCatalog`).
 *
 * `env` is REQUIRED, unlike on the entitlement side. `admin/lib/overrides.ts` seals every
 * catalog-declared secret before it reaches `profiles.payload_json` / `licenses.overrides_json`
 * (R12-02), so without opening them here the still-sealed envelope reaches the catalog prune,
 * fails validation and is dropped — silently delivering a document with every managed secret
 * missing. This is the primary delivery surface for those values, so it is the call site that
 * matters most.
 *
 * The opening happens AFTER the merge so a sealed value in a lower layer that a higher layer
 * overrides is never decrypted at all.
 */
export async function resolveConfigPayload(
  db: Db,
  env: Env,
  product: string,
  license: LicenseRow | null,
  device: DeviceRow | null | undefined,
  now: number,
): Promise<ConfigPayload | null> {
  const { payload } = await resolveMergedPayload(
    db,
    product,
    license,
    device,
    now,
  );
  const opened = await openManagedPayload(env, product, payload);
  const pruned = await prunePayloadAgainstCatalog(db, product, opened);
  if (!pruned) return null;
  return { config: pruned.config, secrets: pruned.secrets };
}

export interface BuildConfigDocInput {
  aud: string;
  deviceId: string;
  now: number;
  maxOfflineDays: number;
  schemaVersion: number;
  payload: ConfigPayload;
}

/** Stamp the envelope onto the config fields. Key order matches the conformance corpus's
 *  `configDoc()` fixture. */
export function buildConfigDoc(input: BuildConfigDocInput): ConfigDoc {
  return {
    iss: ISSUER,
    aud: input.aud,
    deviceId: input.deviceId,
    issuedAt: input.now,
    expiresAt: input.now + DOC_EXPIRY_SECONDS,
    graceUntil: input.now + input.maxOfflineDays * SECONDS_PER_DAY,
    schemaVersion: input.schemaVersion,
    config: input.payload.config,
    secrets: input.payload.secrets,
  };
}

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
