/**
 * Document ASSEMBLY — turning stored rows into the two signed payload shapes wire v3 defines
 * (WIRE-CONTRACT-V3 §2.1, §2.2). Not routing, not authentication, not ETags: just the envelope
 * stamped onto the grant or the settings.
 *
 * ── WHY THESE MOVED INTO CORE ───────────────────────────────────────────────────────────────
 *
 * They were License's and Config's while their routes were the only place a document was minted.
 * Offline bundles (`core/bundles.ts`, §7) make that false: one bundle carries a license document
 * AND a config document, either of which may be absent, and a config-only product (D-08) mints
 * a bundle with no licence anywhere in it. Core has to compose both — a service may not import a
 * sibling (`test/boundaries.test.ts`), and Core importing a service would invert the layering
 * that rule exists to protect.
 *
 * So the builders live here and the two services re-export them, which is exactly the move
 * `injectAdminPolicy` made into `core/entitlements.ts` and `resolveEntitlements`/`docProfile`
 * made into `core/authz.ts` when Identity was carved. Every existing importer is unchanged, and
 * — the point of the exercise — a bundle-activated install receives a document assembled by the
 * same code as the network path, rather than by a second implementation that would be free to
 * drift a grant or a merge order without anyone noticing until a customer did.
 *
 * What deliberately did NOT move: the ETag helpers and the route handlers. A strong ETag over
 * document content is a TRANSPORT concern of the route that serves it, and a bundle has no
 * conditional-request semantics at all — there is no client to send `If-None-Match` from an
 * air-gapped machine.
 *
 * ── THE `maxOfflineDays` PARAMETER ──────────────────────────────────────────────────────────
 *
 * Both builders take it rather than reading it from a licence row, and that is what lets the
 * bundle mint express §7's operator-chosen grace: the network routes pass
 * `license.max_offline_days ?? product.defaultMaxOfflineDays`, the mint passes the operator's
 * `graceDays`. `expiresAt` is NOT parameterised — it is `DOC_EXPIRY_SECONDS` on both paths,
 * because §7 step 4 verifies inner documents on the reload profile where `graceUntil` is the
 * bound that matters. See the note in `core/bundles.ts`.
 */

import {
  DOC_EXPIRY_SECONDS,
  SECONDS_PER_DAY,
  type ManagedEntry,
} from "@polaris-key/protocol";
import { ISSUER } from "@polaris-key/protocol/core";
import type { LicenseDoc } from "@polaris-key/protocol/license";
import type { ConfigDoc } from "@polaris-key/protocol/config";
import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import type { DeviceRow, LicenseRow } from "./data.js";
import {
  openManagedPayload,
  prunePayloadAgainstCatalog,
  resolveMergedPayload,
} from "./payload.js";

// ── license document (§2.1) ───────────────────────────────────────────────────

export interface BuildLicenseDocInput {
  aud: string;
  deviceId: string;
  licenseId: string;
  now: number;
  maxOfflineDays: number;
  profile: LicenseDoc["profile"];
  entitlements: Record<string, ManagedEntry>;
}

/**
 * Stamp the envelope onto the grant fields. Key order matches the conformance corpus's
 * `licenseDoc()` fixture — the corpus pins the wire byte-for-byte, and a signer that emits a
 * different order still verifies but stops being comparable to the fixtures.
 */
export function buildLicenseDoc(input: BuildLicenseDocInput): LicenseDoc {
  return {
    iss: ISSUER,
    aud: input.aud,
    deviceId: input.deviceId,
    issuedAt: input.now,
    expiresAt: input.now + DOC_EXPIRY_SECONDS,
    graceUntil: input.now + input.maxOfflineDays * SECONDS_PER_DAY,
    licenseId: input.licenseId,
    profile: input.profile,
    entitlements: input.entitlements,
  };
}

// ── config document (§2.2) ────────────────────────────────────────────────────

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
