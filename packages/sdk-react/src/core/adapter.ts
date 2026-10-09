// Shared projection helpers both adapters use to turn verified documents + gate inputs into a
// `PolarisState`. Centralizing this is what guarantees mode-parity: the browser and desktop
// adapters disagree on transport, never on how a document becomes state.
//
// Neither the gate nor the config precedence lives here any more — both are `@polaris-key/client-core`
// (wire contract v3 §4.2/§5 and §2.2.1), which is the single implementation Node, React, and
// the conformance runners all execute, the user-visible list (§2.2.1 rule 4) included. What IS
// here is the React-shaped projection on top of it: the flat effective `config` map (which also
// carries override-only keys) and the snapshot readers.

import {
  CHANNEL_STABLE,
  type JSONValue,
  type ManagedEntry,
} from "@polaris-key/protocol/core";
import {
  isUsable,
  licenseState,
  listUserEntries,
  resolveSource,
  resolveValue,
  type ConfigSource,
  type GateInput,
  type ResolveContext,
} from "@polaris-key/client-core";
import { ErrorCode } from "../constants.generated.js";
import type { PolarisError } from "./types.js";
import {
  type DeviceInfo,
  type PolarisDocs,
  type PolarisMode,
  type PolarisState,
  type UserConfigEntry,
} from "./types.js";
import {
  noBusy,
  noErrors,
  withError,
  type ServiceBusyMap,
  type ServiceErrorMap,
  type ServicesMap,
} from "./services.js";

/**
 * The React resolve context. `env` is deliberately EMPTY: environment-variable layering is a
 * Node/Python/Swift concern (a browser has no environment, and a renderer must not inherit the
 * privileged process's), so `resolveSource` can never answer `"env"` here — WIRE-CONTRACT-V3
 * §2.2.1 rule 3, pinned as each `config-matrix.json` case's `expectNoEnv`. Keeping the shared
 * function and starving its env layer is safer than forking the precedence. Every layer reads
 * own properties only, so a key named `constructor` is an ordinary key.
 */
function ctxFor(
  entries: Record<string, ManagedEntry>,
  localOverrides: Record<string, JSONValue>,
): ResolveContext {
  return { remote: entries, localOverrides, env: {}, envPrefix: "" };
}

/** Flatten a `Record<string, ManagedEntry>` to `key → value`. */
export function flattenEntries(
  entries: Record<string, { value: JSONValue }> | undefined,
): Record<string, JSONValue> {
  const out: Record<string, JSONValue> = {};
  for (const [k, v] of Object.entries(entries ?? {})) out[k] = v.value;
  return out;
}

/** Resolve the v3 precedence for ONE key. Returns `undefined` when the key is unknown AND
 *  unoverridden, so the caller can substitute its own fallback. */
export function resolveConfigValue(
  entries: Record<string, ManagedEntry>,
  localOverrides: Record<string, JSONValue>,
  key: string,
): JSONValue | undefined {
  return resolveValue(ctxFor(entries, localOverrides), key);
}

/** Resolve EVERY key's effective value into the flat map the store's `config` field holds.
 *  Keys come from both the document entries and any override-only keys, so an override for a
 *  key the server never sent still surfaces in the effective config. */
export function resolveConfig(
  entries: Record<string, ManagedEntry>,
  localOverrides: Record<string, JSONValue>,
): Record<string, JSONValue> {
  const ctx = ctxFor(entries, localOverrides);
  const out: Record<string, JSONValue> = {};
  for (const key of allKeys(entries, localOverrides)) {
    const v = resolveValue(ctx, key);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function allKeys(
  entries: Record<string, ManagedEntry>,
  localOverrides: Record<string, JSONValue>,
): Set<string> {
  return new Set([...Object.keys(entries), ...Object.keys(localOverrides)]);
}

/** Optional projection flags — everything a transport knows that the documents do not. */
export interface ProjectFlags {
  busy?: ServiceBusyMap;
  error?: ServiceErrorMap;
  localOverrides?: Record<string, JSONValue>;
  capabilities: ServicesMap;
  /** The licence GATE's input: the build's expectation OR a loaded discovery that says
   *  on, never switched off by discovery. Omitted: `capabilities.license.enabled`. */
  licenseGate?: boolean;
}

/**
 * Project the documents + gate inputs into the immutable snapshot the store holds. `phase`
 * flips to `ready` here — this is only ever called after a first transport resolution.
 */
/**
 * A refusal of something the person did on the sign-in card: a key they typed (an activation
 * outcome, the device limit among them) or a sign-in they started. The card shows it under the
 * control they used, with "Replace a device" when the refusal carries the portal link, and they
 * act on it there.
 */
export function isSignInRefusal(error: {
  code?: string;
  activation?: unknown;
}): boolean {
  return (
    error.activation !== undefined ||
    error.code === ErrorCode.signInFailed ||
    error.code === ErrorCode.signInExpired ||
    error.code === ErrorCode.keyEntryUnsupported
  );
}

/**
 * The errors that survive a refresh: the sign-in refusals standing in the license and identity
 * slots. A refresh re-reads the state; it does not retry what the person did, so it neither
 * clears their refusal nor replaces it with its own failure.
 */
export function standingRefusals(prev: ServiceErrorMap): ServiceErrorMap {
  let out = noErrors();
  for (const slug of ["license", "identity"] as const) {
    const e = prev[slug];
    if (e && isSignInRefusal(e)) out = withError(out, slug, e);
  }
  return out;
}

/** The error map after a refresh failed with `err`: the failure lands in the license slot,
 *  unless a sign-in refusal stands there, which stays (the person still has to act on it). */
export function refreshFailure(
  prev: ServiceErrorMap,
  err: PolarisError,
): ServiceErrorMap {
  const standing = prev.license;
  return standing && isSignInRefusal(standing)
    ? prev
    : withError(prev, "license", err);
}

export function projectState(
  mode: PolarisMode,
  docs: PolarisDocs,
  gateInput: Omit<GateInput, "doc" | "licenseServiceEnabled">,
  flags: ProjectFlags,
): PolarisState {
  const gate = licenseState({
    ...gateInput,
    licenseServiceEnabled:
      flags.licenseGate ?? flags.capabilities.license.enabled,
    doc: docs.license,
  });
  const configEntries = docs.config;
  const localOverrides = flags.localOverrides ?? {};
  return {
    phase: "ready",
    mode,
    gate,
    status: gate.status,
    activation: gateInput.activation,
    highWaterMark: gateInput.highWaterMark ?? 0,
    capabilities: flags.capabilities,
    profile: docs.license?.profile ?? null,
    currentDeviceId: docs.license?.deviceId ?? null,
    licenseId: docs.license?.licenseId ?? null,
    config: resolveConfig(configEntries, localOverrides),
    configEntries,
    localOverrides,
    entitlements: flattenEntries(docs.license?.entitlements),
    busy: flags.busy ?? noBusy(),
    // A refusal means nothing once the licence is usable (the person got in another way).
    error: isUsable(gate.status)
      ? withoutRefusals(flags.error ?? noErrors())
      : (flags.error ?? noErrors()),
  };
}

function withoutRefusals(errors: ServiceErrorMap): ServiceErrorMap {
  let out = errors;
  for (const slug of ["license", "identity"] as const) {
    const e = out[slug];
    if (e && isSignInRefusal(e)) out = withError(out, slug, null);
  }
  return out;
}

/** The same snapshot with a new override map: the effective `config` re-resolved over the
 *  unchanged documents (a local `config.set` never re-verifies anything). */
export function withOverrides(
  s: PolarisState,
  localOverrides: Record<string, JSONValue>,
): PolarisState {
  return {
    ...s,
    localOverrides,
    config: resolveConfig(s.configEntries, localOverrides),
  };
}

export function currentDeviceFromState(s: PolarisState): DeviceInfo | null {
  if (!s.currentDeviceId) return null;
  const out: DeviceInfo = {
    id: s.currentDeviceId,
    current: true,
    status: s.status,
  };
  if (s.licenseId) out.licenseId = s.licenseId;
  if (s.profile) out.profile = s.profile;
  // `DeviceInfo.lastVerifiedAt` is epoch SECONDS, like every other time the kit shows; the
  // gate's own field is client-core's milliseconds.
  if (s.gate.lastVerifiedAt !== undefined)
    out.lastVerifiedAt = Math.floor(s.gate.lastVerifiedAt / 1000);
  return out;
}

/** Read a config value off a snapshot with a typed fallback, via the v3 precedence. */
export function readConfig<T = JSONValue>(
  state: PolarisState,
  key: string,
  fallback: T,
): T {
  const v = resolveConfigValue(state.configEntries, state.localOverrides, key);
  return v === undefined ? fallback : (v as unknown as T);
}

/** Where a key's effective value came from (its provenance), per the v3 precedence. */
export function configSource(state: PolarisState, key: string): ConfigSource {
  return resolveSource(ctxFor(state.configEntries, state.localOverrides), key);
}

/** Enumerate config for a settings UI (WIRE-CONTRACT-V3 §2.2.1 rule 4): every DOCUMENT entry
 *  except `hidden` ones, resolved to its effective value with an `enforced` flag (true ⇒ the
 *  server value wins and the row is read-only). A key only a local override supplies has no
 *  catalog entry to render and is not listed; it stays in `state.config` and `getConfig`. */
export function listUserConfig(state: PolarisState): UserConfigEntry[] {
  return listUserEntries(ctxFor(state.configEntries, state.localOverrides));
}

/** Read an entitlement boolean off a snapshot. False whenever the gate is not usable (S-19
 *  G11, SDK-PARITY-PASS §3.3): a revoked, expired or blocked licence still carries its last
 *  verified grants, and none of them may unlock anything. A product without the license service
 *  is `not-applicable` (usable) but grants nothing, because entitlements ride the licence. */
export function readEntitled(state: PolarisState, name: string): boolean {
  return isUsable(state.status) && state.entitlements[name] === true;
}

/** The raw entitlement value (non-boolean grants: a number, a list), or `undefined` when it is
 *  absent or the gate is not usable (§3.3). */
export function readEntitlementValue(
  state: PolarisState,
  name: string,
): JSONValue | undefined {
  if (!isUsable(state.status)) return undefined;
  return Object.prototype.hasOwnProperty.call(state.entitlements, name)
    ? state.entitlements[name]
    : undefined;
}

/** The channels the licence grants, off a snapshot: the `channels` entitlement's string values
 *  in order, as granted, or `["stable"]` when it is absent or not an array. The Worker's own
 *  answer (`entitledChannels` in core/entitlements.ts) and every SDK's; raw grants, never
 *  alias-rewritten — whether a grant COVERS a channel is the entitlement rule's question. */
export function readEntitledChannels(state: PolarisState): string[] {
  const value = state.entitlements["channels"];
  if (!Array.isArray(value)) return [CHANNEL_STABLE];
  return value.filter((v): v is string => typeof v === "string");
}
