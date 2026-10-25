/** The CI publishing readers (one per query), shared by this page and Release's guided panel. */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { CiTokenDto, PublisherPolicyDto } from "../../../../api.js";
import { coreBReads, fetchCiPublisher, fetchCiTokens } from "../data.js";

export { fetchCiPublisher, fetchCiTokens };

/** The trusted-publisher policy: one reader for this page and Release's guided panel. */
export function useCiPublisher(
  slug: string,
): UseQueryResult<PublisherPolicyDto | null> {
  return useQuery(coreBReads.ciPublisher(slug));
}

/** The product's CI tokens: one reader for this page and Release's guided panel. */
export function useCiTokens(slug: string): UseQueryResult<CiTokenDto[]> {
  return useQuery(coreBReads.ciTokens(slug));
}

/** A saved numeric entry back, or null. */
export function num(v: string | undefined): number | null {
  const n = v ? Number(v) : NaN;
  return Number.isInteger(n) ? n : null;
}
