/**
 * A-22.3b: a channel's Setup tab, Store controls: the store connector card moved off Outlet
 * credentials. Its state, an inert connector's reason, the team-key source, and the release
 * dialog at L3 (A-17a).
 */

import userEvent from "@testing-library/user-event";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAxe } from "vitest-axe";
import {
  apiError,
  bootWith,
  CONNECTORS,
  P,
  writes,
} from "./distributionFixture.js";
import { resetConsole } from "./consoleHarness.js";
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

  /** Open the release dialog and pick 2.4.0. */
  async function openRelease(): Promise<HTMLElement> {
    const asc = await screen.findByRole("region", {
      name: "App Store Connect",
    });
    await userEvent.click(
      within(asc).getByRole("button", { name: "Release this version…" }),
    );
    const confirm = await screen.findByRole("alertdialog");
    await userEvent.click(
      within(confirm).getByRole("button", { name: /^Release Required/ }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: /^2\.4\.0 / }),
    );
    return confirm;
  }

  it("releases a held App Store version at L3, with the app's name typed (A-17a)", async () => {
    const { calls } = boot("app-store", {
      [`POST ${P("/distribution/connectors/asc/release")}`]: { ok: true },
    });
    const confirm = await openRelease();
    // The button is drawn again when its reason goes: read it afresh each time.
    const go = () =>
      within(confirm).getByRole("button", { name: "Release version" });
    // A release is picked, but the name is not typed yet: still disabled.
    expect(go().getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(go());
    expect(writes(calls)).toEqual([]);
    const typeName = async (text: string) => {
      const box = within(confirm).getByRole("textbox", { name: /App name/ });
      await userEvent.clear(box);
      await userEvent.type(box, text);
    };
    await typeName("   ");
    expect(go().getAttribute("aria-disabled")).toBe("true");
    await typeName(" DJDL Mobile ");
    expect(go().getAttribute("aria-disabled")).toBeNull();
    await userEvent.click(go());
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        expect.objectContaining({
          path: P("/distribution/connectors/asc/release"),
          body: { releaseId: "rel_240", confirm: "DJDL Mobile" },
        }),
      ]),
    );
  });

  it("words a name that doesn't match App Store Connect and stays open (A-17a)", async () => {
    boot("app-store", {
      [`POST ${P("/distribution/connectors/asc/release")}`]: () =>
        apiError(
          422,
          "invalid_body",
          { reason: "confirmation_mismatch", fields: ["confirm"] },
          "confirm does not match the app's name in App Store Connect",
        ),
    });
    const confirm = await openRelease();
    await userEvent.type(
      within(confirm).getByRole("textbox", { name: /App name/ }),
      "Wrong name",
    );
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Release version" }),
    );
    expect(
      await within(confirm).findByText(
        /doesn't match the app's name in App Store Connect/,
      ),
    ).toBeTruthy();
  });
});
