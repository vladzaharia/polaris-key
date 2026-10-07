/**
 * The managed-payload layer cake, and the catalog prune that guards it — Core-mediated because
 * both documents are built from it (design spec §5.2, WIRE-CONTRACT-V3 §2).
 *
 * ── WHY THIS IS CORE AND NOT ONE OF THE TWO SERVICES ────────────────────────────────────────
 *
 * Wire v3 splits one signed document into two: `pkey-license+jws` carries `entitlements`,
 * `pkey-config+jws` carries `config` + `secrets`. They are assembled by different services, but
 * they are assembled from the SAME stack of stored layers:
 *
 *     catalog defaults  →  tier's profile  →  the license's profiles (in order)
 *                       →  store grants (P6-01)  →  license overrides  →  the OIDC GRANT (LX-08)
 *                       →  ACCOUNT OVERRIDES (U-03)  →  device overrides
 *
 * and that stack is jointly owned: the catalog and the profiles are Config's rows, the tier and
 * the license are License's, the device is Core's. Duplicating the walk in both services would
 * put the two documents one careless edit away from disagreeing about precedence — which is
 * exactly the class of divergence the split is supposed to make impossible. So Core owns the
 * merge, and each service takes its own slice of the result:
 *
 *     services/license/entitlements.ts  →  injectAdminPolicy(…) then `.entitlements`
 *     services/config/document.ts       →  `.config` + `.secrets`
 *
 * `resolveMergedPayload` deliberately does NOT inject admin policy and does NOT open sealed
 * secrets. Both are the caller's business, and both are ORDER-SENSITIVE (see below), so making
 * them the caller's explicit next step is what keeps the legacy `licenseCore.resolveEffective`
 * byte-identical to what it did before the split.
 *
 * `validatePayload` moved here from `configDoc.ts` for the same reason: it is the last gate
 * before signing on both document paths.
 */

/// <reference types="@cloudflare/workers-types" />

import { Catalog } from "@polaris-key/catalog";
import type { ManagedEntry } from "@polaris-key/protocol";
import type { Db } from "../db/types.js";
import { mergePayloads } from "../merge.js";
import { storeGrantLayer } from "./storeGrants.js";
import { oidcGrantLayer } from "./grants.js";
import { accountOverrideLayer } from "./accountOverrides.js";
import { licenseConfigOverridesRetired } from "./overrideMigration.js";
import {
  getActiveSchema,
  getProfile,
  getTier,
  listLicenseProfiles,
  type DeviceRow,
  type LicenseRow,
  type TierRow,
} from "../repo.js";

/**
 * The three managed-entry maps as the CONTROL PLANE stores them, in one object.
 *
 * Server-side only, and deliberately NOT in `@polaris-key/protocol`: nothing signs or ships
 * this shape. Wire contract v3 splits it across two documents — `entitlements` rides
 * `pkey-license+jws`, `config` + `secrets` ride `pkey-config+jws` — so the fused object exists
 * exactly as far as the signing boundary and no further. (In v2 it WAS the wire payload, which
 * is the whole reason it used to live in the protocol package.) Core owns it because both
 * services assemble their document from the same merged instance.
 */
export interface ManagedPayload {
  config: Record<string, ManagedEntry>;
  secrets: Record<string, ManagedEntry>;
  entitlements: Record<string, ManagedEntry>;
}

/** The merged layers plus the tier they were resolved against — License needs the row itself
 *  to inject its policy, and re-reading it would be a second query for the same answer. */
export interface MergedPayload {
  payload: ManagedPayload;
  tier: TierRow | null;
}

/** The catalog's own declared defaults, the bottom layer of every merge. */
async function catalogDefaultPayload(
  db: Db,
  product: string,
  now: number,
): Promise<string | null> {
  const schemaRow = await getActiveSchema(db, product);
  if (!schemaRow) return null;
  try {
    const catalog = new Catalog(JSON.parse(schemaRow.catalog_json));
    const payload: ManagedPayload = {
      config: {},
      secrets: {},
      entitlements: {},
    };
    for (const entry of catalog.entries) {
      if (entry.kind !== "config" || entry.default === undefined) continue;
      payload.config[entry.key] = {
        state: entry.managementDefault ?? "default",
        value: entry.default as ManagedEntry["value"],
        updatedAt: now,
      };
    }
    return JSON.stringify(payload);
  } catch {
    return null;
  }
}

/**
 * The licence overrides as the merge reads them. Before the licence-override migration's run
 * completes, the whole column (the expand phase: both layers are read, S-17 §5.12). From its
 * completion, `entitlements` only (step 5): config and secrets live on the account override layer,
 * and whatever the column still holds until the nightly sweep empties it is never delivered.
 * The migration state is read only when the column carries a config or secret key at all.
 */
async function licenseOverrideLayer(
  db: Db,
  overridesJson: string | null,
): Promise<string | null> {
  if (!overridesJson) return overridesJson;
  let parsed: Partial<ManagedPayload>;
  try {
    parsed = JSON.parse(overridesJson) as Partial<ManagedPayload>;
  } catch {
    return overridesJson;
  }
  const carries = (b: unknown): boolean =>
    b !== null && typeof b === "object" && Object.keys(b).length > 0;
  if (!carries(parsed.config) && !carries(parsed.secrets)) return overridesJson;
  if (!(await licenseConfigOverridesRetired(db))) return overridesJson;
  return JSON.stringify({
    config: {},
    secrets: {},
    entitlements: parsed.entitlements ?? {},
  });
}

/**
 * Walk every managed-payload layer for one device into a single effective payload.
 *
 * `license` is NULLABLE, and that is the D-08 case on the wire: a product that runs Config with
 * License disabled has devices with no licence at all, and they still receive a config document
 * (WIRE-CONTRACT-V3 §2.2). With no licence the tier, the licence profiles and the licence
 * overrides simply contribute no layer — catalog defaults and the device's own overrides remain,
 * which is exactly the right answer rather than a special case.
 *
 * The ACCOUNT OVERRIDE layer (U-03, plans/U-01.md §6.3) is read OUTSIDE the licence block: a
 * licence-less device signed in to an account gets its account's layer, and a floating licence
 * gets none (`core/accountOverrides.ts` `overrideSubject`). It carries only `config` and
 * `secrets`, so the buckets stay disjoint: entitlements still come from the tier, the profiles,
 * the store grants and the licence's own overrides alone. It sits after the licence overrides and
 * before the device's, so an operator's account override beats a store grant and a licence-level
 * value (S-17 §5.12), and a device override still beats both. `opts.entitlementsOnly` skips it for
 * a caller that reads `entitlements` alone (the result's entitlements are identical either way).
 *
 * No sealed value is opened here and no admin policy is injected here; see the file header.
 */
export async function resolveMergedPayload(
  db: Db,
  product: string,
  license: LicenseRow | null,
  device: DeviceRow | null | undefined,
  now: number,
  opts: { entitlementsOnly?: boolean; withoutOidcGrant?: boolean } = {},
): Promise<MergedPayload> {
  const layers: (string | null | undefined)[] = [
    await catalogDefaultPayload(db, product, now),
  ];

  let tier: TierRow | null = null;
  if (license?.tier_id) {
    tier = await getTier(db, product, license.tier_id);
    if (tier?.profile_id) {
      const p = await getProfile(db, product, tier.profile_id);
      layers.push(p?.payload_json ?? null);
    }
  }

  if (license) {
    const profiles = await listLicenseProfiles(db, product, license.id);
    for (const ref of profiles) {
      const p = await getProfile(db, product, ref.profile_id);
      layers.push(p?.payload_json ?? null);
    }
    // P6-01: the licence's active store grants (a verified purchase's flag), after the profiles
    // and BEFORE the licence's own overrides, so an operator's override of the same flag wins
    // (`core/storeGrants.ts`).
    layers.push(await storeGrantLayer(db, product, license.id));
    layers.push(
      opts.entitlementsOnly
        ? license.overrides_json
        : await licenseOverrideLayer(db, license.overrides_json),
    );
    // LX-08 (S-19 §7.14 step 4): the licence's OIDC-provisioned entitlement keys, moved out of its
    // overrides column into its `oidc` grant. Right AFTER the overrides and without any key they
    // carry, which is the order and the precedence the keys had inside the column (an operator's
    // override of a provisioned key still wins; `core/grants.ts` explains the byte identity).
    // A caller previewing a hypothetical row whose overrides already carry the provisioned keys
    // passes `withoutOidcGrant`, so the stored grant is not read twice.
    if (!opts.withoutOidcGrant)
      layers.push(
        await oidcGrantLayer(db, product, license.id, license.overrides_json),
      );
  }

  // U-03: outside `if (license)`, so a licence-less signed-in device gets its account's layer.
  if (!opts.entitlementsOnly)
    layers.push(await accountOverrideLayer(db, product, license, device));

  layers.push(device?.overrides_json ?? null);
  return { payload: mergePayloads(...layers), tier };
}

/**
 * Defense-in-depth: drop any config/secret entry whose key is unknown to the active
 * catalog, sits in the wrong payload bucket, or whose value fails the catalog schema,
 * BEFORE signing. A misconfigured or stale override must never be minted into a signed
 * doc. Entitlements pass through because server-side gates may be policy-only and not
 * declared as user-facing catalog flags.
 *
 * This runs on the document hot path, so it must not depend on runtime code generation:
 * `Catalog` interprets each schema fragment rather than compiling one, because workerd
 * forbids `Function(string)` inside a request and catalogs only ever load mid-request
 * (R10-01). A fragment the validator cannot interpret marks its value invalid, so this
 * prune fails CLOSED — an unenforceable constraint drops the value instead of signing it.
 */
export function validatePayload(
  payload: ManagedPayload,
  catalog: Catalog,
): ManagedPayload {
  const prune = (
    entries: Record<string, ManagedEntry>,
    kind: "config" | "secret" | "flag",
  ): Record<string, ManagedEntry> => {
    const out: Record<string, ManagedEntry> = {};
    for (const [key, entry] of Object.entries(entries)) {
      const catalogEntry = catalog.entryByKey(key);
      if (!catalogEntry || catalogEntry.kind !== kind) continue;
      // `delivery: "serverOnly"` — the value exists for the WORKER to consume; it is never
      // signed into a device document. Every document path funnels through this prune
      // (config document and the bundles that reuse buildConfigDoc), so enforcing it here
      // is what makes the catalog declaration true rather than descriptive.
      if (kind === "secret" && catalogEntry.delivery === "serverOnly") continue;
      if (!catalog.validateKeyValue(key, entry.value).ok) continue;
      out[key] = entry;
    }
    return out;
  };
  return {
    config: prune(payload.config ?? {}, "config"),
    secrets: prune(payload.secrets ?? {}, "secret"),
    entitlements: payload.entitlements ?? {},
  };
}

/**
 * Run the merged payload through the product's ACTIVE catalog, or `null` when the catalog row
 * exists but cannot be parsed.
 *
 * The null is the fail-closed arm both document routes answer `500 catalog_unavailable` to: a
 * catalog we cannot interpret is a catalog we cannot enforce, and delivering the unpruned
 * payload would ship exactly what the catalog exists to refuse. A product with NO active schema
 * row is a different thing — nothing to validate against, payload passes through unchanged.
 */
export async function prunePayloadAgainstCatalog(
  db: Db,
  product: string,
  payload: ManagedPayload,
): Promise<ManagedPayload | null> {
  const schemaRow = await getActiveSchema(db, product);
  if (!schemaRow) return payload;
  try {
    return validatePayload(
      payload,
      new Catalog(JSON.parse(schemaRow.catalog_json)),
    );
  } catch {
    return null;
  }
}

/** Open sealed managed secrets in place (R12-02). Re-exported through Core so a service never
 *  imports the admin tree to mint its own document. */
export { openManagedPayload } from "../admin/lib/managedSecrets.js";
