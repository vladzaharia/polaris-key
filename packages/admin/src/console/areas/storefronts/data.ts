/**
 * The storefronts area's queries (A-18j): every store's plan, the slot board, and A-18b's listing
 * model, fit report and release notes. Writes go through `mutate` (ADMIN.md §5.4).
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  api,
  type ListingFitResponse,
  type ListingReleaseNotesResponse,
  type ListingResponse,
  type ListingSlotDto,
  type StorefrontsResponse,
} from "../../../api.js";
import { qk } from "../../data/queries.js";
import { queryClient } from "../../data/queryClient.js";

export function useStorefronts(
  slug: string,
): UseQueryResult<StorefrontsResponse> {
  return useQuery(
    { queryKey: qk.storefronts(slug), queryFn: () => api.storefronts(slug) },
    queryClient,
  );
}

export function useSlots(
  slug: string,
): UseQueryResult<{ slots: ListingSlotDto[] }> {
  return useQuery(
    {
      queryKey: qk.storefrontSlots(slug),
      queryFn: () => api.storefrontSlots(slug),
    },
    queryClient,
  );
}

export function useListing(slug: string): UseQueryResult<ListingResponse> {
  return useQuery(
    { queryKey: qk.listing(slug), queryFn: () => api.listing(slug) },
    queryClient,
  );
}

export function useListingFit(
  slug: string,
  release: string | null = null,
): UseQueryResult<ListingFitResponse> {
  return useQuery(
    {
      queryKey: qk.listingFit(slug, release),
      queryFn: () => api.listingFit(slug, release),
    },
    queryClient,
  );
}

export function useReleaseNotes(
  slug: string,
  release: string | null,
): UseQueryResult<ListingReleaseNotesResponse> {
  return useQuery(
    {
      queryKey: qk.listingNotes(slug, release ?? ""),
      queryFn: () => api.listingReleaseNotes(slug, release!),
      enabled: release !== null && release !== "",
    },
    queryClient,
  );
}

/** A per-intent key: random, never stored. One per opened dialog, so a retry replays. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto)
    return crypto.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** The store labels a listing column is shown with in this area. */
export const LISTING_GROUP_LABELS: Record<string, string> = {
  masters: "Masters",
  "app-store": "App Store",
  play: "Google Play",
  "ms-store": "Microsoft Store",
  steam: "Steam",
  itch: "itch.io",
  snap: "Snap Store",
  flathub: "Flathub",
  winget: "winget",
  fdroid: "F-Droid",
};
