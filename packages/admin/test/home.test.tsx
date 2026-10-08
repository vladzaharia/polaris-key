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
 * request, simplified in the owner polish of 2026-10-07: the logo, the name and slug (and a pill
 * when the product needs something), then one row of icons for the services it runs, named, with
 * no facts and no rows; below the small breakpoint, the name and one pip per service in that
 * service's accent. Driven through the whole console so the registry query, the router and the
 * shell are the real ones.
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
/** The card's service icons (each a link), in order. */
const icons = (c: HTMLElement): HTMLElement[] =>
  Array.from(c.querySelectorAll<HTMLElement>("[data-service-link]"));
const iconIds = (c: HTMLElement): (string | null)[] =>
  icons(c).map((i) => i.getAttribute("data-service-link"));
/** The phone's pips, in order. */
const pips = (c: HTMLElement): HTMLElement[] =>
  Array.from(c.querySelectorAll<HTMLElement>("[data-pip]"));

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

  it("the main section is one row of named service icons, each linking to its service, and nothing else", async () => {
    const log = boot("#/", { extra: registry() });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    const acme = card("Acme");
    expect(iconIds(acme)).toEqual(["license", "config", "release"]);
    const list = within(acme).getByRole("list", { name: "Services" });
    for (const [label, href] of [
      ["License", "#/p/acme/license/licenses"],
      ["Config", "#/p/acme/config/catalog"],
      ["Release", "#/p/acme/release/releases"],
    ]) {
      const link = within(list).getByRole("link", { name: label });
      expect(link.getAttribute("href")).toBe(href);
      expect(link.getAttribute("title")).toBe(label);
      // The glyph is the whole link: no label text, no fact.
      expect(link.textContent).toBe("");
      expect(link.querySelector("[data-service]")).not.toBeNull();
    }
    // No rows, no facts, no footer, no healthy pill.
    expect(acme.querySelector("[data-service-row]")).toBeNull();
    expect(acme.textContent).not.toMatch(/Schema|active|Synced|Changed|more/);
    expect(acme.querySelector("[data-status=pill]")).toBeNull();
    expect(within(acme).queryByText("Setup complete")).toBeNull();
    // The facts' read is gone with them.
    expect(log.calls.some((c) => c.path === "/manage/api/summary")).toBe(false);
  });

  it("every service the product runs gets an icon, in the service table's order", async () => {
    boot("#/", { extra: registry() });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(iconIds(card("DJDL"))).toEqual([
      "license",
      "config",
      "release",
      "distribution",
      "update",
      "identity",
      "sync",
    ]);
    for (const [label, href] of [
      ["Distribution", "#/p/djdl/distribution/matrix"],
      ["Update", "#/p/djdl/update/feed"],
      ["Identity", "#/p/djdl/identity/portal"],
      ["Cloud Sync", "#/p/djdl/sync/data"],
    ])
      expect(
        within(card("DJDL"))
          .getByRole("link", { name: label })
          .getAttribute("href"),
      ).toBe(href);
  });

  it("a product with one service shows one icon", async () => {
    const solo = {
      ...productRow("djdl", "DJDL", only("license")),
      modifiedAt: 5,
    };
    boot("#/", { extra: { "/manage/api/products": { products: [solo] } } });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(iconIds(card("DJDL"))).toEqual(["license"]);
  });

  it("issues sit in the header's pill, never in the icon row: several are counted", async () => {
    boot("#/", { extra: registry() });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    const djdl = card("DJDL");
    const header = djdl.querySelector("[data-card-header]")!;
    const last = header.lastElementChild!;
    expect(last.getAttribute("data-status")).toBe("pill");
    expect(last.textContent).toBe("2 need attention");
    expect(djdl.querySelector("[data-service-icons] [data-status]")).toBeNull();
  });

  it("one issue on a service is named in the header pill", () => {
    const issue: ProductAttention = {
      id: "djdl:identity",
      product: { slug: "djdl", name: "DJDL" },
      kind: "secret.missing",
      tone: "warning",
      reason: "Secret missing",
      service: "identity",
      short: "Secret missing",
      action: { label: "Fix", href: "#/p/djdl/keys" },
    };
    const { container } = render(
      <ProductCard
        product={productRow("djdl", "DJDL", ALL_ON) as unknown as ProductDetail}
        attention={[issue]}
      />,
    );
    const header = container.querySelector("[data-card-header]")!;
    expect(header.lastElementChild!.textContent).toBe("Secret missing");
    expect(header.lastElementChild!.getAttribute("data-tone")).toBe("warning");
  });

  it("below the small breakpoint: only the name and one pip per service in its accent, named together", async () => {
    boot("#/", { extra: registry() });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    const acme = card("Acme");
    // One pip per service, each scoped to its service's accent token (no colour named in code).
    expect(pips(acme).map((p) => p.getAttribute("data-service"))).toEqual([
      "license",
      "config",
      "release",
    ]);
    for (const p of pips(acme)) {
      expect(p.className).toMatch(/\bbg-accent\b/);
      expect(p.className).toMatch(/\brounded-full\b/);
    }
    const group = within(acme).getByRole("img", {
      name: "Runs License, Config and Release",
    });
    expect(group.className).toMatch(/\bsm:hidden\b/);
    // Everything else steps aside on a phone: the logo, the slug, the pill and the icon row.
    const hiddenOnPhone = (el: Element | null) =>
      expect(el?.getAttribute("class") ?? "").toMatch(/\bmax-sm:hidden\b/);
    hiddenOnPhone(acme.querySelector("[data-logo]"));
    hiddenOnPhone(within(acme).getByText("acme"));
    hiddenOnPhone(acme.querySelector("[data-service-icons]")!.parentElement);
    hiddenOnPhone(
      card("DJDL").querySelector("[data-card-header] [data-status=pill]"),
    );
    // The name, the card's one link, stays.
    expect(
      within(acme).getByRole("link", { name: "Acme" }).className,
    ).not.toMatch(/(^|\s)(max-sm:)?hidden(\s|$)/);
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
    expect(icons(card("DJDL"))).toHaveLength(0);
    expect(pips(card("DJDL"))).toHaveLength(0);
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
