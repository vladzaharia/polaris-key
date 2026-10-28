/**
 * A-22.1: the channel page's shell and Status tab (`distribution/channels/<id>/<tab>`): each state,
 * the tablist's keyboard, and the unknown and out-of-scope channels.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChannelRow, ChannelsView } from "../src/api.js";
import { resetConsole } from "./consoleHarness.js";
import { bootWith, P } from "./distributionFixture.js";
import { parseLocation, r } from "../src/console/routes.js";

beforeEach(() => resetConsole());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const row = (over: Partial<ChannelRow> = {}): ChannelRow => ({
  id: "app-store",
  label: "App Store",
  inScope: true,
  declared: true,
  oneClick: false,
  notUsing: false,
  delivery: {
    state: "live",
    attention: [],
    platforms: [{ platform: "ios", arches: ["arm64"] }],
  },
  commerce: null,
  identity: null,
  ...over,
});

const view = (...channels: ChannelRow[]): ChannelsView => ({
  product: "djdl",
  now: 1,
  platforms: [],
  kinds: [],
  channels,
});

const boot = (hash: string, channels: ChannelRow[]) =>
  bootWith(hash, { [P("/distribution/channels")]: view(...channels) });

const H = "#/p/djdl/distribution/channels";

describe("the channel route", () => {
  it("builds and parses distribution/channels/<id>/<tab>", () => {
    expect(r.channel("djdl", "steam")).toBe(`${H}/steam`);
    expect(r.channel("djdl", "steam", "setup")).toBe(`${H}/steam/setup`);
    expect(parseLocation(`${H}/steam/status`).route).toMatchObject({
      kind: "product",
      page: "channel",
      id: "steam",
      tab: "status",
    });
  });
});

describe("Distribution → a channel: Status", () => {
  it("shows the live state, the platforms and the app identity", async () => {
    boot(`${H}/app-store`, [
      row({
        identity: {
          fields: { bundleId: "com.example.djdl" },
          source: "assigned",
        },
      }),
    ]);
    expect(
      await screen.findByRole("heading", { level: 1, name: "App Store" }),
    ).toBeTruthy();
    expect(screen.getAllByText("Live").length).toBeGreaterThan(0);
    expect(screen.getByText("arm64")).toBeTruthy();
    expect(screen.getByText("Bundle id")).toBeTruthy();
    expect(screen.getByText("com.example.djdl")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Needs attention" })).toBeNull();
  });

  it("lists every attention item with its fix", async () => {
    boot(`${H}/app-store/status`, [
      row({
        delivery: {
          state: "attention",
          attention: [
            { code: "credential_expiring" },
            { code: "no_fitting_build", reasons: ["format", "arch"] },
            { code: "identity_mismatch", field: "bundleId" },
          ],
          platforms: [],
        },
      }),
    ]);
    const list = await screen.findByRole("list", { name: "Needs attention" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toContain("Credential expiring");
    expect(
      within(items[0]!).getByRole("link", { name: "Credentials" }),
    ).toBeTruthy();
    expect(items[1]!.textContent).toContain(
      "the file format or the architecture",
    );
    expect(
      within(items[1]!)
        .getByRole("link", { name: "Releases" })
        .getAttribute("href"),
    ).toBe(`${H}/app-store/releases`);
    expect(items[2]!.textContent).toContain("bundle id");
    expect(screen.getAllByText("Attention").length).toBeGreaterThan(0);
    expect(screen.getByText(/No platform of DJDL is sent here/)).toBeTruthy();
  });

  it("draws a declared but out-of-scope channel as Out of scope, neutral, with its reason", async () => {
    boot(`${H}/steam`, [
      row({
        id: "steam",
        label: "Steam",
        inScope: false,
        delivery: {
          state: "not_set_up",
          attention: [{ code: "out_of_scope" }],
          platforms: [],
        },
      }),
    ]);
    await screen.findByRole("heading", { level: 1, name: "Steam" });
    const pills = screen.getAllByText("Out of scope");
    expect(pills.length).toBeGreaterThan(1);
    expect(
      screen.getByText(/None of DJDL's platforms fit this channel/),
    ).toBeTruthy();
  });

  it("shows Not set up and Ready", async () => {
    boot(`${H}/app-store`, [
      row({ delivery: { state: "not_set_up", attention: [], platforms: [] } }),
    ]);
    expect((await screen.findAllByText("Not set up")).length).toBeGreaterThan(
      0,
    );
    cleanup();
    resetConsole();
    boot(`${H}/app-store`, [
      row({ delivery: { state: "ready", attention: [], platforms: [] } }),
    ]);
    expect((await screen.findAllByText("Ready")).length).toBeGreaterThan(0);
  });
});

describe("Distribution → a channel: the tablist", () => {
  it("shows only built tabs, as a tablist with the roving tab stop", async () => {
    boot(`${H}/app-store`, [row()]);
    const list = await screen.findByRole("tablist", { name: "App Store tabs" });
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Status", "Releases"]);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]!.tabIndex).toBe(0);
    expect(screen.getByRole("tabpanel")).toBeTruthy();
  });

  it("an address on a tab that is not built opens Status and says so", async () => {
    boot(`${H}/app-store/sales`, [row()]);
    await screen.findByRole("tablist", { name: "App Store tabs" });
    await waitFor(() => expect(window.location.hash).toBe(`${H}/app-store`));
    expect(
      screen.getByRole("tab", { name: "Status" }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("the arrow keys move between the tabs, Home and End wrap, Enter opens one", async () => {
    boot(`${H}/app-store`, [row()]);
    const status = await screen.findByRole("tab", { name: "Status" });
    status.focus();
    await userEvent.keyboard("{ArrowRight}");
    const releases = screen.getByRole("tab", { name: "Releases" });
    expect(document.activeElement).toBe(releases);
    await userEvent.keyboard("{Home}");
    expect(document.activeElement).toBe(status);
    await userEvent.keyboard("{End}{Enter}");
    await waitFor(() =>
      expect(window.location.hash).toBe(`${H}/app-store/releases`),
    );
  });
});

describe("Distribution → a channel: unknown and out of scope", () => {
  it("an id the catalogue does not know is not found, and never reads the channels", async () => {
    const { calls } = boot(`${H}/no-such-store`, [row()]);
    expect(
      await screen.findByRole("heading", { name: "Channel not found" }),
    ).toBeTruthy();
    expect(
      screen.getByText("There is no channel “no-such-store”"),
    ).toBeTruthy();
    expect(
      screen.getAllByRole("link", { name: "Channel setup" }).length,
    ).toBeGreaterThan(1);
    expect(calls.some((c) => c.path.endsWith("/distribution/channels"))).toBe(
      false,
    );
  });

  it("a known channel the product does not list is out of scope", async () => {
    boot(`${H}/steam`, [row()]);
    const title = await screen.findByText("Steam is out of scope for DJDL");
    expect(title).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(
      screen.getAllByRole("link", { name: "Channel setup" }).length,
    ).toBeGreaterThan(1);
  });

  it("the bare address asks for a channel", async () => {
    boot(H, [row()]);
    expect(await screen.findByText("Pick a channel")).toBeTruthy();
  });
});
