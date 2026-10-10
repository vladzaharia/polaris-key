/**
 * `useCan` and the "who can help" hooks (ST-29). They read `/me.permissions` and
 * `GET /access/admins`; they decide nothing the worker does not (see `./can.ts`).
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  api,
  type AccessAdmin,
  type AccessAdmins,
  type Me,
} from "../../api.js";
import { fetchMe } from "../data/hooks.js";
import { qk } from "../data/queries.js";
import {
  AREA_NAMES,
  canIn,
  isPlatformArea,
  listOf,
  type AreaId,
  type Level,
} from "./can.js";

/** May the signed-in member act on `area` (in the product `slug`, else at platform scope)? */
export function useCan(
  area: AreaId,
  slug: string | null = null,
  level: Level = "view",
): boolean {
  const me = useCachedMe();
  // Outside the shell (a page rendered alone) there is no session to read: show the control.
  // The shell renders nothing before `/me` arrives, and the worker refuses what it must anyway.
  if (!me) return true;
  return canIn(me, area, isPlatformArea(area) ? null : slug, level);
}

/** The session `/me` the shell already loaded, read from the cache without fetching it. */
function useCachedMe(): Me | undefined {
  return useQuery({ queryKey: qk.me(), queryFn: fetchMe, enabled: false }).data;
}

/** The `scope` query value for an area in a product (or the platform). */
export function accessScope(area: AreaId, slug: string | null): string {
  return slug === null || isPlatformArea(area) ? "platform" : `product:${slug}`;
}

/** Up to three people who can give access to `area` there, narrowest first. */
export function useAccessAdmins(
  area: AreaId,
  slug: string | null,
  enabled = true,
): UseQueryResult<AccessAdmins> {
  const scope = accessScope(area, slug);
  return useQuery({
    queryKey: qk.accessAdmins(scope, area),
    queryFn: () => api.accessAdmins(scope, area),
    enabled,
    staleTime: 60_000,
  });
}

/** "Ask Ana Lindqvist (ana@example.com) or Ben Ode for Licensing access." */
export function askReason(
  area: AreaId,
  admins: readonly AccessAdmin[] | undefined,
): string {
  const what = `${AREA_NAMES[area]} access`;
  if (!admins?.length)
    return `You don't have ${what}. A Superadmin can give it to you.`;
  const [first, ...rest] = admins;
  const names = [
    `${first!.name} (${first!.email})`,
    ...rest.map((a) => a.name),
  ];
  return `Ask ${listOf(names).replace(/ and ([^,]+)$/, " or $1")} for ${what}.`;
}

/**
 * The gate a write control reads: `disabledReason` is set when the member lacks `area` at the
 * edit level, and names the same people NoAccessPage lists (fetched only then).
 */
export function useWriteGate(
  area: AreaId,
  slug: string | null = null,
): { allowed: boolean; disabledReason: string | undefined } {
  const allowed = useCan(area, slug, "edit");
  const admins = useAccessAdmins(area, slug, !allowed);
  return {
    allowed,
    disabledReason: allowed ? undefined : askReason(area, admins.data?.admins),
  };
}
