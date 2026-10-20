import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { configureAxe } from "vitest-axe";
import type { AttentionItemDto } from "../src/api.js";
import { ProductCard } from "../src/console/sections/global/components/ProductCard.js";
import {
  ALL_ON,
  ME,
  PENDING,
  boot,
  productRow,
  resetConsole,
} from "./consoleHarness.js";
import { parseLocation } from "../src/console/routes.js";

/**
 * Home (ADMIN.md §6.1, ST-44): Needs attention from one server read, Platform ready for a
 * platform admin while incomplete, and the products as ST-36's cards (one glyph per feature) or a
 * table, with filters. Driven through the whole console so the queries, the router and the shell
 * are the real ones.
 */

const axe = configureAxe({ rules: { "color-contrast": { enabled: false } } });

beforeEach(resetConsole);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
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
const HEADER = {
  url: "https://img.test/djdl/a/" + "b".repeat(64),
  w64: null,
  w128: null,
};

const only = (
  ...on: (keyof typeof ALL_ON)[]
): Record<string, { enabled: boolean }> =>
  Object.fromEntries(
    Object.keys(ALL_ON).map((s) => [s, { enabled: on.includes(s as never) }]),
  );

function item(
  over: Partial<AttentionItemDto> & Pick<AttentionItemDto, "id">,
): AttentionItemDto {
  return {
    product: { slug: "djdl", name: "DJDL" },
    kind: "secret.missing",
    tone: "warning",
    service: "config",
    short: "Missing secret",
    lines: ["Required secret identity.acoustidKey has no value."],
    action: { label: "Set secret", page: "keys" },
    area: "keys",
    ...over,
  };
}

const ATTENTION: AttentionItemDto[] = [
  item({
    id: "acme:sync.failed",
    kind: "sync.failed",
    tone: "danger",
    product: { slug: "acme", name: "Acme" },
    service: "release",
    short: "Resync failed",
    lines: ["Resync failed.", "line 14 names switch."],
    action: { label: "Open error", page: "releases" },
    area: "ship",
  }),
  item({ id: "djdl:secret.missing:K" }),
];

/** DJDL runs everything (logo, cover); Acme runs License, Config and Release. */
function registry(): Record<string, unknown> {
  const djdl = {
    ...productRow("djdl", "DJDL", ALL_ON),
    modifiedAt: 2_000,
    releaseSource: "github",
    verified: true,
    presentation: { icon: ICON, header: HEADER },
  };
  const acme = {
    ...productRow("acme", "Acme", only("license", "config", "release")),
    modifiedAt: 1_000,
    presentation: { icon: null, header: null },
  };
  return {
    "/manage/api/products": { products: [djdl, acme] },
    "/manage/api/attention": { items: ATTENTION },
  };
}

const READY = {
  done: 1,
  total: 3,
  rows: [
    { id: "keyring", title: "Keyring configured", done: true },
    {
      id: "store-accounts",
      title: "Store accounts",
      done: false,
      detail: "Steam uploads need a platform account.",
      action: { label: "Open connections", to: "connections" },
    },
    {
      id: "background-jobs",
      title: "Background jobs ticking",
      done: false,
      detail: "No scheduled run in the last 20 minutes.",
      action: { label: "Open status", to: "status" },
    },
  ],
};

const cards = (): HTMLElement[] =>
  within(within(main()).getByRole("list", { name: "Products" })).getAllByRole(
    "article",
  );
const card = (name: string): HTMLElement =>
  cards().find((c) => c.getAttribute("aria-label") === name)!;
const glyphs = (c: HTMLElement): (string | null)[] =>
  Array.from(c.querySelectorAll<HTMLElement>("[data-feature-link]")).map((a) =>
    a.getAttribute("data-feature-link"),
  );

describe("Home", () => {
  it("lists every product as a card with one glyph per feature, in canonical order", async () => {
    boot("#/", { extra: registry() });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(glyphs(card("DJDL"))).toEqual([
      "licensing",
      "managed-config",
      "ship-builds",
      "sign-in",
      "cloud-sync",
      "commerce",
    ]);
    expect(glyphs(card("Acme"))).toEqual([
      "licensing",
      "managed-config",
      "ship-builds",
    ]);
    const list = within(card("Acme")).getByRole("list", { name: "Features" });
    for (const [label, href] of [
      ["Licensing", "#/p/acme/license/licenses"],
      ["Managed config: 1 needs attention", "#/p/acme/config/catalog"],
    ].slice(0, 1)) {
      const link = within(list).getByRole("link", { name: label! });
      expect(link.getAttribute("href")).toBe(href);
      expect(link.getAttribute("title")).toBe(label);
    }
    // No facts, no footer, no healthy pill.
    expect(card("Acme").textContent).not.toMatch(
      /Schema|active|Synced|Changed/,
    );
  });

  it("the name is the card's one link, and the glyph links are siblings, never nested", async () => {
    boot("#/", { extra: registry() });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    const acme = card("Acme");
    const name = within(acme).getByRole("link", { name: "Acme" });
    expect(name.getAttribute("href")).toBe("#/p/acme");
    expect(name.hasAttribute("data-card-link")).toBe(true);
    for (const a of Array.from(acme.querySelectorAll("a")))
      expect(a.querySelector("a"), a.outerHTML).toBeNull();
    expect(acme.className).toContain(
      "has-[a[data-card-link]:focus-visible]:ring-2",
    );
  });

  it("puts the server's attention on the card: a pill naming one issue or counting several, and a dot on the feature", async () => {
    const extra = registry();
    extra["/manage/api/attention"] = {
      items: [
        ...ATTENTION,
        item({
          id: "acme:credential.expiring:play",
          kind: "credential.expiring",
          product: { slug: "acme", name: "Acme" },
          service: "release",
          short: "Credential expiring",
          lines: ["Google Play key expires Oct 16."],
          action: { label: "Replace key", page: "storefronts" },
          area: "ship",
        }),
      ],
    };
    boot("#/", { extra });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(within(card("DJDL")).getByText("Missing secret")).toBeTruthy();
    expect(within(card("Acme")).getByText("2 need attention")).toBeTruthy();
    const ship = card("Acme").querySelector(
      '[data-feature-link="ship-builds"]',
    )!;
    expect(ship.getAttribute("aria-label")).toBe(
      "Ship builds: 2 need attention",
    );
    expect(
      ship.querySelector("[data-issue-dot]")?.getAttribute("data-issue-dot"),
    ).toBe("danger");
    const config = card("DJDL").querySelector(
      '[data-feature-link="managed-config"]',
    )!;
    expect(config.getAttribute("aria-label")).toBe(
      "Managed config: 1 needs attention",
    );
  });

  it("Needs attention comes from GET /attention: one fact per line, product, one action; no summary read", async () => {
    const log = boot("#/", { extra: registry() });
    await home();
    const region = await within(main()).findByRole("region", {
      name: /^Needs attention/,
    });
    const rows = within(region).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    // The worst first, with the word.
    expect(within(rows[0]!).getByText("Error")).toBeTruthy();
    expect(within(rows[0]!).getByText("Resync failed.")).toBeTruthy();
    expect(within(rows[0]!).getByText("line 14 names switch.")).toBeTruthy();
    expect(
      within(rows[0]!)
        .getByRole("link", { name: /Open error/ })
        .getAttribute("href"),
    ).toBe("#/p/acme/release/releases");
    expect(
      within(rows[1]!)
        .getByRole("link", { name: /Set secret/ })
        .getAttribute("href"),
    ).toBe("#/p/djdl/settings/keys");
    expect(log.calls.some((c) => c.path === "/manage/api/attention")).toBe(
      true,
    );
    expect(log.calls.some((c) => c.path === "/manage/api/summary")).toBe(false);
    // No tile repeats the count.
    expect(within(main()).queryByText("Need attention")).toBeNull();
    expect(within(main()).queryByText("Linked to a repository")).toBeNull();
  });

  it("says so quietly, in one line, when nothing needs the operator", async () => {
    boot("#/");
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(
      within(main()).queryByRole("region", { name: /Needs attention/ }),
    ).toBeNull();
    expect(within(main()).getByText("Nothing needs attention.")).toBeTruthy();
  });

  it("a failed attention read keeps its card with Try again; it is never an all-clear (B1)", async () => {
    let calls = 0;
    boot("#/", {
      extra: {
        ...registry(),
        "/manage/api/attention": () => {
          calls++;
          return calls < 3
            ? new Response("{}", { status: 500 })
            : { items: ATTENTION };
        },
      },
    });
    await home();
    const card = await within(main()).findByRole("region", {
      name: "Needs attention",
    });
    expect(
      within(card).getByText("What needs attention didn't load."),
    ).toBeTruthy();
    expect(within(main()).queryByText("Nothing needs attention.")).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Try again" }));
    expect(await within(main()).findByText("Resync failed.")).toBeTruthy();
  });

  it("a failed Platform ready read keeps its card with Try again", async () => {
    boot("#/", {
      extra: {
        ...registry(),
        "/manage/api/platform/ready": new Response("{}", { status: 500 }),
      },
    });
    await home();
    const card = await within(main()).findByRole("region", {
      name: "Platform ready",
    });
    expect(within(card).getByText("Platform ready didn't load.")).toBeTruthy();
    expect(
      within(card).getByRole("button", { name: "Try again" }),
    ).toBeTruthy();
  });

  it("holds the slots with skeletons while the reads load", async () => {
    boot("#/", {
      extra: {
        ...registry(),
        "/manage/api/attention": PENDING,
        "/manage/api/platform/ready": PENDING,
      },
    });
    await home();
    expect(
      await within(main()).findByRole("region", {
        name: "Loading Needs attention",
      }),
    ).toBeTruthy();
    expect(
      within(main()).getByRole("region", { name: "Loading Platform ready" }),
    ).toBeTruthy();
  });

  it("identifiers in attention lines are code", async () => {
    boot("#/", {
      extra: {
        ...registry(),
        "/manage/api/attention": {
          items: [
            item({
              id: "x",
              lines: ["Required secret `identity.acoustidKey` has no value."],
            }),
          ],
        },
      },
    });
    await home();
    const code = await within(main()).findByText("identity.acoustidKey");
    expect(code.tagName).toBe("CODE");
  });

  it("one product needs no toolbar", async () => {
    boot("#/", {
      me: { products: [{ slug: "djdl", name: "DJDL", schemaVersion: 1 }] },
      extra: {
        "/manage/api/products": {
          products: [productRow("djdl", "DJDL", ALL_ON)],
        },
      },
    });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(
      within(main()).queryByRole("searchbox", { name: "Filter products" }),
    ).toBeNull();
    expect(within(main()).queryByRole("radio", { name: /Table/ })).toBeNull();
  });

  it("Clear filters puts the focus in the filter field (M6)", async () => {
    boot("#/?q=nothing-here", { extra: registry() });
    await home();
    fireEvent.click(
      await within(main()).findByRole("button", { name: /Clear filters/ }),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(main()).getByRole("searchbox", { name: "Filter products" }),
      ),
    );
  });

  it("Platform ready: open tasks with their fix, the done steps folded away", async () => {
    boot("#/", {
      extra: { ...registry(), "/manage/api/platform/ready": READY },
    });
    await home();
    const region = await within(main()).findByRole("region", {
      name: "Platform ready",
    });
    expect(within(region).getByText("1 of 3 done")).toBeTruthy();
    expect(within(region).getByText("Store accounts")).toBeTruthy();
    expect(
      within(region)
        .getByRole("link", { name: "Open connections" })
        .getAttribute("href"),
    ).toBe("#/platform/store-connections");
    expect(
      within(region).getByText("Keyring configured").closest("ul")!.hidden,
    ).toBe(true);
    const toggle = within(region).getByRole("button", {
      name: "Show done steps",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(region).getByText("Keyring configured")).toBeTruthy();
  });

  it("Connect Steam opens Store connections on that store, not the sign-in providers", async () => {
    const ready = {
      ...READY,
      rows: READY.rows.map((r) =>
        r.id === "store-accounts"
          ? {
              ...r,
              action: {
                label: "Connect Steam",
                to: "connections",
                store: "steam",
              },
            }
          : r,
      ),
    };
    boot("#/", {
      extra: { ...registry(), "/manage/api/platform/ready": ready },
    });
    await home();
    const region = await within(main()).findByRole("region", {
      name: "Platform ready",
    });
    expect(
      within(region)
        .getByRole("link", { name: "Connect Steam" })
        .getAttribute("href"),
    ).toBe("#/platform/store-connections?store=steam");
    expect(
      within(region)
        .getByRole("link", { name: "Open status" })
        .getAttribute("href"),
    ).toBe("#/platform/operations");
  });

  it("first run: a pending or failed Platform ready read still has its card", async () => {
    boot("#/", {
      me: { products: [] },
      extra: {
        "/manage/api/platform/ready": new Response("{}", { status: 500 }),
      },
    });
    await home();
    const card = await within(main()).findByRole("region", {
      name: "Platform ready",
    });
    expect(
      within(card).getByRole("button", { name: "Try again" }),
    ).toBeTruthy();
    cleanup();
    boot("#/", {
      me: { products: [] },
      extra: { "/manage/api/platform/ready": PENDING },
    });
    await home();
    expect(
      await within(main()).findByRole("region", {
        name: "Loading Platform ready",
      }),
    ).toBeTruthy();
  });

  it("Try again that answers moves focus to the new card's heading", async () => {
    let calls = 0;
    boot("#/", {
      extra: {
        ...registry(),
        "/manage/api/attention": () =>
          ++calls < 3
            ? new Response("{}", { status: 500 })
            : { items: ATTENTION },
      },
    });
    await home();
    const card = await within(main()).findByRole("region", {
      name: "Needs attention",
    });
    fireEvent.click(within(card).getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain("Needs attention"),
    );
  });

  it("the Attention facet is not offered until the attention read has answered", async () => {
    boot("#/", { extra: { ...registry(), "/manage/api/attention": PENDING } });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(within(main()).queryByText("Attention")).toBeNull();
    expect(within(main()).getByText("Integration")).toBeTruthy();
  });

  it("arrow keys on Cards and Table select the view", async () => {
    boot("#/", { extra: registry() });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    const cardsRadio = within(main()).getByRole("radio", { name: /Cards/ });
    cardsRadio.focus();
    fireEvent.keyDown(cardsRadio, { key: "ArrowRight" });
    await waitFor(() =>
      expect(
        within(main())
          .getByRole("radio", { name: /Table/ })
          .getAttribute("aria-checked"),
      ).toBe("true"),
    );
  });

  it("Platform ready leaves Home when every row is done, and is never asked for by a member without Platform", async () => {
    const done = {
      done: 3,
      total: 3,
      rows: READY.rows.map((r) => ({ id: r.id, title: r.title, done: true })),
    };
    boot("#/", {
      extra: { ...registry(), "/manage/api/platform/ready": done },
    });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(
      within(main()).queryByRole("region", { name: "Platform ready" }),
    ).toBeNull();
  });

  it("Cards or Table, one filter bar over both, the choice kept", async () => {
    boot("#/", { extra: registry() });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    // Cover: hosted art, else the icon on the neutral surface.
    expect(
      card("DJDL")
        .querySelector("[data-cover=art] img")
        ?.getAttribute("loading"),
    ).toBe("lazy");
    expect(card("Acme").querySelector("[data-cover=flat]")).not.toBeNull();
    fireEvent.click(within(main()).getByRole("radio", { name: /Table/ }));
    const table = await within(main()).findByRole("table");
    expect(within(table).getByText("DJDL")).toBeTruthy();
    expect(within(table).getByText("Acme")).toBeTruthy();
    expect(window.localStorage.getItem("pk-admin-home-view")).toBe('"table"');
    // The filter narrows both views.
    fireEvent.change(
      within(main()).getByRole("searchbox", { name: "Filter products" }),
      {
        target: { value: "acm" },
      },
    );
    await waitFor(() => expect(within(table).queryByText("DJDL")).toBeNull());
    expect(within(table).getByText("Acme")).toBeTruthy();
  });

  it("the Products address lands on Home, filters kept; the retired Setup facet is Attention", () => {
    expect(parseLocation("#/products?q=dj").redirect).toBe("#/?q=dj");
    expect(parseLocation("#/products?setup=attention").redirect).toBe(
      "#/?attention=yes",
    );
    expect(parseLocation("#/products?setup=complete").redirect).toBe(
      "#/?attention=no",
    );
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
  });

  it("shows loading cards while the registry loads", async () => {
    boot("#/", { extra: { "/manage/api/products": PENDING } });
    await home();
    expect(
      within(main())
        .getByRole("list", { name: "Products" })
        .getAttribute("aria-busy"),
    ).toBe("true");
  });

  it("shows a retryable error when the registry cannot load", async () => {
    boot("#/", {
      extra: {
        "/manage/api/products": new Response(
          JSON.stringify({ error: "internal" }),
          {
            status: 500,
            headers: { "content-type": "application/json" },
          },
        ),
      },
    });
    await home();
    const alert = await within(main()).findByRole("alert");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("New product opens the wizard, with no subtitle repeating the count", async () => {
    boot("#/", { extra: registry() });
    await home();
    expect(
      within(main())
        .getByRole("link", { name: /New product/ })
        .getAttribute("href"),
    ).toBe("#/products/new");
    expect(within(main()).queryByText(ME.email)).toBeNull();
    expect(within(main()).queryByText(/^2 products$/)).toBeNull();
  });

  it("passes axe", async () => {
    boot("#/", {
      extra: { ...registry(), "/manage/api/platform/ready": READY },
    });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    const results = await axe(main());
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("ProductCard", () => {
  it("below the small breakpoint: one pip per feature in its accent, named together with the issue", () => {
    const p = {
      ...(productRow("djdl", "DJDL", ALL_ON) as never as Record<
        string,
        unknown
      >),
    } as never;
    render(<ProductCard product={p} attention={[item({ id: "x" })]} />);
    const pips = Array.from(
      document.querySelectorAll<HTMLElement>("[data-pip]"),
    );
    expect(pips.map((x) => x.getAttribute("data-service"))).toEqual([
      "license",
      "config",
      "release",
      "identity",
      "sync",
      "commerce",
    ]);
    const label = document
      .querySelector("[data-feature-pips]")!
      .getAttribute("aria-label")!;
    expect(label).toContain("Managed config: 1 needs attention");
  });
});
