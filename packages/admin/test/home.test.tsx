import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { ProductCard } from "../src/console/pages/global/Home.js";
import type { ProductAttention } from "../src/console/pages/global/attention.js";
import type { ProductDetail } from "../src/api.js";
import { configureAxe } from "vitest-axe";
import {
  ALL_ON,
  ME,
  NONE,
  PENDING,
  boot,
  productRow,
  resetConsole,
} from "./consoleHarness.js";

/**
 * Home (ADMIN.md §6.1; closes DSH-1 to DSH-7) with the product card of the owner's 2026-10-06
 * request (docs/design/console-product-card/, direction B): the logo, the name and slug, and a
 * ledger of the services the product runs with one fact each and its issues in place. Driven
 * through the whole console so the registry query, the router and the shell are the real ones.
 */

const axe = configureAxe({
  rules: { "color-contrast": { enabled: false } },
});

beforeEach(resetConsole);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const main = (): HTMLElement => screen.getByRole("main");

async function home(): Promise<HTMLElement> {
  await screen.findByRole("heading", { level: 1, name: "Home" });
  return main();
}

const ICON = {
  url: "https://img.test/djdl/a/" + "a".repeat(64),
  w64: "https://img.test/djdl/a/" + "a".repeat(64) + "/64.webp",
  w128: "https://img.test/djdl/a/" + "a".repeat(64) + "/128.webp",
};

const only = (
  ...on: (keyof typeof ALL_ON)[]
): Record<string, { enabled: boolean }> =>
  Object.fromEntries(
    Object.keys(ALL_ON).map((s) => [s, { enabled: on.includes(s as never) }]),
  );

/**
 * DJDL runs everything, has a logo, and needs two things: Identity's OIDC client secret and an
 * edge-mint approval (Config). Acme runs License, Config and Release, has no logo, and is healthy.
 */
function registry(): Record<string, unknown> {
  const djdl = {
    ...productRow("djdl", "DJDL", ALL_ON),
    modifiedAt: 2_000,
    releaseSource: "github",
    presentation: { icon: ICON },
    setup: {
      healthy: false,
      secrets: [
        {
          name: "OIDC_CLIENT_SECRET",
          configured: false,
          sources: ["OIDC client secret"],
        },
      ],
      nextActions: [
        {
          id: "secret:OIDC_CLIENT_SECRET",
          label: "Set required secret OIDC_CLIENT_SECRET",
          route: "#/p/djdl/settings",
        },
        {
          id: "edge-mint:studio",
          label: "Review and approve edge-mint recipe studio",
          route: "#/p/djdl/secrets",
        },
      ],
      sync: { status: "ok", lastSyncedAt: 1_900 },
    },
  };
  const acme = {
    ...productRow("acme", "Acme", only("license", "config", "release")),
    modifiedAt: 1_000,
    presentation: { icon: null },
  };
  return { "/manage/api/products": { products: [djdl, acme] } };
}

const cards = (): HTMLElement[] =>
  within(within(main()).getByRole("list", { name: "Products" })).getAllByRole(
    "article",
  );
const card = (name: string): HTMLElement =>
  cards().find((c) => c.getAttribute("aria-label") === name)!;
/** The card's service rows (each a link). */
const rows = (c: HTMLElement): HTMLElement[] =>
  Array.from(c.querySelectorAll<HTMLElement>("[data-service-row]"));
const row = (c: HTMLElement, service: string): HTMLElement =>
  rows(c).find((r) => r.getAttribute("data-service-row") === service)!;

describe("Home", () => {
  it("shows the most recently changed products, capped at six, with a link to all of them", async () => {
    const products = Array.from({ length: 8 }, (_, i) => ({
      ...productRow(`p${i}`, `Product ${i}`, ALL_ON),
      modifiedAt: 100 + i,
    }));
    boot("#/", { extra: { "/manage/api/products": { products } } });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(6));
    expect(cards().map((c) => c.getAttribute("aria-label"))).toEqual([
      "Product 7",
      "Product 6",
      "Product 5",
      "Product 4",
      "Product 3",
      "Product 2",
    ]);
    expect(
      within(main())
        .getByRole("link", { name: /All products/ })
        .getAttribute("href"),
    ).toBe("#/products");
    // The registry's search and sort live on Products, not on a six-card shelf.
    expect(
      within(main()).queryByRole("textbox", { name: /Filter/ }),
    ).toBeNull();
  });

  it("the name is the card's one link to the product, and service links are siblings, never nested", async () => {
    boot("#/", { extra: registry() });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    const acme = card("Acme");
    const name = within(acme).getByRole("link", { name: "Acme" });
    expect(name.getAttribute("href")).toBe("#/p/acme");
    expect(name.hasAttribute("data-card-link")).toBe(true);
    expect(acme.tagName).toBe("ARTICLE");
    for (const a of Array.from(acme.querySelectorAll("a")))
      expect(a.querySelector("a"), a.outerHTML).toBeNull();
    // Focus on the name rings the card; focus on a service link does not.
    expect(acme.className).toContain(
      "has-[a[data-card-link]:focus-visible]:ring-2",
    );
    expect(acme.className).not.toMatch(/has-\[a:focus-visible\]/);
  });

  it("lists each service as a labelled link to its page, with one fact", async () => {
    boot("#/", { extra: registry() });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    const acme = card("Acme");
    expect(rows(acme).map((r) => r.getAttribute("data-service-row"))).toEqual([
      "license",
      "config",
      "release",
    ]);
    const config = row(acme, "config");
    expect(config.getAttribute("href")).toBe("#/p/acme/config/catalog");
    // Schema vN rides /me (ME's acme is schema 1), so it needs no fetch of its own.
    expect(config.textContent).toBe("ConfigSchema v1");
    expect(row(acme, "license").getAttribute("href")).toBe(
      "#/p/acme/license/licenses",
    );
    // No "more" row under four services, and no healthy pill anywhere.
    expect(within(acme).queryByText(/ more$/)).toBeNull();
    expect(acme.querySelector("[data-status=pill]")).toBeNull();
    expect(within(acme).queryByText("Setup complete")).toBeNull();
  });

  it("shows the hosted logo at the tile size, and a monogram when there is none", async () => {
    boot("#/", { extra: registry() });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    const img = card("DJDL").querySelector<HTMLImageElement>(
      "img[data-logo=image]",
    )!;
    expect(img.getAttribute("srcset")).toBe(
      `${ICON.w64} 64w, ${ICON.w128} 128w`,
    );
    expect(img.getAttribute("sizes")).toBe("40px");
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("crossorigin")).toBe("anonymous");
    const mono = card("Acme").querySelector("[data-logo=monogram]")!;
    expect(mono.textContent).toBe("A");
    expect(mono.getAttribute("aria-hidden")).toBe("true");
  });

  it("falls back to the monogram when the icon fails to load", async () => {
    boot("#/", { extra: registry() });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    const djdl = card("DJDL");
    fireEvent.error(djdl.querySelector("img[data-logo=image]")!);
    await waitFor(() =>
      expect(djdl.querySelector("[data-logo=monogram]")?.textContent).toBe("D"),
    );
    expect(djdl.querySelector("img")).toBeNull();
  });

  it("an icon still pulling (no copy yet) is the same monogram, with no spinner", async () => {
    const pulling = {
      ...productRow("djdl", "DJDL", ALL_ON),
      presentation: { icon: null },
    };
    boot("#/", {
      extra: { "/manage/api/products": { products: [pulling] } },
    });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(1));
    const djdl = card("DJDL");
    expect(djdl.querySelector("[data-logo=monogram]")?.textContent).toBe("D");
    expect(
      djdl.querySelector("[role=progressbar], [aria-busy=true]"),
    ).toBeNull();
  });

  it("a product with one service lists one row", async () => {
    const solo = {
      ...productRow("djdl", "DJDL", only("license")),
      modifiedAt: 5,
    };
    boot("#/", { extra: { "/manage/api/products": { products: [solo] } } });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(rows(card("DJDL")).map((r) => r.textContent)).toEqual(["License"]);
  });

  it("past four services: three rows, issues first, and the rest as named glyph links", async () => {
    boot("#/", { extra: registry() });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    const djdl = card("DJDL");
    // Identity and Config need something, so they take two of the three rows; the table's order
    // holds within the rows.
    expect(rows(djdl).map((r) => r.getAttribute("data-service-row"))).toEqual([
      "license",
      "config",
      "identity",
    ]);
    expect(within(djdl).getByText("4 more")).toBeTruthy();
    for (const [label, href] of [
      ["Release", "#/p/djdl/release/releases"],
      ["Distribution", "#/p/djdl/distribution/matrix"],
      ["Update", "#/p/djdl/update/feed"],
      ["Cloud Sync", "#/p/djdl/sync/data"],
    ])
      expect(
        within(djdl).getByRole("link", { name: label }).getAttribute("href"),
      ).toBe(href);
  });

  it("puts a service's issue in its row, naming it, and the row links to the fix", async () => {
    boot("#/", { extra: registry() });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    const djdl = card("DJDL");
    const config = row(djdl, "config");
    expect(within(config).getByText("Needs approval")).toBeTruthy();
    expect(config.querySelector("[data-status=pill]")).not.toBeNull();
    expect(config.getAttribute("href")).toBe("#/p/djdl/config/edge-mint");
    // The issue replaces the fact.
    expect(config.textContent).not.toContain("Schema");
    const identity = row(djdl, "identity");
    expect(within(identity).getByText("Secret missing")).toBeTruthy();
    expect(identity.getAttribute("href")).toBe("#/p/djdl/keys");
    // Both issues sit on services, so the header carries no pill.
    expect(
      djdl.querySelector("[data-card-header] [data-status=pill]"),
    ).toBeNull();
  });

  it("never hides an issue: one on a service collapsed into the glyph links moves to the header pill", () => {
    const issue = (
      service: ProductAttention["service"],
      short: string,
    ): ProductAttention => ({
      id: `djdl:${service}`,
      product: { slug: "djdl", name: "DJDL" },
      kind: "secret.missing",
      tone: "warning",
      reason: short,
      service,
      short,
      action: { label: "Fix", href: "#/p/djdl/keys" },
    });
    // Four services need something; three take the rows, and Identity collapses.
    const { container } = render(
      <ProductCard
        product={productRow("djdl", "DJDL", ALL_ON) as unknown as ProductDetail}
        attention={[
          issue("license", "Licence issue"),
          issue("config", "Needs approval"),
          issue("release", "Needs setup"),
          issue("identity", "Secret missing"),
        ]}
      />,
    );
    const article = container.querySelector("article")!;
    expect(
      rows(article).map((r) => r.getAttribute("data-service-row")),
    ).toEqual(["license", "config", "release"]);
    expect(within(article).getByText("4 more")).toBeTruthy();
    const header = article.querySelector("[data-card-header]")!;
    expect(header.lastElementChild!.getAttribute("data-status")).toBe("pill");
    expect(header.lastElementChild!.textContent).toBe("Secret missing");
  });

  it("an issue that belongs to the product is one pill, at the end of the card header", async () => {
    const keyless = {
      ...productRow("djdl", "DJDL", only("license", "config")),
      setup: {
        healthy: false,
        nextActions: [{ id: "signing-key", label: "Rotate the signing key" }],
      },
    };
    boot("#/", { extra: { "/manage/api/products": { products: [keyless] } } });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(1));
    const header = card("DJDL").querySelector("[data-card-header]")!;
    const last = header.lastElementChild!;
    expect(last.getAttribute("data-status")).toBe("pill");
    expect(last.getAttribute("data-tone")).toBe("danger");
    expect(last.textContent).toBe("No signing key");
  });

  it("a product that runs no services says so in one muted line", async () => {
    const bare = { ...productRow("djdl", "DJDL", NONE) };
    boot("#/", { extra: { "/manage/api/products": { products: [bare] } } });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(within(card("DJDL")).getByText("No services")).toBeTruthy();
    expect(rows(card("DJDL"))).toHaveLength(0);
  });

  it("shows each service's fact from the summary read", async () => {
    boot("#/", {
      extra: {
        ...registry(),
        "/manage/api/summary": {
          products: {
            djdl: {
              license: { active: 1284 },
              release: { version: "2.4.0", channel: "stable" },
              distribution: { storefronts: 3 },
              identity: { users: 312 },
            },
            acme: { license: { active: 1 }, release: null },
          },
        },
      },
    });
    await home();
    await waitFor(() =>
      expect(row(card("DJDL"), "license").textContent).toBe(
        "License1,284 active",
      ),
    );
    const acme = card("Acme");
    expect(row(acme, "license").textContent).toBe("License1 active");
    expect(row(acme, "release").textContent).toBe("ReleaseNo releases");
    // The seven-service card shows its three rows' facts; an issue still wins over a fact.
    const djdl = card("DJDL");
    expect(row(djdl, "config").textContent).toContain("Needs approval");
    expect(row(djdl, "identity").textContent).toContain("Secret missing");
  });

  it("names the release version and its channel, and counts storefronts and users", async () => {
    const quiet = {
      ...productRow(
        "djdl",
        "DJDL",
        only("release", "distribution", "identity"),
      ),
    };
    boot("#/", {
      extra: {
        "/manage/api/products": { products: [quiet] },
        "/manage/api/summary": {
          products: {
            djdl: {
              release: { version: "2.4.0", channel: "beta" },
              distribution: { storefronts: 1 },
              identity: { users: 312 },
            },
          },
        },
      },
    });
    await home();
    await waitFor(() =>
      expect(row(card("DJDL"), "release").textContent).toBe(
        "Release2.4.0 · beta",
      ),
    );
    expect(row(card("DJDL"), "distribution").textContent).toBe(
      "Distribution1 storefront",
    );
    expect(row(card("DJDL"), "identity").textContent).toBe("Identity312 users");
  });

  it("while the facts load, each is a skeleton and the card is otherwise complete", async () => {
    boot("#/", {
      extra: { ...registry(), "/manage/api/summary": PENDING },
    });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    const acme = card("Acme");
    expect(
      row(acme, "license").querySelector("[data-fact-skeleton]"),
    ).not.toBeNull();
    expect(
      row(acme, "release").querySelector("[data-fact-skeleton]"),
    ).not.toBeNull();
    // Config's fact rides /me, so it never waits on the summary.
    expect(row(acme, "config").textContent).toBe("ConfigSchema v1");
    expect(
      within(acme)
        .getByRole("list", { name: "Services" })
        .getAttribute("aria-busy"),
    ).toBe("true");
    expect(within(acme).getByRole("link", { name: "Acme" })).toBeTruthy();
  });

  it("renders the card fully, without facts, when the summary read fails", async () => {
    boot("#/", {
      extra: {
        ...registry(),
        "/manage/api/summary": new Response(
          JSON.stringify({ error: "internal" }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
      },
    });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    const acme = card("Acme");
    await waitFor(() =>
      expect(acme.querySelector("[data-fact-skeleton]")).toBeNull(),
    );
    expect(row(acme, "license").textContent).toBe("License");
    expect(row(acme, "config").textContent).toBe("ConfigSchema v1");
    expect(within(main()).queryByRole("alert")).toBeNull();
  });

  it("says when a repository-linked product last synced, and when a manual one changed", async () => {
    boot("#/", { extra: registry() });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(card("DJDL").textContent).toMatch(/Synced /);
    expect(card("Acme").textContent).toMatch(/Changed /);
  });

  it("lists attention items from the registry's setup state, each with one action (DSH-1)", async () => {
    boot("#/", { extra: registry() });
    await home();
    const list = await within(main()).findByRole("region", {
      name: "Needs attention",
    });
    expect(
      within(list).getByText("Missing required secret OIDC_CLIENT_SECRET"),
    ).toBeTruthy();
    expect(
      within(list)
        .getByRole("link", { name: /Set secret/ })
        .getAttribute("href"),
    ).toBe("#/p/djdl/keys");
    expect(
      within(list)
        .getByRole("link", { name: /Review recipe/ })
        .getAttribute("href"),
    ).toBe("#/p/djdl/config/edge-mint");
  });

  it("retires the Setup complete figure: healthy is silence (EXPERIENCE C2)", async () => {
    boot("#/", { extra: registry() });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(within(main()).queryByText("Setup complete")).toBeNull();
    expect(within(main()).queryByText("1 of 2")).toBeNull();
    expect(within(main()).getByText("Need attention")).toBeTruthy();
    expect(within(main()).getByText("Linked to a repository")).toBeTruthy();
  });

  it("omits the attention list when nothing needs the operator", async () => {
    boot("#/");
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(
      within(main()).queryByRole("region", { name: "Needs attention" }),
    ).toBeNull();
  });

  it("first run: opens the wizard with the source chosen (DSH-6)", async () => {
    boot("#/", { me: { products: [] } });
    await home();
    expect(
      await within(main()).findByText("Register your first product"),
    ).toBeTruthy();
    expect(
      within(main())
        .getByRole("link", { name: /Link a repository/ })
        .getAttribute("href"),
    ).toBe("#/products/new?via=github");
    expect(
      within(main())
        .getByRole("link", { name: "Start manually" })
        .getAttribute("href"),
    ).toBe("#/products/new?via=manual");
    expect(within(main()).queryByText(/grant access/i)).toBeNull();
    expect(within(main()).queryByText(/Product administrator/)).toBeNull();
  });

  it("shows loading tiles and cards while the registry loads", async () => {
    boot("#/", { extra: { "/manage/api/products": PENDING } });
    await home();
    expect(
      within(main())
        .getByRole("list", { name: "Products" })
        .getAttribute("aria-busy"),
    ).toBe("true");
    expect(within(main()).getByText("Loading Products")).toBeTruthy();
  });

  it("shows a retryable error when the registry cannot load", async () => {
    boot("#/", {
      extra: {
        "/manage/api/products": new Response(
          JSON.stringify({ error: "internal" }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
      },
    });
    await home();
    const alert = await within(main()).findByRole("alert");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("one name for the registry, and New product opens the wizard (DSH-5)", async () => {
    boot("#/", { extra: registry() });
    await home();
    expect(within(main()).queryByText(/registry/i)).toBeNull();
    expect(within(main()).queryByText(ME.email)).toBeNull();
    expect(
      within(main())
        .getByRole("link", { name: /New product/ })
        .getAttribute("href"),
    ).toBe("#/products/new");
  });

  it("passes axe", async () => {
    boot("#/", { extra: registry() });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    const results = await axe(main());
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
