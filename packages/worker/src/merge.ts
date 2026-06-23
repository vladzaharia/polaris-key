// Effective managed payload = layered merge of tier(profile) -> license -> machine,
// key-by-key (a later layer's entry wins). Each layer is a stored ManagedPayload JSON.

import type { ManagedEntry, ManagedPayload } from "@polaris-key/protocol";

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
  return { ...base, ...over };
}

/** Merge stored payload layers in precedence order (earliest = lowest precedence). */
export function mergePayloads(...layers: (string | null | undefined)[]): ManagedPayload {
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
