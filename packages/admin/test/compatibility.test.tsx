/**
 * P4-15 — the Release section's Compatibility tab over a mocked admin API: the matrix renders
 * every cell state (pinned, held, compatible, incompatible, revoked) with the current set member
 * ringed, yanked as a modifier, the live contentApi levels and the unsatisfied markers; the
 * liveness overlay joins Distribution's matrix (live outlets, a readiness hold, a store outlet that
 * is not ready); and the simulator sends the chosen selector and renders the worker's answer.
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
import type {
  CompatResponse,
  DistributionMatrix,
  MatrixCellDto,
  SimulateParams,
  SimulateResponse,
} from "../src/api.js";
import { ApiError } from "../src/api.js";
import { resetCache } from "../src/context.js";
import { sha } from "./releaseFixture.js";

const releaseCompat =
  vi.fn<
    (
      slug: string,
      opts?: { limit?: number; offset?: number },
    ) => Promise<CompatResponse>
  >();
const distributionMatrix =
  vi.fn<(slug: string, opts?: unknown) => Promise<DistributionMatrix>>();
const simulateUpdate =
  vi.fn<(slug: string, params: SimulateParams) => Promise<SimulateResponse>>();

vi.mock("../src/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api.js")>()),
  api: {
    releaseCompat: (slug: string, opts?: { limit?: number; offset?: number }) =>
      releaseCompat(slug, opts),
    distributionMatrix: (slug: string, opts?: unknown) =>
      distributionMatrix(slug, opts),
    simulateUpdate: (slug: string, params: SimulateParams) =>
      simulateUpdate(slug, params),
  },
}));

const { Compatibility } =
  await import("../src/views/releases/Compatibility.js");

const SLUG = "diceroll";
const FOES = "diceroll.foes";
const SKINS = "diceroll.skins";

const COMPAT: CompatResponse = {
  channels: ["stable", "beta"],
  liveLevels: { stable: [3, 4] },
  levels: [3, 4],
  limit: 10,
  offset: 0,
  capped: false,
  older: { appReleases: 3, packReleases: 0 },
  packs: [
    { id: FOES, binding: "compatible", required: true, delivery: "essential" },
    { id: SKINS, binding: "pinned", required: false, delivery: "on-demand" },
  ],
  appReleases: [
    {
      releaseId: "app@1.5.0",
      version: "1.5.0",
      seq: 15,
      channel: "stable",
      contentApi: 4,
      live: true,
      liveOn: ["stable"],
      yanked: null,
      platforms: ["android", "ios"],
      engines: [""],
      pins: [{ pack: SKINS, releaseId: "skins@1.0.0" }],
      holds: [],
      unsatisfied: [
        {
          pack: FOES,
          reason: "content-floor",
          detail:
            "no release of diceroll.foes on stable is at or above the floor 2.1.0",
          channel: "stable",
          platform: "android",
          engine: "",
          variant: "",
        },
      ],
    },
    {
      releaseId: "app@1.4.0",
      version: "1.4.0",
      seq: 14,
      channel: "stable",
      contentApi: 3,
      live: true,
      liveOn: ["stable"],
      yanked: null,
      platforms: ["ios"],
      engines: [""],
      pins: [],
      holds: [{ pack: FOES, releaseId: "foes@1.0.0" }],
      unsatisfied: [],
    },
  ],
  packReleases: [
    {
      pack: FOES,
      releaseId: "foes@2.0.0",
      version: "2.0.0",
      seq: 3,
      sha256: sha(200),
      channel: "stable",
      requires: { contentApi: [">=4"], engines: [] },
      yanked: null,
      revoked: null,
      current: true,
    },
    {
      pack: FOES,
      releaseId: "foes@1.0.1",
      version: "1.0.1",
      seq: 2,
      sha256: sha(101),
      channel: "stable",
      requires: { contentApi: [">=3 <4"], engines: [] },
      yanked: { reason: "revoked", at: 1_720_000_000, by: "ci:k1" },
      revoked: {
        kind: "record",
        recordSha256: sha(900),
        reason: "Exploit in spawn tables",
        issuedAt: 1_720_000_000,
        replacement: null,
      },
      current: false,
    },
    {
      pack: FOES,
      releaseId: "foes@1.0.0",
      version: "1.0.0",
      seq: 1,
      sha256: sha(100),
      channel: "stable",
      requires: { contentApi: [">=3 <4"], engines: [] },
      yanked: null,
      revoked: null,
      current: true,
    },
    {
      pack: SKINS,
      releaseId: "skins@1.0.0",
      version: "1.0.0",
      seq: 1,
      sha256: sha(300),
      channel: "stable",
      requires: { contentApi: [], engines: [] },
      yanked: null,
      revoked: null,
      current: false,
    },
  ],
  cells: [
    cell(
      "app@1.5.0",
      "foes@2.0.0",
      "compatible",
      true,
      "contentApi >=4 holds level 4",
    ),
    cell(
      "app@1.5.0",
      "foes@1.0.1",
      "revoked",
      false,
      "revoked (Exploit)",
      true,
    ),
    cell(
      "app@1.5.0",
      "foes@1.0.0",
      "incompatible",
      false,
      "contentApi >=3 <4 excludes level 4",
    ),
    cell(
      "app@1.5.0",
      "skins@1.0.0",
      "pinned",
      false,
      "the app release pins it",
    ),
    cell(
      "app@1.4.0",
      "foes@2.0.0",
      "incompatible",
      false,
      "contentApi >=4 excludes level 3",
    ),
    cell(
      "app@1.4.0",
      "foes@1.0.1",
      "revoked",
      false,
      "revoked (Exploit)",
      true,
    ),
    cell("app@1.4.0", "foes@1.0.0", "held", true, "the app release holds it"),
    cell("app@1.4.0", "skins@1.0.0", "incompatible", false, "pinned binding"),
  ],
  hidden: { appReleases: 3, packReleases: 0 },
  resolvedAt: 1_720_000_000,
};

function cell(
  appReleaseId: string,
  packReleaseId: string,
  state: CompatResponse["cells"][number]["state"],
  current: boolean,
  reason: string,
  yanked = false,
): CompatResponse["cells"][number] {
  return { appReleaseId, packReleaseId, state, current, yanked, reason };
}

function mcell(
  releaseId: string,
  outletId: string,
  availability: string | null,
  readiness: MatrixCellDto["readiness"] = null,
): MatrixCellDto {
  return {
    releaseId,
    outletId,
    availability,
    records: [],
    submission: null,
    rollouts: [],
    readiness,
  };
}

const MATRIX: DistributionMatrix = {
  deliverableId: "app",
  limit: 50,
  outlets: [
    {
      outletId: "direct",
      kind: "direct",
      transport: "pkey-cdn",
      derives: true,
      supported: true,
    },
    {
      outletId: "app-store",
      kind: "app-store",
      transport: "pkey-cdn",
      derives: false,
      supported: true,
    },
    {
      outletId: "play",
      kind: "play",
      transport: "play-pad",
      derives: false,
      supported: true,
    },
    {
      outletId: "web",
      kind: "web",
      transport: "web",
      derives: true,
      supported: true,
    },
  ],
  releases: ["app@1.5.0", "app@1.4.0"].map((releaseId) => ({
    releaseId,
    version: releaseId.slice(4),
    channel: "stable",
    publishedAt: null,
    yanked: false,
  })),
  cells: [
    mcell("app@1.5.0", "direct", "live"),
    mcell("app@1.5.0", "play", "live"),
    mcell("app@1.5.0", "app-store", "in-review", {
      state: "blocked",
      holds: false,
      holdable: false,
      warning:
        "Polaris Key cannot hold a release on app-store: do not submit it yet",
      blockers: [],
      pendingReason: null,
    }),
    mcell("app@1.5.0", "web", "pending", {
      state: "blocked",
      holds: true,
      holdable: true,
      warning: null,
      blockers: [
        {
          pack: FOES,
          version: "2.0.0",
          reason: "not-live",
          detail: "foes 2.0.0 is not live on web",
        },
      ],
      pendingReason: null,
    }),
    mcell("app@1.4.0", "app-store", "live"),
  ],
  states: { availability: [], submission: [], rollout: [] },
};

const RESULT: SimulateResponse = {
  selector: {
    appRelease: "app@1.5.0",
    version: "1.5.0",
    channel: "stable",
    platform: "android",
    outlet: { id: "play", kind: "play", servesPlatform: true },
    axes: { texture: ["etc2"] },
    engine: null,
    contentApi: 4,
    build: { id: "android", arch: "arm64", format: "aab" },
    device: "dev-1",
    methods: ["download"],
  },
  feed: {
    composable: true,
    selector: {},
    omitted: [],
    deltas: 0,
    target: { sha256: sha(15), version: "1.5.0", seq: 15 },
    appRollout: { halted: false, rollout: null, bucket: null },
  },
  decision: {
    action: "none",
    reason: "up-to-date",
    behind: false,
    discardStaged: false,
  },
  boot: "none",
  errors: [],
  set: [],
  packSetId: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  activePackSetId:
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  reported: {
    packSetId:
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    matches: true,
  },
  block: null,
  packs: [
    {
      pack: FOES,
      declared: {
        binding: "compatible",
        required: true,
        delivery: "essential",
      },
      expected: { required: true, delivery: "essential" },
      effectiveBinding: "pinned",
      reason: {
        kind: "transport",
        transport: "play-pad",
        detail:
          "compatible (pinned by play-pad on play: that transport cannot deliver content between app releases)",
      },
      feedTarget: { sha256: sha(200), version: "2.0.0", seq: 3 },
      gate: null,
      floor: { minVersion: "2.0.0", versionScheme: "semver" },
      unsatisfied: [],
      revocations: [],
      active: null,
      install: null,
      revoke: false,
      runs: null,
    },
  ],
  notes: [],
};

beforeEach(() => {
  resetCache();
  releaseCompat.mockReset().mockResolvedValue(COMPAT);
  distributionMatrix.mockReset().mockResolvedValue(MATRIX);
  simulateUpdate.mockReset().mockResolvedValue(RESULT);
});

afterEach(() => {
  cleanup();
});

describe("Compatibility tab (P4-15)", () => {
  it("renders every cell state, the current member, yanked, live levels and unsatisfied markers", async () => {
    render(<Compatibility slug={SLUG} />);
    const row15 = await screen.findByTestId("compat-row-app@1.5.0");
    const row14 = screen.getByTestId("compat-row-app@1.4.0");

    const states = (row: HTMLElement) =>
      [...row.querySelectorAll("[data-state]")].map((e) => [
        e.getAttribute("data-state"),
        e.getAttribute("data-current"),
      ]);
    expect(states(row15)).toEqual([
      ["compatible", "true"],
      ["revoked", "false"],
      ["incompatible", "false"],
      ["pinned", "false"],
    ]);
    expect(states(row14)).toEqual([
      ["incompatible", "false"],
      ["revoked", "false"],
      ["held", "true"],
      ["incompatible", "false"],
    ]);
    // The reason is the cell's title; a yanked release is struck through.
    const revoked = row15.querySelector('[data-state="revoked"]')!;
    expect(revoked.getAttribute("title")).toBe("revoked (Exploit)");
    expect(revoked.className).toMatch(/line-through/);
    expect(within(revoked as HTMLElement).getByText("(yanked)")).toBeTruthy();

    const levels = screen.getByLabelText("Live contentApi levels");
    expect(within(levels).getByText("contentApi 3")).toBeTruthy();
    expect(within(levels).getByText("contentApi 4")).toBeTruthy();
    expect(within(row15).getByText("1 unsatisfied")).toBeTruthy();
    expect(screen.getByText(/3 older app releases/)).toBeTruthy();
    expect(releaseCompat).toHaveBeenCalledWith(SLUG, { limit: 10, offset: 0 });
  });

  it("pages through older releases with an offset, and back", async () => {
    releaseCompat.mockImplementation(async (_slug, opts) => ({
      ...COMPAT,
      offset: opts?.offset ?? 0,
      older:
        (opts?.offset ?? 0) === 0
          ? COMPAT.older
          : { appReleases: 0, packReleases: 0 },
    }));
    render(<Compatibility slug={SLUG} />);
    await screen.findByTestId("compat-row-app@1.5.0");
    expect(screen.queryByRole("button", { name: "Newer releases" })).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Older releases" }),
    );
    await waitFor(() =>
      expect(releaseCompat).toHaveBeenLastCalledWith(SLUG, {
        limit: 10,
        offset: 10,
      }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Newer releases" }),
    );
    // Back on the first page (served from the console's cache): older pages are offered again.
    expect(
      await screen.findByRole("button", { name: "Older releases" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Newer releases" })).toBeNull();
  });

  it("says a release outside Distribution's newest 50 is unknown, not unserved", async () => {
    distributionMatrix.mockReset().mockResolvedValue({
      ...MATRIX,
      releases: MATRIX.releases.filter((r) => r.releaseId === "app@1.5.0"),
    });
    render(<Compatibility slug={SLUG} />);
    const row14 = await screen.findByTestId("compat-row-app@1.4.0");
    await waitFor(() =>
      expect(
        within(row14).getByText("unknown (outside Distribution's newest 50)"),
      ).toBeTruthy(),
    );
  });

  it("marks a capped page", async () => {
    releaseCompat.mockReset().mockResolvedValue({ ...COMPAT, capped: true });
    render(<Compatibility slug={SLUG} />);
    expect(await screen.findByText("capped at 200 app releases")).toBeTruthy();
  });

  it("overlays per-outlet liveness and readiness from Distribution's matrix", async () => {
    render(<Compatibility slug={SLUG} />);
    const row15 = await screen.findByTestId("compat-row-app@1.5.0");
    await waitFor(() => expect(within(row15).getByText("direct")).toBeTruthy());
    const overlay = within(row15).getByLabelText("Outlets serving it");
    expect(within(overlay).getByText("play")).toBeTruthy();
    expect(
      within(overlay).getByText("web: held").getAttribute("title"),
    ).toMatch(/not live on web/);
    expect(within(overlay).getByText("app-store: not ready")).toBeTruthy();
    const row14 = screen.getByTestId("compat-row-app@1.4.0");
    expect(
      within(within(row14).getByLabelText("Outlets serving it")).getByText(
        "app-store",
      ),
    ).toBeTruthy();
    expect(distributionMatrix).toHaveBeenCalledWith(SLUG, {
      deliverable: "app",
      limit: 50,
    });
  });

  it("says the overlay is unavailable when Distribution does not answer", async () => {
    distributionMatrix
      .mockReset()
      .mockRejectedValue(new ApiError(404, undefined, "not_found"));
    render(<Compatibility slug={SLUG} />);
    await screen.findByTestId("compat-row-app@1.5.0");
    expect(
      await screen.findByText(/Per-outlet liveness is unavailable/),
    ).toBeTruthy();
  });

  it("the simulator sends the selector and renders the decision, packSetId and bindings", async () => {
    render(<Compatibility slug={SLUG} />);
    await screen.findByTestId("compat-row-app@1.5.0");
    const form = screen.getByRole("form", { name: "Simulator" });
    await userEvent.selectOptions(
      within(form).getByLabelText("App release"),
      "app@1.5.0",
    );
    await userEvent.selectOptions(
      within(form).getByLabelText("Platform"),
      "android",
    );
    await waitFor(() =>
      expect(
        within(form).getByRole("option", { name: "play (play)" }),
      ).toBeTruthy(),
    );
    await userEvent.selectOptions(
      within(form).getByLabelText("Outlet"),
      "play",
    );
    await userEvent.type(
      within(form).getByLabelText("Variant"),
      "texture=etc2",
    );
    await userEvent.type(
      within(form).getByLabelText("Device id (rollout buckets)"),
      "dev-1",
    );
    await userEvent.type(
      within(form).getByLabelText("Reported packSetId"),
      RESULT.packSetId!,
    );
    await userEvent.click(
      within(form).getByRole("button", { name: "Simulate" }),
    );

    await waitFor(() => expect(simulateUpdate).toHaveBeenCalledTimes(1));
    expect(simulateUpdate).toHaveBeenCalledWith(SLUG, {
      appRelease: "app@1.5.0",
      platform: "android",
      outlet: "play",
      variant: "texture=etc2",
      device: "dev-1",
      packSetId: RESULT.packSetId,
    });
    const result = await screen.findByRole("region", {
      name: "Simulation result",
    });
    expect(within(result).getByTestId("sim-decision").textContent).toMatch(
      /none \(up-to-date\)/,
    );
    expect(within(result).getByTestId("sim-packsetid").textContent).toBe(
      RESULT.packSetId,
    );
    expect(within(result).getByText("matches")).toBeTruthy();
    const foes = within(result).getByTestId(`sim-pack-${FOES}`);
    expect(within(foes).getByText("compatible → pinned")).toBeTruthy();
    expect(within(foes).getByText(/pinned by play-pad on play/)).toBeTruthy();
    expect(within(foes).getByText("≥ 2.0.0")).toBeTruthy();
  });

  it("shows the simulated feed's delta menu (P4-29)", async () => {
    simulateUpdate
      .mockReset()
      .mockResolvedValue({ ...RESULT, feed: { ...RESULT.feed, deltas: 3 } });
    render(<Compatibility slug={SLUG} />);
    await screen.findByTestId("compat-row-app@1.5.0");
    await userEvent.click(screen.getByRole("button", { name: "Simulate" }));
    const result = await screen.findByRole("region", {
      name: "Simulation result",
    });
    expect(within(result).getByText(/delta menu: 3 entries/)).toBeTruthy();
  });

  it("shows the worker's refusal when a simulation fails", async () => {
    const refusal = new ApiError(404, undefined, "not_found");
    refusal.message = "nowhere is no live outlet of this product";
    simulateUpdate.mockReset().mockRejectedValue(refusal);
    render(<Compatibility slug={SLUG} />);
    await screen.findByTestId("compat-row-app@1.5.0");
    await userEvent.click(screen.getByRole("button", { name: "Simulate" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /no live outlet/,
    );
  });
});
