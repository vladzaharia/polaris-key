import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ALL_ON, boot, productRow, resetConsole } from "./consoleHarness.js";
import { feedRoutes } from "./feedsFixture.js";
import { planCsv } from "../src/console/sections/feeds/pages/CleanupDryRun.js";
import { captureDownloads } from "./portalDataKit.js";

/**
 * The cleanup dry-run dialog (F-38a; mockup `packages.cleanup-dry-run`): the notice callout on
 * Packages, the plan per package with what is held back and why, the CSV, and Apply behind an L2
 * confirm that is never the default.
 */

beforeEach(resetConsole);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const BASE = "/manage/api/products/djdl/distribution/feeds";
const RETENTION = `${BASE}/retention`;
const PRUNE = `${BASE}/prune`;
// 2026-10-07 09:00Z and a week later.
const NOTICED = 1_791_363_600;
const STARTS = NOTICED + 7 * 86_400;

const retention = (over: Record<string, unknown> = {}) => ({
  product: "djdl",
  prunePrereleases: false,
  locked: false,
  source: "default",
  notice: {
    noticedAt: NOTICED,
    startsAt: STARTS,
    packages: 2,
    versions: 3,
    bytes: 3_000_000,
    freedBytes: 2_500_000,
  },
  version: 0,
  ...over,
});

const v = (version: string, bytes: number) => ({
  releaseId: `a@${version}`,
  version,
  files: 2,
  bytes,
  freedBytes: bytes,
});

function plan(over: Record<string, unknown> = {}) {
  return {
    product: "djdl",
    dryRun: true,
    prunePrereleases: false,
    retention: retention(),
    packages: [
      {
        deliverableId: "a",
        ecosystem: "npm",
        name: "@djdl/source-kit",
        nameNorm: "@djdl/source-kit",
        stable: "2.3.0",
        stableReleaseId: "a@2.3.0",
        prune: [v("2.0.0-dev.1", 1_000_000), v("2.2.0-beta.6", 1_500_000)],
        kept: [
          {
            releaseId: "a@2.1.0-beta.2",
            version: "2.1.0-beta.2",
            reason: "pinned",
          },
        ],
        bytes: 2_500_000,
        freedBytes: 2_500_000,
      },
      {
        deliverableId: "b",
        ecosystem: "pypi",
        name: "djdl-crates",
        nameNorm: "djdl-crates",
        stable: "1.1.0",
        stableReleaseId: "b@1.1.0",
        prune: [v("1.0.0b1", 500_000)],
        kept: [],
        bytes: 500_000,
        freedBytes: 0,
      },
    ],
    skipped: [],
    totals: {
      versions: 3,
      bytes: 3_000_000,
      freedBytes: 2_500_000,
      failed: 0,
      skipped: 0,
    },
    more: false,
    ...over,
  };
}

const EMPTY = plan({
  packages: [],
  totals: { versions: 0, bytes: 0, freedBytes: 0, failed: 0, skipped: 0 },
});

function open(
  extra: Record<string, unknown> = {},
  me: Record<string, unknown> = {},
) {
  return boot("#/p/djdl/distribution/feeds", {
    me,
    extra: {
      ...feedRoutes(),
      "/manage/api/products/djdl": {
        product: productRow("djdl", "DJDL", ALL_ON),
      },
      [RETENTION]: retention(),
      [`POST ${PRUNE}`]: plan(),
      ...extra,
    },
  });
}

async function openDialog() {
  const main = within(await screen.findByRole("main"));
  await userEvent.click(
    await main.findByRole("button", { name: "See the dry run" }),
  );
  return within(await screen.findByRole("dialog", { name: "Cleanup dry run" }));
}

describe("planCsv", () => {
  it("lists every version cleanup deletes and every one it holds back", () => {
    const lines = planCsv(plan() as never).split("\r\n");
    expect(lines[0]).toBe("Package,Feed,Version,Action,Reason,Files,Bytes");
    expect(lines).toContain(
      "'@djdl/source-kit,npm,2.0.0-dev.1,delete,,2,1000000",
    );
    expect(lines).toContain(
      "'@djdl/source-kit,npm,2.1.0-beta.2,keep,pinned by a channel,,",
    );
    expect(lines).toHaveLength(5);
  });
});

describe("the cleanup callout", () => {
  it("names the start date and opens the dialog", async () => {
    open();
    const main = within(await screen.findByRole("main"));
    expect(await main.findByText("Cleanup starts Oct 14")).toBeTruthy();
    await openDialog();
  });

  it("is absent once the operator chose", async () => {
    open({ [RETENTION]: retention({ source: "operator", notice: null }) });
    const main = within(await screen.findByRole("main"));
    await main.findByRole("list", { name: "Package feeds" });
    expect(main.queryByRole("button", { name: "See the dry run" })).toBeNull();
  });
});

describe("the dry-run dialog", () => {
  it("sends apply false and shows the plan: dates, per package, held-back reasons, totals", async () => {
    const log = open();
    const d = await openDialog();
    await d.findByText("These go with the first stable release after Oct 14.");
    expect(d.getByText(/^Read /)).toBeTruthy();
    expect(d.getByText("Copies on public registries stay.")).toBeTruthy();
    const call = log.calls.find(
      (c) => c.method === "POST" && c.path === PRUNE,
    )!;
    expect(call.json).toEqual({ apply: false });
    expect(d.getByText("@djdl/source-kit")).toBeTruthy();
    expect(d.getByText("2.0.0-dev.1 … 2.2.0-beta.6")).toBeTruthy();
    expect(d.getByText("2.1.0-beta.2")).toBeTruthy();
    expect(d.getByText(/pinned by a channel/)).toBeTruthy();
    expect(d.getAllByText(/Every stable version/).length).toBe(2);
    expect(d.getByText("3 versions · 3 MB")).toBeTruthy();
    // The primary only closes; nothing was written.
    expect(
      d.getByRole("button", { name: "Keep the Oct 14 start" }),
    ).toBeTruthy();
    expect(
      log.calls.filter((c) => c.method === "POST" && c.path === PRUNE).length,
    ).toBe(1);
  });

  it("shows a loading state while the plan is read", async () => {
    open({ [`POST ${PRUNE}`]: (await import("./consoleHarness.js")).PENDING });
    await openDialog();
    expect(document.querySelector("[data-skeleton=cleanup]")).not.toBeNull();
  });

  it("says so when nothing goes, and offers no delete", async () => {
    open({ [`POST ${PRUNE}`]: EMPTY });
    const d = await openDialog();
    await d.findByText("Nothing to delete.");
    expect(d.queryByRole("button", { name: /Delete .* now/ })).toBeNull();
    expect(d.getAllByRole("button", { name: "Close" }).length).toBe(2);
  });

  it("exports the whole plan as CSV, held-back versions included", async () => {
    const dl = captureDownloads();
    try {
      open();
      const d = await openDialog();
      await userEvent.click(
        await d.findByRole("button", { name: /Download all 3 \(CSV\)/ }),
      );
      expect(dl.saved).toHaveLength(1);
      expect(dl.saved[0]!.filename).toBe("cleanup-dry-run-djdl.csv");
      // jsdom's Blob has no text(): the content is checked on the builder below.
    } finally {
      dl.restore();
    }
  });

  it("deletes only after an L2 confirm, then reads the plan again", async () => {
    let applied = false;
    const log = open({
      [`POST ${PRUNE}`]: (_q: URLSearchParams, req: { json?: unknown }) => {
        if ((req.json as { apply: boolean }).apply) {
          applied = true;
          return plan({
            dryRun: false,
            totals: {
              versions: 3,
              bytes: 3_000_000,
              freedBytes: 2_500_000,
              failed: 0,
              skipped: 0,
            },
          });
        }
        return applied ? EMPTY : plan();
      },
    });
    const d = await openDialog();
    const del = await d.findByRole("button", { name: "Delete 3 versions now" });
    await userEvent.click(del);
    // Nothing was sent by opening the confirm.
    expect(
      log.calls.some(
        (c) => (c.json as { apply?: boolean } | undefined)?.apply === true,
      ),
    ).toBe(false);
    const confirm = within(await screen.findByRole("alertdialog"));
    expect(confirm.getByText("Delete 3 versions now?")).toBeTruthy();
    expect(
      confirm.getByText("A deleted version can't be published again."),
    ).toBeTruthy();
    const applyBtn = () =>
      confirm.getByRole("button", { name: "Delete 3 versions" });
    const apply = applyBtn();
    // A typed confirmation: nothing is sent until the product slug is typed.
    await userEvent.click(apply);
    expect(
      log.calls.some(
        (c) => (c.json as { apply?: boolean } | undefined)?.apply === true,
      ),
    ).toBe(false);
    await userEvent.type(
      confirm.getByLabelText(/Type the product slug/),
      "djdl",
    );
    await waitFor(
      () => expect(applyBtn().getAttribute("aria-disabled")).not.toBe("true"),
      { timeout: 8000 },
    );
    await userEvent.click(applyBtn());
    await waitFor(() =>
      expect(
        log.calls.some(
          (c) => (c.json as { apply?: boolean } | undefined)?.apply === true,
        ),
      ).toBe(true),
    );
    await d.findByText("Nothing to delete.");
    // Focus lands on the dialog title, not <body>.
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Cleanup dry run"),
    );
  });

  it("says when the plan was read and names packages with no stable release", async () => {
    open({
      [`POST ${PRUNE}`]: plan({
        skipped: [{ deliverableId: "c", reason: "no-stable" }],
      }),
    });
    const d = await openDialog();
    expect(await d.findByText(/^Read /)).toBeTruthy();
    expect(d.queryByText(/^Dry run /)).toBeNull();
    expect(d.getByText(/1 package has no stable release yet/)).toBeTruthy();
  });

  it("turns cleanup off with the version it read, and closes", async () => {
    const log = open({
      [`PUT ${RETENTION}`]: retention({ source: "operator", version: 4 }),
    });
    const d = await openDialog();
    await userEvent.click(
      await d.findByRole("button", { name: "Turn off cleanup" }),
    );
    await waitFor(() =>
      expect(log.calls.find((c) => c.method === "PUT")?.json).toEqual({
        expectedVersion: 0,
        prunePrereleases: false,
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Cleanup dry run" }),
      ).toBeNull(),
    );
  });

  it("re-reads and says so when the setting moved under a Turn off", async () => {
    const log = open({
      [`PUT ${RETENTION}`]: new Response(
        JSON.stringify({ error: "bad_request", reason: "version_conflict" }),
        { status: 409 },
      ),
    });
    const d = await openDialog();
    await userEvent.click(
      await d.findByRole("button", { name: "Turn off cleanup" }),
    );
    await screen.findByText(/cleanup setting changed/);
    expect(
      screen.getByRole("dialog", { name: "Cleanup dry run" }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        log.calls.filter((c) => c.method === "POST" && c.path === PRUNE).length,
      ).toBeGreaterThan(1),
    );
  });

  it("keeps Delete soft-disabled for a member who cannot edit Ship builds", async () => {
    const reader = { view: ["ship"], edit: [] as string[] };
    open({}, {
      platformAdmin: false,
      permissions: { roles: [], platform: reader, products: { djdl: reader } },
    } as never);
    const d = await openDialog();
    const del = await d.findByRole("button", { name: "Delete 3 versions now" });
    expect(del.getAttribute("aria-disabled")).toBe("true");
  });

  it("says the dry run didn't load and retries", async () => {
    let n = 0;
    open({
      [`POST ${PRUNE}`]: () =>
        n++ === 0 ? new Response("{}", { status: 500 }) : plan(),
    });
    const d = await openDialog();
    await userEvent.click(
      await d.findByRole("button", { name: /Try again|Retry/ }),
    );
    await d.findByText("@djdl/source-kit");
  });
});
