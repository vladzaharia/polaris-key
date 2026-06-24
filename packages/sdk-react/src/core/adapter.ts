// Shared projection helpers both adapters use to turn a verified doc + gate input into a
// `PolarisState`. Centralizing this is what guarantees mode-parity: the browser and
// desktop adapters disagree on transport, never on how a doc becomes state.

import type { JSONValue, ManagedConfigDoc, ManagedEntry } from "@polaris-key/protocol";
import { licenseState, type GateInput } from "./gateModel.js";
import { type ConfigSource, type PolarisMode, type PolarisState, type UserConfigEntry } from "./types.js";

/** Flatten a `Record<string, ManagedEntry>` to `key → value`. */
export function flattenEntries(
  entries: Record<string, { value: JSONValue }> | undefined,
): Record<string, JSONValue> {
  const out: Record<string, JSONValue> = {};
  for (const [k, v] of Object.entries(entries ?? {})) out[k] = v.value;
  return out;
}

/** True when a v2 management state locks the value to the server (client cannot override). */
function isLocked(state: ManagedEntry["state"]): boolean {
  return state === "enforced" || state === "hidden";
}

/** Resolve the v2 precedence for ONE key against the raw entries + local overrides:
 *    `enforced`/`hidden` (remote, locked)  >  local override  >  remote `default`.
 *  Environment layering lives in the node/python/swift SDKs, not the browser, so it is
 *  deliberately absent here. Returns `undefined` when the key is unknown AND unoverridden. */
export function resolveConfigValue(
  entries: Record<string, ManagedEntry>,
  localOverrides: Record<string, JSONValue>,
  key: string,
): JSONValue | undefined {
  const entry = entries[key];
  if (entry && isLocked(entry.state)) return entry.value; // server wins, locked.
  if (key in localOverrides) return localOverrides[key]; // default-state local win.
  return entry?.value; // remote default (or undefined if absent).
}

/** Resolve EVERY key's effective value into the flat map the store's `config` field holds.
 *  Keys come from both the doc entries and any override-only keys, so an override for a key
 *  the server never sent still surfaces in the effective config. */
export function resolveConfig(
  entries: Record<string, ManagedEntry>,
  localOverrides: Record<string, JSONValue>,
): Record<string, JSONValue> {
  const out: Record<string, JSONValue> = {};
  const keys = new Set([...Object.keys(entries), ...Object.keys(localOverrides)]);
  for (const key of keys) {
    const v = resolveConfigValue(entries, localOverrides, key);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** Project a doc + gate input into the immutable snapshot the store holds. `phase` flips
 *  to `ready` here — this is only ever called after a first transport resolution. The
 *  effective `config` map is resolved through the v2 precedence using `localOverrides`. */
export function projectState(
  mode: PolarisMode,
  doc: ManagedConfigDoc | null,
  gateInput: Omit<GateInput, "doc">,
  flags: { busy?: boolean; error?: PolarisState["error"]; localOverrides?: Record<string, JSONValue> } = {},
): PolarisState {
  const gate = licenseState({ ...gateInput, doc });
  const configEntries = doc?.payload.config ?? {};
  const localOverrides = flags.localOverrides ?? {};
  return {
    phase: "ready",
    mode,
    gate,
    status: gate.status,
    profile: doc?.profile ?? null,
    config: resolveConfig(configEntries, localOverrides),
    configEntries,
    localOverrides,
    entitlements: flattenEntries(doc?.payload.entitlements),
    busy: flags.busy ?? false,
    error: flags.error ?? null,
  };
}

/** Read a config value off a snapshot with a typed fallback, via the v2 precedence. */
export function readConfig<T = JSONValue>(state: PolarisState, key: string, fallback: T): T {
  const v = resolveConfigValue(state.configEntries, state.localOverrides, key);
  return v === undefined ? fallback : (v as unknown as T);
}

/** Where a key's effective value came from (its provenance), per the v2 precedence. */
export function configSource(state: PolarisState, key: string): ConfigSource {
  const entry = state.configEntries[key];
  if (entry?.state === "enforced") return "enforced";
  if (entry?.state === "hidden") return "hidden";
  if (key in state.localOverrides) return "local";
  if (entry) return "remote-default";
  return "fallback";
}

/** Enumerate config for a settings UI: every key EXCEPT `hidden`, resolved to its effective
 *  value with an `enforced` flag (true ⇒ the server value wins and the row is read-only).
 *  Override-only keys (no server entry) are included as un-enforced rows. */
export function listUserConfig(state: PolarisState): UserConfigEntry[] {
  const out: UserConfigEntry[] = [];
  const keys = new Set([...Object.keys(state.configEntries), ...Object.keys(state.localOverrides)]);
  for (const key of keys) {
    const entry = state.configEntries[key];
    if (entry?.state === "hidden") continue; // withheld from user-facing enumeration.
    const value = resolveConfigValue(state.configEntries, state.localOverrides, key);
    if (value === undefined) continue;
    out.push({ key, value, enforced: entry?.state === "enforced" });
  }
  return out;
}

/** Read an entitlement boolean off a snapshot. */
export function readEntitled(state: PolarisState, name: string): boolean {
  return state.entitlements[name] === true;
}
