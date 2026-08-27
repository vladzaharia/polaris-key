/**
 * Redaction + payload parsing. Responses NEVER echo a stored secret value: secret entries
 * are reduced to a `{ state, configured }` shape, and config keys flagged `secret` in the
 * active catalog have their value blanked.
 */

import type { Catalog } from "@polaris-key/catalog";
import type { ManagedEntry } from "@polaris-key/protocol";
import type { ManagedPayload } from "../../core/payload.js";
import { isSealedEnvelope } from "./managedSecrets.js";

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
  //
  // R12-01 — this FAILS CLOSED. The catalog is mutable external state: it is null while a
  // schema replacement or a manifest resync is between `deactivateSchemas` and `insertSchema`,
  // null when `catalog_json` is unparseable, and a v2 catalog may legitimately drop a key or
  // its `secret` flag. In every one of those cases the old code fell through to `: entry` and
  // echoed the stored plaintext. An entry we cannot positively classify as non-secret is
  // redacted, because the module's guarantee ("responses NEVER echo a stored secret value")
  // has to hold when the catalog is missing, not only when it agrees with us.
  const config: Record<string, ManagedEntry> = {};
  for (const [key, entry] of Object.entries(payload.config ?? {})) {
    const meta = catalog?.entryByKey(key);
    // A value that is a Sealed envelope was written as a secret (R12-02) and stays redacted
    // whatever the CURRENT catalog says — that is what closes the "v2 catalog drops the flag"
    // arm, where the catalog now positively (and wrongly) declares the key non-secret.
    const isSecret = isSealedEnvelope(entry.value)
      ? true
      : meta
        ? meta.secret === true
        : true;
    config[key] = isSecret
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
