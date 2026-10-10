/**
 * `can()` (ST-29; ST-28 plan §2.2): deny by default, six rules, roles summed. Each case is written
 * out by hand; nothing here derives an expectation from `can()` itself.
 */

import { describe, expect, it } from "vitest";
import {
  can,
  isSuperadmin,
  PLATFORM,
  type Grant,
  type Principal,
  type Scope,
} from "../src/core/rbac/can.js";
import { AREA_IDS, PRODUCT_AREAS } from "../src/core/rbac/areas.js";
import {
  holdsRoot,
  resolvePrincipal,
  ROOT_GRANT,
} from "../src/core/rbac/principal.js";
import { PRINCIPALS } from "./rbacFixtures.js";

const alpha: Scope = { kind: "product", slug: "alpha", system: false };
const beta: Scope = { kind: "product", slug: "beta", system: false };
const system: Scope = { kind: "product", slug: "polaris-key", system: true };

const p = (...grants: Grant[]): Principal => ({ memberId: "m", grants });

describe("can(): the rules", () => {
  it("1. denies a null or absent principal everything", () => {
    for (const area of AREA_IDS) {
      expect(can(null, PLATFORM, area, "view")).toBe(false);
      expect(can(undefined, alpha, area, "edit")).toBe(false);
    }
  });

  it("2. allows `console` to any member, and to no one with no grant", () => {
    expect(can(p(), PLATFORM, "console", "view")).toBe(false);
    for (const principal of [
      PRINCIPALS.consoleOnly,
      PRINCIPALS.alphaAdmin,
      PRINCIPALS.alphaShip,
      PRINCIPALS.allProducts,
      PRINCIPALS.platformAdmin,
      PRINCIPALS.root,
    ])
      expect(can(principal, PLATFORM, "console", "view")).toBe(true);
  });

  it("3. allows a Superadmin everything, at every scope, the system product included", () => {
    for (const scope of [PLATFORM, alpha, system])
      for (const area of AREA_IDS)
        for (const level of ["view", "edit"] as const)
          expect(can(PRINCIPALS.root, scope, area, level)).toBe(true);
  });

  it("4. evaluates the system product as the platform", () => {
    // Platform admin reaches every area of the system product; product grants never do.
    for (const area of PRODUCT_AREAS) {
      expect(can(PRINCIPALS.platformAdmin, system, area, "edit"), area).toBe(
        true,
      );
      expect(can(PRINCIPALS.allProducts, system, area, "view"), area).toBe(
        false,
      );
      expect(
        can(
          p({
            role: "product_admin",
            scope: "product:polaris-key",
            areas: null,
            source: "grant",
          }),
          system,
          area,
          "view",
        ),
        area,
      ).toBe(false);
    }
  });

  it("5. allows a Platform admin `platform`, `members` and `docs` at platform scope, and nothing of a product", () => {
    const pa = PRINCIPALS.platformAdmin;
    expect(can(pa, PLATFORM, "platform", "edit")).toBe(true);
    expect(can(pa, PLATFORM, "members", "edit")).toBe(true);
    expect(can(pa, PLATFORM, "docs", "view")).toBe(true);
    for (const area of PRODUCT_AREAS)
      expect(can(pa, alpha, area, "view"), area).toBe(false);
    // A product area named at platform scope is no grant.
    expect(can(pa, PLATFORM, "license", "view")).toBe(false);
  });

  it("6. allows a Product admin the bound areas of the bound product, else all ten", () => {
    const all = PRINCIPALS.alphaAdmin;
    const narrow = PRINCIPALS.alphaShip;
    expect(PRODUCT_AREAS).toHaveLength(10);
    for (const area of PRODUCT_AREAS) {
      expect(can(all, alpha, area, "edit"), area).toBe(true);
      expect(can(all, beta, area, "view"), area).toBe(false);
      expect(can(narrow, alpha, area, "edit"), area).toBe(
        area === "ship" || area === "commerce",
      );
      expect(can(PRINCIPALS.allProducts, beta, area, "edit"), area).toBe(true);
    }
    // A product grant never reaches platform scope.
    for (const area of ["platform", "members", "docs"] as const) {
      expect(can(all, PLATFORM, area, "view"), area).toBe(false);
      expect(can(PRINCIPALS.allProducts, PLATFORM, area, "view"), area).toBe(
        false,
      );
    }
  });

  it("denies Console access every area but `console`", () => {
    for (const area of AREA_IDS.filter((a) => a !== "console")) {
      expect(can(PRINCIPALS.consoleOnly, PLATFORM, area, "view"), area).toBe(
        false,
      );
      expect(can(PRINCIPALS.consoleOnly, alpha, area, "view"), area).toBe(
        false,
      );
    }
  });

  it("sums roles: no grant takes away what another gives", () => {
    const both = p(
      {
        role: "product_admin",
        scope: "product:alpha",
        areas: ["ship"],
        source: "grant",
      },
      {
        role: "product_admin",
        scope: "product:alpha",
        areas: ["license"],
        source: "rule",
      },
      {
        role: "platform_admin",
        scope: "platform",
        areas: null,
        source: "grant",
      },
    );
    expect(can(both, alpha, "ship", "edit")).toBe(true);
    expect(can(both, alpha, "license", "edit")).toBe(true);
    expect(can(both, alpha, "keys", "edit")).toBe(false);
    expect(can(both, PLATFORM, "platform", "edit")).toBe(true);
  });

  it("does not let a Superadmin role at a product scope act as one", () => {
    const odd = p({
      role: "superadmin",
      scope: "product:alpha",
      areas: null,
      source: "grant",
    });
    expect(isSuperadmin(odd)).toBe(false);
    expect(can(odd, PLATFORM, "platform", "view")).toBe(false);
  });
});

describe("resolvePrincipal: the root rule", () => {
  const env = { PLATFORM_ADMIN_GROUP: "admins" };

  it("grants Superadmin to a subject in the platform group, and nothing to anyone else", async () => {
    const root = await resolvePrincipal(
      env,
      null,
      { sub: "op", groups: ["staff", "admins"] },
      0,
    );
    expect(root).toEqual({ memberId: "op", grants: [ROOT_GRANT] });
    expect(ROOT_GRANT).toEqual({
      role: "superadmin",
      scope: "platform",
      areas: null,
      source: "root",
    });
    const other = await resolvePrincipal(
      env,
      null,
      { sub: "u", groups: ["staff"] },
      0,
    );
    expect(other).toEqual({ memberId: "u", grants: [] });
  });

  it("roots no one when the group is unset or empty (fail closed)", () => {
    expect(holdsRoot({}, ["admins"])).toBe(false);
    expect(holdsRoot({ PLATFORM_ADMIN_GROUP: "" }, [""])).toBe(false);
  });
});
