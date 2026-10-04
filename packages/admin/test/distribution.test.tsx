import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { RolloutsResponse, ServicesResponse } from "../src/api.js";
import { resetCache } from "../src/context.js";

const services = vi.fn<(slug: string) => Promise<ServicesResponse>>();
const rollouts = vi.fn<(slug: string) => Promise<RolloutsResponse>>();

vi.mock("../src/api.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return {
    ...actual,
    api: {
      services: (slug: string) => services(slug),
      rollouts: (slug: string) => rollouts(slug),
    },
  };
});

const EMPTY_ROLLOUTS: RolloutsResponse = { rollouts: [] };

const { Distribution } = await import("../src/views/Distribution.js");

function state(on: Partial<Record<string, boolean>>): ServicesResponse {
  return {
    services: {
      license: { enabled: true },
      config: { enabled: true },
      release: { enabled: on.release ?? false },
      distribution: { enabled: on.distribution ?? false },
      update: { enabled: on.update ?? false },
      identity: { enabled: false },
    },
    registration: null,
    effectiveRegistration: "requires-license",
    source: "manifest",
  };
}

/**
 * The Distribution overview: the release ← distribution ← update chain, which Core descriptor
 * hook answers for this product, and (P2b-04) the outlet rollouts, read-only.
 */
describe("Distribution — overview", () => {
  beforeEach(() => {
    resetCache();
    services.mockReset();
    rollouts.mockReset();
    rollouts.mockResolvedValue(EMPTY_ROLLOUTS);
  });
  afterEach(cleanup);

  it("shows the chain and every hook answering when all three are on", async () => {
    services.mockResolvedValue(
      state({ release: true, distribution: true, update: true }),
    );
    render(<Distribution slug="djdl" />);
    const table = (await screen.findAllByRole("table")).at(-1)!;
    for (const hook of ["releaseCatalog", "delivery", "outletCapabilities"]) {
      const row = within(table).getByText(hook).closest("tr")!;
      expect(within(row).getByText("answering")).toBeTruthy();
    }
    expect(screen.getAllByText("on")).toHaveLength(3);
  });

  it("marks a hook null when the service that provides it is off", async () => {
    // Distribution on with Release off is incoherent for the validators, but a hand-edited row
    // can still say it — the view must report what the hooks would actually answer.
    services.mockResolvedValue(state({ distribution: true }));
    render(<Distribution slug="djdl" />);
    const table = (await screen.findAllByRole("table")).at(-1)!;
    const catalog = within(table).getByText("releaseCatalog").closest("tr")!;
    expect(within(catalog).getByText("null")).toBeTruthy();
    const delivery = within(table).getByText("delivery").closest("tr")!;
    expect(within(delivery).getByText("answering")).toBeTruthy();
  });

  it("lists outlet rollouts without an implementation-status caveat (P2b-04)", async () => {
    services.mockResolvedValue(
      state({ release: true, distribution: true, update: true }),
    );
    rollouts.mockResolvedValue({
      rollouts: [
        {
          deliverableId: "app",
          outletId: "direct",
          channel: "stable",
          releaseId: "v1.4.0",
          rolloutBp: 2500,
          state: "halted",
          mirrored: false,
          source: "ci",
          startedAt: 1,
          updatedAt: 2,
          updatedBy: "ci:static:tok",
        },
      ],
    });
    render(<Distribution slug="djdl" />);
    const row = (await screen.findByText("v1.4.0")).closest("tr")!;
    expect(within(row).getByText("25%")).toBeTruthy();
    expect(within(row).getByText("halted")).toBeTruthy();
    // The signed feed carries halts (P3-03), so no "not yet" warning sits above the list.
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.queryByText(/legacy feeds|yank it or pin/)).toBeNull();
  });
});
