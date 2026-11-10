/**
 * Update → Updates (P2-11): updaters grouped by what verifies together, with the Verified state;
 * the loading, empty, error, no-data and failing states.
 */

import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { configureAxe } from "vitest-axe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, bootWith, P } from "./distributionFixture.js";
import { resetConsole } from "./consoleHarness.js";
import { renderUpdaterSetup } from "../src/console/sections/update/model/updaterSetup.js";

const axe = configureAxe({
  rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
});
const HASH = "#/p/djdl/update/updates";
const KEY = P("/distribution/updaters");

const mac = {
  platform: "macos",
  arches: ["arm64"],
  updaters: ["sparkle", "velopack"],
};
const win = {
  platform: "windows",
  arches: ["x86_64"],
  updaters: ["winsparkle", "velopack", "app-installer"],
};
const direct = (over: Record<string, unknown> = {}) => ({
  id: "direct",
  state: "verified",
  reports: 64,
  reverted: 0,
  release: null,
  platforms: [mac, win],
  ...over,
});
const view = (groups: unknown[], store: string[] = [], access = "public") => ({
  product: "djdl",
  now: 1,
  access,
  groups,
  store,
});

beforeEach(() => resetConsole());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Update → Updates", () => {
  it("states Verified once for the direct group, with a Set up with choice per platform", async () => {
    bootWith(HASH, { [KEY]: view([direct()]) });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Updates" }),
    ).toBeTruthy();
    const card = await screen.findByRole("region", {
      name: /Polaris Locker: macOS, Windows/,
    });
    expect(within(card).getAllByText("Verified")).toHaveLength(1);
    expect(within(card).getByText("64 update reports.")).toBeTruthy();
    expect(within(card).getAllByRole("tab", { name: "Sparkle" })).toHaveLength(
      1,
    );
  });

  it("a Windows-only product has no Sparkle, and choosing a tab changes the setup", async () => {
    bootWith(HASH, { [KEY]: view([direct({ platforms: [win] })]) });
    const card = await screen.findByRole("region", {
      name: /Polaris Locker: Windows/,
    });
    expect(within(card).queryByRole("tab", { name: "Sparkle" })).toBeNull();
    expect(within(card).getByText(/win_sparkle_set_appcast_url/)).toBeTruthy();
    await userEvent.click(
      within(card).getByRole("tab", { name: "App Installer" }),
    );
    await waitFor(() =>
      expect(within(card).getByText(/app\.appinstaller/)).toBeTruthy(),
    );
  });

  it("a failing group names the release, links Rollouts and says when it clears", async () => {
    bootWith(HASH, {
      [KEY]: view([
        direct({ state: "failing", reverted: 12, release: "4.2.2" }),
      ]),
    });
    const card = await screen.findByRole("region", {
      name: /Polaris Locker/,
    });
    expect(within(card).getByText("12 reverted")).toBeTruthy();
    expect(within(card).getByText("4.2.2 did not hold")).toBeTruthy();
    expect(
      within(card).getByRole("link", { name: "Open Rollouts" }),
    ).toBeTruthy();
    expect(within(card).getByText(/under 30 days old/)).toBeTruthy();
  });

  it("says once, page-wide, when the counters cannot be read", async () => {
    bootWith(HASH, {
      [KEY]: view([direct({ state: "unavailable", reports: 0 })]),
    });
    expect(
      await screen.findByText("Update reports could not be read"),
    ).toBeTruthy();
    expect(screen.getAllByText("No data")).toHaveLength(1);
  });

  it("lists store platforms once, without an updater", async () => {
    bootWith(HASH, { [KEY]: view([], ["ios"]) });
    expect(await screen.findByText("Updated by the store")).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("points an empty product at Releases", async () => {
    bootWith(HASH, { [KEY]: view([]) });
    expect(await screen.findByText("No platform shipped yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Releases" })).toBeTruthy();
  });

  it("offers Try again when the read fails", async () => {
    bootWith(HASH, { [KEY]: () => apiError(500, "internal") });
    expect(
      await screen.findByRole("button", { name: /Try again/i }),
    ).toBeTruthy();
  });

  it("has no axe violations while loading", async () => {
    bootWith(HASH, { [KEY]: () => new Promise(() => {}) });
    await screen.findByRole("status", { name: "Loading the updaters" });
    expect((await axe(document.body)).violations).toEqual([]);
  });

  it("has no axe violations", async () => {
    bootWith(HASH, { [KEY]: view([direct()], ["ios"]) });
    await screen.findByRole("region", { name: /Polaris Locker/ });
    expect((await axe(document.body)).violations).toEqual([]);
  });
});

describe("renderUpdaterSetup", () => {
  const url = (p: string) => `https://k.example/djdl/${p}`;
  const base = {
    url,
    channel: "stable",
    access: "public",
    keyShared: false,
    godot: false,
  };
  it("sends the license token only under a non-public delivery", () => {
    const code = (access: string) =>
      renderUpdaterSetup({
        ...base,
        access,
        updater: "winsparkle",
        platform: "windows",
      }).snippets[0]!.code;
    expect(code("public")).not.toContain("Authorization");
    expect(code("licensed")).toContain("snprintf");
    expect(code("licensed")).not.toContain('" + ');
  });
  it("puts the Godot key where each platform reads it", () => {
    const at = (platform: string) =>
      renderUpdaterSetup({ ...base, updater: "godot", platform });
    expect(at("macos").snippets[0]!.label).toBe("macOS export preset");
    expect(at("windows").snippets[0]!.code).toContain(
      "update_eddsa_public_key",
    );
    expect(at("linux").snippets).toEqual([]);
  });
  it("links the .appinstaller file, not the protocol", () => {
    const s = renderUpdaterSetup({
      ...base,
      updater: "app-installer",
      platform: "windows",
    });
    expect(s.snippets[0]!.code).toBe(
      "https://k.example/djdl/update/stable/app.appinstaller",
    );
  });
  it("says the key is shared instead of repeating the steps", () => {
    const s = renderUpdaterSetup({
      ...base,
      keyShared: true,
      updater: "winsparkle",
      platform: "windows",
    });
    expect(s.steps[0]).toContain("the Sparkle key from macOS");
    expect(s.steps.join(" ")).not.toContain("generate_keys");
  });
});
