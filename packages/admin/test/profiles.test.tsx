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
  ProductCatalog,
  ProfileDetail,
  ProfileSummary,
} from "../src/api.js";
import { resetCache } from "../src/context.js";
import { Toaster } from "../src/components/ui/index.js";
import { Profiles } from "../src/views/Profiles.js";

// The Profiles view is the only unit under test; `api` is fully mocked so we assert rendering +
// which methods each flow calls (list / create / payload-edit via putProfilePayload / delete).
vi.mock("../src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api.js")>();
  return {
    ...actual,
    api: {
      profiles: vi.fn(),
      profile: vi.fn(),
      createProfile: vi.fn(),
      putProfilePayload: vi.fn(),
      deleteProfile: vi.fn(),
      schema: vi.fn(),
    },
  };
});

import { api } from "../src/api.js";

const mockApi = api as unknown as {
  profiles: ReturnType<typeof vi.fn>;
  profile: ReturnType<typeof vi.fn>;
  createProfile: ReturnType<typeof vi.fn>;
  putProfilePayload: ReturnType<typeof vi.fn>;
  deleteProfile: ReturnType<typeof vi.fn>;
  schema: ReturnType<typeof vi.fn>;
};

const PROFILES: ProfileSummary[] = [
  {
    id: "default",
    name: "Default",
    description: "Baseline config",
    modifiedBy: "ada@x.io",
    modifiedAt: 1_700_000_000,
  },
  { id: "vip", name: "VIP" },
];

const CATALOG: ProductCatalog = {
  schemaVersion: 2,
  entries: [
    {
      key: "theme",
      kind: "config",
      category: "appearance",
      label: "Theme",
      description: "UI theme",
      schema: { type: "string" },
    },
    {
      key: "beta_features",
      kind: "flag",
      category: "flags",
      label: "Beta features",
      description: "Enable beta",
      schema: { type: "boolean" },
    },
  ],
};

const DETAIL: ProfileDetail = {
  id: "default",
  name: "Default",
  description: "Baseline config",
  payload: {
    config: {
      theme: { state: "default", value: "dark", updatedAt: 1_700_000_000 },
    },
    secrets: {},
    entitlements: {
      beta_features: { state: "default", value: false, updatedAt: 0 },
    },
  },
};

function renderProfiles() {
  return render(
    <Toaster>
      <Profiles slug="djdl" />
    </Toaster>,
  );
}

beforeEach(() => {
  resetCache();
  vi.clearAllMocks();
  mockApi.profiles.mockResolvedValue({ profiles: PROFILES });
  mockApi.profile.mockResolvedValue(DETAIL);
  mockApi.schema.mockResolvedValue(CATALOG);
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

describe("Profiles view", () => {
  it("lists profiles with id, name, description, and last-modified", async () => {
    renderProfiles();
    expect(await screen.findByText("Default")).toBeTruthy();
    expect(screen.getByText("VIP")).toBeTruthy();
    expect(screen.getByText("Baseline config")).toBeTruthy();
    // Last-modified shows the actor.
    expect(screen.getByText(/ada@x\.io/)).toBeTruthy();
  });

  it("shows the empty state when there are no profiles", async () => {
    mockApi.profiles.mockResolvedValue({ profiles: [] });
    renderProfiles();
    expect(await screen.findByText("No profiles yet")).toBeTruthy();
  });

  it("surfaces an error state with a retry affordance", async () => {
    mockApi.profiles.mockRejectedValue(new Error("boom"));
    renderProfiles();
    expect(await screen.findByText("Could not load profiles")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeTruthy();
  });

  it("creates a profile via createProfile", async () => {
    mockApi.createProfile.mockResolvedValue({ ok: true, id: "trial" });
    renderProfiles();
    await screen.findByText("Default");

    await userEvent.click(screen.getByRole("button", { name: /New profile/ }));
    const dialog = await screen.findByRole("dialog");

    await userEvent.type(within(dialog).getByLabelText(/^Id/), "trial");
    await userEvent.type(within(dialog).getByLabelText("Name"), "Trial");
    await userEvent.type(
      within(dialog).getByLabelText("Description"),
      "Time-limited",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create profile" }),
    );

    await waitFor(() => expect(mockApi.createProfile).toHaveBeenCalledTimes(1));
    const [slug, body] = mockApi.createProfile.mock.calls[0]!;
    expect(slug).toBe("djdl");
    expect(body).toMatchObject({
      id: "trial",
      name: "Trial",
      description: "Time-limited",
    });
  });

  it("opens a profile and edits its managed payload via putProfilePayload", async () => {
    mockApi.putProfilePayload.mockResolvedValue({ ok: true, id: "default" });
    renderProfiles();
    await screen.findByText("Default");

    // Open the editor for the default profile.
    await userEvent.click(screen.getByRole("button", { name: "Edit default" }));
    const dialog = await screen.findByRole("dialog");
    // The catalog-driven editor loaded the profile + schema and rendered the managed fields.
    await within(dialog).findByLabelText("Theme");
    expect(mockApi.profile).toHaveBeenCalledWith("djdl", "default");

    // Change the Theme value, then save.
    const theme = within(dialog).getByLabelText("Theme") as HTMLInputElement;
    await userEvent.clear(theme);
    await userEvent.type(theme, "light");
    await userEvent.click(
      within(dialog).getByRole("button", { name: /Save payload/ }),
    );

    await waitFor(() =>
      expect(mockApi.putProfilePayload).toHaveBeenCalledTimes(1),
    );
    const [slug, id, updates] = mockApi.putProfilePayload.mock.calls[0]!;
    expect(slug).toBe("djdl");
    expect(id).toBe("default");
    expect(updates).toEqual([{ key: "theme", value: "light" }]);
  });

  it("confirms before deleting and calls deleteProfile on confirm", async () => {
    mockApi.deleteProfile.mockResolvedValue({ ok: true, id: "vip" });
    renderProfiles();
    await screen.findByText("VIP");

    await userEvent.click(screen.getByRole("button", { name: "Delete vip" }));
    const confirmDialog = await screen.findByRole("alertdialog");
    expect(
      within(confirmDialog).getByText(/Delete profile “vip”\?/),
    ).toBeTruthy();
    expect(mockApi.deleteProfile).not.toHaveBeenCalled();

    await userEvent.click(
      within(confirmDialog).getByRole("button", { name: "Delete profile" }),
    );
    await waitFor(() =>
      expect(mockApi.deleteProfile).toHaveBeenCalledWith("djdl", "vip"),
    );
  });
});
