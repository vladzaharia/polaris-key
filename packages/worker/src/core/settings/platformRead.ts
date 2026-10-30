/**
 * The platform settings' typed readers (ST-05a): `resolvePlatformSetting()` over Core's registry,
 * for the readers that live in Core and so cannot import the composition root (`mount.ts`).
 *
 * Every platform-scope entry lives in the platform slice (`platform.ts`), so a registry of Core's
 * own slices resolves them all; a service's slice contributes no platform key. A reader names the
 * registry key (`deltas.lazy.mode`) and gets the effective value the one resolver answers, from
 * the 30-second per-isolate copy of `platform_settings`.
 *
 * A `ceiling` kill switch whose `[vars]` value is a hard off answers `off` WITHOUT touching the
 * database (A-13's rule), so a break-glass deploy keeps working with D1 down.
 */

import type {
  ReservedDisplayNamesMode,
  ReservedNamesMode,
} from "@polaris-key/manifest";
import type { Db } from "../../db/types.js";
import type { SettingsEnv } from "../platformSettings.js";
import { buildSettingsRegistry, type SettingsRegistry } from "./registry.js";
import { PLATFORM_SLICE } from "./platform.js";
import {
  isHardOffDeploy,
  parseDeployValue,
  resolvePlatformSetting,
  type ResolvedSetting,
  type SettingsContext,
} from "./resolve.js";
import type { SettingDef } from "./types.js";

/** The value each typed reader returns, by registry key. */
export interface PlatformValues {
  "deltas.lazy.mode": "on" | "off";
  "deltas.lazy.maxBytes": number;
  "blobs.gc.mode": "on" | "off";
  "blobs.gc.graceDays": number;
  "licensing.reservedNames": ReservedNamesMode;
  "identity.reservedDisplayNames": ReservedDisplayNamesMode;
  "identity.reservedDisplayTerms": readonly string[];
  "identity.keyEntryRefusals": "on" | "off";
  "assets.hosting.enabled": "on" | "off";
  "email.dailyCapDefault": number;
  "cloudSync.quota.defaultBytes": number;
  "cloudSync.writesPaused": "on" | "off";
  "cloudConnect.relayPaused": "on" | "off";
  "cloudConnect.quota.defaultRelayBytes": number;
  "launch.identityExchange": "on" | "off";
  "launch.connect": "on" | "off";
  "launch.syncE2e": "on" | "off";
  "launch.relay": "on" | "off";
  /** The rule document, unparsed: `parseAccessRules` (`core/rbac/ruleGrants.ts`) reads it. */
  "console.access": unknown;
}

let CORE_REGISTRY: SettingsRegistry | undefined;

/** Core's registry (the platform and Core slices): every platform-scope entry there is. */
export function coreSettingsRegistry(): SettingsRegistry {
  return (CORE_REGISTRY ??= buildSettingsRegistry([]));
}

/** The resolver's context for a Core reader. */
export function coreSettingsContext(env: SettingsEnv, db: Db): SettingsContext {
  return { env, db, registry: coreSettingsRegistry() };
}

/** One platform setting's effective value (a hard-off `[vars]` answers without a read). */
export async function platformSetting<K extends keyof PlatformValues>(
  env: SettingsEnv,
  db: Db,
  key: K,
): Promise<PlatformValues[K]> {
  const def = coreSettingsRegistry().get(key, "platform")!;
  if (def.varName !== undefined && isHardOffDeploy(def, env[def.varName]))
    return "off" as PlatformValues[K];
  return (await resolvePlatformSetting(coreSettingsContext(env, db), key))
    .value as PlatformValues[K];
}

/** LG-1: the launch gates, one per v0.10.0 feature (`launch.*`, default off, fail closed). */
export type LaunchGate = Extract<keyof PlatformValues, `launch.${string}`>;

/** Is a launch gate on? Off while the setting is unset, hard-off in `[vars]`, or unreadable. */
export async function launchGateOn(
  env: SettingsEnv,
  db: Db,
  gate: LaunchGate,
): Promise<boolean> {
  try {
    return (await platformSetting(env, db, gate)) === "on";
  } catch {
    return false;
  }
}

/** One platform setting resolved with its chain, version and source (the console's view). */
export async function platformSettingResolved(
  env: SettingsEnv,
  db: Db,
  key: string,
  opts: { fresh?: boolean } = {},
): Promise<ResolvedSetting> {
  return resolvePlatformSetting(coreSettingsContext(env, db), key, opts);
}

/**
 * The live platform entries stored in `platform_settings` under an A-13 row key
 * (`storage.storedAs`) and settable from a `[vars]` name: what the Platform → Settings page lists
 * and what `env.ts` tags `@editable`. Adding an entry is a THREAT-MODEL §9 review trigger.
 */
export function aliasedPlatformEntries(): SettingDef[] {
  return PLATFORM_SLICE.filter(
    (d) =>
      !d.pending &&
      d.storage.kind === "scalar" &&
      d.storage.storedAs !== undefined &&
      d.varName !== undefined,
  );
}

/**
 * ST-16: the live product defaults and bounds the page edits as rows (`area: "product-defaults"`,
 * a scalar the operator owns, linked to a product entry). The licence defaults stay pending until
 * the hot paths read them through the resolver.
 */
export function productDefaultEntries(): SettingDef[] {
  return PLATFORM_SLICE.filter(
    (d) =>
      !d.pending &&
      d.area === "product-defaults" &&
      d.ownership === "operator" &&
      d.storage.kind === "scalar" &&
      d.productLink !== undefined &&
      ["switch", "integer", "enum"].includes(d.value.kind),
  );
}

/**
 * The live operator-owned lists the page edits as rows (PX-W13c): `identity.reservedDisplayTerms`.
 * Stored under the registry key itself, so no `[vars]` alias.
 */
export function listEntries(): SettingDef[] {
  return PLATFORM_SLICE.filter(
    (d) =>
      !d.pending &&
      d.ownership === "operator" &&
      d.storage.kind === "scalar" &&
      d.storage.storedAs === undefined &&
      d.value.kind === "list",
  );
}

/** Ceiling kill switches whose `[vars]` value is an unrecognised string (a hard off). */
export function unrecognisedCeilingVars(env: SettingsEnv): string[] {
  return aliasedPlatformEntries()
    .filter((d) => {
      const raw = env[d.varName!];
      return (
        isHardOffDeploy(d, raw) &&
        typeof raw === "string" &&
        parseDeployValue(d, raw) === undefined
      );
    })
    .map((d) => d.varName!);
}
