import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ProfileSummary, TierSummary } from "../src/api.js";
import { resetCache } from "../src/context.js";
import { Toaster } from "../src/components/ui/index.js";
import { Tiers } from "../src/views/Tiers.js";

// The Tiers view is the only unit under test; `api` is fully mocked so we assert the component's
// rendering + which methods each flow calls (list / create-with-channels / edit / delete).
vi.mock("../src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api.js")>();
  return {
    ...actual,
    api: {
      tiers: vi.fn(),
      profiles: vi.fn(),
      createTier: vi.fn(),
      patchTier: vi.fn(),
      deleteTier: vi.fn(),
    },
  };
});

import { api } from "../src/api.js";

const mockApi = api as unknown as {
  tiers: ReturnType<typeof vi.fn>;
  profiles: ReturnType<typeof vi.fn>;
  createTier: ReturnType<typeof vi.fn>;
  patchTier: ReturnType<typeof vi.fn>;
  deleteTier: ReturnType<typeof vi.fn>;
};

const PRO: TierSummary = {
  id: "pro",
  label: "Pro",
  profile: "default",
  policyExpiryDays: 365,
  policyDeviceLimit: 5,
  channels: ["stable", "beta"],
  minVersion: "1.0.0",
  maxVersion: null,
};

const FREE: TierSummary = {
  id: "free",
  label: "Free",
  profile: null,
  policyExpiryDays: null,
  policyDeviceLimit: null,
  channels: [],
  minVersion: null,
  maxVersion: null,
};

const PROFILES: ProfileSummary[] = [
  { id: "default", name: "Default" },
  { id: "vip", name: "VIP" },
];

function renderTiers() {
  return render(
    <Toaster>
      <Tiers slug="djdl" />
    </Toaster>,
  );
}

beforeEach(() => {
  resetCache();
  vi.clearAllMocks();
  mockApi.tiers.mockResolvedValue({ tiers: [PRO, FREE] });
  mockApi.profiles.mockResolvedValue({ profiles: PROFILES });
  // jsdom lacks these Radix-needed APIs.
  (
    Element.prototype as unknown as { hasPointerCapture: () => boolean }
  ).hasPointerCapture = () => false;
  (
    Element.prototype as unknown as { scrollIntoView: () => void }
  ).scrollIntoView = () => undefined;
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
});

afterEach(cleanup);

describe("Tiers view", () => {
  it("lists tiers with label, profile, policies, channels, and version window", async () => {
    renderTiers();
    expect(await screen.findByText("Pro")).toBeTruthy();
    expect(screen.getByText("Free")).toBeTruthy();
    // Profile resolves to its display name.
    expect(screen.getByText("Default")).toBeTruthy();
    // Policy numbers render.
    expect(screen.getByText("365")).toBeTruthy();
    // Channels render as badges.
    expect(screen.getByText("stable")).toBeTruthy();
    expect(screen.getByText("beta")).toBeTruthy();
    // Version window for Pro: min set, max open.
    expect(screen.getByText(/1\.0\.0/)).toBeTruthy();
  });

  it("shows the empty state when there are no tiers", async () => {
    mockApi.tiers.mockResolvedValue({ tiers: [] });
    renderTiers();
    expect(await screen.findByText("No tiers yet")).toBeTruthy();
  });

  it("surfaces an error state with a retry affordance", async () => {
    mockApi.tiers.mockRejectedValue(new Error("boom"));
    renderTiers();
    expect(await screen.findByText("Could not load tiers")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeTruthy();
  });

  it("creates a tier with selected channels via createTier", async () => {
    mockApi.createTier.mockResolvedValue({ ok: true, id: "team" });
    renderTiers();
    await screen.findByText("Pro");

    await userEvent.click(screen.getByRole("button", { name: /New tier/ }));
    const dialog = await screen.findByRole("dialog");

    await userEvent.type(within(dialog).getByLabelText(/^Id/), "team");
    await userEvent.type(within(dialog).getByLabelText("Label"), "Team");
    expect(within(dialog).getByRole("tab", { name: "Basics" })).toBeTruthy();
    expect(within(dialog).getByRole("tab", { name: "Policy" })).toBeTruthy();
    expect(within(dialog).getByRole("tab", { name: "Channels" })).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole("tab", { name: "Channels" }),
    );
    // Select the "stable" channel checkbox.
    await userEvent.click(within(dialog).getByLabelText("stable"));
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create tier" }),
    );

    await waitFor(() => expect(mockApi.createTier).toHaveBeenCalledTimes(1));
    const [slug, body] = mockApi.createTier.mock.calls[0]!;
    expect(slug).toBe("djdl");
    expect(body).toMatchObject({
      id: "team",
      label: "Team",
      channels: ["stable"],
    });
  });

  it("blocks create when the id is already taken", async () => {
    renderTiers();
    await screen.findByText("Pro");
    await userEvent.click(screen.getByRole("button", { name: /New tier/ }));
    const dialog = await screen.findByRole("dialog");

    await userEvent.type(within(dialog).getByLabelText(/^Id/), "pro");
    expect(within(dialog).getByText(/already exists/)).toBeTruthy();
    const createBtn = within(dialog).getByRole("button", {
      name: "Create tier",
    }) as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);
    expect(mockApi.createTier).not.toHaveBeenCalled();
  });

  it("edits a tier's channels and version window via patchTier", async () => {
    mockApi.patchTier.mockResolvedValue({ ok: true, id: "pro" });
    renderTiers();
    await screen.findByText("Pro");

    await userEvent.click(screen.getByRole("button", { name: "Edit pro" }));
    const dialog = await screen.findByRole("dialog");

    // Pro starts with stable+beta selected; untick beta and set a max version.
    await userEvent.click(
      within(dialog).getByRole("tab", { name: "Channels" }),
    );
    expect(
      within(dialog).getByLabelText("beta").getAttribute("aria-checked"),
    ).toBe("true");
    await userEvent.click(within(dialog).getByLabelText("beta"));
    await userEvent.click(within(dialog).getByRole("tab", { name: "Policy" }));
    await userEvent.type(within(dialog).getByLabelText("Max version"), "2.0.0");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );

    await waitFor(() => expect(mockApi.patchTier).toHaveBeenCalledTimes(1));
    const [slug, id, body] = mockApi.patchTier.mock.calls[0]!;
    expect(slug).toBe("djdl");
    expect(id).toBe("pro");
    expect(body.channels).toEqual(["stable"]);
    expect(body.maxVersion).toBe("2.0.0");
  });

  it("confirms before deleting and calls deleteTier on confirm", async () => {
    mockApi.deleteTier.mockResolvedValue({ ok: true, id: "free" });
    renderTiers();
    await screen.findByText("Free");

    await userEvent.click(screen.getByRole("button", { name: "Delete free" }));
    const confirmDialog = await screen.findByRole("alertdialog");
    expect(
      within(confirmDialog).getByText(/Delete tier “free”\?/),
    ).toBeTruthy();
    expect(mockApi.deleteTier).not.toHaveBeenCalled();

    await userEvent.click(
      within(confirmDialog).getByRole("button", { name: "Delete tier" }),
    );
    await waitFor(() =>
      expect(mockApi.deleteTier).toHaveBeenCalledWith("djdl", "free"),
    );
  });
});
