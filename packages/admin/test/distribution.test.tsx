import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ServicesResponse } from "../src/api.js";
import { resetCache } from "../src/context.js";

const services = vi.fn<(slug: string) => Promise<ServicesResponse>>();

vi.mock("../src/api.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return { ...actual, api: { services: (slug: string) => services(slug) } };
});

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
 * The Distribution overview (P2b-01): the release ← distribution ← update chain, and which Core
 * descriptor hook answers for this product. Read-only — there is no Distribution admin API yet.
 */
describe("Distribution — overview", () => {
  beforeEach(() => {
    resetCache();
    services.mockReset();
  });
  afterEach(cleanup);

  it("shows the chain and every hook answering when all three are on", async () => {
    services.mockResolvedValue(
      state({ release: true, distribution: true, update: true }),
    );
    render(<Distribution slug="djdl" />);
    const table = await screen.findByRole("table");
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
    const table = await screen.findByRole("table");
    const catalog = within(table).getByText("releaseCatalog").closest("tr")!;
    expect(within(catalog).getByText("null")).toBeTruthy();
    const delivery = within(table).getByText("delivery").closest("tr")!;
    expect(within(delivery).getByText("answering")).toBeTruthy();
  });
});
