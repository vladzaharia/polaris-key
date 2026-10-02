/**
 * P2b-06 — the Distribution section's Matrix tab: releases × outlets with availability,
 * submission and rollout per cell. The view renders the worker's matrix as it is (which verbs a
 * rollout allows is the server's `controls`), a mirrored rollout has every control disabled, and
 * each control confirms its effect and then calls P2b-04's admin rollout route exactly once.
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
  DistributionMatrix,
  MatrixRolloutDto,
  ReleaseStoreResponse,
  RolloutVerb,
} from "../src/api.js";
import { ApiError } from "../src/api.js";
import { resetCache } from "../src/context.js";
import { Toaster } from "../src/components/ui/index.js";
import { SLUG, STORE } from "./releaseFixture.js";

const distributionMatrix =
  vi.fn<(slug: string) => Promise<DistributionMatrix>>();
const releases = vi.fn<(slug: string) => Promise<ReleaseStoreResponse>>();
const rolloutAction =
  vi.fn<
    (
      slug: string,
      outlet: string,
      channel: string,
      verb: RolloutVerb,
      body: { deliverable: string; releaseId: string },
    ) => Promise<unknown>
  >();

vi.mock("../src/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api.js")>()),
  api: {
    distributionMatrix: (slug: string) => distributionMatrix(slug),
    releases: (slug: string) => releases(slug),
    rolloutAction: (
      s: string,
      o: string,
      c: string,
      v: RolloutVerb,
      b: { deliverable: string; releaseId: string },
    ) => rolloutAction(s, o, c, v, b),
  },
}));

const { DistributionMatrixView } =
  await import("../src/views/distribution/Matrix.js");

function rollout(
  outletId: string,
  state: MatrixRolloutDto["state"],
  controls: RolloutVerb[],
  extra: Partial<MatrixRolloutDto> = {},
): MatrixRolloutDto {
  return {
    deliverableId: "app",
    outletId,
    channel: "stable",
    releaseId: "v0.4.2",
    rolloutBp: 2500,
    state,
    mirrored: false,
    source: "admin",
    startedAt: 1,
    updatedAt: 2,
    updatedBy: "admin:u1",
    controls,
    ...extra,
  };
}

const MATRIX: DistributionMatrix = {
  deliverableId: "app",
  limit: 20,
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
      transport: "apple-ba",
      derives: false,
      supported: false,
    },
    {
      outletId: "play",
      kind: "play",
      transport: "pkey-cdn",
      derives: false,
      supported: true,
    },
  ],
  releases: [
    {
      releaseId: "v0.4.2",
      version: "0.4.2",
      channel: "stable",
      publishedAt: 1,
      yanked: false,
    },
    {
      releaseId: "v0.4.0",
      version: "0.4.0",
      channel: "stable",
      publishedAt: 0,
      yanked: true,
    },
  ],
  cells: [
    {
      releaseId: "v0.4.2",
      outletId: "direct",
      availability: "live",
      records: [
        {
          releaseId: "v0.4.2",
          buildId: "macos-universal",
          outletId: "direct",
          transport: "pkey-cdn",
          state: "live",
          since: 1,
          source: "derived",
          derived: true,
          updatedAt: null,
        },
      ],
      submission: null,
      rollouts: [rollout("direct", "active", ["pause", "halt", "complete"])],
    },
    {
      releaseId: "v0.4.2",
      outletId: "app-store",
      availability: "in-review",
      records: [
        {
          releaseId: "v0.4.2",
          buildId: "",
          outletId: "app-store",
          transport: "pkey-cdn",
          state: "in-review",
          since: 1,
          source: "asc",
          derived: false,
          updatedAt: 2,
        },
      ],
      submission: {
        releaseId: "v0.4.2",
        outletId: "app-store",
        state: "submitted",
        submittedAt: 1,
        reviewedAt: null,
        source: "asc",
        updatedAt: 2,
      },
      rollouts: [],
    },
    {
      releaseId: "v0.4.2",
      outletId: "play",
      availability: "live",
      records: [],
      submission: null,
      rollouts: [
        rollout("play", "active", [], { mirrored: true, source: "play" }),
      ],
    },
    ...["direct", "app-store", "play"].map((outletId) => ({
      releaseId: "v0.4.0",
      outletId,
      availability: null,
      records: [],
      submission: null,
      rollouts: [],
    })),
  ],
  states: {
    availability: ["pending", "live"],
    submission: ["submitted"],
    rollout: ["active", "paused", "halted", "complete"],
  },
  effect: {
    reachesDevices: "signed-feed",
    note: "A pause or halt reaches devices through the signed feed (wire v4 SDKs). The legacy feeds keep serving it.",
  },
};

function renderView() {
  return render(
    <Toaster>
      <DistributionMatrixView slug={SLUG} />
    </Toaster>,
  );
}

function cellOf(release: string, outlet: string): HTMLElement {
  const row = document.querySelector(`tr[data-release="${release}"]`)!;
  return row.querySelector(`td[data-outlet="${outlet}"]`) as HTMLElement;
}

describe("Distribution — matrix", () => {
  beforeEach(() => {
    resetCache();
    distributionMatrix.mockReset();
    releases.mockReset();
    rolloutAction.mockReset();
    distributionMatrix.mockResolvedValue(MATRIX);
    releases.mockResolvedValue(STORE);
    rolloutAction.mockResolvedValue({ rollout: {} });
  });
  afterEach(cleanup);

  it("shows availability, submission and rollout per (release, outlet), and the halt caveat", async () => {
    renderView();
    await screen.findByRole("table", { name: "Distribution matrix" });
    expect(
      screen.getByText(/reaches devices through the signed feed/),
    ).toBeTruthy();
    const direct = cellOf("v0.4.2", "direct");
    expect(within(direct).getByText("live (derived)")).toBeTruthy();
    expect(within(direct).getByText("active")).toBeTruthy();
    expect(within(direct).getByText("25%")).toBeTruthy();
    const store = cellOf("v0.4.2", "app-store");
    expect(within(store).getByText("in-review")).toBeTruthy();
    // A transport v1 does not act on is named in its column header (P4-05).
    expect(screen.getByText("apple-ba: not supported yet")).toBeTruthy();
    expect(screen.queryAllByText(/not supported yet/)).toHaveLength(1);
    expect(within(store).getByText("submitted")).toBeTruthy();
    expect(
      within(cellOf("v0.4.0", "direct")).getByText("not available"),
    ).toBeTruthy();
    // The row header reuses P2-07's components: the yanked badge and payload SHA-256s.
    const yankedRow = document.querySelector('tr[data-release="v0.4.0"]')!;
    expect(within(yankedRow as HTMLElement).getByText("yanked")).toBeTruthy();
    const payloads = STORE.releases[0]!.artifacts.filter(
      (a) => a.role === "payload",
    );
    expect(payloads.length).toBeGreaterThan(0);
    const header = document.querySelector('tr[data-release="v0.4.2"] th')!;
    await waitFor(() =>
      expect(
        header.querySelector(`code[title="${payloads[0]!.sha256}"]`),
      ).toBeTruthy(),
    );
  });

  it("enables exactly the controls the server allows; a mirrored rollout has none", async () => {
    renderView();
    await screen.findByRole("table", { name: "Distribution matrix" });
    const direct = cellOf("v0.4.2", "direct");
    const enabled = (name: string) =>
      !(
        within(direct).getByRole("button", {
          name: `${name} direct/stable`,
        }) as HTMLButtonElement
      ).disabled;
    expect([
      enabled("Pause"),
      enabled("Resume"),
      enabled("Halt"),
      enabled("Complete"),
    ]).toEqual([true, false, true, true]);
    const play = cellOf("v0.4.2", "play");
    expect(within(play).getByText(/Mirrored from play/)).toBeTruthy();
    for (const verb of ["Pause", "Resume", "Halt", "Complete"])
      expect(
        (
          within(play).getByRole("button", {
            name: `${verb} play/stable`,
          }) as HTMLButtonElement
        ).disabled,
        verb,
      ).toBe(true);
  });

  it("a control confirms its effect, then calls P2b-04's rollout route once and refreshes", async () => {
    renderView();
    await screen.findByRole("table", { name: "Distribution matrix" });
    await userEvent.click(
      within(cellOf("v0.4.2", "direct")).getByRole("button", {
        name: "Halt direct/stable",
      }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(
      within(dialog).getByText(/Halt the rollout of 0.4.2 on direct\/stable/),
    ).toBeTruthy();
    expect(rolloutAction).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Halt" }));
    await waitFor(() => expect(rolloutAction).toHaveBeenCalledTimes(1));
    expect(rolloutAction).toHaveBeenCalledWith(
      SLUG,
      "direct",
      "stable",
      "halt",
      {
        deliverable: "app",
        releaseId: "v0.4.2",
      },
    );
    await waitFor(() => expect(distributionMatrix).toHaveBeenCalledTimes(2));
  });

  it("a refused control keeps the dialog's toast honest and changes nothing", async () => {
    rolloutAction.mockRejectedValue(
      new ApiError(
        409,
        undefined,
        "bad_request",
        undefined,
        "invalid_transition",
      ),
    );
    renderView();
    await screen.findByRole("table", { name: "Distribution matrix" });
    await userEvent.click(
      within(cellOf("v0.4.2", "direct")).getByRole("button", {
        name: "Complete direct/stable",
      }),
    );
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Complete" }),
    );
    await waitFor(() => expect(rolloutAction).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText(/Couldn’t complete the rollout/),
    ).toBeTruthy();
    expect(distributionMatrix).toHaveBeenCalledTimes(1);
  });

  it("says so when there are no releases or no outlets", async () => {
    distributionMatrix.mockResolvedValue({ ...MATRIX, outlets: [], cells: [] });
    renderView();
    expect(await screen.findByText("No outlets declared")).toBeTruthy();
  });
});
