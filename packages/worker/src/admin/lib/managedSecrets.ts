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
 * The AAD is `pkey:v2:<product>:managed-secret:<key>`, so a ciphertext is bound to the product
 * AND to the catalog key it was written under: moving a sealed blob between products, or between
 * two keys of the same product, fails the auth tag rather than decrypting.
 *
 * `openManagedValue` is deliberately tolerant of a plaintext value. Sealing is AES-GCM, which
 * SQLite cannot do, so rows written before this change cannot be re-sealed by a `.sql`
 * migration; they are migrated lazily instead — read as plaintext, re-sealed on the next admin
 * write. `isSealedEnvelope` is what keeps that unambiguous, and it is also what stops a
 * state-only edit (`{key, state}` with no `value`) from double-sealing an already-sealed value.
 *
 * ── ADJ-03: THE AAD CHANGED, AND THAT NEEDED A SECOND LAZY MIGRATION ─────────────────────────
 *
 * These values were originally sealed as `kind: "product-secret"` with `id: "managed:" + key`,
 * i.e. AAD `pkey:v2:<product>:product-secret:managed:<key>`. `core/products.ts`'s per-product
 * secrets use the SAME kind with `id: name`, so a product secret named `managed:<key>` produced
 * a byte-identical AAD and the two slots aliased — separated only by a prefix convention that
 * nothing enforced. `keyvault.ts` now carries a `"managed-secret"` kind and this file uses it
 * with a bare `id`, which makes the namespaces structurally disjoint instead of lexically so.
 *
 * Changing an AAD invalidates every blob written under the old one, so `openEither` reads BOTH:
 * current context first, then the pre-ADJ-03 one. A legacy envelope is re-sealed under the new
 * context by `sealManagedValue` on the next write that touches it, so the fallback drains over
 * time without a migration script — the same lazy shape the plaintext case above already uses.
 */

import type { Catalog } from "@polaris-key/catalog";
import type { ManagedEntry } from "@polaris-key/protocol";
import type { ManagedPayload } from "../../core/payload.js";
import type { Env } from "../../env.js";
import { open, seal, type SealContext } from "../../keyvault.js";

function ctx(product: string, key: string): SealContext {
  return { product, kind: "managed-secret", id: key };
}

/** The pre-ADJ-03 slot. READ-ONLY: nothing seals under this again. */
function legacyCtx(product: string, key: string): SealContext {
  return { product, kind: "product-secret", id: `managed:${key}` };
}

/**
 * Open an envelope under the current context, falling back to the pre-ADJ-03 one.
 *
 * Returns which context won, because that is what the write path needs to know whether it owes
 * a re-seal. Null means neither opened — the caller must treat that as "no usable value"; a
 * wrong or partial plaintext never escapes, because AES-GCM's auth tag makes "the other AAD"
 * a hard failure rather than a garbled success.
 */
async function openEither(
  env: Env,
  product: string,
  key: string,
  sealed: string,
): Promise<{ plaintext: string; legacy: boolean } | null> {
  try {
    return {
      plaintext: await open(env, sealed, ctx(product, key)),
      legacy: false,
    };
  } catch {
    /* not the current slot — try the one it may have been written under */
  }
  try {
    return {
      plaintext: await open(env, sealed, legacyCtx(product, key)),
      legacy: true,
    };
  } catch {
    return null;
  }
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
  if (isSealedEnvelope(value)) {
    // Already sealed — but possibly under the pre-ADJ-03 AAD. This is the WRITE half of that
    // lazy migration: carrying a legacy blob forward untouched keeps working (openEither reads
    // it), re-sealing it here retires it. A blob that opens under neither context is returned
    // EXACTLY as it was: re-sealing something we cannot read would replace the only copy of a
    // value an operator may still be able to recover with a KEK we do not currently hold.
    const opened = await openEither(env, product, key, value as string);
    if (!opened || !opened.legacy) return value as string;
    return seal(env, opened.plaintext, ctx(product, key));
  }
  const plaintext = typeof value === "string" ? value : JSON.stringify(value);
  return seal(env, plaintext, ctx(product, key));
}

/**
 * Re-seal an existing envelope under the ACTIVE KEK and the CURRENT AAD, verifying the round
 * trip before returning.
 *
 * This is the KEK-rotation sweep's entry point (`admin/handlers/products.ts`), and it is a
 * separate function from `sealManagedValue` because the two want opposite things from an
 * already-sealed input: the write path leaves a current-context envelope alone, whereas the
 * sweep exists precisely to rewrite one under a newer key.
 *
 * THROWS when the value opens under neither context or does not round-trip — the sweep records
 * that as a per-row failure, which is the whole reason it never overwrites first and checks
 * after.
 */
export async function resealManagedValue(
  env: Env,
  product: string,
  key: string,
  sealed: string,
): Promise<string> {
  const opened = await openEither(env, product, key, sealed);
  if (!opened) throw new Error("sealed value did not open under any known AAD");
  const next = await seal(env, opened.plaintext, ctx(product, key));
  if ((await open(env, next, ctx(product, key))) !== opened.plaintext)
    throw new Error("re-sealed value did not round-trip");
  return next;
}

/**
 * Does a stored value already hold exactly `value`?
 *
 * The manifest ingest needs this and `openManagedValue` cannot answer it: sealing uses a random
 * IV, so re-sealing the same plaintext yields a different envelope and a byte comparison of two
 * envelopes is meaningless. Comparing the SEALED PLAINTEXT is exact — `sealManagedValue` derives
 * it from the value by a fixed rule, so the same value always produces the same plaintext.
 *
 * Fails CLOSED: an envelope that will not open is never reported as matching, so a resync facing
 * a value it cannot read refuses rather than silently overwriting it.
 */
export async function managedValueMatches(
  env: Env,
  product: string,
  key: string,
  stored: unknown,
  value: unknown,
): Promise<boolean> {
  const wanted = typeof value === "string" ? value : JSON.stringify(value);
  if (!isSealedEnvelope(stored)) {
    const have = typeof stored === "string" ? stored : JSON.stringify(stored);
    return have === wanted;
  }
  const opened = await openEither(env, product, key, stored as string);
  return opened?.plaintext === wanted;
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
  const opened = await openEither(env, product, key, value as string);
  if (!opened) return null;
  try {
    return JSON.parse(opened.plaintext) as unknown;
  } catch {
    return opened.plaintext;
  }
}

/**
 * Open every sealed value in a resolved payload, in place of the envelopes.
 *
 * This is the reader half of R12-02 and belongs immediately before a payload is minted into a
 * signed config doc or rendered to an owner. NOT yet wired into `resolveEffective`
 * (`licenseCore.ts`) — see the Remediation section of R11-data.md for the exact call-site
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
