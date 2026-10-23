/**
 * The Core section's reads (docs/design/ADMIN.md §6.6): one `queryOptions` factory per key
 * family. A page calls `useQuery(coreReads.x(slug))`, spreads it to add `enabled`, or reads
 * imperatively with `queryClient.fetchQuery(coreReads.x(slug))`.
 */

import { queryOptions } from "@tanstack/react-query";
import { api, type CiTokenDto, type PublisherPolicyDto } from "../../../api.js";
import { qk } from "../../data/queries.js";

// core B

export function fetchCiPublisher(
  slug: string,
): Promise<PublisherPolicyDto | null> {
  return api.ciPublisher(slug).then((r) => r.policy);
}

export function fetchCiTokens(slug: string): Promise<CiTokenDto[]> {
  return api.ciTokens(slug).then((r) => r.tokens);
}

export const coreBReads = {
  keys: (slug: string) =>
    queryOptions({
      queryKey: qk.keys(slug),
      queryFn: () => api.productKeys(slug),
    }),
  trustPolicy: (slug: string) =>
    queryOptions({
      queryKey: qk.trustPolicy(slug),
      queryFn: () => api.trustPolicy(slug),
    }),
  ciPublisher: (slug: string) =>
    queryOptions({
      queryKey: qk.ciPublisher(slug),
      queryFn: () => fetchCiPublisher(slug),
    }),
  ciTokens: (slug: string) =>
    queryOptions({
      queryKey: qk.ciTokens(slug),
      queryFn: () => fetchCiTokens(slug),
    }),
  blobGc: (slug: string) =>
    queryOptions({
      queryKey: qk.blobGc(slug),
      queryFn: () => api.blobGc(slug),
    }),
  userOverrides: (slug: string, subject: string) =>
    queryOptions({
      queryKey: qk.userOverrides(slug, subject),
      queryFn: () => api.productUserOverrides(slug, subject),
    }),
  portal: (slug: string) =>
    queryOptions({
      queryKey: qk.portal(slug),
      queryFn: () => api.portalSettings(slug).then((r) => r.settings),
    }),
  services: (slug: string) =>
    queryOptions({
      queryKey: qk.services(slug),
      queryFn: () => api.services(slug),
    }),
  packageFeedsSwitch: (slug: string) =>
    queryOptions({
      queryKey: qk.packageFeedsSwitch(slug),
      queryFn: () => api.packageFeeds(slug),
    }),
  productSettingsEvery: (slug: string) =>
    queryOptions({
      queryKey: qk.productSettingsEvery(slug),
      queryFn: () => api.productSettings(slug),
    }),
  productMembers: (slug: string) =>
    queryOptions({
      queryKey: qk.productMembers(slug),
      queryFn: () => api.productMembers(slug),
    }),
};
