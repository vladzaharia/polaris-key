// GENERATED FILE — do not edit by hand. Source: conformance/parity/api.json; regenerate with `pnpm gen api`.
import { expect, it } from "vitest";
import {
  PolarisKeyProvider,
  useBoot,
  useConfigSetting,
  useEntitlement,
  useManagedConfig,
  usePolarisAuth,
  type PolarisKeyConfig,
} from "../src/index.js";

// Type-level: each hook member and config key exists.
export type Surface = [
  PolarisKeyConfig["productSlug"],
  NonNullable<PolarisKeyConfig["trust"]>["pinnedKeys"],
  PolarisKeyConfig["baseUrl"],
  ReturnType<typeof useManagedConfig>["get"],
  ReturnType<typeof useManagedConfig>["getConfigSource"],
  ReturnType<typeof useManagedConfig>["set"],
  ReturnType<typeof useManagedConfig>["clear"],
  ReturnType<typeof useManagedConfig>["clearAll"],
  ReturnType<typeof useConfigSetting>["value"],
  ReturnType<typeof useConfigSetting>["source"],
  ReturnType<typeof useConfigSetting>["locked"],
  ReturnType<typeof useConfigSetting>["set"],
  ReturnType<typeof useConfigSetting>["clear"],
  ReturnType<typeof usePolarisAuth>["signOut"],
  PolarisKeyConfig["auth"],
];

it("client.create", () => expect(typeof PolarisKeyProvider).toBe("function"));
it("client.boot", () => expect(typeof useBoot).toBe("function"));
it("config.setting", () => expect(typeof useConfigSetting).toBe("function"));
it("entitlements.has", () => expect(typeof useEntitlement).toBe("function"));
