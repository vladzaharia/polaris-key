/**
 * Update → Updates (P2-11): one card per shipped platform with its updater setup and Verified
 * state; the loading, empty, error, partial and failing states.
 */

import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, bootWith, P } from "./distributionFixture.js";
import { resetConsole } from "./consoleHarness.js";
import { partialLine } from "../src/console/sections/update/pages/UpdatesPage.js";
import { renderUpdaterSetup } from "../src/console/sections/update/model/updaterSetup.js";

const axe = configureAxe({
  rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
});
const HASH = "#/p/djdl/update/updates";
const KEY = P("/distribution/updaters");

const mac = {
  platform: "macos",
  arches: ["arm64"],
  updaters: ["sparkle", "velopack", "godot", "signed-feed"],
  state: "verified",
  devices: { reported: 64, reverted: 0 },
};
const win = {
  platform: "windows",
  arches: ["x86_64"],
  updaters: ["winsparkle", "velopack", "app-installer", "godot", "signed-feed"],
  state: "not_seen",
  devices: { reported: 0, reverted: 0 },
};
const view = (...platforms: unknown[]) => ({
  product: "djdl",
  now: 1,
  platforms,
});

beforeEach(() => resetConsole());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Update → Updates", () => {
  it("shows a card per shipped platform, Verified and Not seen yet, and the partial line", async () => {
    bootWith(HASH, { [KEY]: view(mac, win) });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Updates" }),
    ).toBeTruthy();
    const macCard = await screen.findByRole("region", { name: "macOS" });
    expect(within(macCard).getByText("Verified")).toBeTruthy();
    expect(
      within(macCard).getByText("64 devices reported an update."),
    ).toBeTruthy();
    const winCard = screen.getByRole("region", { name: "Windows" });
    expect(within(winCard).getByText("Not seen yet")).toBeTruthy();
    expect(screen.getByText(/Verified on 1 of 2/)).toBeTruthy();
  });

  it("a Windows-only product has no Sparkle", async () => {
    bootWith(HASH, { [KEY]: view(win) });
    const card = await screen.findByRole("region", { name: "Windows" });
    expect(within(card).queryByRole("radio", { name: "Sparkle" })).toBeNull();
    expect(
      within(card).getByRole("radio", { name: "WinSparkle" }),
    ).toBeTruthy();
  });

  it("choosing another updater changes the setup", async () => {
    bootWith(HASH, { [KEY]: view(win) });
    const card = await screen.findByRole("region", { name: "Windows" });
    expect(within(card).getByText(/winsparkle\.xml/)).toBeTruthy();
    await userEvent.click(
      within(card).getByRole("radio", { name: "App Installer" }),
    );
    await waitFor(() =>
      expect(within(card).getByText(/app\.appinstaller/)).toBeTruthy(),
    );
  });

  it("a failing card stays with what to do, and links to update health", async () => {
    bootWith(HASH, {
      [KEY]: view({
        ...mac,
        state: "failing",
        devices: { reported: 5, reverted: 12 },
      }),
    });
    const card = await screen.findByRole("region", { name: "macOS" });
    expect(within(card).getByText("Updates reverted")).toBeTruthy();
    expect(
      within(card).getByRole("link", { name: "Open update health" }),
    ).toBeTruthy();
    expect(
      within(card).getByText(
        "12 devices reverted an update or rolled a boot back.",
      ),
    ).toBeTruthy();
  });

  it("says so when the counters cannot be read, not 'not seen'", async () => {
    bootWith(HASH, {
      [KEY]: view({ ...mac, state: "unavailable" }),
    });
    const card = await screen.findByRole("region", { name: "macOS" });
    expect(within(card).getByText("No data")).toBeTruthy();
    expect(within(card).queryByText("Not seen yet")).toBeNull();
  });

  it("is empty before any platform ships", async () => {
    bootWith(HASH, { [KEY]: view() });
    expect(await screen.findByText("No platform shipped yet")).toBeTruthy();
  });

  it("offers Try again when the read fails", async () => {
    bootWith(HASH, { [KEY]: () => apiError(500, "internal") });
    expect(
      await screen.findByRole("button", { name: /Try again/i }),
    ).toBeTruthy();
  });

  it("has no axe violations", async () => {
    bootWith(HASH, { [KEY]: view(mac, win) });
    await screen.findByRole("region", { name: "macOS" });
    expect((await axe(document.body)).violations).toEqual([]);
  });
});

describe("renderUpdaterSetup / partialLine", () => {
  const url = (p: string) => `https://k.example/djdl/${p}`;
  it("builds the feed URLs for the track", () => {
    expect(
      renderUpdaterSetup({
        updater: "sparkle",
        platform: "macos",
        channel: "beta",
        url,
      }).endpoints[0]!.url,
    ).toBe("https://k.example/djdl/update/beta/appcast.xml");
    expect(
      renderUpdaterSetup({
        updater: "velopack",
        platform: "macos",
        channel: "stable",
        url,
      }).endpoints[0]!.url,
    ).toContain("releases.osx.json");
  });
  it("names the partial only when some are not Verified", () => {
    expect(partialLine([mac] as never)).toBeNull();
    expect(partialLine([mac, mac] as never)).toBeNull();
    expect(partialLine([mac, win] as never)).toBe("Verified on 1 of 2");
  });
});
