/**
 * The console's ROUTE LEDGER (ST-49, BRAND-TRANSITION.md B16): one map of every 0.9 page address to
 * where it lives in 1.0. It feeds the router's Page moved entries (`routes.ts`) and the generated
 * table in docs/design/ADMIN.md §2.8 (`pnpm gen route-ledger`).
 *
 * The 0.9 line has removals, not aliases: a page that is gone does not redirect and keeps no alias.
 * Its old address opens a Page moved page that names the new home and links to it. A row is one of:
 *
 * - `live`: the page keeps its id and its address. `nav.ts` must still say so (routeLedger test).
 * - `moved`: the address is gone; `to` is the page that took over its job.
 * - `deleted`: the page is deleted with no successor, by package `by`. While the page is still in
 *   `nav.ts` it stays live; once it leaves, its address reads "deleted" and nothing else.
 *
 * The rows are the page ids of `nav.ts` at v0.9.9 (52) plus the product tabs that preceded them. A
 * page id that leaves `nav.ts` without a row here fails `test/routeLedger.test.ts`; a new 1.0 page
 * needs no row, because it has no 0.9 address to answer for.
 *
 * Imports are types only: the generator and the router both read this module.
 */

import type { PageId } from "./nav.js";

export type LedgerScope = "product" | "global";
export type LedgerFate = "live" | "moved" | "deleted";

export interface LedgerRow {
  /** The 0.9 page id, or `tab:<name>` for a product tab older than the page ids. */
  id: string;
  /** Under `#/p/<slug>/` (a product page) or at the root of the hash (a global one). */
  scope: LedgerScope;
  /** The 0.9 path below that root; empty is the root page. */
  from: string;
  fate: LedgerFate;
  /** The page that took over (`moved` only). A record id in the old address follows it. */
  to?: PageId;
  /** The package that moved or deleted the page (the 'deleted (U-27)' of the table). */
  by?: string;
}

export const ROUTE_LEDGER: readonly LedgerRow[] = [
  { id: "overview", scope: "product", from: "", fate: "live" },
  { id: "integration", scope: "product", from: "integration", fate: "live" },
  { id: "services", scope: "product", from: "settings/features", fate: "live" },
  { id: "devices", scope: "product", from: "devices", fate: "live" },
  { id: "users", scope: "product", from: "users", fate: "live" },
  {
    id: "presentation",
    scope: "product",
    from: "settings/presentation",
    fate: "live",
  },
  {
    id: "presentation-listing",
    scope: "product",
    from: "settings/presentation/listing",
    fate: "live",
  },
  { id: "keys", scope: "product", from: "settings/keys", fate: "live" },
  { id: "activity", scope: "product", from: "activity", fate: "live" },
  { id: "settings", scope: "product", from: "settings", fate: "live" },
  {
    id: "settings-members",
    scope: "product",
    from: "settings/members",
    fate: "live",
  },
  { id: "settings-all", scope: "product", from: "settings/all", fate: "live" },
  { id: "licenses", scope: "product", from: "license/licenses", fate: "live" },
  { id: "tiers", scope: "product", from: "license/tiers", fate: "live" },
  {
    id: "enrollment",
    scope: "product",
    from: "license/enrollment",
    fate: "live",
  },
  {
    id: "license-batches",
    scope: "product",
    from: "license/batches",
    fate: "live",
  },
  {
    id: "license-settings",
    scope: "product",
    from: "license/settings",
    fate: "live",
  },
  { id: "catalog", scope: "product", from: "config/catalog", fate: "live" },
  {
    id: "catalog-edit",
    scope: "product",
    from: "config/catalog/edit",
    fate: "live",
  },
  { id: "profiles", scope: "product", from: "config/profiles", fate: "live" },
  { id: "releases", scope: "product", from: "release/releases", fate: "live" },
  { id: "channels", scope: "product", from: "release/channels", fate: "live" },
  {
    id: "deliverables",
    scope: "product",
    from: "release/deliverables",
    fate: "live",
  },
  {
    id: "compatibility",
    scope: "product",
    from: "release/compatibility",
    fate: "live",
  },
  {
    id: "simulator",
    scope: "product",
    from: "release/compatibility/simulator",
    fate: "live",
  },
  {
    id: "content-keys",
    scope: "product",
    from: "release/content-keys",
    fate: "live",
  },
  { id: "matrix", scope: "product", from: "distribution/matrix", fate: "live" },
  {
    id: "rollouts",
    scope: "product",
    from: "distribution/rollouts",
    fate: "live",
  },
  {
    id: "outlets",
    scope: "product",
    from: "distribution/outlets",
    fate: "live",
  },
  {
    id: "storefronts",
    scope: "product",
    from: "distribution/storefronts",
    fate: "live",
  },
  {
    id: "listing",
    scope: "product",
    from: "distribution/listing",
    fate: "moved",
    to: "presentation-listing",
    by: "A-27",
  },
  {
    id: "app-store",
    scope: "product",
    from: "distribution/app-store",
    fate: "live",
  },
  {
    id: "channel",
    scope: "product",
    from: "distribution/channels",
    fate: "live",
  },
  { id: "access", scope: "product", from: "distribution/access", fate: "live" },
  {
    id: "package-feeds",
    scope: "product",
    from: "distribution/feeds",
    fate: "live",
  },
  { id: "health", scope: "product", from: "distribution/health", fate: "live" },
  {
    id: "credentials",
    scope: "product",
    from: "distribution/credentials",
    fate: "live",
  },
  { id: "feed", scope: "product", from: "update/feed", fate: "live" },
  {
    id: "portal",
    scope: "product",
    from: "identity/portal",
    fate: "moved",
    to: "app-sign-in",
    by: "I-29",
  },
  {
    id: "sign-in",
    scope: "product",
    from: "identity/sign-in",
    fate: "moved",
    to: "app-sign-in",
    by: "I-29",
  },
  { id: "sync-data", scope: "product", from: "sync/data", fate: "live" },
  {
    id: "connect-setup",
    scope: "product",
    from: "connect/setup",
    fate: "live",
  },
  {
    id: "connect-devices",
    scope: "product",
    from: "connect/devices",
    fate: "live",
  },
  {
    id: "connect-usage",
    scope: "product",
    from: "connect/usage",
    fate: "live",
  },
  { id: "commerce-overview", scope: "product", from: "commerce", fate: "live" },
  {
    id: "commerce",
    scope: "product",
    from: "commerce/in-app-purchases",
    fate: "live",
  },
  {
    id: "platform-settings",
    scope: "global",
    from: "platform/settings",
    fate: "live",
  },
  {
    id: "platform-deployment",
    scope: "global",
    from: "platform/deployment",
    fate: "moved",
    to: "platform-status",
    by: "CX-PSTAT",
  },
  {
    id: "platform-operations",
    scope: "global",
    from: "platform/operations",
    fate: "moved",
    to: "platform-status",
    by: "CX-PSTAT",
  },
  {
    id: "platform-stores",
    scope: "global",
    from: "platform/store-connections",
    fate: "live",
  },
  {
    id: "platform-feeds",
    scope: "global",
    from: "platform/feeds",
    fate: "live",
  },
  {
    id: "platform-activity",
    scope: "global",
    from: "platform/activity",
    fate: "live",
  },
  {
    id: "platform-members",
    scope: "global",
    from: "platform/members",
    fate: "live",
  },
  {
    id: "platform-override-migration",
    scope: "global",
    from: "platform/override-migration",
    fate: "deleted",
    by: "U-27",
  },
  { id: "home", scope: "global", from: "", fate: "live" },
  {
    id: "products",
    scope: "global",
    from: "products",
    fate: "moved",
    to: "home",
    by: "ST-44",
  },
  { id: "product-new", scope: "global", from: "products/new", fate: "live" },
  { id: "api-tokens", scope: "global", from: "tokens", fate: "live" },
  {
    id: "personal-tokens",
    scope: "global",
    from: "personal-tokens",
    fate: "live",
  },

  {
    id: "sign-in-methods",
    scope: "global",
    from: "account/sign-in-methods",
    fate: "live",
  },

  // Pre-0.9 product tabs (the redesign before SH-1): a hash that never matched a page since.
  {
    id: "tab:overview",
    scope: "product",
    from: "overview",
    fate: "moved",
    to: "overview",
    by: "P0-31",
  },
  {
    id: "tab:services",
    scope: "product",
    from: "services",
    fate: "moved",
    to: "services",
    by: "P0-31",
  },
  {
    id: "tab:presentation",
    scope: "product",
    from: "presentation",
    fate: "moved",
    to: "presentation",
    by: "P0-31",
  },
  {
    id: "tab:keys",
    scope: "product",
    from: "keys",
    fate: "moved",
    to: "keys",
    by: "P0-31",
  },
  {
    id: "tab:secrets",
    scope: "product",
    from: "secrets",
    fate: "moved",
    to: "keys",
    by: "P0-31",
  },
  {
    id: "tab:licenses",
    scope: "product",
    from: "licenses",
    fate: "moved",
    to: "licenses",
    by: "P0-31",
  },
  {
    id: "tab:tiers",
    scope: "product",
    from: "tiers",
    fate: "moved",
    to: "tiers",
    by: "P0-31",
  },
  {
    id: "tab:fingerprints",
    scope: "product",
    from: "fingerprints",
    fate: "moved",
    to: "enrollment",
    by: "P0-31",
  },
  {
    id: "tab:profiles",
    scope: "product",
    from: "profiles",
    fate: "moved",
    to: "profiles",
    by: "P0-31",
  },
  {
    id: "tab:releases",
    scope: "product",
    from: "releases",
    fate: "moved",
    to: "releases",
    by: "P0-31",
  },
  {
    id: "tab:deliverables",
    scope: "product",
    from: "deliverables",
    fate: "moved",
    to: "deliverables",
    by: "P0-31",
  },
  {
    id: "tab:compatibility",
    scope: "product",
    from: "compatibility",
    fate: "moved",
    to: "compatibility",
    by: "P0-31",
  },
  {
    id: "tab:distribution-matrix",
    scope: "product",
    from: "distribution-matrix",
    fate: "moved",
    to: "matrix",
    by: "P0-31",
  },
  {
    id: "tab:distribution-health",
    scope: "product",
    from: "distribution-health",
    fate: "moved",
    to: "health",
    by: "P0-31",
  },
  {
    id: "tab:updates",
    scope: "product",
    from: "updates",
    fate: "moved",
    to: "feed",
    by: "P0-31",
  },
];

/** Where an old address now lives: a page and, for a collection page, the record id it named. */
export interface MovedTo {
  /** Absent when the page is deleted and has no successor. */
  page?: PageId;
  scope: LedgerScope;
  id?: string;
  /** The old address's path below its scope root, for the page's own words. */
  from: string;
  /** The package that moved or deleted it. */
  by?: string;
}

const segs = (path: string): string[] => (path === "" ? [] : path.split("/"));

/**
 * The ledger row a path answers to, when the path is a removed page's address (or, for a page with
 * records, the address plus a record id). `hasRecord` says whether the destination page lists
 * records. A `live` row never matches: the router has already resolved those from `nav.ts`.
 */
export function ledgerLookup(
  scope: LedgerScope,
  path: string[],
  hasRecord: (page: PageId) => boolean,
): MovedTo | undefined {
  for (const row of ROUTE_LEDGER) {
    if (row.scope !== scope || row.fate === "live") continue;
    const from = segs(row.from);
    if (from.length === 0) {
      // The root page's old address is never a removed page: nothing hangs off an empty path.
      continue;
    }
    if (!from.every((s, i) => path[i] === s)) continue;
    const base = { scope, from: row.from, ...(row.by ? { by: row.by } : {}) };
    const to = row.fate === "moved" ? row.to : undefined;
    if (path.length === from.length)
      return { ...base, ...(to ? { page: to } : {}) };
    if (to && path.length === from.length + 1 && hasRecord(to)) {
      return { ...base, page: to, id: path[from.length]! };
    }
  }
  return undefined;
}
