import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { ALL_ON, PENDING, boot, resetConsole } from "./consoleHarness.js";

/**
 * The Platform section (notes/S-13 §9.1, owner decision 3 of 2026-10-04): a sidebar group, the
 * redirects of the pages still to come, the Status page (A-11, A-14), platform activity (A-12) and
 * the account menu's version chip. Settings (4P-1) has its own suite, `platformSettings.test.tsx`.
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

const SHA = "0123456789abcdef0123456789abcdef01234567";

const IDENTITY = {
  releaseTag: "v0.8.6",
  gitSha: SHA,
  cloudflare: {
    id: "cf-version-1234567890",
    tag: "v0.8.6",
    uploadedAt: "2026-10-03T12:00:00Z",
  },
  protocolVersion: 4,
  discoveryVersion: 2,
  latestMigration: "0054_b_platform_audit.sql",
  environment: "prod",
};

function deploy(i: number, smoke = "success") {
  return {
    id: `run-${i}`,
    at: 1_790_000_000 - i * 3600,
    environment: "prod",
    tag: `v0.8.${6 - i}`,
    gitSha: SHA,
    runUrl: `https://github.com/acme/pk/actions/runs/${i}`,
    scripts: ["polaris-key", "polaris-key-deltas"],
    latestMigration: "0054_b_platform_audit.sql",
    cloudflareVersionId: "cf",
    deltasVersionId: "cf2",
    smoke,
  };
}

function deployment(over: Record<string, unknown> = {}) {
  return {
    current: IDENTITY,
    deploys: {
      items: [deploy(0), deploy(1)],
      nextCursor: { beforeAt: 1_789_996_400, beforeId: "run-1" },
    },
    migrations: {
      latest: "0054_b_platform_audit.sql",
      applied: [
        { name: "0053_x.sql", appliedAt: "2026-09-01 10:00:00" },
        { name: "0054_b_platform_audit.sql", appliedAt: "2026-10-01 10:00:00" },
      ],
      upToDate: true,
    },
    indexes: { missing: [] },
    bindings: { DB: true, HOT: true, BLOBS: true, CF_VERSION_METADATA: true },
    ...over,
  };
}

const ACTIVITY = {
  items: [
    {
      id: "pa1",
      at: 1_790_000_000,
      actor: { sub: "u1", name: "Ada Lovelace", email: "ada@x.io" },
      action: "kek.reseal",
      target: { kind: "kek", id: "kek-2" },
      summary: "Re-sealed 12 value(s) under KEK kek-2 (0 remaining)",
      before: null,
      after: null,
    },
  ],
  nextCursor: null,
};

function platformRoutes(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    "/manage/api/platform/version": IDENTITY,
    "/manage/api/platform/deployment": (q: URLSearchParams) =>
      q.get("beforeId")
        ? {
            ...deployment(),
            deploys: { items: [deploy(2, "failure")], nextCursor: null },
          }
        : deployment(),
    "/manage/api/platform/operations": operations(),
    "/manage/api/platform/activity": ACTIVITY,
    "/manage/api/platform/settings": {
      settings: [],
      storeAvailable: true,
      propagationSeconds: 30,
      deployTime: [],
      secrets: [],
      constants: [],
      warnings: [],
    },
    "/manage/api/products/kek": {
      ok: true,
      active: "kek-1",
      kids: ["kek-1"],
      counts: {},
      remaining: 0,
      unopenable: 0,
      countsComplete: true,
      countsTruncated: [],
    },
    ...over,
  };
}

async function statusPage(): Promise<HTMLElement> {
  await screen.findByRole("heading", { level: 1, name: "Status" });
  return main();
}

describe("the Platform context in the sidebar (ST-45)", () => {
  it("lists Home and the Platform pages, each with an icon, off a product", async () => {
    boot("#/", { extra: platformRoutes() });
    await screen.findByRole("heading", { level: 1, name: "Home" });
    // No group header and no disclosure: the pages are the list.
    expect(nav().querySelector("[data-section-header]")).toBeNull();
    const status = within(nav()).getByRole("link", { name: "Status" });
    expect(status.getAttribute("href")).toBe("#/platform/status");
    expect(status.querySelector("svg[data-nav-icon]")).not.toBeNull();
    // CX-PSTAT: Deployment and Operations are one page now.
    expect(
      within(nav()).queryByRole("link", { name: "Deployment" }),
    ).toBeNull();
    expect(
      within(nav()).queryByRole("link", { name: "Operations" }),
    ).toBeNull();
    const settings = within(nav()).getByRole("link", { name: "Settings" });
    expect(settings.getAttribute("href")).toBe("#/platform/settings");
    // F-11 built Package feeds: every Platform page is listed, each with its icon.
    const feeds = within(nav()).getByRole("link", { name: "Package feeds" });
    expect(feeds.getAttribute("href")).toBe("#/platform/feeds");
    expect(feeds.querySelector("svg[data-nav-icon]")).not.toBeNull();
  });

  it("marks the current Platform page", async () => {
    boot("#/platform/status", { extra: platformRoutes() });
    await statusPage();
    expect(
      within(nav())
        .getByRole("link", { name: "Status" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(document.title).toBe("Status · Polaris Key Console");
  });
});

describe("the Platform pages inside a product", () => {
  it("never appear in the sidebar; the switcher, the version chip and ⌘K reach them", async () => {
    boot("#/p/djdl", { services: ALL_ON, extra: platformRoutes() });
    await screen.findByRole("heading", { level: 1, name: "DJDL" });
    expect(nav().getAttribute("data-context")).toBe("product");
    for (const name of ["Home", "Status", "API tokens"]) {
      expect(within(nav()).queryByRole("link", { name }), name).toBeNull();
    }
    expect(nav().querySelector("[data-section=platform]")).toBeNull();

    // The context card: Platform first (back to Home), the products, New product last.
    await userEvent.click(
      within(nav()).getByRole("button", { name: /^Product: DJDL \(djdl\)/ }),
    );
    const entry = await screen.findByRole("option", { name: /Platform/ });
    expect(entry).toBeTruthy();
    expect(screen.queryByText("All products")).toBeNull();
    expect(screen.getByRole("link", { name: "New product" })).toBeTruthy();
    await userEvent.keyboard("{Escape}");

    // The account menu's version chip goes to Status.
    await userEvent.click(screen.getByRole("button", { name: "Account menu" }));
    const chip = await screen.findByRole("menuitem", { name: /Version/ });
    expect(chip.getAttribute("href")).toBe("#/platform/status");
  });

  it("the context card on Home is Platform, and opens the same switcher", async () => {
    boot("#/", { extra: platformRoutes() });
    await screen.findByRole("heading", { level: 1, name: "Home" });
    const card = within(nav()).getByRole("button", {
      name: "Platform. Change product",
    });
    await userEvent.click(card);
    expect(await screen.findByRole("option", { name: /DJDL/ })).toBeTruthy();
  });
});

describe("Platform URLs", () => {
  it("#/platform goes to Settings", async () => {
    boot("#/platform", { extra: platformRoutes() });
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    await waitFor(() =>
      expect(window.location.hash).toBe("#/platform/settings"),
    );
  });
});

describe("Status", () => {
  const route = (over: Record<string, unknown> = {}) =>
    platformRoutes({ "/manage/api/platform/operations": operations(over) });
  const checks = (page: HTMLElement) =>
    within(page).findByRole("table", { name: /Checks/ });
  const rowOf = (table: HTMLElement, title: string) =>
    within(table).getByText(title).closest("tr")!;

  it("leads with a Check, Result, Next action table; healthy checks say None", async () => {
    boot("#/platform/status", { extra: route() });
    const page = await statusPage();
    await within(page).findByText(/Live since/);
    const table = await checks(page);
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Check", "Result", "Next action"]);
    for (const title of [
      "Worker deployment",
      "Storage bindings",
      "Recent automation",
    ])
      await waitFor(() =>
        expect(within(rowOf(table, title)).getByText("None")).toBeTruthy(),
      );
    expect(within(table).getByText("All 4 present")).toBeTruthy();
    expect(within(table).getByText(/v0\.8\.6/)).toBeTruthy();
    // The Checks card comes first, then the cards in the mockup's order.
    expect(
      within(page)
        .getAllByRole("heading", { level: 2 })
        .map((h) => h.textContent)
        .slice(0, 7),
    ).toEqual([
      "Checks",
      "Health by area",
      "Scheduled jobs",
      "Queues",
      "Services",
      "Storage and schema",
      "Deploys",
    ]);
    expect(within(page).getAllByText("OK").length).toBeGreaterThan(0);
    expect(
      within(page).getByText("Logs never show tokens, keys or emails."),
    ).toBeTruthy();
  });

  it("says a webhook failure once in Checks, and draws no Retry or Purge the API cannot do", async () => {
    const o = operations();
    boot("#/platform/status", {
      extra: route({
        connectors: {
          ...o.connectors,
          items: [{ ...o.connectors.items[0], failedEvents24h: 12 }],
        },
      }),
    });
    const page = await statusPage();
    const table = await checks(page);
    const row = await waitFor(() => rowOf(table, "Recent automation"));
    await within(row).findByText(/12 webhook deliveries failed/);
    expect(
      within(row)
        .getByRole("link", { name: "Open Store connections" })
        .getAttribute("href"),
    ).toBe("#/platform/store-connections");
    expect(within(page).getByText("12 failed in the last day")).toBeTruthy();
    expect(
      within(page).queryByRole("button", { name: /retry|purge/i }),
    ).toBeNull();
  });

  it("draws one row per service with its products and last error", async () => {
    boot("#/platform/status", {
      extra: route({
        services: [
          { slug: "license", productsEnabled: 2, lastError: null },
          {
            slug: "release",
            productsEnabled: 1,
            lastError: {
              step: "release:acme",
              at: 1_700_000_000_000,
              error: "boom",
            },
          },
          { slug: "sync", productsEnabled: 0, lastError: null },
        ],
      }),
    });
    const page = await statusPage();
    const list = await within(page).findByRole("list", { name: "Services" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText("2 products")).toBeTruthy();
    expect(within(rows[1]!).getByText("Failed")).toBeTruthy();
    expect(within(rows[1]!).getByText(/1 product · boom/)).toBeTruthy();
    expect(within(rows[2]!).getByText("No products")).toBeTruthy();
  });

  it("flags migrations behind, missing indexes, absent bindings and a failed smoke check", async () => {
    boot("#/platform/status", {
      extra: platformRoutes({
        "/manage/api/platform/deployment": deployment({
          migrations: {
            latest: "0054_b_platform_audit.sql",
            applied: [{ name: "0053_x.sql", appliedAt: null }],
            upToDate: false,
          },
          indexes: { missing: ["idx_a"] },
          bindings: { DB: true, BLOBS: false },
          deploys: { items: [deploy(0, "failure")], nextCursor: null },
        }),
      }),
    });
    const page = await statusPage();
    const table = await checks(page);
    await within(table).findByText(
      /Migration 0054_b_platform_audit.sql not applied/,
    );
    expect(
      within(table).getByText("Smoke check failed after the deploy"),
    ).toBeTruthy();
    expect(within(table).getByText(/Not bound: BLOBS/)).toBeTruthy();
    expect(within(table).getByText(/1 missing: idx_a/)).toBeTruthy();
    expect(
      within(table)
        .getByRole("link", { name: /View the deploy run/ })
        .getAttribute("href"),
    ).toBe("https://github.com/acme/pk/actions/runs/0");
    // Storage and schema says it too.
    expect(
      within(
        within(page).getByRole("region", { name: "Storage and schema" }),
      ).getByText(/not applied/),
    ).toBeTruthy();
  });

  it("marks a section the Worker could not read, never healthy", async () => {
    boot("#/platform/status", {
      extra: route({ jobs: null, connectors: null, heartbeats: null }),
    });
    const page = await statusPage();
    await within(await checks(page)).findByText(
      /run history could not be read/,
    );
    expect(within(page).getAllByText("Degraded").length).toBeGreaterThan(0);
  });

  it("is Failed when a core binding does not answer", async () => {
    const o = operations();
    boot("#/platform/status", {
      extra: route({
        probes: {
          ...o.probes,
          d1: { bound: true, ok: false, latencyMs: 3000, error: "no answer" },
        },
      }),
    });
    const page = await statusPage();
    await within(await checks(page)).findByText(
      /Did not answer its probe: no answer/,
    );
    expect(within(page).getByText("Failed")).toBeTruthy();
  });

  it("lists queues, scheduled jobs, storage and schema from the snapshot", async () => {
    boot("#/platform/status", { extra: route() });
    const page = await statusPage();
    const queues = await within(page).findByRole("region", { name: "Queues" });
    expect(
      within(queues).getByText("4 waiting", { exact: false }),
    ).toBeTruthy();
    expect(within(queues).getByText("Empty")).toBeTruthy();
    const jobs = within(page).getByRole("region", { name: "Scheduled jobs" });
    expect(within(jobs).getByText("Daily at 03:17 UTC")).toBeTruthy();
    expect(within(jobs).getByText(/Connector poll, 1 step/)).toBeTruthy();
    const storage = within(page).getByRole("region", {
      name: "Storage and schema",
    });
    expect(within(storage).getByText("12.4 MB")).toBeTruthy();
    expect(within(storage).getByText(/5 GB · 42 objects/)).toBeTruthy();
    expect(within(storage).getByText(/none pending/)).toBeTruthy();
    expect(within(storage).getByText("All required present")).toBeTruthy();
  });

  it("lists deploys and loads older ones with the keyset cursor", async () => {
    const log = boot("#/platform/status", { extra: route() });
    const page = await statusPage();
    const deploys = await within(page).findByRole("region", {
      name: "Deploys",
    });
    expect(await within(deploys).findByText("v0.8.6")).toBeTruthy();
    await userEvent.click(
      within(deploys).getByRole("button", { name: /Load more/ }),
    );
    expect(await within(deploys).findByText("Smoke check failed")).toBeTruthy();
    const page2 = log.calls.find(
      (c) =>
        c.path === "/manage/api/platform/deployment" &&
        c.query.includes("beforeId=run-1"),
    );
    expect(page2?.query).toBe("beforeAt=1789996400&beforeId=run-1");
  });

  it("explains an empty deploy history", async () => {
    boot("#/platform/status", {
      extra:
        route({}) &&
        platformRoutes({
          "/manage/api/platform/deployment": deployment({
            deploys: { items: [], nextCursor: null },
          }),
        }),
    });
    const page = await statusPage();
    expect(await within(page).findByText(/No deploys recorded/)).toBeTruthy();
  });

  it("shows a skeleton while loading, then a retryable row when a read fails", async () => {
    boot("#/platform/status", {
      extra:
        route({}) &&
        platformRoutes({ "/manage/api/platform/deployment": PENDING }),
    });
    await statusPage();
    cleanup();
    vi.unstubAllGlobals();
    resetConsole();
    boot("#/platform/status", {
      extra: platformRoutes({
        "/manage/api/platform/operations": new Response("{}", { status: 500 }),
      }),
    });
    const page = await statusPage();
    const table = await checks(page);
    const row = await waitFor(() => rowOf(table, "Recent automation"));
    await within(row).findByText("Could not be read");
    expect(within(row).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("shows one error when neither read loads", async () => {
    boot("#/platform/status", {
      extra: platformRoutes({
        "/manage/api/platform/deployment": new Response("{}", { status: 500 }),
        "/manage/api/platform/operations": new Response("{}", { status: 500 }),
      }),
    });
    const page = await statusPage();
    const alert = await within(page).findByRole("alert");
    expect(
      within(alert).getByRole("button", { name: "Try again" }),
    ).toBeTruthy();
  });

  it("pauses and resumes refreshing, remembers the choice, and shows one freshness line", async () => {
    boot("#/platform/status", { extra: route() });
    const page = await statusPage();
    const pause = await within(page).findByRole("button", {
      name: "Pause refreshing",
    });
    expect(within(page).getByText(/^Checked /)).toBeTruthy();
    expect(within(page).queryByRole("button", { name: "Refresh" })).toBeNull();
    await userEvent.click(pause);
    expect(
      window.localStorage.getItem("pk-admin-operations-auto-refresh"),
    ).toBe("false");
    expect(
      within(page).getByRole("button", { name: "Resume refreshing" }),
    ).toBeTruthy();
    expect(within(page).getByRole("button", { name: "Refresh" })).toBeTruthy();
    window.localStorage.removeItem("pk-admin-operations-auto-refresh");
  });

  it("refetches both reads on Refresh while paused", async () => {
    window.localStorage.setItem("pk-admin-operations-auto-refresh", "false");
    let calls = 0;
    boot("#/platform/status", {
      extra: platformRoutes({
        "/manage/api/platform/operations": () => {
          calls += 1;
          return operations();
        },
      }),
    });
    const page = await statusPage();
    await within(page).findByRole("region", { name: "Queues" });
    await waitFor(() => expect(calls).toBeGreaterThan(0));
    const before = calls;
    await userEvent.click(
      within(page).getByRole("button", { name: "Refresh" }),
    );
    await waitFor(() => expect(calls).toBeGreaterThan(before));
    window.localStorage.removeItem("pk-admin-operations-auto-refresh");
  });

  it("no longer carries the platform activity: it has its own page", async () => {
    boot("#/platform/status", { extra: route() });
    const page = await statusPage();
    await within(page).findByText(/Live since/);
    expect(
      within(page).queryByRole("region", { name: "Platform activity" }),
    ).toBeNull();
  });

  it("answers the old Deployment and Operations addresses with Page moved, not a redirect", async () => {
    for (const path of ["deployment", "operations"]) {
      boot(`#/platform/${path}`, { extra: route() });
      await screen.findByRole("heading", { level: 1, name: "Page moved" });
      expect(window.location.hash).toBe(`#/platform/${path}`);
      expect(
        within(main())
          .getByRole("link", { name: /Status/ })
          .getAttribute("href"),
      ).toBe("#/platform/status");
      cleanup();
      vi.unstubAllGlobals();
      resetConsole();
    }
  });

  it("passes axe", async () => {
    boot("#/platform/status", { extra: route() });
    const page = await statusPage();
    await within(page).findByText(/Live since/);
    const results = await axe(page);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("the version chip", () => {
  it("names the build in the account menu and links to Status", async () => {
    boot("#/", { extra: platformRoutes() });
    await screen.findByRole("heading", { level: 1, name: "Home" });
    await userEvent.click(screen.getByRole("button", { name: "Account menu" }));
    const chip = await screen.findByRole("menuitem", { name: /Version/ });
    expect(chip.textContent).toContain("v0.8.6 · prod");
    expect(chip.getAttribute("href")).toBe("#/platform/status");
  });

  it("is absent when the version cannot be read", async () => {
    boot("#/", {
      extra: platformRoutes({
        "/manage/api/platform/version": new Response("{}", { status: 403 }),
      }),
    });
    await screen.findByRole("heading", { level: 1, name: "Home" });
    await userEvent.click(screen.getByRole("button", { name: "Account menu" }));
    await screen.findByRole("menuitem", { name: /Sign out/ });
    expect(screen.queryByRole("menuitem", { name: /Version/ })).toBeNull();
  });
});

// ── Operations snapshot fixtures (4P-3, over A-14); the Status page reads them ──────────────────────────────────────────────────

const GENERATED = 1_790_000_000;

function step(name: string, over: Record<string, unknown> = {}) {
  return {
    step: name,
    startedAt: (GENERATED - 600) * 1000,
    durationMs: 850,
    outcome: "ok",
    items: 1,
    rowsAffected: 3,
    error: null,
    ...over,
  };
}

function operations(over: Record<string, unknown> = {}) {
  return {
    generatedAt: GENERATED,
    probes: {
      d1: { bound: true, ok: true, latencyMs: 12 },
      kv: { bound: true, ok: true, latencyMs: 20 },
      r2: { bound: true, ok: true, latencyMs: 31 },
      updateHealth: { bound: true },
      email: { bound: false },
    },
    queues: {
      deltas: {
        bound: true,
        ok: true,
        latencyMs: 5,
        backlogCount: 4,
        backlogBytes: 2048,
        oldestMessageAt: GENERATED - 120,
      },
      deadLetter: {
        bound: true,
        ok: true,
        latencyMs: 5,
        backlogCount: 0,
        backlogBytes: 0,
        oldestMessageAt: null,
      },
      consumer: {
        maxBatchSize: 1,
        maxBatchTimeoutSeconds: 5,
        maxRetries: 3,
        maxConcurrency: 1,
      },
    },
    heartbeats: [
      {
        script: "main",
        at: GENERATED - 300,
        versionTag: "v0.8.6",
        cloudflareVersionId: null,
        outcome: "connectorPoll:ok",
        backlogCount: null,
        backlogBytes: null,
        oldestMessageAt: null,
      },
      {
        script: "deltas",
        at: GENERATED - 60,
        versionTag: "v0.8.6",
        cloudflareVersionId: null,
        outcome: "ok",
        backlogCount: 4,
        backlogBytes: 2048,
        oldestMessageAt: GENERATED - 120,
      },
    ],
    jobs: {
      latest: {
        maintenance: {
          runId: "r1",
          job: "maintenance",
          cron: "17 3 * * *",
          startedAt: (GENERATED - 3600) * 1000,
          durationMs: 4200,
          outcome: "ok",
          steps: [step("retention"), step("audit:*")],
        },
        connectorPoll: {
          runId: "r2",
          job: "connectorPoll",
          cron: "*/15 * * * *",
          startedAt: (GENERATED - 600) * 1000,
          durationMs: 900,
          outcome: "ok",
          steps: [step("asc:poll")],
        },
      },
      recent: [
        {
          runId: "r2",
          job: "connectorPoll",
          cron: "*/15 * * * *",
          startedAt: (GENERATED - 600) * 1000,
          durationMs: 900,
          outcome: "ok",
          steps: 1,
        },
        {
          runId: "r1",
          job: "maintenance",
          cron: "17 3 * * *",
          startedAt: (GENERATED - 3600) * 1000,
          durationMs: 4200,
          outcome: "ok",
          steps: 2,
        },
      ],
      failures: [],
    },
    storage: {
      d1: { sizeBytes: 12_400_000 },
      r2: {
        committedBytes: 5_000_000_000,
        objects: 42,
        byKind: [
          { kind: "bundle", gated: false, bytes: 5_000_000_000, objects: 42 },
        ],
      },
    },
    indexes: { missing: [] },
    services: [
      { slug: "license", productsEnabled: 2, lastError: null },
      { slug: "release", productsEnabled: 1, lastError: null },
      { slug: "sync", productsEnabled: 0, lastError: null },
    ],
    connectors: {
      items: [
        {
          connector: "asc",
          productsConfigured: 2,
          objectsTracked: 7,
          lastPolledAt: GENERATED - 600,
          lastEventAt: null,
          failedEvents24h: 0,
        },
        {
          connector: "play",
          productsConfigured: 0,
          objectsTracked: 0,
          lastPolledAt: null,
          lastEventAt: null,
          failedEvents24h: 0,
        },
      ],
      lastPollFailure: null,
      commerce: { available: false },
    },
    recentErrors: {
      jobFailures: [],
      lazyDeltaRefusals: [
        { reason: "too_large", count: 3, lastAt: GENERATED - 90 },
      ],
    },
    ...over,
  };
}
