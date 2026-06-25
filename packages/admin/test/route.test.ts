import { describe, expect, it } from "vitest";
import { hashFor, parseRoute, tabOf, TABS, type Route } from "../src/route.js";

// Hash routing is the only navigation layer (no router dep). These pin the parse/serialize
// round-trip + the precedence rules so deep links and the product switcher stay in sync.

describe("parseRoute", () => {
  it("empty hash defaults to the dashboard", () => {
    expect(parseRoute("")).toEqual({ kind: "dashboard" });
    expect(parseRoute("#/")).toEqual({ kind: "dashboard" });
  });

  it("#/products parses to the products registry", () => {
    expect(parseRoute("#/products")).toEqual({ kind: "products" });
  });

  it("a product root defaults to the overview view", () => {
    expect(parseRoute("#/p/djdl")).toEqual({
      kind: "product",
      slug: "djdl",
      view: "overview",
    });
  });

  it("each known tab parses through", () => {
    for (const { tab } of TABS) {
      expect(parseRoute(`#/p/djdl/${tab}`)).toEqual({
        kind: "product",
        slug: "djdl",
        view: tab,
      });
    }
  });

  it("a license detail carries the id", () => {
    expect(parseRoute("#/p/djdl/license/lic_42")).toEqual({
      kind: "product",
      slug: "djdl",
      view: "license",
      id: "lic_42",
    });
  });

  it("an unknown view falls back to licenses", () => {
    expect(parseRoute("#/p/djdl/bogus")).toEqual({
      kind: "product",
      slug: "djdl",
      view: "licenses",
    });
  });

  it("legacy product views route to the new workspace tabs", () => {
    expect(parseRoute("#/p/djdl/catalog")).toEqual({
      kind: "product",
      slug: "djdl",
      view: "config",
    });
    expect(parseRoute("#/p/djdl/oidc")).toEqual({
      kind: "product",
      slug: "djdl",
      view: "identity",
    });
  });

  it("decodes a URL-encoded slug and id (encoded slashes survive)", () => {
    expect(parseRoute("#/p/my%20product/license/id%2Fwith%2Fslashes")).toEqual({
      kind: "product",
      slug: "my product",
      view: "license",
      id: "id/with/slashes",
    });
  });

  it("a garbage hash falls back to the dashboard", () => {
    expect(parseRoute("#nonsense")).toEqual({ kind: "dashboard" });
  });
});

describe("hashFor", () => {
  it("serializes the dashboard + products routes", () => {
    expect(hashFor({ kind: "dashboard" })).toBe("#/");
    expect(hashFor({ kind: "products" })).toBe("#/products");
  });

  it("serializes a tab route", () => {
    expect(hashFor({ kind: "product", slug: "djdl", view: "config" })).toBe(
      "#/p/djdl/config",
    );
  });

  it("serializes a license-detail route with its id", () => {
    expect(
      hashFor({ kind: "product", slug: "djdl", view: "license", id: "lic_1" }),
    ).toBe("#/p/djdl/license/lic_1");
  });

  it("a license view without an id degrades to the slug root", () => {
    expect(hashFor({ kind: "product", slug: "djdl", view: "license" })).toBe(
      "#/p/djdl/license",
    );
  });

  it("encodes slugs + ids with special characters", () => {
    expect(
      hashFor({ kind: "product", slug: "a/b", view: "license", id: "c d" }),
    ).toBe("#/p/a%2Fb/license/c%20d");
  });
});

describe("parseRoute ∘ hashFor round-trip", () => {
  const routes: Route[] = [
    { kind: "dashboard" },
    { kind: "products" },
    { kind: "product", slug: "djdl", view: "overview" },
    { kind: "product", slug: "djdl", view: "licenses" },
    { kind: "product", slug: "acme", view: "activity" },
    { kind: "product", slug: "djdl", view: "settings" },
    { kind: "product", slug: "djdl", view: "license", id: "lic_99" },
  ];
  for (const route of routes) {
    it(`round-trips ${JSON.stringify(route)}`, () => {
      expect(parseRoute(hashFor(route))).toEqual(route);
    });
  }
});

describe("tabOf", () => {
  it("dashboard + products have no tab", () => {
    expect(tabOf({ kind: "dashboard" })).toBeNull();
    expect(tabOf({ kind: "products" })).toBeNull();
  });

  it("a license detail maps back to the licenses tab", () => {
    expect(
      tabOf({ kind: "product", slug: "djdl", view: "license", id: "x" }),
    ).toBe("licenses");
  });

  it("a tab view maps to itself", () => {
    expect(tabOf({ kind: "product", slug: "djdl", view: "config" })).toBe(
      "config",
    );
  });

  it("legacy views map to their workspace tab", () => {
    expect(tabOf({ kind: "product", slug: "djdl", view: "catalog" })).toBe(
      "config",
    );
    expect(tabOf({ kind: "product", slug: "djdl", view: "oidc" })).toBe(
      "identity",
    );
  });
});
