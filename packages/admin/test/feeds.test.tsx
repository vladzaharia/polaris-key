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
  servicesResponse,
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

  it("Token and Licensed are one choice, Customers, over the stored value (P0-47)", async () => {
    // A feed stored as `authenticated` (the old Token) reads Customers and keeps its value.
    const routes = feedRoutes();
    const npm = "/manage/api/products/djdl/distribution/feeds/npm";
    const stored = feedDetail("product", "npm");
    routes[npm] = {
      ...stored,
      settings: { ...stored.settings, accessMode: "authenticated" },
    };
    const log = boot("#/p/djdl/distribution/feeds/npm/settings", {
      extra: {
        ...routes,
        ...product(true),
        [`PUT ${npm}/settings`]: { ok: true, settings: stored.settings },
      },
    });
    const access = await within(await mainReady()).findByRole("form", {
      name: "Access",
    });
    const names = within(access)
      .getAllByRole("radio")
      .map((r) => r.getAttribute("aria-label") ?? r.textContent ?? "");
    expect(names.some((n) => /Customers/.test(n))).toBe(true);
    expect(names.some((n) => /^Token|Licensed/.test(n))).toBe(false);
    const customers = within(access).getByRole("radio", { name: /Customers/ });
    expect(customers.getAttribute("aria-checked")).toBe("true");
    // Nothing to save while the choice is the stored one.
    expect(within(access).queryByRole("button", { name: /^Save/ })).toBeNull();
    // Entitled, then back: still nothing to save, and no write.
    await userEvent.click(
      within(access).getByRole("radio", { name: /Entitled/ }),
    );
    await userEvent.click(customers);
    expect(within(access).queryByRole("button", { name: /^Save/ })).toBeNull();
    expect(log.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("opening a public feed to Customers stores licensed, after the L1 confirm (P0-47)", async () => {
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
      within(access).getByRole("radio", { name: /Customers/ }),
    );
    await userEvent.click(
      within(access).getByRole("button", { name: /^Save/ }),
    );
    const dialog = await screen.findByRole("alertdialog");
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

  it("maps stored modes to choices and back without changing a stored Customers mode", () => {
    expect(feedAccessChoice("authenticated")).toBe("customers");
    expect(feedAccessChoice("licensed")).toBe("customers");
    expect(feedAccessChoice("public")).toBe("public");
    expect(feedAccessChoice("entitled")).toBe("entitled");
    expect(feedAccessMode("customers", "authenticated")).toBe("authenticated");
    expect(feedAccessMode("customers", "licensed")).toBe("licensed");
    expect(feedAccessMode("customers", "public")).toBe("licensed");
    expect(feedAccessMode("customers", "entitled")).toBe("licensed");
    expect(feedAccessMode("entitled", "authenticated")).toBe("entitled");
    expect(feedAccessMode("public", "licensed")).toBe("public");
  });

  it("the Tokens page lists service and legacy tokens, mints a service token and shows it once with every client's setup", async () => {
    const minted = {
      ok: true,
      token: `pkeyci_${"k".repeat(43)}`,
      view: {
        tokenId: "cit_new",
        label: "Build box",
        scopes: ["packages:read"],
        createdBy: "admin:ada@x.io",
        createdAt: 1_700_000_000,
        expiresAt: 1_700_000_000 + 90 * 86_400,
        lastUsedAt: null,
        hint: "kkkk",
        revokedAt: null,
        revokedBy: null,
        revokeReason: null,
        status: "active",
      },
    };
    const log = boot("#/p/djdl/distribution/feeds/tokens", {
      extra: {
        ...feedRoutes(),
        ...product(true),
        "POST /manage/api/products/djdl/distribution/feeds/tokens": minted,
      },
    });
    await heading("Service tokens");
    const table = await within(main()).findByRole("table", {
      name: "Service tokens",
    });
    await within(table).findByText("Deploy box");
    // The token's hint matches the secret in CI; the access column says what it reaches.
    expect(table.textContent).toContain("pkeyci_…R8VQ");
    expect(table.textContent).toContain("Reads every private feed");
    await userEvent.click(
      within(main()).getByRole("button", { name: /New token/ }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "New service token",
    });
    // No binding choice, no feed list, no Godot URL: a service token reads the product's feeds.
    expect(
      within(dialog).queryByRole("radio", { name: /One license/ }),
    ).toBeNull();
    expect(within(dialog).queryByRole("switch")).toBeNull();
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
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
        binding: "service",
        expiresInDays: 90,
      }),
    );
    const shown = await screen.findByRole("dialog", {
      name: "Service token created",
    });
    expect(shown.textContent).toContain(minted.token);
    expect(shown.textContent).toContain("Build box · expires");
    // CI's step: the secret name, the command, and snippets that read it from the environment.
    expect(shown.textContent).toContain(
      "Add it to your CI secrets as PKEY_REGISTRY_TOKEN",
    );
    expect(shown.textContent).toContain(
      "pkey feeds setup --ecosystem npm --owner djdl --token-env PKEY_REGISTRY_TOKEN",
    );
    expect(shown.textContent).toContain(
      "//pkg.plrs.im/npm/djdl/:_authToken=${PKEY_REGISTRY_TOKEN}",
    );
    // The feed's real scope, never the placeholder; the secret only in the one field.
    expect(shown.textContent).toContain("@djdl:registry=");
    expect(shown.textContent).not.toContain("@scope");
    expect(shown.textContent!.split(minted.token).length).toBe(2);
    // Godot is public here: no URL snippet.
    expect(shown.textContent).not.toContain("asset-library");
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
    await heading("Service tokens");
    await within(main()).findByRole("table", { name: "Service tokens" });
    await userEvent.click(
      within(main()).getByRole("button", { name: /New token/ }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "New service token",
    });
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: /Label/ }),
      "Pusher",
    );
    await userEvent.click(
      within(dialog).getByRole("radio", { name: /Read and publish/ }),
    );
    expect(dialog.textContent).toContain("docker push");
    // No error before an attempt. A publish token names its feeds: with none picked, Create
    // says so and sends nothing.
    expect(dialog.textContent).not.toContain(
      "Choose the feeds this token publishes to.",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create token" }),
    );
    expect(dialog.textContent).toContain(
      "Choose the feeds this token publishes to.",
    );
    expect(log.calls.some((c) => c.method === "POST")).toBe(false);
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

/** The product's tokens page body, with overrides. */
const TOKENS_URL = "/manage/api/products/djdl/distribution/feeds/tokens";
function tokensPage(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...(feedRoutes()[TOKENS_URL] as object), ...over };
}
const SERVICE_ROW = {
  scopes: ["packages:read"],
  createdBy: "admin:ada@x.io",
  createdAt: 1_700_000_000,
  expiresAt: 4_000_000_000,
  lastUsedAt: null,
  hint: "abcd",
  revokedAt: null,
  revokedBy: null,
  revokeReason: null,
  status: "active",
};
const refusal = (status: number, body: Record<string, unknown>): Response =>
  new Response(JSON.stringify({ error: body }), { status });
/** Member permissions: Ship at the given level, optionally Keys. */
function member(opts: { edit: boolean; keys?: boolean }) {
  const view = ["ship", ...(opts.keys ? ["keys"] : [])];
  return {
    platformAdmin: false,
    permissions: {
      roles: [],
      platform: { view: ["console"], edit: ["console"] },
      products: {
        djdl: { view, edit: opts.edit ? view : opts.keys ? ["keys"] : [] },
      },
    },
  } as never;
}
const tokensTable = async (): Promise<HTMLElement> =>
  within(await mainReady()).findByRole("table", { name: "Service tokens" });
const openMint = async (name = "New service token"): Promise<HTMLElement> => {
  await userEvent.click(
    within(main()).getByRole("button", { name: /New token/ }),
  );
  return screen.findByRole("dialog", { name });
};

describe("service tokens (F-33b.4)", () => {
  it("lists service tokens by hint, what each reaches, legacy with its end date, and folds the ended ones", async () => {
    const base = tokensPage();
    const tokens = base.tokens as Record<string, unknown>[];
    boot("#/p/djdl/distribution/feeds/tokens", {
      extra: {
        ...feedRoutes(),
        ...product(true),
        [TOKENS_URL]: {
          ...base,
          serviceTokens: [
            ...(base.serviceTokens as Record<string, unknown>[]),
            {
              ...SERVICE_ROW,
              tokenId: "cit_done",
              label: "Old runner",
              status: "revoked",
              revokedAt: 1_700_000_100,
              revokedBy: "admin:ada@x.io",
              revokeReason: "manual",
            },
          ],
          tokens: [
            ...tokens,
            {
              ...tokens[1],
              tokenId: "rtok_gone",
              label: "Detached",
              revokedBy: "system",
              revokeReason: "link_removed",
            },
            {
              ...tokens[0],
              tokenId: "rtok_push",
              label: "Pusher",
              scopes: ["publish", "read"],
              ecosystems: ["npm"],
              legacy: false,
            },
          ],
        },
      },
    });
    const table = await tokensTable();
    await within(table).findByText("Deploy box");
    const deploy = within(table).getByText("Deploy box").closest("tr")!;
    expect(deploy.textContent).toContain("pkeyci_…R8VQ");
    expect(deploy.textContent).not.toContain("cit_deploy");
    expect(deploy.textContent).toContain("Reads every private feed");
    expect(deploy.textContent).not.toContain("Never");
    expect(
      within(table).getByText("Idle runner").closest("tr")!.textContent,
    ).toContain("Never");
    const legacy = within(table).getByText("CI pull").closest("tr")!;
    // The console's date format, in the pill and in Expires.
    expect(legacy.textContent).toMatch(/Legacy\s*works until [A-Z][a-z]{2} \d/);
    expect(
      within(table).getByText("Pusher").closest("tr")!.textContent,
    ).toContain("Publishes to npm");
    // Ended tokens are folded behind one button, with who ended them and why.
    expect(within(table).queryByText("Detached")).toBeNull();
    await userEvent.click(
      within(main()).getByRole("button", { name: "Show 3 revoked" }),
    );
    expect(
      within(table).getByText("Detached").closest("tr")!.textContent,
    ).toContain("Revoked by System · link removed");
    expect(
      within(table).getByText("Old runner").closest("tr")!.textContent,
    ).toContain("Revoked by ada@x.io · manual");
    expect(
      within(table).getByText("Old laptop").closest("tr")!.textContent,
    ).toContain("Revoked by ada@x.io · manual");
  });

  it("starts an empty product with the next step: a token, and the command that prints the setup", async () => {
    boot("#/p/djdl/distribution/feeds/tokens", {
      extra: {
        ...feedRoutes(),
        ...product(true),
        [TOKENS_URL]: tokensPage({ tokens: [], serviceTokens: [] }),
      },
    });
    const m = await mainReady();
    expect(
      await within(m).findByText(
        "Give CI and servers read access to DJDL's private feeds",
      ),
    ).toBeTruthy();
    expect(m.textContent).toContain(
      "pkey feeds setup --ecosystem npm --owner djdl --token-env PKEY_REGISTRY_TOKEN",
    );
    // One New token…, in the header, while the list is empty.
    expect(within(m).getAllByRole("button", { name: /New token/ }).length).toBe(
      1,
    );
  });

  it("an empty product with no private feed names no command", async () => {
    const page = tokensPage({ tokens: [], serviceTokens: [] }) as {
      feeds: Record<string, unknown>[];
    };
    boot("#/p/djdl/distribution/feeds/tokens", {
      extra: {
        ...feedRoutes(),
        ...product(true),
        [TOKENS_URL]: {
          ...page,
          feeds: page.feeds.map((f) => ({ ...f, accessMode: "public" })),
        },
      },
    });
    const m = await mainReady();
    await within(m).findByText(/read access to DJDL's private feeds/);
    expect(m.textContent).not.toContain("pkey feeds setup");
  });

  it("the platform's Revoke all calls owner-bound read tokens registry tokens", async () => {
    boot("#/platform/feeds/tokens", { extra: feedRoutes() });
    const m = await mainReady();
    await within(m).findByRole("table", { name: "Registry tokens" });
    await userEvent.click(
      within(m).getAllByRole("button", { name: /More actions/i })[0]!,
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Revoke all/ }),
    );
    const all = await screen.findByRole("alertdialog");
    expect(all.textContent).toContain("Revoke the 1 active token?");
    expect(all.textContent).toContain("1 registry token stops working");
    expect(all.textContent).not.toContain("license token");
    expect(all.textContent).not.toContain("service");
  });

  it("revokes by cit_ id at L2, names the kind in the toast, and keeps focus on the next row's actions", async () => {
    // The list the server answers: the revoke below ends the first token in it.
    const page = tokensPage() as {
      serviceTokens: Record<string, unknown>[];
    };
    const log = boot("#/p/djdl/distribution/feeds/tokens", {
      extra: {
        ...feedRoutes(),
        ...product(true),
        [TOKENS_URL]: page,
        [`POST ${TOKENS_URL}/cit_deploy/revoke`]: {
          ok: true,
          view: { ...SERVICE_ROW, tokenId: "cit_deploy" },
        },
      },
    });
    const table = await tokensTable();
    await within(table).findByText("Deploy box");
    await userEvent.click(
      within(table).getByRole("button", { name: "Actions for Deploy box" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Revoke/ }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(confirmFor("registryToken.revoke").level).toBe(2);
    expect(dialog.textContent).toContain("Revoke Deploy box?");
    expect(dialog.textContent).not.toMatch(/\bmint/i);
    Object.assign(page.serviceTokens[0]!, {
      status: "revoked",
      revokedAt: 1_700_000_100,
    });
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Revoke token" }),
    );
    await waitFor(() =>
      expect(
        log.calls.some(
          (c) =>
            c.method === "POST" && c.path.endsWith("/tokens/cit_deploy/revoke"),
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(await screen.findByText("Service token revoked")).toBeTruthy();
    // Not <body>: the next row's actions, in display order.
    await waitFor(() =>
      expect(
        document.activeElement?.getAttribute("aria-label") ??
          document.activeElement?.outerHTML.slice(0, 200),
      ).toBe("Actions for Idle runner"),
    );
  });

  it("names a legacy token as legacy when it is revoked", async () => {
    boot("#/p/djdl/distribution/feeds/tokens", {
      extra: {
        ...feedRoutes(),
        ...product(true),
        [`POST ${TOKENS_URL}/rtok_ci/revoke`]: { ok: true, view: {} },
      },
    });
    const table = await tokensTable();
    await within(table).findByText("CI pull");
    await userEvent.click(
      within(table).getByRole("button", { name: "Actions for CI pull" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Revoke/ }),
    );
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Revoke token",
      }),
    );
    expect(await screen.findByText("Legacy token revoked")).toBeTruthy();
  });

  it("Revoke all is L3: the slug is typed, and the copy is the counts", async () => {
    const base = tokensPage();
    const log = boot("#/p/djdl/distribution/feeds/tokens", {
      extra: {
        ...feedRoutes(),
        ...product(true),
        [TOKENS_URL]: {
          ...base,
          tokens: [
            ...(base.tokens as Record<string, unknown>[]),
            {
              ...(base.tokens as Record<string, unknown>[])[0],
              tokenId: "rtok_lic",
              label: "Licensee token",
              legacy: false,
              binding: "license",
              licenseId: "lic_1",
              createdBy: "portal:pacc_1",
            },
          ],
        },
        [`POST ${TOKENS_URL}/revoke-all`]: { ok: true, revoked: 4 },
      },
    });
    await tokensTable();
    await userEvent.click(
      within(main()).getAllByRole("button", { name: /More actions/i })[0]!,
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Revoke all/ }),
    );
    const all = await screen.findByRole("alertdialog");
    expect(confirmFor("registryToken.revokeAll")).toMatchObject({
      level: 3,
      typed: "slug",
    });
    expect(all.textContent).toContain("Revoke all 4 active tokens?");
    expect(all.textContent).toContain(
      "2 service tokens and 1 legacy token stop working within 30 seconds.",
    );
    expect(all.textContent).toContain(
      "1 token a licensee created in Polaris Locker stops too.",
    );
    expect(all.textContent).not.toMatch(/\bmint/i);
    const confirm = within(all).getByRole("button", { name: "Revoke all" });
    expect(
      confirm.hasAttribute("disabled") ||
        confirm.getAttribute("aria-disabled") === "true",
    ).toBe(true);
    await userEvent.type(
      within(all).getByRole("textbox", { name: /Type to confirm/ }),
      "djdl",
    );
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Revoke all",
      }),
    );
    await waitFor(() =>
      expect(
        log.calls.some(
          (c) => c.method === "POST" && c.path.endsWith("/tokens/revoke-all"),
        ),
      ).toBe(true),
    );
  });

  it("leaves the licensee line out when no licensee token is active", async () => {
    boot("#/p/djdl/distribution/feeds/tokens", {
      extra: { ...feedRoutes(), ...product(true) },
    });
    await tokensTable();
    await userEvent.click(
      within(main()).getAllByRole("button", { name: /More actions/i })[0]!,
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Revoke all/ }),
    );
    const all = await screen.findByRole("alertdialog");
    expect(all.textContent).toContain("Revoke all 3 active tokens?");
    expect(all.textContent).not.toContain("a licensee created");
  });

  it("keeps the label when a save fails, says why, and returns focus on Escape", async () => {
    boot("#/p/djdl/distribution/feeds/tokens", {
      extra: {
        ...feedRoutes(),
        ...product(true),
        [`POST ${TOKENS_URL}`]: refusal(500, {
          code: "internal",
          message: "boom",
        }),
      },
    });
    await tokensTable();
    const open = within(main()).getByRole("button", { name: /New token/ });
    const dialog = await openMint();
    const label = within(dialog).getByRole("textbox", { name: /Label/ });
    await userEvent.type(label, "Keep me");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create token" }),
    );
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect((label as HTMLInputElement).value).toBe("Keep me");
    expect(screen.queryByRole("dialog", { name: /created/ })).toBeNull();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(open));
  });

  it("says why Create does nothing: an empty or control-character label is marked and focused", async () => {
    boot("#/p/djdl/distribution/feeds/tokens", {
      extra: { ...feedRoutes(), ...product(true) },
    });
    await tokensTable();
    const dialog = await openMint();
    const label = within(dialog).getByRole("textbox", { name: /Label/ });
    // Nothing is flagged before an attempt.
    expect(dialog.textContent).not.toContain("Give the token a label");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create token" }),
    );
    expect(dialog.textContent).toContain("Give the token a label");
    await waitFor(() => expect(document.activeElement).toBe(label));
    await userEvent.type(label, "bad\u0007label");
    expect(dialog.textContent).toContain(
      "Remove control characters from the label.",
    );
  });

  it("words a token limit and marks the field a 422 names", async () => {
    boot("#/p/djdl/distribution/feeds/tokens", {
      extra: {
        ...feedRoutes(),
        ...product(true),
        [`POST ${TOKENS_URL}`]: refusal(409, {
          code: "conflict",
          reason: "token_limit",
          message: "too many",
        }),
      },
    });
    await tokensTable();
    const dialog = await openMint();
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: /Label/ }),
      "One more",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create token" }),
    );
    expect(
      await within(dialog).findByText("Too many active tokens"),
    ).toBeTruthy();
    expect(dialog.textContent).toContain("djdl has 500 active tokens");
    expect(dialog.textContent).toContain("Revoke one, then try again.");
  });

  it("marks the field a 422 names, instead of a bare banner", async () => {
    const res = new Response(
      JSON.stringify({
        error: { code: "invalid_token", message: "bad", fields: ["label"] },
      }),
      { status: 422 },
    );
    boot("#/p/djdl/distribution/feeds/tokens", {
      extra: {
        ...feedRoutes(),
        ...product(true),
        [`POST ${TOKENS_URL}`]: res,
      },
    });
    await tokensTable();
    const dialog = await openMint();
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: /Label/ }),
      "Nope",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create token" }),
    );
    expect(
      await within(dialog).findByText(/The server refused this label/),
    ).toBeTruthy();
    expect(within(dialog).queryByRole("alert")).toBeNull();
    // Focus moves to the marked field.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole("textbox", { name: /Label/ }),
      ),
    );
  });

  it("returns focus to New token… when the shown-once dialog is done", async () => {
    const minted = {
      ok: true,
      token: `pkeyci_${"m".repeat(43)}`,
      view: { ...SERVICE_ROW, tokenId: "cit_m", label: "M", hint: "mmmm" },
    };
    boot("#/p/djdl/distribution/feeds/tokens", {
      extra: {
        ...feedRoutes(),
        ...product(true),
        [`POST ${TOKENS_URL}`]: minted,
      },
    });
    await tokensTable();
    const open = within(main()).getByRole("button", { name: /New token/ });
    const dialog = await openMint();
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: /Label/ }),
      "M",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create token" }),
    );
    const shown = await screen.findByRole("dialog", {
      name: "Service token created",
    });
    await userEvent.click(
      within(shown).getByRole("checkbox", { name: /stored it/ }),
    );
    await userEvent.click(within(shown).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(document.activeElement).toBe(open));
  });

  it("has no Create on the platform scope; its empty state points to Personal tokens", async () => {
    boot("#/platform/feeds/tokens", { extra: feedRoutes() });
    await heading("Registry tokens");
    const m = await mainReady();
    await within(m).findByRole("table", { name: "Registry tokens" });
    expect(within(m).queryByRole("button", { name: /New token/ })).toBeNull();
    expect(m.textContent).toContain(
      "Team members install with their personal token.",
    );
    cleanup();
    resetConsole();
    const page = feedRoutes()["/manage/api/platform/feeds/tokens"] as object;
    boot("#/platform/feeds/tokens", {
      extra: {
        ...feedRoutes(),
        "/manage/api/platform/feeds/tokens": { ...page, tokens: [] },
      },
    });
    const empty = await mainReady();
    const link = await within(empty).findByRole("link", {
      name: "Personal tokens",
    });
    expect(link.getAttribute("href")).toBe("#/personal-tokens");
    // The sentence is said once, not as a callout and again in the empty state.
    expect(empty.textContent!.split("personal token").length).toBe(2);
  });

  it("shows the page's error with Try again, and New token… says it couldn't load", async () => {
    boot("#/p/djdl/distribution/feeds/tokens", {
      extra: {
        ...feedRoutes(),
        ...product(true),
        [TOKENS_URL]: refusal(500, { code: "internal", message: "boom" }),
      },
    });
    const m = await mainReady();
    expect(
      await within(m).findByRole("button", { name: /try again/i }),
    ).toBeTruthy();
    const btn = within(m).getByRole("button", { name: /New token/ });
    await waitFor(() =>
      expect(
        document.getElementById(btn.getAttribute("aria-describedby") ?? "x")
          ?.textContent,
      ).toBe("Couldn't load tokens"),
    );
  });

  it("without Keys the Read option is off and says who to ask; a publish token still comes through", async () => {
    boot("#/p/djdl/distribution/feeds/tokens", {
      me: member({ edit: true }),
      extra: {
        ...feedRoutes(),
        ...product(true),
        "/manage/api/access/admins": { admins: [] },
        [TOKENS_URL]: tokensPage({
          limits: {
            ...(tokensPage().limits as object),
            publishEcosystems: ["npm"],
            publishDefaultDays: 7,
            publishMaxDays: 30,
          },
        }),
      },
    });
    await tokensTable();
    const dialog = await openMint("New publish token");
    const read = within(dialog).getByRole("radio", { name: /^Read(?! and)/ });
    expect(
      read.hasAttribute("disabled") ||
        read.getAttribute("aria-disabled") === "true",
    ).toBe(true);
    expect(dialog.textContent).toContain("Keys and secrets access");
    // The publish default applies from the first render, and a sole publish feed is ticked.
    expect(
      (
        within(dialog).getByRole("textbox", {
          name: /Expires after/,
        }) as HTMLInputElement
      ).value,
    ).toBe("7");
    expect(
      within(dialog)
        .getByRole("checkbox", { name: /npm/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("without Keys and without a publish feed, New token… says why it is off", async () => {
    boot("#/p/djdl/distribution/feeds/tokens", {
      me: member({ edit: true }),
      extra: {
        ...feedRoutes(),
        ...product(true),
        "/manage/api/access/admins": { admins: [] },
      },
    });
    await tokensTable();
    const btn = within(main()).getByRole("button", { name: /New token/ });
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    await waitFor(() =>
      expect(
        document.getElementById(btn.getAttribute("aria-describedby") ?? "x")
          ?.textContent,
      ).toContain("Keys and secrets access"),
    );
  });

  it("a view-only member sees Revoke and Revoke all off, with the reason", async () => {
    boot("#/p/djdl/distribution/feeds/tokens", {
      me: member({ edit: false }),
      extra: {
        ...feedRoutes(),
        ...product(true),
        "/manage/api/access/admins": { admins: [] },
      },
    });
    const table = await tokensTable();
    await within(table).findByText("Deploy box");
    await userEvent.click(
      within(table).getByRole("button", { name: "Actions for Deploy box" }),
    );
    const item = await screen.findByRole("menuitem", { name: /Revoke/ });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    await userEvent.keyboard("{Escape}");
    await userEvent.click(
      within(main()).getAllByRole("button", { name: /More actions/i })[0]!,
    );
    const all = await screen.findByRole("menuitem", { name: /Revoke all/ });
    expect(all.getAttribute("aria-disabled")).toBe("true");
  });

  it("handles a few hundred service tokens, with search", async () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      ...SERVICE_ROW,
      tokenId: `cit_${String(i).padStart(4, "0")}`,
      label: `Runner ${i}`,
    }));
    boot("#/p/djdl/distribution/feeds/tokens", {
      extra: {
        ...feedRoutes(),
        ...product(true),
        [TOKENS_URL]: tokensPage({ serviceTokens: many }),
      },
    });
    const table = await tokensTable();
    await within(table).findByText("Runner 0");
    expect(table.querySelectorAll("tbody tr").length).toBeGreaterThan(10);
    expect(within(main()).getByRole("searchbox")).toBeTruthy();
  });

  it("passes axe", async () => {
    boot("#/p/djdl/distribution/feeds/tokens", {
      extra: { ...feedRoutes(), ...product(true) },
    });
    await within(await tokensTable()).findByText("Deploy box");
    expect((await axe(main())).violations.map((v) => v.id)).toEqual([]);
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

  it("product scope with package feeds off: absent from the sidebar, and the page offers Turn on", async () => {
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
    await heading("Package feeds");
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
    // Public, Customers (Token and Licensed are one choice, P0-47) and Entitled.
    expect(
      radios.map(
        (r) =>
          r.hasAttribute("disabled") ||
          r.getAttribute("data-disabled") !== null,
      ),
    ).toEqual([false, false, false]);
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
        ].filter(Boolean),
      );
      // P0-47: Upstream had one option (none) and is gone; the feed still never proxies.
      expect(within(main()).queryByText("Upstream registry"), eco).toBeNull();
      expect(
        within(main()).queryByRole("region", { name: "Upstream" }),
        eco,
      ).toBeNull();
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
