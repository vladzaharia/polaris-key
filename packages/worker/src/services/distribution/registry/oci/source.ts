/**
 * Release's package state as the OCI feed reads it (F-08): a repository name resolved to its
 * package deliverable, and that package as a `RegistryPackage`, through the shared catalog
 * helpers (`../catalogSource.ts`), never Release's tables (rule 6).
 */

import type { ReleaseCatalog } from "../../../../core/hooks.js";
import { findPackageDeliverable, registryPackageOf } from "../catalogSource.js";
import type { RegistryPackage } from "../materialise.js";

type PackageReader = Pick<
  ReleaseCatalog,
  "packageDeliverables" | "packageVersions" | "packageChannelHeads"
>;

/** The package deliverable of `owner` whose OCI repository is `repository`, or `null`. OCI
 *  repository names are lower case by grammar, so the shared case-insensitive match is exact. */
export async function ociDeliverable(
  catalog: PackageReader,
  repository: string,
): Promise<{ id: string; name: string } | null> {
  const found = await findPackageDeliverable(catalog, "oci", repository);
  return found ? { id: found.id, name: found.name } : null;
}

/** One package deliverable as the renderer sees it: every version, and its channel tags. Its
 *  normalised name is the repository name itself. */
export async function ociPackage(
  catalog: PackageReader,
  owner: string,
  deliverable: { id: string; name: string },
): Promise<RegistryPackage> {
  return registryPackageOf(
    owner,
    "oci",
    deliverable,
    await catalog.packageVersions(deliverable.id),
    await catalog.packageChannelHeads(deliverable.id),
    deliverable.name,
  );
}
