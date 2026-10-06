/**
 * U-03: Platform → Override migration, and the notice it puts on each affected product's
 * Licenses page. The page offers only the next step the Worker allows: flag the login card (I-07)
 * and the Library (I-11) live (each confirmed), start the 30-day notice once both are, run (typed,
 * after a fresh sign-in) once the notice has run, continue until every product is through, then
 * the report with its CSV. The dry run writes nothing and never carries a secret value.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import type {
  OverrideMigrationDryRun,
  OverrideMigrationState,
  OverrideMigrationStoredRow,
} from "../src/api.js";
import { boot, resetConsole, type FetchLog } from "./consoleHarness.js";
import { bootLicense } from "./licenseFixture.js";
import { migrationGates } from "../src/console/pages/platformOverrideMigration.js";
import { migrationNoticeText } from "../src/console/pages/license/OverrideMigrationNotice.js";
import { confirmFor } from "../src/lib/actions.js";
import { formatDate, fromSeconds } from "../src/lib/format.js";

const axe = configureAxe({
  rules: {
    "color-contrast": { enabled: false },
    region: { enabled: false },
  },
});

const NOW_S = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const BASE = "/manage/api/platform/override-migration";
const HASH = "#/platform/override-migration";

type Phase = OverrideMigrationState["phase"];

function stateOf(
  phase: Phase,
  over: {
    loginCard?: boolean;
    library?: boolean;
    runAllowed?: boolean;
    runNotBefore?: number | null;
  } = {},
): OverrideMigrationState {
  const flagged = phase !== "idle";
  const started = phase === "running" || phase === "completed";
  const runNotBefore =
    over.runNotBefore !== undefined
      ? over.runNotBefore
      : phase === "idle"
        ? null
        : NOW_S + 10 * DAY;
  return {
    phase,
    noticeDays: 30,
    reportDays: 90,
    prerequisites: {
      loginCard: {
        liveAt: (over.loginCard ?? flagged) ? NOW_S - 40 * DAY : null,
        by: (over.loginCard ?? flagged) ? "u1" : null,
      },
      library: {
        liveAt: (over.library ?? flagged) ? NOW_S - 40 * DAY : null,
        by: (over.library ?? flagged) ? "u1" : null,
      },
    },
    notice: {
      startedAt: phase === "idle" ? null : NOW_S - 20 * DAY,
      by: phase === "idle" ? null : "u1",
      runNotBefore,
      runAllowed: over.runAllowed ?? phase === "running",
    },
    run: {
      id: started ? "run_1" : null,
      startedAt: started ? NOW_S - DAY : null,
      by: started ? "u1" : null,
      completedAt: phase === "completed" ? NOW_S - 3600 : null,
      productsDone: started ? ["djdl"] : [],
      reportExpiresAt: phase === "completed" ? NOW_S + 89 * DAY : null,
      columnsEmptiedAt: null,
    },
    inventory: {
      computedAt: NOW_S - 3600,
      products: [
        {
          product: "djdl",
          licences: 3,
          owned: 1,
          dropped: 2,
          collapsingAccounts: 0,
        },
      ],
      totals: { licences: 3, owned: 1, dropped: 2 },
    },
  };
}

const DRY: OverrideMigrationDryRun = {
  computedAt: NOW_S,
  inventory: stateOf("notice").inventory!,
  report: [
    {
      product: "djdl",
      licenseId: "lic_1",
      outcome: "moved",
      subject: null,
      subjectCreatedAtRun: true,
      buyerEmail: "ada@x.io",
      keys: { config: ["feature.timeout"], secrets: ["api.token"] },
      values: {},
    },
    {
      product: "djdl",
      licenseId: "lic_2",
      outcome: "dropped",
      subject: null,
      buyerEmail: "lab@x.io",
      keys: { config: ["feature.timeout"], secrets: ["api.token"] },
      values: { config: { "feature.timeout": 30 } },
    },
  ],
};

const STORED: OverrideMigrationStoredRow[] = [
  {
    product: "djdl",
    runId: "run_1",
    licenseId: "lic_3",
    outcome: "collapsed",
    subject: "ps_AAAAAAAAAAAAAAAAAAAAAA",
    buyerEmail: "ada@x.io",
    keys: { config: ["feature.timeout"], secrets: [] },
    values: {
      collapsed: [
        {
          bucket: "config",
          key: "feature.timeout",
          keptFrom: "lic_1",
          kept: 60,
          lost: 30,
        },
      ],
    },
    createdAt: NOW_S - 3600,
    expiresAt: NOW_S + 89 * DAY,
  },
];

function bootPage(
  state: OverrideMigrationState,
  opts: { fresh?: boolean; routes?: Record<string, unknown> } = {},
): FetchLog {
  return boot(HASH, {
    me: {
      authAt: opts.fresh === false ? NOW_S - 3600 : NOW_S - 10,
      stepUpMaxAgeSeconds: 300,
    },
    extra: {
      [BASE]: { state },
      [`PUT ${BASE}/prerequisites`]: { state },
      [`POST ${BASE}/notice`]: { state: stateOf("notice") },
      [`DELETE ${BASE}/notice`]: { state: stateOf("idle") },
      [`POST ${BASE}/dry-run`]: DRY,
      [`POST ${BASE}/run`]: {
        progress: {
          runId: "run_1",
          done: false,
          completedAt: null,
          productsDone: ["djdl"],
          productsRemaining: ["acme"],
          written: { moved: 1, collapsed: 0, dropped: 2 },
        },
        state: stateOf("running"),
      },
      [`${BASE}/report`]: (q: URLSearchParams) =>
        q.get("format") === "csv"
          ? new Response("product,license\r\ndjdl,lic_3\r\n", {
              status: 200,
              headers: { "content-type": "text/csv" },
            })
          : { rows: STORED },
      ...opts.routes,
    },
  });
}

const writesTo = (log: FetchLog, path: string) =>
  log.calls.filter((c) => c.method !== "GET" && c.path === path);

const disabled = (el: HTMLElement) =>
  el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";

async function page(): Promise<HTMLElement> {
  await screen.findByRole("heading", { level: 1, name: "Override migration" });
  // The header draws at once; the sections once the state has loaded.
  await screen.findByRole("heading", { name: "Prerequisites" });
  return screen.getByRole("main");
}

beforeEach(resetConsole);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("migrationGates: what the page offers in each state", () => {
  it("idle: the notice waits for both prerequisites", () => {
    const none = migrationGates(stateOf("idle"));
    expect(none.missing).toEqual(["loginCard", "library"]);
    expect(none.startNotice).toEqual({
      visible: true,
      reason:
        "Flag the login card (I-07) and the Library (I-11) live in production first.",
    });
    expect(none.run.visible).toBe(false);
    expect(none.withdrawNotice.visible).toBe(false);
    expect(none.unflagLocked).toBeNull();
    expect(none.report).toBe(false);

    const one = migrationGates(stateOf("idle", { loginCard: true }));
    expect(one.startNotice.reason).toBe(
      "Flag the Library (I-11) live in production first.",
    );
    const both = migrationGates(
      stateOf("idle", { loginCard: true, library: true }),
    );
    expect(both.startNotice).toEqual({ visible: true, reason: null });
  });

  it("notice: withdraw, no unflagging, and the run waits for the window", () => {
    const waiting = migrationGates(stateOf("notice"));
    expect(waiting.startNotice.visible).toBe(false);
    expect(waiting.withdrawNotice.visible).toBe(true);
    expect(waiting.unflagLocked).toMatch(/Withdraw it before unflagging/);
    expect(waiting.run).toMatchObject({ visible: true, continuing: false });
    expect(waiting.run.reason).toBe(
      `The notice runs until ${formatDate(fromSeconds(NOW_S + 10 * DAY))}. The run can't start before.`,
    );
    const due = migrationGates(
      stateOf("notice", { runAllowed: true, runNotBefore: NOW_S - 60 }),
    );
    expect(due.run).toEqual({ visible: true, continuing: false, reason: null });
  });

  it("running: continue; completed: the report, and no run or dry run", () => {
    const running = migrationGates(stateOf("running"));
    expect(running.run).toEqual({
      visible: true,
      continuing: true,
      reason: null,
    });
    expect(running.withdrawNotice.visible).toBe(false);
    expect(running.report).toBe(true);
    expect(running.dryRun).toBe(true);
    const done = migrationGates(stateOf("completed"));
    expect(done.run.visible).toBe(false);
    expect(done.report).toBe(true);
    expect(done.dryRun).toBe(false);
    expect(done.unflagLocked).toBe("The migration has run.");
  });

  it("the run is typed (L3), the notice is a caution (L1)", () => {
    expect(confirmFor("overrideMigration.run")).toMatchObject({
      intent: "danger",
      typedConfirmation: true,
      typed: "migrate",
    });
    expect(confirmFor("overrideMigration.startNotice").intent).toBe("caution");
    expect(confirmFor("overrideMigration.flagPrerequisite").intent).toBe(
      "caution",
    );
  });
});

describe("Platform → Override migration", () => {
  it("says the run is the owner's decision; Start notice waits for both flags", async () => {
    bootPage(stateOf("idle"));
    const main = await page();
    expect(
      within(main).getByText("The production run is the owner's decision"),
    ).toBeTruthy();
    const start = within(main).getByRole("button", { name: /Start notice/ });
    expect(disabled(start)).toBe(true);
    expect(
      within(main).getAllByText(
        "Flag the login card (I-07) and the Library (I-11) live in production first.",
      ).length,
    ).toBeGreaterThan(0);
    expect(
      within(main).queryByRole("button", { name: /Run migration/ }),
    ).toBeNull();
    const results = await axe(main);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });

  it("flags a prerequisite live only after a confirm", async () => {
    const log = bootPage(stateOf("idle"));
    const main = await page();
    await userEvent.click(
      within(main).getAllByRole("button", { name: "Flag as live…" })[0]!,
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText("Is the login card (I-07) live in production?"),
    ).toBeTruthy();
    expect(writesTo(log, `${BASE}/prerequisites`)).toEqual([]);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Flag as live" }),
    );
    await waitFor(() =>
      expect(writesTo(log, `${BASE}/prerequisites`)[0]).toMatchObject({
        method: "PUT",
        json: { loginCard: true },
      }),
    );
  });

  it("starts the notice, naming the run date 30 days out", async () => {
    const log = bootPage(stateOf("idle", { loginCard: true, library: true }));
    const main = await page();
    await userEvent.click(
      within(main).getByRole("button", { name: /Start notice/ }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(
        `The run becomes possible on ${formatDate(Date.now() + 30 * DAY * 1000)}, and not before.`,
      ),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Start notice" }),
    );
    await waitFor(() =>
      expect(writesTo(log, `${BASE}/notice`)[0]).toMatchObject({
        method: "POST",
      }),
    );
  });

  it("during the notice: the run waits for the date, unflagging is locked, withdraw is offered", async () => {
    bootPage(stateOf("notice"));
    const main = await page();
    expect(
      disabled(within(main).getByRole("button", { name: /Run migration/ })),
    ).toBe(true);
    for (const b of within(main).getAllByRole("button", { name: "Unflag…" }))
      expect(disabled(b)).toBe(true);
    expect(
      within(main).getByRole("button", { name: /Withdraw notice/ }),
    ).toBeTruthy();
    expect(
      within(main).queryByRole("button", { name: /Start notice/ }),
    ).toBeNull();
  });

  it("runs after typing migrate with a fresh sign-in, then offers Continue", async () => {
    const log = bootPage(
      stateOf("notice", { runAllowed: true, runNotBefore: NOW_S - 60 }),
    );
    const main = await page();
    await userEvent.click(
      within(main).getByRole("button", { name: /Run migration/ }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(
        /Unowned licenses' config and secret overrides are dropped/,
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText(/This can't be undone/)).toBeTruthy();
    const confirm = () =>
      within(dialog).getByRole("button", { name: "Run migration" });
    expect(disabled(confirm())).toBe(true);
    await userEvent.type(within(dialog).getByRole("textbox"), "migrate");
    await userEvent.click(confirm());
    await waitFor(() => expect(writesTo(log, `${BASE}/run`)).toHaveLength(1));
    expect(
      await screen.findByText("Products are left: continue the run"),
    ).toBeTruthy();
  });

  it("asks for a fresh sign-in, back to this page, before a run", async () => {
    bootPage(
      stateOf("notice", { runAllowed: true, runNotBefore: NOW_S - 60 }),
      { fresh: false },
    );
    const main = await page();
    await userEvent.click(
      within(main).getByRole("button", { name: /Run migration/ }),
    );
    const dialog = await screen.findByRole("alertdialog");
    const link = within(dialog).getByRole("link", { name: "Sign in again" });
    expect(link.getAttribute("href")).toContain("stepUp=1");
    expect(decodeURIComponent(link.getAttribute("href")!)).toContain(
      "/manage/#/platform/override-migration",
    );
    await userEvent.type(within(dialog).getByRole("textbox"), "migrate");
    expect(
      disabled(within(dialog).getByRole("button", { name: "Run migration" })),
    ).toBe(true);
  });

  it("continues a started run one call at a time", async () => {
    const log = bootPage(stateOf("running"));
    const main = await page();
    await userEvent.click(
      within(main).getByRole("button", { name: "Continue run" }),
    );
    await waitFor(() => expect(writesTo(log, `${BASE}/run`)).toHaveLength(1));
  });

  it("words an out-of-order refusal with the Worker's own message", async () => {
    bootPage(stateOf("running"), {
      routes: {
        [`POST ${BASE}/run`]: new Response(
          JSON.stringify({
            error: {
              code: "run_in_progress",
              message:
                "Another request is running the migration. Wait a moment and continue.",
            },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      },
    });
    const main = await page();
    await userEvent.click(
      within(main).getByRole("button", { name: "Continue run" }),
    );
    expect(await screen.findByText("Not possible right now")).toBeTruthy();
    expect(
      screen.getByText(
        "Another request is running the migration. Wait a moment and continue.",
      ),
    ).toBeTruthy();
  });

  it("shows a dry run's report, writing nothing and showing no secret value", async () => {
    const log = bootPage(stateOf("notice"));
    const main = await page();
    await userEvent.click(
      within(main).getByRole("button", { name: "Run dry run" }),
    );
    await waitFor(() =>
      expect(writesTo(log, `${BASE}/dry-run`)[0]).toMatchObject({
        method: "POST",
        json: {},
      }),
    );
    const table = await screen.findByRole("table", { name: "Dry run report" });
    expect(within(table).getByText("Dropped")).toBeTruthy();
    expect(within(table).getByText("Moved")).toBeTruthy();
    expect(within(table).getByText("feature.timeout: 30")).toBeTruthy();
    expect(within(table).getAllByText("api.token (secret)").length).toBe(1);
    expect(within(table).getByText("Created at the run")).toBeTruthy();
    expect(within(table).getByText("lab@x.io")).toBeTruthy();
    expect(
      within(main).getByText(/1 moved, 0 collapsed, 1 dropped/),
    ).toBeTruthy();
  });

  it("after the run: the report and its CSV, and no run or dry run", async () => {
    const created = vi.fn(() => "blob:report");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: created }));
    URL.revokeObjectURL = () => undefined;
    const log = bootPage(stateOf("completed"));
    const main = await page();
    const table = await screen.findByRole("table", {
      name: "Migration report",
    });
    expect(await within(table).findByText("Collapsed")).toBeTruthy();
    expect(
      within(table).getByText("feature.timeout: 30 (kept lic_1)"),
    ).toBeTruthy();
    expect(
      within(table)
        .getByRole("link", { name: "ps_AAAAAAAAAAAAAAAAAAAAAA" })
        .getAttribute("href"),
    ).toBe("#/p/djdl/users/ps_AAAAAAAAAAAAAAAAAAAAAA");
    expect(
      within(main).queryByRole("button", { name: /Run migration|Continue/ }),
    ).toBeNull();
    expect(
      within(main).queryByRole("button", { name: "Run dry run" }),
    ).toBeNull();
    await userEvent.click(
      within(main).getByRole("button", { name: "Download CSV" }),
    );
    await waitFor(() => expect(created).toHaveBeenCalled());
    expect(
      log.calls.some(
        (c) => c.path === `${BASE}/report` && c.query === "format=csv",
      ),
    ).toBe(true);
  });
});

describe("the notice on a product's Licenses page", () => {
  it("words the counts and the run date", () => {
    const now = fromSeconds(NOW_S);
    const date = formatDate(fromSeconds(NOW_S + 10 * DAY));
    expect(migrationNoticeText(stateOf("notice"), "djdl", now)).toEqual({
      tone: "warning",
      text: `2 licenses' config overrides are dropped on ${date} unless their customers add them to an account; 1 moves to its owner's account overrides.`,
    });
    const ownedOnly = stateOf("notice");
    ownedOnly.inventory!.products[0] = {
      product: "djdl",
      licences: 2,
      owned: 2,
      dropped: 0,
      collapsingAccounts: 0,
    };
    expect(migrationNoticeText(ownedOnly, "djdl", now)).toEqual({
      tone: "info",
      text: `2 licenses' config overrides move to their owners' account overrides on ${date}.`,
    });
    expect(migrationNoticeText(stateOf("notice"), "acme", now)).toBeNull();
    expect(migrationNoticeText(stateOf("idle"), "djdl", now)).toBeNull();
    expect(migrationNoticeText(stateOf("running"), "djdl", now)).toBeNull();
    expect(migrationNoticeText(undefined, "djdl", now)).toBeNull();
  });

  it("shows on the Licenses page while the notice runs, linking to the platform page", async () => {
    bootLicense("#/p/djdl/license/licenses", {
      routes: { [BASE]: { state: stateOf("notice") } },
    });
    expect(
      await screen.findByText(
        "License config overrides are moving to account overrides",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/2 licenses' config overrides are dropped on/),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Override migration" })
        .getAttribute("href"),
    ).toBe(HASH);
  });

  it("says nothing before the notice", async () => {
    bootLicense("#/p/djdl/license/licenses", {
      routes: { [BASE]: { state: stateOf("idle") } },
    });
    await screen.findByRole("table", { name: "Licenses" });
    expect(
      screen.queryByText(
        "License config overrides are moving to account overrides",
      ),
    ).toBeNull();
  });
});
