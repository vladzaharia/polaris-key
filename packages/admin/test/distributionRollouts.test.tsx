/**
 * Distribution → Rollouts (admin chunk 9, ADMIN.md §6.4 T2): every rollout, live, halted first,
 * with linked releases, who changed it and when, facets in the URL and the allowed verbs as row
 * actions. Closes DOV-1 to DOV-4 (the descriptor hooks card is deliberately gone).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { resetConsole } from "./consoleHarness.js";
import {
  apiError,
  bootWith,
  P,
  ROLLOUTS,
  writes,
} from "./distributionFixture.js";

const axe = configureAxe({
  rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
});
const HASH = "#/p/djdl/distribution/rollouts";

beforeEach(() => resetConsole());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function table(): Promise<HTMLElement> {
  const t = await screen.findByRole("table", { name: "Rollouts" });
  // Rows arrive with the data; versions arrive with Release's store.
  await within(t).findAllByRole("link", { name: "2.4.0" });
  return t;
}

describe("Distribution → Rollouts", () => {
  it("lists every rollout, halted first, linked, with who changed it", async () => {
    bootWith(HASH);
    const t = await table();
    expect(
      screen.getByRole("heading", { level: 1, name: "Rollouts" }),
    ).toBeTruthy();
    const rows = within(t).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByText("Halted")).toBeTruthy();
    expect(within(rows[0]!).getByText(/by Automatic/)).toBeTruthy();
    // DOV-3: the release is a link showing its version, not a raw id.
    expect(
      within(t).getAllByRole("link", { name: "2.4.0" }).length,
    ).toBeGreaterThan(0);
    expect(within(t).getAllByRole("meter").length).toBe(4);
    expect(screen.queryByText(/Descriptor hooks/)).toBeNull();
    expect(screen.queryByText(/does not stop devices yet/)).toBeNull();
  });

  it("round-trips the state facet through the URL", async () => {
    bootWith(`${HASH}?state=paused`);
    const t = await screen.findByRole("table", { name: "Rollouts" });
    await waitFor(() => expect(within(t).getAllByRole("row")).toHaveLength(2));
    expect(within(t).getByText("2.4.0-rc.2")).toBeTruthy();
  });

  it("shows no results for a filter that matches nothing, and clears it", async () => {
    bootWith(`${HASH}?state=complete`);
    expect(await screen.findByText(/No rollouts match/i)).toBeTruthy();
    await userEvent.click(
      screen.getAllByRole("button", { name: /Clear filters/ })[0]!,
    );
    await waitFor(() => expect(window.location.hash).not.toContain("state="));
  });

  it("halts from the row menu at L2, then refetches", async () => {
    const { calls } = bootWith(HASH, {
      [`POST ${P("/distribution/rollouts/direct/stable/halt")}`]: {
        rollout: {},
      },
    });
    await table();
    const before = calls.filter(
      (c) => c.path === P("/distribution/rollouts"),
    ).length;
    await userEvent.click(
      screen.getByRole("button", {
        name: "Actions for 2.4.0 on direct / stable",
      }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Halt…" }),
    );
    const confirm = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Halt 2.4.0" }),
    );
    await waitFor(() =>
      expect(writes(calls)).toContainEqual(
        expect.objectContaining({
          path: P("/distribution/rollouts/direct/stable/halt"),
          body: { deliverable: "app", releaseId: "rel_240" },
        }),
      ),
    );
    await waitFor(() =>
      expect(
        calls.filter((c) => c.path === P("/distribution/rollouts")).length,
      ).toBeGreaterThan(before),
    );
  });

  it("offers no verbs on a store-owned rollout", async () => {
    bootWith(HASH);
    await table();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Actions for 2.4.0 on play / stable",
      }),
    );
    const menu = await screen.findByRole("menu");
    expect(
      within(menu).getByRole("menuitem", { name: "Open in matrix" }),
    ).toBeTruthy();
    expect(
      within(menu).queryByRole("menuitem", { name: /Pause|Halt|Complete/ }),
    ).toBeNull();
  });

  it("explains rollouts when there are none", async () => {
    bootWith(HASH, { [P("/distribution/rollouts")]: { rollouts: [] } });
    expect(await screen.findByText("No rollouts yet")).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "Start rollout…" }).length,
    ).toBeGreaterThan(0);
  });

  it("shows the error inline with Retry", async () => {
    let fail = true;
    bootWith(HASH, {
      [P("/distribution/rollouts")]: () =>
        fail ? apiError(500, "internal") : ROLLOUTS,
    });
    const retry = await screen.findByRole("button", { name: "Retry" });
    fail = false;
    await userEvent.click(retry);
    expect(await table()).toBeTruthy();
  });

  it("passes axe", async () => {
    bootWith(HASH);
    await table();
    const results = await axe(document.body);
    expect(
      results.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
      ),
    ).toEqual([]);
  });
});
