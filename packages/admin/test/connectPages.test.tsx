/**
 * Cloud Connect → Linked devices and Usage (CC-16.3): loading, empty, error, paged and read-only
 * states, units, null columns left out, and the tabs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import type { ConnectPeoplePage, ConnectUsageResponse } from "../src/api.js";
import { HttpError } from "../src/api.js";
import { KitProviders } from "../src/kit/KitProviders.js";

const people =
  vi.fn<
    (c?: string | null, subject?: string | null) => Promise<ConnectPeoplePage>
  >();
const usage = vi.fn<() => Promise<ConnectUsageResponse>>();
const productSettings = vi.fn();

vi.mock("../src/api.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/api.js")>("../src/api.js");
  return {
    ...actual,
    api: {
      connectPeople: (_s: string, c?: string | null, subject?: string | null) =>
        people(c, subject),
      connectUsage: () => usage(),
      productSettings: () => productSettings(),
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
  productSettings.mockReset();
  productSettings.mockResolvedValue({
    settings: [{ key: "cloudConnect.ceiling.relayBytes", value: 500 * GiB }],
  });
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
    expect(heads).toEqual(["Device", "Platform", "Keys issued", "Last seen"]);
    expect(screen.getByText(/2 devices/)).toBeTruthy();
    // The label falls back to the id for an unnamed device; named devices link to Devices.
    const link = screen.getByRole("link", { name: "Laptop 1" });
    expect(link.getAttribute("href")).toContain("devices/dev_1_");
    // The person is the subject in full, linking to their user record.
    const who = screen.getByRole("link", { name: /^ps_01abc/ });
    expect(who.getAttribute("href")).toContain("users/ps_01abc");
    expect(who.textContent).toBe(person(1).subject);
    // Read-only: nothing here writes, so no button.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect((await axe(r.container)).violations).toEqual([]);
    void container;
  });

  it("labels a person by their contact email, with the subject beneath", async () => {
    people.mockResolvedValue({
      enabled: true,
      people: [{ ...person(1), label: "ada@example.com" }],
      nextCursor: null,
    });
    const { container } = view(<ConnectDevicesPage slug="acme" />);
    const who = await screen.findByRole("link", { name: "ada@example.com" });
    expect(who.getAttribute("href")).toContain("users/ps_01abc");
    expect(who.getAttribute("data-person-link")).toBe(person(1).subject);
    expect(screen.getByText(person(1).subject)).toBeTruthy();
    expect(screen.getByText(/2 devices/)).toBeTruthy();
    expect((await axe(container)).violations).toEqual([]);
  });

  it("narrows to one person with ?subject=, and Show everyone clears it", async () => {
    const one = person(2);
    window.location.hash = `#/p/acme/connect/devices?subject=${one.subject}`;
    people.mockResolvedValue({
      enabled: true,
      people: [one],
      nextCursor: null,
    });
    view(<ConnectDevicesPage slug="acme" />);
    expect(await screen.findByText(/Showing one person/)).toBeTruthy();
    expect(people).toHaveBeenLastCalledWith(null, one.subject);
    const all = screen.getByRole("link", { name: "Show everyone" });
    expect(all.getAttribute("href")).not.toContain("subject");
    window.location.hash = "";
  });

  it("says so when the filtered person has linked nothing", async () => {
    window.location.hash = "#/p/acme/connect/devices?subject=ps_none";
    people.mockResolvedValue({ enabled: true, people: [], nextCursor: null });
    view(<ConnectDevicesPage slug="acme" />);
    expect(
      await screen.findByText("No linked devices for this user"),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Show everyone" })).toBeTruthy();
    window.location.hash = "";
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
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText(/2 people\./)).toBeTruthy();
    expect(people).toHaveBeenLastCalledWith("ps_01", null);
    // Focus lands on the first new person's link, not <body>.
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("data-person-link")).toBe(
        person(2).subject,
      ),
    );
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
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
    ).toEqual(["Setup", "Usage", "Linked devices"]);
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
    // The month tile, the 30-day tile and the day's row; the month tile is against the ceiling.
    expect((await screen.findAllByText(/^2\.3\sGiB$/)).length).toBe(3);
    expect(screen.getByText("This month")).toBeTruthy();
    expect(await screen.findByText(/^Of 500\sGiB/)).toBeTruthy();
    expect(screen.getByText("Relay sessions")).toBeTruthy();
    expect(screen.getByText("41")).toBeTruthy();
    const table = screen.getByRole("table", { name: "Relay use per day" });
    // Column order: Day, Sessions, Data, then the bar.
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Day", "Sessions", "Data", "Share of the busiest day"]);
    expect(within(table).getAllByRole("row")).toHaveLength(31);
    // Newest first.
    expect(within(table).getAllByRole("rowheader")[0]!.textContent).toBe(
      "Fri, Oct 30",
    );
    expect((await axe(container)).violations).toEqual([]);
  });

  it("totals this UTC month and the last 30 days from one 31-day read", async () => {
    const days = Array.from({ length: 31 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 8, 30 + i));
      return {
        day: d.toISOString().slice(0, 10),
        bytes: i === 0 ? 5 * GiB : i === 30 ? GiB : 0,
        sessions: i === 0 ? 3 : 0,
      };
    });
    usage.mockResolvedValue({
      enabled: true,
      days,
      totals: { bytes: 6 * GiB, sessions: 3 },
      people: 2,
    });
    view(<ConnectUsagePage slug="acme" />);
    // 2026-09-30 is outside both the month and the last 30 days.
    expect(
      (await screen.findAllByText(/^1\sGiB$/)).length,
    ).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText(/^5\sGiB$/)).toBeNull();
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
