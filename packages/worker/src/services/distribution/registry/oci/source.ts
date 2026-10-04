/**
 * Release's package state as the OCI feed reads it (F-08): a repository name resolved to its
 * package deliverable, and that package as a `RegistryPackage`, read ONLY through the read-only
 * `releaseCatalog` hook (F-03's `packageDeliverables`, `packageVersions` and
 * `packageChannelHeads`), never Release's tables (rule 6).
 */

import type { ReleaseCatalog } from "../../../../core/hooks.js";
import type { PackageVersion, RegistryPackage } from "../materialise.js";

type PackageReader = Pick<
  ReleaseCatalog,
  "packageDeliverables" | "packageVersions" | "packageChannelHeads"
>;

/** The package deliverable of `owner` whose OCI repository is `repository`, or `null`. */
export async function ociDeliverable(
  catalog: PackageReader,
  repository: string,
): Promise<{ id: string; name: string } | null> {
  const found = (await catalog.packageDeliverables()).find(
    (d) => d.ecosystem === "oci" && d.name === repository,
  );
  return found ? { id: found.id, name: found.name } : null;
}

/** The channel → tag rule (§6.3): `stable` is `latest`, every other channel its own name. */
export function channelTag(channel: string): string {
  return channel === "stable" ? "latest" : channel;
}

/** One package deliverable as the renderer sees it: every version, and its channel tags. */
export async function ociPackage(
  catalog: PackageReader,
  owner: string,
  deliverable: { id: string; name: string },
): Promise<RegistryPackage> {
  const rows = await catalog.packageVersions(deliverable.id);
  const versions: PackageVersion[] = rows.map((r) => ({
    version: r.version,
    state: r.state,
    stateMessage: r.stateMessage,
    files: r.files,
    metadata: r.metadata,
    publishedAt: r.publishedAt,
  }));
  const tags: Record<string, string> = {};
  for (const head of await catalog.packageChannelHeads(deliverable.id))
    tags[channelTag(head.channel)] = head.version;
  return {
    product: owner,
    ecosystem: "oci",
    deliverableId: deliverable.id,
    name: deliverable.name,
    nameNorm: deliverable.name,
    versions,
    tags,
  };
}
