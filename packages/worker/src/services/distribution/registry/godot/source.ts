/**
 * Release's package state as the Godot feed reads it (F-09): a `PackageSource` over the
 * read-only `releaseCatalog` hook (F-03: `packageDeliverables`, `packageVersions`,
 * `packageChannelHeads`), which answers null while Release is off for the owner. Nothing here
 * writes; Distribution never reads Release's tables directly (rule 6).
 *
 * Generic over the ecosystem; it lives in `godot/` only so the feed packages (F-04 to F-09) stay
 * in disjoint directories. Hoisting it beside `materialise.ts` is a follow-up once more than one
 * feed uses it.
 */

import type { ReleaseCatalog } from "../../../../core/hooks.js";
import type { RegistryEcosystem } from "../../../../core/registryHost.js";
import type {
  PackageSource,
  PackageVersion,
  RegistryPackage,
} from "../materialise.js";

/** The feeds' tag for a channel: `stable` → `latest`, any other channel keeps its name. */
export function channelTag(channel: string): string {
  return channel === "stable" ? "latest" : channel;
}

/** One package deliverable of `product` as a `RegistryPackage`, or `null` when it is not one of
 *  `ecosystem`. */
export async function loadPackage(
  catalog: ReleaseCatalog,
  product: string,
  ecosystem: RegistryEcosystem,
  deliverableId: string,
  declared?: { id: string; ecosystem: string; name: string },
): Promise<RegistryPackage | null> {
  const decl =
    declared ??
    (await catalog.packageDeliverables()).find((d) => d.id === deliverableId);
  if (!decl || decl.ecosystem !== ecosystem) return null;
  const rows = await catalog.packageVersions(deliverableId);
  const heads = await catalog.packageChannelHeads(deliverableId);
  const versions: PackageVersion[] = rows.map((r) => ({
    version: r.version,
    state: r.state,
    stateMessage: r.stateMessage,
    files: r.files.map((f) => ({ ...f })),
    metadata: r.metadata,
    publishedAt: r.publishedAt,
  }));
  const tags: Record<string, string> = {};
  for (const h of heads) tags[channelTag(h.channel)] = h.version;
  return {
    product,
    ecosystem,
    deliverableId,
    name: decl.name,
    nameNorm: rows[0]?.nameNorm ?? decl.name.toLowerCase(),
    versions,
    tags,
  };
}

/** Every package of `ecosystem` the product declares, loaded, by deliverable id. */
export async function loadPackages(
  catalog: ReleaseCatalog,
  product: string,
  ecosystem: RegistryEcosystem,
): Promise<RegistryPackage[]> {
  const out: RegistryPackage[] = [];
  const decls = (await catalog.packageDeliverables())
    .filter((d) => d.ecosystem === ecosystem)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const d of decls) {
    const pkg = await loadPackage(catalog, product, ecosystem, d.id, d);
    if (pkg) out.push(pkg);
  }
  return out;
}

/** A `PackageSource` for one owner over its catalog. Another owner reads as absent. */
export function catalogPackageSource(
  catalog: ReleaseCatalog,
  owner: string,
  ecosystem: RegistryEcosystem,
): PackageSource {
  return {
    async package(product, deliverableId) {
      if (product !== owner) return null;
      return loadPackage(catalog, product, ecosystem, deliverableId);
    },
  };
}
