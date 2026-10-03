/**
 * R12-02 — envelope encryption for catalog-declared managed secrets.
 *
 * Every OTHER secret class in the system is sealed under `PLATFORM_KEK`:
 * `product_keys.enc_private_json` and `product_secrets.enc_value_json` both go through
 * `keyvault.seal()`, and `env.ts` states the design as fact ("Product signing keys, OIDC client
 * secrets, and edge-mint key material are sealed in D1 under PLATFORM_KEK"). Catalog-declared
 * secrets — `kind: "secret"` entries and `kind: "config"` entries flagged `secret: true` — were
 * the exception nobody wrote down: `applyOverrides` wrote them verbatim into
 * `profiles.payload_json` and `licenses.overrides_json`. A read-only D1 dump (a leaked
 * Cloudflare API token, a support export, a restored backup) therefore yielded every
 * product-delivered secret in cleartext, and the KEK gave no protection at all.
 *
 * The AAD is `pkey:v2:<product>:product-secret:managed:<key>`, so a ciphertext is bound to the
 * product AND to the catalog key it was written under: moving a sealed blob between products,
 * or between two keys of the same product, fails the auth tag rather than decrypting.
 *
 * `openManagedValue` is deliberately tolerant of a plaintext value. Sealing is AES-GCM, which
 * SQLite cannot do, so rows written before this change cannot be re-sealed by a `.sql`
 * migration; they are migrated lazily instead — read as plaintext, re-sealed on the next admin
 * write. `isSealedEnvelope` is what keeps that unambiguous, and it is also what stops a
 * state-only edit (`{key, state}` with no `value`) from double-sealing an already-sealed value.
 */

import type { Catalog } from "@polaris-key/catalog";
import type { ManagedEntry } from "@polaris-key/protocol";
import type { ManagedPayload } from "../../core/payload.js";
import type { Env } from "../../env.js";
import { open, seal, type SealContext } from "../../keyvault.js";

function ctx(product: string, key: string): SealContext {
  return { product, kind: "product-secret", id: `managed:${key}` };
}

/** True when a catalog key's stored value must be sealed at rest. */
export function isManagedSecretKey(catalog: Catalog, key: string): boolean {
  const entry = catalog.entryByKey(key);
  if (!entry) return false;
  return entry.kind === "secret" || entry.secret === true;
}

/** Does this stored value already carry a `Sealed` envelope? */
export function isSealedEnvelope(value: unknown): boolean {
  if (typeof value !== "string" || !value.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(value) as { v?: unknown; ct?: unknown };
    return parsed.v === 2 && typeof parsed.ct === "string";
  } catch {
    return false;
  }
}

/** Seal one managed secret value. Non-strings are JSON-encoded first so the round trip is
 *  lossless. THROWS when `PLATFORM_KEK` is missing — a secret is never persisted unsealed. */
export async function sealManagedValue(
  env: Env,
  product: string,
  key: string,
  value: unknown,
): Promise<string> {
  if (isSealedEnvelope(value)) return value as string;
  const plaintext = typeof value === "string" ? value : JSON.stringify(value);
  return seal(env, plaintext, ctx(product, key));
}

/** Open one managed secret value. A legacy plaintext value is returned as-is (lazy migration);
 *  a value that IS an envelope but fails to open returns null, so a wrong or partial plaintext
 *  can never escape. */
export async function openManagedValue(
  env: Env,
  product: string,
  key: string,
  value: unknown,
): Promise<unknown> {
  if (!isSealedEnvelope(value)) return value;
  let plaintext: string;
  try {
    plaintext = await open(env, value as string, ctx(product, key));
  } catch {
    return null;
  }
  try {
    return JSON.parse(plaintext) as unknown;
  } catch {
    return plaintext;
  }
}

/**
 * Open every sealed value in a resolved payload, in place of the envelopes.
 *
 * This is the reader half of R12-02 and belongs immediately before a payload is minted into a
 * signed config doc or rendered to an owner. NOT yet wired into `resolveEffective`
 * (`licenseCore.ts`) — see the Remediation section of the R11 audit findings for the exact call-site
 * change handed to the licensing lane.
 */
export async function openManagedPayload(
  env: Env,
  product: string,
  payload: ManagedPayload,
): Promise<ManagedPayload> {
  const openBucket = async (
    entries: Record<string, ManagedEntry>,
  ): Promise<Record<string, ManagedEntry>> => {
    const out: Record<string, ManagedEntry> = {};
    for (const [key, entry] of Object.entries(entries)) {
      out[key] = isSealedEnvelope(entry.value)
        ? {
            ...entry,
            value: (await openManagedValue(
              env,
              product,
              key,
              entry.value,
            )) as ManagedEntry["value"],
          }
        : entry;
    }
    return out;
  };
  return {
    config: await openBucket(payload.config ?? {}),
    secrets: await openBucket(payload.secrets ?? {}),
    entitlements: payload.entitlements ?? {},
  };
}
