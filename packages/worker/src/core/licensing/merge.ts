// Effective managed payload = layered merge of tier(profile) -> license -> device,
// key-by-key (a later layer's entry wins). Each layer is a stored ManagedPayload JSON.

import type { ManagedEntry } from "@polaris-key/protocol";
import type { ManagedPayload } from "./payload.js";

export function emptyPayload(): ManagedPayload {
  return { config: {}, secrets: {}, entitlements: {} };
}

function parsePayload(json: string | null | undefined): ManagedPayload {
  if (!json) return emptyPayload();
  try {
    const p = JSON.parse(json) as Partial<ManagedPayload>;
    return {
      config: cleanMap(p.config),
      secrets: cleanMap(p.secrets),
      entitlements: cleanMap(p.entitlements),
    };
  } catch {
    return emptyPayload();
  }
}

const STATES = new Set(["default", "enforced", "hidden"]);

/** A stored layer is untrusted JSON; keep only well-formed entries with a known state. */
function cleanMap(m: unknown): Record<string, ManagedEntry> {
  const out: Record<string, ManagedEntry> = {};
  if (m === null || typeof m !== "object" || Array.isArray(m)) return out;
  for (const [k, e] of Object.entries(m as Record<string, unknown>)) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) continue;
    if (!STATES.has((e as { state?: unknown }).state as string)) continue;
    out[k] = e as ManagedEntry;
  }
  return out;
}

function mergeMap(
  base: Record<string, ManagedEntry>,
  over: Record<string, ManagedEntry>,
): Record<string, ManagedEntry> {
  const out: Record<string, ManagedEntry> = { ...base };
  for (const [key, overEntry] of Object.entries(over)) {
    const baseEntry = out[key];
    if (
      (baseEntry?.state === "enforced" || baseEntry?.state === "hidden") &&
      overEntry.state === "default"
    ) {
      out[key] = {
        ...baseEntry,
        updatedAt: Math.max(baseEntry.updatedAt ?? 0, overEntry.updatedAt ?? 0),
      };
      continue;
    }
    // The higher-precedence layer's value + state win, but `updatedAt` reflects the most
    // recent admin change across BOTH layers so clients detect any change in either layer.
    out[key] = baseEntry
      ? {
          ...overEntry,
          updatedAt: Math.max(
            baseEntry.updatedAt ?? 0,
            overEntry.updatedAt ?? 0,
          ),
        }
      : overEntry;
  }
  return out;
}

/** Merge stored payload layers in precedence order (earliest = lowest precedence). */
export function mergePayloads(
  ...layers: (string | null | undefined)[]
): ManagedPayload {
  let out = emptyPayload();
  for (const layer of layers) {
    const p = parsePayload(layer);
    out = {
      config: mergeMap(out.config, p.config),
      secrets: mergeMap(out.secrets, p.secrets),
      entitlements: mergeMap(out.entitlements, p.entitlements),
    };
  }
  return out;
}
