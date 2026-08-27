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
  ProfileDetail as ProfileDetailDto,
  ProfileSummary,
} from "../src/api.js";
import { resetCache } from "../src/context.js";
import { Toaster } from "../src/components/ui/index.js";
import { Profiles } from "../src/views/Profiles.js";
import { ProfileDetail } from "../src/views/profiles/ProfileDetail.js";

// The Profiles views are the only units under test; `api` is fully mocked so we assert rendering
// + which methods each flow calls (list / create / payload-edit via putProfilePayload / delete).
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

import { api, ApiError } from "../src/api.js";

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

const DETAIL: ProfileDetailDto = {
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

function renderDetail() {
  return render(
    <Toaster>
      <ProfileDetail slug="djdl" id="default" />
    </Toaster>,
  );
}

beforeEach(() => {
  resetCache();
  vi.clearAllMocks();
  window.location.hash = "";
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

  it("links each row to the profile's own detail route", async () => {
    // Editing is a routed page, not a modal — so a profile has a URL an operator can share.
    renderProfiles();
    const link = (await screen.findByText("Default")) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("#/p/djdl/profiles/default");
  });

  it("creates a profile via createProfile, then goes straight to its editor", async () => {
    mockApi.createProfile.mockResolvedValue({ ok: true, id: "trial" });
    renderProfiles();
    await screen.findByText("Default");

    await userEvent.click(screen.getByRole("button", { name: /New profile/ }));
    const dialog = await screen.findByRole("dialog");

    // One pane, three fields — the create step only collects identity.
    expect(within(dialog).queryByRole("tab")).toBeNull();
    await userEvent.type(
      within(dialog).getByRole("textbox", { name: /^Id/ }),
      "trial",
    );
    await userEvent.type(within(dialog).getByLabelText("Name"), "Trial");
    await userEvent.type(
      within(dialog).getByLabelText("Description"),
      "Time-limited",
    );
    await userEvent.click(
      within(dialog).getByRole("button", { name: /Create & configure/ }),
    );

    await waitFor(() => expect(mockApi.createProfile).toHaveBeenCalledTimes(1));
    const [slug, body] = mockApi.createProfile.mock.calls[0]!;
    expect(slug).toBe("djdl");
    expect(body).toMatchObject({
      id: "trial",
      name: "Trial",
      description: "Time-limited",
    });
    // Create THEN edit: the payload is set on the profile's own page.
    await waitFor(() =>
      expect(window.location.hash).toBe("#/p/djdl/profiles/trial"),
    );
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

describe("Profile detail — the routed payload editor", () => {
  it("renders the profile header with a way back to the list", async () => {
    renderDetail();
    expect(await screen.findByText("Default")).toBeTruthy();
    expect(
      (
        screen.getByRole("link", {
          name: /Back to profiles/,
        }) as HTMLAnchorElement
      ).getAttribute("href"),
    ).toBe("#/p/djdl/profiles");
    expect(mockApi.profile).toHaveBeenCalledWith("djdl", "default");
  });

  it("groups the catalog-driven editor by category", async () => {
    renderDetail();
    expect(
      await screen.findByRole("button", { name: /appearance/ }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /flags/ })).toBeTruthy();
    expect(await screen.findByLabelText("Theme")).toBeTruthy();
  });

  it("edits its managed payload via putProfilePayload", async () => {
    mockApi.putProfilePayload.mockResolvedValue({ ok: true, id: "default" });
    renderDetail();

    const theme = (await screen.findByLabelText("Theme")) as HTMLInputElement;
    await userEvent.clear(theme);
    await userEvent.type(theme, "light");
    await userEvent.click(
      await screen.findByRole("button", { name: /Save payload/ }),
    );

    await waitFor(() =>
      expect(mockApi.putProfilePayload).toHaveBeenCalledTimes(1),
    );
    const [slug, id, updates] = mockApi.putProfilePayload.mock.calls[0]!;
    expect(slug).toBe("djdl");
    expect(id).toBe("default");
    // A set row always carries its state, so a later demotion to Default cannot delete it.
    expect(updates).toEqual([
      { key: "theme", state: "default", value: "light" },
    ]);
  });

  it("shows an unset catalog key as 'Not set' rather than as a blank value", async () => {
    // `beta_features` IS in the payload; add a key the payload does not mention.
    mockApi.schema.mockResolvedValue({
      ...CATALOG,
      entries: [
        ...CATALOG.entries,
        {
          key: "telemetry",
          kind: "config",
          category: "privacy",
          label: "Telemetry",
          description: "Send usage data",
          schema: { type: "boolean" },
          default: false,
        },
      ],
    });
    renderDetail();
    expect(await screen.findByText("Not set")).toBeTruthy();
    expect(screen.queryByLabelText("Telemetry")).toBeNull();
  });

  it("maps a 422's catalog-validated fields back onto the rows that caused them", async () => {
    mockApi.putProfilePayload.mockRejectedValue(
      new ApiError(422, ['theme must be one of "dark", "light"']),
    );
    renderDetail();

    const theme = (await screen.findByLabelText("Theme")) as HTMLInputElement;
    await userEvent.clear(theme);
    await userEvent.type(theme, "chartreuse");
    await userEvent.click(
      await screen.findByRole("button", { name: /Save payload/ }),
    );

    // Inline on the row, not a toast that names no control.
    expect(
      await screen.findByText('must be one of "dark", "light"'),
    ).toBeTruthy();
  });

  it("points at the catalog when the product declares no config keys", async () => {
    mockApi.schema.mockResolvedValue({ schemaVersion: 1, entries: [] });
    renderDetail();
    expect(
      await screen.findByText("This product has no config catalog"),
    ).toBeTruthy();
  });

  it("surfaces a catalog load failure with a retry", async () => {
    mockApi.schema.mockRejectedValue(new Error("nope"));
    renderDetail();
    expect(await screen.findByText("Could not load the catalog")).toBeTruthy();
  });
});
