/**
 * A-22.3b: a channel's Setup tab, Store controls: the store connector card moved off Outlet
 * credentials. Its state, an inert connector's reason, the team-key source, and the release
 * dialog at L3 (A-17a).
 */

import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAxe } from "vitest-axe";
import {
  apiError,
  bootWith,
  CONNECTORS,
  CREDENTIALS,
  P,
} from "./distributionFixture.js";
import { resetConsole } from "./consoleHarness.js";
import { VIEW_ONLY } from "./credentialsKit.js";
import type { ChannelRow } from "../src/api.js";
import { channel, channels } from "./channelFixture.js";

const axe = configureAxe({
  rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
});

const boot = (
  id: string,
  extra: Record<string, unknown> = {},
  c: Partial<ChannelRow> = {},
) =>
  bootWith(`#/p/djdl/distribution/channels/${id}/setup`, {
    [P("/distribution/channels")]: channels(channel({ id, ...c })),
    ...extra,
  });

beforeEach(() => resetConsole());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const settled = () => screen.findByRole("tab", { name: "Setup" });

describe("Distribution → a channel: Setup → Store controls", () => {
  it("shows only this channel's connector, and an inert one's reason", async () => {
    boot("app-store");
    const asc = await screen.findByRole("region", {
      name: "App Store Connect",
    });
    expect(within(asc).getByText("Connected")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Google Play" })).toBeNull();
    cleanup();
    resetConsole();
    boot("microsoft-store", {}, { label: "Microsoft Store" });
    const ms = await screen.findByRole("region", { name: "Microsoft Store" });
    expect(within(ms).getByText(/Not running/)).toBeTruthy();
    expect(within(ms).getByText(/Declare an ms-store channel/)).toBeTruthy();
  });

  it("draws nothing for a channel with no store connector", async () => {
    boot("polaris-key", {}, { label: "Polaris Locker" });
    await settled();
    expect(
      screen.queryByRole("heading", { name: "Store controls" }),
    ).toBeNull();
    expect(
      screen.queryByRole("region", { name: "App Store Connect" }),
    ).toBeNull();
  });

  it("passes axe", async () => {
    boot("app-store");
    await screen.findByRole("region", { name: "App Store Connect" });
    expect((await axe(document.body)).violations).toEqual([]);
  });

  it("says when App Store Connect uses the platform's team key (A-16)", async () => {
    boot("app-store", {
      [P("/distribution/connectors")]: {
        connectors: [
          {
            ...CONNECTORS.connectors[0],
            setup: {
              ...CONNECTORS.connectors[0]!.setup,
              apiKeyCredential: null,
              credentialSource: "platform",
              platformSource: "console",
            },
          },
        ],
      },
    });
    const asc = await screen.findByRole("region", {
      name: "App Store Connect",
    });
    expect(
      within(asc).getByText("The platform's team key (set in the console)"),
    ).toBeTruthy();
    expect(within(asc).queryByText("API key credential")).toBeNull();
  });

  it("has no release action: releasing lives on the Releases tab", async () => {
    boot("app-store");
    const asc = await screen.findByRole("region", {
      name: "App Store Connect",
    });
    expect(
      within(asc).queryByRole("button", { name: "Release this version…" }),
    ).toBeNull();
    expect(
      within(asc).getByRole("button", { name: "Webhook setup…" }),
    ).toBeTruthy();
  });

  it("is not Connected while its key's last use failed", async () => {
    boot("app-store", {
      [P("/outlet-credentials")]: {
        ...CREDENTIALS,
        credentials: CREDENTIALS.credentials.map((c) =>
          c.id === "asc-team-key" ? { ...c, lastError: "401 from Apple" } : c,
        ),
      },
    });
    const asc = await screen.findByRole("region", {
      name: "App Store Connect",
    });
    expect(await within(asc).findByText("Key check failed")).toBeTruthy();
    expect(within(asc).queryByText("Connected")).toBeNull();
  });

  it("is read-only without Ship edit: every action is off", async () => {
    boot("app-store", { "/manage/api/me": VIEW_ONLY });
    const asc = await screen.findByRole("region", {
      name: "App Store Connect",
    });
    for (const n of ["Webhook setup…", "TestFlight public link…"])
      expect(
        within(asc)
          .getByRole("button", { name: n })
          .getAttribute("aria-disabled"),
      ).toBe("true");
  });

  it("says so, with Retry, when the connectors can't be read", async () => {
    boot("app-store", {
      [P("/distribution/connectors")]: () => apiError(500, "internal"),
    });
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
