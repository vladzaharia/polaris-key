import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";

// The licenses views talk to the typed `api` client; mock it wholesale so these tests assert the
// view behavior (rendering, the one-time key reveal, confirm flows, the override batch) without a
// network. `vi.mock` is hoisted, so the factory must not close over outer `let`s.
vi.mock("../src/api.js", () => {
  const api = {
    licenses: vi.fn(),
    license: vi.fn(),
    schema: vi.fn(),
    createLicense: vi.fn(),
    patchLicense: vi.fn(),
    setLicenseEnabled: vi.fn(),
    putLicenseOverrides: vi.fn(),
    mintKey: vi.fn(),
    revokeKey: vi.fn(),
    deauthorizeMachine: vi.fn(),
  };
  return { api };
});

import {
  api,
  type LicenseDetail as LicenseDetailDto,
  type LicenseSummary,
  type ProductCatalog,
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
  enrolledAt: 1_700_000_000,
  expiresAt: null,
  keyCount: 2,
  activeKeyCount: 1,
  machineCount: 1,
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
  machines: [
    {
      machineId: "dev_1",
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

beforeEach(() => {
  resetCache();
  for (const fn of Object.values(mockApi)) fn.mockReset();
  mockApi.licenses.mockResolvedValue({ licenses: [SUMMARY] });
  mockApi.license.mockResolvedValue(DETAIL);
  mockApi.schema.mockResolvedValue(CATALOG);
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
  mockApi.deauthorizeMachine.mockResolvedValue({
    ok: true,
    machineId: "dev_1",
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
    await user.type(within(dialog).getByLabelText(/Name/), "Grace Hopper");
    await user.type(within(dialog).getByLabelText(/Email/), "grace@x.io");
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
    });
    // There is a copy button with an accessible name.
    expect(
      within(panel).getByRole("button", { name: "Copy key" }),
    ).toBeTruthy();
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
      expect(mockApi.deauthorizeMachine).toHaveBeenCalledWith(
        "djdl",
        "lic_1",
        "dev_1",
      ),
    );
  });

  it("surfaces enforced/hidden override state and submits a batch via putLicenseOverrides", async () => {
    const user = await renderDetail();
    await user.click(screen.getByRole("tab", { name: "Overrides" }));

    // The catalog-driven editor renders each key with its management-state badge.
    expect(await screen.findByText("feature.timeout")).toBeTruthy();
    expect(screen.getByText("enforced")).toBeTruthy(); // the secret's state
    expect(screen.getByText("hidden")).toBeTruthy(); // the flag's state

    // No pending changes initially → save is disabled.
    const save = screen.getByRole("button", { name: "Save overrides" });
    expect((save as HTMLButtonElement).disabled).toBe(true);

    // Change the config value; that makes the form dirty and submits a batch.
    const timeout = screen.getByLabelText("Timeout");
    await user.clear(timeout);
    await user.type(timeout, "60");
    await waitFor(() =>
      expect((save as HTMLButtonElement).disabled).toBe(false),
    );
    await user.click(save);

    await waitFor(() => expect(mockApi.putLicenseOverrides).toHaveBeenCalled());
    const [, , updates] = mockApi.putLicenseOverrides.mock.calls.at(-1)!;
    expect(updates).toEqual([{ key: "feature.timeout", value: 60 }]);
  });
});
