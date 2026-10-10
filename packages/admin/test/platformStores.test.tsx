import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { PENDING, boot, resetConsole } from "./consoleHarness.js";
import { confirmFor } from "../src/lib/actions.js";
import {
  appStatusLines,
  credentialHealth,
} from "../src/console/pages/platformStores.js";
import type { PlatformStoreApp, PlatformStoreCredential } from "../src/api.js";

/**
 * Platform → Store connections (A-16; ADMIN.md §2.3): credential presence and health per store,
 * never key material; the apps the team credential sees; assign and release (L1) with the 409
 * refusals in plain words and the result panel; the Play track-status opt-in; Re-check.
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
const nav = (): HTMLElement =>
  screen.getAllByRole("navigation", { name: "Console" })[0]!;

const BASE = "/manage/api/platform/store-connections";

function credential(
  over: Partial<PlatformStoreCredential> & { id: string },
): PlatformStoreCredential {
  const [store, slot] = over.id.split(".") as [
    PlatformStoreCredential["store"],
    string,
  ];
  return {
    store,
    slot,
    kind: "asc-api-key",
    label: over.id,
    configured: false,
    source: null,
    meta: null,
    console: {
      present: false,
      status: null,
      meta: null,
      createdAt: null,
      createdBy: null,
      rotatedAt: null,
      lastUsedAt: null,
      lastOkAt: null,
      lastError: null,
    },
    secret: { name: "PLATFORM_X", present: false, valid: false },
    pinField: "appleId",
    pins: 0,
    ...over,
  };
}

const STORES = [
  {
    store: "app-store",
    label: "App Store",
    configured: true,
    primary: "app-store.api-key",
    credentials: [
      credential({
        id: "app-store.api-key",
        label: "App Store Connect API key (team)",
        configured: true,
        source: "secret",
        meta: { keyId: "ABC123DEFG", issuerId: "69a6de7f-1111" },
        secret: { name: "PLATFORM_ASC_API_KEY", present: true, valid: true },
        pins: 1,
      }),
      credential({
        id: "app-store.in-app-purchase-key",
        label: "In-App Purchase key (team, App Store Server API)",
        kind: "app-store-server-key",
        secret: {
          name: "PLATFORM_APP_STORE_SERVER_KEY",
          present: false,
          valid: false,
        },
        pinField: "bundleId",
      }),
    ],
    settings: [
      {
        key: "teamId",
        label: "Apple Developer Team ID",
        usedBy: "App Attest's default team.",
        value: "48H7CLBV8Y",
        source: "env",
        envName: "PLATFORM_APPLE_TEAM_ID",
        updatedAt: null,
        updatedBy: null,
      },
    ],
    appsListing: true,
    assignments: [
      { product: "acme", pins: { "app-store.api-key": "2222222222" } },
    ],
  },
  {
    store: "google-play",
    label: "Google Play",
    configured: true,
    primary: "google-play.service-account",
    credentials: [
      credential({
        id: "google-play.service-account",
        label: "Google Play service account (developer account)",
        kind: "google-service-account",
        configured: true,
        source: "console",
        meta: { clientEmail: "pk@acme.iam.gserviceaccount.com" },
        console: {
          present: true,
          status: "active",
          meta: { clientEmail: "pk@acme.iam.gserviceaccount.com" },
          createdAt: 1_790_000_000,
          createdBy: "u1",
          rotatedAt: null,
          lastUsedAt: 1_790_000_100,
          lastOkAt: 1_790_000_100,
          lastError: null,
        },
        secret: {
          name: "PLATFORM_GOOGLE_SERVICE_ACCOUNT",
          present: false,
          valid: false,
        },
        pinField: "packageName",
      }),
    ],
    settings: [],
    appsListing: true,
    assignments: [],
  },
  {
    store: "microsoft-store",
    label: "Microsoft Store",
    configured: true,
    primary: "microsoft-store.partner-center",
    credentials: [
      credential({
        id: "microsoft-store.partner-center",
        label: "Partner Center app (seller account)",
        kind: "ms-partner-center",
        configured: true,
        source: "console",
        meta: { tenantId: "t-1", clientId: "c-1", sellerId: "s-1" },
        console: {
          present: true,
          status: "active",
          meta: null,
          createdAt: 1_790_000_000,
          createdBy: "u1",
          rotatedAt: null,
          lastUsedAt: 1_790_000_100,
          lastOkAt: null,
          lastError: "Partner Center token: HTTP 401",
        },
        pinField: "productId",
      }),
    ],
    settings: [],
    appsListing: true,
    assignments: [],
  },
  {
    store: "steam",
    label: "Steam",
    configured: false,
    primary: "steam.publisher-key",
    credentials: [
      credential({
        id: "steam.publisher-key",
        label: "Steamworks Web API publisher key (group)",
        kind: "steam-publisher-key",
        secret: {
          name: "PLATFORM_STEAM_PUBLISHER_KEY",
          present: false,
          valid: false,
        },
        pinField: "appId",
      }),
    ],
    settings: [],
    appsListing: true,
    assignments: [],
  },
];

const ASC_APPS = {
  store: "app-store",
  source: "secret",
  fetchedAt: 1_790_000_000,
  cached: false,
  truncated: false,
  apps: [
    {
      appId: "1234567890",
      name: "Godot Demo",
      pins: { "app-store.in-app-purchase-key": "com.acme.demo" },
      identifiers: { bundleId: "com.acme.demo", sku: "DEMO" },
      status: {
        appStore: {
          versions: [
            {
              platform: "IOS",
              versionString: "1.2.0",
              state: "WAITING_FOR_REVIEW",
            },
          ],
          phasedRelease: null,
        },
        testflight: { versions: [{ id: "p1" }] },
      },
      assignedProduct: null,
      assignedVia: null,
    },
    {
      appId: "2222222222",
      name: "Acme Game",
      pins: {},
      identifiers: { bundleId: "com.acme.game", sku: null },
      status: { appStore: { versions: [], phasedRelease: null } },
      assignedProduct: "acme",
      assignedVia: "platform",
    },
    {
      appId: "3333333333",
      name: "DJ Tool",
      pins: {},
      identifiers: { bundleId: "com.djdl.tool", sku: null },
      status: { appStore: { versions: [], phasedRelease: null } },
      assignedProduct: "djdl",
      assignedVia: "own-credential",
    },
  ],
};

const PLAY_APPS = (tracks: boolean) => ({
  store: "google-play",
  source: "console",
  fetchedAt: 1_790_000_000,
  cached: true,
  truncated: false,
  apps: [
    {
      appId: "com.acme.game",
      name: "Acme Game",
      pins: {},
      identifiers: { packageName: "com.acme.game" },
      status: tracks
        ? {
            tracks: [
              {
                track: "production",
                releases: [
                  {
                    name: "42",
                    status: "inProgress",
                    userFraction: 0.2,
                    versionCodes: ["42"],
                  },
                ],
              },
            ],
            tracksError: null,
          }
        : { tracks: null, tracksError: null },
      assignedProduct: null,
      assignedVia: null,
    },
  ],
});

const ASSIGN_RESULT = {
  ok: true,
  store: "app-store",
  appId: "1234567890",
  product: "djdl",
  pins: [
    { credential: "app-store.api-key", pin: "1234567890", changed: true },
    {
      credential: "app-store.in-app-purchase-key",
      pin: "com.acme.demo",
      changed: true,
    },
  ],
  released: [],
  ownCredentialsRepinned: ["oc_asc_1"],
  ownCredentialsSkipped: [{ id: "oc_steam_9", reason: "account_unverified" }],
};

function routes(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [BASE]: { ok: true, stores: STORES },
    [`${BASE}/app-store/apps`]: ASC_APPS,
    [`${BASE}/google-play/apps`]: (q: URLSearchParams) =>
      PLAY_APPS(q.get("tracks") === "1"),
    [`${BASE}/microsoft-store/apps`]: {
      store: "microsoft-store",
      source: "console",
      fetchedAt: 1_790_000_000,
      cached: false,
      truncated: false,
      apps: [],
    },
    [`${BASE}/app-store/apps/1234567890/product`]: ASSIGN_RESULT,
    [`${BASE}/app-store/apps/2222222222/product`]: {
      ok: true,
      store: "app-store",
      appId: "2222222222",
      product: "acme",
      cleared: [{ credential: "app-store.api-key", pin: "2222222222" }],
    },
    ...over,
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function storesPage(): Promise<HTMLElement> {
  await screen.findByRole("heading", { level: 1, name: "Store connections" });
  return main();
}

async function appsTable(): Promise<HTMLElement> {
  return within(main()).findByRole("table");
}

async function openRowMenu(name: string): Promise<void> {
  await userEvent.click(
    await within(main()).findByRole("button", { name: `Actions for ${name}` }),
  );
}

describe("Store connections: navigation and URL", () => {
  it("is listed in the Platform section and carries its help link", async () => {
    boot(`#/platform/store-connections`, { extra: routes() });
    await storesPage();
    const link = within(nav()).getByRole("link", { name: "Store connections" });
    expect(link.getAttribute("href")).toBe("#/platform/store-connections");
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(link.querySelector("svg[data-nav-icon]")).not.toBeNull();
    expect(document.title).toBe("Store connections · Polaris Key");
    expect(
      screen
        .getAllByRole("link", { name: /Docs/ })
        .some((a) =>
          a.getAttribute("href")?.includes("/docs/operate/platform/connections/"),
        ),
    ).toBe(true);
  });

  it("keeps the chosen store in the URL, both ways", async () => {
    boot(`#/platform/store-connections?store=microsoft-store`, {
      extra: routes(),
    });
    const page = await storesPage();
    const ms = within(page).getByRole("button", { name: /Microsoft Store/ });
    expect(ms.getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(
      within(page).getByRole("button", { name: /Google Play/ }),
    );
    await waitFor(() =>
      expect(window.location.hash).toBe(
        "#/platform/store-connections?store=google-play",
      ),
    );
    expect(
      within(page)
        .getByRole("button", { name: /Google Play/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });
});

describe("Store connections: credentials", () => {
  it("shows presence, source and account metadata, never a key", async () => {
    boot(`#/platform/store-connections`, { extra: routes() });
    const page = await storesPage();
    const creds = await within(page).findByRole("region", {
      name: "Credentials",
    });
    expect(within(creds).getByText("PLATFORM_ASC_API_KEY")).toBeTruthy();
    expect(within(creds).getByText("69a6de7f-1111")).toBeTruthy();
    expect(within(creds).getByText("ABC123DEFG")).toBeTruthy();
    expect(within(creds).getByText("Not checked")).toBeTruthy();
    // The In-App Purchase slot is unset: its secret name says how to add it.
    expect(
      within(creds).getByText("PLATFORM_APP_STORE_SERVER_KEY"),
    ).toBeTruthy();
    const account = within(page).getByRole("region", { name: "Account" });
    expect(within(account).getByText("48H7CLBV8Y")).toBeTruthy();
    expect(page.textContent).not.toMatch(/PRIVATE KEY|p8|clientSecret/);
  });

  it("shows the last check's status line when the store refused it", async () => {
    boot(`#/platform/store-connections?store=microsoft-store`, {
      extra: routes(),
    });
    const page = await storesPage();
    const creds = await within(page).findByRole("region", {
      name: "Credentials",
    });
    expect(within(creds).getAllByText("Last check failed").length).toBe(1);
    expect(
      within(creds).getByText("Partner Center token: HTTP 401"),
    ).toBeTruthy();
    expect(within(creds).getByText("s-1")).toBeTruthy();
  });

  it("offers the connect form and, as the alternative, the Worker-secret workflow", async () => {
    const log = boot(`#/platform/store-connections?store=steam`, {
      extra: routes(),
    });
    const page = await storesPage();
    expect(
      await within(page).findByText("No Steam credential yet"),
    ).toBeTruthy();
    expect(page.textContent).toContain(
      "gh secret set PLATFORM_STEAM_PUBLISHER_KEY --env production < key.json",
    );
    expect(page.textContent).toContain(
      "gh workflow run sync-worker-secrets.yml -f target=prod",
    );
    expect(
      within(page)
        .getAllByRole("link")
        .some(
          (a) => a.getAttribute("href") === "/docs/operate/platform/connections/",
        ),
    ).toBe(true);
    // No listing is requested for a store with no credential. UX-69 (SETUP.md D42): the key is
    // pasted into a connect form that checks it before saving; nothing is checked until then.
    expect(log.calls.some((c) => c.path === `${BASE}/steam/apps`)).toBe(false);
    expect(
      within(page).getByRole("form", {
        name: "Connect Steamworks Web API publisher key (group)",
      }),
    ).toBeTruthy();
    expect(within(page).getByText("Or set it as a Worker secret")).toBeTruthy();
    expect(log.calls.some((c) => c.path.endsWith("/check"))).toBe(false);
  });

  it("classifies credential health", () => {
    const base = credential({ id: "steam.publisher-key" });
    expect(credentialHealth(base)).toBe("missing");
    expect(
      credentialHealth({
        ...base,
        secret: { name: "X", present: true, valid: false },
      }),
    ).toBe("invalid");
    expect(credentialHealth({ ...base, source: "secret" })).toBe("unchecked");
    expect(
      credentialHealth({
        ...base,
        source: "console",
        console: { ...base.console, present: true, lastOkAt: 1 },
      }),
    ).toBe("working");
    expect(
      credentialHealth({
        ...base,
        console: { ...base.console, present: true, status: "disabled" },
      }),
    ).toBe("inactive");
  });
});

describe("Store connections: apps", () => {
  it("lists the apps the team credential sees, with store status and holder", async () => {
    boot(`#/platform/store-connections`, { extra: routes() });
    await storesPage();
    const table = await appsTable();
    expect(await within(table).findByText("Godot Demo")).toBeTruthy();
    expect(
      within(table).getByText("iOS 1.2.0: Waiting for review"),
    ).toBeTruthy();
    expect(within(table).getByText("TestFlight: 1 version(s)")).toBeTruthy();
    expect(
      within(table).getByRole("link", { name: "Acme" }).getAttribute("href"),
    ).toBe("#/p/acme");
    expect(
      within(table).getByText("through the product's own key"),
    ).toBeTruthy();
  });

  it("reads Play track status only on the explicit opt-in", async () => {
    const log = boot(`#/platform/store-connections?store=google-play`, {
      extra: routes(),
    });
    const page = await storesPage();
    const table = await appsTable();
    expect(
      await within(table).findByText("Track status not loaded"),
    ).toBeTruthy();
    const playCalls = () =>
      log.calls.filter((c) => c.path === `${BASE}/google-play/apps`);
    expect(playCalls().every((c) => !c.query.includes("tracks"))).toBe(true);
    await userEvent.click(
      within(page).getByRole("switch", { name: /Show track status/ }),
    );
    expect(
      await within(main()).findByText(
        "production: In progress, 20%, version code 42",
      ),
    ).toBeTruthy();
    expect(playCalls().some((c) => c.query === "tracks=1")).toBe(true);
    expect(window.location.hash).toContain("tracks=1");
  });

  it("Re-check reads the store again and refreshes the credential's health", async () => {
    const log = boot(`#/platform/store-connections`, { extra: routes() });
    const page = await storesPage();
    await appsTable();
    const before = log.calls.filter((c) => c.path === BASE).length;
    await userEvent.click(
      within(page).getByRole("button", { name: "Re-check" }),
    );
    await waitFor(() =>
      expect(
        log.calls.some(
          (c) => c.path === `${BASE}/app-store/apps` && c.query === "refresh=1",
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(log.calls.filter((c) => c.path === BASE).length).toBeGreaterThan(
        before,
      ),
    );
  });

  it("shows the store's refusal as a status line", async () => {
    boot(`#/platform/store-connections`, {
      extra: routes({
        [`${BASE}/app-store/apps`]: json(502, {
          error: {
            code: "store_unavailable",
            message: "App Store Connect apps: HTTP 401",
            status: 401,
          },
        }),
      }),
    });
    const page = await storesPage();
    expect(
      await within(page).findByText("App Store Connect apps: HTTP 401"),
    ).toBeTruthy();
    expect(
      within(page).getByText("App Store refused the apps listing"),
    ).toBeTruthy();
  });

  it("words store status for every store", () => {
    const app = (status: Record<string, unknown>, ids = {}) =>
      ({
        appId: "1",
        name: null,
        pins: {},
        identifiers: ids,
        status,
        assignedProduct: null,
        assignedVia: null,
      }) as PlatformStoreApp;
    expect(
      appStatusLines(
        "microsoft-store",
        app({ pendingStatus: "PreProcessing", lastPublishedSubmission: "x" }),
        false,
      ),
    ).toEqual(["Pending submission: Pre processing", "Published"]);
    expect(appStatusLines("steam", app({ source: "operator" }), false)).toEqual(
      ["Entered by an operator (not listed by Steam)"],
    );
    expect(
      appStatusLines("google-play", app({ tracksError: "HTTP 403" }), true),
    ).toEqual(["Track status unavailable: HTTP 403"]);
  });
});

describe("Store connections: assign and release", () => {
  it("assigns behind the L1 caution confirm and lists what changed", async () => {
    expect(confirmFor("storeApp.assign").level).toBe(1);
    const log = boot(`#/platform/store-connections`, { extra: routes() });
    await storesPage();
    await appsTable();
    await openRowMenu("Godot Demo");
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Assign to product…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("com.acme.demo");
    const confirm = within(dialog).getByRole("button", { name: "Assign app" });
    expect(
      confirm.hasAttribute("disabled") ||
        confirm.getAttribute("aria-disabled") === "true",
    ).toBe(true);
    await userEvent.click(within(dialog).getByRole("combobox"));
    await userEvent.click(await screen.findByRole("option", { name: "DJDL" }));
    const listsBefore = log.calls.filter((c) => c.path === BASE).length;
    await userEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Assign app",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    const put = log.calls.find(
      (c) =>
        c.method === "PUT" &&
        c.path === `${BASE}/app-store/apps/1234567890/product`,
    );
    expect(JSON.parse(put!.body!)).toEqual({ product: "djdl" });
    expect(
      await within(main()).findByText(/Assigned Godot Demo to djdl/),
    ).toBeTruthy();
    expect(main().textContent).toContain("oc_asc_1");
    expect(main().textContent).toContain("oc_steam_9");
    await waitFor(() =>
      expect(log.calls.filter((c) => c.path === BASE).length).toBeGreaterThan(
        listsBefore,
      ),
    );
  });

  for (const [code, title] of [
    ["app_assigned_elsewhere", "Another product already holds this app"],
    [
      "own_credential_other_account",
      "The product's own key belongs to another account",
    ],
  ] as const) {
    it(`explains a 409 ${code} in plain words and keeps the dialog open`, async () => {
      boot(`#/platform/store-connections`, {
        extra: routes({
          [`${BASE}/app-store/apps/1234567890/product`]: json(409, {
            error: {
              code,
              message:
                code === "app_assigned_elsewhere"
                  ? "appleId 1234567890 is already pinned to product acme; release it there first"
                  : "the product's own credential oc_1 belongs to another App Store account",
            },
          }),
        }),
      });
      await storesPage();
      await appsTable();
      await openRowMenu("Godot Demo");
      await userEvent.click(
        await screen.findByRole("menuitem", { name: "Assign to product…" }),
      );
      const dialog = await screen.findByRole("alertdialog");
      await userEvent.click(within(dialog).getByRole("combobox"));
      await userEvent.click(
        await screen.findByRole("option", { name: "DJDL" }),
      );
      await userEvent.click(
        within(screen.getByRole("alertdialog")).getByRole("button", {
          name: "Assign app",
        }),
      );
      const alert = await within(screen.getByRole("alertdialog")).findByRole(
        "alert",
      );
      expect(alert.textContent).toContain(title);
      if (code === "app_assigned_elsewhere")
        expect(alert.textContent).toContain("Acme holds it");
      expect(alert.textContent).not.toContain(code);
    });
  }

  it("an app held through a product's own key can only go to that product", async () => {
    boot(`#/platform/store-connections`, { extra: routes() });
    await storesPage();
    await appsTable();
    await openRowMenu("DJ Tool");
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Assign to product…" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("combobox").textContent).toContain("DJDL");
    expect(dialog.textContent).toContain("Held through this product's own key");
  });

  it("Set up opens the holding product's storefront flow, scoped to the store (A-18j)", async () => {
    boot(`#/platform/store-connections`, {
      extra: routes({
        [BASE]: {
          ok: true,
          stores: STORES.map((s) =>
            s.store === "app-store" ? { ...s, storefront: true } : s,
          ),
        },
      }),
    });
    await storesPage();
    await appsTable();
    await openRowMenu("Acme Game");
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Set up" }),
    );
    await waitFor(() =>
      expect(window.location.hash).toBe(
        "#/p/acme/distribution/storefronts?flow=add&stores=app-store&step=prerequisites",
      ),
    );
  });

  it("no Set up for a store without a storefront adapter", async () => {
    boot(`#/platform/store-connections`, { extra: routes() });
    await storesPage();
    await appsTable();
    await openRowMenu("Acme Game");
    await screen.findByRole("menuitem", { name: "Release from Acme" });
    expect(screen.queryByRole("menuitem", { name: "Set up" })).toBeNull();
  });

  it("releases behind the L1 caution confirm", async () => {
    expect(confirmFor("storeApp.release").level).toBe(1);
    const log = boot(`#/platform/store-connections`, { extra: routes() });
    await storesPage();
    await appsTable();
    await openRowMenu("Acme Game");
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Release from Acme" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("pin_missing");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Release app" }),
    );
    await waitFor(() =>
      expect(
        log.calls.some(
          (c) =>
            c.method === "DELETE" &&
            c.path === `${BASE}/app-store/apps/2222222222/product`,
        ),
      ).toBe(true),
    );
    expect(
      await within(main()).findByText(/Released Acme Game from acme/),
    ).toBeTruthy();
  });
});

describe("Store connections: states", () => {
  it("shows a loading state", async () => {
    boot(`#/platform/store-connections`, {
      extra: routes({ [BASE]: PENDING }),
    });
    const page = await storesPage();
    expect(within(page).queryByRole("table")).toBeNull();
    expect(page.querySelector(".pk-skeleton")).not.toBeNull();
  });

  it("shows an error state with Retry", async () => {
    boot(`#/platform/store-connections`, {
      extra: routes({ [BASE]: json(500, { error: { code: "internal" } }) }),
    });
    const page = await storesPage();
    expect(
      await within(page).findByRole("button", { name: /Retry|Try again/ }),
    ).toBeTruthy();
  });

  it("shows an empty state when the team credential sees no apps", async () => {
    boot(`#/platform/store-connections?store=microsoft-store`, {
      extra: routes(),
    });
    const page = await storesPage();
    expect(
      await within(page).findByText("The team credential sees no apps"),
    ).toBeTruthy();
  });

  it("passes axe", async () => {
    boot(`#/platform/store-connections`, { extra: routes() });
    const page = await storesPage();
    const table = await appsTable();
    await within(table).findByText("Godot Demo");
    const results = await axe(page);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

// ── UX-69: the connect form, checked on paste ────────────────────────────────────────────────

const STEAM_CHECK = `${BASE}/steam/credentials/publisher-key/check`;
const STEAM_PUT = `${BASE}/steam/credentials/publisher-key`;
const STEAM_KEY = "0123456789ABCDEF0123456789ABCDEF";

function check(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    id: "steam.publisher-key",
    check: {
      verdict: "valid",
      reason: "ok",
      title: "Publisher key · 2 apps",
      detail: null,
      facts: [
        { label: "Apps", value: "2" },
        { label: "First apps", value: "Dice" },
      ],
      ...over,
    },
  };
}

async function steamForm(): Promise<HTMLElement> {
  const page = await storesPage();
  return within(page).findByRole("form", {
    name: "Connect Steamworks Web API publisher key (group)",
  });
}

async function pasteKey(form: HTMLElement, value = STEAM_KEY): Promise<void> {
  const field = within(form).getByLabelText(/Publisher Web API key/);
  await userEvent.click(field);
  await userEvent.paste(value);
}

describe("Store connections: connect, checked on paste (UX-69)", () => {
  it("checks the key the moment it is pasted, shows what the store found, then saves", async () => {
    const log = boot(`#/platform/store-connections?store=steam`, {
      extra: routes({
        [`POST ${STEAM_CHECK}`]: check(),
        [`PUT ${STEAM_PUT}`]: {
          ok: true,
          id: "steam.publisher-key",
          source: "console",
          meta: {},
        },
      }),
    });
    const form = await steamForm();
    const save = within(form).getByRole("button", { name: "Save key" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await pasteKey(form);
    expect(
      await within(form).findByText("Publisher key · 2 apps"),
    ).toBeTruthy();
    expect(within(form).getByText("Dice")).toBeTruthy();
    const sent = log.calls.filter((c) => c.path === STEAM_CHECK);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe("POST");
    expect(sent[0]!.json).toEqual({ value: { key: STEAM_KEY } });
    await waitFor(() =>
      expect((save as HTMLButtonElement).disabled).toBe(false),
    );
    await userEvent.click(save);
    await waitFor(() =>
      expect(
        log.calls.some((c) => c.method === "PUT" && c.path === STEAM_PUT),
      ).toBe(true),
    );
    const put = log.calls.find((c) => c.method === "PUT")!;
    expect(put.json).toEqual({ value: { key: STEAM_KEY } });
  });

  it("never saves a refused key: the reason and the fix are shown, Save stays off", async () => {
    const log = boot(`#/platform/store-connections?store=steam`, {
      extra: routes({
        [`POST ${STEAM_CHECK}`]: check({
          verdict: "invalid",
          reason: "rejected",
          title: "Steam did not accept this as a publisher Web API key",
          detail: "Use the key from Steamworks → Users & Permissions.",
          facts: [],
          status: 403,
        }),
      }),
    });
    const form = await steamForm();
    await pasteKey(form);
    expect(
      await within(form).findByText(
        "Steam did not accept this as a publisher Web API key",
      ),
    ).toBeTruthy();
    expect(
      within(form).getByText(
        "Use the key from Steamworks → Users & Permissions.",
      ),
    ).toBeTruthy();
    const save = within(form).getByRole("button", { name: "Save key" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(save);
    expect(log.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("an edit after a pass takes the pass away until it is checked again", async () => {
    boot(`#/platform/store-connections?store=steam`, {
      extra: routes({ [`POST ${STEAM_CHECK}`]: check() }),
    });
    const form = await steamForm();
    await pasteKey(form);
    await within(form).findByText("Publisher key · 2 apps");
    const save = within(form).getByRole("button", { name: "Save key" });
    await waitFor(() =>
      expect((save as HTMLButtonElement).disabled).toBe(false),
    );
    await userEvent.type(
      within(form).getByLabelText(/Publisher Web API key/),
      "0",
    );
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(within(form).getByText(/Changed since the last check/)).toBeTruthy();
  });

  it("shows a warning (another team) and still lets it be saved", async () => {
    boot(`#/platform/store-connections?store=steam`, {
      extra: routes({
        [`POST ${STEAM_CHECK}`]: check({
          verdict: "warning",
          reason: "wrong-account",
          title: "This key cannot see an app a product is assigned: 480",
          detail: "It may belong to another team or account.",
        }),
      }),
    });
    const form = await steamForm();
    await pasteKey(form);
    const callout = await within(form).findByText(
      "This key cannot see an app a product is assigned: 480",
    );
    expect(callout.closest("[data-tone]")?.getAttribute("data-tone")).toBe(
      "warning",
    );
    // A warning saves, but never looks like a pass: "Save anyway", described by the reason.
    const save = await within(form).findByRole("button", {
      name: "Save anyway",
    });
    await waitFor(() =>
      expect((save as HTMLButtonElement).disabled).toBe(false),
    );
    expect(save.getAttribute("data-variant")).toBe("outline");
    const described = save.getAttribute("aria-describedby")!;
    expect(document.getElementById(described)?.textContent).toContain(
      "It may belong to another team or account.",
    );
    expect(within(form).queryByRole("button", { name: "Save key" })).toBeNull();
  });

  it("a refused field is marked on that field (Partner Center's expired secret)", async () => {
    const base = `${BASE}/microsoft-store/credentials/partner-center`;
    boot(`#/platform/store-connections?store=microsoft-store`, {
      extra: routes({
        [`POST ${base}/check`]: {
          ok: true,
          id: "microsoft-store.partner-center",
          check: {
            verdict: "invalid",
            reason: "expired",
            title: "This client secret has expired",
            detail: "Create a new client secret.",
            facts: [],
            field: "value.clientSecret",
          },
        },
      }),
    });
    const page = await storesPage();
    const creds = await within(page).findByRole("region", {
      name: "Credentials",
    });
    await userEvent.click(
      within(creds).getByRole("button", { name: "Replace key" }),
    );
    const form = within(creds).getByRole("form", {
      name: /Connect Partner Center app/,
    });
    await userEvent.type(within(form).getByLabelText(/Tenant ID/), "t");
    await userEvent.type(within(form).getByLabelText(/Client ID/), "c");
    await userEvent.type(within(form).getByLabelText(/Seller ID/), "s");
    await pasteKeyInto(form, /Client secret/, "secret-value");
    const secret = within(form).getByLabelText(/Client secret/);
    await waitFor(() =>
      expect(secret.getAttribute("aria-invalid")).toBe("true"),
    );
    // The callout carries the reason; the field only points to it (announced once).
    expect(
      within(form).getAllByText("This client secret has expired"),
    ).toHaveLength(1);
    expect(
      within(form).getByText("Refused: see the check below."),
    ).toBeTruthy();
  });

  it("a .p8 file fills the key and its Key ID from the file name", async () => {
    const log = boot(`#/platform/store-connections`, {
      extra: routes({
        [`POST ${BASE}/app-store/credentials/api-key/check`]: {
          ok: true,
          id: "app-store.api-key",
          check: {
            verdict: "valid",
            reason: "ok",
            title: "Team 69a6de7f · 2 apps",
            detail: null,
            facts: [],
          },
        },
      }),
    });
    const page = await storesPage();
    const creds = await within(page).findByRole("region", {
      name: "Credentials",
    });
    await userEvent.click(
      within(creds).getAllByRole("button", { name: "Replace key" })[0]!,
    );
    const form = within(creds).getByRole("form", {
      name: /Connect App Store Connect API key/,
    });
    await userEvent.type(
      within(form).getByLabelText(/Issuer ID/),
      "69a6de7f-1111",
    );
    const file = new File(
      ["-----BEGIN PRIVATE KEY-----\nMIGT\n-----END PRIVATE KEY-----\n"],
      "AuthKey_ABC123DEFG.p8",
      { type: "application/octet-stream" },
    );
    const input = form.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, file);
    await within(form).findByText("Team 69a6de7f · 2 apps");
    const sent = log.calls.find((c) => c.path.endsWith("/api-key/check"))!;
    expect(sent.json).toEqual({
      value: {
        keyId: "ABC123DEFG",
        issuerId: "69a6de7f-1111",
        p8: "-----BEGIN PRIVATE KEY-----\nMIGT\n-----END PRIVATE KEY-----\n",
      },
    });
  });

  it("the connect form passes axe", async () => {
    boot(`#/platform/store-connections?store=steam`, {
      extra: routes({ [`POST ${STEAM_CHECK}`]: check() }),
    });
    const form = await steamForm();
    await pasteKey(form);
    await within(form).findByText("Publisher key · 2 apps");
    const results = await axe(main());
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

async function pasteKeyInto(
  form: HTMLElement,
  label: RegExp,
  value: string,
): Promise<void> {
  await userEvent.click(within(form).getByLabelText(label));
  await userEvent.paste(value);
}
