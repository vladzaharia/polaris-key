// Shared projection helpers both adapters use to turn a verified doc + gate input into a
// `PolarisState`. Centralizing this is what guarantees mode-parity: the browser and
// desktop adapters disagree on transport, never on how a doc becomes state.

import type { JSONValue, ManagedConfigDoc } from "@polaris-key/protocol";
import { licenseState, type GateInput } from "./gateModel.js";
import { type PolarisMode, type PolarisState } from "./types.js";

/** Flatten a `Record<string, ManagedEntry>` to `key → value`. */
export function flattenEntries(
  entries: Record<string, { value: JSONValue }> | undefined,
): Record<string, JSONValue> {
  const out: Record<string, JSONValue> = {};
  for (const [k, v] of Object.entries(entries ?? {})) out[k] = v.value;
  return out;
}

/** Project a doc + gate input into the immutable snapshot the store holds. `phase` flips
 *  to `ready` here — this is only ever called after a first transport resolution. */
export function projectState(
  mode: PolarisMode,
  doc: ManagedConfigDoc | null,
  gateInput: Omit<GateInput, "doc">,
  flags: { busy?: boolean; error?: PolarisState["error"] } = {},
): PolarisState {
  const gate = licenseState({ ...gateInput, doc });
  return {
    phase: "ready",
    mode,
    gate,
    status: gate.status,
    profile: doc?.profile ?? null,
    config: flattenEntries(doc?.payload.config),
    entitlements: flattenEntries(doc?.payload.entitlements),
    busy: flags.busy ?? false,
    error: flags.error ?? null,
  };
}

/** Read a config value off a snapshot with a typed fallback. */
export function readConfig<T = JSONValue>(state: PolarisState, key: string, fallback: T): T {
  return key in state.config ? (state.config[key] as unknown as T) : fallback;
}

/** Read an entitlement boolean off a snapshot. */
export function readEntitled(state: PolarisState, name: string): boolean {
  return state.entitlements[name] === true;
}
