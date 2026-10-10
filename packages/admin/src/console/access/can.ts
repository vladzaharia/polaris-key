/**
 * The console's view of authorization (ST-29). The worker decides: every `/manage/api` route is a
 * row of its route table and checks `can()` before any handler runs. The console only reads the
 * answer `/me.permissions` carries, to hide what the member cannot open and to say who can help.
 * Nothing here is a control: a page this file hides still answers 403 if reached.
 *
 * `PAGE_AREAS` names the area each console page belongs to. It mirrors the worker's routes (a
 * page reads the routes of its area), and `test/access.test.tsx` pins every page to one.
 */

import type { AreaId, Me, MeRole } from "../../api.js";
import type { GlobalPageId, PageId, ProductPageId } from "../nav.js";
import { parseLocation } from "../routes.js";

export type { AreaId };
export type Level = "view" | "edit";

/** The names the console shows (worker `AREAS`). */
export const AREA_NAMES: Record<AreaId, string> = {
  console: "Console",
  platform: "Platform",
  members: "Members",
  docs: "Docs",
  core: "Core",
  license: "Licensing",
  config: "Managed config",
  ship: "Ship builds",
  signin: "Sign-in",
  sync: "Cloud Sync",
  commerce: "Commerce",
  keys: "Keys & secrets",
  settings: "Settings",
};

/** The `data-service` accent of an area's pages (B17), for the icon and the destination buttons. */
export const AREA_ACCENTS: Partial<Record<AreaId, string>> = {
  core: "core",
  license: "license",
  config: "config",
  ship: "release",
  signin: "identity",
  sync: "sync",
  commerce: "commerce",
  keys: "core",
  settings: "core",
};

/** The area of every product page. */
const PRODUCT_PAGE_AREAS: Record<ProductPageId, AreaId> = {
  overview: "core",
  services: "core",
  devices: "core",
  users: "core",
  presentation: "core",
  activity: "core",
  settings: "core",
  keys: "keys",
  licenses: "license",
  tiers: "license",
  enrollment: "license",
  "license-batches": "license",
  "license-settings": "license",
  catalog: "config",
  "catalog-edit": "config",
  profiles: "config",
  "edge-mint": "config",
  releases: "ship",
  channels: "ship",
  deliverables: "ship",
  compatibility: "ship",
  simulator: "ship",
  "content-keys": "ship",
  matrix: "ship",
  rollouts: "ship",
  outlets: "ship",
  storefronts: "ship",
  listing: "ship",
  "app-store": "ship",
  access: "ship",
  "package-feeds": "ship",
  health: "ship",
  credentials: "keys",
  commerce: "commerce",
  feed: "ship",
  portal: "signin",
  "sign-in": "signin",
  "sync-data": "sync",
};

/** The area of every global page: Home and the product list are every member's. */
const GLOBAL_PAGE_AREAS: Record<GlobalPageId, AreaId> = {
  home: "console",
  products: "console",
  "product-new": "platform",
  "platform-settings": "platform",
  "platform-deployment": "platform",
  "platform-operations": "platform",
  "platform-stores": "platform",
  "platform-feeds": "platform",
  "platform-override-migration": "platform",
};

export const PAGE_AREAS: Record<PageId, AreaId> = {
  ...PRODUCT_PAGE_AREAS,
  ...GLOBAL_PAGE_AREAS,
};

export function areaOfPage(page: PageId): AreaId {
  return PAGE_AREAS[page];
}

/** True for the areas granted at platform scope (the rest are a product's). */
export function isPlatformArea(area: AreaId): boolean {
  return (
    area === "console" ||
    area === "platform" ||
    area === "docs" ||
    area === "members"
  );
}

/**
 * What `can()` answered for this member: `area` in the product `slug`, or at platform scope when
 * `slug` is null. A worker older than ST-29 sends no `permissions`: a platform admin then holds
 * every area, as it always did, and anyone else only the console.
 */
export function canIn(
  me: Me | undefined,
  area: AreaId,
  slug: string | null = null,
  level: Level = "view",
): boolean {
  if (!me) return false;
  const perms = me.permissions;
  if (!perms) return me.platformAdmin || area === "console";
  const levels = slug === null ? perms.platform : perms.products[slug];
  return levels?.[level].includes(area) ?? false;
}

/** Can the member open this page (in this product)? */
export function canOpenPage(
  me: Me | undefined,
  page: PageId,
  slug: string | null,
): boolean {
  // A member with no product and no Platform area has nothing to list: Home is the only page.
  if (page === "products")
    return canIn(me, "platform") || (me?.products.length ?? 0) > 0;
  const area = areaOfPage(page);
  return canIn(me, area, isPlatformArea(area) ? null : slug);
}

/** Can the member open what this console href names? Anything that is not a page passes. */
export function canOpenHref(me: Me | undefined, href: string): boolean {
  const hash = href.slice(href.indexOf("#"));
  if (!hash.startsWith("#")) return true;
  const { route } = parseLocation(hash);
  if (route.kind === "product") return canOpenPage(me, route.page, route.slug);
  if (route.kind === "global") return canOpenPage(me, route.page, null);
  return true;
}

/** The product slug a role names, or `null` for a platform or All-products role. */
function roleProduct(role: MeRole): string | null {
  return role.scope.startsWith("product:")
    ? role.scope.slice("product:".length)
    : null;
}

/**
 * A role as the console names it (Members' role tag): "Superadmin", "Platform admin",
 * "Diceroll admin", "All products admin", "Console access". `areas` is set for a narrowed one.
 */
export function roleLabel(
  role: MeRole,
  productName: (slug: string) => string,
): { label: string; areas: AreaId[] | null } {
  switch (role.role) {
    case "superadmin":
      return { label: "Superadmin", areas: null };
    case "platform_admin":
      return { label: "Platform admin", areas: null };
    case "console_access":
      return { label: "Console access", areas: null };
    case "product_admin": {
      const slug = roleProduct(role);
      return {
        label:
          slug === null ? "All products admin" : `${productName(slug)} admin`,
        areas: role.areas,
      };
    }
  }
}

/** A list in prose: "A", "A and B", "A, B and C". */
export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
