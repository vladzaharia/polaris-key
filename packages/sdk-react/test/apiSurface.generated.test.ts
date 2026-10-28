// GENERATED FILE — do not edit by hand. Source: conformance/parity/api.json; regenerate with `pnpm gen api`.
import { expect, it } from "vitest";
import {
  PolarisKeyProvider,
  useBoot,
  useCapabilities,
  useChangelog,
  useCloudConnect,
  useCloudSync,
  useConfigSetting,
  useEntitlement,
  useImportBundle,
  useLatestVersion,
  useLicense,
  useLicenseChoice,
  useLicenseGate,
  useManagedConfig,
  usePolarisAuth,
  usePolarisFetch,
  usePolarisKey,
  usePresentation,
  useSetting,
  useUpdateDecision,
  type PolarisKeyConfig,
} from "../src/index.js";

// Type-level: each hook member and config key exists.
export type Surface = [
  PolarisKeyConfig["productSlug"],
  NonNullable<PolarisKeyConfig["trust"]>["pinnedKeys"],
  PolarisKeyConfig["baseUrl"],
  PolarisKeyConfig["expectedServices"],
  ReturnType<typeof useManagedConfig>["get"],
  ReturnType<typeof useManagedConfig>["getConfigSource"],
  ReturnType<typeof useManagedConfig>["set"],
  ReturnType<typeof useManagedConfig>["clear"],
  ReturnType<typeof useManagedConfig>["clearAll"],
  ReturnType<typeof useConfigSetting>["value"],
  ReturnType<typeof useConfigSetting>["source"],
  ReturnType<typeof useConfigSetting>["locked"],
  ReturnType<typeof useConfigSetting>["visibility"],
  ReturnType<typeof useConfigSetting>["set"],
  ReturnType<typeof useConfigSetting>["clear"],
  ReturnType<typeof useSetting>["sync"],
  ReturnType<typeof usePolarisKey>["activateWithKey"],
  ReturnType<typeof usePolarisAuth>["signIn"],
  ReturnType<typeof usePolarisAuth>["signOut"],
  ReturnType<typeof usePolarisAuth>["choice"],
  ReturnType<typeof useCloudSync>["status"],
  ReturnType<typeof useCloudSync>["flush"],
  ReturnType<typeof useCloudSync>["status"],
  PolarisKeyConfig["auth"],
  PolarisKeyConfig["mode"],
  PolarisKeyConfig["bridge"],
  PolarisKeyConfig["localOverrides"],
  PolarisKeyConfig["version"],
  PolarisKeyConfig["refreshIntervalSeconds"],
  PolarisKeyConfig["store"],
  PolarisKeyConfig["backend"],
  ReturnType<typeof useCloudConnect>["start"],
  ReturnType<typeof useCloudConnect>["stop"],
  ReturnType<typeof useCloudConnect>["peers"],
  ReturnType<typeof useCloudConnect>["devices"],
  ReturnType<typeof useCloudConnect>["open"],
  ReturnType<typeof useCloudConnect>["onChannel"],
  ReturnType<typeof useCloudConnect>["refreshPeers"],
  ReturnType<typeof useCloudConnect>["status"],
  ReturnType<typeof useCloudConnect>["onNotice"],
];

it("client.create", () => expect(typeof PolarisKeyProvider).toBe("function"));
it("client.boot", () => expect(typeof useBoot).toBe("function"));
it("config.setting", () => expect(typeof useConfigSetting).toBe("function"));
it("entitlements.has", () => expect(typeof useEntitlement).toBe("function"));
it("identity.useLicenseChoice", () =>
  expect(typeof useLicenseChoice).toBe("function"));
it("client.presentation", () =>
  expect(typeof usePresentation).toBe("function"));
it("client.capabilities", () =>
  expect(typeof useCapabilities).toBe("function"));
it("client.importBundle", () =>
  expect(typeof useImportBundle).toBe("function"));
it("release.changelog", () => expect(typeof useChangelog).toBe("function"));
it("update.check", () => expect(typeof useLatestVersion).toBe("function"));
it("update.decide", () => expect(typeof useUpdateDecision).toBe("function"));
it("license.status", () => expect(typeof useLicense).toBe("function"));
it("hooks.usePolarisKey", () => expect(typeof usePolarisKey).toBe("function"));
it("hooks.usePolarisAuth", () =>
  expect(typeof usePolarisAuth).toBe("function"));
it("hooks.useLicenseGate", () =>
  expect(typeof useLicenseGate).toBe("function"));
it("hooks.usePolarisFetch", () =>
  expect(typeof usePolarisFetch).toBe("function"));
