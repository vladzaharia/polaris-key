/**
 * Release → Compatibility over a mocked admin API (ADMIN.md §6.3.5): the matrix on the `Grid`
 * renders every cell state (pinned, held, compatible, incompatible, revoked) with the current set
 * member marked in words, yanked as a modifier, the live contentApi levels and the unsatisfied
 * markers; a cell opens a drawer with its reason and links; the overlay joins Distribution's
 * matrix; and the simulator sends the chosen selector from URL-held inputs and renders the
 * worker's full answer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  CompatResponse,
  DeliverablesResponse,
  DistributionMatrix,
  MatrixCellDto,
  ProductDetail,
  ReleaseChannelsResponse,
  ReleaseStoreResponse,
  SimulateParams,
  SimulateResponse,
} from "../src/api.js";
import { ApiError } from "../src/api.js";
import { sha } from "./releaseFixture.js";
import {
  expectNoAxeViolations,
  hashQuery,
  mountAt,
  pending,
} from "./releaseHarness.js";

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
const product = vi.fn<(slug: string) => Promise<{ product: ProductDetail }>>();
const releases = vi.fn<(slug: string) => Promise<ReleaseStoreResponse>>();
const releaseChannels =
  vi.fn<(slug: string) => Promise<ReleaseChannelsResponse>>();
const deliverables = vi.fn<(slug: string) => Promise<DeliverablesResponse>>();

vi.mock("../src/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api.js")>()),
  api: {
    releaseCompat: (slug: string, opts?: { limit?: number; offset?: number }) =>
      releaseCompat(slug, opts),
    distributionMatrix: (slug: string, opts?: unknown) =>
      distributionMatrix(slug, opts),
    simulateUpdate: (slug: string, params: SimulateParams) =>
      simulateUpdate(slug, params),
    product: (slug: string) => product(slug),
    releases: (slug: string) => releases(slug),
    releaseChannels: (slug: string) => releaseChannels(slug),
    deliverables: (slug: string) => deliverables(slug),
  },
}));

const { CompatibilityPage } =
  await import("../src/console/pages/release/CompatibilityPage.js");
const { SimulatorPage } =
  await import("../src/console/pages/release/SimulatorPage.js");

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

const PRODUCT = {
  slug: SLUG,
  name: "Diceroll",
  services: {
    license: { enabled: true },
    config: { enabled: true },
    release: { enabled: true },
    distribution: { enabled: true },
    update: { enabled: true },
    identity: { enabled: true },
  },
} as unknown as ProductDetail;

const app = (releaseId: string, version: string, seq: number) => ({
  releaseId,
  deliverable: "app",
  version,
  seq,
  channel: "stable",
  title: null,
  publishedAt: 1_720_000_000 + seq,
  sourceUrl: null,
  status: "ok",
  yank: null,
  builds: [
    {
      buildId: "android",
      platform: "android",
      arch: "arm64",
      format: "aab",
      buildNumber: null,
      minOs: null,
    },
    {
      buildId: "ios",
      platform: "ios",
      arch: "arm64",
      format: "ipa",
      buildNumber: null,
      minOs: null,
    },
  ],
  artifacts: [],
});

/** Every app release, newest first: more than the matrix page shows (CMP-8). */
const STORE: ReleaseStoreResponse = {
  releases: [
    app("app@1.5.0", "1.5.0", 15),
    app("app@1.4.0", "1.4.0", 14),
    app("app@1.3.0", "1.3.0", 13),
    app("app@1.2.0", "1.2.0", 12),
  ],
  channels: [],
  floors: [],
};

const CHANNELS: ReleaseChannelsResponse = {
  deliverables: [
    {
      deliverable: "app",
      kind: "app",
      platforms: ["android", "ios"],
      channels: ["stable", "beta"].map((channel) => ({
        deliverable: "app",
        channel,
        pointer: null,
        pinned: false,
        includes: null,
        minSupported: null,
        critical: false,
        source: "manifest" as const,
        modifiedAt: null,
        modifiedBy: null,
        resolved: "app@1.5.0",
        byPlatform: {},
      })),
    },
  ],
};

const DELIVERABLES = {
  gateKnown: true,
  deliverables: [
    { id: FOES, kind: "pack", variantKeys: ["texture=etc2", "texture=s3tc"] },
    { id: SKINS, kind: "pack", variantKeys: [""] },
  ],
} as unknown as DeliverablesResponse;

beforeEach(() => {
  releaseCompat.mockReset().mockResolvedValue(COMPAT);
  distributionMatrix.mockReset().mockResolvedValue(MATRIX);
  simulateUpdate.mockReset().mockResolvedValue(RESULT);
  product.mockReset().mockResolvedValue({ product: PRODUCT });
  releases.mockReset().mockResolvedValue(STORE);
  releaseChannels.mockReset().mockResolvedValue(CHANNELS);
  deliverables.mockReset().mockResolvedValue(DELIVERABLES);
});
afterEach(cleanup);

const MATRIX_HASH = `#/p/${SLUG}/release/compatibility`;
const SIM_HASH = `#/p/${SLUG}/release/compatibility/simulator`;

function mountMatrix(query = "") {
  return mountAt(`${MATRIX_HASH}${query}`, <CompatibilityPage slug={SLUG} />);
}

function mountSimulator(query = "") {
  return mountAt(`${SIM_HASH}${query}`, <SimulatorPage slug={SLUG} />);
}

/** The grid row of an app release (its header links to the release record). */
async function row(version: string): Promise<HTMLElement> {
  const grid = await screen.findByRole("grid");
  return within(grid).getByRole("link", { name: version }).closest("tr")!;
}

describe("Compatibility matrix (T5, CMP-1 to CMP-7, CMP-11)", () => {
  it("heads the page and renders every cell state with words, the current member and yanked", async () => {
    mountMatrix();
    expect(
      await screen.findByRole("heading", { level: 1, name: "Compatibility" }),
    ).toBeTruthy();
    const row15 = await row("1.5.0");
    const row14 = await row("1.4.0");
    const states = (r: HTMLElement) =>
      [...r.querySelectorAll("[data-state]")].map((e) => [
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
    // "Current" is a word, not a ring alone; each cell's name is a sentence (CMP-2).
    const cells = within(row15).getAllByRole("gridcell");
    expect(cells[0]!.getAttribute("aria-label")).toBe(
      "1.5.0 with diceroll.foes 2.0.0: Compatible, the current set member.",
    );
    expect(cells[1]!.getAttribute("aria-label")).toBe(
      "1.5.0 with diceroll.foes 1.0.1: Revoked, yanked.",
    );
    expect(cells[0]!.textContent).toMatch(/Current/);
    // Never a title (CMP-2).
    expect(row15.querySelector("[title]")).toBeNull();
    const levels = screen.getByLabelText("Live contentApi levels");
    expect(levels.textContent).toMatch(/stable 3, 4/);
    expect(within(row15).getByText("1 unsatisfied")).toBeTruthy();
    expect(releaseCompat).toHaveBeenCalledWith(SLUG, { limit: 10, offset: 0 });
  });

  it("opens a cell drawer with the reason, the unsatisfied requirement and links (CMP-11)", async () => {
    mountMatrix();
    const row15 = await row("1.5.0");
    await userEvent.click(within(row15).getAllByRole("gridcell")[0]!);
    const drawer = await screen.findByRole("dialog");
    expect(hashQuery().get("cell")).toBe("app@1.5.0:foes@2.0.0");
    expect(
      within(drawer).getByText("contentApi >=4 holds level 4"),
    ).toBeTruthy();
    expect(
      within(drawer).getByText(/at or above the floor 2\.1\.0/),
    ).toBeTruthy();
    expect(
      within(drawer)
        .getByRole("link", { name: "Open app release" })
        .getAttribute("href"),
    ).toBe(`#/p/${SLUG}/release/releases/${encodeURIComponent("app@1.5.0")}`);
    expect(
      within(drawer)
        .getByRole("link", { name: "Open pack release" })
        .getAttribute("href"),
    ).toBe(
      `#/p/${SLUG}/release/deliverables/${encodeURIComponent(FOES)}/releases?release=${encodeURIComponent("foes@2.0.0")}`,
    );
    expect(
      within(drawer)
        .getByRole("link", { name: "Simulate this device" })
        .getAttribute("href"),
    ).toBe(`${SIM_HASH}?app=app%401.5.0&platform=android&channel=stable`);
  });

  it("opens a cell from the keyboard: one tab stop, arrows, Enter (CMP-2)", async () => {
    mountMatrix();
    await row("1.5.0");
    const first = screen.getAllByRole("gridcell")[0]!;
    first.focus();
    await userEvent.keyboard("{ArrowRight}{Enter}");
    await screen.findByRole("dialog");
    expect(hashQuery().get("cell")).toBe("app@1.5.0:foes@1.0.1");
  });

  it("pages through older releases with an offset in the URL, and back (CMP-5)", async () => {
    releaseCompat.mockImplementation(async (_slug, opts) => ({
      ...COMPAT,
      offset: opts?.offset ?? 0,
      older:
        (opts?.offset ?? 0) === 0
          ? COMPAT.older
          : { appReleases: 0, packReleases: 0 },
    }));
    mountMatrix();
    await row("1.5.0");
    expect(
      screen.getByText(/releases 1–10 of each channel, of 5/),
    ).toBeTruthy();
    const newer = screen.getByRole("button", { name: "‹ Newer" });
    expect(newer.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: "Older ›" }));
    await waitFor(() =>
      expect(releaseCompat).toHaveBeenLastCalledWith(SLUG, {
        limit: 10,
        offset: 10,
      }),
    );
    expect(hashQuery().get("offset")).toBe("10");
    await userEvent.click(screen.getByRole("button", { name: "‹ Newer" }));
    await waitFor(() => expect(hashQuery().get("offset")).toBeNull());
  });

  it("filters by pack, channel and live through the URL, with a no-results state", async () => {
    mountMatrix(`?pack=${encodeURIComponent(SKINS)}`);
    const row15 = await row("1.5.0");
    expect(within(row15).getAllByRole("gridcell")).toHaveLength(1);
    cleanup();
    mountMatrix("?channel=beta");
    expect(
      await screen.findByText("No releases match these filters"),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Clear filters" }),
    );
    await waitFor(() => expect(hashQuery().get("channel")).toBeNull());
    expect(await row("1.5.0")).toBeTruthy();
  });

  it("says a release outside Distribution's newest 50 is not tracked, not unserved (CMP-6)", async () => {
    distributionMatrix.mockReset().mockResolvedValue({
      ...MATRIX,
      releases: MATRIX.releases.filter((r) => r.releaseId === "app@1.5.0"),
    });
    mountMatrix();
    const row14 = await row("1.4.0");
    expect(
      await within(row14).findByText(
        "Not in the newest 50 releases tracked by Distribution",
      ),
    ).toBeTruthy();
  });

  it("marks a capped page without implementation detail", async () => {
    releaseCompat.mockReset().mockResolvedValue({ ...COMPAT, capped: true });
    mountMatrix();
    expect(
      await screen.findByText(/Showing the newest 200 app releases/),
    ).toBeTruthy();
  });

  it("overlays per-outlet liveness and holds from Distribution's shared matrix query (CMP-4)", async () => {
    mountMatrix();
    const row15 = await row("1.5.0");
    expect(
      await within(row15).findByText(/Outlets: direct, play/),
    ).toBeTruthy();
    expect(within(row15).getByText(/held on web/)).toBeTruthy();
    const row14 = await row("1.4.0");
    expect(within(row14).getByText("Outlets: app-store")).toBeTruthy();
    expect(distributionMatrix).toHaveBeenCalledWith(SLUG, {
      deliverable: "app",
      limit: 50,
    });
  });

  it("says the overlay is unavailable when Distribution does not answer", async () => {
    distributionMatrix
      .mockReset()
      .mockRejectedValue(new ApiError(404, undefined, "not_found"));
    mountMatrix();
    await row("1.5.0");
    expect(await screen.findByText("Outlet liveness unavailable")).toBeTruthy();
  });

  it("shows a skeleton, then the error with Retry (CMP-3), and first-run states", async () => {
    releaseCompat.mockReturnValueOnce(pending());
    const { container } = mountMatrix();
    await screen.findByRole("heading", { level: 1, name: "Compatibility" });
    expect(container.querySelector("[data-skeleton=matrix]")).toBeTruthy();
    cleanup();
    releaseCompat
      .mockReset()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce({ ...COMPAT, appReleases: [], cells: [] });
    mountMatrix();
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No app releases yet")).toBeTruthy();
  });

  it("passes axe", async () => {
    const { container } = mountMatrix();
    await row("1.5.0");
    await expectNoAxeViolations(container);
  });
});

describe("Update simulator (T6, CMP-8 to CMP-10)", () => {
  it("lists every app release, platforms from its builds, and sends the selector from the URL", async () => {
    mountSimulator();
    await userEvent.click(
      await screen.findByRole("button", { name: /App release/ }),
    );
    // Every release in the store, not just the matrix page (CMP-8).
    expect(
      await screen.findByRole("option", { name: /^1\.2\.0/ }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("option", { name: /^1\.5\.0/ }));
    await userEvent.click(screen.getByRole("combobox", { name: /Platform/ }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Android",
      "iOS / iPadOS",
    ]);
    await userEvent.click(screen.getByRole("option", { name: "Android" }));
    await userEvent.click(screen.getByRole("combobox", { name: /Outlet/ }));
    await userEvent.click(await screen.findByRole("option", { name: /^play/ }));
    await userEvent.click(screen.getByRole("combobox", { name: /Channel/ }));
    await userEvent.click(await screen.findByRole("option", { name: "beta" }));
    // Variant per axis, from the packs' declarations.
    await userEvent.click(screen.getByRole("combobox", { name: "texture" }));
    await userEvent.click(await screen.findByRole("option", { name: "etc2" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: /Device id/ }),
      "dev-1",
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: /Reported pack set/ }),
      RESULT.packSetId!,
    );
    expect(simulateUpdate).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Simulate" }));
    await waitFor(() => expect(simulateUpdate).toHaveBeenCalledTimes(1));
    expect(simulateUpdate).toHaveBeenCalledWith(SLUG, {
      appRelease: "app@1.5.0",
      platform: "android",
      outlet: "play",
      channel: "beta",
      variant: "texture=etc2",
      device: "dev-1",
      packSetId: RESULT.packSetId,
    });
    // The inputs are in the URL, so the result is shareable.
    expect(hashQuery().get("app")).toBe("app@1.5.0");
    expect(hashQuery().get("variant")).toBe("texture=etc2");
  });

  it("renders the full answer: decision and reason, feed, pack set, per-pack bindings (CMP-10)", async () => {
    mountSimulator(
      `?app=${encodeURIComponent("app@1.5.0")}&platform=android&packSet=${RESULT.packSetId}`,
    );
    const result = await screen.findByRole("region", {
      name: "Simulation result",
    });
    expect(within(result).getByTestId("sim-decision").textContent).toMatch(
      /None/,
    );
    expect(within(result).getByText("Because: up-to-date")).toBeTruthy();
    expect(within(result).getByText(/target 1\.5\.0/)).toBeTruthy();
    expect(within(result).getByText("Matches reported")).toBeTruthy();
    expect(
      within(result).getByText(/Build android \(arm64, aab\)/),
    ).toBeTruthy();
    const foes = result.querySelector(`[data-pack="${FOES}"]`) as HTMLElement;
    expect(within(foes).getByText("compatible → pinned")).toBeTruthy();
    expect(within(foes).getByText(/pinned by play-pad on play/)).toBeTruthy();
    expect(within(foes).getByText("≥ 2.0.0")).toBeTruthy();
    expect(
      within(result).getByRole("button", { name: "Copy result as JSON" }),
    ).toBeTruthy();
  });

  it("shows the simulated feed's delta menu (P4-29)", async () => {
    simulateUpdate
      .mockReset()
      .mockResolvedValue({ ...RESULT, feed: { ...RESULT.feed, deltas: 3 } });
    mountSimulator(`?app=${encodeURIComponent("app@1.5.0")}&platform=android`);
    const result = await screen.findByRole("region", {
      name: "Simulation result",
    });
    expect(within(result).getByText(/delta menu: 3 entries/)).toBeTruthy();
  });

  it("clears a stale result when the inputs change (CMP-9)", async () => {
    mountSimulator(`?app=${encodeURIComponent("app@1.5.0")}&platform=android`);
    await screen.findByRole("region", { name: "Simulation result" });
    await userEvent.type(
      screen.getByRole("textbox", { name: /Device id/ }),
      "x",
    );
    expect(
      screen.queryByRole("region", { name: "Simulation result" }),
    ).toBeNull();
    expect(screen.getByText(/The inputs changed/)).toBeTruthy();
  });

  it("validates a reported pack set before sending", async () => {
    mountSimulator(`?app=${encodeURIComponent("app@1.5.0")}&platform=android`);
    await screen.findByRole("region", { name: "Simulation result" });
    await userEvent.type(
      screen.getByRole("textbox", { name: /Reported pack set/ }),
      "nothex",
    );
    expect(
      screen.getByText("A pack set id is 64 lowercase hex characters."),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Simulate" }));
    expect(simulateUpdate).toHaveBeenCalledTimes(1);
  });

  it("shows the worker's refusal when a simulation fails", async () => {
    const refusal = new ApiError(404, undefined, "not_found");
    refusal.message = "nowhere is no live outlet of this product";
    simulateUpdate.mockReset().mockRejectedValue(refusal);
    mountSimulator(`?app=${encodeURIComponent("app@1.5.0")}&platform=android`);
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /no live outlet/,
    );
  });

  it("asks for an app release first", async () => {
    mountSimulator();
    expect(
      await screen.findByText(/Choose an app release and a platform/),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Simulate" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("passes axe", async () => {
    const { container } = mountSimulator(
      `?app=${encodeURIComponent("app@1.5.0")}&platform=android`,
    );
    await screen.findByRole("region", { name: "Simulation result" });
    await expectNoAxeViolations(container);
  });
});
