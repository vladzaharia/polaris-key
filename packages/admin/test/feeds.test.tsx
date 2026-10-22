import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import {
  ALL_ON,
  PENDING,
  boot,
  productRow,
  resetConsole,
  servicesResponse,
} from "./consoleHarness.js";
import { feedDetail, feedRoutes, productOverview } from "./feedsFixture.js";
import {
  PACKAGES_POLL_MS,
  pollPackages,
} from "../src/console/sections/feeds/pages/PackagesOverview.js";
import { confirmFor } from "../src/lib/actions.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatFeedSetup,
  renderFeedSetup,
  type PackageEcosystem,
} from "@polaris-key/manifest";
import {
  ECOSYSTEM_LABELS,
  feedAccessChoice,
  feedAccessMode,
  feedSetupSnippets,
} from "../src/console/sections/feeds/model/model.js";

/** The shared setup-snippet cases and goldens (F-12), also run by the CLI's test. */
const SHARED_FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../shared-manifest/test/fixtures/feed-setup",
);
const { origin: SHARED_ORIGIN, cases: SHARED_CASES } = JSON.parse(
  readFileSync(join(SHARED_FIXTURES, "cases.json"), "utf8"),
) as {
  origin: string;
  cases: {
    id: string;
    ecosystem: PackageEcosystem;
    owner: string;
    namespace?: Record<string, unknown>;
  }[];
};

/**
 * Package feeds (F-11; plans/F-01.md §6.9): the overview, one page per feed and the package record,
 * one component set in two scopes. The product scope hides the Owner column and the platform
 * policy and appears only with package feeds on; settings save section by section with the
 * version they read; access modes other than Public are unavailable; version verbs follow the
 * protocol; every page has its loading, empty and error states and passes axe.
 */

const axe = configureAxe({
  rules: { "color-contrast": { enabled: false } },
});

beforeEach(resetConsole);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NPM_PATH = "/manage/api/products/djdl/distribution/feeds/npm";
const general = async (): Promise<HTMLElement> =>
  within(await mainReady()).findByRole("form", { name: "General" });
const main = (): HTMLElement => screen.getByRole("main");
/** The main column, once the shell has mounted. */
const mainReady = (): Promise<HTMLElement> => screen.findByRole("main");
const nav = (): HTMLElement =>
  screen.getAllByRole("navigation", { name: "Console" })[0]!;

/** The product's overview with these ecosystems declared (a feed page exists only for those). */
function declaring(...ecos: string[]): Record<string, unknown> {
  const overview = productOverview();
  overview.feeds = overview.feeds.map((f) =>
    ecos.includes(f.ecosystem)
      ? {
          ...f,
          configured: true,
          enabled: true,
          status: "enabled",
          reason: null,
        }
      : f,
  ) as typeof overview.feeds;
  return { "/manage/api/products/djdl/distribution/feeds": overview };
}

/** The product row with its package feeds switch. */
function product(packageFeeds: boolean): Record<string, unknown> {
  return {
    "/manage/api/products/djdl": {
      product: { ...productRow("djdl", "DJDL", ALL_ON), packageFeeds },
    },
  };
}

async function heading(name: string | RegExp): Promise<HTMLElement> {
  return screen.findByRole("heading", { level: 1, name });
}

/** The npm settings page with the feed stored at `accessMode`, and a PUT that answers `put`. */
function bootSettings(
  accessMode: string,
  put: unknown = {
    ok: true,
    settings: feedDetail("product", "npm").settings,
  },
  patch: Record<string, unknown> = {},
): ReturnType<typeof boot> {
  const routes = feedRoutes();
  const stored = feedDetail("product", "npm");
  routes[NPM_PATH] = {
    ...stored,
    settings: {
      ...stored.settings,
      accessMode,
      accessDisplay:
        accessMode === "public"
          ? "public"
          : accessMode === "entitled"
            ? "customers, packages gated individually"
            : "customers",
      ...patch,
    },
  };
  return boot("#/p/djdl/distribution/feeds/npm/settings", {
    extra: { ...routes, ...product(true), [`PUT ${NPM_PATH}/settings`]: put },
  });
}

describe("registry auth (F-21)", () => {
  it("Access is two options in General: Public and Customers, no Access section", async () => {
    bootSettings("public");
    const form = await general();
    const radios = within(form).getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Public"),
      expect.stringContaining("Customers"),
    ]);
    expect(
      within(form)
        .getByRole("radio", { name: /Public/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(form.textContent).not.toMatch(/Entitled|Unavailable/);
    expect(within(main()).queryByRole("form", { name: "Access" })).toBeNull();
    // Public: no token row.
    expect(
      within(form).queryByRole("link", { name: /Open Tokens/ }),
    ).toBeNull();
  });

  it("Customers shows the Tokens link; nothing to save while the choice is the stored one", async () => {
    const log = bootSettings("licensed");
    const form = await general();
    expect(
      within(form)
        .getByRole("radio", { name: /Customers/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(within(form).getByRole("link", { name: "Tokens" })).toBeTruthy();
    expect(form.textContent).toContain("Polaris Locker");
    expect(within(form).queryByRole("button", { name: /^Save/ })).toBeNull();
    expect(form.textContent).not.toContain("gated individually");
    expect(log.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("opening a Public feed to Customers stores licensed, after the L1 confirm", async () => {
    const log = bootSettings("public");
    const form = await general();
    await userEvent.click(
      within(form).getByRole("radio", { name: /Customers/ }),
    );
    await userEvent.click(within(form).getByRole("button", { name: /^Save/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("refused within 30 seconds");
    expect(dialog.textContent).not.toContain("401");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Switch to Customers" }),
    );
    await waitFor(() =>
      expect(log.calls.find((c) => c.method === "PUT")?.json).toEqual({
        expectedVersion: 3,
        accessMode: "licensed",
      }),
    );
  });

  it("widening Customers to Public asks first (L1) and writes public", async () => {
    const log = bootSettings("licensed");
    const form = await general();
    await userEvent.click(within(form).getByRole("radio", { name: /Public/ }));
    await userEvent.click(within(form).getByRole("button", { name: /^Save/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByRole("heading", { name: /Make the npm feed public/ }),
    ).toBeTruthy();
    expect(dialog.textContent).toContain("no credentials");
    expect(dialog.textContent).toContain("stays installed");
    expect(log.calls.some((c) => c.method === "PUT")).toBe(false);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Make feed public" }),
    );
    await waitFor(() =>
      expect(log.calls.find((c) => c.method === "PUT")?.json).toEqual({
        expectedVersion: 3,
        accessMode: "public",
      }),
    );
    expect(confirmFor("feed.widen").intent).not.toBe("none");
  });

  it("cancelling the widening confirm writes nothing", async () => {
    const log = bootSettings("licensed");
    const form = await general();
    await userEvent.click(within(form).getByRole("radio", { name: /Public/ }));
    await userEvent.click(within(form).getByRole("button", { name: /^Save/ }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: /Cancel/ }),
    );
    expect(log.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("an entitled feed reads Customers, packages gated individually, and is not rewritten", async () => {
    const log = bootSettings("entitled");
    const form = await general();
    expect(
      within(form)
        .getByRole("radio", { name: /Customers/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    // The selected card says the fact; there is no separate "Now" line.
    expect(
      within(form).getByRole("radio", { name: /Customers/ }).textContent,
    ).toContain("Packages gated individually");
    expect(form.textContent).not.toContain("Now:");
    // The packages without a gate are named, each linking to its Delivery tab.
    expect(form.textContent).toContain("entitlement");
    expect(
      within(form)
        .getByRole("link", { name: "@djdl/sdk" })
        .getAttribute("href"),
    ).toContain("/deliverables/npm.sdk/delivery");
    // Untouched: nothing to save, and no write.
    expect(within(form).queryByRole("button", { name: /^Save/ })).toBeNull();
    // Public, then back to Customers: the form is the stored choice again; still no write.
    await userEvent.click(within(form).getByRole("radio", { name: /Public/ }));
    // The warning is about Customers: gone while Public is picked.
    expect(form.textContent).not.toContain("tokens are refused these packages");
    await userEvent.click(
      within(form).getByRole("radio", { name: /Customers/ }),
    );
    expect(within(form).queryByRole("button", { name: /^Save/ })).toBeNull();
    expect(log.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("a refused access write (an old client sending entitled) is surfaced and keeps the input", async () => {
    bootSettings(
      "public",
      new Response(
        JSON.stringify({
          error: {
            code: "bad_request",
            message: "accessMode is public or licensed",
            fields: ["accessMode"],
            reason: "access_mode_unavailable",
          },
        }),
        { status: 422, headers: { "content-type": "application/json" } },
      ),
    );
    const form = await general();
    await userEvent.click(
      within(form).getByRole("radio", { name: /Customers/ }),
    );
    await userEvent.click(within(form).getByRole("button", { name: /^Save/ }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Switch to Customers" }),
    );
    expect(
      await within(form).findByText(
        "This page is out of date. Reload it, then choose again.",
      ),
    ).toBeTruthy();
    expect(
      within(form)
        .getByRole("radio", { name: /Customers/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("maps stored modes to the two choices and back", () => {
    expect(feedAccessChoice("authenticated")).toBe("customers");
    expect(feedAccessChoice("licensed")).toBe("customers");
    expect(feedAccessChoice("entitled")).toBe("customers");
    expect(feedAccessChoice("public")).toBe("public");
    expect(feedAccessMode("customers")).toBe("licensed");
    expect(feedAccessMode("public")).toBe("public");
  });

  it("the Tokens page lists tokens, mints one and shows it once with every client's setup", async () => {
    const minted = {
      ok: true,
      token: `pkeyr_${"k".repeat(43)}`,
      view: {
        ...(
          feedRoutes()[
            "/manage/api/products/djdl/distribution/feeds/tokens"
          ] as { tokens: Record<string, unknown>[] }
        ).tokens[0],
        tokenId: "rtok_new",
        label: "Build box",
        ecosystems: null,
      },
    };
    const log = boot("#/p/djdl/distribution/feeds/tokens", {
      extra: {
        ...feedRoutes(),
        ...product(true),
        "POST /manage/api/products/djdl/distribution/feeds/tokens": minted,
      },
    });
    await heading("Registry tokens");
    const table = await within(main()).findByRole("table", {
      name: "Registry tokens",
    });
    expect(table.textContent).toContain("CI pull");
    expect(table.textContent).toContain("Licensee, in Polaris Locker");
    await userEvent.click(
      within(main()).getByRole("button", { name: /New token/ }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "New registry token",
    });
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: /Label/ }),
      "Build box",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create token" }),
    );
    await waitFor(() =>
      expect(log.calls.find((c) => c.method === "POST")?.json).toEqual({
        label: "Build box",
        binding: "owner",
        expiresInDays: 90,
        ecosystems: null,
      }),
    );
    const shown = await screen.findByRole("dialog", {
      name: "Registry token created",
    });
    expect(shown.textContent).toContain(minted.token);
    // The npm feed is enabled: its .npmrc carries the real token.
    expect(shown.textContent).toContain(
      `//pkg.plrs.im/npm/djdl/:_authToken=${minted.token}`,
    );
  });

  it("F-22/F-23: a publish token is minted with publish and named feeds (OCI for docker push), owner-bound only", async () => {
    const page = feedRoutes()[
      "/manage/api/products/djdl/distribution/feeds/tokens"
    ] as { tokens: Record<string, unknown>[]; limits: Record<string, unknown> };
    const minted = {
      ok: true,
      token: `pkeyr_${"p".repeat(43)}`,
      view: {
        ...page.tokens[0],
        tokenId: "rtok_push",
        label: "Pusher",
        scopes: ["publish", "read"],
        ecosystems: ["npm", "oci"],
      },
    };
    const log = boot("#/p/djdl/distribution/feeds/tokens", {
      extra: {
        ...feedRoutes(),
        "/manage/api/products/djdl/distribution/feeds/tokens": {
          ...page,
          limits: {
            ...page.limits,
            publishDefaultDays: 7,
            publishMaxDays: 30,
            publishEcosystems: ["npm", "pypi", "swift", "maven", "oci"],
          },
        },
        ...product(true),
        "POST /manage/api/products/djdl/distribution/feeds/tokens": minted,
      },
    });
    await heading("Registry tokens");
    await within(main()).findByRole("table", { name: "Registry tokens" });
    await userEvent.click(
      within(main()).getByRole("button", { name: /New token/ }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "New registry token",
    });
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: /Label/ }),
      "Pusher",
    );
    await userEvent.click(
      within(dialog).getByRole("radio", { name: /Read and publish/ }),
    );
    expect(dialog.textContent).toContain("docker push");
    // A publish token names its feeds: none picked yet, so it cannot be created.
    expect(dialog.textContent).toContain(
      "Choose the feeds this token publishes to.",
    );
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Create token",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    // Never a Godot editor URL token, and never every feed.
    expect(
      within(dialog).queryByRole("switch", { name: /Godot editor URL/ }),
    ).toBeNull();
    expect(
      within(dialog).queryByRole("checkbox", { name: /Every feed/ }),
    ).toBeNull();
    await userEvent.click(
      within(dialog).getByRole("checkbox", { name: /npm/ }),
    );
    await userEvent.click(
      within(dialog).getByRole("checkbox", { name: /OCI/ }),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create token" }),
    );
    await waitFor(() =>
      expect(log.calls.find((c) => c.method === "POST")?.json).toEqual({
        label: "Pusher",
        binding: "owner",
        expiresInDays: 7,
        scopes: ["publish"],
        ecosystems: ["npm", "oci"],
      }),
    );
  });

  it("revoking a token is L2", async () => {
    const log = boot("#/platform/feeds/tokens", {
      extra: {
        ...feedRoutes(),
        "POST /manage/api/platform/feeds/tokens/rtok_ci/revoke": {
          ok: true,
          view: {},
        },
      },
    });
    const table = await within(await mainReady()).findByRole("table", {
      name: "Registry tokens",
    });
    await within(table).findByText("CI pull");
    await userEvent.click(
      within(table).getByRole("button", { name: "Actions for CI pull" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Revoke/ }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(confirmFor("registryToken.revoke").level).toBe(2);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Revoke token" }),
    );
    await waitFor(() =>
      expect(
        log.calls.some(
          (c) =>
            c.method === "POST" &&
            c.path.endsWith("/manage/api/platform/feeds/tokens/rtok_ci/revoke"),
        ),
      ).toBe(true),
    );
  });

  it("authenticated snippets name the token by env, or carry it; Godot needs a URL token", () => {
    // The console's credential argument goes straight to the shared renderer (F-12), so the
    // Setup tab and the shown-once dialog print what `pkey feeds setup --token-env` prints.
    const ctx = {
      origin: "https://pkg.plrs.im",
      owner: "acme",
      namespace: { scope: "@acme" },
    };
    const code = (
      snippets: ReturnType<typeof feedSetupSnippets>,
      id: string,
    ): string => snippets!.find((x) => x.id === id)!.code;
    const env = feedSetupSnippets("npm", ctx, {
      kind: "env",
      name: "PKEY_REGISTRY_TOKEN",
    });
    expect(code(env, "npmrc")).toBe(
      "@acme:registry=https://pkg.plrs.im/npm/acme/\n//pkg.plrs.im/npm/acme/:_authToken=${PKEY_REGISTRY_TOKEN}",
    );
    const token = "pkeyr_" + "x".repeat(43);
    const oci = feedSetupSnippets(
      "oci",
      { ...ctx, namespace: {} },
      { kind: "token", value: token },
    );
    expect(code(oci, "pull")).toContain(
      `echo ${token} | docker login pkg.plrs.im -u __token__ --password-stdin`,
    );
    const godotToken = "pkeyr_" + "g".repeat(43);
    const godot = feedSetupSnippets(
      "godot",
      { ...ctx, namespace: { publisher: "acme" } },
      { kind: "godot-url", value: godotToken },
    );
    expect(code(godot, "editor-4.6")).toBe(
      `https://pkg.plrs.im/godot/acme/t/${godotToken}/asset-library/api`,
    );
    // A Godot feed takes only a URL token: an env credential renders the anonymous setup.
    const godotEnv = feedSetupSnippets(
      "godot",
      { ...ctx, namespace: { publisher: "acme" } },
      { kind: "env", name: "PKEY_REGISTRY_TOKEN" },
    );
    expect(code(godotEnv, "editor-4.6")).toBe(
      "https://pkg.plrs.im/godot/acme/asset-library/api",
    );
    const maven = feedSetupSnippets(
      "maven",
      { ...ctx, namespace: { groupPrefixes: ["gg.acme"] } },
      { kind: "env", name: "PKEY_REGISTRY_TOKEN" },
    );
    expect(code(maven, "maven-credentials")).toContain(
      "<password>${env.PKEY_REGISTRY_TOKEN}</password>",
    );
    // A token a snippet cannot carry renders nothing rather than a broken line.
    expect(
      feedSetupSnippets("npm", ctx, { kind: "token", value: "bad token" }),
    ).toBeNull();
  });
});

describe("what a feed no longer sets (F-34)", () => {
  it("Maven has no yank policy: yanked versions are always hidden, so there is nothing to set", async () => {
    boot("#/p/djdl/distribution/feeds/maven/settings", {
      extra: { ...feedRoutes(), ...declaring("maven"), ...product(true) },
    });
    await general();
    const forms = within(main())
      .getAllByRole("form")
      .map((f) => f.getAttribute("aria-label"));
    expect(forms).toEqual(["General", "Namespace", "Limits"]);
    expect(main().textContent).not.toMatch(/yank policy|hide yanked/i);
    expect(main().querySelector("[data-capability]")).toBeNull();
  });
});

describe("the Feeds overview", () => {
  it("platform scope: every feed with status, counts, access and registry URL, the owners, no caveats", async () => {
    boot("#/platform/feeds", { extra: feedRoutes() });
    await heading("Package feeds");
    const table = await within(await mainReady()).findByRole("table", {
      name: "Package feeds",
    });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(
      rows.map((r) => within(r).getAllByRole("cell")[0]!.textContent),
    ).toEqual([
      "npm",
      "PyPI",
      "Docker / OCI",
      "Swift",
      "Maven / Gradle",
      "Godot",
      "Cargo",
      "Go",
    ]);
    expect(within(rows[0]!).getByText("Enabled")).toBeTruthy();
    expect(
      within(rows[0]!).getByText("https://pkg.plrs.im/npm/polaris-key/"),
    ).toBeTruthy();
    expect(
      within(rows[0]!).getByRole("link", { name: "npm" }).getAttribute("href"),
    ).toBe("#/platform/feeds/npm");
    expect(within(main()).getByText("8 of 8")).toBeTruthy();
    expect(
      within(main()).getByRole("heading", { name: "Owners" }),
    ).toBeTruthy();
    // One page per feed: the overview links every feed page.
    const feedNav = within(main()).getByRole("navigation", {
      name: "Package feeds",
    });
    expect(
      within(feedNav)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual([
      "Overview",
      "npm",
      "PyPI",
      "Docker / OCI",
      "Swift",
      "Maven / Gradle",
      "Godot",
      "Cargo",
      "Go",
      "Tokens",
    ]);
    // Nothing suggests a public registry, and nothing is "coming soon".
    expect(main().textContent).not.toMatch(
      /npmjs|Maven Central|pypi\.org|coming soon/i,
    );
    // The sidebar's Platform → Package feeds is the current page, with its icon.
    const link = within(nav()).getByRole("link", { name: "Package feeds" });
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(link.querySelector("svg[data-nav-icon]")).not.toBeNull();
  });

  it("platform scope before the bootstrap: offers to set the feeds up (L1)", async () => {
    const routes = feedRoutes();
    routes["/manage/api/platform/feeds"] = {
      ...(routes["/manage/api/platform/feeds"] as object),
      owner: null,
      ownerName: null,
    };
    const log = boot("#/platform/feeds", {
      extra: {
        ...routes,
        "POST /manage/api/platform/feeds/bootstrap": {
          ok: true,
          slug: "polaris-key",
          created: true,
        },
      },
    });
    await heading("Package feeds");
    await userEvent.click(
      await within(await mainReady()).findByRole("button", {
        name: "Set up platform feeds…",
      }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(confirmFor("feed.bootstrap").intent).toBe("caution");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Set up platform feeds" }),
    );
    await waitFor(() =>
      expect(
        log.calls.some(
          (c) =>
            c.method === "POST" &&
            c.path === "/manage/api/platform/feeds/bootstrap",
        ),
      ).toBe(true),
    );
  });

  it("product scope: one card per provisioned feed, in tab order, naming its packages and tracks", async () => {
    boot("#/p/djdl/distribution/feeds", {
      extra: { ...feedRoutes(), ...product(true) },
    });
    await heading("Packages");
    const page = within(await mainReady());
    const list = await page.findByRole("list", { name: "Package feeds" });
    // The fixture provisioned npm, PyPI and OCI; the tab order is the card order.
    const cards = within(list).getAllByRole("region", {
      name: /^(npm|PyPI|Docker \/ OCI)$/,
    });
    expect(
      cards.map((c) => within(c).getByRole("heading").textContent),
    ).toEqual(["npm", "PyPI", "Docker / OCI"]);
    const npm = cards[0]!;
    expect(within(npm).getByText("pkg.plrs.im/npm/djdl/")).toBeTruthy();
    expect(npm.querySelector("[data-access-chip]")!.textContent).toBe("Public");
    // Each package: its name, the version on each release track, versions and last publish.
    const rows = await within(npm).findAllByRole("listitem");
    expect(rows.map((r) => within(r).getByRole("link").textContent)).toEqual([
      "@djdl/sdk",
      "@djdl/cli",
    ]);
    expect(rows[0]!.textContent).toMatch(/stable\s*2\.3\.0/);
    expect(rows[0]!.textContent).toMatch(/5 versions/);
    expect(
      within(npm)
        .getByRole("link", { name: "Open the npm feed" })
        .getAttribute("href"),
    ).toBe("#/p/djdl/distribution/feeds/npm");
    // The count beside the title, and no subtitle repeating the host.
    expect(main().textContent).toContain("3 feeds");
    expect(main().textContent).not.toContain("On pkg.plrs.im");
    // No switch, no field, no button that creates a feed.
    expect(page.queryByRole("switch")).toBeNull();
    expect(
      page.queryByRole("button", { name: /new feed|turn on/i }),
    ).toBeNull();
    expect(page.queryByRole("heading", { name: "Owners" })).toBeNull();
    // Registry tokens stay one click away.
    expect(page.getByRole("button", { name: "Registry tokens" })).toBeTruthy();
    // The tabs: Overview, the declared feeds, Tokens; no undeclared ecosystem.
    const bar = screen.getByRole("navigation", { name: "Package feeds" });
    expect(
      within(bar)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Overview", "npm", "PyPI", "Docker / OCI", "Tokens"]);
    // Listed under Ship builds as Packages.
    expect(
      within(nav())
        .getByRole("link", { name: "Packages" })
        .getAttribute("href"),
    ).toBe("#/p/djdl/distribution/feeds");
  });

  it("the access chip says where access changes", async () => {
    boot("#/p/djdl/distribution/feeds", {
      extra: { ...feedRoutes(), ...product(true) },
    });
    await screen.findByRole("list", { name: "Package feeds" });
    const chip = main().querySelector("[data-access-chip]")!;
    expect(chip.getAttribute("aria-label")).toBe(
      "Access: Public. Change in Settings",
    );
    expect(chip.getAttribute("href")).toBe(
      "#/p/djdl/distribution/feeds/npm/settings",
    );
  });

  it("an off feed never says it is waiting: it says what is refused and links to Settings", async () => {
    boot("#/p/djdl/distribution/feeds", {
      extra: { ...feedRoutes(), ...product(true) },
    });
    const list = await within(await mainReady()).findByRole("list", {
      name: "Package feeds",
    });
    const pypi = within(list).getByRole("region", { name: "PyPI" });
    expect(
      within(pypi).queryByText(/Waiting for the first package/),
    ).toBeNull();
    expect(
      within(pypi).getByText("Installs and CI publishes are refused."),
    ).toBeTruthy();
    expect(
      within(pypi)
        .getByRole("link", { name: "Turn it on in Settings" })
        .getAttribute("href"),
    ).toBe("#/p/djdl/distribution/feeds/pypi/settings");
  });

  it("a declared feed with no package yet waits, and gives the publish step for its deliverable", async () => {
    boot("#/p/djdl/distribution/feeds", {
      extra: {
        ...feedRoutes(),
        ...declaring("swift"),
        ...product(true),
        "/manage/api/products/djdl/release/deliverables": {
          gateKnown: true,
          deliverables: [
            { id: "swift.sourcekit", kind: "package", type: "swift" },
          ],
        },
      },
    });
    const swift = await within(await mainReady()).findByRole("region", {
      name: "Swift",
    });
    expect(
      within(swift).getByText("Waiting for the first package…"),
    ).toBeTruthy();
    expect(
      await within(swift).findByText(
        "pkey release publish --deliverable swift.sourcekit --dir dist/swift",
      ),
    ).toBeTruthy();
  });

  it("without the deliverable read, a waiting feed points at Publish from CI", async () => {
    boot("#/p/djdl/distribution/feeds", {
      extra: { ...feedRoutes(), ...declaring("swift"), ...product(true) },
    });
    const swift = await within(await mainReady()).findByRole("region", {
      name: "Swift",
    });
    expect(
      within(swift)
        .getByRole("link", { name: "Publish from CI" })
        .getAttribute("href"),
    ).toBe("/docs/features/ship-builds/packages/publish/#publish-from-ci");
  });

  it("polls while a feed waits or nothing is declared, and stops otherwise", () => {
    const base = productOverview();
    const only = (...ecos: string[]) => ({
      ...base,
      feeds: base.feeds.map((f) => ({
        ...f,
        configured: ecos.includes(f.ecosystem),
      })),
    });
    expect(pollPackages(only())).toBe(PACKAGES_POLL_MS);
    expect(pollPackages(only("npm"))).toBe(false);
    expect(pollPackages(only("npm", "swift"))).toBe(false); // swift is off in the fixture, so it waits for nothing
    const waiting = only("npm");
    waiting.feeds = waiting.feeds.map((f) =>
      f.ecosystem === "npm" ? { ...f, packages: 0 } : f,
    );
    expect(pollPackages(waiting)).toBe(PACKAGES_POLL_MS);
    expect(pollPackages(undefined)).toBe(false);
  });

  it("a deep link to an undeclared ecosystem says so and offers no way to create the feed", async () => {
    boot("#/p/djdl/distribution/feeds/swift/settings", {
      extra: { ...feedRoutes(), ...product(true) },
    });
    const page = within(await mainReady());
    expect(
      await page.findByText("DJDL declares no Swift package"),
    ).toBeTruthy();
    expect(main().querySelector("[data-code-frame]")!.textContent).toContain(
      "ecosystem: swift",
    );
    expect(page.queryByRole("switch")).toBeNull();
    expect(page.queryByRole("form")).toBeNull();
    expect(page.queryByRole("tab")).toBeNull();
  });

  it("a 403 on the read is a refusal, with no Try again", async () => {
    boot("#/p/djdl/distribution/feeds", {
      extra: {
        ...feedRoutes(),
        ...product(true),
        "/manage/api/products/djdl/distribution/feeds": new Response(
          JSON.stringify({ error: { code: "forbidden", message: "no" } }),
          { status: 403 },
        ),
      },
    });
    const alert = await within(await mainReady()).findByRole("alert");
    expect(alert.textContent).toMatch(/don't have access/i);
    expect(
      within(alert).queryByRole("button", { name: /try again/i }),
    ).toBeNull();
  });

  it("loads as card-shaped placeholders, with no tab bar until feeds exist", async () => {
    boot("#/p/djdl/distribution/feeds", {
      extra: {
        ...feedRoutes(),
        ...product(true),
        "/manage/api/products/djdl/distribution/feeds": PENDING,
      },
    });
    await heading("Packages");
    expect(main().querySelector('[data-skeleton="cards"]')).not.toBeNull();
    expect(
      screen.queryByRole("navigation", { name: "Package feeds" }),
    ).toBeNull();
  });

  it("a Customers feed reads Customers on its card", async () => {
    const routes = feedRoutes();
    const overview = productOverview();
    overview.feeds = overview.feeds.map((f) =>
      f.ecosystem === "npm"
        ? { ...f, accessMode: "licensed", accessDisplay: "customers" }
        : f,
    );
    routes["/manage/api/products/djdl/distribution/feeds"] = overview;
    boot("#/p/djdl/distribution/feeds", {
      extra: { ...routes, ...product(true) },
    });
    await heading("Packages");
    const list = await within(await mainReady()).findByRole("list", {
      name: "Package feeds",
    });
    expect(list.querySelector("[data-access-chip]")!.textContent).toBe(
      "Customers",
    );
  });

  it("nothing declared: the empty card shows the declaration and the publish command, nothing to turn on", async () => {
    const routes = feedRoutes();
    const overview = productOverview();
    overview.feeds = overview.feeds.map((f) => ({
      ...f,
      configured: false,
      enabled: false,
      status: "off" as const,
      reason: "not-set-up" as const,
      packages: 0,
    }));
    routes["/manage/api/products/djdl/distribution/feeds"] = overview;
    boot("#/p/djdl/distribution/feeds", {
      extra: { ...routes, ...product(true) },
    });
    await heading("Packages");
    const page = within(await mainReady());
    expect(await page.findByText("DJDL declares no packages yet")).toBeTruthy();
    expect(page.getByText(".pkey/release", { selector: "code" })).toBeTruthy();
    expect(main().querySelector("[data-code-frame]")!.textContent).toMatch(
      /kind: package/,
    );
    expect(
      page.getByText(
        "pkey release publish --deliverable npm.sourcekit --dir dist/npm",
      ),
    ).toBeTruthy();
    expect(page.queryByRole("list", { name: "Package feeds" })).toBeNull();
    // No feed pages to switch between yet.
    expect(
      screen.queryByRole("navigation", { name: "Package feeds" }),
    ).toBeNull();
    // One guided panel: sentence and named docs link, the declaration and its command.
    expect(main().querySelector("[data-guided-panel]")).not.toBeNull();
    expect(
      page
        .getByRole("link", { name: "Declaring a package" })
        .getAttribute("href"),
    ).toBe("/docs/features/ship-builds/packages/publish/#declare-the-package");
    expect(main().querySelector("[data-code-frame]")!.textContent).toContain(
      "npm | pypi | swift | maven | oci | godot | cargo | go",
    );
    expect(page.getByRole("region", { name: "Publish command" })).toBeTruthy();
    // Existing tokens stay revocable from here.
    expect(page.getByRole("button", { name: "Registry tokens" })).toBeTruthy();
    expect(page.queryByRole("switch")).toBeNull();
    expect(
      page.queryByRole("button", { name: /turn on|new feed/i }),
    ).toBeNull();
    // The nav still lists Packages (nothing declared is not a reason to hide the page).
    expect(within(nav()).getByRole("link", { name: "Packages" })).toBeTruthy();
    expect((await axe(main())).violations.map((v) => v.id)).toEqual([]);
  });

  it("product scope with package feeds off: still in the sidebar, and the page offers Turn on", async () => {
    boot("#/p/djdl/distribution/feeds/npm", {
      extra: {
        ...feedRoutes(),
        ...product(false),
        "/manage/api/products/djdl/distribution/package-feeds": {
          packageFeeds: { enabled: false, version: 2, updatedAt: 1760000000 },
        },
        "PUT /manage/api/products/djdl/distribution/package-feeds": {
          ok: true,
          packageFeeds: { enabled: true, version: 3, updatedAt: 1760000100 },
        },
      },
    });
    await heading("Packages");
    const page = within(await mainReady());
    expect(await page.findByText(/Package feeds are off for/)).toBeTruthy();
    expect(await page.findByText(/Nothing was deleted/)).toBeTruthy();
    expect(page.getByText(/Turned off on/)).toBeTruthy();
    expect(page.queryByRole("link", { name: "Open Features" })).toBeNull();
    expect(
      page.getByRole("button", { name: "Turn on package feeds" }),
    ).toBeTruthy();
    expect(
      within(nav())
        .getByRole("link", { name: "Packages" })
        .getAttribute("href"),
    ).toBe("#/p/djdl/distribution/feeds");
  });

  it("loading and error states", async () => {
    boot("#/platform/feeds", {
      extra: { "/manage/api/platform/feeds": PENDING },
    });
    await heading("Package feeds");
    expect(main().querySelector("[data-skeleton]")).not.toBeNull();
    cleanup();
    resetConsole();
    boot("#/platform/feeds", {
      extra: {
        "/manage/api/platform/feeds": new Response(
          JSON.stringify({ error: { code: "internal", message: "boom" } }),
          { status: 500 },
        ),
      },
    });
    await heading("Package feeds");
    expect(
      await within(await mainReady()).findByRole("button", {
        name: /try again/i,
      }),
    ).toBeTruthy();
  });

  it("passes axe in both scopes", async () => {
    boot("#/platform/feeds", { extra: feedRoutes() });
    await within(await screen.findByRole("main")).findByRole("table", {
      name: "Package feeds",
    });
    expect((await axe(main())).violations.map((v) => v.id)).toEqual([]);
  });
});

describe("a feed page", () => {
  it("platform scope: Packages lists the platform's packages with an owner column and an owner filter", async () => {
    const log = boot("#/platform/feeds/npm", { extra: feedRoutes() });
    await heading(/npm/);
    const table = await within(await mainReady()).findByRole("table", {
      name: "npm packages",
    });
    expect(
      within(table).getByRole("columnheader", { name: /Owner/ }),
    ).toBeTruthy();
    expect(within(table).getByText("@polaris-key/node")).toBeTruthy();
    expect(within(table).getAllByText("latest → 0.9.2").length).toBe(2);
    expect(
      within(table)
        .getByRole("link", { name: "@polaris-key/node" })
        .getAttribute("href"),
    ).toBe("#/platform/feeds/npm/packages/polaris-key/%40polaris-key%2Fnode");
    expect(
      log.calls.some(
        (c) =>
          c.path.endsWith("/npm/packages") && c.query === "owner=polaris-key",
      ),
    ).toBe(true);
    await userEvent.click(
      within(main()).getByRole("radio", { name: "All owners" }),
    );
    await waitFor(() =>
      expect(
        log.calls.some(
          (c) => c.path.endsWith("/npm/packages") && c.query === "",
        ),
      ).toBe(true),
    );
    // The tabs are routes.
    const tabs = within(main()).getByRole("navigation", { name: "npm feed" });
    expect(
      within(tabs).getByRole("link", { name: "Settings" }).getAttribute("href"),
    ).toBe("#/platform/feeds/npm/settings");
  });

  it("product scope: no owner column; an empty feed says how a package arrives", async () => {
    boot("#/p/djdl/distribution/feeds/npm", {
      extra: { ...feedRoutes(), ...product(true) },
    });
    const table = await within(await mainReady()).findByRole("table", {
      name: "npm packages",
    });
    expect(
      within(table).queryByRole("columnheader", { name: /Owner/ }),
    ).toBeNull();
    cleanup();
    resetConsole();
    boot("#/p/djdl/distribution/feeds/swift", {
      extra: { ...feedRoutes(), ...declaring("swift"), ...product(true) },
    });
    expect(
      await within(await mainReady()).findByText("No Swift packages yet"),
    ).toBeTruthy();
  });

  it("Setup: renderFeedSetup's snippets, byte-identical to pkey feeds setup (the shared goldens)", async () => {
    // Every platform feed is a shared case (packages/shared-manifest/test/fixtures/feed-setup):
    // the CLI's test prints the same golden for the same input.
    for (const c of SHARED_CASES.filter(
      (c) => c.id.endsWith("-feed") && c.owner === "polaris-key",
    )) {
      cleanup();
      resetConsole();
      boot(`#/platform/feeds/${c.ecosystem}/setup`, { extra: feedRoutes() });
      await heading(ECOSYSTEM_LABELS[c.ecosystem]);
      const want = renderFeedSetup(c.ecosystem, {
        origin: SHARED_ORIGIN,
        owner: c.owner,
        namespace: c.namespace,
      });
      expect(formatFeedSetup(want), c.id).toBe(
        readFileSync(join(SHARED_FIXTURES, `${c.id}.txt`), "utf8"),
      );
      await waitFor(() =>
        expect(main().querySelectorAll("pre").length, c.id).toBe(want.length),
      );
      const shown = [...main().querySelectorAll("pre")].map((pre) =>
        [...pre.querySelectorAll("code > span")]
          .map((line) =>
            line.textContent === "\n" ? "" : (line.textContent ?? ""),
          )
          .join("\n"),
      );
      expect(shown, c.id).toEqual(want.map((s) => s.code));
      if (c.ecosystem === "pypi")
        // pip's warning against --extra-index-url is on the page, not only in the CLI.
        expect(main().textContent).toContain(
          "Never add this feed with --extra-index-url",
        );
      for (const s of want)
        expect(
          within(main()).getByRole("heading", { level: 2, name: s.title }),
        ).toBeTruthy();
    }
  });

  it("Settings: each section saves with the version it read; both access options can be chosen", async () => {
    const log = boot("#/p/djdl/distribution/feeds/npm/settings", {
      extra: {
        ...feedRoutes(),
        ...product(true),
        "PUT /manage/api/products/djdl/distribution/feeds/npm/settings": {
          ok: true,
          settings: feedDetail("product", "npm").settings,
        },
      },
    });
    await heading(/npm/);
    const access = await general();
    const radios = within(access).getAllByRole("radio");
    // Public and Customers, both choosable.
    expect(
      radios.map(
        (r) =>
          r.hasAttribute("disabled") ||
          r.getAttribute("data-disabled") !== null,
      ),
    ).toEqual([false, false]);
    expect(access.textContent).not.toContain("Unavailable");
    expect(access.textContent).not.toMatch(/coming soon|ships/i);
    // The platform policy is the platform's: not in product scope.
    expect(
      within(main()).queryByRole("form", { name: "Platform policy" }),
    ).toBeNull();
    const ns = within(main()).getByRole("form", { name: "Namespace" });
    const scope = within(ns).getByRole("textbox", { name: "Scope" });
    await userEvent.clear(scope);
    await userEvent.type(scope, "@djdl-sdk");
    await userEvent.click(within(ns).getByRole("button", { name: /^Save/ }));
    await waitFor(() => {
      const put = log.calls.find((c) => c.method === "PUT");
      expect(put?.json).toEqual({
        expectedVersion: 3,
        namespace: { scope: "@djdl-sdk" },
      });
    });
  });

  it("Settings: switching a feed off asks first (L1)", async () => {
    const log = boot("#/p/djdl/distribution/feeds/npm/settings", {
      extra: {
        ...feedRoutes(),
        ...product(true),
        "PUT /manage/api/products/djdl/distribution/feeds/npm/settings": {
          ok: true,
          settings: feedDetail("product", "npm").settings,
        },
      },
    });
    const general = await within(await mainReady()).findByRole("form", {
      name: "General",
    });
    await userEvent.click(
      within(general).getByRole("switch", { name: "Serving" }),
    );
    await userEvent.click(
      within(general).getByRole("button", { name: /^Save/ }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("not-found");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Switch off feed" }),
    );
    await waitFor(() =>
      expect(log.calls.find((c) => c.method === "PUT")?.json).toEqual({
        expectedVersion: 3,
        enabled: false,
      }),
    );
  });

  it("Settings in platform scope: the platform policy moved to Platform settings (ST-09)", async () => {
    boot("#/platform/feeds/oci/settings", { extra: feedRoutes() });
    const main_ = await mainReady();
    await within(main_).findByRole("form", { name: "General" });
    expect(
      within(main_).queryByRole("form", { name: "Platform policy" }),
    ).toBeNull();
    const link = within(main_).getByRole("link", { name: "Platform settings" });
    expect(link.getAttribute("href")).toBe(
      "#/platform/settings?setting=feeds.policy.oci.enabled",
    );
    expect(confirmFor("feed.policyOff").intent).toBe("danger");
  });

  it("the ecosystem panel saves its own ext_json with the version it read (F-12)", async () => {
    const put = "PUT /manage/api/platform/feeds/swift/settings";
    const log = boot("#/platform/feeds/swift/settings", {
      extra: {
        ...feedRoutes(),
        [put]: { ok: true, settings: feedDetail("platform", "swift").settings },
      },
    });
    const panel = await within(await mainReady()).findByRole("form", {
      name: "Signing and identifiers",
    });
    // Rendered from the adapter's declared extensions, never a switch on the ecosystem.
    const signed = within(panel).getByRole("switch", {
      name: "Require signed releases",
    });
    expect(signed.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(signed);
    await userEvent.type(
      within(panel).getByRole("textbox", { name: "Repository URLs" }),
      "polaris-key.PolarisKey https://github.com/vladzaharia/polaris-key",
    );
    await userEvent.click(within(panel).getByRole("button", { name: /^Save/ }));
    await waitFor(() =>
      expect(log.calls.find((c) => c.method === "PUT")?.json).toEqual({
        expectedVersion: 3,
        ext: {
          requireSigned: false,
          repositoryUrls: {
            "polaris-key.PolarisKey": [
              "https://github.com/vladzaharia/polaris-key",
            ],
          },
        },
      }),
    );
  });

  it("each ecosystem's panel, and none where the adapter declares no extensions", async () => {
    const cases: [string, string | null][] = [
      ["npm", null],
      ["maven", null],
      ["pypi", "Simple API"],
      ["oci", null],
      ["godot", null],
    ];
    for (const [eco, title] of cases) {
      cleanup();
      resetConsole();
      boot(`#/platform/feeds/${eco}/settings`, { extra: feedRoutes() });
      await within(await mainReady()).findByRole("form", { name: "General" });
      const forms = within(main())
        .getAllByRole("form")
        .map((f) => f.getAttribute("aria-label"));
      expect(forms, eco).toEqual(
        ["General", "Namespace", "Limits", title].filter(Boolean),
      );
      // P0-47: Upstream had one option (none) and is gone; the feed still never proxies.
      expect(within(main()).queryByText("Upstream registry"), eco).toBeNull();
      expect(
        within(main()).queryByRole("region", { name: "Upstream" }),
        eco,
      ).toBeNull();
    }
  });

  it("OCI has no untagged-manifest setting, and a stored retainUntaggedDays is neither shown nor sent", async () => {
    const routes = feedRoutes();
    const stored = feedDetail("platform", "oci");
    routes["/manage/api/platform/feeds/oci"] = {
      ...stored,
      settings: { ...stored.settings, ext: { retainUntaggedDays: 30 } },
    };
    const put = "PUT /manage/api/platform/feeds/oci/settings";
    const log = boot("#/platform/feeds/oci/settings", {
      extra: { ...routes, [put]: { ok: true, settings: stored.settings } },
    });
    const form = await general();
    expect(main().textContent).not.toMatch(/untagged|retention/i);
    expect(
      within(main()).queryByRole("form", { name: "Retention" }),
    ).toBeNull();
    // Saving General sends only what changed.
    await userEvent.click(
      within(form).getByRole("switch", { name: "Serving" }),
    );
    await userEvent.click(within(form).getByRole("button", { name: /^Save/ }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Switch off feed" }),
    );
    await waitFor(() =>
      expect(log.calls.find((c) => c.method === "PUT")?.json).toEqual({
        expectedVersion: 3,
        enabled: false,
      }),
    );
  });

  it("Godot's asset listing is not shown: stored values stay the fallback and are never sent", async () => {
    const routes = feedRoutes();
    const stored = feedDetail("platform", "godot");
    routes["/manage/api/platform/feeds/godot"] = {
      ...stored,
      settings: {
        ...stored.settings,
        ext: { categoryId: 3, supportLevel: "official" },
      },
    };
    const put = "PUT /manage/api/platform/feeds/godot/settings";
    const log = boot("#/platform/feeds/godot/settings", {
      extra: { ...routes, [put]: { ok: true, settings: stored.settings } },
    });
    const form = await general();
    expect(main().textContent).not.toMatch(
      /asset listing|support level|oldest editor|category/i,
    );
    await userEvent.click(
      within(form).getByRole("switch", { name: "Serving" }),
    );
    await userEvent.click(within(form).getByRole("button", { name: /^Save/ }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Switch off feed" }),
    );
    await waitFor(() =>
      expect(log.calls.find((c) => c.method === "PUT")?.json).toEqual({
        expectedVersion: 3,
        enabled: false,
      }),
    );
  });

  /** The npm settings page with the namespace the manifest provisioned. */
  function bootDerived(
    extra: Record<string, unknown> = {},
    settings: Record<string, unknown> = {},
  ): ReturnType<typeof boot> {
    const routes = feedRoutes();
    const stored = feedDetail("product", "npm");
    routes[NPM_PATH] = {
      ...stored,
      settings: {
        ...stored.settings,
        version: 1,
        updatedBy: "u1",
        namespaceSource: "manifest",
        ...settings,
      },
    };
    return boot("#/p/djdl/distribution/feeds/npm/settings", {
      extra: { ...routes, ...product(true), ...extra },
    });
  }

  it("Namespace: a manifest namespace reads From manifest, and Override opens the first field", async () => {
    bootDerived();
    const ns = await within(await mainReady()).findByRole("form", {
      name: "Namespace",
    });
    expect(
      within(ns).getByRole("button", { name: /From manifest/ }),
    ).toBeTruthy();
    expect(ns.textContent).toContain("refused at publish");
    expect(within(ns).queryByRole("textbox", { name: "Scope" })).toBeNull();
    expect(within(ns).queryByRole("button", { name: /^Save/ })).toBeNull();
    await userEvent.click(within(ns).getByRole("button", { name: "Override" }));
    const scope = within(ns).getByRole("textbox", { name: "Scope" });
    expect(scope).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(scope));
    // Still From manifest until something is saved.
    expect(
      within(ns).getByRole("button", { name: /From manifest/ }),
    ).toBeTruthy();
  });

  it("Namespace: Cancel, and Discard after an edit, return to the manifest read-out", async () => {
    bootDerived();
    const ns = await within(await mainReady()).findByRole("form", {
      name: "Namespace",
    });
    await userEvent.click(within(ns).getByRole("button", { name: "Override" }));
    await userEvent.click(within(ns).getByRole("button", { name: "Cancel" }));
    expect(within(ns).queryByRole("textbox", { name: "Scope" })).toBeNull();
    expect(within(ns).getByRole("button", { name: "Override" })).toBeTruthy();
    await userEvent.click(within(ns).getByRole("button", { name: "Override" }));
    await userEvent.type(
      within(ns).getByRole("textbox", { name: "Scope" }),
      "x",
    );
    await userEvent.click(within(ns).getByRole("button", { name: "Discard" }));
    await waitFor(() =>
      expect(within(ns).queryByRole("textbox", { name: "Scope" })).toBeNull(),
    );
    expect(within(ns).getByRole("button", { name: "Override" })).toBeTruthy();
  });

  it("Namespace: saving Limits does not make a manifest namespace read as the operator's", async () => {
    const log = bootDerived({
      [`PUT ${NPM_PATH}/settings`]: {
        ok: true,
        settings: feedDetail("product", "npm").settings,
      },
    });
    const limits = await within(await mainReady()).findByRole("form", {
      name: "Limits",
    });
    const size = within(limits).getByRole("textbox", { name: "Size" });
    await userEvent.clear(size);
    await userEvent.type(size, "10");
    await userEvent.click(
      within(limits).getByRole("button", { name: /^Save/ }),
    );
    await waitFor(() =>
      expect(log.calls.find((c) => c.method === "PUT")?.json).toEqual({
        expectedVersion: 1,
        maxPackageBytes: 10 * 1024 * 1024,
      }),
    );
    const ns = within(main()).getByRole("form", { name: "Namespace" });
    expect(
      within(ns).getByRole("button", { name: /From manifest/ }),
    ).toBeTruthy();
    // The save lands the focus on the section, not the page.
    await waitFor(() => expect(document.activeElement?.id).toBe("feed-limits"));
  });

  it("Namespace: one saved in the console reads Set in console", async () => {
    bootDerived({}, { namespaceSource: "console" });
    const ns = await within(await mainReady()).findByRole("form", {
      name: "Namespace",
    });
    expect(
      within(ns).getByRole("button", { name: /Set in console/ }),
    ).toBeTruthy();
    expect(within(ns).getByRole("textbox", { name: "Scope" })).toBeTruthy();
  });

  it("Cancel on a General confirm shows no error and writes nothing (widen, tighten, switch off)", async () => {
    for (const [stored, pick, cancel] of [
      ["licensed", /Public/, "Cancel"],
      ["public", /Customers/, "Cancel"],
      ["licensed", null, "Cancel"],
    ] as const) {
      cleanup();
      resetConsole();
      const log = bootSettings(stored);
      const form = await general();
      if (pick)
        await userEvent.click(within(form).getByRole("radio", { name: pick }));
      else
        await userEvent.click(
          within(form).getByRole("switch", { name: "Serving" }),
        );
      await userEvent.click(
        within(form).getByRole("button", { name: /^Save/ }),
      );
      const dialog = await screen.findByRole("alertdialog");
      await userEvent.click(
        within(dialog).getByRole("button", { name: cancel }),
      );
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(within(form).queryByRole("alert"), String(pick)).toBeNull();
      expect(form.textContent).not.toMatch(/went wrong|cancelled/i);
      expect(log.calls.some((c) => c.method === "PUT")).toBe(false);
    }
  });

  it("Escape on a General confirm shows no error either", async () => {
    bootSettings("licensed");
    const form = await general();
    await userEvent.click(within(form).getByRole("radio", { name: /Public/ }));
    await userEvent.click(within(form).getByRole("button", { name: /^Save/ }));
    await screen.findByRole("alertdialog");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(within(form).queryByRole("alert")).toBeNull();
    expect(form.textContent).not.toMatch(/went wrong|cancelled/i);
  });

  it("switching off and widening in one save asks once and saves both", async () => {
    const log = bootSettings("licensed");
    const form = await general();
    await userEvent.click(
      within(form).getByRole("switch", { name: "Serving" }),
    );
    await userEvent.click(within(form).getByRole("radio", { name: /Public/ }));
    await userEvent.click(within(form).getByRole("button", { name: /^Save/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain(
      "Switch off the npm feed and make it public",
    );
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Switch off and make public",
      }),
    );
    await waitFor(() =>
      expect(log.calls.find((c) => c.method === "PUT")?.json).toEqual({
        expectedVersion: 3,
        enabled: false,
        accessMode: "public",
      }),
    );
    expect(log.calls.filter((c) => c.method === "PUT").length).toBe(1);
  });

  it("switching off and moving to Customers in one save asks once and saves both", async () => {
    const log = bootSettings("public");
    const form = await general();
    await userEvent.click(
      within(form).getByRole("switch", { name: "Serving" }),
    );
    await userEvent.click(
      within(form).getByRole("radio", { name: /Customers/ }),
    );
    await userEvent.click(within(form).getByRole("button", { name: /^Save/ }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Switch off and use Customers",
      }),
    );
    await waitFor(() =>
      expect(log.calls.find((c) => c.method === "PUT")?.json).toEqual({
        expectedVersion: 3,
        enabled: false,
        accessMode: "licensed",
      }),
    );
  });

  it("toasts name what changed", async () => {
    bootSettings("licensed");
    const form = await general();
    await userEvent.click(within(form).getByRole("radio", { name: /Public/ }));
    await userEvent.click(within(form).getByRole("button", { name: /^Save/ }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Make feed public",
      }),
    );
    expect(await screen.findByText("npm feed is public")).toBeTruthy();
  });

  it("a version conflict refetches, offers Keep mine / Discard mine, and the next save carries the fresh version", async () => {
    let served = 3;
    const routes = feedRoutes();
    const stored = feedDetail("product", "npm");
    const puts: unknown[] = [];
    routes[NPM_PATH] = () => ({
      ...stored,
      settings: {
        ...stored.settings,
        version: served,
        maxPackageBytes: served === 3 ? 52_428_800 : 20 * 1024 * 1024,
      },
    });
    routes[`PUT ${NPM_PATH}/settings`] = (
      _q: URLSearchParams,
      req: { json?: unknown },
    ) => {
      puts.push(req.json);
      if ((req.json as { expectedVersion: number }).expectedVersion === 3) {
        served = 4;
        return new Response(
          JSON.stringify({
            error: {
              code: "bad_request",
              message: "the feed's settings changed since you read them",
              reason: "version_conflict",
            },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        );
      }
      return { ok: true, settings: stored.settings };
    };
    boot("#/p/djdl/distribution/feeds/npm/settings", {
      extra: { ...routes, ...product(true) },
    });
    const limits = await within(await mainReady()).findByRole("form", {
      name: "Limits",
    });
    const size = within(limits).getByRole("textbox", { name: "Size" });
    await userEvent.clear(size);
    await userEvent.type(size, "10");
    await userEvent.click(
      within(limits).getByRole("button", { name: /^Save/ }),
    );
    expect(
      await within(limits).findByText(
        "Someone saved this feed after you opened it",
      ),
    ).toBeTruthy();
    expect(limits.textContent).not.toMatch(/went wrong|changed on the server/i);
    await userEvent.click(
      within(limits).getByRole("button", { name: "Keep mine" }),
    );
    await userEvent.click(
      within(limits).getByRole("button", { name: /^Save/ }),
    );
    await waitFor(() =>
      expect(puts).toEqual([
        { expectedVersion: 3, maxPackageBytes: 10 * 1024 * 1024 },
        { expectedVersion: 4, maxPackageBytes: 10 * 1024 * 1024 },
      ]),
    );
  });

  it("saving one section does not tell another section's draft that someone else saved", async () => {
    let served = 3;
    let served_enabled = true;
    const routes = feedRoutes();
    const stored = feedDetail("product", "npm");
    const puts: unknown[] = [];
    routes[NPM_PATH] = () => ({
      ...stored,
      settings: {
        ...stored.settings,
        version: served,
        enabled: served_enabled,
      },
    });
    routes[`PUT ${NPM_PATH}/settings`] = (
      _q: URLSearchParams,
      req: { json?: unknown },
    ) => {
      puts.push(req.json);
      const body = req.json as { enabled?: boolean };
      served += 1;
      if (body.enabled !== undefined) served_enabled = body.enabled;
      return { ok: true, settings: { ...stored.settings, version: served } };
    };
    boot("#/p/djdl/distribution/feeds/npm/settings", {
      extra: { ...routes, ...product(true) },
    });
    const general = await within(await mainReady()).findByRole("form", {
      name: "General",
    });
    const limits = within(main()).getByRole("form", { name: "Limits" });
    const size = within(limits).getByRole("textbox", { name: /^Size/ });
    await userEvent.clear(size);
    await userEvent.type(size, "10");
    await userEvent.click(
      within(general).getByRole("switch", { name: "Serving" }),
    );
    await userEvent.click(
      within(general).getByRole("button", { name: /^Save/ }),
    );
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Switch off feed",
      }),
    );
    await waitFor(() => expect(puts.length).toBe(1));
    // The refetch carries our own version: Limits keeps its draft and says nothing.
    await screen.findByText("npm feed switched off");
    await new Promise((r) => setTimeout(r, 200));
    expect(main().textContent).not.toContain("Someone saved this feed");
    expect(
      (
        within(within(main()).getByRole("form", { name: "Limits" })).getByRole(
          "textbox",
          { name: /^Size/ },
        ) as HTMLInputElement
      ).value,
    ).toBe("10");
    await userEvent.click(
      within(limits).getByRole("button", { name: /^Save/ }),
    );
    await waitFor(() =>
      expect(puts[1]).toEqual({
        expectedVersion: 4,
        maxPackageBytes: 10 * 1024 * 1024,
      }),
    );
  });

  it("Discard mine after a conflict takes theirs and clears the notice", async () => {
    let served = 3;
    const routes = feedRoutes();
    const stored = feedDetail("product", "npm");
    routes[NPM_PATH] = () => ({
      ...stored,
      settings: {
        ...stored.settings,
        version: served,
        maxPackageBytes: served === 3 ? 52_428_800 : 20 * 1024 * 1024,
      },
    });
    routes[`PUT ${NPM_PATH}/settings`] = () => {
      served = 4;
      return new Response(
        JSON.stringify({
          error: {
            code: "bad_request",
            message: "x",
            reason: "version_conflict",
          },
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    };
    boot("#/p/djdl/distribution/feeds/npm/settings", {
      extra: { ...routes, ...product(true) },
    });
    const limits = await within(await mainReady()).findByRole("form", {
      name: "Limits",
    });
    const size = within(limits).getByRole("textbox", { name: "Size" });
    await userEvent.clear(size);
    await userEvent.type(size, "10");
    await userEvent.click(
      within(limits).getByRole("button", { name: /^Save/ }),
    );
    await within(limits).findByText(
      "Someone saved this feed after you opened it",
    );
    await userEvent.click(
      within(limits).getByRole("button", { name: "Discard mine" }),
    );
    await waitFor(() =>
      expect(
        within(limits).queryByText(
          "Someone saved this feed after you opened it",
        ),
      ).toBeNull(),
    );
    await waitFor(() => expect((size as HTMLInputElement).value).toBe("20"));
  });

  it("Override: typing back to the stored value keeps the editor open with focus in it", async () => {
    bootDerived();
    const ns = await within(await mainReady()).findByRole("form", {
      name: "Namespace",
    });
    await userEvent.click(within(ns).getByRole("button", { name: "Override" }));
    const scope = within(ns).getByRole("textbox", { name: "Scope" });
    await userEvent.type(scope, "x");
    await userEvent.keyboard("{Backspace}");
    const again = within(ns).getByRole("textbox", { name: "Scope" });
    expect(again).toBe(scope);
    expect(document.activeElement).toBe(scope);
  });

  it("Cancel and Discard in override mode hand focus back to Override", async () => {
    bootDerived();
    const ns = await within(await mainReady()).findByRole("form", {
      name: "Namespace",
    });
    await userEvent.click(within(ns).getByRole("button", { name: "Override" }));
    await userEvent.click(within(ns).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(ns).getByRole("button", { name: "Override" }),
      ),
    );
    await userEvent.click(within(ns).getByRole("button", { name: "Override" }));
    await userEvent.type(
      within(ns).getByRole("textbox", { name: "Scope" }),
      "x",
    );
    await userEvent.click(within(ns).getByRole("button", { name: "Discard" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(ns).getByRole("button", { name: "Override" }),
      ),
    );
  });

  it("the combined off-and-widen confirm looks ahead and does not contradict itself", async () => {
    bootSettings("licensed");
    const form = await general();
    await userEvent.click(
      within(form).getByRole("switch", { name: "Serving" }),
    );
    await userEvent.click(within(form).getByRole("radio", { name: /Public/ }));
    await userEvent.click(within(form).getByRole("button", { name: /^Save/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.querySelectorAll("li").length).toBe(3);
    expect(dialog.textContent).toContain(
      "When it is switched on again, anyone can install",
    );
    expect(dialog.textContent).not.toContain("Within 30 seconds anyone");
  });

  it("a namespace nobody set shows no Source row", async () => {
    boot("#/p/djdl/distribution/feeds/godot/settings", {
      extra: { ...feedRoutes(), ...declaring("godot"), ...product(true) },
    });
    const ns = await within(await mainReady()).findByRole("form", {
      name: "Namespace",
    });
    expect(ns.textContent).not.toContain("Source");
  });

  it("the entitled warning uses one noun and stays one block", async () => {
    bootSettings("entitled");
    const form = await general();
    expect(form.textContent).toContain(
      "Customers' tokens are refused these packages",
    );
    expect(form.textContent).not.toContain("License tokens");
  });

  it("a view-only member's access cards read as locked, with the reason", async () => {
    boot("#/p/djdl/distribution/feeds/npm/settings", {
      me: {
        platformAdmin: false,
        permissions: {
          roles: [],
          platform: { view: ["console"], edit: [] },
          products: {
            djdl: { view: ["core", "ship"], edit: [] },
            acme: { view: ["core"], edit: [] },
          },
        },
      },
      extra: { ...feedRoutes(), ...product(true) },
    });
    const form = await general();
    const group = within(form).getByRole("radiogroup");
    expect(group.getAttribute("aria-disabled")).toBe("true");
    expect(form.textContent).toMatch(/edit access|can view this/i);
  });

  it("a view-only member sees the settings read-only", async () => {
    const routes = feedRoutes();
    boot("#/p/djdl/distribution/feeds/npm/settings", {
      me: {
        platformAdmin: false,
        permissions: {
          roles: [],
          platform: { view: ["console"], edit: [] },
          products: {
            djdl: { view: ["core", "ship"], edit: [] },
            acme: { view: ["core"], edit: [] },
          },
        },
      },
      extra: { ...routes, ...product(true) },
    });
    const form = await general();
    expect(
      within(form)
        .getByRole("radio", { name: /Public/ })
        .closest("[aria-readonly]"),
    ).not.toBeNull();
  });

  it("a 500 on save offers Copy details", async () => {
    bootSettings("public", new Response("{}", { status: 500 }));
    const form = await general();
    await userEvent.click(
      within(form).getByRole("radio", { name: /Customers/ }),
    );
    await userEvent.click(within(form).getByRole("button", { name: /^Save/ }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Switch to Customers",
      }),
    );
    expect(
      await within(form).findByRole("button", { name: /Copy details/ }),
    ).toBeTruthy();
  });

  it("a never-saved feed reads Customers, as the server defaults it", async () => {
    boot("#/p/djdl/distribution/feeds/swift/settings", {
      extra: { ...feedRoutes(), ...declaring("swift"), ...product(true) },
    });
    const form = await general();
    expect(
      within(form)
        .getByRole("radio", { name: /Customers/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("Namespace: a namespace an operator saved is editable with no derived badge", async () => {
    boot("#/p/djdl/distribution/feeds/npm/settings", {
      extra: { ...feedRoutes(), ...product(true) },
    });
    const ns = await within(await mainReady()).findByRole("form", {
      name: "Namespace",
    });
    expect(ns.textContent).not.toContain("Derived");
    expect(within(ns).getByRole("textbox", { name: "Scope" })).toBeTruthy();
  });

  it("Settings: a failed load shows the error with Try again", async () => {
    boot("#/p/djdl/distribution/feeds/npm/settings", {
      extra: {
        ...feedRoutes(),
        ...product(true),
        [NPM_PATH]: new Response("{}", { status: 500 }),
      },
    });
    expect(
      await within(await mainReady()).findByRole("button", {
        name: /Try again/,
      }),
    ).toBeTruthy();
  });

  it("Activity: the feed's trail", async () => {
    boot("#/platform/feeds/npm/activity", { extra: feedRoutes() });
    expect(
      await within(await mainReady()).findByText(
        "changed the settings of feed",
        { exact: false },
      ),
    ).toBeTruthy();
  });

  it("an unknown feed is a not-found page naming it", async () => {
    boot("#/platform/feeds/cpan", { extra: feedRoutes() });
    await heading("Feed not found");
    expect(within(main()).getByText("There is no cpan feed")).toBeTruthy();
  });

  it("passes axe on Settings, ecosystem panels included", async () => {
    for (const eco of ["maven", "swift", "godot", "cargo"]) {
      cleanup();
      resetConsole();
      boot(`#/platform/feeds/${eco}/settings`, { extra: feedRoutes() });
      await within(await mainReady()).findByRole("form", {
        name: "General",
      });
      expect(
        (await axe(main())).violations.map((v) => v.id),
        eco,
      ).toEqual([]);
    }
  });

  it("the sub-navigation bar: Overview and Tokens apart, every feed a link, the current one marked", async () => {
    boot("#/platform/feeds/pypi/setup", { extra: feedRoutes() });
    await heading("PyPI");
    const bar = screen.getByRole("navigation", { name: "Package feeds" });
    const links = within(bar).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual([
      "Overview",
      "npm",
      "PyPI",
      "Docker / OCI",
      "Swift",
      "Maven / Gradle",
      "Godot",
      "Cargo",
      "Go",
      "Tokens",
    ]);
    expect(
      links.filter((l) => l.getAttribute("aria-current") === "page"),
    ).toEqual([within(bar).getByRole("link", { name: "PyPI" })]);
    // Every item carries its icon; the separators (after Overview, before Tokens) are
    // decoration, not links.
    for (const l of links) expect(l.querySelector("svg")).not.toBeNull();
    expect(bar.querySelectorAll('li[aria-hidden="true"]').length).toBe(2);
    expect((await axe(bar)).violations.map((v) => v.id)).toEqual([]);
  });
});

describe("the package record", () => {
  it("versions with tags, publish source, size, digests and state; npm offers deprecate, never yank", async () => {
    const log = boot("#/p/djdl/distribution/feeds/npm/packages/%40djdl%2Fsdk", {
      extra: {
        ...feedRoutes(),
        ...product(true),
        "POST /manage/api/products/djdl/distribution/feeds/npm/packages/%40djdl%2Fsdk/versions/2.3.0/deprecate":
          { ok: true, state: "deprecated" },
      },
    });
    await heading("@djdl/sdk");
    const table = await within(await mainReady()).findByRole("table", {
      name: "Versions of @djdl/sdk",
    });
    expect(within(table).getByText("Deprecated")).toBeTruthy();
    expect(
      within(table).getAllByText(/Trusted publisher/).length,
    ).toBeGreaterThan(0);
    expect(within(table).getByText(/CI token/)).toBeTruthy();
    expect(
      within(table).getAllByRole("button", { name: /Copy the sha512/ }).length,
    ).toBe(3);
    await userEvent.click(
      within(table).getByRole("button", { name: "Actions for 2.3.0" }),
    );
    const items = (await screen.findAllByRole("menuitem")).map(
      (m) => m.textContent,
    );
    expect(items).toEqual(["Deprecate…"]);
    await userEvent.click(screen.getByRole("menuitem", { name: "Deprecate…" }));
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", {
      name: "Deprecate 2.3.0",
    });
    expect(
      confirm.hasAttribute("disabled") ||
        confirm.getAttribute("aria-disabled") === "true",
    ).toBe(true);
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: "Message" }),
      "Use 3.x",
    );
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(log.calls.find((c) => c.method === "POST")?.json).toEqual({
        message: "Use 3.x",
      }),
    );
  });

  it("a yank is L2 and needs a reason; a yanked version offers unyank", async () => {
    const log = boot("#/platform/feeds/oci/packages/polaris-key/pkey", {
      extra: {
        ...feedRoutes(),
        "POST /manage/api/platform/feeds/oci/packages/polaris-key/pkey/versions/0.9.2/yank":
          { ok: true, state: "yanked" },
      },
    });
    await heading("pkey");
    const table = await within(await mainReady()).findByRole("table", {
      name: "Versions of pkey",
    });
    await userEvent.click(
      within(table).getByRole("button", { name: "Actions for 0.9.0" }),
    );
    expect(
      (await screen.findAllByRole("menuitem")).map((m) => m.textContent),
    ).toEqual(["Unyank…"]);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(
      within(table).getByRole("button", { name: "Actions for 0.9.2" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Yank…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(confirmFor("package.yank").intent).toBe("danger");
    expect(dialog.textContent).toContain("can never be published again");
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: "Reason" }),
      "bad layer",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Yank 0.9.2" }),
    );
    await waitFor(() =>
      expect(log.calls.find((c) => c.method === "POST")?.json).toEqual({
        reason: "bad layer",
      }),
    );
  });

  it("Setup for the package and History filtered to it; a missing package is a not-found page", async () => {
    boot(
      "#/platform/feeds/npm/packages/polaris-key/%40polaris-key%2Fnode/setup",
      {
        extra: feedRoutes(),
      },
    );
    await heading("@polaris-key/node");
    await waitFor(() =>
      expect(main().textContent).toContain(
        "npm install @polaris-key/node@2.3.0",
      ),
    );
    cleanup();
    resetConsole();
    boot("#/platform/feeds/npm/packages/polaris-key/nope", {
      extra: {
        ...feedRoutes(),
        "/manage/api/platform/feeds/npm/packages/polaris-key/nope":
          new Response(
            JSON.stringify({
              error: { code: "not_found", message: "not found" },
            }),
            { status: 404 },
          ),
      },
    });
    await heading("Package not found");
  });

  it("passes axe", async () => {
    boot("#/platform/feeds/oci/packages/polaris-key/pkey", {
      extra: feedRoutes(),
    });
    await within(await screen.findByRole("main")).findByRole("table", {
      name: "Versions of pkey",
    });
    expect((await axe(main())).violations.map((v) => v.id)).toEqual([]);
  });
});

describe("Core → Services: the package feeds switch", () => {
  it("is its own section and saves on its own; turning it off asks first", async () => {
    const log = boot("#/p/djdl/settings/features", {
      extra: {
        ...feedRoutes(),
        ...product(true),
        "/manage/api/products/djdl/services": servicesResponse(ALL_ON),
        "PUT /manage/api/products/djdl/distribution/package-feeds": {
          ok: true,
          packageFeeds: { enabled: false, version: 3, updatedAt: 1 },
        },
      },
    });
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    const main = await mainReady();
    const section = await within(main).findByText("Packages");
    const sw = await within(main).findByRole("switch", { name: /Packages/ });
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
    await userEvent.click(sw);
    // No save bar: the switch's own L1 confirm is the only step.
    expect(
      within(section).queryByRole("button", { name: "Save package feeds" }),
    ).toBeNull();
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Turn off Packages" }),
    );
    await waitFor(() =>
      expect(log.calls.find((c) => c.method === "PUT")?.json).toEqual({
        enabled: false,
        expectedVersion: 2,
      }),
    );
  });
});
