/**
 * Distribution → Matrix (admin chunk 9, ADMIN.md §6.4): the T5 grid, its views and URL state, the
 * cell drawer with only the server-allowed verbs, the store's own controls for a mirrored
 * rollout, readiness overrides, Set percentage and Start rollout. Closes MTX-1 to MTX-10.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { resetConsole } from "./consoleHarness.js";
import {
  apiError,
  bootWith,
  MATRIX,
  P,
  writes,
} from "./distributionFixture.js";

const axe = configureAxe({
  rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
});

const MATRIX_HASH = "#/p/djdl/distribution/matrix";

beforeEach(() => {
  resetConsole();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function grid(): Promise<HTMLElement> {
  return screen.findByRole("grid", { name: /Distribution matrix of the app/ });
}

describe("Distribution → Matrix", () => {
  it("renders releases × outlets as a grid of summaries, with a legend and no status caveat", async () => {
    bootWith(MATRIX_HASH);
    const g = await grid();
    expect(
      screen.getByRole("heading", { level: 1, name: "Matrix" }),
    ).toBeTruthy();
    for (const o of ["direct", "app-store", "play", "altstore"])
      expect(
        within(g).getByRole("columnheader", { name: new RegExp(o) }),
      ).toBeTruthy();
    const cell = within(g).getByRole("gridcell", {
      name: /^2\.4\.0 on direct: Live, Rolling out · 25 %/,
    });
    expect(within(cell).getByText("Live")).toBeTruthy();
    expect(
      within(g).getByRole("gridcell", {
        name: /^2\.4\.0 on altstore: Pending, Held for packs/,
      }),
    ).toBeTruthy();
    // MTX-1: no action buttons in cells.
    expect(within(g).queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByRole("list", { name: "Legend" })).toBeTruthy();
    expect(screen.queryByText(/does not stop devices yet/)).toBeNull();
  });

  it("round-trips the view, channel and limit through the URL", async () => {
    const { calls } = bootWith(
      `${MATRIX_HASH}?view=readiness&channel=beta&limit=50`,
    );
    const g = await grid();
    // Only the beta release, readiness summaries.
    expect(within(g).getAllByRole("row")).toHaveLength(2);
    expect(
      within(g).getByRole("gridcell", {
        name: /^2\.4\.0-rc\.2 on direct: readiness not tracked/,
      }),
    ).toBeTruthy();
    expect(
      calls.some(
        (c) =>
          c.path === P("/distribution/matrix") && c.query.includes("limit=50"),
      ),
    ).toBe(true);
    await userEvent.click(screen.getByRole("radio", { name: "Availability" }));
    await waitFor(() => expect(window.location.hash).not.toContain("view="));
    expect(window.location.hash).toContain("channel=beta");
  });

  it("opens the cell drawer from the grid and offers only the server's verbs", async () => {
    bootWith(MATRIX_HASH);
    const g = await grid();
    await userEvent.click(
      within(g).getByRole("gridcell", { name: /^2\.4\.0 on direct/ }),
    );
    await waitFor(() =>
      expect(window.location.hash).toContain("cell=rel_240%3Adirect"),
    );
    const drawer = await screen.findByRole("dialog", {
      name: "2.4.0 on direct",
    });
    expect(
      within(drawer).getByRole("heading", { name: "Availability" }),
    ).toBeTruthy();
    expect(
      within(drawer).getByText("Derived: Polaris Key serves these bytes", {
        exact: false,
      }),
    ).toBeTruthy();
    expect(
      within(drawer).getByRole("button", { name: "Pause direct / stable" }),
    ).toBeTruthy();
    expect(
      within(drawer).getByRole("button", { name: "Halt direct / stable" }),
    ).toBeTruthy();
    expect(
      within(drawer).queryByRole("button", { name: "Resume direct / stable" }),
    ).toBeNull();
    expect(
      within(drawer).getByRole("meter", {
        name: /Rollout of 2\.4\.0 on stable/,
      }),
    ).toBeTruthy();
  });

  it("halts at L2 and refreshes the matrix after the server confirms", async () => {
    const { calls } = bootWith(`${MATRIX_HASH}?cell=rel_240:direct`, {
      [`POST ${P("/distribution/rollouts/direct/stable/halt")}`]: {
        rollout: {},
      },
    });
    const drawer = await screen.findByRole("dialog", {
      name: "2.4.0 on direct",
    });
    const before = calls.filter(
      (c) => c.path === P("/distribution/matrix"),
    ).length;
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Halt direct / stable" }),
    );
    const confirm = await screen.findByRole("alertdialog");
    expect(
      within(confirm).getByText(/Only an explicit resume lifts a halt/),
    ).toBeTruthy();
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Halt 2.4.0" }),
    );
    await waitFor(() =>
      expect(writes(calls)).toContainEqual(
        expect.objectContaining({
          path: P("/distribution/rollouts/direct/stable/halt"),
          method: "POST",
          body: { deliverable: "app", releaseId: "rel_240" },
        }),
      ),
    );
    await waitFor(() =>
      expect(
        calls.filter((c) => c.path === P("/distribution/matrix")).length,
      ).toBeGreaterThan(before),
    );
  });

  it("keeps the confirmation open with the worded refusal when the server refuses", async () => {
    bootWith(`${MATRIX_HASH}?cell=rel_240:direct`, {
      [`POST ${P("/distribution/rollouts/direct/stable/pause")}`]: () =>
        apiError(409, "bad_request", { reason: "stale_release" }),
    });
    const drawer = await screen.findByRole("dialog", {
      name: "2.4.0 on direct",
    });
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Pause direct / stable" }),
    );
    const confirm = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Pause 2.4.0" }),
    );
    expect(
      await within(confirm).findByText(/Someone changed this rollout/),
    ).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("sets a percentage with a preset (MTX-5)", async () => {
    const { calls } = bootWith(`${MATRIX_HASH}?cell=rel_240:direct`, {
      [`POST ${P("/distribution/rollouts/direct/stable")}`]: { rollout: {} },
    });
    const drawer = await screen.findByRole("dialog", {
      name: "2.4.0 on direct",
    });
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Set percentage…" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Set the percentage of 2.4.0",
    });
    await userEvent.click(within(dialog).getByRole("button", { name: "50 %" }));
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Set to 50 %" }),
    );
    await waitFor(() =>
      expect(writes(calls)).toContainEqual(
        expect.objectContaining({
          path: P("/distribution/rollouts/direct/stable"),
          body: { deliverable: "app", releaseId: "rel_240", bp: 5000 },
        }),
      ),
    );
  });

  it("shows a mirrored rollout read-only, with the store's own controls", async () => {
    const { calls } = bootWith(`${MATRIX_HASH}?cell=rel_240:play`, {
      [`POST ${P("/distribution/connectors/play/rollout/halt")}`]: { ok: true },
    });
    const drawer = await screen.findByRole("dialog", { name: "2.4.0 on play" });
    expect(
      within(drawer).getByText(/Google Play owns this rollout/),
    ).toBeTruthy();
    expect(
      within(drawer).queryByRole("button", { name: /^Pause play/ }),
    ).toBeNull();
    await userEvent.click(
      await within(drawer).findByRole("button", { name: "Halt on Play…" }),
    );
    const confirm = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Halt 2.4.0" }),
    );
    await waitFor(() =>
      expect(writes(calls)).toContainEqual(
        expect.objectContaining({
          path: P("/distribution/connectors/play/rollout/halt"),
          body: { track: "production", releaseId: "rel_240" },
        }),
      ),
    );
  });

  it("overrides a readiness hold only with a reason (MTX-2)", async () => {
    const { calls } = bootWith(`${MATRIX_HASH}?cell=rel_240:altstore`, {
      [`POST ${P("/distribution/readiness/rel_240/altstore/override")}`]: {
        appReleaseId: "rel_240",
        readiness: null,
      },
    });
    const drawer = await screen.findByRole("dialog", {
      name: "2.4.0 on altstore",
    });
    expect(
      within(drawer).getByRole("link", { name: "textures 3.0.0" }),
    ).toBeTruthy();
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Override…" }),
    );
    const confirm = await screen.findByRole("alertdialog");
    const go = within(confirm).getByRole("button", { name: "Override 2.4.0" });
    expect((go as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(
      within(confirm).getByLabelText(/Reason/),
      "packs ship in the build",
    );
    await userEvent.click(go);
    await waitFor(() =>
      expect(writes(calls)).toContainEqual(
        expect.objectContaining({
          path: P("/distribution/readiness/rel_240/altstore/override"),
          body: { reason: "packs ship in the build" },
        }),
      ),
    );
  });

  it("refreshes readiness and shows what changed", async () => {
    bootWith(MATRIX_HASH, {
      [`POST ${P("/distribution/readiness/refresh")}`]: {
        refreshed: 3,
        rows: [],
      },
    });
    await grid();
    await userEvent.click(
      screen.getByRole("button", { name: "Refresh readiness" }),
    );
    expect(
      await screen.findByText(/3 release × outlet pairs were recomputed/),
    ).toBeTruthy();
  });

  it("starts a rollout from the header", async () => {
    const { calls } = bootWith(MATRIX_HASH, {
      [`POST ${P("/distribution/rollouts/altstore/beta")}`]: { rollout: {} },
    });
    await grid();
    await userEvent.click(
      screen.getByRole("button", { name: "Start rollout…" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Start a rollout",
    });
    await userEvent.click(
      within(dialog).getByRole("combobox", { name: /Outlet/ }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: /altstore/ }),
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: /^Release/ }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: /2\.4\.0-rc\.2/ }),
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "10 %" }));
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Start rollout" }),
    );
    await waitFor(() =>
      expect(writes(calls)).toContainEqual(
        expect.objectContaining({
          path: P("/distribution/rollouts/altstore/beta"),
          body: { deliverable: "app", releaseId: "rel_rc2", bp: 1000 },
        }),
      ),
    );
  });

  it("asks for the matrix of another deliverable through the URL (MTX-6)", async () => {
    const { calls } = bootWith(MATRIX_HASH);
    await grid();
    await userEvent.click(
      screen.getByRole("combobox", { name: "Deliverable" }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: /textures/ }),
    );
    await waitFor(() =>
      expect(window.location.hash).toContain("deliverable=textures"),
    );
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.path === P("/distribution/matrix") &&
            c.query.includes("deliverable=textures"),
        ),
      ).toBe(true),
    );
  });

  it("splits the empty state by cause (MTX-9)", async () => {
    bootWith(MATRIX_HASH, {
      [P("/distribution/matrix")]: { ...MATRIX, releases: [], cells: [] },
    });
    expect(
      await screen.findByRole("heading", {
        name: "No releases of the app yet",
      }),
    ).toBeTruthy();
    cleanup();
    resetConsole();
    bootWith(MATRIX_HASH, {
      [P("/distribution/matrix")]: { ...MATRIX, outlets: [], cells: [] },
    });
    expect(
      await screen.findByRole("heading", { name: "No outlets declared" }),
    ).toBeTruthy();
  });

  it("shows a loading state, then an error with Retry", async () => {
    let fail = true;
    bootWith(MATRIX_HASH, {
      [P("/distribution/matrix")]: () =>
        fail ? apiError(500, "internal") : MATRIX,
    });
    expect(await screen.findByLabelText("Loading the matrix")).toBeTruthy();
    const retry = await screen.findByRole("button", { name: "Retry" });
    fail = false;
    await userEvent.click(retry);
    expect(await grid()).toBeTruthy();
  });

  it("filters to no results and clears the filter", async () => {
    bootWith(`${MATRIX_HASH}?channel=nightly`);
    expect(
      await screen.findByRole("heading", {
        name: /^No releases on this channel/,
      }),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: /Clear filters/ }),
    );
    expect(await grid()).toBeTruthy();
  });

  it("passes axe", async () => {
    const { container } = { container: document.body };
    bootWith(MATRIX_HASH);
    await grid();
    const results = await axe(container);
    expect(
      results.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
      ),
    ).toEqual([]);
  });
});
