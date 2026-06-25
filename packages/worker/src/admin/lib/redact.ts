/**
 * Redaction + payload parsing. Responses NEVER echo a stored secret value: secret entries
 * are reduced to a `{ state, configured }` shape, and config keys flagged `secret` in the
 * active catalog have their value blanked.
 */

import type { Catalog } from "@polaris-key/catalog";
import type { ManagedEntry, ManagedPayload } from "@polaris-key/protocol";

/** Strip stored secret values out of a payload before it goes over the wire. */
export function redactPayload(
  payload: ManagedPayload,
  catalog: Catalog | null,
): {
  config: Record<string, ManagedEntry>;
  secrets: Record<
    string,
    { state: string; configured: boolean; updatedAt: number }
  >;
  entitlements: Record<string, ManagedEntry>;
} {
  const secrets: Record<
    string,
    { state: string; configured: boolean; updatedAt: number }
  > = {};
  for (const [key, entry] of Object.entries(payload.secrets ?? {})) {
    secrets[key] = {
      state: entry.state,
      configured: entry.value != null && entry.value !== "",
      updatedAt: entry.updatedAt,
    };
  }
  // A config key flagged `secret` in the catalog is also redacted (value blanked, but its
  // state + updatedAt are preserved so the admin UI can still show change metadata).
  const config: Record<string, ManagedEntry> = {};
  for (const [key, entry] of Object.entries(payload.config ?? {})) {
    const meta = catalog?.entryByKey(key);
    config[key] = meta?.secret
      ? { state: entry.state, value: "", updatedAt: entry.updatedAt }
      : entry;
  }
  return { config, secrets, entitlements: payload.entitlements ?? {} };
}

/** Parse a stored payload JSON column into a complete `ManagedPayload`, tolerating nulls. */
export function parsePayload(json: string | null | undefined): ManagedPayload {
  if (!json) return { config: {}, secrets: {}, entitlements: {} };
  try {
    const p = JSON.parse(json) as Partial<ManagedPayload>;
    return {
      config: p.config ?? {},
      secrets: p.secrets ?? {},
      entitlements: p.entitlements ?? {},
    };
  } catch {
    return { config: {}, secrets: {}, entitlements: {} };
  }
}
