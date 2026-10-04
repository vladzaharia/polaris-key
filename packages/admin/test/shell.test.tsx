import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SERVICE_ACCENTS } from "@polaris-key/brand";
import {
  PRODUCT_PAGES,
  SECTIONS,
  navItems,
  platformLinks,
} from "../src/console/nav.js";

type ServiceAccentKey = keyof (typeof SERVICE_ACCENTS)["dark"];
import { PREF_KEYS } from "../src/console/storage.js";
import {
  ALL_ON,
  NONE,
  boot,
  resetConsole,
  type Enablement,
} from "./consoleHarness.js";

/**
 * The console shell (docs/design/ADMIN.md §2, components.md §1): sections by enablement, the
 * section bit, the switcher, the mobile drawer, collapsible section headers, item icons, the state
 * pages and the page heading. These drive the whole `App`, because the properties that matter span
 * the sidebar AND the router: a hidden section must also be a deep link that explains itself.
 */

beforeEach(resetConsole);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const nav = (): HTMLElement =>
  screen.getAllByRole("navigation", { name: "Console" })[0]!;

/** The sidebar's section headers, in render order. */
function sectionHeaders(): string[] {
  return [...nav().querySelectorAll("[data-section-header]")].map(
    (el) => el.textContent ?? "",
  );
}

const header = (label: string): HTMLElement =>
  within(nav()).getByRole("button", { name: label });

async function ready(): Promise<void> {
  await screen.findByRole("navigation", { name: "Console" });
  await waitFor(() => expect(sectionHeaders().length).toBeGreaterThan(0));
}

const expanded = (label: string): string | null =>
  header(label).getAttribute("aria-expanded");

/** Open a collapsed section by hand (a peek), so its items render. */
async function expand(label: string): Promise<void> {
  if (expanded(label) === "false") await userEvent.click(header(label));
  expect(expanded(label)).toBe("true");
}

/** Peek into every collapsed section, so every item renders. */
async function expandAll(): Promise<void> {
  for (const label of sectionHeaders()) await expand(label);
}

/** The labels of the sidebar's links, in render order. */
const navLinkLabels = (): string[] =>
  within(nav())
    .queryAllByRole("link")
    .map((a) => a.textContent ?? "");

describe("sections by enablement (D-15)", () => {
  it("draws Core, then one group per enabled service, in canonical order", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    await waitFor(() =>
      expect(sectionHeaders()).toEqual([
        "Core",
        "License",
        "Config",
        "Release",
        "Distribution",
        "Update",
        "Identity",
      ]),
    );
  });

  it("omits a disabled service's group entirely rather than greying it out", async () => {
    boot("#/p/djdl", {
      services: {
        ...ALL_ON,
        release: { enabled: false },
        update: { enabled: false },
      },
    });
    await ready();
    await waitFor(() =>
      expect(sectionHeaders()).toEqual([
        "Core",
        "License",
        "Config",
        "Distribution",
        "Identity",
      ]),
    );
    expect(within(nav()).queryByRole("link", { name: "Releases" })).toBeNull();
    expect(within(nav()).queryByRole("link", { name: "Feed" })).toBeNull();
  });

  it("keeps Core → Services reachable for a product that runs nothing", async () => {
    boot("#/p/djdl", { services: NONE });
    await ready();
    await waitFor(() => expect(sectionHeaders()).toEqual(["Core"]));
    expect(
      within(nav())
        .getByRole("link", { name: "Services" })
        .getAttribute("href"),
    ).toBe("#/p/djdl/services");
  });

  it("shows every group while enablement is unknown", async () => {
    // Fail-open: the worker gates each endpoint itself, so the filter is an affordance, and
    // hiding first then revealing would make the nav jump under the cursor.
    boot("#/p/djdl", { perProduct: { djdl: undefined } });
    await ready();
    expect(sectionHeaders()).toEqual(SECTIONS.map((s) => s.label));
  });

  it("shows only platform links off a product (SH-10)", async () => {
    boot("#/products");
    await screen.findByRole("navigation", { name: "Console" });
    expect(sectionHeaders()).toEqual([]);
    expect(within(nav()).getByRole("link", { name: "Home" })).toBeTruthy();
    expect(within(nav()).getByRole("link", { name: "Products" })).toBeTruthy();
  });
});

describe("items and headers (owner, 2026-10-03)", () => {
  it("every nav item renders an icon", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    // Only the active section starts open, so peek into the rest: every item, not just Core's.
    await expandAll();
    const links = within(nav()).getAllByRole("link");
    expect(links.length).toBeGreaterThan(10);
    // Exactly the nav model's items: the platform links, then every section's.
    expect(links.map((a) => a.textContent)).toEqual([
      ...platformLinks().map((p) => p.label),
      ...SECTIONS.flatMap((s) => navItems(s).map((p) => p.label)),
    ]);
    for (const link of links) {
      expect(
        link.querySelector("svg[data-nav-icon]"),
        `${link.textContent} has no icon`,
      ).not.toBeNull();
    }
    // Including the two that had none before the redesign (SH-4).
    for (const name of ["Deliverables", "Compatibility", "Matrix", "Health"]) {
      expect(
        within(nav()).getByRole("link", { name }).querySelector("svg"),
      ).not.toBeNull();
    }
  });

  it("section headers render no icon", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    for (const el of nav().querySelectorAll("[data-section-header]")) {
      const icons = [...el.querySelectorAll("svg")].filter(
        (svg) => !svg.hasAttribute("data-disclosure"),
      );
      expect(icons, `${el.textContent} header has an icon`).toEqual([]);
    }
  });

  it("marks the current page with aria-current, and only it", async () => {
    boot("#/p/djdl/license/tiers", { services: ALL_ON });
    await ready();
    const current = within(nav())
      .getAllByRole("link")
      .filter((a) => a.getAttribute("aria-current") === "page");
    expect(current.map((a) => a.textContent)).toEqual(["Tiers"]);
  });

  it("a record page keeps its collection current", async () => {
    boot("#/p/djdl/config/profiles/trial", {
      services: ALL_ON,
      extra: {
        "/manage/api/products/djdl/config/profiles/trial": {
          id: "trial",
          name: "Trial",
          payload: {},
        },
      },
    });
    await ready();
    expect(
      within(nav())
        .getByRole("link", { name: "Profiles" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("items are real links (middle-click and open in a new tab work, SH-5)", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    await expand("License");
    expect(
      within(nav())
        .getByRole("link", { name: "Licenses" })
        .getAttribute("href"),
    ).toBe("#/p/djdl/license/licenses");
  });
});

describe("collapsible section headers (owner, 2026-10-03)", () => {
  it("opens only the active section at load; every other is collapsed", async () => {
    boot("#/p/djdl/license/tiers", { services: ALL_ON });
    await ready();
    for (const section of SECTIONS) {
      expect(expanded(section.label), section.label).toBe(
        section.key === "license" ? "true" : "false",
      );
    }
    // Only the active section's items render, beside the platform links.
    const license = SECTIONS.find((s) => s.key === "license")!;
    expect(navLinkLabels()).toEqual([
      ...platformLinks().map((p) => p.label),
      ...navItems(license).map((p) => p.label),
    ]);
  });

  it("on a Core page, Core is the open section", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    for (const section of SECTIONS) {
      expect(expanded(section.label), section.label).toBe(
        section.key === "core" ? "true" : "false",
      );
    }
    const core = SECTIONS.find((s) => s.key === "core")!;
    expect(navLinkLabels()).toEqual([
      ...platformLinks().map((p) => p.label),
      ...navItems(core).map((p) => p.label),
    ]);
  });

  it("each header is a disclosure button with aria-expanded and aria-controls", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    const license = header("License");
    expect(license.tagName).toBe("BUTTON");
    expect(license.getAttribute("aria-expanded")).toBe("false");
    const controls = license.getAttribute("aria-controls")!;
    expect(controls).toBeTruthy();
    await expand("License");
    const region = document.getElementById(controls)!;
    expect(within(region).getByRole("link", { name: "Licenses" })).toBeTruthy();
  });

  it("a collapsed header expands as a peek on click, and with Enter and Space", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    const license = header("License");
    expect(within(nav()).queryByRole("link", { name: "Licenses" })).toBeNull();

    await userEvent.click(license);
    expect(license.getAttribute("aria-expanded")).toBe("true");
    expect(within(nav()).getByRole("link", { name: "Licenses" })).toBeTruthy();
    await userEvent.click(license);
    expect(license.getAttribute("aria-expanded")).toBe("false");
    expect(within(nav()).queryByRole("link", { name: "Licenses" })).toBeNull();

    license.focus();
    await userEvent.keyboard("{Enter}");
    expect(license.getAttribute("aria-expanded")).toBe("true");
    await userEvent.keyboard(" ");
    expect(license.getAttribute("aria-expanded")).toBe("false");
    await userEvent.keyboard(" ");
    expect(license.getAttribute("aria-expanded")).toBe("true");

    // A peek touches only its own section.
    expect(expanded("Core")).toBe("true");
    expect(expanded("Config")).toBe("false");
  });

  it("a collapsed section keeps its header and its accent cue", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    expect(expanded("Config")).toBe("false");
    const group = nav().querySelector('[data-section="config"]')!;
    expect(group.getAttribute("data-service")).toBe("config");
    expect(
      within(group as HTMLElement).getByRole("button", { name: "Config" }),
    ).toBeTruthy();
    expect(
      group.querySelector("[data-section-header] .bg-accent"),
    ).not.toBeNull();
  });

  it("entering another section opens it and collapses the previous one and every peek", async () => {
    boot("#/p/djdl/license/tiers", { services: ALL_ON });
    await ready();
    await expand("Config");
    await expand("Release");

    // Follow a link inside a peeked section.
    await userEvent.click(
      within(nav()).getByRole("link", { name: "Profiles" }),
    );
    await waitFor(() =>
      expect(
        within(nav())
          .getByRole("link", { name: "Profiles" })
          .getAttribute("aria-current"),
      ).toBe("page"),
    );
    expect(expanded("Config")).toBe("true");
    expect(expanded("License")).toBe("false");
    expect(expanded("Release")).toBe("false");
    expect(within(nav()).queryByRole("link", { name: "Tiers" })).toBeNull();
    expect(within(nav()).queryByRole("link", { name: "Releases" })).toBeNull();

    // And by URL, into Core.
    act(() => {
      window.location.hash = "#/p/djdl/activity";
    });
    await waitFor(() => expect(expanded("Core")).toBe("true"));
    expect(expanded("Config")).toBe("false");
    for (const section of SECTIONS.filter((s) => s.key !== "core")) {
      expect(expanded(section.label), section.label).toBe("false");
    }
  });

  it("a peek stays open while you move between pages of the active section", async () => {
    boot("#/p/djdl/license/tiers", { services: ALL_ON });
    await ready();
    await expand("Config");
    await userEvent.click(
      within(nav()).getByRole("link", { name: "Licenses" }),
    );
    await waitFor(() =>
      expect(
        within(nav())
          .getByRole("link", { name: "Licenses" })
          .getAttribute("aria-current"),
      ).toBe("page"),
    );
    expect(expanded("Config")).toBe("true");
  });

  it("the section holding the current page cannot be collapsed", async () => {
    boot("#/p/djdl/license/tiers", { services: ALL_ON });
    await ready();
    const license = header("License");
    expect(license.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(license);
    expect(license.getAttribute("aria-expanded")).toBe("true");
    license.focus();
    await userEvent.keyboard("{Enter}");
    expect(license.getAttribute("aria-expanded")).toBe("true");
    await userEvent.keyboard(" ");
    expect(license.getAttribute("aria-expanded")).toBe("true");
    expect(within(nav()).getByRole("link", { name: "Tiers" })).toBeTruthy();
  });

  it("persists nothing: no storage writes, and a peek does not survive a reload", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    const before = { ...window.localStorage };
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    await expand("Config");
    await expand("Release");
    await userEvent.click(header("Release"));
    act(() => {
      window.location.hash = "#/p/djdl/license/tiers";
    });
    await waitFor(() => expect(expanded("License")).toBe("true"));
    await expand("Identity");
    expect(setItem).not.toHaveBeenCalled();
    expect({ ...window.localStorage }).toEqual(before);
    setItem.mockRestore();
    cleanup();

    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    for (const section of SECTIONS) {
      expect(expanded(section.label), section.label).toBe(
        section.key === "core" ? "true" : "false",
      );
    }
  });
});

describe("accents and the section bit (BRAND.md §6)", () => {
  it("tags each sidebar group with its section's brand token", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    expect(
      [...nav().querySelectorAll("[data-section]")].map((el) =>
        el.getAttribute("data-service"),
      ),
    ).toEqual(SECTIONS.map((s) => s.accent));
  });

  it("accents the content and <html> from the current route's section", async () => {
    boot("#/p/djdl/license/tiers", { services: ALL_ON });
    await ready();
    const main = screen.getByRole("main");
    expect(
      main.querySelector("[data-service]")?.getAttribute("data-service"),
    ).toBe("license");
    expect(document.documentElement.getAttribute("data-service")).toBe(
      "license",
    );
  });

  it("the header mark: no bit on Home, Products and Core; each service section's own accent elsewhere", async () => {
    // The display cut's terminal bit (the kit's "gold" path).
    const BIT_D = "M70 85 L84 71 L90 77 L76 91 Z";
    boot("#/p/djdl", { services: ALL_ON });
    const brand = await screen.findByRole("link", { name: "Polaris Key home" });
    expect(brand.querySelector("svg")!.getAttribute("width")).toBe("48");
    const theme = (): "dark" | "light" =>
      document.documentElement.classList.contains("light") ? "light" : "dark";
    const bit = (): Element | null => brand.querySelector(`path[d="${BIT_D}"]`);

    // Core: the bare Pinned K, with no bit element at all.
    expect(bit()).toBeNull();
    expect(brand.querySelector(".polaris-section-bit")).toBeNull();

    for (const page of PRODUCT_PAGES.filter((p) => p.ready && p.inNav)) {
      const section = SECTIONS.find((s) => s.items.includes(page))!;
      act(() => {
        window.location.hash = `#/p/djdl${page.path ? `/${page.path}` : ""}`;
      });
      await waitFor(() =>
        expect(document.documentElement.getAttribute("data-service")).toBe(
          section.accent,
        ),
      );
      if (section.accent === "core") {
        expect(bit(), page.page).toBeNull();
      } else {
        await waitFor(() =>
          expect(bit()?.getAttribute("fill"), page.page).toBe(
            SERVICE_ACCENTS[theme()][section.accent as ServiceAccentKey].bit,
          ),
        );
        expect(bit()!.classList.contains("polaris-section-bit")).toBe(true);
      }
    }

    act(() => {
      window.location.hash = "#/products";
    });
    await waitFor(() => expect(bit()).toBeNull());
  });

  it("leaves <html> unsectioned once the shell is gone", async () => {
    boot("#/p/djdl/license/tiers", { services: ALL_ON });
    await ready();
    cleanup();
    expect(document.documentElement.hasAttribute("data-service")).toBe(false);
  });
});

describe("the product switcher keeps the page (SH-11)", () => {
  async function switchTo(name: RegExp): Promise<void> {
    await userEvent.click(
      await screen.findByRole("button", { name: /^Product: DJDL \(djdl\)/ }),
    );
    await userEvent.click(await screen.findByRole("option", { name }));
  }

  it("stays on the same page when the target product runs that service", async () => {
    boot("#/p/djdl/license/tiers", { services: ALL_ON });
    await ready();
    await switchTo(/^Acme/);
    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/acme/license/tiers"),
    );
  });

  it("lands on the target's Overview when it does not run the page's service", async () => {
    boot("#/p/djdl/license/tiers", {
      services: ALL_ON,
      perProduct: { acme: { ...ALL_ON, license: { enabled: false } } },
    });
    await ready();
    await switchTo(/^Acme/);
    await waitFor(() => expect(window.location.hash).toBe("#/p/acme"));
  });

  it("drops a record id: it names something in the old product", async () => {
    boot("#/p/djdl/config/profiles/trial", {
      services: ALL_ON,
      extra: {
        "/manage/api/products/djdl/config/profiles/trial": {
          id: "trial",
          name: "Trial",
          payload: {},
        },
      },
    });
    await ready();
    await switchTo(/^Acme/);
    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/acme/config/profiles"),
    );
  });

  it("names itself for assistive tech, and filters as you type", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Product: DJDL (djdl). Change product",
      }),
    );
    await userEvent.type(
      await screen.findByRole("combobox", { name: "Find a product" }),
      "acm",
    );
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options.some((t) => t?.startsWith("Acme"))).toBe(true);
    expect(options.some((t) => t?.startsWith("DJDL"))).toBe(false);
  });
});

describe("the mobile drawer (SH-2)", () => {
  it("is closed until opened, is a modal, and Escape closes it", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull();

    const menu = screen.getByRole("button", { name: "Open navigation" });
    await userEvent.click(menu);
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    expect(
      within(drawer).getByRole("navigation", { name: "Console" }),
    ).toBeTruthy();
    // The page behind is hidden from assistive tech while the drawer is open.
    expect(
      screen
        .getByRole("main", { hidden: true })
        .closest("[aria-hidden='true']"),
    ).not.toBeNull();

    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(menu));
  });

  it("closes when the window grows to the desktop layout, releasing the page", async () => {
    // A controllable matchMedia: the desktop query starts false (a phone), then flips.
    const listeners = new Set<() => void>();
    let desktop = false;
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() {
        return query === "(min-width: 1024px)" ? desktop : false;
      },
      media: query,
      addEventListener: (_: string, fn: () => void) => {
        if (query === "(min-width: 1024px)") listeners.add(fn);
      },
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    }));
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    await userEvent.click(
      screen.getByRole("button", { name: "Open navigation" }),
    );
    await screen.findByRole("dialog", { name: "Navigation" });
    act(() => {
      desktop = true;
      for (const fn of listeners) fn();
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull(),
    );
    expect(screen.getByRole("main").closest("[aria-hidden='true']")).toBeNull();
  });

  it("closes when a link is followed", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    await userEvent.click(
      screen.getByRole("button", { name: "Open navigation" }),
    );
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    await userEvent.click(
      within(drawer).getByRole("link", { name: "Activity" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull(),
    );
    await waitFor(() => expect(window.location.hash).toBe("#/p/djdl/activity"));
  });
});

describe("state pages (T8)", () => {
  it("a deep link into a disabled section explains, and links to Services", async () => {
    boot("#/p/djdl/release/releases", {
      services: { ...ALL_ON, release: { enabled: false } },
    });
    expect(
      await screen.findByText("The Release service isn’t enabled for DJDL."),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Enable Release" }).getAttribute("href"),
    ).toBe("#/p/djdl/services");
  });

  it("gates a record deep link on its collection's section", async () => {
    boot("#/p/djdl/license/licenses/lic_1", {
      services: { ...ALL_ON, license: { enabled: false } },
    });
    expect(
      await screen.findByText("The License service isn’t enabled for DJDL."),
    ).toBeTruthy();
  });

  it("an unknown product suggests the closest slugs and the registry", async () => {
    boot("#/p/djd/license/licenses");
    expect(
      await screen.findByRole("heading", { name: "Unknown product" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "djdl" }).getAttribute("href"),
    ).toBe("#/p/djdl");
    expect(screen.queryByRole("link", { name: "acme" })).toBeNull();
    expect(screen.getByRole("link", { name: "All products" })).toBeTruthy();
    expect(screen.queryByText(/not authorized/i)).toBeNull();
  });

  it("an unknown page names the segment and offers Overview and the palette", async () => {
    boot("#/p/djdl/nonsense", { services: ALL_ON });
    expect(
      await screen.findByRole("heading", { name: "Page not found" }),
    ).toBeTruthy();
    expect(screen.getByText("nonsense")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Go to Overview" }).getAttribute("href"),
    ).toBe("#/p/djdl");
    await userEvent.click(
      screen.getByRole("button", { name: "Search or jump to…" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Command palette" }),
    ).toBeTruthy();
  });

  it("an unknown global path is not found, not Products (#/productsfoo)", async () => {
    boot("#/productsfoo");
    expect(
      await screen.findByRole("heading", { name: "Page not found" }),
    ).toBeTruthy();
    expect(screen.getByText("productsfoo")).toBeTruthy();
  });

  it("still renders a Core page for a product running no services", async () => {
    boot("#/p/djdl/settings", { services: NONE });
    await ready();
    expect(screen.queryByText(/isn’t enabled/)).toBeNull();
  });
});

describe("old URLs and history", () => {
  it("replaces an old URL with the new one, so Back does not loop", async () => {
    const replace = vi.spyOn(window.history, "replaceState");
    boot("#/p/djdl/tiers", { services: ALL_ON });
    await ready();
    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/djdl/license/tiers"),
    );
    expect(replace).toHaveBeenCalled();
    expect(
      within(nav())
        .getByRole("link", { name: "Tiers" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("sends a page that is not built yet to the page that holds it today", async () => {
    boot("#/p/djdl/config/edge-mint", { services: ALL_ON });
    await ready();
    await waitFor(() => expect(window.location.hash).toBe("#/p/djdl/keys"));
  });
});

describe("page heading, title and focus", () => {
  it("the top bar has no heading; the page's own title is the one h1 (SH-12)", async () => {
    boot("#/p/djdl/config/profiles", { services: ALL_ON });
    const h1 = await screen.findByRole("heading", {
      level: 1,
      name: "Profiles",
    });
    const topBar = screen
      .getByRole("link", { name: "Polaris Key home" })
      .closest("header")!;
    expect(within(topBar).queryAllByRole("heading")).toEqual([]);
    expect(h1.closest("main")).not.toBeNull();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("sets document.title to page · product · Polaris Key", async () => {
    boot("#/p/djdl/license/tiers", { services: ALL_ON });
    await waitFor(() =>
      expect(document.title).toBe("Tiers · DJDL · Polaris Key"),
    );
    act(() => {
      window.location.hash = "#/products";
    });
    await waitFor(() => expect(document.title).toBe("Products · Polaris Key"));
  });

  it("moves focus to the new page's h1 and announces it", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    await expand("License");
    await userEvent.click(within(nav()).getByRole("link", { name: "Tiers" }));
    const h1 = await screen.findByRole("heading", { level: 1, name: "Tiers" });
    await waitFor(() => expect(document.activeElement).toBe(h1));
    expect(document.getElementById("route-announcer")!.textContent).toBe(
      "Tiers, page loaded",
    );
  });

  it("the skip link is the first focusable element and targets main", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    await userEvent.tab();
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(document.activeElement).toBe(skip);
    await userEvent.click(skip);
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });
});

describe("the top bar", () => {
  it("the docs link is a labelled link to this page's docs (SH-13)", async () => {
    boot("#/p/djdl/license/tiers", { services: ALL_ON });
    const docs = await screen.findByRole("link", { name: "Docs" });
    expect(docs.getAttribute("href")).toBe("/docs/services/license/model/");
  });

  it.each([
    ["staging", "Staging"],
    ["dev", "Dev"],
  ] as const)(
    "shows the %s environment badge (A-1)",
    async (environment, label) => {
      boot("#/", { me: { environment } });
      const badge = await screen.findByText(label);
      expect(
        badge.closest("[data-environment]")!.getAttribute("data-environment"),
      ).toBe(environment);
    },
  );

  it.each([["prod"], [null], [undefined]] as const)(
    "hides the environment badge for %s",
    async (environment) => {
      boot("#/", { me: { environment } });
      await screen.findByRole("navigation", { name: "Console" });
      expect(document.querySelector("[data-environment]")).toBeNull();
    },
  );

  it("the account menu shows who is signed in and when the session ends (SH-14)", async () => {
    const ends = Math.floor(new Date(2026, 9, 3, 18, 40).getTime() / 1000);
    boot("#/", { me: { sessionExpiresAt: ends } });
    await userEvent.click(
      await screen.findByRole("button", { name: "Account menu" }),
    );
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("ada@x.io")).toBeTruthy();
    expect(within(menu).getByText(/^Session ends /)).toBeTruthy();
    expect(
      within(menu).getByRole("menuitem", { name: /Keyboard shortcuts/ }),
    ).toBeTruthy();
    expect(
      within(menu).getByRole("menuitem", { name: "Sign out" }),
    ).toBeTruthy();
  });

  it("omits the session end when the worker does not send it", async () => {
    boot("#/");
    await userEvent.click(
      await screen.findByRole("button", { name: "Account menu" }),
    );
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByText(/^Session ends /)).toBeNull();
  });

  it("opens the shortcut sheet with ?", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    fireEvent.keyDown(window, { key: "?" });
    const sheet = await screen.findByRole("dialog", {
      name: "Keyboard shortcuts",
    });
    expect(within(sheet).getByText("Go to Licenses")).toBeTruthy();
  });
});

describe("keyboard shortcuts (ADMIN.md §5.5)", () => {
  it("g then a page key goes there; g h goes Home", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "l" });
    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/djdl/license/licenses"),
    );
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "h" });
    await waitFor(() => expect(window.location.hash).toBe("#/"));
  });

  it("does not jump into a section the product does not run", async () => {
    boot("#/p/djdl", { services: { ...ALL_ON, release: { enabled: false } } });
    await ready();
    await waitFor(() => expect(sectionHeaders()).not.toContain("Release"));
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "r" });
    await new Promise((r) => setTimeout(r, 50));
    expect(window.location.hash).toBe("#/p/djdl");
  });

  it("never fires while typing in a field", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    const input = document.createElement("input");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "g" });
    fireEvent.keyDown(input, { key: "l" });
    fireEvent.keyDown(input, { key: "?" });
    await new Promise((r) => setTimeout(r, 50));
    expect(window.location.hash).toBe("#/p/djdl");
    expect(screen.queryByRole("dialog")).toBeNull();
    input.remove();
  });

  it("⌘\\ collapses the desktop sidebar to a rail, and persists it", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    await waitFor(() =>
      expect(
        within(nav()).getByRole("link", { name: "Licenses" }).textContent,
      ).toBe(""),
    );
    expect(window.localStorage.getItem(PREF_KEYS.sidebarRail)).toBe("true");
  });
});

describe("enablement edits refresh the nav", () => {
  it("a product with sections loaded from the registry draws them before its own row arrives", async () => {
    const enablement: Enablement = { ...ALL_ON, identity: { enabled: false } };
    boot("#/p/djdl", { services: enablement });
    await ready();
    await waitFor(() => expect(sectionHeaders()).not.toContain("Identity"));
  });
});
