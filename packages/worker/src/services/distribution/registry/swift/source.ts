/**
 * Release's package state as the materialiser reads it (`PackageSource`, plans/F-01.md §6.5),
 * over the read-only `releaseCatalog` hook F-03 ships (`packageDeliverables`, `packageVersions`,
 * `packageChannelHeads`). Distribution never reads Release's tables itself (rule 6).
 *
 * Channels become tags here, once (§6.3): `stable` → `latest`, any other channel → a tag of its
 * own name. Generic over the ecosystem; it lives in F-06's directory only so the parallel feed
 * packages touch disjoint files (a follow-up may hoist it beside `materialise.ts`).
 */

import type {
  CatalogPackageDeliverable,
  ReleaseCatalog,
} from "../../../../core/hooks.js";
import type { RegistryEcosystem } from "../../../../core/registryHost.js";
import type { PackageSource, RegistryPackage } from "../materialise.js";

/** The catalog readers a package source needs. */
export type PackageCatalog = Pick<
  ReleaseCatalog,
  "packageDeliverables" | "packageVersions" | "packageChannelHeads"
>;

/** The tag a channel maps to (§6.3). */
export function channelTag(channel: string): string {
  return channel === "stable" ? "latest" : channel;
}

/** The package deliverable of `ecosystem` whose name equals `nameNorm` (already normalised by
 *  `normalise`), or `null`. */
export async function findPackageDeliverable(
  catalog: PackageCatalog,
  ecosystem: RegistryEcosystem,
  nameNorm: string,
  normalise: (name: string) => string,
): Promise<CatalogPackageDeliverable | null> {
  for (const d of await catalog.packageDeliverables())
    if (d.ecosystem === ecosystem && normalise(d.name) === nameNorm) return d;
  return null;
}

/** A `PackageSource` for one product's catalog, limited to `ecosystem`'s packages. */
export function catalogPackageSource(
  catalog: PackageCatalog,
  ecosystem: RegistryEcosystem,
  normalise: (name: string) => string,
): PackageSource {
  return {
    async package(product, deliverableId): Promise<RegistryPackage | null> {
      const decl = (await catalog.packageDeliverables()).find(
        (d) => d.id === deliverableId,
      );
      if (!decl || decl.ecosystem !== ecosystem) return null;
      const versions = await catalog.packageVersions(deliverableId);
      const heads = await catalog.packageChannelHeads(deliverableId);
      const tags: Record<string, string> = {};
      for (const h of heads) tags[channelTag(h.channel)] = h.version;
      return {
        product,
        ecosystem,
        deliverableId,
        name: decl.name,
        nameNorm: versions[0]?.nameNorm ?? normalise(decl.name),
        versions: versions.map((v) => ({
          version: v.version,
          state: v.state,
          stateMessage: v.stateMessage,
          files: v.files,
          metadata: v.metadata,
          publishedAt: v.publishedAt,
        })),
        tags,
      };
    },
  };
}
