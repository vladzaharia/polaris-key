// GENERATED FILE — do not edit by hand. Source: conformance/parity/api.json; regenerate with `pnpm gen api`.
import { expect, it } from "vitest";
import {
  ConfigClient,
  DeviceCodeSession,
  EntitlementsClient,
  IdentityClient,
  LicenseClient,
  PolarisKeyClient,
  RedirectSession,
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
  ConfigSetting["value"],
  ConfigSetting["source"],
  ConfigSetting["locked"],
  ConfigSetting["visibility"],
  ConfigSetting["set"],
  ConfigSetting["clear"],
  ConfigSetting["on"],
  PolarisKeyClient["events"],
];

it("client.create", () =>
  expect(typeof PolarisKeyClient.create).toBe("function"));
it("client.boot", () =>
  expect("boot" in PolarisKeyClient.prototype).toBe(true));
it("config.get", () => expect("get" in ConfigClient.prototype).toBe(true));
it("config.getConfigSource", () =>
  expect("getConfigSource" in ConfigClient.prototype).toBe(true));
it("config.getSecret", () =>
  expect("getSecret" in ConfigClient.prototype).toBe(true));
it("config.mintToken", () =>
  expect("mintToken" in ConfigClient.prototype).toBe(true));
it("config.set", () => expect("set" in ConfigClient.prototype).toBe(true));
it("config.clear", () => expect("clear" in ConfigClient.prototype).toBe(true));
it("config.clearAll", () =>
  expect("clearAll" in ConfigClient.prototype).toBe(true));
it("config.onConfigChange", () =>
  expect("onConfigChange" in ConfigClient.prototype).toBe(true));
it("config.setting", () =>
  expect("setting" in ConfigClient.prototype).toBe(true));
it("license.activateWithKey", () =>
  expect("activateWithKey" in LicenseClient.prototype).toBe(true));
it("entitlements.has", () =>
  expect("has" in EntitlementsClient.prototype).toBe(true));
it("entitlements.value", () =>
  expect("value" in EntitlementsClient.prototype).toBe(true));
it("entitlements.all", () =>
  expect("all" in EntitlementsClient.prototype).toBe(true));
it("identity.signIn", () =>
  expect("signIn" in IdentityClient.prototype).toBe(true));
it("identity.subject", () =>
  expect("subject" in IdentityClient.prototype).toBe(true));
it("identity.signOut", () =>
  expect("signOut" in IdentityClient.prototype).toBe(true));
it("identity.signIn.start", () =>
  expect("signIn" in IdentityClient.prototype).toBe(true));
it("identity.signIn.session.reopen", () =>
  expect("reopen" in DeviceCodeSession.prototype).toBe(true));
it("identity.signIn.session.cancel", () =>
  expect("cancel" in DeviceCodeSession.prototype).toBe(true));
it("identity.signIn.session.wait", () =>
  expect("wait" in DeviceCodeSession.prototype).toBe(true));
it("identity.signIn.session.complete", () =>
  expect("complete" in RedirectSession.prototype).toBe(true));
it("identity.attachLicense", () =>
  expect("attach" in IdentityClient.prototype).toBe(true));
it("identity.openAccount", () =>
  expect("openAccount" in IdentityClient.prototype).toBe(true));
it("client.discover", () =>
  expect("discover" in PolarisKeyClient.prototype).toBe(true));
it("client.init", () =>
  expect("init" in PolarisKeyClient.prototype).toBe(true));
it("client.portal", () =>
  expect("portal" in PolarisKeyClient.prototype).toBe(true));
it("client.presentation", () =>
  expect("presentation" in PolarisKeyClient.prototype).toBe(true));
it("client.presentationIcon", () =>
  expect("presentationIcon" in PolarisKeyClient.prototype).toBe(true));
it("client.presentationSource", () =>
  expect("presentationSource" in PolarisKeyClient.prototype).toBe(true));
it("client.discovery", () =>
  expect("discovery" in PolarisKeyClient.prototype).toBe(true));
it("client.servicesPinned", () =>
  expect("servicesPinned" in PolarisKeyClient.prototype).toBe(true));
it("client.hasToken", () =>
  expect("hasToken" in PolarisKeyClient.prototype).toBe(true));
it("client.ensureActivated", () =>
  expect("ensureActivated" in PolarisKeyClient.prototype).toBe(true));
it("client.capabilities", () =>
  expect("capabilities" in PolarisKeyClient.prototype).toBe(true));
it("client.supports", () =>
  expect("supports" in PolarisKeyClient.prototype).toBe(true));
it("client.caps", () =>
  expect("caps" in PolarisKeyClient.prototype).toBe(true));
it("client.sync", () =>
  expect("sync" in PolarisKeyClient.prototype).toBe(true));
it("client.getSyncState", () =>
  expect("getSyncState" in PolarisKeyClient.prototype).toBe(true));
it("client.importBundle", () =>
  expect("importBundle" in PolarisKeyClient.prototype).toBe(true));
it("client.crashTags", () =>
  expect("crashTags" in PolarisKeyClient.prototype).toBe(true));
it("client.status", () =>
  expect("status" in PolarisKeyClient.prototype).toBe(true));
it("client.storeStatus", () =>
  expect("storeStatus" in PolarisKeyClient.prototype).toBe(true));
it("client.isLicensed", () =>
  expect("isLicensed" in PolarisKeyClient.prototype).toBe(true));
it("client.listDevices", () =>
  expect("listDevices" in PolarisKeyClient.prototype).toBe(true));
it("client.deauthorizeDevice", () =>
  expect("deauthorizeDevice" in PolarisKeyClient.prototype).toBe(true));
it("client.renameDevice", () =>
  expect("renameDevice" in PolarisKeyClient.prototype).toBe(true));
it("client.startRefresh", () =>
  expect("startRefresh" in PolarisKeyClient.prototype).toBe(true));
it("client.close", () =>
  expect("close" in PolarisKeyClient.prototype).toBe(true));
it("config.listUserConfig", () =>
  expect("listUserConfig" in ConfigClient.prototype).toBe(true));
it("config.schemaVersion", () =>
  expect("schemaVersion" in ConfigClient.prototype).toBe(true));
it("config.fetchSchema", () =>
  expect("fetchSchema" in ConfigClient.prototype).toBe(true));
it("config.isLocked", () =>
  expect("isLocked" in ConfigClient.prototype).toBe(true));
it("license.activation", () =>
  expect("activation" in LicenseClient.prototype).toBe(true));
it("license.licenseInfo", () =>
  expect("licenseInfo" in LicenseClient.prototype).toBe(true));
it("license.entitledChannels", () =>
  expect("entitledChannels" in LicenseClient.prototype).toBe(true));
it("license.getProfile", () =>
  expect("getProfile" in LicenseClient.prototype).toBe(true));
it("license.getLicenseId", () =>
  expect("getLicenseId" in LicenseClient.prototype).toBe(true));
it("license.enroll", () =>
  expect("enroll" in LicenseClient.prototype).toBe(true));
it("license.deactivate", () =>
  expect("deactivate" in LicenseClient.prototype).toBe(true));
it("identity.current", () =>
  expect("current" in IdentityClient.prototype).toBe(true));
it("identity.forget", () =>
  expect("forget" in IdentityClient.prototype).toBe(true));
it("client.currentDevice", () =>
  expect("currentDevice" in PolarisKeyClient.prototype).toBe(true));
it("license.status", () =>
  expect("status" in LicenseClient.prototype).toBe(true));
it("license.isLicensed", () =>
  expect("isLicensed" in LicenseClient.prototype).toBe(true));
it("removed: config.getConfig", () =>
  expect("getConfig" in ConfigClient.prototype).toBe(false));
it("removed: PolarisKeyClient.getConfig", () =>
  expect("getConfig" in PolarisKeyClient.prototype).toBe(false));
it("removed: license.isEntitled", () =>
  expect("isEntitled" in LicenseClient.prototype).toBe(false));
it("removed: license.entitlementValue", () =>
  expect("entitlementValue" in LicenseClient.prototype).toBe(false));
it("removed: license.getEntitlements", () =>
  expect("getEntitlements" in LicenseClient.prototype).toBe(false));
it("removed: PolarisKeyClient.getCurrentDevice", () =>
  expect("getCurrentDevice" in PolarisKeyClient.prototype).toBe(false));
it("removed: identity.signInWithBrowser", () =>
  expect("signInWithBrowser" in IdentityClient.prototype).toBe(false));
it("removed: identity.beginSignIn", () =>
  expect("beginSignIn" in IdentityClient.prototype).toBe(false));
it("removed: identity.pollSignIn", () =>
  expect("pollSignIn" in IdentityClient.prototype).toBe(false));
it("removed: identity.waitForSignIn", () =>
  expect("waitForSignIn" in IdentityClient.prototype).toBe(false));
