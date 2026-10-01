// `license.entitledChannels()` — the Worker's answer for the same document (P1b-07, PARITY §5.2).
//
// @pkey-feature license.channels
//
// The fixture table below is the SAME table every SDK's channel test runs (Python
// tests/test_channels.py, Swift ChannelsTests.swift, React test/channels.test.ts), so for one
// `channels` entitlement every SDK returns one list. The expectations are the Worker's own
// `entitledChannels` (packages/worker/src/core/entitlements.ts): the string values in order, as
// granted (no alias rewriting, no deduplication), and `["stable"]` when the entitlement is absent
// or not an array. There is no corpus case for this yet (P0-04 D11 sends it to a later corpus
// plan), so identical unit fixtures are the proof.

import { describe, expect, it } from "vitest";
import type { ManagedEntry } from "@polaris-key/protocol/core";
import { LicenseClient } from "../src/license/client.js";

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

function licenseWith(channels: unknown): LicenseClient {
  const entitlements: Record<string, ManagedEntry> = {
    polarisVpn: { state: "enforced", value: true, updatedAt: 1 },
  };
  if (channels !== undefined)
    entitlements.channels = {
      state: "enforced",
      value: channels as ManagedEntry["value"],
      updatedAt: 1,
    };
  const cache = { state: { license: { doc: { entitlements } } } };
  return new LicenseClient(
    {} as never,
    cache as never,
    {} as never,
    {} as never,
    async () => undefined,
  );
}

describe("license.entitledChannels()", () => {
  for (const [name, value, want] of FIXTURES) {
    it(name, () => {
      expect(licenseWith(value).entitledChannels()).toEqual(want);
    });
  }

  it("with no licence document at all, the floor: stable", () => {
    const cache = { state: { license: null } };
    const c = new LicenseClient(
      {} as never,
      cache as never,
      {} as never,
      {} as never,
      async () => undefined,
    );
    expect(c.entitledChannels()).toEqual(["stable"]);
  });
});
