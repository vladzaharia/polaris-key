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
  scopeSlug,
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
  return canIn(me, area, scopeSlug(area, slug), level);
}

/** Why an emergency sign-in cannot create a durable credential (ST-30c.2, N3). */
export const BREAK_GLASS_NO_TOKENS =
  "Emergency sign-in can't create tokens. Sign out, then sign in with your account to create one.";

/**
 * Set while the session is an emergency sign-in: the reason a mint action (a token, a trusted
 * publisher) is soft-disabled. The server refuses them anyway (`break_glass_session`).
 */
export function useBreakGlassReason(): string | undefined {
  return useCachedMe()?.breakGlass ? BREAK_GLASS_NO_TOKENS : undefined;
}

/** The session `/me` the shell already loaded, read from the cache without fetching it. */
export function useCachedMe(): Me | undefined {
  return useQuery({ queryKey: qk.me(), queryFn: fetchMe, enabled: false }).data;
}

/** The `scope` query value for an area in a product (or the platform). */
export function accessScope(area: AreaId, slug: string | null): string {
  return slug === null || (isPlatformArea(area) && area !== "members")
    ? "platform"
    : `product:${slug}`;
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
    // Platform access is given by Superadmins, never a product's admin (the server lists no
    // Platform admins either):
    // whatever a worker answers, a platform scope names none.
    select: (d) =>
      scope === "platform"
        ? { ...d, admins: d.admins.filter((a) => a.role !== "product_admin") }
        : d,
    enabled,
    staleTime: 60_000,
  });
}

/** "Ask Ana Lindqvist (ana@example.com) or Ben Ode for Licensing access." */
export function askReason(
  area: AreaId,
  admins: readonly AccessAdmin[] | undefined,
  hasView = false,
  /** What the page calls the access, when the area's own name is not a word its reader knows. */
  name: string = AREA_NAMES[area],
): string {
  const what = hasView ? `${name} edit access` : `${name} access`;
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
  name?: string,
): { allowed: boolean; disabledReason: string | undefined; canView: boolean } {
  const allowed = useCan(area, slug, "edit");
  const canView = useCan(area, slug, "view");
  const admins = useAccessAdmins(area, slug, !allowed);
  return {
    allowed,
    canView,
    disabledReason: allowed
      ? undefined
      : askReason(area, admins.data?.admins, canView, name),
  };
}
