import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ACROSS_PRODUCTS_MAX,
  navigationSource,
  productPagesAcross,
} from "../src/console/shell/palette/navigation.js";
import {
  createActions,
  deleteProductActions,
  missingChain,
  sdkActions,
  serviceSwitchId,
  turnOnActions,
} from "../src/console/shell/palette/actions.js";
import { rankPalette } from "../src/console/shell/palette/rank.js";
import {
  pushRecent,
  readRecents,
  recordItem,
  recordRecentId,
  RECENT_MAX,
} from "../src/console/shell/palette/recents.js";
import {
  PALETTE_GROUPS,
  PALETTE_SOURCES,
} from "../src/console/shell/palette/registry.js";
import type { PaletteItem } from "../src/console/shell/palette/types.js";
import { parseLocation } from "../src/console/routes.js";
import { PREF_KEYS } from "../src/console/storage.js";
import {
  ALL_ON,
  NONE,
  boot,
  resetConsole,
  servicesResponse,
} from "./consoleHarness.js";

/**
 * The palette's source registry and client sources (EXPERIENCE.md §0.3 J-1, UX-06a): actions
 * (Turn on <Service>, Create license…), ranking (the current product first, Platform only on a
 * match), and recents (the last five things opened, records included).
 */

beforeEach(resetConsole);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openPalette(): Promise<HTMLElement> {
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  return screen.findByRole("dialog", { name: "Command palette" });
}

const input = (dialog: HTMLElement): HTMLElement =>
  within(dialog).getByRole("combobox", { name: "Search or jump to" });

const hasGroup = (dialog: HTMLElement, name: string): boolean =>
  within(dialog).queryByRole("group", { name }) !== null;

const groupLabels = (dialog: HTMLElement, name: string): string[] =>
  within(within(dialog).getByRole("group", { name }))
    .getAllByRole("option")
    .map((o) => o.textContent ?? "");

describe("the registry", () => {
  it("lists each source once and gives every built-in heading a place", () => {
    const ids = PALETTE_SOURCES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "support-code",
      "entities",
      "navigation",
      "product-pages",
      "actions",
      "settings",
      "products",
    ]);
    expect(PALETTE_GROUPS.map((g) => g.heading)).toEqual([
      "Pasted key",
      "Recent",
      "Support code",
      "Pages",
      "Licenses",
      "Users",
      "Actions",
      "Settings",
      "Products",
      "Platform",
    ]);
    expect(
      PALETTE_GROUPS.find((g) => g.heading === "Platform")!.matchOnly,
    ).toBe(true);
  });
});

describe("Turn on <Service>", () => {
  it("offers each service the product does not run, with what it needs", () => {
    const items = turnOnActions("djdl", {
      license: { enabled: true },
      config: { enabled: true },
    });
    expect(items.map((i) => [i.label, i.detail])).toEqual([
      ["Turn on Release", "Services"],
      ["Turn on Distribution", "Needs Release"],
      ["Turn on Update", "Needs Distribution and Release"],
      ["Turn on Identity", "Services"],
      ["Turn on Cloud Sync", "Needs Identity"],
      ["Turn on Commerce", "Services"],
      ["Turn on Cloud Connect", "Needs Identity"],
    ]);
    expect(items.every((i) => i.matchOnly && i.group === "Actions")).toBe(true);
  });

  it("offers nothing off a product, while enablement loads, or when all is on", () => {
    expect(turnOnActions(null, NONE)).toEqual([]);
    expect(turnOnActions("djdl", null)).toEqual([]);
    expect(turnOnActions("djdl", ALL_ON)).toEqual([]);
  });

  it("follows the requires chain past services that are on", () => {
    expect(missingChain("update", { release: { enabled: true } })).toEqual([
      "distribution",
    ]);
    expect(missingChain("update", {})).toEqual(["distribution", "release"]);
    expect(missingChain("license", {})).toEqual([]);
  });

  it("targets Update's own switch only once Distribution is on, else the Ship builds switch", () => {
    const owner = "feature-ship-builds-switch";
    const nested = "feature-ship-builds-in-app-updates";
    expect(
      serviceSwitchId("update", {
        license: { enabled: true },
        config: { enabled: true },
      }),
    ).toBe(owner);
    expect(serviceSwitchId("update", { release: { enabled: true } })).toBe(
      owner,
    );
    expect(
      serviceSwitchId("update", {
        release: { enabled: true },
        distribution: { enabled: true },
      }),
    ).toBe(nested);
    expect(serviceSwitchId("distribution", {})).toBe(owner);
  });

  it("is found by the service's own page names", () => {
    const items = turnOnActions("djdl", {
      ...ALL_ON,
      distribution: { enabled: false },
      update: { enabled: false },
    });
    const rows = rankPalette(items, [], "rollouts", PALETTE_GROUPS);
    expect(rows.flatMap((g) => g.items.map((i) => i.label))).toEqual([
      "Turn on Distribution",
    ]);
  });
});

describe("create actions", () => {
  it("offers New license… only while the product runs License", () => {
    expect(createActions("djdl", ALL_ON).map((i) => i.label)).toEqual([
      "New license…",
      "New product",
    ]);
    expect(
      createActions("djdl", { license: { enabled: false } }).map(
        (i) => i.label,
      ),
    ).toEqual(["New product"]);
    expect(createActions(null, null).map((i) => i.label)).toEqual([
      "New product",
    ]);
  });
});

describe("SDK actions (UX-59)", () => {
  it("offers the quick start, the install and the trust pins on a product, on a match only", () => {
    const items = sdkActions("djdl");
    expect(items.map((i) => i.label)).toEqual([
      "SDK quick start",
      "Install the SDK",
      "Trust pins",
    ]);
    expect(items.every((i) => i.matchOnly)).toBe(true);
    expect(items.find((i) => i.label === "Trust pins")?.href).toBe(
      "#/p/djdl/settings/keys",
    );
    expect(sdkActions(null)).toEqual([]);
  });

  it("is found by the words a developer types", () => {
    const items = sdkActions("djdl");
    const find = (q: string) =>
      rankPalette(items, [], q, PALETTE_GROUPS)
        .flatMap((g) => g.items)
        .map((i) => i.label);
    expect(find("sdk")).toContain("SDK quick start");
    expect(find("install")[0]).toBe("Install the SDK");
    expect(find("pins")[0]).toBe("Trust pins");
    expect(find("godot")).toContain("SDK quick start");
  });
});

describe("ranking", () => {
  const nav = navigationSource("djdl", "DJDL", ALL_ON);

  it("untyped: the current product's pages lead, Platform and match-only rows wait", () => {
    const groups = rankPalette(
      [...nav, ...turnOnActions("djdl", NONE)],
      [],
      "",
      PALETTE_GROUPS,
    );
    expect(groups.map((g) => g.heading)).toEqual(["Pages"]);
    const labels = groups[0]!.items.map((i) => i.label);
    expect(labels[0]).toBe("Overview");
    expect(labels.indexOf("Licenses")).toBeLessThan(labels.indexOf("Home"));
    expect(labels).not.toContain("Status");
  });

  it("typed: Platform appears on a match, after the product's own pages", () => {
    const groups = rankPalette(nav, [], "settings", PALETTE_GROUPS);
    expect(
      groups.map((g) => [g.heading, g.items.map((i) => i.detail)]),
    ).toEqual([
      // Core → Settings, then License → Settings (LX-06), in section order. The licence page is
      // "Licensing" in the palette and still found by its sidebar label.
      // The settings hub's tabs (Features, Keys and secrets, Members…) are found by the word too.
      [
        "Pages",
        [
          "Product · DJDL",
          "Settings · DJDL",
          "Licensing · DJDL",
          "Settings · DJDL",
          "Settings · DJDL",
          "Settings · DJDL",
          "Settings · DJDL",
          "Settings · DJDL",
          "Settings · DJDL",
        ],
      ],
      ["Platform", ["Platform"]],
    ]);
    expect(groups[0]!.items.map((i) => i.label)).toEqual([
      "Settings",
      "All settings",
      "Licensing",
      "Features and general",
      "Presentation",
      "Listing",
      "Polaris Locker",
      "Keys and secrets",
      "Members",
    ]);
  });

  it("a heading the table does not know goes last, so a new source needs no edit here", () => {
    const entity: PaletteItem = {
      id: "entity:lic_1",
      group: "Licenses",
      label: "Mara Fennick",
      detail: "Pro",
      keywords: "",
      icon: null,
      href: "#/p/djdl/license/licenses/lic_1",
    };
    const groups = rankPalette([entity, ...nav], [], "", PALETTE_GROUPS);
    expect(groups.map((g) => g.heading)).toEqual(["Pages", "Licenses"]);
  });

  it("pins recents first untyped, and leaves a run row in its own group when typed", () => {
    const settings = nav.find((i) => i.id === "nav:djdl:settings")!;
    const untyped = rankPalette(nav, [settings], "", PALETTE_GROUPS);
    expect(untyped[0]).toMatchObject({ heading: "Recent" });
    expect(untyped[1]!.items.find((i) => i.id === settings.id)).toBeUndefined();
    const typed = rankPalette(nav, [settings], "settings", PALETTE_GROUPS);
    expect(typed.map((g) => g.heading)).toEqual(["Pages", "Platform"]);
  });
});

describe("recents", () => {
  it("keeps the last five, newest first, without repeats", () => {
    for (let i = 0; i < 7; i++) pushRecent(`nav:${i}`);
    pushRecent("nav:4");
    expect(readRecents()).toEqual([
      "nav:4",
      "nav:6",
      "nav:5",
      "nav:3",
      "nav:2",
    ]);
    expect(readRecents()).toHaveLength(RECENT_MAX);
  });

  it("names a record by its route, the same record on any tab", () => {
    const onKeys = parseLocation("#/p/djdl/license/licenses/lic_1/keys").route;
    const plain = parseLocation("#/p/djdl/license/licenses/lic_1").route;
    expect(recordRecentId(onKeys)).toBe(recordRecentId(plain));
    expect(
      recordRecentId(parseLocation("#/p/djdl/license/licenses").route),
    ).toBe(null);
    const id = recordRecentId(plain)!;
    expect(
      recordItem(id, [{ slug: "djdl", name: "DJDL", schemaVersion: 1 }]),
    ).toMatchObject({
      label: "License lic_1",
      detail: "Licenses · DJDL",
      href: "#/p/djdl/license/licenses/lic_1",
      group: "Recent",
    });
    // A product the session no longer has drops out.
    expect(recordItem(id, [])).toBeNull();
    // A channel record reads by its label, never its id (A-22.7).
    const channel = recordRecentId(
      parseLocation("#/p/djdl/distribution/channels/app-store/releases").route,
    )!;
    expect(
      recordItem(channel, [{ slug: "djdl", name: "DJDL", schemaVersion: 1 }]),
    ).toMatchObject({ label: "App Store" });
  });
});

describe("the palette in the console", () => {
  it("with Release off, “release” returns Turn on Release, which opens Services on its switch", async () => {
    boot("#/p/djdl", {
      services: {
        ...ALL_ON,
        release: { enabled: false },
        distribution: { enabled: false },
        update: { enabled: false },
      },
      extra: {
        "/manage/api/products/djdl/services": servicesResponse({
          ...ALL_ON,
          release: { enabled: false },
          distribution: { enabled: false },
          update: { enabled: false },
        }),
      },
    });
    await screen.findByRole("navigation", { name: "Console" });
    const dialog = await openPalette();
    await userEvent.type(input(dialog), "release");
    await waitFor(() =>
      expect(groupLabels(dialog, "Actions")[0]).toMatch(/^Turn on Release/),
    );
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/djdl/settings/features"),
    );
    await waitFor(() =>
      expect(document.activeElement?.id).toBe("feature-ship-builds-switch"),
    );
  });

  it("with Distribution off, Turn on Update focuses the enabled Ship builds switch, not the disabled In-app updates one", async () => {
    const services = {
      ...NONE,
      license: { enabled: true },
      config: { enabled: true },
    };
    boot("#/p/djdl", {
      services,
      extra: {
        "/manage/api/products/djdl/services": servicesResponse(services),
      },
    });
    await screen.findByRole("navigation", { name: "Console" });
    const dialog = await openPalette();
    await userEvent.type(input(dialog), "turn on update");
    await userEvent.click(
      await within(dialog).findByRole("option", { name: /^Turn on Update/ }),
    );
    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/djdl/settings/features"),
    );
    const owner = await screen.findByRole("switch", { name: /Ship builds/i });
    expect(owner.id).toBe("feature-ship-builds-switch");
    expect((owner as HTMLButtonElement).disabled).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(owner));
    const updates = screen.getByRole("switch", { name: /In-app updates/i });
    expect(updates.getAttribute("aria-disabled")).toBe("true");
  });

  it("“sdk” finds the SDK quick start, which opens Integration on the SDK picker (UX-59)", async () => {
    boot("#/p/djdl/activity", { services: ALL_ON });
    await screen.findByRole("navigation", { name: "Console" });
    const dialog = await openPalette();
    await userEvent.type(input(dialog), "sdk quick");
    await waitFor(() =>
      expect(groupLabels(dialog, "Actions")[0]).toMatch(/^SDK quick start/),
    );
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/djdl/integration"),
    );
    await waitFor(() =>
      expect(document.activeElement?.id).toBe("sdk-quick-start-tab"),
    );
  });

  it("Platform pages show only once typed; the current product's pages lead", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await screen.findByRole("navigation", { name: "Console" });
    const dialog = await openPalette();
    await waitFor(() => expect(hasGroup(dialog, "Pages")).toBe(true));
    expect(hasGroup(dialog, "Platform")).toBe(false);
    expect(groupLabels(dialog, "Pages")[0]).toMatch(/^Overview/);
    // The product on screen is not offered again under Products.
    expect(groupLabels(dialog, "Products").map((n) => n.slice(0, 4))).toEqual([
      "Acme",
    ]);

    await userEvent.type(input(dialog), "deploy");
    await waitFor(() =>
      expect(groupLabels(dialog, "Platform")[0]).toMatch(/^Status/),
    );
  });

  it("New license… opens the wizard drawer over the Licenses page", async () => {
    boot("#/p/djdl/activity", { services: ALL_ON });
    await screen.findByRole("navigation", { name: "Console" });
    const dialog = await openPalette();
    await userEvent.type(input(dialog), "new lic");
    await userEvent.click(
      await within(dialog).findByRole("option", { name: /^New license/ }),
    );
    expect(
      await screen.findByRole("dialog", { name: "New license" }),
    ).toBeTruthy();
    expect(window.location.hash).toBe(
      "#/p/djdl/license/licenses?setup=new-license&step=tier",
    );
  });

  it("remembers records opened anywhere and offers them under Recent", async () => {
    boot("#/p/djdl/license/licenses/lic_9/keys", {
      services: ALL_ON,
      extra: {
        "/manage/api/products/djdl/license/licenses/lic_9": {
          license: { id: "lic_9", name: "Mara", email: "m@x.io" },
        },
      },
    });
    await screen.findByRole("navigation", { name: "Console" });
    await waitFor(() =>
      expect(
        JSON.parse(window.localStorage.getItem(PREF_KEYS.recentCommands)!),
      ).toEqual(["record:#/p/djdl/license/licenses/lic_9"]),
    );
    window.location.hash = "#/p/djdl";
    const dialog = await openPalette();
    await waitFor(() =>
      expect(groupLabels(dialog, "Recent")[0]).toMatch(/^License lic_9/),
    );
  });

  it("fills the screen on a phone with a Cancel control, and shows key hints on desktop", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await screen.findByRole("navigation", { name: "Console" });
    const dialog = await openPalette();
    expect(dialog.className).toContain("inset-0");
    expect(dialog.className).toContain("sm:max-w-xl");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("palette across products (from Home)", () => {
  const products = [
    { slug: "djdl", name: "DJDL", services: ALL_ON },
    { slug: "acme", name: "Acme", services: ALL_ON },
  ] as never;

  it('"secret" finds Keys and secrets for each product, before any trust pin', () => {
    const rows = productPagesAcross(products, "secret");
    expect(rows.map((r) => [r.label, r.detail])).toEqual([
      ["Keys and secrets", "DJDL · Settings"],
      ["Keys and secrets", "Acme · Settings"],
    ]);
  });

  it("is typed only, capped, and indexes the Members tab", () => {
    expect(productPagesAcross(products, "")).toEqual([]);
    expect(productPagesAcross(products, "e").length).toBeLessThanOrEqual(
      ACROSS_PRODUCTS_MAX,
    );
    expect(productPagesAcross(products, "members").map((r) => r.href)).toEqual(
      expect.arrayContaining(["#/p/djdl/settings/members"]),
    );
  });

  it("offers Delete product… per product, typed only", () => {
    const ctx = { slug: null, productName: null, products };
    expect(deleteProductActions(ctx, "")).toEqual([]);
    expect(deleteProductActions(ctx, "delete djdl").map((r) => r.id)).toEqual([
      "action:delete-product:djdl",
    ]);
  });
});

describe("palette on a product: secret", () => {
  it("ranks the Keys and secrets page above Trust pins", () => {
    const items = [
      ...sdkActions("djdl"),
      ...navigationSource("djdl", "DJDL", ALL_ON),
    ];
    const groups = rankPalette(items, [], "secret", PALETTE_GROUPS);
    const flat = groups.flatMap((g) => g.items.map((i) => i.label));
    expect(flat.indexOf("Keys and secrets")).toBeGreaterThanOrEqual(0);
    expect(flat.indexOf("Keys and secrets")).toBeLessThan(
      flat.indexOf("Trust pins"),
    );
  });
});
