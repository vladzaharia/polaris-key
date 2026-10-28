/**
 * Cloud Connect → Linked devices and Usage (CC-16.3): loading, empty, error, paged and read-only
 * states, units, null columns left out, and the tabs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import type { ConnectPeoplePage, ConnectUsageResponse } from "../src/api.js";
import { HttpError } from "../src/api.js";
import { KitProviders } from "../src/kit/KitProviders.js";

const people = vi.fn<(c?: string | null) => Promise<ConnectPeoplePage>>();
const usage = vi.fn<() => Promise<ConnectUsageResponse>>();

vi.mock("../src/api.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return {
    ...actual,
    api: {
      connectPeople: (_s: string, c?: string | null) => people(c),
      connectUsage: () => usage(),
    },
  };
});

const { ConnectDevicesPage } =
  await import("../src/console/sections/connect/ConnectDevices.js");
const { ConnectUsagePage } =
  await import("../src/console/sections/connect/ConnectUsage.js");

const axe = configureAxe({
  rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
});
const GiB = 1024 ** 3;
const NOW = Math.floor(Date.now() / 1000);

const device = (n: number, extra = {}) => ({
  deviceId: `dev_${n}_aaaaaaaaaaaaaaaaaaaa`,
  label: n === 2 ? null : `Laptop ${n}`,
  platform: "macos",
  keysSince: NOW - 86_400,
  certExpiresAt: null,
  lastRelayAt: null,
  lastSeen: NOW - 120,
  ...extra,
});
const person = (n: number, devices = [device(1), device(2)]) => ({
  subject: `ps_${String(n).padStart(2, "0")}abcdefghijklmnopqrstuvwxyz0123`,
  label: null,
  ringEpoch: 3,
  devices,
});

const headers = async (): Promise<(string | null)[]> =>
  within(await screen.findByRole("table"))
    .getAllByRole("columnheader")
    .map((h) => h.textContent);

const view = (ui: React.ReactElement) =>
  render(<KitProviders>{ui}</KitProviders>);

beforeEach(() => {
  people.mockReset();
  usage.mockReset();
});
afterEach(cleanup);

describe("Linked devices", () => {
  it("loads, then lists a person's devices with no empty columns", async () => {
    people.mockResolvedValue({
      enabled: true,
      people: [person(1)],
      nextCursor: null,
    });
    people.mockReturnValueOnce(new Promise(() => {}));
    const { container, unmount } = view(<ConnectDevicesPage slug="acme" />);
    expect(screen.getByText("Loading linked devices")).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 1, name: "Cloud Connect" }),
    ).toBeTruthy();
    unmount();
    const r = view(<ConnectDevicesPage slug="acme" />);
    const heads = await headers();
    expect(heads).toEqual(["Device", "Platform", "Keys since", "Last seen"]);
    expect(screen.getByText(/roster epoch 3/)).toBeTruthy();
    // The label falls back to the id for an unnamed device; named devices link to Devices.
    const link = screen.getByRole("link", { name: "Laptop 1" });
    expect(link.getAttribute("href")).toContain("devices/dev_1_");
    // The person is the subject, truncated, linking to their user record.
    const who = screen.getByTitle(/^ps_01abc/);
    expect(who.getAttribute("href")).toContain("users/ps_01abc");
    expect(who.textContent).toContain("…");
    // Read-only: nothing here writes, so no button.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect((await axe(r.container)).violations).toEqual([]);
    void container;
  });

  it("draws certificate and relay columns only when a device has them", async () => {
    people.mockResolvedValue({
      enabled: true,
      people: [
        person(1, [
          device(1, { certExpiresAt: NOW + 3600, lastRelayAt: NOW - 60 }),
          device(3),
        ]),
      ],
      nextCursor: null,
    });
    view(<ConnectDevicesPage slug="acme" />);
    const heads = await headers();
    expect(heads).toContain("Certificate expires");
    expect(heads).toContain("Last relay");
  });

  it("is empty when no one has linked a device", async () => {
    people.mockResolvedValue({ enabled: true, people: [], nextCursor: null });
    view(<ConnectDevicesPage slug="acme" />);
    expect(await screen.findByText("No linked devices yet")).toBeTruthy();
  });

  it("pages by cursor with Show more people", async () => {
    people.mockImplementation(async (c) =>
      c
        ? { enabled: true, people: [person(2)], nextCursor: null }
        : { enabled: true, people: [person(1)], nextCursor: "ps_01" },
    );
    view(<ConnectDevicesPage slug="acme" />);
    expect(await screen.findByText(/1 person so far/)).toBeTruthy();
    await userEvent.click(
      screen.getByRole("button", { name: "Show more people" }),
    );
    expect(await screen.findByText(/2 people\./)).toBeTruthy();
    expect(people).toHaveBeenLastCalledWith("ps_01");
    expect(
      screen.queryByRole("button", { name: "Show more people" }),
    ).toBeNull();
  });

  it("answers a failed read once, with Retry", async () => {
    people.mockRejectedValueOnce(new HttpError(500, { code: "internal" }));
    view(<ConnectDevicesPage slug="acme" />);
    const retry = await screen.findByRole("button", { name: "Retry" });
    people.mockResolvedValue({
      enabled: true,
      people: [person(1)],
      nextCursor: null,
    });
    await userEvent.click(retry);
    expect(await screen.findByRole("table")).toBeTruthy();
  });

  it("draws the three tabs", async () => {
    people.mockResolvedValue({ enabled: true, people: [], nextCursor: null });
    view(<ConnectDevicesPage slug="acme" />);
    const nav = await screen.findByRole("navigation", {
      name: "Cloud Connect",
    });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["Setup", "Linked devices", "Usage"]);
    expect(
      within(nav)
        .getByRole("link", { name: "Linked devices" })
        .getAttribute("aria-current"),
    ).toBe("page");
  });
});

const DAYS = Array.from({ length: 30 }, (_, i) => ({
  day: `2026-10-${String(i + 1).padStart(2, "0")}`,
  bytes: i === 29 ? 2.3 * GiB : 0,
  sessions: i === 29 ? 12 : 0,
}));

describe("Usage", () => {
  it("shows totals in real units, the people count and a row per day", async () => {
    usage.mockResolvedValue({
      enabled: true,
      days: DAYS,
      totals: { bytes: 2.3 * GiB, sessions: 12 },
      people: 41,
    });
    const { container } = view(<ConnectUsagePage slug="acme" />);
    expect((await screen.findAllByText(/^2\.3\sGiB$/)).length).toBe(2);
    expect(screen.getByText("Relay sessions")).toBeTruthy();
    expect(screen.getByText("41")).toBeTruthy();
    const table = screen.getByRole("table", { name: "Relay use per day" });
    expect(within(table).getAllByRole("row")).toHaveLength(31);
    // Newest first.
    expect(within(table).getAllByRole("rowheader")[0]!.textContent).toBe(
      "2026-10-30",
    );
    expect((await axe(container)).violations).toEqual([]);
  });

  it("loads with one status", async () => {
    usage.mockReturnValue(new Promise(() => {}));
    view(<ConnectUsagePage slug="acme" />);
    expect(screen.getByText("Loading usage").getAttribute("role")).toBe(
      "status",
    );
  });

  it("is empty with no relay traffic, keeping the people count", async () => {
    usage.mockResolvedValue({
      enabled: true,
      days: DAYS.map((d) => ({ ...d, bytes: 0, sessions: 0 })),
      totals: { bytes: 0, sessions: 0 },
      people: 3,
    });
    view(<ConnectUsagePage slug="acme" />);
    expect(await screen.findByText("No relay traffic yet")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("answers a failed read with Retry", async () => {
    usage.mockRejectedValueOnce(new HttpError(403, { code: "forbidden" }));
    view(<ConnectUsagePage slug="acme" />);
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/edit access/i);
  });
});
