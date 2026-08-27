// Effective managed payload = layered merge of tier(profile) -> license -> device,
// key-by-key (a later layer's entry wins). Each layer is a stored ManagedPayload JSON.

import type { ManagedEntry } from "@polaris-key/protocol";
import type { ManagedPayload } from "./core/payload.js";

export function emptyPayload(): ManagedPayload {
  return { config: {}, secrets: {}, entitlements: {} };
}

function parsePayload(json: string | null | undefined): ManagedPayload {
  if (!json) return emptyPayload();
  try {
    const p = JSON.parse(json) as Partial<ManagedPayload>;
    return {
      config: p.config ?? {},
      secrets: p.secrets ?? {},
      entitlements: p.entitlements ?? {},
    };
  } catch {
    return emptyPayload();
  }
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
