// ST-49: the route ledger (routeLedger.ts) against nav.ts and the router. Every 0.9 address in the
// ledger is live content or a Page moved page; no page id leaves nav.ts without a row.

import { describe, expect, it } from "vitest";
import {
  GLOBAL_PAGES,
  PRODUCT_PAGES,
  pageOf,
  type PageId,
} from "../src/console/nav.js";
import { ROUTE_LEDGER, ledgerLookup } from "../src/console/routeLedger.js";
import { movedHref, parseLocation } from "../src/console/routes.js";

/** The page ids of nav.ts at v0.9.9: the 0.9 inventory every row answers for. */
const V099_PAGE_IDS = [
  "access", "activity", "api-tokens", "app-store", "catalog", "catalog-edit", "channels",
  "commerce", "commerce-overview", "compatibility", "content-keys", "credentials",
  "deliverables", "devices", "enrollment", "feed", "health", "home", "integration", "keys",
  "license-batches", "license-settings", "licenses", "listing", "matrix", "outlets", "overview",
  "package-feeds", "personal-tokens", "platform-deployment", "platform-feeds",
  "platform-operations", "platform-override-migration", "platform-settings", "platform-stores",
  "portal", "presentation", "product-new", "products", "profiles", "releases", "rollouts",
  "services", "settings", "settings-all", "settings-members", "sign-in", "simulator",
  "storefronts", "sync-data", "tiers", "users",
]; // prettier-ignore

/** Pages added after v0.9.9: each has a live row, so a later move or removal has its answer. */
const ADDED_PAGE_IDS = [
  "platform-activity",
  "presentation-listing",
  "platform-members",
  "sign-in-methods",
  "connect-setup",
  "connect-devices",
  "connect-usage",
  "channel",
]; // ST-51, A-27.11, ST-31.11, ST-30c.4, CC-02.3, A-22.1

const inNav = (id: string): boolean =>
  [...GLOBAL_PAGES, ...PRODUCT_PAGES].some((p) => p.page === id);
const hash = (scope: string, from: string, rest = ""): string =>
  (scope === "product" ? "#/p/djdl/" : "#/") + from + rest;

describe("ROUTE_LEDGER", () => {
  it("has one row for every 0.9 page id and every page added since, and no other page id", () => {
    const ids = ROUTE_LEDGER.filter((r) => !r.id.startsWith("tab:")).map(
      (r) => r.id,
    );
    expect([...ids].sort()).toEqual(
      [...V099_PAGE_IDS, ...ADDED_PAGE_IDS].sort(),
    );
    expect(new Set(ROUTE_LEDGER.map((r) => r.id)).size).toBe(
      ROUTE_LEDGER.length,
    );
  });

  it("a live row is a page nav.ts still has, at the address it had; a page that left needs a moved or deleted row", () => {
    for (const row of ROUTE_LEDGER.filter((r) => r.fate === "live")) {
      expect(
        inNav(row.id),
        `${row.id} left nav.ts: make its row moved or deleted`,
      ).toBe(true);
      expect(pageOf(row.id as PageId).path, row.id).toBe(row.from);
    }
  });

  it("every 0.9 address is live content or a Page moved page, never a redirect", () => {
    for (const row of ROUTE_LEDGER) {
      const parsed = parseLocation(hash(row.scope, row.from));
      expect(parsed.redirect, row.id).toBeUndefined();
      const { route } = parsed;
      const stillThere =
        row.fate === "live" || (row.fate === "deleted" && inNav(row.id));
      if (stillThere) {
        expect(route.kind, row.id).toBe(
          row.scope === "product" ? "product" : "global",
        );
        if (route.kind !== "not-found") expect(route.page, row.id).toBe(row.id);
        continue;
      }
      expect(route.kind, row.id).toBe("not-found");
      if (route.kind !== "not-found") continue;
      expect(route.moved, row.id).toBeDefined();
      expect(route.moved!.page, row.id).toBe(
        row.fate === "moved" ? row.to : undefined,
      );
      if (row.fate === "moved") {
        // The new address is a page, not another not-found.
        const href = movedHref("djdl", route.moved!, route.query)!;
        expect(parseLocation(href).route.kind, `${row.id} -> ${href}`).not.toBe(
          "not-found",
        );
      }
    }
  });

  it("a moved row names a page that exists; a deleted row names its package", () => {
    for (const row of ROUTE_LEDGER) {
      if (row.fate === "moved") {
        expect(inNav(row.to!), row.id).toBe(true);
        expect(row.by, row.id).toBeTruthy();
      }
      if (row.fate === "deleted") {
        expect(row.to, row.id).toBeUndefined();
        expect(row.by, row.id).toMatch(/^[A-Z]+-\d+/);
      }
    }
  });

  it("the deleted override-migration page reads 'deleted (U-27)'", () => {
    const row = ROUTE_LEDGER.find(
      (r) => r.id === "platform-override-migration",
    );
    expect(row).toMatchObject({ fate: "deleted", by: "U-27" });
    // Removed from nav, its address would open a Page moved page with no successor.
    expect(
      ledgerLookup("global", ["platform", "override-migration"], () => false),
    ).toEqual({
      scope: "global",
      from: "platform/override-migration",
      by: "U-27",
    });
  });

  it("a record id follows a moved page that lists records, and only then", () => {
    const record = (p: PageId): boolean => !!pageOf(p).record;
    expect(
      ledgerLookup("product", ["licenses", "lic_1"], record),
    ).toMatchObject({
      page: "licenses",
      id: "lic_1",
    });
    expect(ledgerLookup("product", ["secrets", "x"], record)).toBeUndefined();
    expect(
      ledgerLookup("product", ["identity", "portal", "x"], record),
    ).toBeUndefined();
    expect(ledgerLookup("product", ["nope"], record)).toBeUndefined();
  });
});
