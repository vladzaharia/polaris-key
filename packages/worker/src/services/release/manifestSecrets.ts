/**
 * Sealing (and protecting) catalog-declared secrets that arrive through a `.pkey/` manifest.
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────────────────────
 *
 * R12-02 gave catalog-declared managed secrets envelope encryption under `PLATFORM_KEK`, but
 * wired it into exactly one caller: `applyOverrides`, which only the CONSOLE reaches. The two
 * MANIFEST paths — `linkRepo` (first write) and `resyncRepo` (every push to `.pkey/`) — wrote
 * `payloadJson: JSON.stringify(p.payload)` straight through. Two consequences, both bad:
 *
 *   1. A value under a key the product itself declares `kind: "secret"` landed in
 *      `profiles.payload_json` in CLEARTEXT. A read-only D1 dump then yields it, and the KEK
 *      protects nothing — the exact outcome R12-02 exists to prevent, reachable by anyone with
 *      write access to the repo.
 *   2. The same push OVERWROTE whatever an operator had rotated the value to. Rotating a leaked
 *      secret in the console and having the next unrelated repo commit put the leaked one back
 *      is an incident response silently reverted.
 *
 * So a manifest-supplied secret is SEALED before it is serialised, and a stored value that is
 * already a sealed envelope is never overwritten with a different one — the resync REFUSES, the
 * same shape as the `oidc.issuer` gate. Writing the same value again is a no-op (the stored
 * envelope is carried forward untouched), so a resync of an unchanged manifest stays clean.
 *
 * ── WHICH KEYS COUNT ────────────────────────────────────────────────────────────────────────
 *
 * The UNION of the catalog being applied and the catalog currently active. Judging by the
 * incoming catalog alone would let one push demote `kind: "secret"` to `kind: "config"` and
 * write the value in cleartext in the same commit; judging by the active one alone would leave
 * a brand-new secret key unsealed for one cycle. Union, so neither direction has a window.
 */

import type { Catalog } from "@polaris-key/catalog";
import type { Env } from "../../core/platform.js";
import {
  isManagedSecretKey,
  isSealedEnvelope,
  managedValueMatches,
  sealManagedValue,
} from "../../core/ingest.js";

/** The payload buckets whose values can be catalog-declared secrets. `entitlements` cannot. */
const SECRET_BEARING_BUCKETS = ["config", "secrets"] as const;

export type SealedPayloadResult =
  | { ok: true; json: string }
  | { ok: false; error: string };

/** True for any key at least one of the supplied catalogs declares as a managed secret. */
export function managedSecretKeyPredicate(
  catalogs: readonly Catalog[],
): (key: string) => boolean {
  return (key) => catalogs.some((c) => isManagedSecretKey(c, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A stored bucket entry, parsed out of `profiles.payload_json`. Entries are `ManagedEntry`
 * (`{state, value, updatedAt}`), but a hand-authored manifest may also write a bare value, so
 * both shapes are read and each is written back in the shape it arrived in.
 */
function entryValue(entry: unknown): unknown {
  return isRecord(entry) && "value" in entry ? entry.value : entry;
}

function withEntryValue(entry: unknown, value: unknown): unknown {
  return isRecord(entry) && "value" in entry ? { ...entry, value } : value;
}

function parseStoredBuckets(
  storedPayloadJson: string | null,
): Record<string, Record<string, unknown>> {
  if (!storedPayloadJson) return {};
  try {
    const parsed: unknown = JSON.parse(storedPayloadJson);
    if (!isRecord(parsed)) return {};
    const out: Record<string, Record<string, unknown>> = {};
    for (const bucket of SECRET_BEARING_BUCKETS) {
      const value = parsed[bucket];
      if (isRecord(value)) out[bucket] = value;
    }
    return out;
  } catch {
    // An unparseable stored payload protects nothing, so it cannot be the basis of a refusal.
    return {};
  }
}

/**
 * Produce the `profiles.payload_json` a manifest profile should be persisted as.
 *
 * `storedPayloadJson` is the row this write replaces (null at link time). Returns a refusal —
 * never a partial payload — when the manifest tries to replace an already-sealed stored value.
 */
export async function sealedProfilePayloadJson(
  env: Env,
  product: string,
  profileId: string,
  payload: Record<string, unknown>,
  isSecretKey: (key: string) => boolean,
  storedPayloadJson: string | null,
): Promise<SealedPayloadResult> {
  const stored = parseStoredBuckets(storedPayloadJson);
  const next: Record<string, unknown> = { ...payload };

  for (const bucket of SECRET_BEARING_BUCKETS) {
    const entries = payload[bucket];
    if (!isRecord(entries)) continue;
    const sealedEntries: Record<string, unknown> = { ...entries };
    for (const [key, entry] of Object.entries(entries)) {
      if (!isSecretKey(key)) continue;
      const value = entryValue(entry);
      const storedValue = entryValue(stored[bucket]?.[key]);

      if (isSealedEnvelope(storedValue)) {
        if (await managedValueMatches(env, product, key, storedValue, value)) {
          // Same value: carry the STORED envelope forward rather than re-sealing, so an
          // unchanged manifest produces a byte-identical row and the resync stays a no-op.
          sealedEntries[key] = withEntryValue(entry, storedValue);
          continue;
        }
        return {
          ok: false,
          error:
            `manifest would overwrite the sealed stored value of secret ${JSON.stringify(key)} ` +
            `in profile ${JSON.stringify(profileId)}; rotate it in the console instead — a ` +
            `repo push may not replace a secret an operator has already set`,
        };
      }

      sealedEntries[key] = withEntryValue(
        entry,
        await sealManagedValue(env, product, key, value),
      );
    }
    next[bucket] = sealedEntries;
  }

  return { ok: true, json: JSON.stringify(next) };
}
