import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";

vi.mock("../src/api.js", () => {
  const api = {
    deauthorizeDevice: vi.fn(),
    resetDeviceFingerprint: vi.fn(),
  };
  return { api };
});

import { api, type DeviceDto } from "../src/api.js";
import { AdminProvider, resetCache } from "../src/context.js";
import { Toaster, TooltipProvider } from "../src/components/ui/index.js";
import { DevicesSection } from "../src/views/licenses/DevicesSection.js";

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
    // Shell.tsx mounts TooltipProvider around every routed view, so mirror that here
    // rather than making the section provide a redundant one of its own.
    <AdminProvider value={{ me: ME, product: "djdl", setProduct: () => {} }}>
      <TooltipProvider>
        <Toaster>{node}</Toaster>
      </TooltipProvider>
    </AdminProvider>,
  );
}

const VERIFIED: DeviceDto = {
  deviceId: "dev-verified",
  status: "authorized",
  firstSeen: 1_700_000_000,
  lastSeen: 1_700_003_600,
  platform: "darwin",
  arch: "arm64",
  appVersion: "1.4.0",
  fingerprint: {
    status: "verified",
    hwid: "BgNwYHns5OhG",
    components: { machineUuid: "abcd1234", cpuModel: "efgh5678" },
    componentCount: 2,
    firstSeen: 1_700_000_000,
    lastSeen: 1_700_003_600,
  },
  facts: {
    os: { name: "darwin", version: "15.1", build: "24B83" },
    hardware: { cpuModel: "Apple M3", cpuCores: 12, ramMb: 36864 },
    runtime: { name: "node", version: "22.13.1" },
    probes: {
      rekordbox: { present: true, version: "7.0.1" },
      serato: { present: false },
    },
    updatedAt: 1_700_003_600,
  },
};

const UNVERIFIED: DeviceDto = {
  deviceId: "dev-legacy",
  status: "authorized",
  firstSeen: 1_700_000_000,
  lastSeen: 1_700_003_600,
  fingerprint: {
    status: "unverified",
    hwid: null,
    components: {},
    componentCount: 0,
    firstSeen: 1_700_000_000,
    lastSeen: 1_700_003_600,
  },
};

afterEach(() => {
  cleanup();
  resetCache();
  vi.clearAllMocks();
});

describe("DevicesSection", () => {
  it("shows the truncated hwid and the software summary", () => {
    withProviders(
      <DevicesSection
        slug="djdl"
        id="lic_1"
        devices={[VERIFIED]}
        onChanged={() => {}}
      />,
    );
    expect(screen.getByText("BgNwYHns5OhG")).toBeTruthy();
    expect(screen.getByText(/darwin 15\.1/)).toBeTruthy();
    expect(screen.getByText("app 1.4.0")).toBeTruthy();
    // One of two declared probes is present.
    expect(screen.getByText("1 of 2 apps")).toBeTruthy();
  });

  it("marks a device that never sent a fingerprint as unverified", () => {
    withProviders(
      <DevicesSection
        slug="djdl"
        id="lic_1"
        devices={[UNVERIFIED]}
        onChanged={() => {}}
      />,
    );
    expect(screen.getByText("Unverified")).toBeTruthy();
  });

  it("offers a binding reset only for devices that have one", () => {
    withProviders(
      <DevicesSection
        slug="djdl"
        id="lic_1"
        devices={[{ ...VERIFIED, fingerprint: null }]}
        onChanged={() => {}}
      />,
    );
    expect(screen.queryByText("Reset binding")).toBeNull();
  });

  it("resets a binding without deauthorizing the device", async () => {
    mockApi.resetDeviceFingerprint.mockResolvedValue({
      ok: true,
      deviceId: "dev-verified",
    });
    const onChanged = vi.fn();
    withProviders(
      <DevicesSection
        slug="djdl"
        id="lic_1"
        devices={[VERIFIED]}
        onChanged={onChanged}
      />,
    );

    await userEvent.click(screen.getByText("Reset binding"));
    const dialog = await screen.findByRole("alertdialog");
    await userEvent.click(within(dialog).getByText("Reset binding"));

    await waitFor(() => {
      expect(mockApi.resetDeviceFingerprint).toHaveBeenCalledWith(
        "djdl",
        "lic_1",
        "dev-verified",
      );
    });
    // The reset must NOT go through the deauthorize path — that would cost the user a seat.
    expect(mockApi.deauthorizeDevice).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
  });
});
