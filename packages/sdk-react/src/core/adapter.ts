// Shared projection helpers both adapters use to turn verified documents + gate inputs into a
// `PolarisState`. Centralizing this is what guarantees mode-parity: the browser and desktop
// adapters disagree on transport, never on how a document becomes state.
//
// Neither the gate nor the config precedence lives here any more — both are `@plrs/client-core`
// (wire contract v3 §4.2/§5 and the layered-config rules), which is the single implementation
// Node, React, and the conformance runners all execute. What IS here is the React-shaped
// enumeration a settings UI needs on top of it: override-only keys included, `hidden` excluded,
// effective values resolved.

import type { JSONValue, ManagedEntry } from "@plrs/protocol/core";
import {
  licenseState,
  resolveSource,
  resolveValue,
  type ConfigSource,
  type GateInput,
  type ResolveContext,
} from "@plrs/client-core";
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
  type ServiceBusyMap,
  type ServiceErrorMap,
  type ServicesMap,
} from "./services.js";

/**
 * The React resolve context. `env` is deliberately EMPTY: environment-variable layering is a
 * Node/Python/Swift concern (a browser has no environment, and a renderer must not inherit the
 * privileged process's), so `resolveSource` can never answer `"env"` here. Keeping the shared
 * function and starving its env layer is safer than forking the precedence.
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
}

/**
 * Project the documents + gate inputs into the immutable snapshot the store holds. `phase`
 * flips to `ready` here — this is only ever called after a first transport resolution.
 */
export function projectState(
  mode: PolarisMode,
  docs: PolarisDocs,
  gateInput: Omit<GateInput, "doc" | "licenseServiceEnabled">,
  flags: ProjectFlags,
): PolarisState {
  const gate = licenseState({
    ...gateInput,
    licenseServiceEnabled: flags.capabilities.license.enabled,
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
    error: flags.error ?? noErrors(),
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
  if (s.gate.lastVerifiedAt !== undefined)
    out.lastVerifiedAt = s.gate.lastVerifiedAt;
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

/** Enumerate config for a settings UI: every key EXCEPT `hidden`, resolved to its effective
 *  value with an `enforced` flag (true ⇒ the server value wins and the row is read-only).
 *  Override-only keys (no server entry) are included as un-enforced rows — which is why this
 *  is not `client-core`'s `listUserEntries`, which enumerates the REMOTE catalog only. */
export function listUserConfig(state: PolarisState): UserConfigEntry[] {
  const ctx = ctxFor(state.configEntries, state.localOverrides);
  const out: UserConfigEntry[] = [];
  for (const key of allKeys(state.configEntries, state.localOverrides)) {
    const entry = state.configEntries[key];
    if (entry?.state === "hidden") continue; // withheld from user-facing enumeration.
    const value = resolveValue(ctx, key);
    if (value === undefined) continue;
    out.push({ key, value, enforced: entry?.state === "enforced" });
  }
  return out;
}

/** Read an entitlement boolean off a snapshot. */
export function readEntitled(state: PolarisState, name: string): boolean {
  return state.entitlements[name] === true;
}
