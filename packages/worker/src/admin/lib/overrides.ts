/**
 * Override batch application: take a list of key updates, validate each value against the
 * active catalog, and produce a new payload all-or-nothing (any invalid update fails the
 * whole batch). Shared by license overrides and profile payload edits.
 */

import type { Catalog } from "@polaris-key/catalog";
import type { ManagedEntry, ManagedPayload } from "@polaris-key/protocol";

export interface OverrideUpdate {
  key: string;
  state?: "default" | "enforced" | "hidden";
  value?: unknown;
}

/** Apply a validated batch onto a stored payload JSON; returns the new payload or errors.
 *  `now` (epoch seconds) is stamped as `updatedAt` on every entry written. */
export function applyOverrides(
  current: ManagedPayload,
  updates: OverrideUpdate[],
  catalog: Catalog,
  now: number,
): { ok: true; payload: ManagedPayload } | { ok: false; fields: string[] } {
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
      entry.kind === "secret" ? next.secrets : entry.kind === "flag" ? next.entitlements : next.config;
    if (u.value === undefined && (u.state === "default" || u.state === undefined)) {
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
    bucket[u.key] = {
      // Default-when-omitted is "enforced" so an admin-set value wins (old "managed" behavior).
      state: u.state ?? "enforced",
      value: (u.value ?? bucket[u.key]?.value ?? true) as ManagedEntry["value"],
      updatedAt: now,
    };
  }
  if (fields.length) return { ok: false, fields };
  return { ok: true, payload: next };
}
