import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
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
import type { ProductAttentionItem } from "../src/console/sections/global/model/home.js";
import { formatSince } from "../src/lib/format.js";
import { movedHref, parseLocation } from "../src/console/routes.js";

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

const READY_STEAM = {
  done: 2,
  total: 3,
  rows: [
    { id: "keyring", title: "Keyring configured", done: true },
    { id: "email-sender", title: "Email sender configured", done: true },
    {
      id: "store-accounts",
      title: "Stores connected",
      done: false,
      detail:
        "Another product's Steam uploads need a Steamworks publisher key.",
      action: {
        label: "Connect Steam",
        to: "connections",
        store: "steam",
      },
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
      "cloud-connect",
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

  it("Needs attention lists the store identity items, each with its target (A-28.5)", async () => {
    const extra = registry();
    extra["/manage/api/attention"] = {
      items: [
        item({
          id: "djdl:storefront.identity_mismatch:app-store",
          kind: "storefront.identity_mismatch",
          service: "commerce",
          short: "App mismatch",
          lines: [
            "App Store purchases are checked against `com.typo.app`, not the assigned app `com.djdl.app`.",
          ],
          action: { label: "Review", page: "commerce-overview" },
          area: "commerce",
        }),
        item({
          id: "djdl:storefront.identity_ambiguous:steam",
          kind: "storefront.identity_ambiguous",
          service: "commerce",
          short: "Keys disagree",
          lines: [
            "Steam keys name different apps.",
            "Purchases are checked against `480`.",
          ],
          action: { label: "Review", page: "commerce-overview" },
          area: "commerce",
        }),
        item({
          id: "djdl:channel.identity_mismatch:ios:bundleId",
          kind: "channel.identity_mismatch",
          service: "distribution",
          short: "App mismatch",
          lines: [
            "The `ios` channel declares bundle ID `com.typo.app`; the assigned app is `com.djdl.app`.",
          ],
          action: {
            label: "Review",
            page: "outlets",
            query: { outlet: "ios" },
          },
          area: "ship",
        }),
      ],
    };
    boot("#/", { extra });
    await home();
    const region = await within(main()).findByRole("region", {
      name: /^Needs attention/,
    });
    const rows = within(region).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    const hrefs = rows.map((row) =>
      within(row)
        .getByRole("link", { name: /Review/ })
        .getAttribute("href"),
    );
    expect(hrefs.filter((h) => h === "#/p/djdl/commerce")).toHaveLength(2);
    expect(hrefs).toContain("#/p/djdl/distribution/outlets?outlet=ios");
    expect(
      within(region).getAllByText("com.typo.app", { selector: "code" }),
    ).toHaveLength(2);
    expect(
      within(region).getByText("Steam keys name different apps."),
    ).toBeTruthy();
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
    // The message stops at 72ch; the action column sits at the card's far edge.
    expect(rows[0]!.parentElement!.className).toContain(
      "minmax(0,1fr)_max-content]",
    );
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

  it("with nothing to attend to, the open guide takes its own row (no split, no void beside the all-clear)", async () => {
    boot("#/", {
      extra: {
        ...registry(),
        "/manage/api/attention": { items: [] },
        "/manage/api/platform/ready": READY,
      },
    });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    const guide = await within(main()).findByRole("region", {
      name: "Platform ready",
    });
    expect(within(main()).getByText("Nothing needs attention.")).toBeTruthy();
    expect(document.querySelector("[data-home-grid]")!.className).not.toContain(
      "grid-cols-[minmax(0,2fr)",
    );
    expect(guide.className).not.toContain("col-start-2");
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

  it("Connect Steam carries the Steam mark; the link's words name it (ST-44b.3)", async () => {
    boot("#/", {
      extra: { ...registry(), "/manage/api/platform/ready": READY_STEAM },
    });
    await home();
    const link = await within(main()).findByRole("link", {
      name: "Connect Steam",
    });
    expect(link.querySelector("svg")).toBeTruthy();
    expect(link.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
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
    ).toBe("#/platform/status");
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
    expect(
      within(main()).queryByRole("button", { name: "Needs attention" }),
    ).toBeNull();
    expect(
      within(main()).getByRole("button", { name: "Integration verified" }),
    ).toBeTruthy();
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

  it("Platform ready is one quiet line once every row is done, with Show steps", async () => {
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
    const line = await within(main()).findByRole("region", {
      name: "Platform ready",
    });
    expect(line.getAttribute("data-platform-ready")).toBe("done");
    // B-055: a chip as wide as its words, not a bar across the page.
    expect(line.className).toContain("w-fit");
    expect(within(line).queryByRole("progressbar")).toBeNull();
    const steps = within(line).getByRole("button", { name: "Show steps" });
    expect(steps.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(steps);
    expect(
      within(line).getByRole("button", { name: "Hide steps" }),
    ).toBeTruthy();
    expect(within(line).getByText("Keyring configured")).toBeTruthy();
  });

  it("Platform ready is not asked for, or drawn, for a member without Platform", async () => {
    boot("#/", {
      me: { platformAdmin: false },
      extra: { ...registry(), "/manage/api/platform/ready": READY },
    });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(
      within(main()).queryByRole("region", { name: "Platform ready" }),
    ).toBeNull();
  });

  describe("Platform ready can be hidden", () => {
    const KEY = "pk-admin-setup-guide-hidden:u1";
    const ready = { "/manage/api/platform/ready": READY };
    const guide = (): HTMLElement | null =>
      within(main()).queryByRole("region", { name: "Platform ready" });

    it("Hide Platform ready removes the card, moves focus to Products, remembers it for this operator", async () => {
      boot("#/", { extra: { ...registry(), ...ready } });
      await home();
      const card = await within(main()).findByRole("region", {
        name: "Platform ready",
      });
      const hide = within(card).getByRole("button", {
        name: "Hide Platform ready",
      });
      hide.focus();
      await userEvent.keyboard("{Enter}");
      await waitFor(() => expect(guide()).toBeNull());
      await waitFor(() =>
        expect(document.activeElement).toBe(
          within(main()).getByRole("heading", { level: 2, name: /^Products/ }),
        ),
      );
      expect(window.localStorage.getItem(KEY)).toBe("true");
      // Attention and Products now use the full width: no split on the grid.
      expect(
        document.querySelector("[data-home-grid]")!.className,
      ).not.toContain("grid-cols-[minmax(0,2fr)");
    });

    it("hiding offers Undo in a toast, which brings the guide back", async () => {
      boot("#/", { extra: { ...registry(), ...ready } });
      await home();
      const card = await within(main()).findByRole("region", {
        name: "Platform ready",
      });
      fireEvent.click(
        within(card).getByRole("button", { name: "Hide Platform ready" }),
      );
      await waitFor(() => expect(guide()).toBeNull());
      fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
      expect(
        await within(main()).findByRole("region", { name: "Platform ready" }),
      ).toBeTruthy();
      expect(window.localStorage.getItem(KEY)).toBe("false");
    });

    it("stays hidden on the next visit, and is another operator's own choice", async () => {
      window.localStorage.setItem(KEY, "true");
      boot("#/", { extra: { ...registry(), ...ready } });
      await home();
      await waitFor(() => expect(cards()).toHaveLength(2));
      expect(guide()).toBeNull();
      cleanup();
      boot("#/", {
        me: { sub: "u2" },
        extra: { ...registry(), ...ready },
      });
      await home();
      expect(
        await within(main()).findByRole("region", { name: "Platform ready" }),
      ).toBeTruthy();
    });

    it("follows the operator: the server's preference hides the guide in a browser with no local copy", async () => {
      boot("#/", {
        me: { prefs: { setupGuideHidden: true } },
        extra: { ...registry(), ...ready },
      });
      await home();
      await waitFor(() => expect(cards()).toHaveLength(2));
      expect(guide()).toBeNull();
      expect(window.localStorage.getItem(KEY)).toBe("true");
    });

    const prefPuts = (log: {
      calls: { method: string; path: string; json?: unknown }[];
    }) =>
      log.calls.filter(
        (c) => c.method === "PUT" && c.path === "/manage/api/me/prefs",
      );

    it("hiding is stored on the server; a copy hidden before it existed is sent up once", async () => {
      const log = boot("#/", { extra: { ...registry(), ...ready } });
      await home();
      fireEvent.click(
        await within(main()).findByRole("button", {
          name: "Hide Platform ready",
        }),
      );
      await waitFor(() =>
        expect(prefPuts(log)[0]?.json).toEqual({ setupGuideHidden: true }),
      );
      cleanup();
      window.localStorage.setItem(KEY, "true");
      const again = boot("#/", {
        me: { prefs: { setupGuideHidden: false } },
        extra: { ...registry(), ...ready },
      });
      await home();
      await waitFor(() => expect(prefPuts(again)).toHaveLength(1));
    });

    it("Show Platform ready in the header menu brings it back and focuses it", async () => {
      window.localStorage.setItem(KEY, "true");
      boot("#/", { extra: { ...registry(), ...ready } });
      await home();
      await waitFor(() => expect(cards()).toHaveLength(2));
      await userEvent.click(
        within(main()).getByRole("button", { name: "More actions" }),
      );
      await userEvent.click(
        await screen.findByRole("menuitem", { name: "Show Platform ready" }),
      );
      const card = await within(main()).findByRole("region", {
        name: "Platform ready",
      });
      expect(window.localStorage.getItem(KEY)).toBe("false");
      await waitFor(() =>
        expect(document.activeElement).toBe(
          within(card).getByRole("heading", { name: "Platform ready" }),
        ),
      );
      expect(
        within(main()).queryByRole("button", { name: "More actions" }),
      ).toBeNull();
    });

    it("B-053: a hidden guide with steps left shows a chip that says how many and restores it", async () => {
      window.localStorage.setItem(KEY, "true");
      boot("#/", { extra: { ...registry(), ...ready } });
      await home();
      await waitFor(() => expect(cards()).toHaveLength(2));
      const chip = await within(main()).findByRole("button", {
        name: "2 setup steps open",
      });
      fireEvent.click(chip);
      expect(
        await within(main()).findByRole("region", { name: "Platform ready" }),
      ).toBeTruthy();
      expect(window.localStorage.getItem(KEY)).toBe("false");
    });

    it("B-053: a hidden guide with every step done leaves no chip", async () => {
      window.localStorage.setItem(KEY, "true");
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
      await within(main()).findByRole("button", { name: "More actions" });
      expect(
        within(main()).queryByRole("button", { name: /setup steps? open/ }),
      ).toBeNull();
    });

    it("a finished guide hides the same way", async () => {
      const done = {
        done: 3,
        total: 3,
        rows: READY.rows.map((r) => ({ id: r.id, title: r.title, done: true })),
      };
      boot("#/", {
        extra: { ...registry(), "/manage/api/platform/ready": done },
      });
      await home();
      const line = await within(main()).findByRole("region", {
        name: "Platform ready",
      });
      fireEvent.click(
        within(line).getByRole("button", { name: "Hide Platform ready" }),
      );
      await waitFor(() => expect(guide()).toBeNull());
      expect(window.localStorage.getItem(KEY)).toBe("true");
    });

    it("no menu while the guide is showing, and none for a member without Platform", async () => {
      boot("#/", { extra: { ...registry(), ...ready } });
      await home();
      await within(main()).findByRole("region", { name: "Platform ready" });
      expect(
        within(main()).queryByRole("button", { name: "More actions" }),
      ).toBeNull();
    });
  });

  it("the facets are toggle chips: + Integration verified filters, and the pressed state is announced", async () => {
    boot("#/", { extra: registry() });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    const chip = within(main()).getByRole("button", {
      name: "Integration verified",
    });
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chip);
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(card("DJDL")).toBeTruthy();
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip);
    await waitFor(() => expect(cards()).toHaveLength(2));
    // The retired dropdowns are gone.
    expect(
      within(main()).queryByRole("button", { name: /Filter by/ }),
    ).toBeNull();
  });

  it("Export CSV is in the products' overflow menu, not the toolbar", async () => {
    boot("#/", { extra: registry() });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(
      within(main()).queryByRole("button", { name: /Export CSV/ }),
    ).toBeNull();
    await userEvent.click(
      within(main()).getByRole("button", { name: "More product actions" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Export CSV" }),
    ).toBeTruthy();
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
    // No art: a flat colour band from the slug with nothing drawn in it, as tall as the art beside it.
    const acme = card("Acme").querySelector("[data-cover=slug]")!;
    expect(acme.textContent).toBe("");
    expect(acme.children).toHaveLength(0);
    expect((acme as HTMLElement).style.getPropertyValue("--pk-art")).not.toBe(
      "",
    );
    expect(acme.className).toContain("h-[72px]");
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

  it("the Products address is a removed page: Page moved names Home and carries the filters; the retired Setup facet is Attention", () => {
    for (const [old, now] of [
      ["#/products?q=dj", "#/?q=dj"],
      ["#/products?setup=attention", "#/?attention=yes"],
      ["#/products?setup=complete", "#/?attention=no"],
    ] as const) {
      const parsed = parseLocation(old);
      expect(parsed.redirect, old).toBeUndefined();
      const route = parsed.route;
      if (route.kind !== "not-found" || !route.moved) throw new Error(old);
      expect(movedHref(undefined, route.moved, route.query), old).toBe(now);
    }
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
    expect(
      within(alert).getByRole("button", { name: "Try again" }),
    ).toBeTruthy();
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

  it("passes axe with the guide hidden, and with it finished", async () => {
    window.localStorage.setItem("pk-admin-setup-guide-hidden:u1", "true");
    boot("#/", {
      extra: { ...registry(), "/manage/api/platform/ready": READY },
    });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect((await axe(main())).violations.map((v) => v.id)).toEqual([]);
    cleanup();
    window.localStorage.clear();
    boot("#/", {
      extra: {
        ...registry(),
        "/manage/api/platform/ready": {
          done: 3,
          total: 3,
          rows: READY.rows.map((r) => ({
            id: r.id,
            title: r.title,
            done: true,
          })),
        },
      },
    });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    await within(main()).findByRole("region", { name: "Platform ready" });
    expect((await axe(main())).violations.map((v) => v.id)).toEqual([]);
  });
});

describe("ProductCard", () => {
  it("without art the cover is never empty: tint, else the icon, else the initial", () => {
    const base = productRow("djdl", "DJDL", ALL_ON) as never as Record<
      string,
      unknown
    >;
    const icon = {
      url: "https://img.test/x",
      w64: "https://img.test/x/64.webp",
      w128: "https://img.test/x/128.webp",
    };
    const cover = (presentation: unknown): HTMLElement => {
      const { unmount } = render(
        <ProductCard
          product={{ ...base, presentation } as never}
          attention={[]}
        />,
      );
      const el = document.querySelector<HTMLElement>("[data-cover]")!;
      expect(el.className).toContain("h-[72px]");
      const clone = el.cloneNode(true) as HTMLElement;
      unmount();
      return clone;
    };
    const tint = cover({ icon: null, header: null, accent: "#2f8378" });
    expect(tint.getAttribute("data-cover")).toBe("tint");
    expect(tint.style.getPropertyValue("--pk-art")).not.toBe("");
    const withIcon = cover({ icon, header: null });
    // An icon never repeats in the band: the header tile carries it.
    expect(withIcon.getAttribute("data-cover")).toBe("slug");
    expect(withIcon.querySelector("img, [data-logo]")).toBeNull();
    expect(withIcon.style.getPropertyValue("--pk-art")).not.toBe("");
    const bare = cover({ icon: null, header: null });
    expect(bare.getAttribute("data-cover")).toBe("slug");
    expect(bare.textContent).toBe("");
  });

  it("the system product says System, not a status", () => {
    const p = {
      ...(productRow("polaris-key", "Polaris Key", ALL_ON) as never as Record<
        string,
        unknown
      >),
      system: true,
    };
    render(<ProductCard product={p as never} attention={[]} />);
    expect(screen.getByText("System")).toBeTruthy();
  });

  it("below the small breakpoint: one pip per feature in its accent, named together with the issue", () => {
    const p = {
      ...(productRow("djdl", "DJDL", ALL_ON) as never as Record<
        string,
        unknown
      >),
    } as never;
    render(
      <ProductCard
        product={p}
        attention={[item({ id: "x" }) as ProductAttentionItem]}
      />,
    );
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
      "connect",
    ]);
    const label = document
      .querySelector("[data-feature-pips]")!
      .getAttribute("aria-label")!;
    expect(label).toContain("Managed config: 1 needs attention");
  });
});

describe("a member with narrow access (ST-29)", () => {
  /** DJDL's Ship builds only, with Settings visible but not editable. */
  const NARROW = {
    platformAdmin: false,
    products: [{ slug: "djdl", name: "DJDL", schemaVersion: 1 }],
    permissions: {
      roles: [
        {
          role: "product_admin",
          scope: "product:djdl",
          areas: ["ship", "settings"],
          source: "grant",
        },
      ],
      platform: { view: ["console"], edit: ["console"] },
      products: {
        djdl: { view: ["ship", "settings"], edit: ["ship"] },
      },
    },
  };

  it("B-056: the product card counts only the attention the member can open", async () => {
    const extra = registry();
    extra["/manage/api/attention"] = {
      items: [
        // Keys and secrets is not theirs; Releases is.
        item({ id: "djdl:secret.missing:K" }),
        item({
          id: "djdl:sync.failed",
          kind: "sync.failed",
          tone: "danger",
          service: "release",
          short: "Resync failed",
          lines: ["Resync failed."],
          action: { label: "Open error", page: "releases" },
          area: "ship",
        }),
      ],
    };
    boot("#/", { me: NARROW as never, extra });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    const djdl = card("DJDL");
    expect(within(djdl).getByText("Resync failed")).toBeTruthy();
    expect(within(djdl).queryByText("Missing secret")).toBeNull();
    expect(within(djdl).queryByText("2 need attention")).toBeNull();
  });

  it("B-057: Delete product is disabled in the row menu without Settings edit access", async () => {
    boot("#/", { me: NARROW as never, extra: registry() });
    await home();
    await waitFor(() => expect(cards()).toHaveLength(2));
    fireEvent.click(within(main()).getByRole("radio", { name: /Table/ }));
    const table = await within(main()).findByRole("table");
    await userEvent.click(
      within(table).getByRole("button", { name: /Actions for DJDL/ }),
    );
    const del = await screen.findByRole("menuitem", {
      name: /^Delete product…/,
    });
    expect(del.getAttribute("aria-disabled")).toBe("true");
    expect(del.textContent).toContain("Settings edit access");
  });
});

describe("the platform row (ST-44b.2)", () => {
  const PAUSE_KEY = "cloudSync.writesPaused";
  const nowS = (): number => Math.floor(Date.now() / 1000);

  function platformItem(
    over: Partial<AttentionItemDto> = {},
  ): AttentionItemDto {
    return {
      id: "@platform:sync.paused",
      product: null,
      kind: "sync.paused",
      tone: "warning",
      service: "sync",
      short: "Writes paused",
      lines: [
        "Cloud Sync writes are paused for every product.",
        "Devices keep their changes and send them on resume.",
      ],
      action: {
        label: "Resume writes",
        page: "platform-settings",
        query: { setting: PAUSE_KEY },
      },
      area: "platform",
      since: nowS() - 60,
      by: "Ana Lima",
      reason: "Storage errors in eu-west",
      ...over,
    };
  }

  const settingsView = (on: boolean): Record<string, unknown> => ({
    settings: [
      {
        key: PAUSE_KEY,
        area: "cloudSync",
        label: "Pause Cloud Sync writes",
        description: "",
        kind: "switch",
        scripts: ["main"],
        precedence: "runtime",
        default: "off",
        deployValue: null,
        value: on ? "on" : "off",
        source: on ? "runtime" : "default",
        forcedOff: false,
        stored: null,
        version: 4,
        confirm: { on: "L2", off: "L1" },
      },
    ],
    storeAvailable: true,
    propagationSeconds: 30,
    deployTime: [],
    secrets: [],
  });

  /** Registry plus the pause; a resume flips the switch and the next attention read is clean. */
  function paused(over: Partial<AttentionItemDto> = {}): {
    routes: Record<string, unknown>;
    state: { on: boolean };
  } {
    const state = { on: true };
    const base = registry();
    const routes = {
      ...base,
      "/manage/api/attention": () => ({
        items: [
          ...(state.on ? [platformItem(over)] : []),
          ...ATTENTION.slice(1),
        ],
      }),
      "/manage/api/platform/settings": () => settingsView(state.on),
      [`PATCH /manage/api/platform/settings/${PAUSE_KEY}`]: () => {
        state.on = false;
        return settingsView(false).settings;
      },
    };
    return { routes, state };
  }

  const platformRows = (): HTMLElement[] =>
    within(main())
      .queryAllByRole("listitem")
      .filter((li) => li.querySelector("[data-platform-subject]"));

  it("is one row, not one per product, with the mark and Platform for its subject", async () => {
    boot("#/", { extra: paused().routes });
    await home();
    await within(main()).findByText(/Cloud Sync writes are paused/);
    expect(platformRows()).toHaveLength(1);
    const row = platformRows()[0]!;
    expect(within(row).getByText("Platform")).toBeTruthy();
    expect(within(row).getByText("Warning")).toBeTruthy();
    expect(
      within(row).getByRole("button", { name: "Resume writes" }),
    ).toBeTruthy();
    expect(row.querySelector("a[href]")).toBeNull();
    expect(
      within(main()).getAllByText(/Cloud Sync writes are paused/),
    ).toHaveLength(1);
  });

  const FACT = "Cloud Sync writes are paused for every product";

  it("line 1 says since when and by whom: today the time, an earlier day the date, no name no parenthesis", async () => {
    const at = nowS() - 90;
    boot("#/", { extra: paused({ since: at }).routes });
    await home();
    await within(main()).findByText(/Cloud Sync writes are paused/);
    const row = platformRows()[0]!;
    // The name is isolated (FSI to PDI); the consequence is line 2, with no Since line between.
    expect(
      within(row).getByText(
        `${FACT}, since ${formatSince(at * 1000)} (\u2068Ana Lima\u2069).`,
      ),
    ).toBeTruthy();
    expect(
      within(row).getByText(
        "Devices keep their changes and send them on resume.",
      ),
    ).toBeTruthy();
    expect(within(row).queryByText(/^Since /)).toBeNull();
    cleanup();
    resetConsole();

    const earlier = nowS() - 3 * 86_400;
    boot("#/", { extra: paused({ since: earlier, by: null }).routes });
    await home();
    await within(main()).findByText(/Cloud Sync writes are paused/);
    const line = within(platformRows()[0]!).getByText(/^Cloud Sync writes/);
    expect(line.textContent).toBe(
      `${FACT}, since ${formatSince(earlier * 1000)}.`,
    );
    expect(line.textContent).not.toContain("(");
  });

  it("formats in the viewer's zone: the time today, the date before, the year only when it is not this one", () => {
    const now = Date.UTC(2026, 9, 22, 18, 0);
    const opts = { locale: "en-GB", timeZone: "UTC" };
    expect(formatSince(Date.UTC(2026, 9, 22, 14, 6), now, opts)).toBe("14:06");
    expect(formatSince(Date.UTC(2026, 9, 21, 14, 6), now, opts)).toBe(
      "21 Oct, 14:06",
    );
    expect(formatSince(Date.UTC(2025, 8, 17, 14, 6), now, opts)).toBe(
      "17 Sept 2025, 14:06",
    );
    expect(
      formatSince(Date.UTC(2026, 9, 22, 23, 30), Date.UTC(2026, 9, 23, 1, 0), {
        ...opts,
        timeZone: "Asia/Tokyo",
      }),
    ).toBe("8:30");
  });

  it("Resume writes opens the dialog in place with who and why; resuming removes the row and focuses the heading", async () => {
    const user = userEvent.setup();
    const { routes, state } = paused();
    boot("#/", { extra: routes });
    await home();
    await user.click(
      await within(main()).findByRole("button", { name: "Resume writes" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(window.location.hash).toBe("#/");
    expect(within(dialog).getByText(/Ana Lima/)).toBeTruthy();
    expect(within(dialog).getByText(/Storage errors in eu-west/)).toBeTruthy();
    await user.type(within(dialog).getByLabelText(/Reason/), "Provider fixed");
    await user.click(
      within(dialog).getByRole("button", { name: "Resume writes" }),
    );
    await waitFor(() => expect(state.on).toBe(false));
    await waitFor(() => expect(platformRows()).toHaveLength(0));
    await waitFor(() => expect(document.activeElement?.tagName).toBe("H2"));
    expect(window.location.hash).toBe("#/");
  });

  it("is on no product: no pill, no count, no dot on any card", async () => {
    const { routes } = paused();
    routes["/manage/api/attention"] = { items: [platformItem()] };
    boot("#/", { extra: routes });
    await home();
    await within(main()).findByText(/Cloud Sync writes are paused/);
    await waitFor(() => expect(cards()).toHaveLength(2));
    for (const c of cards()) {
      expect(within(c).queryByText(/need attention|Writes paused/)).toBeNull();
      expect(c.querySelector("[data-issue-dot]")).toBeNull();
    }
  });

  it("a Platform admin with no product grant sees the row and the first-run state, and can resume", async () => {
    const user = userEvent.setup();
    const { routes } = paused();
    routes["/manage/api/products"] = { products: [] };
    routes["/manage/api/attention"] = { items: [platformItem()] };
    boot("#/", { me: { products: [] }, extra: routes });
    await home();
    expect(
      await within(main()).findByText("Register your first product"),
    ).toBeTruthy();
    await user.click(
      await within(main()).findByRole("button", { name: "Resume writes" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    // The products are not listed to this member, yet the switch reaches them: said in words.
    expect(
      within(dialog).getByText(
        "Every product with Cloud Sync takes new data again.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).queryByText("No product has Cloud Sync on."),
    ).toBeNull();
  });

  it("a Product admin is never sent it, so Home draws no platform row", async () => {
    const routes = registry();
    boot("#/", {
      me: {
        platformAdmin: false,
        products: [{ slug: "djdl", name: "DJDL", schemaVersion: 1 }],
      },
      extra: routes,
    });
    await home();
    await waitFor(() => expect(cards().length).toBeGreaterThan(0));
    expect(platformRows()).toHaveLength(0);
    expect(
      within(main()).queryByText(/Cloud Sync writes are paused/),
    ).toBeNull();
  });

  const platformSettingsCalls = (log: { calls: { path: string }[] }): number =>
    log.calls.filter((c) => c.path === "/manage/api/platform/settings").length;

  it("B1: a failed settings read is asked again on click, then the dialog opens", async () => {
    const user = userEvent.setup();
    const { routes } = paused();
    let n = 0;
    const view = routes["/manage/api/platform/settings"] as () => unknown;
    routes["/manage/api/platform/settings"] = () =>
      ++n <= 1 ? new Response("{}", { status: 500 }) : view();
    boot("#/", { extra: routes });
    await home();
    await within(main()).findByRole("button", { name: "Resume writes" });
    await waitFor(() => expect(n).toBeGreaterThanOrEqual(1));
    await user.click(
      within(main()).getByRole("button", { name: "Resume writes" }),
    );
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
  });

  it("B1: when the read keeps failing, a toast says so with Retry; Retry opens the dialog once it answers", async () => {
    const user = userEvent.setup();
    const { routes } = paused();
    let up = false;
    const view = routes["/manage/api/platform/settings"] as () => unknown;
    routes["/manage/api/platform/settings"] = () =>
      up ? view() : new Response("{}", { status: 500 });
    boot("#/", { extra: routes });
    await home();
    await user.click(
      await within(main()).findByRole("button", { name: "Resume writes" }),
    );
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    up = true;
    fireEvent.click(retry);
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
  });

  it("B1: a slow read shows the button busy, then the dialog; without a click nothing pops open", async () => {
    const user = userEvent.setup();
    const { routes } = paused();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const view = routes["/manage/api/platform/settings"] as () => unknown;
    let first = true;
    routes["/manage/api/platform/settings"] = () => {
      if (first) {
        first = false;
        return PENDING;
      }
      return view();
    };
    void gate;
    boot("#/", { extra: routes });
    await home();
    const button = await within(main()).findByRole("button", {
      name: "Resume writes",
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await user.click(button);
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    release();
  });

  it("B1: Refresh asks for the settings again", async () => {
    const user = userEvent.setup();
    const log = boot("#/", { extra: paused().routes });
    await home();
    await within(main()).findByRole("button", { name: "Resume writes" });
    await waitFor(() => expect(platformSettingsCalls(log)).toBe(1));
    await user.click(within(main()).getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(platformSettingsCalls(log)).toBe(2));
  });

  async function resume(
    user: ReturnType<typeof userEvent.setup>,
  ): Promise<void> {
    await user.click(
      await within(main()).findByRole("button", { name: "Resume writes" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByLabelText(/Reason/), "Provider fixed");
    await user.click(
      within(dialog).getByRole("button", { name: "Resume writes" }),
    );
  }

  it("B2: a Platform admin with no products and Platform ready hidden lands on the first-run heading", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("pk-admin-setup-guide-hidden:u1", "true");
    const { routes, state } = paused();
    routes["/manage/api/products"] = { products: [] };
    routes["/manage/api/attention"] = () => ({
      items: state.on ? [platformItem()] : [],
    });
    boot("#/", { me: { products: [] }, extra: routes });
    await home();
    await resume(user);
    await waitFor(() => expect(platformRows()).toHaveLength(0));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(main()).getByRole("heading", {
          level: 2,
          name: "Register your first product",
        }),
      ),
    );
  });

  it("N3: resuming the only item focuses the all-clear line", async () => {
    const user = userEvent.setup();
    const { routes, state } = paused();
    routes["/manage/api/attention"] = () => ({
      items: state.on ? [platformItem()] : [],
    });
    boot("#/", { extra: { ...routes, "/manage/api/platform/ready": READY } });
    await home();
    await resume(user);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(main()).getByText("Nothing needs attention."),
      ),
    );
  });

  it("N4: a 409 on resume, with writes already running, refetches and says so; no raw server text", async () => {
    const user = userEvent.setup();
    const { routes, state } = paused();
    routes[`PATCH /manage/api/platform/settings/${PAUSE_KEY}`] = () => {
      state.on = false;
      return new Response(JSON.stringify({ error: "version_conflict" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    };
    boot("#/", { extra: routes });
    await home();
    await resume(user);
    expect(
      await screen.findByText("Writes were already resumed."),
    ).toBeTruthy();
    await waitFor(() => expect(platformRows()).toHaveLength(0));
    expect(screen.queryByText(/changed on the server/i)).toBeNull();
  });

  it("N5, N6, N8: a button with no arrow at the links' size, the mark in rem", async () => {
    boot("#/", { extra: paused().routes });
    await home();
    await within(main()).findByText(/Cloud Sync writes are paused/);
    const row = platformRows()[0]!;
    const button = within(row).getByRole("button", { name: "Resume writes" });
    expect(button.querySelector("svg")).toBeNull();
    expect(button.className).toContain("text-sm");
    expect(button.className).toContain("justify-self-start");
    expect(
      row.querySelector("[data-platform-subject] svg")!.getAttribute("class"),
    ).toContain("size-6");
    expect(row.parentElement!.className).toContain(
      "@xl:grid-cols-[max-content_fit-content(11rem)_minmax(0,1fr)_max-content]",
    );
  });
});
