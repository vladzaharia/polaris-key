import { describe, expect, it } from "vitest";
import {
  hashFor,
  isSectionEnabled,
  isTabEnabled,
  parseRoute,
  SECTIONS,
  sectionOf,
  tabOf,
  TABS,
  visibleSections,
  type Route,
  type ServiceState,
  type Tab,
} from "../src/route.js";
import type { ServiceSlug } from "../src/api.js";

// Hash routing is the only navigation layer (no router dep). These pin the parse/serialize
// round-trip + the precedence rules so deep links and the product switcher stay in sync.
//
// `route.ts` also owns the suite console's NAV MODEL (D-15): a tab belongs to a service section,
// and a section only exists for a product that runs that service. Three places read that answer
// — sidebar, router, topbar — so it is pinned here rather than in each of them.

/** Everything on. The starting point for "and now turn exactly one thing off". */
const ALL_ON: ServiceState = {
  license: { enabled: true },
  config: { enabled: true },
  release: { enabled: true },
  distribution: { enabled: true },
  update: { enabled: true },
  identity: { enabled: true },
};

const withOff = (...off: ServiceSlug[]): ServiceState => ({
  ...ALL_ON!,
  ...Object.fromEntries(off.map((s) => [s, { enabled: false }])),
});

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
    expect(parseRoute("#/p/djdl/licenses/lic_42")).toEqual({
      kind: "product",
      slug: "djdl",
      view: "license",
      id: "lic_42",
    });
  });

  it("a profile detail carries the id", () => {
    // Profile editing is a routed page, not a modal: the payload is as large as the catalog,
    // and "the profile that's wrong" needs a URL.
    expect(parseRoute("#/p/djdl/profiles/default")).toEqual({
      kind: "product",
      slug: "djdl",
      view: "profile",
      id: "default",
    });
    // The list route is unaffected.
    expect(parseRoute("#/p/djdl/profiles")).toEqual({
      kind: "product",
      slug: "djdl",
      view: "profiles",
    });
  });

  it("an unknown view falls back to the OVERVIEW, not to licenses", () => {
    // Re-baselined by the nav regroup: Licenses is a view a config-only product does not have,
    // so it cannot be where "I don't know what you meant" lands. Overview is in the platform
    // section, which every product has whatever it runs.
    expect(parseRoute("#/p/djdl/bogus")).toEqual({
      kind: "product",
      slug: "djdl",
      view: "overview",
    });
  });

  it("unknown product views fall back to the overview", () => {
    expect(parseRoute("#/p/djdl/catalog")).toEqual({
      kind: "product",
      slug: "djdl",
      view: "overview",
    });
    // `oidc` was a real tab before P7; the Identity section replaced it. An old bookmark must
    // land somewhere sane rather than on a blank screen.
    expect(parseRoute("#/p/djdl/oidc")).toEqual({
      kind: "product",
      slug: "djdl",
      view: "overview",
    });
  });

  it("decodes a URL-encoded slug and id (encoded slashes survive)", () => {
    expect(parseRoute("#/p/my%20product/licenses/id%2Fwith%2Fslashes")).toEqual(
      {
        kind: "product",
        slug: "my product",
        view: "license",
        id: "id/with/slashes",
      },
    );
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
    ).toBe("#/p/djdl/licenses/lic_1");
  });

  it("serializes a profile-detail route under its list segment", () => {
    expect(
      hashFor({
        kind: "product",
        slug: "djdl",
        view: "profile",
        id: "default",
      }),
    ).toBe("#/p/djdl/profiles/default");
  });

  it("encodes slugs + ids with special characters", () => {
    expect(
      hashFor({ kind: "product", slug: "a/b", view: "license", id: "c d" }),
    ).toBe("#/p/a%2Fb/licenses/c%20d");
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
    { kind: "product", slug: "djdl", view: "profile", id: "default" },
    // P4-09: a pack deliverable's page; pack ids carry dots.
    { kind: "product", slug: "djdl", view: "deliverable", id: "djdl.core3d" },
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

  it("a profile detail maps back to the profiles tab", () => {
    // A detail leaf is not in the sidebar, so it has to name the tab that should light up —
    // and the tab it names is also the enablement gate the router runs it through.
    expect(
      tabOf({ kind: "product", slug: "djdl", view: "profile", id: "x" }),
    ).toBe("profiles");
  });

  it("a deliverable detail maps back to the deliverables tab", () => {
    expect(
      tabOf({ kind: "product", slug: "djdl", view: "deliverable", id: "x" }),
    ).toBe("deliverables");
  });

  it("a tab view maps to itself", () => {
    expect(tabOf({ kind: "product", slug: "djdl", view: "config" })).toBe(
      "config",
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The nav model (D-15 / D-17)
// ═════════════════════════════════════════════════════════════════════════════

describe("SECTIONS", () => {
  it("declares every tab exactly once", () => {
    // `TABS` is derived from `SECTIONS`, so a tab that appeared twice would render twice in the
    // sidebar and make `sectionOf` return whichever section happened to be first.
    const tabs = SECTIONS.flatMap((s) => s.items.map((i) => i.tab));
    expect(new Set(tabs).size).toBe(tabs.length);
    expect(tabs).toEqual(TABS.map((t) => t.tab));
  });

  it("groups the tabs under the services that own them", () => {
    const bySection = Object.fromEntries(
      SECTIONS.map((s) => [s.key, s.items.map((i) => i.tab)]),
    );
    expect(bySection).toEqual({
      platform: [
        "overview",
        "services",
        "devices",
        "secrets",
        "activity",
        "settings",
      ],
      license: ["licenses", "tiers", "fingerprints"],
      config: ["config", "profiles"],
      release: ["releases", "deliverables", "compatibility"],
      distribution: [
        "distribution",
        "distribution-matrix",
        "distribution-health",
      ],
      update: ["updates"],
      identity: ["identity"],
    });
  });

  it("carries the D-17 accent tokens: each service's slug, and `core` for the platform", () => {
    // @polaris-key/brand keys the section accents by service slug, and the always-on substrate
    // gets the `core` accent. These strings are the CSS contract (`[data-service="…"]` in the
    // brand's tokens.css), so a rename here is a silent theming regression.
    expect(Object.fromEntries(SECTIONS.map((s) => [s.key, s.accent]))).toEqual({
      platform: "core",
      license: "license",
      config: "config",
      release: "release",
      distribution: "distribution",
      update: "update",
      identity: "identity",
    });
  });

  it("binds each section to the service that gates it, and the platform to none", () => {
    expect(Object.fromEntries(SECTIONS.map((s) => [s.key, s.service]))).toEqual(
      {
        platform: null,
        license: "license",
        config: "config",
        release: "release",
        distribution: "distribution",
        update: "update",
        identity: "identity",
      },
    );
  });
});

describe("sectionOf", () => {
  it("is total over every tab", () => {
    for (const { tab } of TABS) {
      expect(sectionOf(tab).items.some((i) => i.tab === tab)).toBe(true);
    }
  });
});

describe("enablement filtering", () => {
  it("shows every section when everything is on", () => {
    expect(visibleSections(ALL_ON).map((s) => s.key)).toEqual(
      SECTIONS.map((s) => s.key),
    );
  });

  it("hides exactly the section whose service is off", () => {
    expect(visibleSections(withOff("release")).map((s) => s.key)).toEqual([
      "platform",
      "license",
      "config",
      "distribution",
      "update",
      "identity",
    ]);
    // Distribution's section exists only while Distribution is on (P2b-01).
    expect(visibleSections(withOff("distribution")).map((s) => s.key)).toEqual([
      "platform",
      "license",
      "config",
      "release",
      "update",
      "identity",
    ]);
    expect(isTabEnabled("distribution", withOff("distribution"))).toBe(false);
    expect(isTabEnabled("distribution", ALL_ON)).toBe(true);
  });

  it("keeps the platform section for a product that runs NOTHING", () => {
    // The escape hatch: enablement is edited from Platform → Services, so a product with every
    // service off must still have a nav that can reach it. Hiding the platform section would
    // make an all-off product unrecoverable from the console.
    const nothing = withOff(
      "license",
      "config",
      "release",
      "distribution",
      "update",
      "identity",
    );
    expect(visibleSections(nothing).map((s) => s.key)).toEqual(["platform"]);
    expect(isTabEnabled("services", nothing)).toBe(true);
  });

  it("shows everything while enablement is still unknown", () => {
    // Fail-OPEN, deliberately: this is an affordance filter, not an access control — the worker
    // gates every one of these endpoints itself. Hiding first and revealing on load would make
    // the nav jump under the operator's cursor and flash a "not enabled" screen on a deep link
    // that is in fact enabled.
    expect(visibleSections(null).map((s) => s.key)).toEqual(
      SECTIONS.map((s) => s.key),
    );
    expect(isTabEnabled("licenses", null)).toBe(true);
  });

  it("treats a service missing from the map as off", () => {
    // A worker that grew a sixth service would send a map this build has never seen; the
    // reverse — a map missing a slug we DO know — must not read as enabled.
    const partial = { license: { enabled: true } } as unknown as ServiceState;
    expect(isTabEnabled("licenses", partial)).toBe(true);
    expect(isTabEnabled("releases", partial)).toBe(false);
  });

  it("gates every tab through its own section", () => {
    const off = withOff("license");
    const expected: [Tab, boolean][] = [
      ["overview", true],
      ["services", true],
      ["secrets", true],
      ["activity", true],
      ["settings", true],
      ["licenses", false],
      ["tiers", false],
      ["fingerprints", false],
      ["config", true],
      ["profiles", true],
      ["releases", true],
      ["updates", true],
      ["identity", true],
    ];
    for (const [tab, want] of expected) {
      expect(isTabEnabled(tab, off), tab).toBe(want);
    }
  });

  it("isSectionEnabled agrees with visibleSections", () => {
    const state = withOff("config", "identity");
    for (const section of SECTIONS) {
      expect(isSectionEnabled(section, state), section.key).toBe(
        visibleSections(state).includes(section),
      );
    }
  });
});
