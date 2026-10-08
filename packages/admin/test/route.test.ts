import { describe, expect, it } from "vitest";
import {
  ALL_PAGES,
  GLOBAL_PAGES,
  PRODUCT_PAGES,
  PLATFORM_GROUP,
  SECTIONS,
  accentOf,
  groupOf,
  isPlatformPage,
  platformItems,
  platformLinks,
  docsFor,
  isPageEnabled,
  isSectionEnabled,
  navItems,
  pageOf,
  sameViewIn,
  sectionOf,
  visibleSections,
  type GlobalPageId,
  type PageId,
  type ProductPageId,
  type ServiceState,
} from "../src/console/nav.js";
import {
  MOVED_TABS,
  codecs,
  hrefFor,
  movedHref,
  parseLocation,
  productPage,
  r,
  searchTermFor,
  viewKey,
  withParam,
  type Route,
} from "../src/console/routes.js";
import type { ServiceSlug } from "../src/api.js";

/**
 * The console's URL contract (docs/design/ADMIN.md §2.5–2.6): every page parses and round-trips,
 * a section's key alone redirects to its first page, and anything else is a not-found page that
 * names the segment (SH-8); a pre-redesign tab's not-found page knows where its page moved.
 * The nav model those URLs come from (nav.ts) is pinned here too.
 */

const ALL_ON: ServiceState = {
  license: { enabled: true },
  config: { enabled: true },
  release: { enabled: true },
  distribution: { enabled: true },
  update: { enabled: true },
  identity: { enabled: true },
  sync: { enabled: true },
};

const withOff = (...off: ServiceSlug[]): ServiceState => ({
  ...ALL_ON!,
  ...Object.fromEntries(off.map((s) => [s, { enabled: false }])),
});

/** A route without its query, for `toEqual`. */
function bare(route: Route): Record<string, unknown> {
  const { query: _query, ...rest } = route;
  return rest;
}

const parse = (hash: string) => {
  const parsed = parseLocation(hash);
  return { route: bare(parsed.route), redirect: parsed.redirect };
};

describe("every page parses and round-trips", () => {
  it("Home is the empty hash, `#` and `#/`", () => {
    for (const hash of ["", "#", "#/"]) {
      expect(parse(hash)).toEqual({
        route: { kind: "global", page: "home" },
        redirect: undefined,
      });
    }
  });

  it("each global page", () => {
    for (const p of GLOBAL_PAGES) {
      const hash = `#/${p.path}`;
      const { route, redirect } = parse(hash);
      expect(redirect, p.page).toBeUndefined();
      expect(route).toEqual({ kind: "global", page: p.page });
      expect(hrefFor(parseLocation(hash).route)).toBe(hash);
    }
  });

  it("each product page, at #/p/<slug>/<section>/<page>", () => {
    for (const p of PRODUCT_PAGES) {
      const hash = productPage("djdl", p.page as ProductPageId);
      expect(hash).toBe(`#/p/djdl${p.path ? `/${p.path}` : ""}`);
      const { route, redirect } = parse(hash);
      expect(redirect, p.page).toBeUndefined();
      expect(route).toEqual({ kind: "product", slug: "djdl", page: p.page });
      expect(hrefFor(parseLocation(hash).route)).toBe(hash);
    }
  });

  it("each record, with and without each tab", () => {
    for (const p of PRODUCT_PAGES.filter((x) => x.record)) {
      const page = p.page as ProductPageId;
      const plain = productPage("djdl", page, { id: "rec_1" });
      expect(parse(plain)).toEqual({
        route: { kind: "product", slug: "djdl", page, id: "rec_1" },
        redirect: undefined,
      });
      expect(hrefFor(parseLocation(plain).route)).toBe(plain);
      for (const tab of p.record!.tabs ?? []) {
        const hash = productPage("djdl", page, { id: "rec_1", tab });
        expect(parse(hash).route).toEqual({
          kind: "product",
          slug: "djdl",
          page,
          id: "rec_1",
          tab,
        });
        expect(hrefFor(parseLocation(hash).route)).toBe(hash);
      }
    }
  });

  it("the typed builders produce the same hashes as the table", () => {
    expect(r.home()).toBe("#/");
    expect(r.products()).toBe("#/products");
    expect(r.overview("djdl")).toBe("#/p/djdl");
    expect(r.keys("djdl")).toBe("#/p/djdl/keys");
    expect(r.license("djdl", "lic_1", "keys")).toBe(
      "#/p/djdl/license/licenses/lic_1/keys",
    );
    expect(r.profile("djdl", "trial")).toBe("#/p/djdl/config/profiles/trial");
    expect(r.deliverable("djdl", "core")).toBe(
      "#/p/djdl/release/deliverables/core",
    );
    expect(r.feed("djdl")).toBe("#/p/djdl/update/feed");
  });

  it("keeps the query on a page, and round-trips it", () => {
    const hash = r.licenses("djdl", {
      status: "expired,active",
      sort: "-expires",
    });
    expect(hash).toBe(
      "#/p/djdl/license/licenses?status=expired%2Cactive&sort=-expires",
    );
    const { route } = parseLocation(hash);
    expect(route.query.get("status")).toBe("expired,active");
    expect(route.query.get("sort")).toBe("-expires");
    expect(hrefFor(route)).toBe(hash);
  });

  it("drops empty query values from builders", () => {
    expect(
      r.matrix("djdl", { deliverable: "", view: null, window: undefined }),
    ).toBe("#/p/djdl/distribution/matrix");
  });

  it("decodes and re-encodes slugs and ids (an encoded slash survives)", () => {
    const hash = r.license("dj dl", "a/b c");
    expect(hash).toBe("#/p/dj%20dl/license/licenses/a%2Fb%20c");
    expect(parse(hash).route).toEqual({
      kind: "product",
      slug: "dj dl",
      page: "licenses",
      id: "a/b c",
    });
    expect(hrefFor(parseLocation(hash).route)).toBe(hash);
  });

  it("tolerates a trailing slash", () => {
    expect(parse("#/p/djdl/license/tiers/").route).toEqual({
      kind: "product",
      slug: "djdl",
      page: "tiers",
    });
  });
});

describe("section roots redirect to the section's first page", () => {
  it("a product section alone goes to its first page", () => {
    expect(parseLocation("#/p/djdl/license").redirect).toBe(
      "#/p/djdl/license/licenses",
    );
    expect(parseLocation("#/p/djdl/release").redirect).toBe(
      "#/p/djdl/release/releases",
    );
    expect(parseLocation("#/p/djdl/update").redirect).toBe(
      "#/p/djdl/update/feed",
    );
  });

  it("#/platform goes to the Platform group's first page, keeping the query", () => {
    const parsed = parseLocation("#/platform?x=1");
    expect(parsed.redirect).toBe("#/platform/settings?x=1");
    expect(bare(parsed.route)).toEqual({
      kind: "global",
      page: "platform-settings",
    });
    expect(r.platform()).toBe("#/platform");
  });

  it("pre-redesign tabs do not redirect: their not-found route says where the page moved", () => {
    // ADMIN.md §2.5: old hash → the new address the moved page links to (id and query kept).
    const OLD: [string, string][] = [
      ["#/p/djdl/overview", "#/p/djdl"],
      ["#/p/djdl/secrets", "#/p/djdl/keys"],
      ["#/p/djdl/licenses", "#/p/djdl/license/licenses"],
      ["#/p/djdl/licenses/lic_1", "#/p/djdl/license/licenses/lic_1"],
      [
        "#/p/djdl/licenses?status=disabled",
        "#/p/djdl/license/licenses?status=disabled",
      ],
      ["#/p/djdl/tiers", "#/p/djdl/license/tiers"],
      ["#/p/djdl/fingerprints", "#/p/djdl/license/enrollment"],
      ["#/p/djdl/profiles", "#/p/djdl/config/profiles"],
      ["#/p/djdl/profiles/p1", "#/p/djdl/config/profiles/p1"],
      ["#/p/djdl/releases", "#/p/djdl/release/releases"],
      ["#/p/djdl/deliverables", "#/p/djdl/release/deliverables"],
      [
        "#/p/djdl/deliverables/textures",
        "#/p/djdl/release/deliverables/textures",
      ],
      ["#/p/djdl/compatibility", "#/p/djdl/release/compatibility"],
      ["#/p/djdl/distribution-matrix", "#/p/djdl/distribution/matrix"],
      ["#/p/djdl/distribution-health", "#/p/djdl/distribution/health"],
      ["#/p/djdl/updates", "#/p/djdl/update/feed"],
      ["#/p/a%20b/licenses/lic%2F1", "#/p/a%20b/license/licenses/lic%2F1"],
    ];
    for (const [old, now] of OLD) {
      const parsed = parseLocation(old);
      expect(parsed.redirect, old).toBeUndefined();
      const route = parsed.route;
      if (route.kind !== "not-found") throw new Error(`${old}: ${route.kind}`);
      expect(route.moved, old).toBeDefined();
      expect(movedHref(route.slug!, route.moved!, route.query), old).toBe(now);
      // The new address is a page, not another not-found.
      expect(parseLocation(now).route.kind, now).toBe("product");
    }
    // Every old tab in the map is a page that exists, and it is not a path a page owns today.
    for (const [tab, page] of MOVED_TABS) {
      expect(pageOf(page).page).toBe(page);
      expect(parseLocation(`#/p/djdl/${tab}`).route.kind, tab).toBe(
        "not-found",
      );
    }
  });

  it("only an old tab, or an old tab and an id its page has records for, is moved", () => {
    for (const hash of [
      "#/p/djdl/nope",
      "#/p/djdl/secrets/x", // Keys & secrets has no records
      "#/p/djdl/licenses/lic_1/keys", // the old URLs had no record tabs
      "#/p/djdl/constructor",
      "#/p/djdl/config/nope",
    ]) {
      const route = parseLocation(hash).route;
      expect(route.kind, hash).toBe("not-found");
      expect(route.kind === "not-found" && route.moved, hash).toBeFalsy();
    }
    // The old tabs that are section keys now are section roots, and redirect as before.
    expect(parseLocation("#/p/djdl/config").redirect).toBe(
      "#/p/djdl/config/catalog",
    );
    for (const key of ["distribution", "identity"])
      expect(parseLocation(`#/p/djdl/${key}`).redirect, key).toMatch(
        new RegExp(`^#/p/djdl/${key}/`),
      );
  });

  it("a not-found path's search term is its first segment that is not a section key", () => {
    expect(searchTermFor("nope")).toBe("nope");
    expect(searchTermFor("license/nope")).toBe("nope");
    expect(searchTermFor("licensez/lic_1")).toBe("licensez");
    expect(searchTermFor("distribution-foo_bar")).toBe("distribution foo bar");
    expect(searchTermFor("license")).toBe("license");
    expect(searchTermFor("")).toBe("");
  });
});

describe("records parse in place", () => {
  it("the tier record parses as a record and stays put (chunk 6)", () => {
    expect(parseLocation("#/p/djdl/license/tiers/t1").redirect).toBeUndefined();
    expect(
      parseLocation("#/p/djdl/license/tiers/t1/used-by").route,
    ).toMatchObject({ page: "tiers", id: "t1", tab: "used-by" });
  });

  it("the device drawer is a routed record (chunk 5)", () => {
    const parsed = parseLocation("#/p/djdl/devices/dev_1");
    expect(parsed.redirect).toBeUndefined();
    expect(parsed.route).toMatchObject({
      kind: "product",
      page: "devices",
      id: "dev_1",
    });
  });

  it("a record keeps its id and tab (the release record, chunk 8)", () => {
    const parsed = parseLocation("#/p/djdl/release/releases/rel_1/builds");
    expect(parsed.redirect).toBeUndefined();
    expect(parsed.route).toMatchObject({
      kind: "product",
      page: "releases",
      id: "rel_1",
      tab: "builds",
    });
    for (const path of [
      "channels",
      "content-keys",
      "compatibility/simulator",
    ]) {
      expect(
        parseLocation(`#/p/djdl/release/${path}`).redirect,
      ).toBeUndefined();
    }
  });
});

describe("unknown segments resolve to not-found (SH-8)", () => {
  it("names the product and the path it could not match", () => {
    expect(parse("#/p/djdl/nope").route).toEqual({
      kind: "not-found",
      slug: "djdl",
      path: "nope",
    });
    expect(parse("#/p/djdl/license/nope").route).toEqual({
      kind: "not-found",
      slug: "djdl",
      path: "license/nope",
    });
  });

  it("an unknown record tab is not silently the first tab", () => {
    expect(parse("#/p/djdl/license/licenses/lic_1/bogus").route.kind).toBe(
      "not-found",
    );
  });

  it("global paths match exactly: #/productsfoo is not Products", () => {
    expect(parse("#/productsfoo").route).toEqual({
      kind: "not-found",
      path: "productsfoo",
    });
    expect(parse("#/nothing/here").route.kind).toBe("not-found");
  });

  it("a product path with no slug, and a malformed escape", () => {
    expect(parse("#/p").route.kind).toBe("not-found");
    expect(parse("#/p/").route.kind).toBe("not-found");
    expect(parse("#/p/%E0%A4%A/overview").route.kind).toBe("not-found");
  });

  it("a not-found route round-trips to its own hash", () => {
    expect(hrefFor(parseLocation("#/p/djdl/nope").route)).toBe("#/p/djdl/nope");
    expect(hrefFor(parseLocation("#/productsfoo").route)).toBe("#/productsfoo");
  });
});

describe("the remount key (ADMIN.md §2.6)", () => {
  const key = (hash: string) => viewKey(parseLocation(hash).route);

  it("ignores the query and the record tab", () => {
    expect(key("#/p/djdl/license/licenses?q=a")).toBe(
      key("#/p/djdl/license/licenses?q=b"),
    );
    expect(key("#/p/djdl/license/licenses/l1/keys")).toBe(
      key("#/p/djdl/license/licenses/l1/devices"),
    );
  });

  it("changes with the product, the page and the record", () => {
    expect(key("#/p/a/license/licenses")).not.toBe(
      key("#/p/b/license/licenses"),
    );
    expect(key("#/p/a/license/licenses")).not.toBe(key("#/p/a/license/tiers"));
    expect(key("#/p/a/license/licenses/l1")).not.toBe(
      key("#/p/a/license/licenses/l2"),
    );
  });
});

describe("query codecs (ADMIN.md §5.7)", () => {
  it("string: empty is absent, the fallback is never written", () => {
    const c = codecs.string();
    expect(c.parse(null)).toBe("");
    expect(c.parse("abc")).toBe("abc");
    expect(c.format("")).toBeNull();
    expect(c.format("abc")).toBe("abc");
  });

  it("int: non-negative integers only, anything else reads as the fallback", () => {
    const c = codecs.int(24);
    expect(c.parse("168")).toBe(168);
    expect(c.parse("-1")).toBe(24);
    expect(c.parse("1.5")).toBe(24);
    expect(c.parse("x")).toBe(24);
    expect(c.parse(null)).toBe(24);
    expect(c.format(24)).toBeNull();
    expect(c.format(48)).toBe("48");
  });

  it("oneOf: an unknown value reads as the fallback", () => {
    const c = codecs.oneOf(["matrix", "readiness"] as const, "matrix");
    expect(c.parse("readiness")).toBe("readiness");
    expect(c.parse("evil")).toBe("matrix");
    expect(c.format("matrix")).toBeNull();
  });

  it("list: comma-separated, order kept, blanks dropped", () => {
    const c = codecs.list();
    expect(c.parse("active,,expired")).toEqual(["active", "expired"]);
    expect(c.parse(null)).toEqual([]);
    expect(c.format([])).toBeNull();
    expect(c.format(["a", "b"])).toBe("a,b");
  });

  it("withParam sets and removes one parameter, leaving the rest", () => {
    const q = new URLSearchParams("q=x&status=a");
    expect(withParam(q, "status", codecs.list(), ["a", "b"]).toString()).toBe(
      "q=x&status=a%2Cb",
    );
    expect(withParam(q, "status", codecs.list(), []).toString()).toBe("q=x");
    expect(q.toString()).toBe("q=x&status=a");
  });
});

describe("the nav model (nav.ts)", () => {
  it("declares every page exactly once, with a unique path per scope", () => {
    const ids = ALL_PAGES.map((p) => p.page);
    expect(new Set(ids).size).toBe(ids.length);
    const globalPaths = GLOBAL_PAGES.map((p) => p.path);
    expect(new Set(globalPaths).size).toBe(globalPaths.length);
    const productPaths = PRODUCT_PAGES.map((p) => p.path);
    expect(new Set(productPaths).size).toBe(productPaths.length);
  });

  it("covers the §2.3 page set", () => {
    const expected: PageId[] = [
      "home",
      "products",
      "product-new",
      "platform-settings",
      "platform-deployment",
      "platform-operations",
      "platform-stores",
      "platform-feeds",
      "platform-override-migration",
      "package-feeds",
      "overview",
      "services",
      "devices",
      "users",
      // HA-06: the images Polaris Key hosts for the product.
      "presentation",
      "keys",
      "activity",
      "settings",
      "licenses",
      "tiers",
      "enrollment",
      "license-settings",
      "license-batches",
      "catalog",
      "catalog-edit",
      "profiles",
      "edge-mint",
      "releases",
      "channels",
      "deliverables",
      "compatibility",
      "simulator",
      "content-keys",
      "matrix",
      "rollouts",
      "outlets",
      "storefronts",
      "listing",
      "app-store",
      "commerce",
      "access",
      "health",
      "credentials",
      "feed",
      "portal",
      "sign-in",
      "sync-data",
    ];
    expect(ALL_PAGES.map((p) => p.page).sort()).toEqual([...expected].sort());
  });

  it("puts Core first, then one section per service in canonical order", () => {
    expect(SECTIONS.map((s) => s.key)).toEqual([
      "core",
      "license",
      "config",
      "release",
      "distribution",
      "update",
      "identity",
      "sync",
    ]);
    expect(SECTIONS[0]!.service).toBeNull();
    for (const s of SECTIONS.slice(1)) expect(s.service).toBe(s.key);
  });

  it("carries the accent tokens: each service's slug, `core` for Core and the global pages", () => {
    expect(SECTIONS.map((s) => s.accent)).toEqual([
      "core",
      "license",
      "config",
      "release",
      "distribution",
      "update",
      "identity",
      "sync",
    ]);
    for (const g of GLOBAL_PAGES) expect(accentOf(g.page)).toBe("core");
    expect(accentOf("tiers")).toBe("license");
    expect(accentOf("health")).toBe("distribution");
  });

  it("every nav ITEM declares an icon component (owner, 2026-10-03)", () => {
    // Items only: section headers deliberately have none (shell.test.tsx asserts that). Every page
    // the sidebar or the palette can list, built or not yet, declares a lucide component.
    for (const p of ALL_PAGES) {
      expect(p.icon, `${p.page} has no icon`).toBeTruthy();
      expect(
        ["function", "object"].includes(typeof p.icon),
        `${p.page}'s icon is not a component`,
      ).toBe(true);
    }
  });

  it("every page has an absolute, trailing-slash docs path", () => {
    for (const p of ALL_PAGES) {
      expect(docsFor(p.page), p.page).toMatch(/^\/docs\/([a-z0-9-]+\/)*$/);
    }
    for (const s of SECTIONS) expect(s.docs, s.key).toMatch(/^\/docs\//);
  });

  it("product `g` shortcuts are ADMIN.md §5.5's, unique, and never shadow `g h` or `g p`", () => {
    const keys = PRODUCT_PAGES.map((p) => p.shortcut).filter(Boolean);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain("h");
    expect(keys).not.toContain("p");
    expect(
      Object.fromEntries(
        PRODUCT_PAGES.filter((p) => p.shortcut).map((p) => [
          p.shortcut,
          p.page,
        ]),
      ),
    ).toEqual({
      o: "overview",
      l: "licenses",
      c: "catalog",
      r: "releases",
      m: "matrix",
      a: "activity",
      s: "settings",
    });
  });

  it("every section lists at least one page", () => {
    for (const s of SECTIONS)
      expect(navItems(s).length, s.key).toBeGreaterThan(0);
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
      "core",
      "license",
      "config",
      "distribution",
      "update",
      "identity",
      "sync",
    ]);
  });

  it("keeps Core for a product that runs nothing", () => {
    const none = withOff(
      "license",
      "config",
      "release",
      "distribution",
      "update",
      "identity",
      "sync",
    );
    expect(visibleSections(none).map((s) => s.key)).toEqual(["core"]);
  });

  it("shows everything while enablement is unknown, and treats a missing service as off", () => {
    expect(visibleSections(null).length).toBe(SECTIONS.length);
    expect(isSectionEnabled(SECTIONS[1]!, {})).toBe(false);
  });

  it("gates every product page through its own section", () => {
    for (const p of PRODUCT_PAGES) {
      const section = sectionOf(p.page)!;
      const off = section.service === null ? ALL_ON : withOff(section.service);
      expect(isPageEnabled(p.page as ProductPageId, off), p.page).toBe(
        section.service === null,
      );
      expect(isPageEnabled(p.page as ProductPageId, ALL_ON)).toBe(true);
    }
  });
});

describe("the product switcher keeps the page (sameViewIn, fixes SH-11)", () => {
  it("keeps a page whose service the target runs", () => {
    expect(sameViewIn("tiers", ALL_ON)).toBe("tiers");
    expect(sameViewIn("activity", withOff("license"))).toBe("activity");
  });

  it("lands on Overview when the target does not run the page's service", () => {
    expect(sameViewIn("tiers", withOff("license"))).toBe("overview");
    expect(sameViewIn("matrix", withOff("distribution"))).toBe("overview");
  });

  it("keeps the page while the target's enablement is unknown", () => {
    expect(sameViewIn("feed", null)).toBe("feed");
  });
});

describe("global pages", () => {
  it("have no section", () => {
    for (const id of [
      "home",
      "products",
      "product-new",
      "platform-deployment",
    ] as GlobalPageId[]) {
      expect(sectionOf(id)).toBeNull();
    }
  });

  it("the Platform section's pages are one sidebar group; Home and Products are links", () => {
    expect(PLATFORM_GROUP.items.map((p) => p.page)).toEqual([
      "platform-settings",
      "platform-deployment",
      "platform-operations",
      "platform-stores",
      "platform-feeds",
      "platform-override-migration",
    ]);
    for (const p of PLATFORM_GROUP.items) {
      expect(isPlatformPage(p.page)).toBe(true);
      expect(groupOf(p.page)).toBe("platform");
      expect(p.path.startsWith("platform/")).toBe(true);
    }
    expect(groupOf("home")).toBeNull();
    expect(groupOf("tiers")).toBe("license");
    expect(platformLinks().map((p) => p.page)).toEqual(["home", "products"]);
    // P0-47: Override migration (U-03, cancelled) is out of the sidebar and the palette; its
    // URL still answers until U-27 removes the page.
    expect(platformItems().map((p) => p.page)).toEqual([
      "platform-settings",
      "platform-deployment",
      "platform-operations",
      "platform-stores",
      "platform-feeds",
    ]);
    expect(
      parseLocation("#/platform/override-migration").redirect,
    ).toBeUndefined();
  });

  it("#/platform redirects to Settings; every Platform page renders in place", () => {
    expect(parseLocation("#/platform").redirect).toBe("#/platform/settings");
    expect(parseLocation("#/platform/settings").redirect).toBeUndefined();
    expect(parseLocation("#/platform/operations").redirect).toBeUndefined();
    expect(
      parseLocation("#/platform/store-connections").redirect,
    ).toBeUndefined();
    expect(parseLocation("#/platform/feeds").redirect).toBeUndefined();
    expect(
      parseLocation("#/platform/override-migration").redirect,
    ).toBeUndefined();
    expect(r.platform()).toBe("#/platform");
    expect(r.platformDeployment()).toBe("#/platform/deployment");
    expect(r.productNew({ via: "github" })).toBe("#/products/new?via=github");
    const wizard = parseLocation("#/products/new?via=manual&step=basics");
    expect(wizard.redirect).toBeUndefined();
    expect(wizard.route).toMatchObject({ kind: "global", page: "product-new" });
  });
});

describe("package feeds (F-11): a feed under a page, a package under a feed, in both scopes", () => {
  it("parses a feed, its tab, and a package with its tab, in product scope", () => {
    expect(parseLocation("#/p/djdl/distribution/feeds").route).toMatchObject({
      kind: "product",
      page: "package-feeds",
    });
    expect(
      parseLocation("#/p/djdl/distribution/feeds/npm/settings").route,
    ).toMatchObject({ page: "package-feeds", id: "npm", tab: "settings" });
    // `packages` alone is the feed's Packages tab; with a name after it, a package.
    expect(
      parseLocation("#/p/djdl/distribution/feeds/npm/packages").route,
    ).toMatchObject({ id: "npm", tab: "packages" });
    const pkg = parseLocation(
      "#/p/djdl/distribution/feeds/npm/packages/%40acme%2Fsdk/history",
    ).route;
    expect(pkg).toMatchObject({
      page: "package-feeds",
      id: "npm",
      child: { ids: ["@acme/sdk"], tab: "history" },
    });
    expect(hrefFor(pkg)).toBe(
      "#/p/djdl/distribution/feeds/npm/packages/%40acme%2Fsdk/history",
    );
    expect(r.packageFeedPackage("djdl", "npm", "@acme/sdk")).toBe(
      "#/p/djdl/distribution/feeds/npm/packages/%40acme%2Fsdk",
    );
    // An unknown package tab is not a page.
    expect(
      parseLocation("#/p/djdl/distribution/feeds/npm/packages/x/nope").route
        .kind,
    ).toBe("not-found");
  });

  it("parses the platform scope, where a package is owner and name", () => {
    expect(parseLocation("#/platform/feeds/pypi/activity").route).toMatchObject(
      { kind: "global", page: "platform-feeds", id: "pypi", tab: "activity" },
    );
    const pkg = parseLocation(
      "#/platform/feeds/npm/packages/polaris-key/%40polaris-key%2Fnode",
    ).route;
    expect(pkg).toMatchObject({
      kind: "global",
      page: "platform-feeds",
      id: "npm",
      child: { ids: ["polaris-key", "@polaris-key/node"] },
    });
    expect(hrefFor(pkg)).toBe(
      "#/platform/feeds/npm/packages/polaris-key/%40polaris-key%2Fnode",
    );
    expect(r.platformFeed("oci", "setup")).toBe("#/platform/feeds/oci/setup");
    // One name is not enough in platform scope: the URL names nothing.
    expect(
      parseLocation("#/platform/feeds/npm/packages/polaris-key").route.kind,
    ).toBe("not-found");
  });

  it("remounts on a new feed or package, not on a tab", () => {
    const a = parseLocation("#/platform/feeds/npm/settings").route;
    const b = parseLocation("#/platform/feeds/npm/activity").route;
    const c = parseLocation("#/platform/feeds/pypi").route;
    const d = parseLocation("#/platform/feeds/npm/packages/o/n").route;
    expect(viewKey(a)).toBe(viewKey(b));
    expect(viewKey(a)).not.toBe(viewKey(c));
    expect(viewKey(a)).not.toBe(viewKey(d));
  });

  it("lists Package feeds in Distribution only while the product has them on", () => {
    const distribution = SECTIONS.find((s) => s.key === "distribution")!;
    const labels = (f: { packageFeeds: boolean } | null) =>
      navItems(distribution, f).map((p) => p.label);
    expect(labels({ packageFeeds: false })).not.toContain("Package feeds");
    expect(labels({ packageFeeds: true })).toContain("Package feeds");
    // While the product loads, the item shows (the nav does not jump).
    expect(labels(null)).toContain("Package feeds");
    expect(docsFor("package-feeds")).toBe("/docs/admin/feeds/");
    expect(docsFor("platform-feeds")).toBe("/docs/admin/feeds/");
  });
});
