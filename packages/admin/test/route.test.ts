import { describe, expect, it } from "vitest";
import {
  ALL_PAGES,
  GLOBAL_PAGES,
  PRODUCT_PAGES,
  SECTIONS,
  accentOf,
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
  LEGACY_REDIRECTS,
  codecs,
  hrefFor,
  parseLocation,
  productPage,
  r,
  viewKey,
  withParam,
  type Route,
} from "../src/console/routes.js";
import type { ServiceSlug } from "../src/api.js";

/**
 * The console's URL contract (docs/design/ADMIN.md §2.5–2.6): every page parses and round-trips,
 * every pre-redesign URL redirects, a page that is not built yet redirects to the page that holds
 * its capability today, and anything else is a not-found page that names the segment (SH-8).
 * The nav model those URLs come from (nav.ts) is pinned here too.
 */

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

/** A route without its query, for `toEqual`. */
function bare(route: Route): Record<string, unknown> {
  const { query: _query, ...rest } = route;
  return rest;
}

const parse = (hash: string) => {
  const parsed = parseLocation(hash);
  return { route: bare(parsed.route), redirect: parsed.redirect };
};

const READY_PRODUCT = PRODUCT_PAGES.filter((p) => p.ready);
const NOT_READY = ALL_PAGES.filter((p) => !p.ready);

describe("every page parses and round-trips", () => {
  it("Home is the empty hash, `#` and `#/`", () => {
    for (const hash of ["", "#", "#/"]) {
      expect(parse(hash)).toEqual({
        route: { kind: "global", page: "home" },
        redirect: undefined,
      });
    }
  });

  it("each built global page", () => {
    for (const p of GLOBAL_PAGES.filter((g) => g.ready)) {
      const hash = `#/${p.path}`;
      const { route, redirect } = parse(hash);
      expect(redirect, p.page).toBeUndefined();
      expect(route).toEqual({ kind: "global", page: p.page });
      expect(hrefFor(parseLocation(hash).route)).toBe(hash);
    }
  });

  it("each built product page, at #/p/<slug>/<section>/<page>", () => {
    for (const p of READY_PRODUCT) {
      const hash = productPage("djdl", p.page as ProductPageId);
      expect(hash).toBe(`#/p/djdl${p.path ? `/${p.path}` : ""}`);
      const { route, redirect } = parse(hash);
      expect(redirect, p.page).toBeUndefined();
      expect(route).toEqual({ kind: "product", slug: "djdl", page: p.page });
      expect(hrefFor(parseLocation(hash).route)).toBe(hash);
    }
  });

  it("each built record, with and without each tab", () => {
    for (const p of READY_PRODUCT.filter((x) => x.record?.ready)) {
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

describe("every old URL redirects (ADMIN.md §2.5)", () => {
  // The table, verbatim. Each row: old hash → new hash.
  const TABLE: [string, string][] = [
    ["#/p/djdl/overview", "#/p/djdl"],
    ["#/p/djdl/secrets", "#/p/djdl/keys"],
    ["#/p/djdl/licenses", "#/p/djdl/license/licenses"],
    ["#/p/djdl/licenses/lic_1", "#/p/djdl/license/licenses/lic_1"],
    ["#/p/djdl/tiers", "#/p/djdl/license/tiers"],
    ["#/p/djdl/fingerprints", "#/p/djdl/license/enrollment"],
    ["#/p/djdl/config", "#/p/djdl/config/catalog"],
    ["#/p/djdl/profiles", "#/p/djdl/config/profiles"],
    ["#/p/djdl/profiles/trial", "#/p/djdl/config/profiles/trial"],
    ["#/p/djdl/releases", "#/p/djdl/release/releases"],
    ["#/p/djdl/deliverables", "#/p/djdl/release/deliverables"],
    [
      "#/p/djdl/deliverables/core%20pack",
      "#/p/djdl/release/deliverables/core%20pack",
    ],
    ["#/p/djdl/compatibility", "#/p/djdl/release/compatibility"],
    ["#/p/djdl/distribution", "#/p/djdl/distribution/matrix"],
    ["#/p/djdl/distribution-matrix", "#/p/djdl/distribution/matrix"],
    ["#/p/djdl/distribution-health", "#/p/djdl/distribution/health"],
    ["#/p/djdl/updates", "#/p/djdl/update/feed"],
    ["#/p/djdl/identity", "#/p/djdl/identity/portal"],
  ];

  it.each(TABLE)("%s → %s", (from, to) => {
    const parsed = parseLocation(from);
    expect(parsed.redirect).toBe(to);
    // The route already is the target, so the first render shows the right page.
    expect(bare(parsed.route)).toEqual(bare(parseLocation(to).route));
    expect(parseLocation(to).redirect).toBeUndefined();
  });

  it("covers every legacy tab the old router knew", () => {
    const covered = new Set(TABLE.map(([from]) => from.split("/")[3]));
    expect([...covered].sort()).toEqual(Object.keys(LEGACY_REDIRECTS).sort());
  });

  it("keeps the query across a redirect", () => {
    expect(parseLocation("#/p/djdl/licenses?status=expired").redirect).toBe(
      "#/p/djdl/license/licenses?status=expired",
    );
  });

  it("does not invent a shape the old URL never had", () => {
    expect(parseLocation("#/p/djdl/licenses/a/b").route.kind).toBe("not-found");
    expect(parseLocation("#/p/djdl/tiers/t1").route.kind).toBe("not-found");
    expect(parseLocation("#/p/djdl/config/nope").route.kind).toBe("not-found");
  });

  it("a section alone goes to its first page", () => {
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
});

describe("pages that are not built yet redirect to their host", () => {
  const hashOf = (page: PageId): string =>
    GLOBAL_PAGES.some((g) => g.page === page)
      ? `#/${pageOf(page).path}`
      : productPage("djdl", page as ProductPageId);

  it.each(NOT_READY.map((p) => [p.page, p.host!] as const))(
    "%s → %s",
    (page, host) => {
      const parsed = parseLocation(hashOf(page));
      expect(parsed.redirect, page).toBe(hashOf(host));
      const target = parsed.route;
      expect(target.kind === "not-found" ? null : target.page).toBe(host);
    },
  );

  it("a record that is not built yet goes to its collection", () => {
    expect(parseLocation("#/p/djdl/license/tiers/t1").redirect).toBe(
      "#/p/djdl/license/tiers",
    );
    expect(
      parseLocation("#/p/djdl/release/releases/rel_1/builds").redirect,
    ).toBe("#/p/djdl/release/releases");
    expect(parseLocation("#/p/djdl/devices/dev_1").redirect).toBe(
      "#/p/djdl/devices",
    );
  });

  it("every host is a built page in the same scope", () => {
    for (const p of NOT_READY) {
      expect(p.host, p.page).toBeDefined();
      const host = pageOf(p.host!);
      expect(host.ready, `${p.page} → ${p.host}`).toBe(true);
      expect(sectionOf(host.page) === null, p.page).toBe(
        sectionOf(p.page) === null,
      );
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
      "platform",
      "overview",
      "services",
      "devices",
      "keys",
      "activity",
      "settings",
      "licenses",
      "tiers",
      "enrollment",
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
      "access",
      "health",
      "credentials",
      "feed",
      "portal",
      "sign-in",
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

  it("every section lists at least one built page", () => {
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
      "platform",
      "product-new",
    ] as GlobalPageId[]) {
      expect(sectionOf(id)).toBeNull();
    }
  });
});
