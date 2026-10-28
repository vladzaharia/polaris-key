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
import {
  PRODUCT_PAGES,
  isPageEnabled,
  type GlobalPageId,
  type PageId,
  type ProductPageId,
  type ServiceState,
} from "../nav.js";
import { AREA_NAMES as NAMES } from "../../lib/areaNames.js";
import { parseLocation } from "../routes.js";

export type { AreaId };
export type Level = "view" | "edit";

/** The names the console shows (worker `AREAS`); the table lives in `lib/` so `errorCopy` can use it. */
export const AREA_NAMES: Record<AreaId, string> = NAMES;

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
  connect: "connect",
};

/** The area of every product page. */
const PRODUCT_PAGE_AREAS: Record<ProductPageId, AreaId> = {
  overview: "core",
  integration: "core",
  services: "core",
  devices: "core",
  users: "core",
  presentation: "core",
  portal: "core",
  activity: "core",
  settings: "core",
  "settings-members": "members",
  "settings-all": "core",
  keys: "keys",
  licenses: "license",
  tiers: "license",
  enrollment: "license",
  "license-batches": "license",
  "license-settings": "license",
  catalog: "config",
  "catalog-edit": "config",
  profiles: "config",
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
  "presentation-listing": "ship",
  "app-store": "ship",
  channel: "ship",
  access: "ship",
  "package-feeds": "ship",
  health: "ship",
  credentials: "keys",
  commerce: "commerce",
  "commerce-overview": "commerce",
  feed: "ship",
  "app-sign-in": "signin",
  "sync-setup": "sync",
  "sync-usage": "sync",
  "sync-data": "sync",
  "connect-setup": "connect",
  "connect-devices": "connect",
  "connect-usage": "connect",
};

/** The area of every global page: Home and the product list are every member's. */
const GLOBAL_PAGE_AREAS: Record<GlobalPageId, AreaId> = {
  home: "console",
  "api-tokens": "platform",
  // Every member's own tokens; the Everyone tab asks for `platform` itself.
  "personal-tokens": "console",
  "sign-in-methods": "console",
  "product-new": "platform",
  "platform-settings": "platform",
  // The Worker gates `/members` on the `members` area (Superadmin and Platform admin hold it).
  "platform-members": "members",
  "platform-status": "platform",
  "platform-stores": "platform",
  "platform-connections": "platform",
  "platform-feeds": "platform",
  "platform-activity": "platform",
};

export const PAGE_AREAS: Record<PageId, AreaId> = {
  ...PRODUCT_PAGE_AREAS,
  ...GLOBAL_PAGE_AREAS,
};

export function areaOfPage(page: PageId): AreaId {
  return PAGE_AREAS[page];
}

/**
 * True for the areas granted at platform scope (the rest are a product's). `members` is both: the
 * platform's own, and each product's (Product → Settings → Members, ST-31.14); see `scopeSlug`.
 */
export function isPlatformArea(area: AreaId): boolean {
  return (
    area === "console" ||
    area === "platform" ||
    area === "docs" ||
    area === "members"
  );
}

/** The product slug an area is asked in: `null` for the platform scope. */
export function scopeSlug(area: AreaId, slug: string | null): string | null {
  if (area === "members") return slug;
  return isPlatformArea(area) ? null : slug;
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
  const area = areaOfPage(page);
  return canIn(me, area, scopeSlug(area, slug));
}

/**
 * Where a product link should land for this member (B-016): its Overview when they can open it,
 * else the first page of the product they can (a member narrowed to Licensing lands on Licenses).
 * Falls back to Overview, whose own no-access page then says who can help.
 */
export function landingPage(
  me: Me | undefined,
  slug: string,
  services: ServiceState = null,
): ProductPageId {
  if (canOpenPage(me, "overview", slug)) return "overview";
  const first = PRODUCT_PAGES.find(
    (p) =>
      p.inNav &&
      isPageEnabled(p.page as ProductPageId, services) &&
      canOpenPage(me, p.page, slug),
  );
  return (first?.page as ProductPageId | undefined) ?? "overview";
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
    default:
      // A role this console does not know (a newer Worker): its id, never nothing.
      return {
        label: String((role as { role?: unknown }).role ?? ""),
        areas: null,
      };
  }
}

/** A list in prose: "A", "A and B", "A, B and C". */
export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
