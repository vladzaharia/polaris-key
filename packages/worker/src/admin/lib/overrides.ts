/**
 * Override batch application: take a list of key updates, validate each value against the
 * active catalog, and produce a new payload all-or-nothing (any invalid update fails the
 * whole batch). Shared by license overrides and profile payload edits.
 */

import type { Catalog } from "@polaris-key/catalog";
import type { ManagedEntry } from "@polaris-key/protocol";
import type { ManagedPayload } from "../../core/payload.js";
import type { Env } from "../../env.js";
import { isManagedSecretKey, sealManagedValue } from "./managedSecrets.js";

export interface OverrideUpdate {
  key: string;
  state?: "default" | "enforced" | "hidden";
  value?: unknown;
}

/** Apply a validated batch onto a stored payload JSON; returns the new payload or errors.
 *  `now` (epoch seconds) is stamped as `updatedAt` on every entry written.
 *
 *  R12-02: a value under a `kind: "secret"` entry, or under a `kind: "config"` entry flagged
 *  `secret: true`, is envelope-encrypted under `PLATFORM_KEK` before it reaches the caller —
 *  so it is sealed by the time `profiles.payload_json` / `licenses.overrides_json` are written.
 *  Validation still runs against the PLAINTEXT, so catalog schemas keep working unchanged. */
export async function applyOverrides(
  env: Env,
  product: string,
  current: ManagedPayload,
  updates: OverrideUpdate[],
  catalog: Catalog,
  now: number,
): Promise<
  { ok: true; payload: ManagedPayload } | { ok: false; fields: string[] }
> {
  const fields: string[] = [];
  const next: ManagedPayload = {
    config: { ...current.config },
    secrets: { ...current.secrets },
    entitlements: { ...current.entitlements },
  };
  for (const u of updates) {
    if (!u || typeof u.key !== "string") {
      fields.push("missing key");
      continue;
    }
    const entry = catalog.entryByKey(u.key);
    if (!entry) {
      fields.push(`unknown config key: ${u.key}`);
      continue;
    }
    const bucket =
      entry.kind === "secret"
        ? next.secrets
        : entry.kind === "flag"
          ? next.entitlements
          : next.config;
    if (
      u.value === undefined &&
      (u.state === "default" || u.state === undefined)
    ) {
      // Clearing an override.
      delete bucket[u.key];
      continue;
    }
    if (u.value !== undefined) {
      const res = catalog.validateKeyValue(u.key, u.value);
      if (!res.ok) {
        fields.push(...res.errors);
        continue;
      }
    }
    // A state-only update (no `value`) carries the STORED value forward untouched — already
    // sealed if it was a secret — so it is never re-sealed and never re-validated.
    const nextValue = u.value ?? bucket[u.key]?.value ?? true;
    bucket[u.key] = {
      // Default-when-omitted is "enforced" so an admin-set value wins.
      state: u.state ?? "enforced",
      value: (isManagedSecretKey(catalog, u.key)
        ? await sealManagedValue(env, product, u.key, nextValue)
        : nextValue) as ManagedEntry["value"],
      updatedAt: now,
    };
  }
  if (fields.length) return { ok: false, fields };
  return { ok: true, payload: next };
}
