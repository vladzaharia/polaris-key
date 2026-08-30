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
 *                       →  license overrides  →  device overrides
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

/**
 * The product's ACTIVE catalog, or `null` when there is none to enforce — no active
 * `product_schema` row, or a row whose `catalog_json` will not parse into a `Catalog`.
 *
 * ONE loader, deliberately: `prunePayloadAgainstCatalog` treats both of those as the same
 * fail-closed answer (see below), and the admin surface's `loadCatalog` is this function under
 * its old name. Two spellings of "read the active catalog" is how one of them acquires a
 * different null policy from the other.
 */
export async function activeCatalog(
  db: Db,
  product: string,
): Promise<Catalog | null> {
  const schemaRow = await getActiveSchema(db, product);
  if (!schemaRow) return null;
  try {
    return new Catalog(JSON.parse(schemaRow.catalog_json));
  } catch {
    return null;
  }
}

/** The catalog's own declared defaults, the bottom layer of every merge. */
async function catalogDefaultPayload(
  db: Db,
  product: string,
  now: number,
): Promise<string | null> {
  const catalog = await activeCatalog(db, product);
  if (!catalog) return null;
  try {
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
 * Walk every managed-payload layer for one device into a single effective payload.
 *
 * `license` is NULLABLE, and that is the D-08 case on the wire: a product that runs Config with
 * License disabled has devices with no licence at all, and they still receive a config document
 * (WIRE-CONTRACT-V3 §2.2). With no licence the tier, the licence profiles and the licence
 * overrides simply contribute no layer — catalog defaults and the device's own overrides remain,
 * which is exactly the right answer rather than a special case.
 *
 * No sealed value is opened here and no admin policy is injected here; see the file header.
 */
export async function resolveMergedPayload(
  db: Db,
  product: string,
  license: LicenseRow | null,
  device: DeviceRow | null | undefined,
  now: number,
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
    layers.push(license.overrides_json);
  }

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
 * Run the merged payload through the product's ACTIVE catalog, or `null` when there is no
 * usable catalog: no active `product_schema` row, or a row that will not parse.
 *
 * The null is the fail-closed arm both document routes answer `500 catalog_unavailable` to: a
 * catalog we cannot interpret is a catalog we cannot enforce, and delivering the unpruned
 * payload would ship exactly what the catalog exists to refuse.
 *
 * ── WHY "NO ACTIVE SCHEMA ROW" IS THE SAME ANSWER (deliberate, not an oversight) ─────────────
 *
 * This used to `return payload` unpruned when there was no active schema, on the reasoning that
 * there is "nothing to validate against". That is defensible for a payload assembled only out of
 * catalog-derived layers — an empty catalog contributes no defaults, so there would be nothing
 * to drop — and it is WRONG in composition, because the payload reaching here is NOT only
 * catalog-derived:
 *
 *   • `services/identity/oidc.ts:applyProvisioning` writes `payload.secrets[<key>]` straight from
 *     a `provisioning_config` row, with no catalog consulted at all;
 *   • `licenses.overrides_json` / `profiles.payload_json` keep whatever a previous catalog
 *     version, or a previous admin, put there.
 *
 * So "no active schema" is not "nothing to drop" — it is "everything, including a
 * `delivery: "serverOnly"` secret, passes through into a signed document". And the state is
 * reachable on purpose: `deactivateSchemas` runs on every catalog publish, and a product may
 * simply never have published one. `delivery: "serverOnly"` is only true rather than descriptive
 * because THIS prune enforces it (see `validatePayload`), which means the enforcement may not be
 * conditional on a row that an ordinary admin action removes.
 *
 * The cost of the closed door is honest and bounded: a product with no catalog cannot serve a
 * config document, and gets a 500 naming the reason instead of a silently over-broad document.
 * A product that wants config publishes a catalog — an empty one is a legal catalog and prunes
 * everything, which is the correct reading of "this product declares no keys".
 */
export async function prunePayloadAgainstCatalog(
  db: Db,
  product: string,
  payload: ManagedPayload,
): Promise<ManagedPayload | null> {
  const catalog = await activeCatalog(db, product);
  if (!catalog) return null;
  try {
    return validatePayload(payload, catalog);
  } catch {
    return null;
  }
}

/** The managed-secret envelope helpers (R12-02), re-exported through Core so a service never
 *  imports the admin tree to mint its own document — or to seal a value it writes. */
export {
  isManagedSecretKey,
  openManagedPayload,
  sealManagedValue,
} from "../admin/lib/managedSecrets.js";

/** Read one of the stored `ManagedPayload` JSON columns. Core-owned because the shape is
 *  declared here: a writer that has to merge onto an existing row (Identity's sign-in, which
 *  must not flatten an admin's overrides) needs the reader without importing the admin tree. */
export { parsePayload } from "../admin/lib/redact.js";
