/**
 * Distribution → Health (admin chunk 9, ADMIN.md §6.4 T1): funnels per rollout, the window in the
 * URL, the auto-halt reading and settings, trips and alerts, and the Sentry candidates. Closes
 * UHL-1 to UHL-8; replaces `updateHealth.test.tsx`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { resetConsole } from "./consoleHarness.js";
import {
  apiError,
  bootWith,
  HEALTH,
  P,
  writes,
} from "./distributionFixture.js";

const axe = configureAxe({
  rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
});
const HASH = "#/p/djdl/distribution/health";

beforeEach(() => resetConsole());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function loaded(): Promise<void> {
  await screen.findByRole("heading", { name: "Funnels" });
  await screen.findByRole("figure");
}

describe("Distribution → Health", () => {
  it("shows a funnel per rollout in distinct devices, with rates (UHL-1, UHL-6)", async () => {
    bootWith(HASH);
    await loaded();
    expect(
      screen.getByRole("heading", { level: 1, name: "Health" }),
    ).toBeTruthy();
    const fig = screen.getByRole("figure");
    expect(
      within(fig).getByText(/2\.4\.0 on direct \/ stable, last 24 h/),
    ).toBeTruthy();
    expect(screen.getByText(/Revert rate 1\.1 %/)).toBeTruthy();
    // "Show as table" exists for every chart.
    await userEvent.click(
      within(fig).getByRole("button", { name: "Show as table" }),
    );
    expect(within(fig).getByRole("table")).toBeTruthy();
    expect(within(fig).getByText("1,200")).toBeTruthy();
    expect(
      screen.getAllByRole("link", { name: "2.4.0" }).length,
    ).toBeGreaterThan(0);
  });

  it("counts reports from undeclared outlets apart, never judged", async () => {
    bootWith(HASH, {
      [P("/distribution/update-health")]: {
        ...HEALTH,
        unknown: [
          {
            deliverable: "app",
            releaseId: "rel_239",
            outlet: "unknown",
            devices: {
              ...HEALTH.rollouts[0]!.devices,
              update_applied: 40,
              update_reverted: 2,
            },
          },
        ],
      },
    });
    await loaded();
    expect(screen.getByText(/2\.3\.9: 40 applied, 2 reverted/)).toBeTruthy();
  });

  it("round-trips the window through the URL and asks the server for it (UHL-2)", async () => {
    const { calls } = bootWith(`${HASH}?window=6`);
    await loaded();
    expect(
      calls.some(
        (c) =>
          c.path === P("/distribution/update-health") &&
          c.query === "?windowHours=6",
      ),
    ).toBe(true);
    expect(
      screen.getByRole("radio", { name: "6 h" }).getAttribute("aria-checked"),
    ).toBe("true");
    await userEvent.click(screen.getByRole("radio", { name: "72 h" }));
    await waitFor(() => expect(window.location.hash).toContain("window=72"));
    await waitFor(() =>
      expect(calls.some((c) => c.query === "?windowHours=72")).toBe(true),
    );
  });

  it("shows the auto-halt's last reading and its trips (UHL-3)", async () => {
    bootWith(HASH);
    await loaded();
    expect(screen.getByText(/Last reading/)).toBeTruthy();
    const trips = screen.getByRole("list", {
      name: "Auto-halt trips and alerts",
    });
    expect(within(trips).getByText(/revert rate 7\.10%/)).toBeTruthy();
  });

  it("saves auto-halt settings as fractions through the one route, validating ranges (UHL-4, UHL-5)", async () => {
    const { calls } = bootWith(HASH, {
      [`POST ${P("/distribution/update-health/settings")}`]: {
        settings: HEALTH.autoHalt.settings,
      },
    });
    await loaded();
    const form = screen.getByRole("form", { name: "Auto-halt settings" });
    const rate = within(form).getByLabelText(/Maximum revert rate/);
    expect((rate as HTMLInputElement).value).toBe("5");
    await userEvent.clear(rate);
    await userEvent.type(rate, "150");
    const bar = await screen.findByRole("region", {
      name: "Unsaved changes in Auto-halt",
    });
    await userEvent.click(
      within(bar).getByRole("button", { name: "Save changes" }),
    );
    expect(await within(form).findByText(/less than 100 %/)).toBeTruthy();
    expect(writes(calls)).toEqual([]);
    await userEvent.clear(rate);
    await userEvent.type(rate, "2.5");
    await userEvent.click(
      within(bar).getByRole("button", { name: "Save changes" }),
    );
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          path: P("/distribution/update-health/settings"),
          body: {
            enabled: true,
            windowHours: 24,
            minSample: 200,
            maxRevertRate: 0.025,
            maxBootRollbackRate: 0.02,
          },
        }),
      ]),
    );
  });

  it("resets the form to the server's defaults", async () => {
    bootWith(HASH);
    await loaded();
    const form = screen.getByRole("form", { name: "Auto-halt settings" });
    await userEvent.click(
      within(form).getByRole("button", { name: "Reset to defaults" }),
    );
    expect(
      (
        within(form).getByLabelText(
          /Minimum devices applied/,
        ) as HTMLInputElement
      ).value,
    ).toBe("100");
    expect(
      await screen.findByRole("region", {
        name: "Unsaved changes in Auto-halt",
      }),
    ).toBeTruthy();
  });

  it("halts a Sentry candidate only after the L2 confirmation, exactly once", async () => {
    const { calls } = bootWith(HASH, {
      [`POST ${P("/distribution/update-health/candidates/cand_1/confirm")}`]: {
        candidate: {},
      },
    });
    await loaded();
    await userEvent.click(
      screen.getByRole("button", { name: "Halt rollout…" }),
    );
    expect(writes(calls)).toEqual([]);
    const confirm = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Halt rollout" }),
    );
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          path: P("/distribution/update-health/candidates/cand_1/confirm"),
        }),
      ]),
    );
  });

  it("dismisses a candidate, and lists decided ones apart (UHL-7)", async () => {
    const { calls } = bootWith(HASH, {
      [`POST ${P("/distribution/update-health/candidates/cand_1/dismiss")}`]: {
        candidate: {},
      },
    });
    await loaded();
    await userEvent.click(screen.getByRole("button", { name: "Dismiss…" }));
    const confirm = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Dismiss candidate" }),
    );
    await waitFor(() =>
      expect(writes(calls).map((c) => c.path)).toEqual([
        P("/distribution/update-health/candidates/cand_1/dismiss"),
      ]),
    );
    await userEvent.click(screen.getByRole("tab", { name: /Decided/ }));
    expect(await screen.findByText(/“Error rate”/)).toBeTruthy();
  });

  it("links the unconfigured Sentry state to Outlet credentials (UHL-7)", async () => {
    bootWith(HASH, {
      [P("/distribution/update-health")]: {
        ...HEALTH,
        sentry: { configured: false, candidates: [] },
      },
    });
    await loaded();
    const link = screen.getByRole("link", { name: "Set a Sentry credential" });
    expect(link.getAttribute("href")).toBe("#/p/djdl/distribution/credentials");
  });

  it("explains health when there are no rollouts", async () => {
    bootWith(HASH, {
      [P("/distribution/update-health")]: { ...HEALTH, rollouts: [] },
    });
    expect(await screen.findByText("No rollouts to watch")).toBeTruthy();
  });

  it("shows loading tiles, then the error with Retry", async () => {
    let fail = true;
    bootWith(HASH, {
      [P("/distribution/update-health")]: () =>
        fail ? apiError(500, "internal") : HEALTH,
    });
    const retry = await screen.findByRole("button", { name: "Retry" });
    fail = false;
    await userEvent.click(retry);
    await loaded();
  });

  it("passes axe", async () => {
    bootWith(HASH);
    await loaded();
    const results = await axe(document.body);
    expect(
      results.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
      ),
    ).toEqual([]);
  });
});
