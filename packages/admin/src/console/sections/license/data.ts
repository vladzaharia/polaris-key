/**
 * The Licensing section's reads: one `queryOptions` factory per key family (components.md §7).
 * Pages and hooks call `useQuery(factory)`, or spread it to add `enabled` or `retry`.
 */

import {
  infiniteQueryOptions,
  keepPreviousData,
  queryOptions,
} from "@tanstack/react-query";
import {
  api,
  LICENSE_PAGE_MAX,
  type LicenseBatch,
  type LicenseListFilter,
  type LicensePage,
} from "../../../api.js";
import { qk } from "../../data/queries.js";
import type { HolderState } from "./components/holders.js";

export const licensesQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.licenses(slug),
    queryFn: () => api.licenses(slug),
  });

/** A one-row page: whether the product has a licence, and the holders facts. Under `qk.licenses`. */
export const licensesFirstQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.licensesFirst(slug),
    queryFn: () => api.licensesPage(slug, { limit: 1 }),
  });

/**
 * The Licenses page's rows, one page at a time. `big` is read at fetch time: Search-all reads
 * a larger page.
 */
export const licensePagesQuery = (
  slug: string,
  filter: LicenseListFilter,
  big: { current: boolean },
) =>
  infiniteQueryOptions({
    queryKey: [...qk.licensesPages(slug), filter],
    queryFn: ({ pageParam }) =>
      api.licensesPage(slug, {
        cursor: pageParam,
        ...(big.current ? { limit: LICENSE_PAGE_MAX } : {}),
        ...filter,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: LicensePage) => last.nextCursor ?? undefined,
    // A tile or chip changes the filter: the rows stay until the new first page lands.
    placeholderData: keepPreviousData,
  });

export const tiersQuery = (slug: string) =>
  queryOptions({ queryKey: qk.tiers(slug), queryFn: () => api.tiers(slug) });

export const licenseQuery = (slug: string, id: string) =>
  queryOptions({
    queryKey: qk.license(slug, id),
    queryFn: () => api.license(slug, id),
  });

export const licenseCleanupQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.licenseCleanup(slug),
    queryFn: () => api.licenseCleanupCandidates(slug),
  });

/**
 * What each holder state counts across the whole product: the Worker's `total` for a one-row page
 * under each holder filter. A state the Worker did not count stays out of the result.
 */
export const holderCountsQuery = (
  slug: string,
  states: readonly HolderState[],
) =>
  queryOptions({
    queryKey: qk.licenseHolderCounts(slug),
    queryFn: async (): Promise<Partial<Record<HolderState, number>>> => {
      const pages = await Promise.all(
        states.map((holder) => api.licensesPage(slug, { limit: 1, holder })),
      );
      const out: Partial<Record<HolderState, number>> = {};
      states.forEach((h, i) => {
        const total = pages[i]?.total;
        if (total !== undefined) out[h] = total;
      });
      return out;
    },
  });

/** The page size the batch list is read in, and the most pages read (10,000 batches). */
const BATCH_PAGE = 500;
const MAX_BATCH_PAGES = 20;

/** Every batch of the product, newest first, all pages read: one key, one shape. */
export async function fetchLicenseBatches(
  slug: string,
): Promise<{ batches: LicenseBatch[] }> {
  const batches: LicenseBatch[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_BATCH_PAGES; page++) {
    const res = await api.licenseBatches(slug, { limit: BATCH_PAGE, cursor });
    batches.push(...(res.batches ?? []));
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return { batches };
}

export const licenseBatchesQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.licenseBatches(slug),
    queryFn: () => fetchLicenseBatches(slug),
  });

/** One batch; `null` reads nothing (a licence created on its own). */
export const licenseBatchQuery = (slug: string, id: string | null) =>
  queryOptions({
    queryKey: qk.licenseBatch(slug, id ?? ""),
    queryFn: () => api.licenseBatch(slug, id ?? ""),
    enabled: id !== null,
  });

export const licenseHolderMovesQuery = (slug: string, id: string) =>
  queryOptions({
    queryKey: qk.licenseHolderMoves(slug, id),
    queryFn: () => api.licenseHolderMoves(slug, id),
  });

export const fingerprintPolicyQuery = (slug: string) =>
  queryOptions({
    queryKey: qk.fingerprintPolicy(slug),
    queryFn: () => api.fingerprintPolicy(slug),
  });

/** One query for a licence's whole profile stack, so the hook count never depends on its length. */
export const profileStackQuery = (
  slug: string,
  stackKey: string,
  profileIds: readonly string[],
) =>
  queryOptions({
    queryKey: qk.profileStack(slug, stackKey),
    queryFn: () =>
      stackKey === ""
        ? Promise.resolve([])
        : Promise.all(
            profileIds.map((profileId) =>
              api.profile(slug, profileId).then((profile) => ({
                source: `profile “${profile.name || profile.id}”`,
                payload: profile.payload,
              })),
            ),
          ),
  });
