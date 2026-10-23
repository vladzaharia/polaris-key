/**
 * The Config section's reads (docs/design/ADMIN.md §6.6). One fetcher per query key: the catalog,
 * profile list and tier list keep the exact fetchers every other reader of those keys uses, so the
 * cache holds one shape per key (`test/queryFactories.test.ts`).
 */

import { coreBReads } from "../core/data.js";
import {
  queryOptions,
  type QueryObserverOptions,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  api,
  ApiError,
  type CatalogKeyUsage,
  type CatalogVersionSummary,
  type EdgeMintRecipesResponse,
  type ProductCatalog,
  type ProductDetail,
  type ProfileDetail,
  type ProfileSummary,
} from "../../../api.js";
import type { Source } from "../../../ui/SourceBadge.js";
import { qk } from "../../data/queries.js";
import { licenseQuery } from "../license/data.js";

/** A 404 from a read: the thing does not exist (a product with no catalog yet). */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** The active catalog, shared with Distribution's pack gates (one fetcher for the key). */
export const catalogQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.catalog(slug),
    queryFn: () => api.schema(slug),
  });

/** The profile list, shared with Licensing's tier forms (one fetcher for the key). */
export const profilesQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.profiles(slug),
    queryFn: () => api.profiles(slug),
  });

/** The active catalog. A 404 means "no catalog yet", which pages render as their first run. */
export function useCatalog(
  slug: string,
  enabled = true,
): UseQueryResult<ProductCatalog> {
  return useQuery({ ...catalogQuery(slug), enabled });
}

const catalogVersionsQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.catalogVersions(slug),
    queryFn: () => api.catalogVersions(slug),
  });

const catalogVersionQuery = (slug: string, version: number) =>
  queryOptions({
    queryKey: qk.catalogVersion(slug, version),
    queryFn: () => api.catalogVersion(slug, version),
  });

const catalogUsageQuery = (slug: string, keys: readonly string[]) =>
  queryOptions({
    queryKey: qk.catalogUsage(slug, keys),
    queryFn: () => api.catalogUsage(slug, keys),
  });

const profileQuery = (slug: string, id: string) =>
  queryOptions({
    queryKey: qk.profile(slug, id),
    queryFn: () => api.profile(slug, id),
  });

/** Managed-config mint recipes. */
export const mintQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.mint(slug),
    queryFn: () => api.edgeMintRecipes(slug),
  });

/** One removed-value holder, read whole under its own key (the config is picked from it). */
export const holderQuery = (
  slug: string,
  kind: "profile" | "license" | "account",
  id: string,
): QueryObserverOptions<unknown> =>
  (kind === "profile"
    ? profileQuery(slug, id)
    : kind === "license"
      ? licenseQuery(slug, id)
      : coreBReads.userOverrides(slug, id)) as QueryObserverOptions<unknown>;

export function useCatalogVersions(
  slug: string,
  enabled = true,
): UseQueryResult<{ versions: CatalogVersionSummary[] }> {
  return useQuery({ ...catalogVersionsQuery(slug), enabled });
}

export function useCatalogVersion(
  slug: string,
  version: number | null,
): UseQueryResult<ProductCatalog> {
  return useQuery({
    ...catalogVersionQuery(slug, version ?? 0),
    enabled: version !== null && version > 0,
  });
}

/** Who sets these keys (A-7b). Disabled for an empty key list. */
export function useCatalogUsage(
  slug: string,
  keys: readonly string[],
): UseQueryResult<{ keys: Record<string, CatalogKeyUsage> }> {
  return useQuery({
    ...catalogUsageQuery(slug, keys),
    enabled: keys.length > 0,
  });
}

export function useProfiles(
  slug: string,
): UseQueryResult<{ profiles: ProfileSummary[] }> {
  return useQuery(profilesQuery(slug));
}

export function useProfile(
  slug: string,
  id: string,
): UseQueryResult<ProfileDetail> {
  return useQuery(profileQuery(slug, id));
}

/**
 * `watch` keeps the recipe fresh while an approve drawer is open, so a recipe that changes under it
 * is noticed before the operator approves it (admin-2-16).
 */
export function useEdgeMint(
  slug: string,
  watch = false,
): UseQueryResult<EdgeMintRecipesResponse> {
  return useQuery({
    ...mintQuery(slug),
    ...(watch
      ? { refetchInterval: 15_000, refetchOnWindowFocus: "always" as const }
      : {}),
  });
}

/**
 * Who owns the catalog (CAT-3): a product linked to a repository takes its catalog from
 * `.pkey/schema`, and the next resync re-applies it over a console publish.
 */
export function catalogSource(
  product: ProductDetail | undefined,
): Extract<Source, "manifest" | "admin"> {
  // ST-01b: a console publish claims the catalog (`config.catalog`), so a repo-linked product's
  // catalog is the console's once claimed, and the manifest's until then.
  if (product?.releaseSource !== "github") return "admin";
  return (product.claims ?? []).some((c) => c.key === "config.catalog")
    ? "admin"
    : "manifest";
}

/** The catalog file a manifest-owned catalog comes from. */
export const CATALOG_PATH = ".pkey/schema";
