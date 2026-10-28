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
import { setStepUpRedirectForTests } from "../src/lib/stepUp.js";
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
      ...patch,
    },
  };
  return boot("#/p/djdl/distribution/feeds/npm/settings", {
    extra: { ...routes, ...product(true), [`PUT ${NPM_PATH}/settings`]: put },
  });
}

describe("registry auth (F-21)", () => {
  it("Access is two options in General: Public and Licensed, no Access section", async () => {
    bootSettings("public");
    const form = await general();
    const radios = within(form).getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Public"),
      expect.stringContaining("Licensed"),
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

  it("Licensed shows the Tokens link; nothing to save while the choice is the stored one", async () => {
    const log = bootSettings("licensed");
    const form = await general();
    expect(
      within(form)
        .getByRole("radio", { name: /Licensed/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(within(form).getByRole("link", { name: "Tokens" })).toBeTruthy();
    expect(form.textContent).toContain("Polaris Locker");
    expect(within(form).queryByRole("button", { name: /^Save/ })).toBeNull();
    expect(form.textContent).not.toContain("gated individually");
    expect(log.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("opening a Public feed to Licensed stores licensed, after the L1 confirm", async () => {
    const log = bootSettings("public");
    const form = await general();
    await userEvent.click(
      within(form).getByRole("radio", { name: /Licensed/ }),
    );
    await userEvent.click(within(form).getByRole("button", { name: /^Save/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("refused within 30 seconds");
    expect(dialog.textContent).not.toContain("401");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Switch to Licensed" }),
    );
    await waitFor(() =>
      expect(log.calls.find((c) => c.method === "PUT")?.json).toEqual({
        expectedVersion: 3,
        accessMode: "licensed",
      }),
    );
  });

  it("widening Licensed to Public asks first (L1) and writes public", async () => {
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

  it("an entitled feed reads Licensed, gated per package, and is not rewritten", async () => {
    const log = bootSettings("entitled");
    const form = await general();
    expect(
      within(form)
        .getByRole("radio", { name: /Licensed/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
    // The selected card says the fact; there is no separate "Now" line.
    expect(
      within(form).getByRole("radio", { name: /Licensed/ }).textContent,
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
    // Public, then back to Licensed: the form is the stored choice again; still no write.
    await userEvent.click(within(form).getByRole("radio", { name: /Public/ }));
    // The warning is about Licensed: gone while Public is picked.
    expect(form.textContent).not.toContain("tokens are refused these packages");
    await userEvent.click(
      within(form).getByRole("radio", { name: /Licensed/ }),
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
      within(form).getByRole("radio", { name: /Licensed/ }),
    );
    await userEvent.click(within(form).getByRole("button", { name: /^Save/ }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Switch to Licensed" }),
    );
    expect(
      await within(form).findByText(
        "This page is out of date. Reload it, then choose again.",
      ),
    ).toBeTruthy();
    expect(
      within(form)
        .getByRole("radio", { name: /Licensed/ })
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
        "pkey release publish --deliverable swift.sourcekit --dir <your build output>",
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
        .getByRole("link", { name: "How to set it up" })
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

  it("a package lists only the tracks it has, and (N more) waits for the rows", async () => {
    boot("#/p/djdl/distribution/feeds", {
      extra: { ...feedRoutes(), ...product(true) },
    });
    const list = await within(await mainReady()).findByRole("list", {
      name: "Package feeds",
    });
    const npm = within(list).getByRole("region", { name: "npm" });
    const rows = await within(npm).findAllByRole("listitem");
    // @djdl/cli has a stable tag only: no "beta —".
    expect(rows[1]!.textContent).toMatch(/stable\s*1\.0\.1/);
    expect(rows[1]!.textContent).not.toContain("—");
  });

  it("a platform-off feed links to the platform page, not to Settings", async () => {
    const overview = productOverview();
    overview.feeds = overview.feeds.map((f) =>
      f.ecosystem === "pypi"
        ? {
            ...f,
            status: "unavailable" as const,
            reason: "platform-off" as const,
          }
        : f,
    );
    boot("#/p/djdl/distribution/feeds", {
      extra: {
        ...feedRoutes(),
        ...product(true),
        "/manage/api/products/djdl/distribution/feeds": overview,
      },
    });
    const pypi = await within(await mainReady()).findByRole("region", {
      name: "PyPI",
    });
    expect(within(pypi).queryByText(/Waiting/)).toBeNull();
    expect(
      within(pypi)
        .getByRole("link", { name: "Platform package feeds" })
        .getAttribute("href"),
    ).toBe("#/platform/feeds");
    expect(within(pypi).queryByText("Turn it on in Settings")).toBeNull();
  });

  it("a failed package read shows a small error with Retry", async () => {
    boot("#/p/djdl/distribution/feeds", {
      extra: {
        ...feedRoutes(),
        ...product(true),
        "/manage/api/products/djdl/distribution/feeds/npm/packages":
          new Response(
            JSON.stringify({ error: { code: "internal", message: "boom" } }),
            { status: 500 },
          ),
      },
    });
    const npm = await within(await mainReady()).findByRole("region", {
      name: "npm",
    });
    expect(
      await within(npm).findByRole("button", { name: "Retry" }),
    ).toBeTruthy();
    expect(within(npm).queryByText(/more\)/)).toBeNull();
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

  it("a Licensed feed reads Licensed on its card", async () => {
    const routes = feedRoutes();
    const overview = productOverview();
    overview.feeds = overview.feeds.map((f) =>
      f.ecosystem === "npm" ? { ...f, accessMode: "licensed" } : f,
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
      "Licensed",
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
        "pkey release publish --deliverable npm.sourcekit --dir <your build output>",
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
    expect(page.getByText(/Off since/)).toBeTruthy();
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
    // Public and Licensed, both choosable.
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
      ["public", /Licensed/, "Cancel"],
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

  it("switching off and moving to Licensed in one save asks once and saves both", async () => {
    const log = bootSettings("public");
    const form = await general();
    await userEvent.click(
      within(form).getByRole("switch", { name: "Serving" }),
    );
    await userEvent.click(
      within(form).getByRole("radio", { name: /Licensed/ }),
    );
    await userEvent.click(within(form).getByRole("button", { name: /^Save/ }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Switch off and use Licensed",
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
      within(form).getByRole("radio", { name: /Licensed/ }),
    );
    await userEvent.click(within(form).getByRole("button", { name: /^Save/ }));
    await userEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Switch to Licensed",
      }),
    );
    expect(
      await within(form).findByRole("button", { name: /Copy details/ }),
    ).toBeTruthy();
  });

  it("a never-saved feed reads Licensed, as the server defaults it", async () => {
    boot("#/p/djdl/distribution/feeds/swift/settings", {
      extra: { ...feedRoutes(), ...declaring("swift"), ...product(true) },
    });
    const form = await general();
    expect(
      within(form)
        .getByRole("radio", { name: /Licensed/ })
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
    const confirmButton = () =>
      within(dialog).getByRole("button", {
        name: "Deprecate 2.3.0",
      });
    const confirm = confirmButton();
    expect(
      confirm.hasAttribute("disabled") ||
        confirm.getAttribute("aria-disabled") === "true",
    ).toBe(true);
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: "Message" }),
      "Use 3.x",
    );
    await userEvent.click(confirmButton());
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
    // One confirm for one action: the same typed dialog as the Packages page.
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("Turn off package feeds for DJDL?"),
    ).toBeTruthy();
    await userEvent.type(
      within(dialog).getByLabelText(/Type the product slug/),
      "djdl",
    );
    await waitFor(() =>
      expect(
        within(dialog)
          .getByRole("button", { name: "Turn off package feeds" })
          .getAttribute("aria-disabled"),
      ).not.toBe("true"),
    );
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

describe("Packages: feeds off and Turn off package feeds (F-34.8)", () => {
  const SWITCH = "/manage/api/products/djdl/distribution/package-feeds";
  const OFF_AT = 1_790_000_000;
  // The owner row's `updatedBy` is a session subject: it must never render.
  const MBR = "mbr_01J9ZANALIMA";

  /** The product row with the F-34.3 summary: `offBy` is a display name. */
  function offProduct(on: boolean, offBy: string | null = "Ana Lima") {
    return {
      "/manage/api/products/djdl": {
        product: {
          ...productRow("djdl", "DJDL", ALL_ON),
          packageFeeds: on,
          packages: {
            declared: 3,
            feedsOn: on,
            offBy: on ? null : offBy,
            offAt: on ? null : OFF_AT,
          },
        },
      },
    };
  }
  const OWNER_ROW = {
    enabled: false,
    version: 7,
    updatedAt: OFF_AT,
    updatedBy: MBR,
  };
  const VIEW_ONLY = {
    platformAdmin: false,
    permissions: {
      roles: [],
      platform: { view: ["console"], edit: [] },
      products: {
        djdl: { view: ["core", "ship"], edit: [] },
        acme: { view: ["core"], edit: [] },
      },
    },
  } as never;
  const putCalls = (log: ReturnType<typeof boot>) =>
    log.calls.filter((c) => c.method === "PUT" && c.path === SWITCH);
  const noMember = () => expect(document.body.textContent).not.toMatch(/mbr_/);
  const enabled = async (el: HTMLElement) =>
    waitFor(() => expect(el.getAttribute("aria-disabled")).not.toBe("true"), {
      timeout: 8000,
    });
  const conflict = (row: Record<string, unknown>) =>
    new Response(
      JSON.stringify({
        error: "bad_request",
        reason: "version_conflict",
        packageFeeds: row,
      }),
      { status: 409 },
    );

  function bootOff(
    put: unknown,
    opts: { offBy?: string | null; me?: Record<string, unknown> } = {},
  ): ReturnType<typeof boot> {
    return boot("#/p/djdl/distribution/feeds", {
      ...(opts.me ? { me: opts.me } : {}),
      extra: {
        ...feedRoutes(),
        ...offProduct(false, opts.offBy ?? "Ana Lima"),
        [SWITCH]: { packageFeeds: OWNER_ROW },
        // The generic settings counter is a different number on purpose.
        "/manage/api/products/djdl/settings/distribution.packageFeeds": {
          version: 99,
        },
        [`PUT ${SWITCH}`]: put,
      },
    });
  }
  async function turnOnButton(): Promise<HTMLElement> {
    const page = within(await mainReady());
    await waitFor(
      () =>
        expect(
          page
            .getByRole("button", { name: "Turn on package feeds" })
            .getAttribute("aria-disabled"),
        ).not.toBe("true"),
      { timeout: 8000 },
    );
    return page.getByRole("button", { name: "Turn on package feeds" });
  }

  it("the off card is one solid card: who and when once, nothing deleted, the feeds inside", async () => {
    bootOff({ ok: true });
    const page = within(await mainReady());
    expect(
      await page.findByText(/Package feeds are off for DJDL/),
    ).toBeTruthy();
    expect(
      page.getByText("Installs and CI publishes are refused."),
    ).toBeTruthy();
    expect(
      await page.findByText(
        /Turned off by Ana Lima on .* · Nothing was deleted\./,
      ),
    ).toBeTruthy();
    // Not the first-run box: no dashed empty state.
    expect(main().querySelector("[data-empty]")).toBeNull();
    const card = main().querySelector("[data-feeds-off]") as HTMLElement;
    const list = within(card).getByRole("list", { name: "Feeds" });
    expect(within(list).getAllByRole("listitem").length).toBeGreaterThan(0);
    // The refusal is stated once, not per row.
    expect(card.textContent).not.toMatch(/Refusing/);
    expect(within(list).getByText("no packages yet")).toBeTruthy();
    // The header keeps the registry tokens action.
    expect(page.getByRole("button", { name: /Registry tokens/ })).toBeTruthy();
    noMember();
    expect((await axe(main())).violations.map((v) => v.id)).toEqual([]);
  });

  it("a manifest or unnamed actor reads as 'Off since', never 'turned off by the manifest'", async () => {
    bootOff({ ok: true }, { offBy: "manifest" });
    const page = within(await mainReady());
    expect(
      await page.findByText(/^Off since .* · Nothing was deleted/),
    ).toBeTruthy();
    expect(main().textContent).not.toMatch(/turned off by/i);
  });

  it("Turn on round-trips with the owner-row version and puts focus on the page title", async () => {
    const log = bootOff({
      ok: true,
      packageFeeds: { enabled: true, version: 8, updatedAt: OFF_AT + 5 },
    });
    await userEvent.click(await turnOnButton());
    await waitFor(() => expect(putCalls(log)).toHaveLength(1));
    expect(putCalls(log)[0]!.json).toEqual({
      enabled: true,
      expectedVersion: 7,
    });
  });

  it("Turn on stays disabled until the switch row has loaded", async () => {
    boot("#/p/djdl/distribution/feeds", {
      extra: {
        ...feedRoutes(),
        ...offProduct(false),
        [SWITCH]: PENDING,
      },
    });
    const page = within(await mainReady());
    const b = await page.findByRole("button", {
      name: "Turn on package feeds",
    });
    expect(b.getAttribute("aria-disabled")).toBe("true");
  });

  it("a view-only member gets a soft-disabled Turn on with the house reason", async () => {
    const log = bootOff({ ok: true }, { me: VIEW_ONLY });
    const page = within(await mainReady());
    const b = await page.findByRole("button", {
      name: "Turn on package feeds",
    });
    expect(b.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(b);
    expect(putCalls(log)).toHaveLength(0);
  });

  it("Turn on after a 409 (still off) says so, shows no member id, and retries with the fresh version", async () => {
    let n = 0;
    const log = bootOff(() => {
      n += 1;
      return n === 1
        ? conflict({ ...OWNER_ROW, version: 9 })
        : { ok: true, packageFeeds: { enabled: true, version: 10 } };
    });
    await userEvent.click(await turnOnButton());
    const page = within(await mainReady());
    expect(
      await page.findByText(/Package feeds changed since you opened this/),
    ).toBeTruthy();
    noMember();
    await userEvent.click(
      page.getByRole("button", { name: "Turn on package feeds" }),
    );
    await waitFor(() => expect(putCalls(log)).toHaveLength(2));
    expect(putCalls(log)[1]!.json).toEqual({
      enabled: true,
      expectedVersion: 9,
    });
  });

  it("Turn on after a 409 that says it is already on refetches the product and tells the user", async () => {
    const log = bootOff(() =>
      conflict({
        enabled: true,
        version: 9,
        updatedAt: OFF_AT,
        updatedBy: MBR,
      }),
    );
    await userEvent.click(await turnOnButton());
    expect(
      await screen.findByText("Package feeds were already turned on"),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        log.calls.filter(
          (c) => c.method === "GET" && c.path === "/manage/api/products/djdl",
        ).length,
      ).toBeGreaterThan(1),
    );
    noMember();
  });

  it("a failed Turn on is an inline error with Copy details, inside the card", async () => {
    bootOff(
      new Response(JSON.stringify({ error: "internal" }), { status: 500 }),
    );
    await userEvent.click(await turnOnButton());
    const card = main().querySelector("[data-feeds-off]") as HTMLElement;
    const alert = await within(card).findByRole("alert");
    expect(
      within(alert).getByRole("button", { name: /Copy details/ }),
    ).toBeTruthy();
  });

  /** Packages with the feeds on, ready to open the Turn off dialog. */
  async function openTurnOff(
    put: unknown,
    opts: { me?: Record<string, unknown>; sw?: unknown } = {},
  ) {
    const log = boot("#/p/djdl/distribution/feeds", {
      ...(opts.me ? { me: opts.me } : {}),
      extra: {
        ...feedRoutes(),
        ...offProduct(true),
        [SWITCH]: opts.sw ?? {
          packageFeeds: { ...OWNER_ROW, enabled: true },
        },
        [`PUT ${SWITCH}`]: put,
      },
    });
    const page = within(await mainReady());
    const opener = await page.findByRole("button", {
      name: "Turn off package feeds",
    });
    await userEvent.click(opener);
    const dialog = within(await screen.findByRole("alertdialog"));
    return { log, opener, dialog };
  }
  async function typeAndConfirm(dialog: ReturnType<typeof within>) {
    await userEvent.type(
      dialog.getByLabelText(/Type the product slug/),
      "djdl",
    );
    const confirm = dialog.getByRole("button", {
      name: "Turn off package feeds",
    });
    await enabled(confirm);
    await userEvent.click(confirm);
  }

  it("the confirmation names what stops and what is kept, and needs the product slug", async () => {
    const { log, dialog } = await openTurnOff({ ok: true });
    expect(dialog.getByText("Turn off package feeds for DJDL?")).toBeTruthy();
    expect(dialog.getByText("Installs").tagName).toBe("STRONG");
    expect(
      dialog.getByText(/answer not found, within 30 seconds/),
    ).toBeTruthy();
    expect(dialog.getByText("pkey release publish").tagName).toBe("CODE");
    expect(dialog.getByText("Service tokens")).toBeTruthy();
    expect(dialog.getByText(/versions, tokens and access/)).toBeTruthy();
    // One fact once: no separate "Nothing is deleted" line beside Kept.
    expect(dialog.queryByText(/Nothing is deleted/)).toBeNull();
    // 3 feeds, the packages the fixture holds.
    expect(dialog.getByText(/packages on 3 feeds answer/)).toBeTruthy();
    const confirm = dialog.getByRole("button", {
      name: "Turn off package feeds",
    });
    await waitFor(() =>
      expect(confirm.getAttribute("aria-disabled")).toBe("true"),
    );
    await userEvent.click(confirm);
    expect(putCalls(log)).toHaveLength(0);
    await userEvent.type(
      dialog.getByLabelText(/Type the product slug/),
      "djdl",
    );
    await enabled(
      dialog.getByRole("button", { name: "Turn off package feeds" }),
    );
  });

  it("the Confirm button waits for the switch row to load", async () => {
    const { dialog } = await openTurnOff({ ok: true }, { sw: PENDING });
    await userEvent.type(
      dialog.getByLabelText(/Type the product slug/),
      "djdl",
    );
    const b = dialog.getByRole("button", { name: "Turn off package feeds" });
    expect(
      b.getAttribute("aria-disabled") === "true" ||
        (b as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("Escape backs out without a write and focus returns to the opener", async () => {
    const { log, opener } = await openTurnOff({ ok: true });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(putCalls(log)).toHaveLength(0);
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("a view-only member gets a soft-disabled Turn off", async () => {
    boot("#/p/djdl/distribution/feeds", {
      me: VIEW_ONLY,
      extra: { ...feedRoutes(), ...offProduct(true) },
    });
    const b = await within(await mainReady()).findByRole("button", {
      name: "Turn off package feeds",
    });
    expect(b.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(b);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("sends the owner-row version, never the settings one, and focuses the off card's title", async () => {
    const { log, dialog } = await openTurnOff({
      ok: true,
      packageFeeds: { enabled: false, version: 8, updatedAt: OFF_AT },
    });
    await typeAndConfirm(dialog);
    await waitFor(() => expect(putCalls(log)).toHaveLength(1));
    expect(putCalls(log)[0]!.json).toEqual({
      enabled: false,
      expectedVersion: 7,
    });
  });

  it("a failed save keeps the typed word and the dialog", async () => {
    const { log, dialog } = await openTurnOff(
      new Response(JSON.stringify({ error: "internal" }), { status: 500 }),
    );
    await typeAndConfirm(dialog);
    await waitFor(() => expect(putCalls(log)).toHaveLength(1));
    expect(await dialog.findByRole("alert")).toBeTruthy();
    expect(
      (dialog.getByLabelText(/Type the product slug/) as HTMLInputElement)
        .value,
    ).toBe("djdl");
  });

  it("a 409 that finds the feeds already off ends the flow: no member id, the product refetched, no second confirm", async () => {
    const { log, dialog } = await openTurnOff(() =>
      conflict({ ...OWNER_ROW, version: 9 }),
    );
    await typeAndConfirm(dialog);
    expect(
      await screen.findByText("Package feeds are already off"),
    ).toBeTruthy();
    // The dialog is gone, so there is nothing left to confirm a second time.
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(putCalls(log)).toHaveLength(1);
    noMember();
    // The console shows the true state: the product was refetched.
    await waitFor(() =>
      expect(
        log.calls.filter(
          (c) => c.method === "GET" && c.path === "/manage/api/products/djdl",
        ).length,
      ).toBeGreaterThan(1),
    );
  });

  it("a 409 with the feeds still on shows the current state in the dialog and retries with the fresh version", async () => {
    let n = 0;
    const { log, dialog } = await openTurnOff(() => {
      n += 1;
      return n === 1
        ? conflict({ ...OWNER_ROW, enabled: true, version: 9 })
        : { ok: true, packageFeeds: { enabled: false, version: 10 } };
    });
    await typeAndConfirm(dialog);
    expect(
      await dialog.findByText(/changed since you opened this/),
    ).toBeTruthy();
    noMember();
    await userEvent.click(
      dialog.getByRole("button", { name: "Turn off package feeds" }),
    );
    await waitFor(() => expect(putCalls(log)).toHaveLength(2));
    expect(putCalls(log)[1]!.json).toEqual({
      enabled: false,
      expectedVersion: 9,
    });
  });

  const failOnce = (answer: unknown) => {
    let n = 0;
    return () => {
      n += 1;
      return n === 1
        ? new Response(JSON.stringify({ error: "internal" }), { status: 500 })
        : answer;
    };
  };

  it("B3: a failed switch read on the off card shows the box; Try again refetches and the write then works", async () => {
    const log = boot("#/p/djdl/distribution/feeds", {
      extra: {
        ...feedRoutes(),
        ...offProduct(false),
        [SWITCH]: failOnce({ packageFeeds: OWNER_ROW }),
        [`PUT ${SWITCH}`]: {
          ok: true,
          packageFeeds: { enabled: true, version: 8 },
        },
      },
    });
    const card = async () =>
      waitFor(
        () => {
          const c = main().querySelector("[data-feeds-off]");
          expect(c).not.toBeNull();
          return c as HTMLElement;
        },
        { timeout: 8000 },
      );
    const alert = await within(await card()).findByRole(
      "alert",
      {},
      { timeout: 8000 },
    );
    expect(
      within(alert).getByRole("button", { name: /Copy details/ }),
    ).toBeTruthy();
    expect(
      within(await card())
        .getByRole("button", { name: "Turn on package feeds" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    await userEvent.click(
      within(alert).getByRole("button", { name: "Try again" }),
    );
    await userEvent.click(await turnOnButton());
    await waitFor(() => expect(putCalls(log)).toHaveLength(1));
    expect(putCalls(log)[0]!.json).toEqual({
      enabled: true,
      expectedVersion: 7,
    });
  });

  it("B3: a network failure on the switch read shows the box too", async () => {
    bootOff({ ok: true });
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("/distribution/package-feeds") &&
      (init?.method ?? "GET") === "GET"
        ? Promise.reject(new TypeError("Failed to fetch"))
        : real(input, init),
    );
    const card = (await screen.findByRole("main")).querySelector(
      "[data-feeds-off]",
    );
    expect(card).toBeNull(); // not mounted yet: reloading the route mounts it under the stub
    window.location.hash = "#/p/djdl/distribution/feeds?x=1";
    const off = await waitFor(
      () => {
        const c = main().querySelector("[data-feeds-off]");
        expect(c).not.toBeNull();
        return c as HTMLElement;
      },
      { timeout: 8000 },
    );
    expect(
      await within(off).findByRole(
        "button",
        { name: "Try again" },
        { timeout: 8000 },
      ),
    ).toBeTruthy();
  });

  it("B3: the dialog shows the pending reason, then the box on a failed read, then writes after Try again", async () => {
    const pending = await openTurnOff({ ok: true }, { sw: PENDING });
    const b = pending.dialog.getByRole("button", {
      name: "Turn off package feeds",
    });
    const reason = document.getElementById(b.getAttribute("aria-describedby")!);
    expect(reason?.textContent).toMatch(/Loading|Type djdl/);
    await userEvent.type(
      pending.dialog.getByLabelText(/Type the product slug/),
      "djdl",
    );
    const typed = pending.dialog.getByRole("button", {
      name: "Turn off package feeds",
    });
    expect(
      document.getElementById(typed.getAttribute("aria-describedby")!)
        ?.textContent,
    ).toBe("Loading");
    cleanup();
    resetConsole();
    const { log, dialog } = await openTurnOff(
      {
        ok: true,
        packageFeeds: { enabled: false, version: 8 },
      },
      { sw: failOnce({ packageFeeds: { ...OWNER_ROW, enabled: true } }) },
    );
    const alert = await dialog.findByRole("alert", {}, { timeout: 8000 });
    await userEvent.click(
      within(alert).getByRole("button", { name: "Try again" }),
    );
    await waitFor(() => expect(dialog.queryByRole("alert")).toBeNull(), {
      timeout: 8000,
    });
    await typeAndConfirm(dialog);
    await waitFor(() => expect(putCalls(log)).toHaveLength(1));
    expect(putCalls(log)[0]!.json).toEqual({
      enabled: false,
      expectedVersion: 7,
    });
  });

  it("R3: turning feeds off from the Services switch leaves no stale focus for the Packages page", async () => {
    const { afterWrite } =
      await import("../src/console/sections/feeds/model/model.js");
    afterWrite.focus = null;
    boot("#/p/djdl/settings/features", {
      extra: {
        ...feedRoutes(),
        ...offProduct(true),
        "/manage/api/products/djdl/services": servicesResponse(ALL_ON),
        [SWITCH]: { packageFeeds: { ...OWNER_ROW, enabled: true } },
        [`PUT ${SWITCH}`]: {
          ok: true,
          packageFeeds: { enabled: false, version: 8 },
        },
      },
    });
    const sw = await within(await mainReady()).findByRole("switch", {
      name: /Packages/,
    });
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
    await userEvent.click(sw);
    const dialog = within(await screen.findByRole("alertdialog"));
    await typeAndConfirm(dialog);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(afterWrite.focus).toBeNull();
  });

  it("F1: the Services switch toast has no Undo and says 'Package feeds turned on'", async () => {
    boot("#/p/djdl/settings/features", {
      extra: {
        ...feedRoutes(),
        ...offProduct(false),
        "/manage/api/products/djdl/services": servicesResponse(ALL_ON),
        [SWITCH]: { packageFeeds: OWNER_ROW },
        [`PUT ${SWITCH}`]: {
          ok: true,
          packageFeeds: { enabled: true, version: 8 },
        },
      },
    });
    const sw = await within(await mainReady()).findByRole("switch", {
      name: /Packages/,
    });
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("false"));
    await waitFor(() =>
      expect(sw.getAttribute("aria-disabled")).not.toBe("true"),
    );
    await userEvent.click(sw);
    expect(await screen.findByText("Package feeds turned on")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });
});

describe("minting needs a fresh sign-in (F-33b.7)", () => {
  it("the New service token dialog turns into Sign in again and reopens with its input", async () => {
    const redirect = vi.fn();
    setStepUpRedirectForTests(() => redirect());
    sessionStorage.clear();
    const refused = () =>
      new Response(
        JSON.stringify({
          error: { code: "step_up_required", message: "sign in again" },
          code: "step_up_required",
        }),
        { status: 403 },
      );
    const routes = {
      ...feedRoutes(),
      ...product(true),
      [`POST ${TOKENS_URL}`]: refused(),
    };
    boot("#/p/djdl/distribution/feeds/tokens", { extra: routes });
    await tokensTable();
    let dialog = await openMint();
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: /Label/ }),
      "CI install",
    );
    const days = within(dialog).getByRole("textbox", { name: /Expires after/ });
    await userEvent.clear(days);
    await userEvent.type(days, "45");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create token" }),
    );
    await userEvent.click(
      await within(dialog).findByRole("button", { name: "Sign in again" }),
    );
    expect(redirect).toHaveBeenCalledTimes(1);
    // The sign-in returns to the page: the dialog is back, with what was typed.
    cleanup();
    boot("#/p/djdl/distribution/feeds/tokens", { extra: routes });
    dialog = await screen.findByRole("dialog", { name: "New service token" });
    expect(
      (
        within(dialog).getByRole("textbox", {
          name: /Label/,
        }) as HTMLInputElement
      ).value,
    ).toBe("CI install");
    await waitFor(() =>
      expect(
        (
          within(dialog).getByRole("textbox", {
            name: /Expires after/,
          }) as HTMLInputElement
        ).value,
      ).toBe("45"),
    );
    expect(
      within(dialog).getByRole("button", { name: "Create token" }),
    ).toBeTruthy();
    setStepUpRedirectForTests();
  });

  it("a publish token's dialog does the same and reopens as a publish dialog", async () => {
    const redirect = vi.fn();
    setStepUpRedirectForTests(() => redirect());
    sessionStorage.clear();
    const limits = {
      ...(tokensPage().limits as object),
      publishEcosystems: ["npm"],
      publishDefaultDays: 7,
      publishMaxDays: 30,
    };
    const routes = () => ({
      ...feedRoutes(),
      ...product(true),
      [TOKENS_URL]: tokensPage({ limits }),
      [`POST ${TOKENS_URL}`]: new Response(
        JSON.stringify({
          error: { code: "step_up_required" },
          code: "step_up_required",
        }),
        { status: 403 },
      ),
    });
    boot("#/p/djdl/distribution/feeds/tokens", { extra: routes() });
    await tokensTable();
    let dialog = await openMint();
    await userEvent.click(
      within(dialog).getByRole("radio", { name: /Read and publish/ }),
    );
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: /Label/ }),
      "Release box",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create token" }),
    );
    await userEvent.click(
      await within(dialog).findByRole("button", { name: "Sign in again" }),
    );
    expect(redirect).toHaveBeenCalledTimes(1);
    cleanup();
    boot("#/p/djdl/distribution/feeds/tokens", { extra: routes() });
    dialog = await screen.findByRole("dialog", { name: "New publish token" });
    expect(
      (
        within(dialog).getByRole("textbox", {
          name: /Label/,
        }) as HTMLInputElement
      ).value,
    ).toBe("Release box");
    setStepUpRedirectForTests();
  });
});
