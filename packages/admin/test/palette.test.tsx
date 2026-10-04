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
  filterItems,
  navigationSource,
  productSource,
} from "../src/console/shell/CommandPalette.js";
import { PREF_KEYS } from "../src/console/storage.js";
import { ALL_ON, boot, resetConsole } from "./consoleHarness.js";

/**
 * The command palette (ADMIN.md §2.2, components.md §1.5): ⌘K / Ctrl+K or `/`, the navigation
 * and products sources, recents pinned first, and a live result count.
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

const optionNames = (dialog: HTMLElement): string[] =>
  within(dialog)
    .queryAllByRole("option")
    .map((o) => o.textContent ?? "");

describe("the sources", () => {
  it("navigation offers the platform links and every built page of the enabled sections", () => {
    const items = navigationSource("djdl", "DJDL", {
      ...ALL_ON,
      release: { enabled: false },
    });
    const labels = items.map((i) => i.label);
    expect(labels).toContain("Home");
    expect(labels).toContain("Products");
    expect(labels).toContain("Licenses");
    expect(labels).toContain("Matrix");
    expect(labels).not.toContain("Releases");
    // Sign-in is built (chunk 10); not-built pages are not offered: they would only redirect.
    expect(labels).toContain("Sign-in");
    expect(labels).not.toContain("Package feeds");
    expect(items.find((i) => i.label === "Licenses")!.href).toBe(
      "#/p/djdl/license/licenses",
    );
    expect(items.find((i) => i.label === "Licenses")!.shortcut).toBe("g l");
  });

  it("navigation off a product is the platform links only", () => {
    expect(navigationSource(null, null, null).map((i) => i.label)).toEqual([
      "Home",
      "Products",
      // The Platform section's built pages (notes/S-13 §9.1).
      "Settings",
      "Deployment",
      "Operations",
    ]);
  });

  it("products jump to each product's Overview", () => {
    const items = productSource([
      { slug: "djdl", name: "DJDL", schemaVersion: 1 },
    ]);
    expect(items).toMatchObject([
      { label: "DJDL", detail: "djdl", href: "#/p/djdl", group: "Products" },
    ]);
  });

  it("filters on every word across label, section and slug, label prefixes first", () => {
    const items = [
      ...navigationSource("djdl", "DJDL", ALL_ON),
      ...productSource([{ slug: "acme", name: "Acme", schemaVersion: 1 }]),
    ];
    expect(filterItems(items, "lic").map((i) => i.label)[0]).toBe("Licenses");
    expect(filterItems(items, "license tiers").map((i) => i.label)).toEqual([
      "Tiers",
    ]);
    expect(filterItems(items, "acme").map((i) => i.label)).toEqual(["Acme"]);
    expect(filterItems(items, "zzz")).toEqual([]);
  });
});

describe("the palette in the console", () => {
  it("opens with ⌘K, Ctrl+K and /, and from the top bar", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await screen.findByRole("navigation", { name: "Console" });

    let dialog = await openPalette();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    dialog = await screen.findByRole("dialog", { name: "Command palette" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.keyDown(document.body, { key: "/" });
    dialog = await screen.findByRole("dialog", { name: "Command palette" });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await userEvent.click(
      screen.getByRole("button", { name: "Search or jump to" }),
    );
    dialog = await screen.findByRole("dialog", { name: "Command palette" });
    expect(
      within(dialog).getByRole("combobox", { name: "Search or jump to" }),
    ).toBeTruthy();
  });

  it("⌘K or Ctrl+K pressed again, from inside the open palette, closes it (owner, 2026-10-03)", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await screen.findByRole("navigation", { name: "Console" });

    // Typed into the palette's own input, as an operator would: the event bubbles to the shell.
    await openPalette();
    await userEvent.keyboard("{Meta>}k{/Meta}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await screen.findByRole("dialog", { name: "Command palette" });
    await userEvent.keyboard("{Control>}k{/Control}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // And it opens again afterwards: the shortcut toggles, it does not latch.
    await openPalette();
  });

  it("lists navigation and products, and filters as you type with a live count", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await screen.findByRole("navigation", { name: "Console" });
    const dialog = await openPalette();
    await waitFor(() =>
      expect(optionNames(dialog).some((n) => n.startsWith("Licenses"))).toBe(
        true,
      ),
    );
    expect(optionNames(dialog).some((n) => n.startsWith("Acme"))).toBe(true);

    await userEvent.type(
      within(dialog).getByRole("combobox", { name: "Search or jump to" }),
      "tiers",
    );
    await waitFor(() =>
      expect(optionNames(dialog).map((n) => n.split("License")[0])).toEqual([
        "Tiers",
      ]),
    );
    const live = within(dialog)
      .getAllByRole("status")
      .find((el) => /result/.test(el.textContent ?? ""))!;
    expect(live.textContent).toBe("1 result");

    await userEvent.clear(
      within(dialog).getByRole("combobox", { name: "Search or jump to" }),
    );
    await userEvent.type(
      within(dialog).getByRole("combobox", { name: "Search or jump to" }),
      "qqqq",
    );
    await waitFor(() => expect(live.textContent).toBe("No results"));
    expect(within(dialog).getByText("Nothing matches “qqqq”.")).toBeTruthy();
  });

  it("Enter runs the selected row: navigates and closes", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await screen.findByRole("navigation", { name: "Console" });
    const dialog = await openPalette();
    await userEvent.type(
      within(dialog).getByRole("combobox", { name: "Search or jump to" }),
      "activity",
    );
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(window.location.hash).toBe("#/p/djdl/activity"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("jumps to another product's Overview", async () => {
    boot("#/p/djdl/license/tiers", { services: ALL_ON });
    await screen.findByRole("navigation", { name: "Console" });
    const dialog = await openPalette();
    await userEvent.click(
      await within(dialog).findByRole("option", { name: /^Acme/ }),
    );
    await waitFor(() => expect(window.location.hash).toBe("#/p/acme"));
  });

  it("pins recent commands first, and remembers them", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await screen.findByRole("navigation", { name: "Console" });
    let dialog = await openPalette();
    // The product's Settings, not Platform → Settings.
    await userEvent.click(
      await within(dialog).findByRole("option", { name: /^Settings.*DJDL/ }),
    );
    await waitFor(() => expect(window.location.hash).toBe("#/p/djdl/settings"));
    expect(
      JSON.parse(window.localStorage.getItem(PREF_KEYS.recentCommands)!),
    ).toEqual(["nav:djdl:settings"]);

    dialog = await openPalette();
    const recent = within(dialog).getByRole("group", { name: "Recent" });
    expect(
      within(recent)
        .getAllByRole("option")
        .map((o) => o.textContent?.startsWith("Settings")),
    ).toEqual([true]);
  });

  it("offers nothing a product does not run", async () => {
    boot("#/p/djdl", {
      services: { ...ALL_ON, distribution: { enabled: false } },
    });
    await screen.findByRole("navigation", { name: "Console" });
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("navigation", { name: "Console" })[0]!
          .querySelector('[data-section="distribution"]'),
      ).toBeNull(),
    );
    const dialog = await openPalette();
    expect(optionNames(dialog).some((n) => n.startsWith("Matrix"))).toBe(false);
  });
});
