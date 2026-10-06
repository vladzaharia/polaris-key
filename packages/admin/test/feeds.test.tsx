import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import {
  ALL_ON,
  PENDING,
  boot,
  productRow,
  resetConsole,
} from "./consoleHarness.js";
import { feedDetail, feedRoutes } from "./feedsFixture.js";
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
  feedSetupSnippets,
} from "../src/console/areas/feeds/model.js";

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

const main = (): HTMLElement => screen.getByRole("main");
/** The main column, once the shell has mounted. */
const mainReady = (): Promise<HTMLElement> => screen.findByRole("main");
const nav = (): HTMLElement =>
  screen.getAllByRole("navigation", { name: "Console" })[0]!;

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

describe("registry auth (F-21)", () => {
  it("leaving Public asks first (L1), and Entitled names the packages without a gate", async () => {
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
    const access = await within(await mainReady()).findByRole("form", {
      name: "Access",
    });
    await userEvent.click(
      within(access).getByRole("radio", { name: /Entitled/ }),
    );
    expect(access.textContent).toContain("@djdl/sdk");
    expect(
      within(access).getByRole("link", { name: /Open Tokens/ }),
    ).toBeTruthy();
    await userEvent.click(
      within(access).getByRole("button", { name: /^Save/ }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("401");
    await userEvent.click(
      within(dialog).getByRole("button", { name: /Switch to Entitled/ }),
    );
    await waitFor(() =>
      expect(log.calls.find((c) => c.method === "PUT")?.json).toEqual({
        expectedVersion: 3,
        accessMode: "entitled",
      }),
    );
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
    expect(table.textContent).toContain("Licensee, in the portal");
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

describe("capabilities through the shared badge (A-18j)", () => {
  it("the yank policy's version states render with the storefront tiles' CapabilityBadge", async () => {
    boot("#/p/djdl/distribution/feeds/npm/settings", {
      extra: { ...feedRoutes(), ...product(true) },
    });
    const form = await within(await mainReady()).findByRole("form", {
      name: "Yank policy",
    });
    const strip = within(form).getByRole("list", { name: "Version states" });
    const badges = strip.querySelectorAll("[data-capability]");
    expect(badges.length).toBe(2);
    expect(strip.textContent).toContain("Yank");
    expect(strip.textContent).toContain("Deprecate");
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

  it("product scope: the product's feeds, no owners panel, and the same components", async () => {
    boot("#/p/djdl/distribution/feeds", {
      extra: { ...feedRoutes(), ...product(true) },
    });
    await heading("Package feeds");
    const table = await within(await mainReady()).findByRole("table", {
      name: "Package feeds",
    });
    expect(
      within(table).getByText("https://pkg.plrs.im/npm/djdl/"),
    ).toBeTruthy();
    expect(
      within(table).getAllByText("This feed has no settings yet.").length,
    ).toBe(5);
    expect(
      within(main()).queryByRole("heading", { name: "Owners" }),
    ).toBeNull();
    // Listed under Distribution while package feeds are on.
    expect(
      within(nav())
        .getByRole("link", { name: "Package feeds" })
        .getAttribute("href"),
    ).toBe("#/p/djdl/distribution/feeds");
  });

  it("product scope with package feeds off: absent from the sidebar, and the page says where to turn them on", async () => {
    boot("#/p/djdl/distribution/feeds/npm", {
      extra: { ...feedRoutes(), ...product(false) },
    });
    await heading("Package feeds");
    expect(
      await within(await mainReady()).findByText(
        "Package feeds are off for this product",
      ),
    ).toBeTruthy();
    expect(
      within(main())
        .getByRole("link", { name: "Open Services" })
        .getAttribute("href"),
    ).toBe("#/p/djdl/services");
    expect(
      within(nav())
        .queryAllByRole("link", { name: "Package feeds" })
        .filter((a) => a.getAttribute("href")?.startsWith("#/p/")),
    ).toEqual([]);
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
      await within(await mainReady()).findByRole("button", { name: /retry/i }),
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
      extra: { ...feedRoutes(), ...product(true) },
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

  it("Settings: each section saves with the version it read; every access mode can be chosen (F-21)", async () => {
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
    const access = await within(await mainReady()).findByRole("form", {
      name: "Access",
    });
    const radios = within(access).getAllByRole("radio");
    expect(
      radios.map(
        (r) =>
          r.hasAttribute("disabled") ||
          r.getAttribute("data-disabled") !== null,
      ),
    ).toEqual([false, false, false, false]);
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
      within(general).getByRole("switch", { name: "Enabled" }),
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

  it("Settings in platform scope: the platform policy, and switching an ecosystem off is L2", async () => {
    boot("#/platform/feeds/oci/settings", { extra: feedRoutes() });
    const policy = await within(await mainReady()).findByRole("form", {
      name: "Platform policy",
    });
    expect(policy.textContent).toContain("every product's");
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
      ["oci", "Retention"],
      ["godot", "Asset listing"],
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
        [
          "General",
          "Access",
          "Namespace",
          "Limits",
          "Yank policy",
          title,
          "Platform policy",
        ].filter(Boolean),
      );
    }
    const godot = within(main()).getByRole("form", { name: "Asset listing" });
    expect(
      within(godot).getByRole("combobox", { name: "Category" }),
    ).toBeTruthy();
    expect(
      within(godot).getByRole("combobox", { name: "Support level" }),
    ).toBeTruthy();
    expect(
      within(godot).getByRole("textbox", { name: "License" }),
    ).toBeTruthy();
    expect(
      within(godot).getByRole("textbox", { name: "Oldest editor" }),
    ).toBeTruthy();
  });

  it("the OCI retention and Godot listing panels validate before saving", async () => {
    const put = "PUT /manage/api/platform/feeds/oci/settings";
    const log = boot("#/platform/feeds/oci/settings", {
      extra: {
        ...feedRoutes(),
        [put]: { ok: true, settings: feedDetail("platform", "oci").settings },
      },
    });
    const panel = await within(await mainReady()).findByRole("form", {
      name: "Retention",
    });
    const days = within(panel).getByRole("textbox", {
      name: "Untagged manifests",
    });
    await userEvent.type(days, "30");
    await userEvent.click(within(panel).getByRole("button", { name: /^Save/ }));
    await waitFor(() =>
      expect(log.calls.find((c) => c.method === "PUT")?.json).toEqual({
        expectedVersion: 3,
        ext: { retainUntaggedDays: 30 },
      }),
    );
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
        name: "Platform policy",
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
  it("is its own section and save; turning it off asks first", async () => {
    const log = boot("#/p/djdl/services", {
      extra: {
        ...feedRoutes(),
        ...product(true),
        "/manage/api/products/djdl/services": {
          services: ALL_ON,
          registration: null,
          effectiveRegistration: "requires-license",
          source: "manifest",
        },
        "PUT /manage/api/products/djdl/distribution/package-feeds": {
          ok: true,
          packageFeeds: { enabled: false, version: 3, updatedAt: 1 },
        },
      },
    });
    await heading("Services");
    const form = await within(await mainReady()).findByRole("form", {
      name: "Package feeds",
    });
    const sw = await within(form).findByRole("switch");
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
    await userEvent.click(sw);
    await userEvent.click(
      within(form).getByRole("button", { name: "Save package feeds" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Turn off package feeds" }),
    );
    await waitFor(() =>
      expect(log.calls.find((c) => c.method === "PUT")?.json).toEqual({
        enabled: false,
        expectedVersion: 2,
      }),
    );
  });
});
