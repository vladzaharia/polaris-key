/**
 * The merge's stored layers for one page of licences, read once (P0-29). `resolveMergedPayload`
 * walks the same layers for any {@link PayloadLayerSource}; this one answers from rows read in a
 * fixed number of queries however many licences the page holds: the catalog once, every tier and
 * profile of the product once, and the licence profiles, store grants and OIDC grants of the page
 * with one `IN` read per 90 licences.
 */

import type { Db } from "../../db/types.js";
import type { LicenseProfileRow, LicenseRow } from "../repo.js";
import { oidcGrantLayerOf, oidcGrantRowsFor } from "./grants.js";
import { catalogDefaultPayload, type PayloadLayerSource } from "./payload.js";
import { listLicenseProfileRows } from "./store.js";
import { listProfiles, listTiers } from "./store.js";
import { storeGrantLayerOf, storeGrantRowsFor } from "./storeGrants.js";

export async function prefetchedLayerSource(
  db: Db,
  product: string,
  licenses: readonly Pick<LicenseRow, "id">[],
  now: number,
): Promise<PayloadLayerSource> {
  const ids = licenses.map((l) => l.id);
  const [catalog, tiers, profiles, licenseProfiles, storeGrants, oidcGrants] =
    await Promise.all([
      catalogDefaultPayload(db, product, now),
      listTiers(db, product),
      listProfiles(db, product),
      listLicenseProfileRows(db, product, ids),
      storeGrantRowsFor(db, product, ids),
      oidcGrantRowsFor(db, product, ids, now),
    ]);
  const tierById = new Map(tiers.map((t) => [t.id, t]));
  const profileById = new Map(profiles.map((p) => [p.id, p]));
  const none: LicenseProfileRow[] = [];
  return {
    catalogDefault: async () => catalog,
    tier: async (id) => tierById.get(id) ?? null,
    profile: async (id) => profileById.get(id) ?? null,
    licenseProfiles: async (id) => licenseProfiles.get(id) ?? none,
    storeGrant: async (id) => storeGrantLayerOf(storeGrants.get(id) ?? []),
    oidcGrant: async (id, overridesJson) =>
      oidcGrantLayerOf(oidcGrants.get(id) ?? [], overridesJson),
  };
}
