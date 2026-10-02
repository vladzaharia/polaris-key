/**
 * P6-03 — the Distribution section's Update health tab: the funnel per rollout, the auto-halt
 * settings (saved through the one audited route) and the Sentry halt candidates, each confirmed
 * or dismissed behind a confirmation and sent to the worker exactly once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AutoHaltSettings, UpdateHealthResponse } from "../src/api.js";
import { resetCache } from "../src/context.js";
import { Toaster } from "../src/components/ui/index.js";

const SLUG = "djdl";
const updateHealth = vi.fn<(slug: string) => Promise<UpdateHealthResponse>>();
const saveAutoHalt =
  vi.fn<(slug: string, body: Partial<AutoHaltSettings>) => Promise<unknown>>();
const decideCandidate =
  vi.fn<
    (
      slug: string,
      id: string,
      decision: "confirm" | "dismiss",
    ) => Promise<unknown>
  >();

vi.mock("../src/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api.js")>()),
  api: {
    updateHealth: (slug: string) => updateHealth(slug),
    saveAutoHalt: (slug: string, body: Partial<AutoHaltSettings>) =>
      saveAutoHalt(slug, body),
    decideCandidate: (s: string, id: string, d: "confirm" | "dismiss") =>
      decideCandidate(s, id, d),
  },
}));

const { UpdateHealthView } =
  await import("../src/views/distribution/UpdateHealth.js");

const zero = {
  update_offered: 0,
  update_downloaded: 0,
  update_applied: 0,
  update_confirmed: 0,
  update_reverted: 0,
  pack_failed: 0,
  boot_rolled_back: 0,
};

const DEFAULTS: AutoHaltSettings = {
  enabled: false,
  windowHours: 6,
  minSample: 200,
  maxRevertRate: 0.05,
  maxBootRollbackRate: 0.02,
};

const DATA: UpdateHealthResponse = {
  windowHours: 168,
  counting: true,
  events: Object.keys(zero) as UpdateHealthResponse["events"],
  rollouts: [
    {
      rollout: {
        deliverableId: "app",
        outletId: "direct",
        channel: "stable",
        releaseId: "v1.1.0",
        rolloutBp: 2000,
        state: "active",
        mirrored: false,
        source: "admin",
        startedAt: 1,
        updatedAt: 1,
        updatedBy: "admin:u1",
      },
      devices: {
        ...zero,
        update_offered: 412,
        update_downloaded: 380,
        update_applied: 371,
        update_confirmed: 350,
        update_reverted: 9,
      },
      events: { ...zero, update_offered: 430 },
      truncated: false,
      verdict: { revertRate: 9 / 371, bootRollbackRate: 0, trips: [] },
    },
  ],
  unknown: [
    {
      deliverable: "app",
      releaseId: "v1.1.0",
      outlet: "unknown",
      devices: { ...zero, update_applied: 4, update_reverted: 1 },
    },
  ],
  autoHalt: {
    settings: { ...DEFAULTS, updatedAt: null, updatedBy: null },
    defaults: DEFAULTS,
    maxWindowHours: 168,
    lastReading: null,
    trips: [],
    alerts: [],
  },
  sentry: {
    configured: true,
    candidates: [
      {
        type: "halt-candidate",
        id: "cand_abc",
        outletId: "direct",
        releaseId: "v1.1.0",
        state: "open",
        ref: { channel: "stable" },
        detail: { rule: "Crash spike", alerts: 2 },
        terminal: false,
        updatedAt: 1,
      },
    ],
  },
};

function renderView() {
  return render(
    <Toaster>
      <UpdateHealthView slug={SLUG} />
    </Toaster>,
  );
}

describe("Distribution — update health", () => {
  beforeEach(() => {
    // The auto-halt toggle is a Radix Switch, whose size hook reaches for ResizeObserver.
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      };
    resetCache();
    updateHealth.mockReset();
    saveAutoHalt.mockReset();
    decideCandidate.mockReset();
    updateHealth.mockResolvedValue(DATA);
    saveAutoHalt.mockResolvedValue({ settings: DATA.autoHalt.settings });
    decideCandidate.mockResolvedValue({ candidate: {} });
  });
  afterEach(cleanup);

  it("shows the funnel in distinct devices, the rates and the unknown-outlet counts", async () => {
    renderView();
    await screen.findByText("Funnel");
    expect(screen.getByText("412")).toBeTruthy();
    expect(screen.getByText("412").getAttribute("title")).toBe("430 events");
    expect(screen.getByText("371")).toBeTruthy();
    expect(screen.getByText("2.43%")).toBeTruthy();
    expect(screen.getByText(/never judged/)).toBeTruthy();
  });

  it("saves the auto-halt settings through the one route", async () => {
    renderView();
    await screen.findByText("Auto-halt");
    await userEvent.click(
      screen.getByRole("switch", { name: "Auto-halt enabled" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveAutoHalt).toHaveBeenCalledTimes(1));
    expect(saveAutoHalt).toHaveBeenCalledWith(SLUG, {
      ...DEFAULTS,
      enabled: true,
    });
  });

  it("a Sentry candidate halts only after the confirmation, exactly once", async () => {
    renderView();
    await screen.findByText(/Crash spike/);
    await userEvent.click(screen.getByRole("button", { name: "Halt" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/Halts the direct rollout of v1.1.0/),
    ).toBeTruthy();
    expect(decideCandidate).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Halt" }));
    await waitFor(() => expect(decideCandidate).toHaveBeenCalledTimes(1));
    expect(decideCandidate).toHaveBeenCalledWith(SLUG, "cand_abc", "confirm");
  });

  it("a Sentry candidate can be dismissed", async () => {
    renderView();
    await screen.findByText(/Crash spike/);
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Dismiss" }),
    );
    await waitFor(() =>
      expect(decideCandidate).toHaveBeenCalledWith(SLUG, "cand_abc", "dismiss"),
    );
  });
});
