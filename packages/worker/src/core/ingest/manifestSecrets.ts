/**
 * Sealing (and protecting) catalog-declared secrets that arrive through a `.pkey/` manifest.
 *
 * Catalog-declared managed secrets are sealed under `PLATFORM_KEK` (`core/managedSecrets.ts`),
 * and the console's profile editor (`applyOverrides`) seals what it writes. The two MANIFEST
 * writers of `profiles.payload_json` — `registerFromManifest` (first write, `linkRepo.ts`) and
 * `applyRepoManifest` (every push to `.pkey/`, `resync.ts`; a link of an existing product runs
 * it too) — wrote the payload straight through. Two consequences, both bad:
 *
 *   1. A value under a key the product itself declares `kind: "secret"` (or a config key flagged
 *      `secret: true`) landed in `profiles.payload_json` in CLEARTEXT. A read-only D1 dump then
 *      yields it and the KEK protects nothing, reachable by anyone with write access to the repo.
 *   2. The same push OVERWROTE whatever an operator had rotated the value to. Rotating a leaked
 *      secret in the console and having the next unrelated repo commit put the leaked one back
 *      is an incident response silently reverted.
 *
 * So a manifest-supplied secret is SEALED before it is serialised, and a stored value that is
 * already a sealed envelope is never overwritten with a different one: the whole push is
 * REFUSED, the same shape as the `oidc.issuer` gate. Writing the same value again is a no-op (the
 * stored envelope is carried forward untouched), so a resync of an unchanged manifest stays
 * clean. A manifest that does not declare the value keeps the stored one (`withStoredSecrets`,
 * `resync.ts`).
 *
 * ── WHICH KEYS COUNT ────────────────────────────────────────────────────────────────────────
 *
 * The UNION of the catalog being applied and the catalog currently stored. Judging by the
 * incoming catalog alone would let one push demote `kind: "secret"` to `kind: "config"` and
 * write the value in cleartext in the same commit; judging by the stored one alone would leave
 * a brand-new secret key unsealed for one cycle. Union, so neither direction has a window.
 */

import { Catalog } from "@polaris-key/catalog";
import { isJsonObject, parseJsonObject } from "../../platform/json.js";
import type { Env } from "../../platform/env.js";
import {
  isManagedSecretKey,
  isSealedEnvelope,
  managedValueMatches,
  sealManagedValue,
} from "../managedSecrets.js";

/** The payload buckets whose values can be catalog-declared secrets. `entitlements` cannot. */
const SECRET_BEARING_BUCKETS = ["config", "secrets"] as const;

export type SealedPayloadResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string };

/** The stored catalog as a `Catalog`, or null when there is none or it will not parse. */
export function parseStoredCatalog(
  catalogJson: string | null | undefined,
): Catalog | null {
  const parsed = parseJsonObject(catalogJson);
  if (!parsed) return null;
  try {
    return new Catalog(parsed as never);
  } catch {
    return null;
  }
}

/** True for any key at least one of the supplied catalogs declares as a managed secret. */
export function managedSecretKeyPredicate(
  catalogs: readonly Catalog[],
): (key: string) => boolean {
  return (key) => catalogs.some((c) => isManagedSecretKey(c, key));
}

/**
 * A bucket entry's value. Entries are `ManagedEntry` (`{state, value, updatedAt}`), but a
 * hand-authored manifest may also write a bare value, so both shapes are read and each is written
 * back in the shape it arrived in.
 */
function entryValue(entry: unknown): unknown {
  return isJsonObject(entry) && "value" in entry ? entry.value : entry;
}

function withEntryValue(entry: unknown, value: unknown): unknown {
  return isJsonObject(entry) && "value" in entry ? { ...entry, value } : value;
}

/**
 * The payload a manifest profile should be persisted as: every value it declares under a managed
 * secret key sealed, and the stored sealed value kept when the manifest declares the same one.
 *
 * `storedPayloadJson` is the row this write replaces (null at link time). An unparseable stored
 * payload protects nothing, so it cannot be the basis of a refusal. Returns a refusal, never a
 * partial payload, when the manifest tries to replace an already-sealed stored value, or when a
 * value cannot be sealed (no `PLATFORM_KEK`): a secret is never persisted unsealed.
 */
export async function sealedProfilePayload(
  env: Env,
  product: string,
  profileId: string,
  payload: Record<string, unknown>,
  isSecretKey: (key: string) => boolean,
  storedPayloadJson: string | null | undefined,
): Promise<SealedPayloadResult> {
  const stored = parseJsonObject(storedPayloadJson) ?? {};
  const next: Record<string, unknown> = { ...payload };

  for (const bucket of SECRET_BEARING_BUCKETS) {
    const entries = payload[bucket];
    if (!isJsonObject(entries)) continue;
    const storedBucket = stored[bucket];
    const storedEntries = isJsonObject(storedBucket) ? storedBucket : {};
    const sealedEntries: Record<string, unknown> = { ...entries };
    for (const [key, entry] of Object.entries(entries)) {
      if (!isSecretKey(key)) continue;
      const value = entryValue(entry);
      // An empty slot holds nothing to protect, and sealing `null` would turn "no value" into
      // an envelope.
      if (value === undefined || value === null) continue;
      const storedValue = entryValue(storedEntries[key]);

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
            `in profile ${JSON.stringify(profileId)}; a repo push may not replace a secret that is ` +
            `already sealed. Change it in the console, or remove the value from the manifest to ` +
            `keep the stored one`,
        };
      }

      try {
        sealedEntries[key] = withEntryValue(
          entry,
          await sealManagedValue(env, product, key, value),
        );
      } catch (e) {
        return {
          ok: false,
          error: `cannot seal the value the manifest declares for secret ${JSON.stringify(key)} in profile ${JSON.stringify(profileId)}: ${e instanceof Error ? e.message : "sealing failed"}`,
        };
      }
    }
    next[bucket] = sealedEntries;
  }

  return { ok: true, payload: next };
}
