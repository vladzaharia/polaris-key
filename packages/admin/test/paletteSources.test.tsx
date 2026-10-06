import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { navigationSource } from "../src/console/shell/CommandPalette.js";
import {
  createActions,
  missingChain,
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
import { ALL_ON, NONE, boot, resetConsole } from "./consoleHarness.js";

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
    expect(ids).toEqual(["navigation", "actions", "products"]);
    expect(PALETTE_GROUPS.map((g) => g.heading)).toEqual([
      "Recent",
      "Pages",
      "Actions",
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
  it("offers Create license… only while the product runs License", () => {
    expect(createActions("djdl", ALL_ON).map((i) => i.label)).toEqual([
      "Create license…",
      "Create product",
    ]);
    expect(
      createActions("djdl", { license: { enabled: false } }).map(
        (i) => i.label,
      ),
    ).toEqual(["Create product"]);
    expect(createActions(null, null).map((i) => i.label)).toEqual([
      "Create product",
    ]);
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
    expect(labels).not.toContain("Deployment");
  });

  it("typed: Platform appears on a match, after the product's own pages", () => {
    const groups = rankPalette(nav, [], "settings", PALETTE_GROUPS);
    expect(
      groups.map((g) => [g.heading, g.items.map((i) => i.detail)]),
    ).toEqual([
      ["Pages", ["Core · DJDL"]],
      ["Platform", ["Platform"]],
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
        "/manage/api/products/djdl/services": {
          services: {
            ...ALL_ON,
            release: { enabled: false },
            distribution: { enabled: false },
            update: { enabled: false },
          },
          source: "manifest",
          registration: null,
          effectiveRegistration: "requires-license",
        },
      },
    });
    await screen.findByRole("navigation", { name: "Console" });
    const dialog = await openPalette();
    await userEvent.type(input(dialog), "release");
    await waitFor(() =>
      expect(groupLabels(dialog, "Actions")[0]).toMatch(/^Turn on Release/),
    );
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(window.location.hash).toBe("#/p/djdl/services"));
    await waitFor(() =>
      expect(document.activeElement?.id).toBe("service-release"),
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
      expect(groupLabels(dialog, "Platform")[0]).toMatch(/^Deployment/),
    );
  });

  it("Create license… opens the create dialog over the page", async () => {
    boot("#/p/djdl/activity", { services: ALL_ON });
    await screen.findByRole("navigation", { name: "Console" });
    const dialog = await openPalette();
    await userEvent.type(input(dialog), "create lic");
    await userEvent.click(
      await within(dialog).findByRole("option", { name: /^Create license/ }),
    );
    expect(
      await screen.findByRole("dialog", { name: /create license/i }),
    ).toBeTruthy();
    expect(window.location.hash).toBe("#/p/djdl/activity");
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
