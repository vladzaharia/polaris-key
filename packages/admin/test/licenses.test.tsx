import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";

// The licenses views talk to the typed `api` client; mock the CLIENT but keep the module's real
// exports (`ApiError` in particular — the override editor branches on it to place a 422 on the
// row that caused it). `vi.mock` is hoisted, so the factory must not close over outer `let`s.
vi.mock("../src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api.js")>();
  return {
    ...actual,
    api: {
      licenses: vi.fn(),
      license: vi.fn(),
      schema: vi.fn(),
      createLicense: vi.fn(),
      tiers: vi.fn(),
      profiles: vi.fn(),
      profile: vi.fn(),
      patchLicense: vi.fn(),
      setLicenseEnabled: vi.fn(),
      putLicenseOverrides: vi.fn(),
      mintKey: vi.fn(),
      revokeKey: vi.fn(),
      deauthorizeDevice: vi.fn(),
      services: vi.fn(),
      mintBundle: vi.fn(),
      releases: vi.fn(),
    },
  };
});

import {
  api,
  ApiError,
  type LicenseDetail as LicenseDetailDto,
  type LicenseSummary,
  type ProductCatalog,
  type ServicesResponse,
} from "../src/api.js";
import { AdminProvider, resetCache } from "../src/context.js";
import { Toaster } from "../src/components/ui/index.js";
import { Licenses } from "../src/views/Licenses.js";
import { LicenseDetail } from "../src/views/LicenseDetail.js";

const mockApi = api as unknown as Record<
  keyof typeof api,
  ReturnType<typeof vi.fn>
>;

const ME = {
  sub: "u1",
  name: "Ada Lovelace",
  email: "ada@x.io",
  csrf: "csrf",
  platformAdmin: true,
  products: [{ slug: "djdl", name: "DJDL", schemaVersion: 2 }],
};

function withProviders(node: ReactElement) {
  return render(
    <AdminProvider
      value={{ me: ME, product: "djdl", setProduct: () => undefined }}
    >
      <Toaster>{node}</Toaster>
    </AdminProvider>,
  );
}

const SUMMARY: LicenseSummary = {
  id: "lic_1",
  name: "Ada Lovelace",
  email: "ada@x.io",
  status: "active",
  activatedAt: 1_700_000_000,
  expiresAt: null,
  keyCount: 2,
  activeKeyCount: 1,
  deviceCount: 1,
  profile: null,
  tier: "pro",
  channels: ["stable", "beta"],
  minVersion: null,
  maxVersion: null,
  identityProvider: "manual",
};

const DETAIL: LicenseDetailDto = {
  ...SUMMARY,
  maxOfflineDays: 14,
  overrides: {
    config: {
      "feature.timeout": {
        state: "default",
        value: 30,
        updatedAt: 1_700_000_000,
      },
    },
    secrets: {
      "api.token": {
        state: "enforced",
        configured: true,
        updatedAt: 1_700_000_000,
      },
    },
    entitlements: {
      "flag.pro": { state: "hidden", value: true, updatedAt: 1_700_000_000 },
    },
  },
  keys: [
    {
      hash: "abcdef0123456789abcdef",
      status: "active",
      label: "laptop",
      createdAt: 1_700_000_000,
      createdBy: "ada@x.io",
    },
    {
      hash: "deadbeef0000111122223333",
      status: "revoked",
      createdAt: 1_699_000_000,
      createdBy: "ada@x.io",
    },
  ],
  devices: [
    {
      deviceId: "dev_1",
      status: "active",
      firstSeen: 1_699_000_000,
      lastSeen: 1_700_000_000,
      ua: "Mozilla/5.0",
    },
  ],
};

const CATALOG: ProductCatalog = {
  schemaVersion: 2,
  entries: [
    {
      key: "feature.timeout",
      kind: "config",
      category: "general",
      label: "Timeout",
      description: "Request timeout in seconds.",
      schema: { type: "integer", minimum: 1, maximum: 120 },
    },
    {
      key: "api.token",
      kind: "secret",
      category: "secrets",
      label: "API token",
      description: "Upstream API token.",
      schema: { type: "string" },
    },
    {
      key: "flag.pro",
      kind: "flag",
      category: "entitlements",
      label: "Pro features",
      description: "Unlocks pro features.",
      schema: { type: "boolean" },
    },
  ],
};

/** Both bundle-carrying services on — the default shape a product ships with. */
const SERVICES: ServicesResponse = {
  services: {
    license: { enabled: true },
    config: { enabled: true },
    release: { enabled: false },
    distribution: { enabled: false },
    update: { enabled: false },
    identity: { enabled: false },
  },
  registration: null,
  effectiveRegistration: "requires-license",
  source: "manifest",
};

/** A well-formed request code: 32 base64url characters, as the app's offline screen shows it. */
const DEVICE_REQUEST_CODE = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";

beforeEach(() => {
  resetCache();
  for (const fn of Object.values(mockApi)) fn.mockReset();
  mockApi.licenses.mockResolvedValue({ licenses: [SUMMARY] });
  mockApi.license.mockResolvedValue(DETAIL);
  mockApi.schema.mockResolvedValue(CATALOG);
  mockApi.tiers.mockResolvedValue({ tiers: [] });
  mockApi.profiles.mockResolvedValue({ profiles: [] });
  mockApi.createLicense.mockResolvedValue({
    licenseId: "lic_2",
    key: "PK-NEWKEY-ONESHOT",
    license: SUMMARY,
  });
  mockApi.patchLicense.mockResolvedValue({ ok: true, id: "lic_1" });
  mockApi.setLicenseEnabled.mockResolvedValue({
    ok: true,
    id: "lic_1",
    status: "disabled",
  });
  mockApi.putLicenseOverrides.mockResolvedValue({ ok: true, id: "lic_1" });
  mockApi.mintKey.mockResolvedValue({
    key: "PK-MINTED-ONESHOT",
    hash: "newhash",
    record: DETAIL.keys[0]!,
  });
  mockApi.revokeKey.mockResolvedValue({
    ok: true,
    hash: "abcdef",
    status: "revoked",
  });
  mockApi.deauthorizeDevice.mockResolvedValue({
    ok: true,
    deviceId: "dev_1",
  });
  mockApi.services.mockResolvedValue(SERVICES);
  mockApi.releases.mockResolvedValue({ releases: [], channels: [] });
  mockApi.mintBundle.mockResolvedValue({
    bundleId: "01JBUNDLEID0000000000000A",
    bundle: "eyJhbGciOiJFZERTQSJ9.e30.sig",
  });
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

describe("Licenses list", () => {
  it("loads and renders the license rows", async () => {
    withProviders(<Licenses slug="djdl" />);
    expect(await screen.findByText("ada@x.io")).toBeTruthy();
    expect(screen.getByText("lic_1")).toBeTruthy();
    // Status + tier + identity are surfaced.
    expect(screen.getByText("active")).toBeTruthy();
    expect(screen.getByText("pro")).toBeTruthy();
    expect(mockApi.licenses).toHaveBeenCalledWith("djdl");
  });

  it("shows the empty state when there are no licenses", async () => {
    mockApi.licenses.mockResolvedValue({ licenses: [] });
    withProviders(<Licenses slug="djdl" />);
    expect(await screen.findByText("No licenses yet")).toBeTruthy();
  });

  it("surfaces an error with a retry", async () => {
    mockApi.licenses.mockRejectedValue(new Error("boom"));
    withProviders(<Licenses slug="djdl" />);
    expect(await screen.findByText("Could not load licenses")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("creates a license and reveals the minted key exactly once", async () => {
    const user = userEvent.setup();
    withProviders(<Licenses slug="djdl" />);
    await screen.findByText("ada@x.io");

    await user.click(screen.getByRole("button", { name: "Create license" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("tab", { name: "Holder" })).toBeTruthy();
    expect(within(dialog).getByRole("tab", { name: "Policy" })).toBeTruthy();
    expect(within(dialog).getByRole("tab", { name: "Profiles" })).toBeTruthy();
    await user.type(within(dialog).getByLabelText(/Name/), "Grace Hopper");
    await user.type(within(dialog).getByLabelText(/Email/), "grace@x.io");
    await user.click(within(dialog).getByRole("tab", { name: "Policy" }));
    fireEvent.change(within(dialog).getByLabelText(/Expires/), {
      target: { value: "2026-12-31" },
    });
    await user.type(within(dialog).getByLabelText(/Max offline days/), "21");
    await user.click(within(dialog).getByLabelText("stable"));
    await user.type(within(dialog).getByLabelText(/Minimum version/), "1.2.0");
    await user.type(within(dialog).getByLabelText(/Maximum version/), "2.0.0");
    expect(within(dialog).getByText("Effective policy summary")).toBeTruthy();
    expect(within(dialog).getByText("21 days")).toBeTruthy();
    await user.click(
      within(dialog).getByRole("button", { name: "Create license" }),
    );

    // The one-time key is shown in a copyable panel that warns it is shown only once.
    const panel = await within(dialog).findByRole("status");
    expect(within(panel).getByText("PK-NEWKEY-ONESHOT")).toBeTruthy();
    expect(within(panel).getByText("License key minted")).toBeTruthy();
    expect(within(panel).getByText(/shown only once/i)).toBeTruthy();
    expect(mockApi.createLicense).toHaveBeenCalledWith("djdl", {
      name: "Grace Hopper",
      email: "grace@x.io",
      expiresAt: Math.floor(Date.parse("2026-12-31T00:00:00Z") / 1000),
      maxOfflineDays: 21,
      channels: ["stable"],
      minVersion: "1.2.0",
      maxVersion: "2.0.0",
    });
    // There is a copy button with an accessible name.
    expect(
      within(panel).getByRole("button", { name: "Copy key" }),
    ).toBeTruthy();
  });

  it("validates license creation before submitting", async () => {
    const user = userEvent.setup();
    withProviders(<Licenses slug="djdl" />);
    await screen.findByText("ada@x.io");

    await user.click(screen.getByRole("button", { name: "Create license" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/Name/), "Grace Hopper");
    await user.type(within(dialog).getByLabelText(/Email/), "bad-email");
    await user.click(within(dialog).getByRole("tab", { name: "Policy" }));
    await user.type(within(dialog).getByLabelText(/Max offline days/), "-1");
    await user.click(
      within(dialog).getByRole("button", { name: "Create license" }),
    );

    expect(
      await within(dialog).findByText("Enter a valid email address."),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole("tab", { name: "Policy" }));
    expect(
      within(dialog).getByText("Enter a whole number of days, 0 or higher."),
    ).toBeTruthy();
    expect(mockApi.createLicense).not.toHaveBeenCalled();
  });
});

describe("License detail", () => {
  async function renderDetail() {
    const user = userEvent.setup();
    withProviders(<LicenseDetail slug="djdl" id="lic_1" />);
    await screen.findByRole("heading", { name: "Ada Lovelace" });
    return user;
  }

  it("renders the header, status, and metadata", async () => {
    await renderDetail();
    expect(screen.getAllByText("active").length).toBeGreaterThan(0);
    expect(screen.getByText("14")).toBeTruthy(); // max offline days
    expect(screen.getByText("Effective update policy")).toBeTruthy();
    expect(screen.getByText("stable, beta")).toBeTruthy();
    expect(mockApi.license).toHaveBeenCalledWith("djdl", "lic_1");
  });

  it("confirms before disabling and calls setLicenseEnabled(false)", async () => {
    const user = await renderDetail();
    await user.click(screen.getByRole("switch", { name: "Disable license" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Disable" }));
    await waitFor(() =>
      expect(mockApi.setLicenseEnabled).toHaveBeenCalledWith(
        "djdl",
        "lic_1",
        false,
      ),
    );
  });

  it("mints a key and reveals it once", async () => {
    const user = await renderDetail();
    await user.click(screen.getByRole("tab", { name: /Keys/ }));
    await user.click(screen.getByRole("button", { name: "Mint key" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Mint key" }));
    expect(await within(dialog).findByText("PK-MINTED-ONESHOT")).toBeTruthy();
    expect(mockApi.mintKey).toHaveBeenCalledWith("djdl", "lic_1", undefined);
  });

  it("confirms before revoking a key", async () => {
    const user = await renderDetail();
    await user.click(screen.getByRole("tab", { name: /Keys/ }));
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(
      within(confirm).getByRole("button", { name: "Revoke key" }),
    );
    await waitFor(() =>
      expect(mockApi.revokeKey).toHaveBeenCalledWith(
        "djdl",
        "lic_1",
        "abcdef0123456789abcdef",
      ),
    );
  });

  it("confirms before deauthorizing a device", async () => {
    const user = await renderDetail();
    await user.click(screen.getByRole("tab", { name: /Devices/ }));
    await user.click(screen.getByRole("button", { name: "Deauthorize" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(
      within(confirm).getByRole("button", { name: "Deauthorize" }),
    );
    await waitFor(() =>
      expect(mockApi.deauthorizeDevice).toHaveBeenCalledWith(
        "djdl",
        "lic_1",
        "dev_1",
      ),
    );
  });

  it("surfaces enforced/hidden override state and submits a batch via putLicenseOverrides", async () => {
    const user = await renderDetail();
    await user.click(screen.getByRole("tab", { name: "Overrides" }));

    // The catalog-driven editor leads with the label and carries the dotted key beside it.
    expect(await screen.findByText("feature.timeout")).toBeTruthy();
    // The secret's and the flag's states (a badge and the selected radio each).
    expect(screen.getAllByText("Enforced").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Hidden").length).toBeGreaterThanOrEqual(2);

    // Nothing pending ⇒ no action bar at all; a permanently-parked footer stops being read.
    expect(screen.queryByRole("button", { name: /Save overrides/ })).toBeNull();

    // Change the config value; that makes the form dirty and submits a batch.
    const timeout = screen.getByLabelText(/^Timeout/);
    await user.clear(timeout);
    await user.type(timeout, "60");
    const save = await screen.findByRole("button", { name: /Save overrides/ });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    await user.click(save);

    await waitFor(() => expect(mockApi.putLicenseOverrides).toHaveBeenCalled());
    const [, , updates] = mockApi.putLicenseOverrides.mock.calls.at(-1)!;
    // The state rides along: `applyOverrides` deletes a value-less update whose state is
    // `default`, so a set row must never send its state without its value.
    expect(updates).toEqual([
      { key: "feature.timeout", state: "default", value: 60 },
    ]);
  });

  it("refuses to save a value the catalog rejects, with the server's own wording", async () => {
    const user = await renderDetail();
    await user.click(screen.getByRole("tab", { name: "Overrides" }));
    const timeout = await screen.findByLabelText(/^Timeout/);
    await user.clear(timeout);
    await user.type(timeout, "500"); // maximum is 120

    expect(await screen.findByText(/must be <= 120/)).toBeTruthy();
    // Save is refused while the changed row is invalid: it jumps to the error instead.
    expect(screen.getByText(/fix 1 error to save/)).toBeTruthy();
    await user.click(
      await screen.findByRole("button", { name: /Save overrides/ }),
    );
    expect(mockApi.putLicenseOverrides).not.toHaveBeenCalled();
  });

  it("places a 422's catalog-validated fields on the rows that caused them", async () => {
    mockApi.putLicenseOverrides.mockRejectedValue(
      new ApiError(422, ["feature.timeout must be <= 120"]),
    );
    const user = await renderDetail();
    await user.click(screen.getByRole("tab", { name: "Overrides" }));
    const timeout = await screen.findByLabelText(/^Timeout/);
    await user.clear(timeout);
    await user.type(timeout, "60");
    await user.click(
      await screen.findByRole("button", { name: /Save overrides/ }),
    );
    expect(await screen.findByText("must be <= 120")).toBeTruthy();
  });

  it("shows what the profile layer below contributes to a key this license does not override", async () => {
    // The admin API returns only the license's OWN overrides — no merged view exists — so the
    // console rebuilds the layers below from the tier's profile and the license's profiles.
    mockApi.license.mockResolvedValue({ ...DETAIL, profiles: ["base"] });
    mockApi.profile.mockResolvedValue({
      id: "base",
      name: "Base",
      payload: {
        config: {},
        secrets: {},
        entitlements: {},
      },
    });
    // Give the profile a value for a key the license leaves alone.
    mockApi.profile.mockResolvedValue({
      id: "base",
      name: "Base",
      payload: {
        config: {
          "feature.retries": { state: "default", value: 3, updatedAt: 1 },
        },
        secrets: {},
        entitlements: {},
      },
    });
    mockApi.schema.mockResolvedValue({
      ...CATALOG,
      entries: [
        ...CATALOG.entries,
        {
          key: "feature.retries",
          kind: "config",
          category: "general",
          label: "Retries",
          description: "How many times to retry.",
          schema: { type: "integer", minimum: 0 },
        },
      ],
    });

    const user = await renderDetail();
    await user.click(screen.getByRole("tab", { name: "Overrides" }));
    expect(
      await screen.findByText(/inherits 3 from profile “Base”/),
    ).toBeTruthy();
    await waitFor(() =>
      expect(mockApi.profile).toHaveBeenCalledWith("djdl", "base"),
    );
  });

  // ── offline bundles ─────────────────────────────────────────────────────────
  async function openBundleDialog(): Promise<{
    user: Awaited<ReturnType<typeof renderDetail>>;
    dialog: HTMLElement;
  }> {
    const user = await renderDetail();
    await user.click(screen.getByRole("button", { name: "Offline bundle" }));
    const dialog = await screen.findByRole("dialog");
    return { user, dialog };
  }

  it("opens the offline bundle dialog from the header", async () => {
    const { dialog } = await openBundleDialog();
    expect(within(dialog).getByText("Mint offline bundle")).toBeTruthy();
    expect(within(dialog).getByLabelText(/Device ID/)).toBeTruthy();
    // The grace window defaults to the ceiling.
    const grace = within(dialog).getByLabelText(
      /Grace days/,
    ) as HTMLInputElement;
    expect(grace.value).toBe("365");
    // Config is enabled for this product, so the include control is offered.
    expect(
      await within(dialog).findByLabelText(/Include configuration/),
    ).toBeTruthy();
  });

  it("mints a bundle and shows the bundle id with a download", async () => {
    const { user, dialog } = await openBundleDialog();
    await user.type(
      within(dialog).getByLabelText(/Device ID/),
      DEVICE_REQUEST_CODE,
    );
    await user.clear(within(dialog).getByLabelText(/Grace days/));
    await user.type(within(dialog).getByLabelText(/Grace days/), "30");
    await user.click(
      within(dialog).getByRole("button", { name: "Mint bundle" }),
    );

    expect(
      await within(dialog).findByText("01JBUNDLEID0000000000000A"),
    ).toBeTruthy();
    expect(mockApi.mintBundle).toHaveBeenCalledWith("djdl", {
      deviceId: DEVICE_REQUEST_CODE,
      graceDays: 30,
      includeConfig: true,
      licenseId: "lic_1",
    });
    expect(
      within(dialog).getByRole("button", { name: "Copy ID" }),
    ).toBeTruthy();
    // jsdom has no `URL.createObjectURL`; the download degrades to a no-op rather than throwing.
    const download = within(dialog).getByRole("button", { name: /Download/ });
    expect(() => download.click()).not.toThrow();
  });

  it("refuses a request code that is not 32 characters", async () => {
    const { user, dialog } = await openBundleDialog();
    await user.type(within(dialog).getByLabelText(/Device ID/), "too-short");
    await user.click(
      within(dialog).getByRole("button", { name: "Mint bundle" }),
    );
    expect(
      await within(dialog).findByText(/exactly 32 characters/),
    ).toBeTruthy();
    expect(mockApi.mintBundle).not.toHaveBeenCalled();
  });

  it("hides the config control when the Config service is disabled", async () => {
    mockApi.services.mockResolvedValue({
      ...SERVICES,
      services: { ...SERVICES.services, config: { enabled: false } },
    });
    const { user, dialog } = await openBundleDialog();
    expect(within(dialog).queryByLabelText(/Include configuration/)).toBeNull();

    // …and no config preference is asserted on the wire either — enablement decides.
    await user.type(
      within(dialog).getByLabelText(/Device ID/),
      DEVICE_REQUEST_CODE,
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Mint bundle" }),
    );
    await waitFor(() =>
      expect(mockApi.mintBundle).toHaveBeenCalledWith("djdl", {
        deviceId: DEVICE_REQUEST_CODE,
        graceDays: 365,
        licenseId: "lic_1",
      }),
    );
  });
});

// ── The channel picker (P0-04, WIRE-CONTRACT-V3 §5.1) ─────────────────────────────────
describe("license channel picker", () => {
  const channelRows = (names: string[]) => ({
    releases: [],
    channels: names.map((channel) => ({
      channel,
      releaseId: "v1",
      modifiedAt: null,
    })),
  });

  async function openCreatePolicy() {
    const user = userEvent.setup();
    withProviders(<Licenses slug="djdl" />);
    await screen.findByText("ada@x.io");
    await user.click(screen.getByRole("button", { name: "Create license" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("tab", { name: "Policy" }));
    return { user, dialog };
  }

  it("offers neither dev nor staging on create for a product with no manual channels", async () => {
    const { dialog } = await openCreatePolicy();
    const group = within(dialog).getByRole("group", {
      name: "Release channels",
    });
    for (const name of ["stable", "beta", "pr"])
      expect(within(group).getByLabelText(name)).toBeTruthy();
    expect(within(group).queryByLabelText("dev")).toBeNull();
    expect(within(group).queryByLabelText("staging")).toBeNull();
  });

  it("drops reserved and non-canonical manual names; a manual staging is listed once", async () => {
    mockApi.releases.mockResolvedValue(
      channelRows(["stable", "beta", "dev", "pr", "Nightly", "staging"]),
    );
    const { dialog } = await openCreatePolicy();
    const group = within(dialog).getByRole("group", {
      name: "Release channels",
    });
    await waitFor(() =>
      expect(within(group).getAllByLabelText("staging")).toHaveLength(1),
    );
    expect(within(group).queryByLabelText("dev")).toBeNull();
    expect(within(group).queryByLabelText("Nightly")).toBeNull();
    expect(within(group).getAllByLabelText("pr")).toHaveLength(1);
    expect(
      within(group).getByLabelText("pr").getAttribute("aria-describedby"),
    ).toBeTruthy();
    expect(within(group).getByText("every PR build")).toBeTruthy();
    expect(
      within(group).getByText("manual; the grant also covers beta"),
    ).toBeTruthy();
  });

  it("shows a held dev grant with its label, and can remove it", async () => {
    mockApi.license.mockResolvedValue({
      ...DETAIL,
      channels: ["stable", "dev"],
    });
    const user = userEvent.setup();
    withProviders(<LicenseDetail slug="djdl" id="lic_1" />);
    await screen.findByRole("heading", { name: "Ada Lovelace" });
    const dev = screen.getByLabelText("dev") as HTMLInputElement;
    expect(dev.checked).toBe(true);
    expect(screen.getByText(/skips the version window/)).toBeTruthy();
    await user.click(dev);
    await user.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(mockApi.patchLicense).toHaveBeenCalledTimes(1));
    expect(mockApi.patchLicense.mock.calls[0]![2].channels).toEqual(["stable"]);
  });

  it("keeps a held value the picker does not offer through a save", async () => {
    mockApi.license.mockResolvedValue({
      ...DETAIL,
      channels: ["stable", "Legacy.X"],
    });
    const user = userEvent.setup();
    withProviders(<LicenseDetail slug="djdl" id="lic_1" />);
    await screen.findByRole("heading", { name: "Ada Lovelace" });
    expect(screen.getByText("not offered")).toBeTruthy();
    await user.click(screen.getByLabelText("beta"));
    await user.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(mockApi.patchLicense).toHaveBeenCalledTimes(1));
    expect(mockApi.patchLicense.mock.calls[0]![2].channels).toEqual([
      "stable",
      "beta",
      "Legacy.X",
    ]);
  });
});
