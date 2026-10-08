/**
 * The licence override migration's state (U-03), read by Platform → Override migration and by
 * each product's Licenses page (the notice callout). One key, one fetcher: both readers share
 * `fetchOverrideMigration` (test/queryKeyShapes.test.ts).
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { api, type OverrideMigrationResponse } from "../../api.js";
import { formatDate, fromSeconds } from "../../lib/format.js";
import { qk } from "./queries.js";

export function fetchOverrideMigration(): Promise<OverrideMigrationResponse> {
  return api.overrideMigration();
}

/** The migration's state and inventory. `enabled: false` reads nothing (not a platform admin). */
export function useOverrideMigration(
  enabled = true,
): UseQueryResult<OverrideMigrationResponse> {
  return useQuery({
    queryKey: qk.overrideMigration(),
    queryFn: fetchOverrideMigration,
    enabled,
  });
}

/** "5 Nov 2026" while the earliest run is ahead; `null` once it has passed (or is unknown). */
export function upcomingRunDate(
  runNotBefore: number | null,
  now: number = Date.now(),
): string | null {
  if (runNotBefore === null) return null;
  const at = fromSeconds(runNotBefore);
  return at > now ? formatDate(at) : null;
}
