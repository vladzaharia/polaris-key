// `entitledChannels` — the Worker's answer for the same document (P1b-07, PARITY §5.2).
//
// @pkey-feature license.channels
//
// The fixture table below is the SAME table every SDK's channel test runs (Node
// test/channels.test.ts, Python tests/test_channels.py, Swift ChannelsTests.swift), so for one
// `channels` entitlement every SDK returns one list. The expectations are the Worker's own
// `entitledChannels` (packages/worker/src/core/entitlements.ts): the string values in order, as
// granted (no alias rewriting, no deduplication), and `["stable"]` when the entitlement is absent
// or not an array. Both adapters and `useLicense()` read it off the same snapshot field.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { JSONValue, ManagedEntry } from "@polaris-key/protocol/core";
import { PolarisKeyProvider } from "../src/react/Provider.js";
import { useLicense } from "../src/react/hooks.js";
import { browserAdapter } from "../src/browser/browserAdapter.js";
import { desktopAdapter } from "../src/desktop/desktopAdapter.js";
import type { PolarisAdapter } from "../src/core/index.js";
import {
  makeDoc,
  makeFakeBridge,
  makeFakeFetch,
  NOW_SEC,
  okBridgeState,
} from "./fixtures.js";

afterEach(cleanup);

/** [name, the `channels` entitlement's value (undefined ⇒ absent), the expected list]. */
const FIXTURES: [string, unknown, string[]][] = [
  ["absent", undefined, ["stable"]],
  ["stable only", ["stable"], ["stable"]],
  ["beta", ["beta"], ["beta"]],
  ["order kept", ["pr-42", "stable", "beta"], ["pr-42", "stable", "beta"]],
  ["aliases are raw grants", ["staging", "latest"], ["staging", "latest"]],
  ["duplicates kept", ["beta", "beta"], ["beta", "beta"]],
  [
    "non-strings dropped",
    ["beta", 7, null, true, { a: 1 }, "pr"],
    ["beta", "pr"],
  ],
  ["empty array", [], []],
  ["a string, not an array", "beta", ["stable"]],
  ["null", null, ["stable"]],
  ["an object", { beta: true }, ["stable"]],
];

function docWith(channels: unknown) {
  const entitlements: Record<string, ManagedEntry> = {
    polarisVpn: { state: "enforced", value: true, updatedAt: 950 },
  };
  if (channels !== undefined)
    entitlements.channels = {
      state: "enforced",
      value: channels as JSONValue,
      updatedAt: 950,
    };
  return makeDoc({ entitlements });
}

async function settled(adapter: PolarisAdapter): Promise<void> {
  for (let i = 0; i < 50 && adapter.snapshot().phase === "loading"; i++)
    await new Promise((r) => setTimeout(r, 0));
}

describe("entitledChannels() over the shared fixtures", () => {
  for (const [name, value, want] of FIXTURES) {
    it(`${name}: desktop and browser agree with the Worker`, async () => {
      const desktop = desktopAdapter({
        bridge: makeFakeBridge(okBridgeState({ doc: docWith(value) })),
        now: () => NOW_SEC,
      });
      const browser = browserAdapter({
        auth: "cookie",
        productSlug: "acme",
        fetchImpl: makeFakeFetch(docWith(value)),
        now: () => NOW_SEC,
        offlineStore: null,
      });
      await settled(desktop);
      await settled(browser);
      expect(desktop.entitledChannels()).toEqual(want);
      expect(browser.entitledChannels()).toEqual(want);
      desktop.dispose();
      browser.dispose();
    });
  }

  it("with no licence document, the floor: stable", async () => {
    const browser = browserAdapter({
      auth: "cookie",
      productSlug: "acme",
      fetchImpl: makeFakeFetch(null),
      now: () => NOW_SEC,
      offlineStore: null,
    });
    await settled(browser);
    expect(browser.entitledChannels()).toEqual(["stable"]);
  });

  it("useLicense().entitledChannels reads the same snapshot", async () => {
    const adapter = desktopAdapter({
      bridge: makeFakeBridge(okBridgeState({ doc: docWith(["beta", "pr-7"]) })),
      now: () => NOW_SEC,
    });
    function Probe(): JSX.Element {
      return (
        <span data-testid="ch">{useLicense().entitledChannels.join(",")}</span>
      );
    }
    const { getByTestId } = render(
      <PolarisKeyProvider productSlug="acme" adapter={adapter}>
        <Probe />
      </PolarisKeyProvider>,
    );
    await waitFor(() =>
      expect(getByTestId("ch").textContent).toBe("beta,pr-7"),
    );
  });
});
