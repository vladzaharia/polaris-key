import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { PENDING, boot, resetConsole } from "./consoleHarness.js";

/**
 * The Platform section (notes/S-13 §9.1, owner decision 3 of 2026-10-04): a sidebar group, the
 * redirects of the pages still to come, the Deployment page (A-11), platform activity (A-12) and
 * the account menu's version chip.
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
    "/manage/api/platform/activity": ACTIVITY,
    ...over,
  };
}

async function deploymentPage(): Promise<HTMLElement> {
  await screen.findByRole("heading", { level: 1, name: "Deployment" });
  return main();
}

describe("the Platform section in the sidebar", () => {
  it("is a group with no header icon whose items each carry one, shown off a product", async () => {
    boot("#/", { extra: platformRoutes() });
    await screen.findByRole("heading", { level: 1, name: "Home" });
    const header = within(nav()).getByRole("button", { name: "Platform" });
    expect(header.getAttribute("data-section-header")).toBe("platform");
    expect(
      [...header.querySelectorAll("svg")].filter(
        (svg) => !svg.hasAttribute("data-disclosure"),
      ),
    ).toEqual([]);
    // Not the active section on Home: collapsed until peeked into.
    expect(header.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(header);
    const deployment = within(nav()).getByRole("link", { name: "Deployment" });
    expect(deployment.getAttribute("href")).toBe("#/platform/deployment");
    expect(deployment.querySelector("svg[data-nav-icon]")).not.toBeNull();
    // Pages still to come are not listed: they would only redirect.
    for (const name of ["Settings", "Store connections", "Package feeds"]) {
      expect(
        within(nav())
          .queryAllByRole("link", { name })
          .filter((a) => a.getAttribute("href")?.startsWith("#/platform")),
      ).toEqual([]);
    }
  });

  it("is the open section on a Platform page, and shown beside a product's sections", async () => {
    boot("#/platform/deployment", { extra: platformRoutes() });
    await deploymentPage();
    expect(
      within(nav())
        .getByRole("button", { name: "Platform" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      within(nav())
        .getByRole("link", { name: "Deployment" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(document.title).toBe("Deployment · Polaris Key");
  });
});

describe("Platform URLs", () => {
  it("#/platform goes to Settings, which goes to Deployment until it is built", async () => {
    boot("#/platform", { extra: platformRoutes() });
    await deploymentPage();
    await waitFor(() =>
      expect(window.location.hash).toBe("#/platform/deployment"),
    );
  });

  for (const path of ["settings", "store-connections", "feeds"]) {
    it(`#/platform/${path} redirects to Deployment`, async () => {
      boot(`#/platform/${path}`, { extra: platformRoutes() });
      await deploymentPage();
      await waitFor(() =>
        expect(window.location.hash).toBe("#/platform/deployment"),
      );
    });
  }
});

describe("Deployment", () => {
  it("shows the running build, the environment and the database state", async () => {
    boot("#/platform/deployment", { extra: platformRoutes() });
    const page = await deploymentPage();
    const build = await within(page).findByRole("region", {
      name: "Current build",
    });
    expect(within(build).getByText("v0.8.6")).toBeTruthy();
    expect(within(build).getByText("4")).toBeTruthy();
    expect(within(build).getByText("v2")).toBeTruthy();
    expect(within(page).getAllByText("Production").length).toBeGreaterThan(0);
    expect(within(page).getAllByText("Up to date").length).toBeGreaterThan(0);
    expect(within(page).getByText("4 of 4")).toBeTruthy();
    // Nothing needs attention on a healthy deployment.
    expect(
      within(page).queryByRole("region", { name: "Needs attention" }),
    ).toBeNull();
  });

  it("lists the deploy history and loads older deploys with the keyset cursor", async () => {
    const log = boot("#/platform/deployment", { extra: platformRoutes() });
    const page = await deploymentPage();
    const history = await within(page).findByRole("region", {
      name: "Deploy history",
    });
    await waitFor(() =>
      expect(within(history).getAllByText("Passed")).toHaveLength(2),
    );
    expect(
      within(history)
        .getAllByRole("link", { name: /View run/ })[0]!
        .getAttribute("href"),
    ).toBe("https://github.com/acme/pk/actions/runs/0");
    await userEvent.click(
      within(history).getByRole("button", { name: /Load more/ }),
    );
    expect(await within(history).findByText("Failed")).toBeTruthy();
    const page2 = log.calls.find(
      (c) =>
        c.path === "/manage/api/platform/deployment" &&
        c.query.includes("beforeId=run-1"),
    );
    expect(page2?.query).toBe("beforeAt=1789996400&beforeId=run-1");
  });

  it("flags migrations behind, missing indexes and absent bindings", async () => {
    boot("#/platform/deployment", {
      extra: platformRoutes({
        "/manage/api/platform/deployment": deployment({
          migrations: {
            latest: "0054_b_platform_audit.sql",
            applied: [{ name: "0053_x.sql", appliedAt: null }],
            upToDate: false,
          },
          indexes: { missing: ["idx_a"] },
          bindings: { DB: true, BLOBS: false },
        }),
      }),
    });
    const page = await deploymentPage();
    const list = await within(page).findByRole("region", {
      name: "Needs attention",
    });
    expect(
      within(list).getByText(/has not applied 0054_b_platform_audit/),
    ).toBeTruthy();
    expect(within(list).getByText(/1 missing: idx_a/)).toBeTruthy();
    expect(within(list).getByText(/Not bound: BLOBS/)).toBeTruthy();
  });

  it("says the migration state is unknown when the table cannot be read", async () => {
    boot("#/platform/deployment", {
      extra: platformRoutes({
        "/manage/api/platform/deployment": deployment({
          migrations: {
            latest: "0054_b_platform_audit.sql",
            applied: null,
            upToDate: null,
          },
          indexes: { missing: null },
        }),
      }),
    });
    const page = await deploymentPage();
    expect(
      await within(page).findByText(
        "The database's migration table could not be read.",
      ),
    ).toBeTruthy();
    expect(within(page).getByText("Could not be checked")).toBeTruthy();
  });

  it("explains an empty deploy history", async () => {
    boot("#/platform/deployment", {
      extra: platformRoutes({
        "/manage/api/platform/deployment": deployment({
          deploys: { items: [], nextCursor: null },
        }),
      }),
    });
    const page = await deploymentPage();
    expect(await within(page).findByText("No deploys recorded")).toBeTruthy();
  });

  it("shows loading tiles, then a retryable error when the deployment cannot load", async () => {
    boot("#/platform/deployment", {
      extra: platformRoutes({ "/manage/api/platform/deployment": PENDING }),
    });
    const page = await deploymentPage();
    expect(within(page).getByText("Loading Release")).toBeTruthy();
    cleanup();
    vi.unstubAllGlobals();
    resetConsole();
    boot("#/platform/deployment", {
      extra: platformRoutes({
        "/manage/api/platform/deployment": new Response("{}", { status: 500 }),
      }),
    });
    const failed = await deploymentPage();
    const alert = await within(failed).findByRole("alert");
    expect(within(alert).getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("lists platform activity, newest first, with who did it", async () => {
    boot("#/platform/deployment", { extra: platformRoutes() });
    const page = await deploymentPage();
    const panel = await within(page).findByRole("region", {
      name: "Platform activity",
    });
    expect(await within(panel).findByText("Ada Lovelace")).toBeTruthy();
    expect(within(panel).getByText(/re-sealed values under KEK/)).toBeTruthy();
    expect(within(panel).getByText("kek-2")).toBeTruthy();
  });

  it("explains an empty platform activity log", async () => {
    boot("#/platform/deployment", {
      extra: platformRoutes({
        "/manage/api/platform/activity": { items: [], nextCursor: null },
      }),
    });
    const page = await deploymentPage();
    expect(
      await within(page).findByText("No platform activity yet"),
    ).toBeTruthy();
  });

  it("passes axe", async () => {
    boot("#/platform/deployment", { extra: platformRoutes() });
    const page = await deploymentPage();
    await within(page).findByText("Ada Lovelace");
    await waitFor(() =>
      expect(within(page).getAllByText("Passed")).toHaveLength(2),
    );
    const results = await axe(page);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("the version chip", () => {
  it("names the build in the account menu and links to Deployment", async () => {
    boot("#/", { extra: platformRoutes() });
    await screen.findByRole("heading", { level: 1, name: "Home" });
    await userEvent.click(screen.getByRole("button", { name: "Account menu" }));
    const chip = await screen.findByRole("menuitem", { name: /Version/ });
    expect(chip.textContent).toContain("v0.8.6 · prod");
    expect(chip.getAttribute("href")).toBe("#/platform/deployment");
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

// ── Operations (4P-3, over A-14) ──────────────────────────────────────────────────

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

async function operationsPage(): Promise<HTMLElement> {
  await screen.findByRole("heading", { level: 1, name: "Operations" });
  return main();
}

describe("Operations", () => {
  const route = (over: Record<string, unknown> = {}) =>
    platformRoutes({ "/manage/api/platform/operations": operations(over) });

  it("is in the sidebar and opens at its own URL", async () => {
    boot("#/platform/operations", { extra: route() });
    await operationsPage();
    expect(window.location.hash).toBe("#/platform/operations");
    expect(
      within(nav())
        .getByRole("link", { name: "Operations" })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(document.title).toBe("Operations · Polaris Key");
  });

  it("reads Healthy when every check passes, with the figures in tiles", async () => {
    boot("#/platform/operations", { extra: route() });
    const page = await operationsPage();
    await within(page).findByText("Every check passed");
    expect(within(page).getAllByText("Healthy").length).toBeGreaterThan(0);
    expect(within(page).queryByText("Needs attention")).toBeNull();
    expect(within(page).getAllByText("12.4 MB").length).toBeGreaterThan(0);
    expect(within(page).getAllByText("5 GB").length).toBeGreaterThan(0);
    expect(within(page).getByText("0 in the dead-letter queue")).toBeTruthy();
  });

  it("shows the latest run's steps and the recent history", async () => {
    boot("#/platform/operations", { extra: route() });
    const page = await operationsPage();
    await within(page).findByRole("heading", { name: "Nightly maintenance" });
    expect(within(page).getByText("retention")).toBeTruthy();
    expect(within(page).getByText("audit:*")).toBeTruthy();
    expect(within(page).getByText("Daily at 03:17 UTC")).toBeTruthy();
    expect(within(page).getByText("Recent runs")).toBeTruthy();
    expect(within(page).getAllByText("850 ms").length).toBeGreaterThan(0);
  });

  it("is Degraded with a failed step's error, and Failed when a core binding does not answer", async () => {
    const failedRun = {
      ...operations().jobs.latest.maintenance,
      outcome: "failed",
      steps: [step("retention", { outcome: "failed", error: "D1 busy" })],
    };
    boot("#/platform/operations", {
      extra: route({
        jobs: {
          ...operations().jobs,
          latest: { ...operations().jobs.latest, maintenance: failedRun },
        },
      }),
    });
    let page = await operationsPage();
    await within(page).findByText("Needs attention");
    expect(within(page).getAllByText("Degraded").length).toBeGreaterThan(0);
    expect(within(page).getByText("D1 busy")).toBeTruthy();
    cleanup();
    boot("#/platform/operations", {
      extra: route({
        probes: {
          ...operations().probes,
          d1: { bound: true, ok: false, latencyMs: 3000, error: "no answer" },
        },
      }),
    });
    page = await operationsPage();
    await within(page).findByText("D1 database");
    expect(within(page).getAllByText("Failed").length).toBeGreaterThan(0);
  });

  it("flags a dead-letter backlog, missing indexes and a stalled consumer", async () => {
    const o = operations();
    boot("#/platform/operations", {
      extra: route({
        queues: {
          ...o.queues,
          deadLetter: { ...o.queues.deadLetter, backlogCount: 2 },
        },
        indexes: { missing: ["idx_blob_objects_kind"] },
        heartbeats: [
          { ...o.heartbeats[0] },
          { ...o.heartbeats[1], at: GENERATED - 2 * 3600 },
        ],
      }),
    });
    const page = await operationsPage();
    await within(page).findByText("Needs attention");
    expect(
      within(page).getAllByText("Dead-letter queue").length,
    ).toBeGreaterThan(0);
    expect(
      within(page).getAllByText("idx_blob_objects_kind").length,
    ).toBeGreaterThan(0);
    expect(within(page).getByText("Stalled")).toBeTruthy();
  });

  it("calls an idle consumer healthy however old its heartbeat is", async () => {
    const o = operations();
    boot("#/platform/operations", {
      extra: route({
        queues: {
          ...o.queues,
          deltas: { ...o.queues.deltas, backlogCount: 0 },
        },
        heartbeats: [
          { ...o.heartbeats[0] },
          { ...o.heartbeats[1], at: GENERATED - 5 * 86400 },
        ],
      }),
    });
    const page = await operationsPage();
    await within(page).findByText("Lazy-delta consumer");
    expect(within(page).getByText("Idle")).toBeTruthy();
    expect(within(page).queryByText("Needs attention")).toBeNull();
  });

  it("marks a section the Worker could not read as unavailable, never healthy", async () => {
    boot("#/platform/operations", {
      extra: route({ jobs: null, connectors: null, heartbeats: null }),
    });
    const page = await operationsPage();
    await within(page).findByText("Needs attention");
    expect(
      within(page).getAllByText(/run history could not be read/).length,
    ).toBeGreaterThan(0);
    expect(within(page).getAllByText("Unavailable").length).toBeGreaterThan(0);
  });

  it("lists connectors, with an unused one as not configured", async () => {
    boot("#/platform/operations", { extra: route() });
    const page = await operationsPage();
    await within(page).findByText("App Store Connect");
    expect(within(page).getByText("Google Play")).toBeTruthy();
    expect(within(page).getByText("Not configured")).toBeTruthy();
  });

  it("has no analytics panel", async () => {
    boot("#/platform/operations", { extra: route() });
    const page = await operationsPage();
    await within(page).findByRole("heading", { name: "Store connectors" });
    expect(within(page).queryByText(/analytics/i)).toBeNull();
  });

  it("pauses and resumes auto-refresh, and remembers the choice", async () => {
    boot("#/platform/operations", { extra: route() });
    const page = await operationsPage();
    const sw = await within(page).findByRole("switch", {
      name: "Refresh every 30 s",
    });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await userEvent.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(
      window.localStorage.getItem("pk-admin-operations-auto-refresh"),
    ).toBe("false");
    window.localStorage.removeItem("pk-admin-operations-auto-refresh");
  });

  it("refetches on Refresh", async () => {
    let calls = 0;
    boot("#/platform/operations", {
      extra: platformRoutes({
        "/manage/api/platform/operations": () => {
          calls += 1;
          return operations();
        },
      }),
    });
    const page = await operationsPage();
    await within(page).findByRole("heading", { name: "Nightly maintenance" });
    const before = calls;
    await userEvent.click(
      within(page).getByRole("button", { name: /refresh/i }),
    );
    await waitFor(() => expect(calls).toBeGreaterThan(before));
  });

  it("shows a retryable error when the snapshot cannot load", async () => {
    boot("#/platform/operations", {
      extra: platformRoutes({
        "/manage/api/platform/operations": new Response("{}", { status: 500 }),
      }),
    });
    const page = await operationsPage();
    expect(
      await within(page).findByRole("button", { name: "Retry" }),
    ).toBeTruthy();
  });

  it("passes axe", async () => {
    boot("#/platform/operations", { extra: route() });
    const page = await operationsPage();
    await within(page).findByRole("heading", { name: "Nightly maintenance" });
    const results = await axe(page);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
