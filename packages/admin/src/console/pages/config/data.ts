/**
 * The Config section's reads (docs/design/ADMIN.md §6.6). One fetcher per query key: the catalog,
 * profile list and tier list keep the exact fetchers every other reader of those keys uses, so the
 * cache holds one shape per key (`test/queryKeyShapes.test.ts`).
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
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
import { queryClient } from "../../data/queryClient.js";

/** A 404 from a read: the thing does not exist (a product with no catalog yet). */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** The active catalog. A 404 means "no catalog yet", which pages render as their first run. */
export function useCatalog(slug: string): UseQueryResult<ProductCatalog> {
  return useQuery(
    { queryKey: qk.catalog(slug), queryFn: () => api.schema(slug) },
    queryClient,
  );
}

export function useCatalogVersions(
  slug: string,
  enabled = true,
): UseQueryResult<{ versions: CatalogVersionSummary[] }> {
  return useQuery(
    {
      queryKey: qk.catalogVersions(slug),
      queryFn: () => api.catalogVersions(slug),
      enabled,
    },
    queryClient,
  );
}

export function useCatalogVersion(
  slug: string,
  version: number | null,
): UseQueryResult<ProductCatalog> {
  return useQuery(
    {
      queryKey: qk.catalogVersion(slug, version ?? 0),
      queryFn: () => api.catalogVersion(slug, version ?? 0),
      enabled: version !== null && version > 0,
    },
    queryClient,
  );
}

/** Who sets these keys (A-7b). Disabled for an empty key list. */
export function useCatalogUsage(
  slug: string,
  keys: readonly string[],
): UseQueryResult<{ keys: Record<string, CatalogKeyUsage> }> {
  return useQuery(
    {
      queryKey: qk.catalogUsage(slug, keys),
      queryFn: () => api.catalogUsage(slug, keys),
      enabled: keys.length > 0,
    },
    queryClient,
  );
}

export function useProfiles(
  slug: string,
): UseQueryResult<{ profiles: ProfileSummary[] }> {
  return useQuery(
    { queryKey: qk.profiles(slug), queryFn: () => api.profiles(slug) },
    queryClient,
  );
}

export function useProfile(
  slug: string,
  id: string,
): UseQueryResult<ProfileDetail> {
  return useQuery(
    { queryKey: qk.profile(slug, id), queryFn: () => api.profile(slug, id) },
    queryClient,
  );
}

export function useEdgeMint(
  slug: string,
): UseQueryResult<EdgeMintRecipesResponse> {
  return useQuery(
    { queryKey: qk.mint(slug), queryFn: () => api.edgeMintRecipes(slug) },
    queryClient,
  );
}

/**
 * Who owns the catalog (CAT-3): a product linked to a repository takes its catalog from
 * `.pkey/schema`, and the next resync re-applies it over a console publish.
 */
export function catalogSource(
  product: ProductDetail | undefined,
): Extract<Source, "manifest" | "admin"> {
  return product?.releaseSource === "github" ? "manifest" : "admin";
}

/** The catalog file a manifest-owned catalog comes from. */
export const CATALOG_PATH = ".pkey/schema";
