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
  ProductDeviceDetail,
  ProductDeviceDto,
  ProductDevicePage,
  ProductDeviceSummary,
} from "../src/api.js";

const productDevices = vi.fn();
const productDeviceSummary = vi.fn();
const productDevice = vi.fn();
const deauthorizeProductDevice = vi.fn();
const resetProductDeviceFingerprint = vi.fn();
vi.mock("../src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api.js")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      productDevices: (...a: unknown[]) => productDevices(...a),
      productDeviceSummary: (...a: unknown[]) => productDeviceSummary(...a),
      productDevice: (...a: unknown[]) => productDevice(...a),
      deauthorizeProductDevice: (...a: unknown[]) =>
        deauthorizeProductDevice(...a),
      resetProductDeviceFingerprint: (...a: unknown[]) =>
        resetProductDeviceFingerprint(...a),
    },
  };
});

import { resetCache } from "../src/context.js";
import { Toaster, TooltipProvider } from "../src/components/ui/index.js";
import { Devices } from "../src/views/Devices.js";

function dev(
  id: string,
  over: Partial<ProductDeviceDto> = {},
): ProductDeviceDto {
  return {
    deviceId: id,
    status: "authorized",
    firstSeen: 1_700_000_000,
    lastSeen: 1_700_003_600,
    platform: "windows",
    arch: "x86_64",
    appVersion: "1.0.0",
    licenseId: null,
    seatNo: null,
    ...over,
  };
}

const SUMMARY: ProductDeviceSummary = {
  total: 3,
  byStatus: [
    { value: "authorized", count: 2 },
    { value: "deauthorized", count: 1 },
  ],
  licensed: { licensed: 1, licenceFree: 1 },
  byPlatform: [
    { value: "windows", count: 1 },
    { value: "linux", count: 1 },
  ],
  byArch: [],
  bySdkName: [],
  byAppVersion: [],
};

function detail(d: ProductDeviceDto, over: Partial<ProductDeviceDetail> = {}) {
  return {
    ...d,
    fingerprint: null,
    facts: null,
    ...over,
  } as ProductDeviceDetail;
}

function mount() {
  return render(
    <TooltipProvider>
      <Toaster>
        <Devices slug="djdl" />
      </Toaster>
    </TooltipProvider>,
  );
}

beforeEach(() => {
  for (const m of [
    productDevices,
    productDeviceSummary,
    productDevice,
    deauthorizeProductDevice,
    resetProductDeviceFingerprint,
  ])
    m.mockReset();
  productDeviceSummary.mockResolvedValue(SUMMARY);
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
afterEach(() => {
  cleanup();
  resetCache();
});

describe("Devices view", () => {
  it("lists licensed and licence-free devices with summary chips and follows nextCursor", async () => {
    const page1: ProductDevicePage = {
      devices: [
        dev("dev-free"),
        dev("dev-lic", { licenseId: "lic_1", seatNo: 2 }),
      ],
      nextCursor: "CUR1",
    };
    const page2: ProductDevicePage = {
      devices: [dev("dev-old", { label: "Steam Deck" })],
      nextCursor: null,
    };
    productDevices.mockImplementation(
      async (_s: string, q: { cursor?: string | null }) =>
        q.cursor ? page2 : page1,
    );
    mount();

    await waitFor(() => expect(screen.getByText("dev-free")).toBeTruthy());
    expect(screen.getByText("Licence-free")).toBeTruthy();
    expect(screen.getByText("lic_1")).toBeTruthy();
    expect(screen.getByText(/seat 2/)).toBeTruthy();
    // Default filter is authorized devices only.
    expect(productDevices.mock.calls[0]![1]).toMatchObject({
      status: "authorized",
    });
    // Chips come from the summary endpoint.
    await screen.findByText("2 authorized");
    expect(screen.getByText("1 licence-free")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("Steam Deck");
    expect(productDevices.mock.calls.at(-1)![1]).toMatchObject({
      cursor: "CUR1",
    });
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("refetches from the head when a filter changes", async () => {
    productDevices.mockResolvedValue({
      devices: [dev("dev-a")],
      nextCursor: null,
    });
    mount();
    await screen.findByText("dev-a");

    // Clicking a platform chip filters the list by that platform.
    await userEvent.click(
      await screen.findByRole("button", { name: /linux 1/ }),
    );
    await waitFor(() =>
      expect(productDevices.mock.calls.at(-1)![1]).toMatchObject({
        platform: "linux",
        cursor: null,
      }),
    );
  });

  it("deauthorizes a licence-free device from the drawer, warning that it can re-register", async () => {
    const d = dev("dev-free");
    productDevices.mockResolvedValue({ devices: [d], nextCursor: null });
    productDevice.mockResolvedValue(detail(d));
    deauthorizeProductDevice.mockResolvedValue({
      ok: true,
      deviceId: "dev-free",
    });
    mount();

    await userEvent.click(await screen.findByText("dev-free"));
    const drawer = await screen.findByRole("dialog");
    await within(drawer).findByText(/Licence-free \(registered/);
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Deauthorize" }),
    );

    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText(/can register again/)).toBeTruthy();
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Deauthorize" }),
    );

    await waitFor(() =>
      expect(deauthorizeProductDevice).toHaveBeenCalledWith("djdl", "dev-free"),
    );
    // The list reloads after the action.
    await waitFor(() =>
      expect(productDevices.mock.calls.length).toBeGreaterThan(1),
    );
  });

  it("offers a binding reset only when the device has a fingerprint", async () => {
    const d = dev("dev-fp");
    productDevices.mockResolvedValue({ devices: [d], nextCursor: null });
    productDevice.mockResolvedValue(
      detail(d, {
        fingerprint: {
          status: "verified",
          hwid: "BgNwYHns5OhG",
          components: { cpu: "abcd1234" },
          componentCount: 1,
          firstSeen: 1,
          lastSeen: 2,
        },
      }),
    );
    resetProductDeviceFingerprint.mockResolvedValue({
      ok: true,
      deviceId: "dev-fp",
    });
    mount();

    await userEvent.click(await screen.findByText("dev-fp"));
    const drawer = await screen.findByRole("dialog");
    await userEvent.click(
      await within(drawer).findByRole("button", { name: "Reset binding" }),
    );
    const confirm = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Reset binding" }),
    );
    await waitFor(() =>
      expect(resetProductDeviceFingerprint).toHaveBeenCalledWith(
        "djdl",
        "dev-fp",
      ),
    );
  });

  it("shows an empty state and an error state", async () => {
    productDevices.mockResolvedValueOnce({ devices: [], nextCursor: null });
    mount();
    await screen.findByText("No devices yet");
    cleanup();

    productDevices.mockRejectedValueOnce(new Error("boom"));
    mount();
    await screen.findByText("Couldn’t load devices");
    expect(screen.getByText("boom")).toBeTruthy();
  });
});
