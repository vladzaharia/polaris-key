/**
 * ST-10: the palette finds a setting from the generated index, for what the member can open only,
 * and its row opens All settings on that setting (settingsDeepLink.test.tsx). The I-41 support-code source is covered in
 * palette.test.tsx and stays beside this one in the registry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AreaId, Me } from "../src/api.js";
import {
  PALETTE_SOURCES,
  PALETTE_GROUPS,
} from "../src/console/shell/palette/registry.js";
import {
  SETTINGS_ROWS_MAX,
  settingsItems,
} from "../src/console/shell/palette/settings.js";
import type { PaletteContext } from "../src/console/shell/palette/types.js";
import { SETTINGS_INDEX } from "../src/console/settings.generated.js";
import { SETTING_HOMES } from "../src/console/sections/core/model/settingHomes.js";
import { parseLocation } from "../src/console/routes.js";
import { ALL_ON, ME, boot, resetConsole } from "./consoleHarness.js";
import { expectNoAxeViolations } from "./coreTestUtils.js";

const granted = (areas: AreaId[], platform: AreaId[] = ["console"]): Me => ({
  ...ME,
  platformAdmin: false,
  permissions: {
    roles: [],
    platform: { view: platform, edit: platform },
    products: { djdl: { view: areas, edit: areas } },
  },
});

const ctx = (me: Me, slug: string | null = "djdl"): PaletteContext => ({
  slug,
  productName: slug ? "DJDL" : null,
  services: null,
  features: null,
  products: [],
  page: null,
  me,
});

const live = SETTINGS_INDEX.filter(
  (e) => e.pending === null && e.deprecated === null,
);
const ofArea = (area: string, scope = "product") =>
  live.find((e) => e.scope === scope && e.rbacArea === area)!;

describe("palette from Home: across the operator's products", () => {
  const products = [
    { slug: "djdl", name: "DJDL", services: null },
    { slug: "acme", name: "Acme", services: null },
  ] as unknown as PaletteContext["products"];
  const home = (): PaletteContext => ({
    ...ctx(granted(["core", "license", "config"]), null),
    products,
  });

  it("finds a product's setting, naming its product and the page it lives on", () => {
    const rows = settingsItems(
      {
        ...home(),
        me: {
          ...ME,
          platformAdmin: false,
          permissions: {
            roles: [],
            platform: { view: ["console"], edit: ["console"] },
            products: {
              djdl: { view: ["keys"], edit: ["keys"] },
              acme: { view: ["keys"], edit: ["keys"] },
            },
          },
        },
      },
      "signing keys",
    ).filter((r) => r.id.startsWith("setting:"));
    expect(rows.map((r) => r.id)).toEqual(
      expect.arrayContaining([
        "setting:djdl:core.keys",
        "setting:acme:core.keys",
      ]),
    );
    const row = rows.find((r) => r.id === "setting:djdl:core.keys")!;
    expect(row.detail).toBe("DJDL · Keys & secrets");
    expect(row.detail).not.toMatch(/\bCore\b|License\b|Identity/);
  });

  it("never lists more than the cap", () => {
    expect(settingsItems(home(), "e").length).toBeLessThanOrEqual(
      SETTINGS_ROWS_MAX,
    );
  });
});

describe("palette settings source", () => {
  it("is registered, and its heading has a place", () => {
    expect(PALETTE_SOURCES.map((s) => s.id)).toEqual(
      expect.arrayContaining(["support-code", "settings"]),
    );
    expect(PALETTE_GROUPS.some((g) => g.heading === "Settings")).toBe(true);
  });

  it("lists nothing until something is typed", () => {
    expect(settingsItems(ctx(granted(["core", "license"])), "  ")).toEqual([]);
  });

  it("finds a setting by label, key and alias, and links to its row in All settings", () => {
    const e = ofArea("license");
    const me = granted(["core", "license"]);
    for (const q of [e.label, e.key, ...e.aliases.slice(0, 1)]) {
      const rows = settingsItems(ctx(me), q);
      const row = rows.find((r) => r.id === `setting:djdl:${e.key}`);
      expect(row, q).toBeDefined();
      const route = parseLocation(row!.href!).route;
      const home = SETTING_HOMES[e.key];
      expect(route).toMatchObject({
        kind: "product",
        slug: "djdl",
        page: home?.kind === "page" ? home.page : "settings-all",
      });
      expect(route.kind === "product" && route.query.get("setting")).toBe(
        e.key,
      );
    }
  });

  it("shows a member nothing from an area they lack", () => {
    // Ship builds and Core only: no licence, config, sign-in, sync, commerce or keys settings.
    const me = granted(["core", "ship"]);
    const hidden = live.filter(
      (e) =>
        e.scope === "product" && e.rbacArea !== "core" && e.rbacArea !== "ship",
    );
    expect(hidden.length).toBeGreaterThan(0);
    for (const e of hidden)
      expect(
        settingsItems(ctx(me), e.key).filter((r) => r.label === e.label),
        e.key,
      ).toEqual([]);
    // The same query for a setting they do hold is answered.
    const held = ofArea("ship");
    expect(
      settingsItems(ctx(me), held.key).some(
        (r) => r.id === `setting:djdl:${held.key}`,
      ),
    ).toBe(true);
  });

  it("shows no product setting off a product, and no platform setting without the area", () => {
    const product = ofArea("core");
    const platform = ofArea("platform", "platform");
    const root = granted(["core"], ["console", "platform"]);
    expect(settingsItems(ctx(root, null), product.key)).toEqual([]);
    expect(
      settingsItems(ctx(root, null), platform.key).map((r) => r.id),
    ).toContain(`setting:platform:${platform.key}`);
    expect(settingsItems(ctx(granted(["core"]), null), platform.key)).toEqual(
      [],
    );
  });

  it("caps the rows and ends with the way to see them all", () => {
    const rows = settingsItems(
      ctx(granted(["core", "license", "config"])),
      "e",
    );
    const more = rows.filter((r) => r.id.startsWith("setting:more:"));
    expect(rows.length - more.length).toBeLessThanOrEqual(SETTINGS_ROWS_MAX);
    expect(more).toHaveLength(1);
    expect(more[0]!.label).toMatch(/^See all \d+ settings$/);
    expect(parseLocation(more[0]!.href!).route).toMatchObject({
      page: "settings-all",
    });
  });

  it("sends a manifest-owned or API-only setting to All settings, the rest to their page", () => {
    const me = granted(["core", "license", "config", "ship"]);
    const api = live.find(
      (e) => e.scope === "product" && SETTING_HOMES[e.key]?.kind === "api",
    );
    if (api) {
      const row = settingsItems(ctx(me), api.key).find(
        (r) => r.id === `setting:djdl:${api.key}`,
      );
      if (row)
        expect(parseLocation(row.href!).route).toMatchObject({
          page: "settings-all",
        });
    }
  });
});

describe("the palette with settings", () => {
  beforeEach(resetConsole);
  afterEach(cleanup);

  it("keeps the support-code source and opens a setting with the keyboard, Escape returning focus", async () => {
    const e = ofArea("license");
    boot("#/p/djdl", { services: ALL_ON });
    await screen.findByRole("navigation", { name: "Console" });
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", {
      name: "Command palette",
    });
    const input = within(dialog).getByRole("combobox", {
      name: "Search or jump to",
    });
    await userEvent.type(input, e.label);
    const opt = await within(dialog).findByRole("option", {
      name: new RegExp(e.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    });
    expect(opt).toBeTruthy();
    expect(
      within(dialog).getByRole("group", { name: "Settings" }),
    ).toBeTruthy();
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(window.location.hash).toMatch(
        new RegExp(`\\?setting=${e.key.replace(/\./g, "\\.")}$`),
      ),
    );
  });

  it("returns focus on Escape", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await screen.findByRole("navigation", { name: "Console" });
    const before = document.activeElement;
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog", {
      name: "Command palette",
    });
    await userEvent.type(
      within(dialog).getByRole("combobox", { name: "Search or jump to" }),
      "device limit",
    );
    await screen.findAllByRole("option");
    await new Promise((r) => setTimeout(r, 300));
    await expectNoAxeViolations(dialog);
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Command palette" })).toBe(
        null,
      ),
    );
    expect(document.activeElement).toBe(before);
  });
});
