import { lastAnnouncement } from "../src/ui/LiveRegion.js";
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
import { configureAxe } from "vitest-axe";
import { SERVICE_ACCENTS } from "@polaris-key/brand";
import {
  PRODUCT_PAGES,
  SECTIONS,
  SHIP_BUILDS_KEYS,
  navItems,
  type NavPage,
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

const axe = configureAxe({
  rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
});

beforeEach(resetConsole);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const nav = (): HTMLElement =>
  screen.getAllByRole("navigation", { name: "Console" })[0]!;

/**
 * The sidebar's feature group headers, in render order (ST-45: Core is a flat list with no header,
 * and a feature with one page is a single link row, which carries the header attribute too).
 */
function sectionHeaders(): string[] {
  return [...nav().querySelectorAll("[data-section-header]")].map(
    (el) => el.textContent ?? "",
  );
}

/**
 * The sidebar's feature groups: one per section, but Release, Distribution and Update are one
 * group, "Ship builds" (B5), holding all of their pages under the first one's key.
 */
interface Group {
  key: string;
  label: string;
  accent: string;
  pages: NavPage[];
}
const GROUPS: Group[] = [];
for (const s of SECTIONS) {
  if (s.key === "core") continue;
  const pages = navItems(s, {});
  const ship = SHIP_BUILDS_KEYS.includes(s.key);
  const held = ship ? GROUPS.find((g) => g.label === "Ship builds") : undefined;
  if (held) held.pages.push(...pages);
  else
    GROUPS.push({
      key: s.key,
      label: ship ? "Ship builds" : s.label,
      accent: s.accent,
      pages,
    });
}
/** A feature with exactly one page is one row: its label is the link (no disclosure). */
const isSingle = (g: Group): boolean => g.pages.length === 1;
/** The feature groups that fold: every group but the one-page ones. */
const FOLDING = GROUPS.filter((g) => !isSingle(g));
const FEATURES = GROUPS;

const header = (label: string): HTMLElement =>
  within(nav()).getByRole("button", { name: label });

async function ready(): Promise<void> {
  await screen.findByRole("navigation", { name: "Console" });
  await waitFor(() =>
    expect(within(nav()).queryAllByRole("link").length).toBeGreaterThan(0),
  );
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
  for (const s of FOLDING) await expand(s.label);
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
        "Licensing",
        "Managed config",
        "Ship builds",
        "Sign-in",
        "Cloud Sync",
        "Commerce",
        "Cloud Connect",
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
        "Licensing",
        "Managed config",
        "Ship builds",
        "Sign-in",
        "Cloud Sync",
        "Commerce",
        "Cloud Connect",
      ]),
    );
    expect(within(nav()).queryByRole("link", { name: "Releases" })).toBeNull();
    expect(within(nav()).queryByRole("link", { name: "Feed" })).toBeNull();
  });

  it("keeps Core → Settings reachable for a product that runs nothing, and Services is its tab", async () => {
    boot("#/p/djdl", { services: NONE });
    await ready();
    await waitFor(() => expect(sectionHeaders()).toEqual([]));
    expect(
      within(nav())
        .getByRole("link", { name: "Settings" })
        .getAttribute("href"),
    ).toBe("#/p/djdl/settings");
    // ST-08: Services is no sidebar item; it is a tab of the settings hub.
    expect(within(nav()).queryByRole("link", { name: "Services" })).toBeNull();
  });

  it("shows every group while enablement is unknown", async () => {
    // Fail-open: the worker gates each endpoint itself, so the filter is an affordance, and
    // hiding first then revealing would make the nav jump under the cursor.
    boot("#/p/djdl", { perProduct: { djdl: undefined } });
    await ready();
    expect(sectionHeaders()).toEqual(FEATURES.map((s) => s.label));
  });

  it("shows only platform links off a product (SH-10)", async () => {
    boot("#/");
    await screen.findByRole("navigation", { name: "Console" });
    expect(sectionHeaders()).toEqual([]);
    // The Platform context lists Home and the Platform pages themselves (ST-45), no product's.
    expect(within(nav()).getByRole("link", { name: "Home" })).toBeTruthy();
    expect(within(nav()).getByRole("link", { name: "Status" })).toBeTruthy();
    expect(within(nav()).queryByRole("link", { name: "Overview" })).toBeNull();
    // The products are on Home: no Products link of their own (ST-44).
    expect(within(nav()).queryByRole("link", { name: "Products" })).toBeNull();
  });

  it("lists neither Matrix nor Override migration; their URLs still answer (P0-47)", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    await expandAll();
    // The matrix is Rollouts' view (UX-31); the override migration run is cancelled (U-03).
    expect(within(nav()).getByRole("link", { name: "Rollouts" })).toBeTruthy();
    expect(within(nav()).queryByRole("link", { name: "Matrix" })).toBeNull();
    cleanup();
    boot("#/");
    await screen.findByRole("navigation", { name: "Console" });
    expect(
      await within(nav()).findByRole("link", { name: "Store connections" }),
    ).toBeTruthy();
    expect(
      within(nav()).queryByRole("link", { name: "Override migration" }),
    ).toBeNull();
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
    // Exactly the nav model's items: Core's pages, every feature's (a one-page feature is one row
    // named for the feature), then Settings in the foot. No platform page.
    const core = SECTIONS.find((x) => x.key === "core")!;
    const coreItems = navItems(core).filter((p) => p.page !== "settings");
    expect(links.map((a) => a.textContent)).toEqual([
      ...coreItems.map((p) => p.label),
      // Ship builds → Packages is listed whenever Distribution is on (F-34.7).
      ...FEATURES.flatMap((g) =>
        isSingle(g) ? [g.label] : g.pages.map((p) => p.label),
      ),
      "Settings",
    ]);
    for (const link of links.filter(
      (a) => !a.hasAttribute("data-section-header"),
    )) {
      expect(
        link.querySelector("svg[data-nav-icon]"),
        `${link.textContent} has no icon`,
      ).not.toBeNull();
    }
    // Including the two that had none before the redesign (SH-4).
    for (const name of ["Deliverables", "Compatibility", "Health"]) {
      expect(
        within(nav()).getByRole("link", { name }).querySelector("svg"),
      ).not.toBeNull();
    }
  });

  it("section headers render no icon", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    expect(
      nav().querySelectorAll("[data-section-header]").length,
    ).toBeGreaterThan(0);
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
    await expand("Licensing");
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
    for (const section of FOLDING) {
      expect(expanded(section.label), section.label).toBe(
        section.key === "license" ? "true" : "false",
      );
    }
    // Only the active group's items render, between Core's pages and the foot's Settings.
    const license = SECTIONS.find((s) => s.key === "license")!;
    const core = SECTIONS.find((s) => s.key === "core")!;
    expect(navLinkLabels()).toEqual([
      ...navItems(core)
        .filter((p) => p.page !== "settings")
        .map((p) => p.label),
      ...navItems(license).map((p) => p.label),
      ...FEATURES.filter(isSingle).map((s) => s.label),
      "Settings",
    ]);
  });

  it("on a Core page, every feature group is collapsed and Core's pages are a flat list", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    for (const section of FOLDING) {
      expect(expanded(section.label), section.label).toBe("false");
    }
    expect(within(nav()).queryByRole("button", { name: "Core" })).toBeNull();
    const core = SECTIONS.find((s) => s.key === "core")!;
    expect(navLinkLabels()).toEqual([
      ...navItems(core)
        .filter((p) => p.page !== "settings")
        .map((p) => p.label),
      ...FEATURES.filter(isSingle).map((s) => s.label),
      "Settings",
    ]);
  });

  it("each header is a disclosure button with aria-expanded and aria-controls", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    const license = header("Licensing");
    expect(license.tagName).toBe("BUTTON");
    expect(license.getAttribute("aria-expanded")).toBe("false");
    const controls = license.getAttribute("aria-controls")!;
    expect(controls).toBeTruthy();
    await expand("Licensing");
    const region = document.getElementById(controls)!;
    expect(within(region).getByRole("link", { name: "Licenses" })).toBeTruthy();
  });

  it("a collapsed header expands as a peek on click, and with Enter and Space", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    const license = header("Licensing");
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
    expect(expanded("Managed config")).toBe("false");
  });

  it("a collapsed section keeps its header and its accent cue", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    expect(expanded("Managed config")).toBe("false");
    const group = nav().querySelector('[data-section="config"]')!;
    expect(group.getAttribute("data-service")).toBe("config");
    expect(
      within(group as HTMLElement).getByRole("button", {
        name: "Managed config",
      }),
    ).toBeTruthy();
    expect(
      group.querySelector("[data-section-header] .bg-accent"),
    ).not.toBeNull();
  });

  it("entering another section opens it and collapses the previous one and every peek", async () => {
    boot("#/p/djdl/license/tiers", { services: ALL_ON });
    await ready();
    await expand("Managed config");
    await expand("Ship builds");

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
    expect(expanded("Managed config")).toBe("true");
    expect(expanded("Licensing")).toBe("false");
    expect(expanded("Ship builds")).toBe("false");
    expect(within(nav()).queryByRole("link", { name: "Tiers" })).toBeNull();
    expect(within(nav()).queryByRole("link", { name: "Releases" })).toBeNull();

    // And by URL, into Core.
    act(() => {
      window.location.hash = "#/p/djdl/activity";
    });
    await waitFor(() =>
      expect(
        within(nav())
          .getByRole("link", { name: "Activity" })
          .getAttribute("aria-current"),
      ).toBe("page"),
    );
    expect(expanded("Managed config")).toBe("false");
    for (const section of FOLDING) {
      expect(expanded(section.label), section.label).toBe("false");
    }
  });

  it("a peek stays open while you move between pages of the active section", async () => {
    boot("#/p/djdl/license/tiers", { services: ALL_ON });
    await ready();
    await expand("Managed config");
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
    expect(expanded("Managed config")).toBe("true");
  });

  it("the section holding the current page cannot be collapsed", async () => {
    boot("#/p/djdl/license/tiers", { services: ALL_ON });
    await ready();
    const license = header("Licensing");
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
    // Overview's own reads land first: its first visit records what it saw for its one-time
    // moments (MO-11). The sidebar is what this test watches.
    await screen.findByText(/0 settings/);
    await screen.findByText(/No releases yet/);
    await screen.findByRole("list", { name: "Integration steps" });
    const before = { ...window.localStorage };
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    await expand("Managed config");
    await expand("Ship builds");
    await userEvent.click(header("Ship builds"));
    act(() => {
      window.location.hash = "#/p/djdl/license/tiers";
    });
    await waitFor(() => expect(expanded("Licensing")).toBe("true"));
    await expand("Ship builds");
    expect(setItem).not.toHaveBeenCalled();
    expect({ ...window.localStorage }).toEqual(before);
    setItem.mockRestore();
    cleanup();

    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    for (const section of FOLDING) {
      expect(expanded(section.label), section.label).toBe("false");
    }
  });
});

describe("accents and the section bit (BRAND.md §6)", () => {
  it("tags each sidebar group with its section's brand token", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    expect(
      [...nav().querySelectorAll("[data-section]")].map((el) => [
        el.getAttribute("data-section"),
        el.getAttribute("data-service"),
      ]),
    ).toEqual(
      // Core is a flat list, not a group; no platform group inside a product.
      FEATURES.map((s) => [s.key, s.accent]),
    );
  });

  it("gives the Platform context the core accent, off a product", async () => {
    boot("#/", { services: ALL_ON });
    await screen.findByRole("heading", { level: 1, name: "Home" });
    expect(nav().getAttribute("data-context")).toBe("platform");
    expect(nav().querySelector("[data-section]")).toBeNull();
    expect(
      nav().querySelector("[data-nav-list] ul")?.getAttribute("data-service"),
    ).toBe("core");
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

  it("the header mark: no bit on Home and Core; each service section's own accent elsewhere", async () => {
    // The display cut's terminal bit (the kit's "gold" path).
    const BIT_D = "M70 85 L84 71 L90 77 L76 91 Z";
    boot("#/p/djdl", { services: ALL_ON });
    const brand = await screen.findByRole("link", {
      name: "Polaris Key Console home",
    });
    // The kit's compact Key lockup is 52 px tall (as on plrs.im); the mark alone shows under 640 px.
    expect(brand.querySelector("svg")!.getAttribute("height")).toBe("52");
    // Guard (BR-lockups): the name is drawn by the lockup, never live text beside the mark.
    expect(brand.textContent).toBe("");
    const theme = (): "dark" | "light" =>
      document.documentElement.classList.contains("light") ? "light" : "dark";
    const bit = (): Element | null => brand.querySelector(`path[d="${BIT_D}"]`);

    // Core: the bare Pinned K, with no bit element at all.
    expect(bit()).toBeNull();
    expect(brand.querySelector(".polaris-section-bit")).toBeNull();

    for (const page of PRODUCT_PAGES.filter((p) => p.inNav)) {
      const section = SECTIONS.find((s) => s.items.includes(page))!;
      const accent = page.accent ?? section.accent;
      act(() => {
        window.location.hash = `#/p/djdl${page.path ? `/${page.path}` : ""}`;
      });
      await waitFor(() =>
        expect(document.documentElement.getAttribute("data-service")).toBe(
          accent,
        ),
      );
      if (accent === "core") {
        expect(bit(), page.page).toBeNull();
      } else {
        await waitFor(() =>
          expect(bit()?.getAttribute("fill"), page.page).toBe(
            SERVICE_ACCENTS[theme()][accent as ServiceAccentKey].bit,
          ),
        );
        expect(bit()!.classList.contains("polaris-section-bit")).toBe(true);
      }
    }

    act(() => {
      window.location.hash = "#/";
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

  it("the platform's attention item (product null) is no product's badge (ST-44b.2)", async () => {
    boot("#/p/djdl", {
      services: ALL_ON,
      extra: {
        "/manage/api/attention": {
          items: [
            {
              id: "@platform:sync.paused",
              product: null,
              kind: "sync.paused",
              tone: "warning",
              service: "sync",
              short: "Writes paused",
              lines: ["Cloud Sync writes are paused for every product."],
              action: {
                label: "Resume writes",
                page: "platform-settings",
                query: { setting: "cloudSync.writesPaused" },
              },
              area: "platform",
            },
          ],
        },
      },
    });
    await ready();
    await userEvent.click(
      screen.getByRole("button", { name: /^Product: DJDL \(djdl\)/ }),
    );
    const options = await screen.findAllByRole("option");
    expect(options.length).toBeGreaterThan(1);
    for (const o of options) expect(o.textContent).not.toMatch(/attention/);
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

describe("context card and selected rows (ST-45 fix round)", () => {
  it("names the switcher dialog and wraps the card name instead of truncating", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    const card = within(nav()).getByRole("button", { name: /^Product: DJDL/ });
    expect(card.className).toContain("min-h-[72px]");
    expect(card.className).not.toMatch(/(^| )h-\[72px\]/);
    await userEvent.click(card);
    expect(
      await screen.findByRole("dialog", { name: "Switch product" }),
    ).toBeTruthy();
  });

  it("a selected one-row feature carries the 3 px marker, not the fill alone", async () => {
    boot("#/p/djdl/sync/data", { services: ALL_ON });
    await ready();
    const row = nav().querySelector("[data-section-header=sync]")!;
    expect(row.getAttribute("aria-current")).toBe("page");
    expect(row.className).toContain("before:w-[3px]");
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
    // The page behind is hidden from assistive tech while the drawer is open (inert is stronger).
    expect(
      screen
        .getByRole("main", { hidden: true })
        .closest("[aria-hidden='true'], [inert]"),
    ).not.toBeNull();

    // Opening moves focus to the first item; the page behind is inert; the toggle says so.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(drawer).getAllByRole("link")[0],
      ),
    );
    expect(document.getElementById("content")!.hasAttribute("inert")).toBe(
      true,
    );
    expect(menu.getAttribute("aria-label")).toBe("Close navigation");
    expect(menu.getAttribute("aria-expanded")).toBe("true");

    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Navigation" })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(menu));
    expect(menu.getAttribute("aria-label")).toBe("Open navigation");
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById("content")!.hasAttribute("inert")).toBe(
      false,
    );
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
    // B-007: the top-bar button is `lg:hidden` now; focus goes to the desktop sidebar's current
    // link (else the content), never <body>.
    await waitFor(() => {
      const active = document.activeElement;
      expect(active).not.toBe(document.body);
      expect(
        active?.closest("aside") !== null || active?.id === "content",
      ).toBe(true);
    });
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
  it("B-013: a deep link into a disabled section explains in feature words, and links to Features", async () => {
    boot("#/p/djdl/release/releases", {
      services: { ...ALL_ON, release: { enabled: false } },
    });
    expect(
      await screen.findByText("Ship builds is off for DJDL."),
    ).toBeTruthy();
    expect(screen.getByText(/Turn it on in Features/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/service|Services/);
    expect(
      screen.getByRole("link", { name: "Open Features" }).getAttribute("href"),
    ).toBe("#/p/djdl/settings/features");
  });

  it("B-014: Commerce Overview shows its own off view, not the shell's service-off page", async () => {
    const stores = { configured: false, credential: null, reason: null };
    boot("#/p/djdl/commerce", {
      services: { ...ALL_ON, commerce: { enabled: false } },
      extra: {
        "/manage/api/products/djdl/commerce": {
          licenseEnabled: true,
          setup: { "app-store": stores, play: stores, steam: stores },
          products: [],
          purchases: [],
        },
      },
    });
    expect(
      await screen.findByText("Commerce is off for this product"),
    ).toBeTruthy();
    expect(screen.queryByText(/is off for DJDL\./)).toBeNull();
    expect(
      screen.getByRole("link", { name: "Open Features" }).getAttribute("href"),
    ).toBe("#/p/djdl/settings/features");
  });

  it("gates a record deep link on its collection's section", async () => {
    boot("#/p/djdl/license/licenses/lic_1", {
      services: { ...ALL_ON, license: { enabled: false } },
    });
    expect(await screen.findByText("Licensing is off for DJDL.")).toBeTruthy();
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

  it("an unknown page names the segment and offers Overview and the palette, searching for it", async () => {
    boot("#/p/djdl/license/nonsense", { services: ALL_ON });
    expect(
      await screen.findByRole("heading", { name: "Page not found" }),
    ).toBeTruthy();
    expect(screen.getByText("license/nonsense")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Go to Overview" }).getAttribute("href"),
    ).toBe("#/p/djdl");
    await userEvent.click(
      screen.getByRole("button", { name: "Search or jump to…" }),
    );
    const palette = await screen.findByRole("dialog", {
      name: "Command palette",
    });
    const input = within(palette).getByRole("combobox", {
      name: "Search or jump to",
    }) as HTMLInputElement;
    // The dead segment, selected, so typing replaces it.
    expect(input.value).toBe("nonsense");
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 8]);
    await userEvent.keyboard("tiers");
    expect(input.value).toBe("tiers");
    // Closed and opened from the top bar, the palette starts empty again.
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Command palette" }),
      ).toBeNull(),
    );
    await userEvent.click(
      within(screen.getByRole("banner")).getByRole("button", {
        name: "Search or jump to",
      }),
    );
    expect(
      (
        await screen.findByRole("combobox", { name: "Search or jump to" })
      ).getAttribute("value") ?? "",
    ).toBe("");
  });

  it("a not-found page under a product keeps the product's switcher and sidebar", async () => {
    boot("#/p/djdl/nonsense", { services: ALL_ON });
    await screen.findByRole("heading", { name: "Page not found" });
    await ready();
    expect(sectionHeaders()).toContain("Licensing");
    await userEvent.click(
      screen.getByRole("button", {
        name: "Product: DJDL (djdl). Change product",
      }),
    );
    await userEvent.click(await screen.findByRole("option", { name: /^Acme/ }));
    await waitFor(() => expect(window.location.hash).toBe("#/p/acme"));
  });

  it("an old bookmark says where its page moved and links there, keeping the id and the query", async () => {
    const replace = vi.spyOn(window.history, "replaceState");
    boot("#/p/djdl/licenses?status=disabled", { services: ALL_ON });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Page moved" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "This page moved to Licensing\u00a0→\u00a0Licenses",
      }),
    ).toBeTruthy();
    // Not a redirect: the old address stays until the operator follows the link.
    expect(window.location.hash).toBe("#/p/djdl/licenses?status=disabled");
    expect(replace).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(document.title).toBe("Page moved · DJDL · Polaris Key Console"),
    );
    // The product's chrome stays.
    expect(
      screen.getByRole("button", {
        name: "Product: DJDL (djdl). Change product",
      }),
    ).toBeTruthy();
    const go = screen.getByRole("link", { name: "Go to Licenses" });
    expect(go.getAttribute("href")).toBe(
      "#/p/djdl/license/licenses?status=disabled",
    );
    await userEvent.click(go);
    await waitFor(() =>
      expect(window.location.hash).toBe(
        "#/p/djdl/license/licenses?status=disabled",
      ),
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: /^Licenses/ }),
    ).toBeTruthy();
  });

  it("names the new home of every kind of old bookmark", async () => {
    for (const [old, title, link, href] of [
      [
        "#/p/djdl/licenses/lic_1",
        "This page moved to Licensing\u00a0→\u00a0Licenses",
        "Open license lic_1",
        "#/p/djdl/license/licenses/lic_1",
      ],
      [
        "#/p/djdl/secrets",
        "This page moved to Settings\u00a0→\u00a0Keys and secrets",
        "Go to Keys and secrets",
        "#/p/djdl/settings/keys",
      ],
      [
        "#/p/djdl/overview",
        "This page moved to Core\u00a0→\u00a0Overview",
        "Go to Overview",
        "#/p/djdl",
      ],
      [
        "#/p/djdl/deliverables/textures",
        "This page moved to Release\u00a0→\u00a0Deliverables",
        "Open deliverable textures",
        "#/p/djdl/release/deliverables/textures",
      ],
      [
        "#/p/djdl/updates",
        "This page moved to Update\u00a0→\u00a0Feed",
        "Go to Feed",
        "#/p/djdl/update/feed",
      ],
    ] as const) {
      boot(old, { services: ALL_ON });
      expect(
        await screen.findByRole("heading", { level: 2, name: title }),
        old,
      ).toBeTruthy();
      expect(
        screen.getByRole("link", { name: link }).getAttribute("href"),
        old,
      ).toBe(href);
      cleanup();
    }
  });

  it("a removed global page opens Page moved without a product, and passes axe", async () => {
    boot("#/products?setup=attention");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Page moved" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: "This page moved to Home",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Go to Home" }).getAttribute("href"),
    ).toBe("#/?attention=yes");
    await waitFor(() =>
      expect(document.title).toBe("Page moved · Polaris Key Console"),
    );
    const results = await axe(document.body);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });

  it("the retired Identity pages open Page moved naming App sign-in, and pass axe", async () => {
    boot("#/p/djdl/identity/portal", { services: ALL_ON });
    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: /^This page moved to/,
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /^Go to / }).getAttribute("href"),
    ).toBe("#/p/djdl/identity/app-sign-in");
    const results = await axe(document.body);
    expect(results.violations.map((v) => v.id)).toEqual([]);
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
    expect(screen.queryByText(/isn't enabled/)).toBeNull();
  });
});

describe("section roots and history", () => {
  it("replaces a section's root with its first page, so Back does not loop", async () => {
    const replace = vi.spyOn(window.history, "replaceState");
    boot("#/p/djdl/license", { services: ALL_ON });
    await ready();
    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/djdl/license/licenses"),
    );
    expect(replace).toHaveBeenCalled();
    expect(
      within(nav())
        .getByRole("link", { name: "Licenses" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });

  it("sends the Platform group's root to its first page", async () => {
    // `#/platform` is not a page: like a product section's key, it opens Settings.
    boot("#/platform", { services: ALL_ON });
    await screen.findByRole("navigation", { name: "Console" });
    await waitFor(() =>
      expect(window.location.hash).toBe("#/platform/settings"),
    );
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
      .getByRole("link", { name: "Polaris Key Console home" })
      .closest("header")!;
    expect(within(topBar).queryAllByRole("heading")).toEqual([]);
    expect(h1.closest("main")).not.toBeNull();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("sets document.title to page · product · Polaris Key Console", async () => {
    boot("#/p/djdl/license/tiers", { services: ALL_ON });
    await waitFor(() =>
      expect(document.title).toBe("Tiers · DJDL · Polaris Key Console"),
    );
    act(() => {
      window.location.hash = "#/tokens";
    });
    await waitFor(() =>
      expect(document.title).toBe("API tokens · Polaris Key Console"),
    );
  });

  it("moves focus to the new page's h1 and announces it", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    await expand("Licensing");
    await userEvent.click(within(nav()).getByRole("link", { name: "Tiers" }));
    const h1 = await screen.findByRole("heading", { level: 1, name: "Tiers" });
    await waitFor(() => expect(document.activeElement).toBe(h1));
    expect(lastAnnouncement()).toBe("Tiers, page loaded");
  });

  it("scrolls back to the top on every page change, but not when only the query changes (owner, 2026-10-03)", async () => {
    boot("#/p/djdl/license/licenses", { services: ALL_ON });
    await ready();
    const main = screen.getByRole("main");
    main.scrollTop = 640;
    await userEvent.click(within(nav()).getByRole("link", { name: "Tiers" }));
    await screen.findByRole("heading", { level: 1, name: "Tiers" });
    await waitFor(() => expect(main.scrollTop).toBe(0));

    // A query-string change on the same page (a filter, a tab) keeps the reader's place.
    main.scrollTop = 320;
    window.location.hash = "#/p/djdl/license/tiers?q=pro";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(main.scrollTop).toBe(320);
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
    expect(docs.getAttribute("href")).toBe(
      "/docs/features/licensing/manage-licenses/",
    );
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

  it("My library goes to the person's Polaris Locker library, on the customer host when there is one", async () => {
    boot("#/", { me: { customerOrigin: "https://polaris.locker" } });
    await userEvent.click(
      await screen.findByRole("button", { name: "Account menu" }),
    );
    const item = within(await screen.findByRole("menu")).getByRole("menuitem", {
      name: "My library",
    });
    expect(item.getAttribute("href")).toBe("https://polaris.locker/");
    expect(item.getAttribute("target")).toBe("_blank");
    cleanup();
    boot("#/");
    await userEvent.click(
      await screen.findByRole("button", { name: "Account menu" }),
    );
    expect(
      within(await screen.findByRole("menu"))
        .getByRole("menuitem", { name: "My library" })
        .getAttribute("href"),
    ).toBe("/");
  });

  it("an emergency sign-in shows a labelled banner with the end time, a top-bar pill and no My library; a normal one shows none", async () => {
    const ends = Math.floor(new Date(2026, 9, 3, 18, 40).getTime() / 1000);
    boot("#/", { me: { breakGlass: true, sessionExpiresAt: ends } });
    const region = await screen.findByRole("region", {
      name: "Emergency sign-in",
    });
    expect(region.textContent).toMatch(
      /You're using emergency sign-in until .+\. Sign out when you're done\./,
    );
    expect(
      within(region).getByRole("button", { name: "Sign out" }),
    ).toBeTruthy();
    expect(
      document.querySelector("[data-emergency] .sr-only")?.textContent,
    ).toMatch(/^Emergency sign-in until /);
    await userEvent.click(
      await screen.findByRole("button", { name: "Account menu" }),
    );
    expect(
      within(await screen.findByRole("menu")).queryByRole("menuitem", {
        name: "My library",
      }),
    ).toBeNull();
    cleanup();
    boot("#/");
    await screen.findByRole("button", { name: "Account menu" });
    expect(
      screen.queryByRole("region", { name: "Emergency sign-in" }),
    ).toBeNull();
    expect(document.querySelector("[data-emergency]")).toBeNull();
  });

  it("omits the session end when the worker does not send it", async () => {
    boot("#/");
    await userEvent.click(
      await screen.findByRole("button", { name: "Account menu" }),
    );
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByText(/^Session ends /)).toBeNull();
  });

  it("under 640 px the account menu carries the theme and motion choices the bar hides", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(width < 40rem)",
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    // The theme menu is still rendered; CSS hides it under 640 px (`max-sm:hidden`).
    expect(
      screen.getByRole("button", { name: /^Theme: / }).className,
    ).toContain("max-sm:hidden");
    await userEvent.click(screen.getByRole("button", { name: "Account menu" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("group", { name: "Theme" })).toBeTruthy();
    expect(within(menu).getByRole("group", { name: "Motion" })).toBeTruthy();
    await userEvent.click(
      within(menu).getByRole("menuitemradio", { name: "Light" }),
    );
    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe("light"),
    );
  });

  it("from 640 px the account menu leaves the theme to its own menu", async () => {
    boot("#/");
    await userEvent.click(
      await screen.findByRole("button", { name: "Account menu" }),
    );
    const menu = await screen.findByRole("menu");
    expect(within(menu).queryByRole("group", { name: "Theme" })).toBeNull();
  });

  it("opens the shortcut sheet with ?", async () => {
    boot("#/p/djdl", { services: ALL_ON });
    await ready();
    fireEvent.keyDown(window, { key: "?" });
    const sheet = await screen.findByRole("dialog", {
      name: "Keyboard shortcuts",
    });
    expect(within(sheet).getByText("Go to Licenses")).toBeTruthy();
    // P0-47: g m lands on Rollouts' matrix view, and the sheet says so.
    expect(within(sheet).getByText("Go to Rollouts (matrix)")).toBeTruthy();
    expect(within(sheet).queryByText("Go to Matrix")).toBeNull();
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
    boot("#/p/djdl", {
      services: {
        ...ALL_ON,
        release: { enabled: false },
        distribution: { enabled: false },
        update: { enabled: false },
      },
    });
    await ready();
    await waitFor(() => expect(sectionHeaders()).not.toContain("Ship builds"));
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
        within(nav()).getByRole("link", { name: "Overview" }).textContent,
      ).toBe(""),
    );
    // Only the active section lists its pages; another section is one icon named for it.
    expect(within(nav()).queryByRole("link", { name: "Licenses" })).toBeNull();
    expect(within(nav()).getByRole("link", { name: "Licensing" })).toBeTruthy();
    expect(window.localStorage.getItem(PREF_KEYS.sidebarRail)).toBe("true");
  });
});

describe("enablement edits refresh the nav", () => {
  it("a product with sections loaded from the registry draws them before its own row arrives", async () => {
    const enablement: Enablement = { ...ALL_ON, identity: { enabled: false } };
    boot("#/p/djdl", { services: enablement });
    await ready();
    await waitFor(() => expect(sectionHeaders()).not.toContain("Sign-in"));
  });
});
