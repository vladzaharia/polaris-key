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
  navigationSource,
  productSource,
} from "../src/console/shell/palette/navigation.js";
import { filterItems } from "../src/console/shell/palette/rank.js";
import { PREF_KEYS } from "../src/console/storage.js";
import {
  ALL_ON,
  boot,
  resetConsole,
  servicesResponse,
} from "./consoleHarness.js";

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
    expect(labels).not.toContain("Products");
    expect(labels).toContain("Licenses");
    // P0-47: the matrix is Rollouts' view, so the palette offers Rollouts, not Matrix.
    expect(labels).toContain("Rollouts");
    expect(labels).not.toContain("Matrix");
    // Typing "matrix" still finds it: Rollouts carries the word.
    expect(filterItems(items, "matrix").map((i) => i.label)[0]).toBe(
      "Rollouts",
    );
    expect(labels).not.toContain("Releases");
    // Sign-in is built (chunk 10); not-built pages are not offered: they would only redirect.
    expect(labels).toContain("App sign-in");
    // F-11: Distribution → Package feeds is offered while the product has package feeds on.
    const off = navigationSource(
      "djdl",
      "DJDL",
      { ...ALL_ON },
      { packageFeeds: false },
    );
    expect(
      off.filter((i) => i.href.startsWith("#/p/")).map((i) => i.label),
    ).not.toContain("Package feeds");
    const on = navigationSource("djdl", "DJDL", ALL_ON, { packageFeeds: true });
    expect(
      on.find((i) => i.href === "#/p/djdl/distribution/feeds"),
    ).toBeTruthy();
    expect(items.find((i) => i.label === "Licenses")!.href).toBe(
      "#/p/djdl/license/licenses",
    );
    expect(items.find((i) => i.label === "Licenses")!.shortcut).toBe("g l");
  });

  it("navigation off a product is the platform links only", () => {
    expect(navigationSource(null, null, null).map((i) => i.label)).toEqual([
      "Home",
      "API tokens",
      "Personal tokens",
      // The Platform section's built pages (notes/S-13 §9.1).
      "Settings",
      "Deployment",
      "Operations",
      "Connections",
      "Store connections",
      "Package feeds",
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
    expect(filterItems(items, "licensing tiers").map((i) => i.label)).toEqual([
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
      // The Tiers page leads; settings that mention tiers follow, under their own heading.
      expect(optionNames(dialog)[0]?.startsWith("Tiers")).toBe(true),
    );
    const live = within(dialog)
      .getAllByRole("status")
      .find((el) => el.getAttribute("aria-atomic") === "true")!;
    // Announced when typing pauses (500 ms), and a "See all" row is not a result.
    const seeAll = optionNames(dialog).filter((n) =>
      n.startsWith("See all"),
    ).length;
    await waitFor(
      () =>
        expect(live.textContent).toMatch(
          new RegExp(`^${optionNames(dialog).length - seeAll} results?`),
        ),
      { timeout: 3000 },
    );

    await userEvent.clear(
      within(dialog).getByRole("combobox", { name: "Search or jump to" }),
    );
    await userEvent.type(
      within(dialog).getByRole("combobox", { name: "Search or jump to" }),
      "qqqq",
    );
    await waitFor(() => expect(live.textContent).toBe("No results"), {
      timeout: 3000,
    });
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

  it("opens Update in Services and focuses its nested control", async () => {
    const user = userEvent.setup();
    const services = { ...ALL_ON, update: { enabled: false } };
    boot("#/p/djdl", {
      services,
      extra: {
        "/manage/api/products/djdl/services": servicesResponse(services),
      },
    });
    await screen.findByRole("navigation", { name: "Console" });
    const dialog = await openPalette();
    await user.type(
      within(dialog).getByRole("combobox", { name: "Search or jump to" }),
      "turn on update",
    );

    await user.click(
      await within(dialog).findByRole("option", { name: /^Turn on Update/ }),
    );
    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/djdl/settings/features"),
    );
    const updates = await screen.findByRole("switch", {
      name: /In-app updates/i,
    });
    expect(updates.id).toBe("feature-ship-builds-in-app-updates");
    await waitFor(() => expect(document.activeElement).toBe(updates));
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

  it("offers to open a support code, typed with or without dashes, and jumps to that user (I-41)", async () => {
    const SUBJECT = `ps_${"A".repeat(22)}`;
    const log = boot("#/p/djdl", {
      services: ALL_ON,
      extra: {
        "/manage/api/support-codes/K7M4QX9TZ": {
          product: "acme",
          subject: SUBJECT,
        },
        "/manage/api/support-codes/222222222": () =>
          new Response(JSON.stringify({ error: "not_found" }), { status: 404 }),
      },
    });
    await screen.findByRole("navigation", { name: "Console" });
    const dialog = await openPalette();
    const input = within(dialog).getByRole("combobox", {
      name: "Search or jump to",
    });
    // Nothing is asked for a query that is no code.
    await userEvent.type(input, "tiers");
    expect(log.calls.some((c) => c.path.includes("support-codes"))).toBe(false);
    await userEvent.clear(input);
    await userEvent.type(input, "k7m 4qx.9tz");
    const row = await within(dialog).findByRole("option", {
      name: /Open support code K7M-4QX-9TZ/,
    });
    expect(row.textContent).toMatch(/acme/i);
    expect(within(row).getByText("K7M-4QX-9TZ").tagName).toBe("CODE");
    await userEvent.click(row);
    await waitFor(() =>
      expect(window.location.hash).toBe(`#/p/acme/users/${SUBJECT}`),
    );
  });

  it("a nine-character page name still opens its page: no support-code row, Enter works (I-41)", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await screen.findByRole("navigation", { name: "Console" });
    const dialog = await openPalette();
    const input = within(dialog).getByRole("combobox", {
      name: "Search or jump to",
    });
    await userEvent.type(input, "API tokens");
    await waitFor(() => expect(optionNames(dialog).length).toBeGreaterThan(0));
    expect(
      optionNames(dialog).some((n) =>
        /support code|wrong|never contain/i.test(n),
      ),
    ).toBe(false);
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(window.location.hash).toBe("#/tokens"));
  });

  it("shows no support-code row for a plain word of nine letters", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await screen.findByRole("navigation", { name: "Console" });
    const dialog = await openPalette();
    await userEvent.type(
      within(dialog).getByRole("combobox", { name: "Search or jump to" }),
      "teammates",
    );
    await waitFor(() =>
      expect(within(dialog).getByText(/Nothing matches/)).toBeTruthy(),
    );
    expect(within(dialog).queryByText(/One character is wrong/)).toBeNull();
  });

  it("says one thing for each state of a support code: wrong character, lookalike, none, too many", async () => {
    boot("#/p/djdl", {
      services: ALL_ON,
      extra: {
        "/manage/api/support-codes/222222222": () =>
          new Response(JSON.stringify({ error: "not_found" }), { status: 404 }),
        "/manage/api/support-codes/2222222JX": () =>
          new Response(JSON.stringify({ error: "rate_limited" }), {
            status: 429,
          }),
      },
    });
    await screen.findByRole("navigation", { name: "Console" });
    const dialog = await openPalette();
    const input = within(dialog).getByRole("combobox", {
      name: "Search or jump to",
    });
    const say = async (typed: string, text: RegExp) => {
      await userEvent.clear(input);
      await userEvent.type(input, typed);
      expect(await within(dialog).findByText(text)).toBeTruthy();
    };
    await say(
      "222-222-223",
      /One character is wrong\. Ask them to read it again\./,
    );
    await say(
      "222-222-220",
      /Support codes never contain 0, 1, I, L, O or U\./,
    );
    await say(
      "222-222-222",
      /No user with support code 222-222-222 in your products\./,
    );
    await say("222-222-2JX", /Too many lookups\. Try again in a minute\./);
    // An inert line does not close the palette.
    await userEvent.keyboard("{Enter}");
    expect(
      screen.queryByRole("dialog", { name: "Command palette" }),
    ).toBeTruthy();
  });

  it("says one thing for each state of a support code: wrong character, lookalike, none, too many", async () => {
    boot("#/p/djdl", {
      services: ALL_ON,
      extra: {
        "/manage/api/support-codes/222222222": () =>
          new Response(JSON.stringify({ error: "not_found" }), { status: 404 }),
        "/manage/api/support-codes/2222222JX": () =>
          new Response(JSON.stringify({ error: "rate_limited" }), {
            status: 429,
          }),
      },
    });
    await screen.findByRole("navigation", { name: "Console" });
    const dialog = await openPalette();
    const input = within(dialog).getByRole("combobox", {
      name: "Search or jump to",
    });
    const say = async (typed: string, text: RegExp) => {
      await userEvent.clear(input);
      await userEvent.type(input, typed);
      expect(await within(dialog).findByText(text)).toBeTruthy();
    };
    await say(
      "222-222-223",
      /One character is wrong\. Ask them to read it again\./,
    );
    await say(
      "222-222-220",
      /Support codes never contain 0, 1, I, L, O or U\./,
    );
    await say(
      "222-222-222",
      /No user with support code 222-222-222 in your products\./,
    );
    await say("222-222-2JX", /Too many lookups\. Try again in a minute\./);
    // An inert line does not close the palette.
    await userEvent.keyboard("{Enter}");
    expect(
      screen.queryByRole("dialog", { name: "Command palette" }),
    ).toBeTruthy();
  });

  it("pins recent commands first, and remembers them", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await screen.findByRole("navigation", { name: "Console" });
    let dialog = await openPalette();
    // The product's Settings, not Platform → Settings nor License → Settings ("Licensing", LX-06).
    await userEvent.click(
      await within(dialog).findByRole("option", {
        name: /^Settings.*Product · DJDL/,
      }),
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
    expect(optionNames(dialog).some((n) => n.startsWith("Rollouts"))).toBe(
      false,
    );
  });
});
