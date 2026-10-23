// GENERATED FILE — do not edit by hand. Source: conformance/parity/api.json; regenerate with `pnpm gen api`.
import { expect, it } from "vitest";
import {
  ConfigClient,
  IdentityClient,
  LicenseClient,
  PolarisKeyClient,
  type ConfigSetting,
  type PolarisKeyClientOptions,
} from "../src/index.js";

type Options = PolarisKeyClientOptions;
// Type-level: each member exists (tsc fails when one is renamed away).
export type Surface = [
  Options["productSlug"],
  NonNullable<Options["trust"]>["pinnedKeys"],
  NonNullable<Options["update"]>["pinnedReleaseKeys"],
  Options["baseUrl"],
  Options["expectedServices"],
  ConfigSetting["get"],
  ConfigSetting["source"],
  ConfigSetting["locked"],
  ConfigSetting["set"],
  ConfigSetting["clear"],
  ConfigSetting["on"],
  PolarisKeyClient["events"],
];

it("client.create", () =>
  expect(typeof PolarisKeyClient.create).toBe("function"));
it("client.boot", () =>
  expect("boot" in PolarisKeyClient.prototype).toBe(true));
it("config.get", () =>
  expect("getConfig" in ConfigClient.prototype).toBe(true));
it("config.getConfigSource", () =>
  expect("getConfigSource" in ConfigClient.prototype).toBe(true));
it("config.getSecret", () =>
  expect("getSecret" in ConfigClient.prototype).toBe(true));
it("config.mintToken", () =>
  expect("mintToken" in ConfigClient.prototype).toBe(true));
it("config.set", () => expect("set" in ConfigClient.prototype).toBe(true));
it("config.clear", () => expect("clear" in ConfigClient.prototype).toBe(true));
it("config.onConfigChange", () =>
  expect("onConfigChange" in ConfigClient.prototype).toBe(true));
it("config.setting", () =>
  expect("setting" in ConfigClient.prototype).toBe(true));
it("license.activateWithKey", () =>
  expect("activateWithKey" in LicenseClient.prototype).toBe(true));
it("entitlements.has", () =>
  expect("isEntitled" in LicenseClient.prototype).toBe(true));
it("entitlements.value", () =>
  expect("entitlementValue" in LicenseClient.prototype).toBe(true));
it("entitlements.all", () =>
  expect("getEntitlements" in LicenseClient.prototype).toBe(true));
it("identity.signOut", () =>
  expect("signOut" in IdentityClient.prototype).toBe(true));
