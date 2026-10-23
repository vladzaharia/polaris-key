/** The CI publishing readers (one per query), shared by this page and Release's guided panel. */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  api,
  type CiTokenDto,
  type PublisherPolicyDto,
} from "../../../../api.js";
import { qk } from "../../../data/queries.js";

export function fetchCiPublisher(
  slug: string,
): Promise<PublisherPolicyDto | null> {
  return api.ciPublisher(slug).then((r) => r.policy);
}

export function fetchCiTokens(slug: string): Promise<CiTokenDto[]> {
  return api.ciTokens(slug).then((r) => r.tokens);
}

/** The trusted-publisher policy: one reader for this page and Release's guided panel. */
export function useCiPublisher(
  slug: string,
): UseQueryResult<PublisherPolicyDto | null> {
  return useQuery({
    queryKey: qk.ciPublisher(slug),
    queryFn: () => fetchCiPublisher(slug),
  });
}

/** The product's CI tokens: one reader for this page and Release's guided panel. */
export function useCiTokens(slug: string): UseQueryResult<CiTokenDto[]> {
  return useQuery({
    queryKey: qk.ciTokens(slug),
    queryFn: () => fetchCiTokens(slug),
  });
}

/** A saved numeric entry back, or null. */
export function num(v: string | undefined): number | null {
  const n = v ? Number(v) : NaN;
  return Number.isInteger(n) ? n : null;
}
