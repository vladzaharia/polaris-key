/**
 * The console's authorization areas (ST-28 plan §2.1, built by ST-29).
 *
 * Every admin route declares exactly one area (`console/routes.ts`), and every registry setting
 * names one as its `rbacArea` (`core/settings/define.ts`). A role binding (ST-31) may narrow a
 * Product admin to a list of these ids, so an id is a stored value:
 *
 *   - **Append-only.** An id is never renamed, reused or removed. `test/rbacAreas.test.ts` pins
 *     this list to `test/fixtures/rbac-areas.json`, which only grows.
 *   - **Independent of the sidebar.** The console's nav groups (`nav.ts`) are never an input: a
 *     page that moves in the sidebar keeps its area.
 *   - **Moves are migrations.** A route that changes area fails `test/rbacRouteAreas.test.ts`
 *     unless `AREA_MOVES` below lists it (see that type).
 */

import type { ServiceSlug } from "../services.js";

/** One area: its stable id, the name the console shows, and the scope it is granted at. */
export interface AreaDef {
  id: string;
  /** The UI name (NoAccessPage, Members' role tags). */
  name: string;
  /**
   * `membership`: allowed to every member; `platform`: granted at platform scope; `product`:
   * granted per product; `both`: granted at either (Members).
   */
  scope: "membership" | "platform" | "product" | "both";
}

/** The thirteen areas, in the plan's order. Append only. */
export const AREAS = [
  { id: "console", name: "Console", scope: "membership" },
  { id: "platform", name: "Platform", scope: "platform" },
  { id: "members", name: "Members", scope: "both" },
  { id: "docs", name: "Docs", scope: "platform" },
  { id: "core", name: "Core", scope: "product" },
  { id: "license", name: "Licensing", scope: "product" },
  { id: "config", name: "Managed config", scope: "product" },
  { id: "ship", name: "Ship builds", scope: "product" },
  { id: "signin", name: "Sign-in", scope: "product" },
  { id: "sync", name: "Cloud Sync", scope: "product" },
  { id: "commerce", name: "Commerce", scope: "product" },
  { id: "keys", name: "Keys & secrets", scope: "product" },
  { id: "settings", name: "Settings", scope: "product" },
] as const satisfies readonly AreaDef[];

export type AreaId = (typeof AREAS)[number]["id"];

export const AREA_IDS: readonly AreaId[] = AREAS.map((a) => a.id);

/**
 * The ten areas a Product admin can hold on a product: the nine product areas and the product's
 * Members (`members` is granted at both scopes). A binding with no `areas` covers all ten.
 */
export const PRODUCT_AREAS: readonly AreaId[] = AREAS.filter(
  (a) => a.scope === "product" || a.scope === "both",
).map((a) => a.id);

export function isAreaId(value: unknown): value is AreaId {
  return (
    typeof value === "string" && (AREA_IDS as readonly string[]).includes(value)
  );
}

export function areaName(id: AreaId): string {
  return AREAS.find((a) => a.id === id)!.name;
}

/**
 * The area of each opt-in service's admin surface (`/products/:slug/<service>/**`) and the
 * default `rbacArea` of the settings it owns (§2.7). Release, Distribution and Update are one
 * area, Ship builds. `commerce` is not a service yet: CM-29 moves `distribution/commerce/**`
 * under its own prefix and keeps the area.
 */
export const SERVICE_AREA: Readonly<Record<ServiceSlug, AreaId>> = {
  license: "license",
  config: "config",
  release: "ship",
  distribution: "ship",
  update: "ship",
  identity: "signin",
  sync: "sync",
};

/**
 * A route that changed area. Without an entry here the area drift gate fails. Two kinds are
 * allowed (ST-28 plan §2.7):
 *
 *   - **into a new area** (one added to `AREAS` in the same change, as a split): `migration`
 *     names the file, by its suffix `_rbac_move_<n>.sql` (the lead numbers `00XX` at merge), that
 *     rewrites `console_role_bindings.areas_json` and the SSO rules' grants (ST-32) so holders of
 *     `from` also hold `to`. Because `to` covers only routes split out of `from`, it widens no one.
 *   - **into an existing area**: nothing is rewritten, so holders of `from` lose the route (a
 *     narrowing). The entry carries `narrows: true` and no migration, and needs the security
 *     reviewer's sign-off in the PR. Rewriting bindings into an existing area is refused: it would
 *     widen every holder of `from` to every route of `to`.
 */
export interface AreaMove {
  /** `METHOD /path`, as `test/fixtures/rbac-route-areas.json` keys it. */
  route: string;
  from: AreaId;
  to: AreaId;
  /** The rewrite migration's suffix, e.g. `_rbac_move_1.sql`. Only for a move into a new area. */
  migration?: string;
  /** A move into an existing area: a narrowing, signed off by the security reviewer. */
  narrows?: true;
}

export const AREA_MOVES: readonly AreaMove[] = [];
