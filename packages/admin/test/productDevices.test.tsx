import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  ProductDeviceDetail,
  ProductDeviceDto,
  ProductDevicePage,
  ProductDeviceQuery,
  ProductDeviceSummary,
} from "../src/api.js";
import {
  expectNoAxeViolations,
  hashQuery,
  renderAt,
  resetCore,
} from "./coreTestUtils.js";

const productDevices =
  vi.fn<(slug: string, q: ProductDeviceQuery) => Promise<ProductDevicePage>>();
const productDeviceSummary =
  vi.fn<(slug: string) => Promise<ProductDeviceSummary>>();
const productDevice =
  vi.fn<(slug: string, id: string) => Promise<ProductDeviceDetail>>();
const deauthorizeProductDevice = vi.fn();
const resetProductDeviceFingerprint = vi.fn();

vi.mock("../src/api.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return {
    ...actual,
    api: {
      productDevices: (s: string, q: ProductDeviceQuery) =>
        productDevices(s, q),
      productDeviceSummary: (s: string) => productDeviceSummary(s),
      productDevice: (s: string, id: string) => productDevice(s, id),
      deauthorizeProductDevice: (s: string, id: string) =>
        deauthorizeProductDevice(s, id),
      resetProductDeviceFingerprint: (s: string, id: string) =>
        resetProductDeviceFingerprint(s, id),
    },
  };
});

const { ApiError } = await import("../src/api.js");
const { DevicesPage } = await import("../src/console/pages/core/Devices.js");
const { useRoute } = await import("../src/console/router.js");

const NOW = Math.floor(Date.now() / 1000);

function device(
  n: number,
  over: Partial<ProductDeviceDto> = {},
): ProductDeviceDto {
  return {
    deviceId: `dev_${n}`,
    status: "authorized",
    firstSeen: NOW - 1000,
    lastSeen: NOW - 10,
    label: `Device ${n}`,
    platform: "windows",
    arch: "x64",
    appVersion: "2.4.0",
    licenseId: `lic_${n}`,
    seatNo: 1,
    ...over,
  };
}

const SUMMARY: ProductDeviceSummary = {
  total: 3,
  byStatus: [
    { value: "authorized", count: 2 },
    { value: "deauthorized", count: 1 },
  ],
  licensed: { licensed: 1, licenseFree: 1 },
  byPlatform: [
    { value: "windows", count: 2 },
    { value: "linux", count: 1 },
  ],
  byArch: [],
  bySdkName: [],
  byAppVersion: [],
};

function detail(
  d: ProductDeviceDto,
  over: Partial<ProductDeviceDetail> = {},
): ProductDeviceDetail {
  return {
    ...d,
    fingerprint: null,
    facts: null,
    ...over,
  } as ProductDeviceDetail;
}

/** The page as the router renders it: the drawer id comes from the URL. */
function Routed() {
  const route = useRoute();
  return (
    <DevicesPage
      slug="djdl"
      deviceId={route.kind === "product" ? route.id : undefined}
    />
  );
}

const mount = (hash = "#/p/djdl/devices") => renderAt(hash, <Routed />);

beforeEach(() => {
  resetCore();
  for (const m of [
    productDevices,
    productDeviceSummary,
    productDevice,
    deauthorizeProductDevice,
    resetProductDeviceFingerprint,
  ])
    m.mockReset();
  productDeviceSummary.mockResolvedValue(SUMMARY);
  productDevices.mockResolvedValue({
    devices: [
      device(1),
      device(2, { licenseId: null, seatNo: null, label: "Free one" }),
    ],
    nextCursor: null,
  });
});
afterEach(cleanup);

describe("Core → Devices", () => {
  it("lists licensed and license-free devices with the summary, linking each license (DEV-1)", async () => {
    mount();
    expect(await screen.findByText("Device 1")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "lic_1" }).getAttribute("href"),
    ).toBe("#/p/djdl/license/licenses/lic_1");
    expect(screen.getAllByText("License-free").length).toBeGreaterThan(1);
    expect(screen.getByRole("button", { name: /Authorized/ })).toBeTruthy();
    // No filter: every status, from the head.
    expect(productDevices.mock.calls[0]![1]).toMatchObject({
      status: "all",
      limit: 50,
    });
  });

  it("follows nextCursor on Load more", async () => {
    const user = userEvent.setup();
    productDevices
      .mockResolvedValueOnce({ devices: [device(1)], nextCursor: "c1" })
      .mockResolvedValueOnce({ devices: [device(3)], nextCursor: null });
    mount();
    await screen.findByText("Device 1");
    await user.click(screen.getByRole("button", { name: /Load more/ }));
    expect(await screen.findByText("Device 3")).toBeTruthy();
    expect(productDevices.mock.calls[1]![1]).toMatchObject({ cursor: "c1" });
  });

  it("a summary tile is a filter: it writes the URL and refetches from the head (DEV-4)", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("Device 1");
    const tile = screen.getByRole("button", { name: /Deauthorized/ });
    await user.click(tile);
    await waitFor(() => expect(hashQuery().get("status")).toBe("deauthorized"));
    await waitFor(() =>
      expect(productDevices.mock.calls.at(-1)![1]).toMatchObject({
        status: "deauthorized",
        cursor: null,
      }),
    );
    expect(tile.getAttribute("aria-pressed")).toBe("true");
  });

  it("reads filters from the URL (round trip)", async () => {
    mount(
      "#/p/djdl/devices?status=authorized&platform=linux&license=free&q=dev_",
    );
    await waitFor(() => expect(productDevices).toHaveBeenCalled());
    expect(productDevices.mock.calls[0]![1]).toMatchObject({
      status: "authorized",
      platform: "linux",
      licensed: false,
      q: "dev_",
    });
    expect(
      await screen.findByText(/Showing license-free devices only/),
    ).toBeTruthy();
  });

  it("opens the routed drawer with every fact as text (DEV-2, DEV-3)", async () => {
    productDevice.mockResolvedValue(
      detail(device(1), {
        facts: {
          os: {
            name: "macOS",
            version: "15.1",
            build: "24B83",
            kernel: "24.1.0",
          },
          hardware: {
            cpuModel: "Apple M2",
            cpuCores: 8,
            ramMb: 16384,
            machineModel: "Mac14,2",
          },
          runtime: { name: "node", version: "22" },
          probes: { rekordbox: { present: true, version: "7.0" } },
          updatedAt: NOW,
        },
        fingerprint: {
          status: "verified",
          hwid: "abcdef0123456789",
          components: { cpu: "Apple M2" },
          componentCount: 1,
          firstSeen: NOW,
          lastSeen: NOW,
        },
      }),
    );
    mount("#/p/djdl/devices/dev_1");
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Mac14,2")).toBeTruthy();
    expect(within(dialog).getByText(/build 24B83/)).toBeTruthy();
    expect(within(dialog).getByText("rekordbox")).toBeTruthy();
    expect(within(dialog).getByText("16.0 GB")).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Reset binding…" }),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getAllByRole("button", { name: "Close" }).at(-1)!,
    );
    await waitFor(() => expect(window.location.hash).toBe("#/p/djdl/devices"));
  });

  it("deauthorizes a license-free device (L2), warning that it can register again", async () => {
    const user = userEvent.setup();
    const free = device(2, { licenseId: null, seatNo: null });
    productDevice.mockResolvedValue(detail(free));
    deauthorizeProductDevice.mockResolvedValue({ ok: true, deviceId: "dev_2" });
    mount("#/p/djdl/devices/dev_2");
    const dialog = await screen.findByRole("dialog");
    await user.click(
      await within(dialog).findByRole("button", { name: "Deauthorize…" }),
    );
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText(/can register again/)).toBeTruthy();
    expect(within(confirm).getByText(/no seat is freed/)).toBeTruthy();
    await user.click(
      within(confirm).getByRole("button", { name: "Deauthorize" }),
    );
    await waitFor(() =>
      expect(deauthorizeProductDevice).toHaveBeenCalledWith("djdl", "dev_2"),
    );
    // Invalidation refetches the list and the summary.
    await waitFor(() =>
      expect(productDeviceSummary.mock.calls.length).toBeGreaterThan(1),
    );
  });

  it("offers a binding reset only when the device has a fingerprint", async () => {
    productDevice.mockResolvedValue(detail(device(1)));
    mount("#/p/djdl/devices/dev_1");
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(
      "No binding: this device has not sent a fingerprint.",
    );
    expect(
      within(dialog).queryByRole("button", { name: "Reset binding…" }),
    ).toBeNull();
  });

  it("a drawer load error offers Retry", async () => {
    const user = userEvent.setup();
    productDevice
      .mockRejectedValueOnce(new ApiError(500))
      .mockResolvedValue(detail(device(1)));
    mount("#/p/djdl/devices/dev_1");
    const dialog = await screen.findByRole("dialog");
    await user.click(
      await within(dialog).findByRole("button", { name: "Retry" }),
    );
    expect(await within(dialog).findByText("Hardware")).toBeTruthy();
  });

  it("shows a first-run empty state, and an error state with Retry", async () => {
    productDevices.mockResolvedValue({ devices: [], nextCursor: null });
    mount();
    expect(await screen.findByText("No devices yet")).toBeTruthy();
    cleanup();
    resetCore();
    productDevices.mockRejectedValue(new ApiError(500));
    mount();
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("passes axe", async () => {
    const { container } = mount();
    await screen.findByText("Device 1");
    await expectNoAxeViolations(container);
  });
});
