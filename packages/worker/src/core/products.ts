// Product context — assembled from the `products` row + active schema version + the
// per-product signing key. The signing key is now KEK-custodied: it lives sealed in the
// `product_keys` table and is opened per request under `env.PLATFORM_KEK` (src/keyvault.ts),
// NOT resolved from a Worker secret by name. Fails closed if there is no active product key
// or it can't be decrypted: a product with no usable key can never sign config.

import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import {
  getActiveProductKey,
  getActiveSchema,
  getProduct,
  getProductSecret,
  listVerificationProductKeys,
} from "../repo.js";
import { open } from "../keyvault.js";
import {
  parseAutoIssue,
  parseFingerprintPolicy,
  type AutoIssuePolicy,
  type FingerprintPolicy,
} from "../fingerprint.js";
import {
  parseServices,
  resolveRegistration,
  type RegistrationPolicy,
  type ServicesMap,
} from "./services.js";
import { parseWebOrigins } from "./cors.js";

export interface Product {
  slug: string;
  name: string;
  signingKid: string;
  signingKeyPem: string;
  signingPub: string | null;
  compatMin: string;
  compatMax: string;
  defaultMaxOfflineDays: number;
  defaultDeviceLimit: number;
  adminGroup: string | null;
  schemaVersion: number;
  fingerprintPolicy: FingerprintPolicy;
  autoIssue: AutoIssuePolicy;
  /** Which Polaris Key services this product runs (design spec §2.2). Always complete: a row that
   *  has never been written reads back as the defaults, i.e. today's behaviour. */
  services: ServicesMap;
  /** Who may mint a device token here (wire v3 §6). Already RESOLVED — an undeclared policy is
   *  derived from `services` at load, so no caller re-implements the derivation. */
  registration: RegistrationPolicy;
  /** The exact browser origins this product answers CORS for (P0-05, `web.origins`). Empty
   *  when undeclared or unreadable, which means no `Access-Control-*` header is ever sent. */
  webOrigins: readonly string[];
}

export interface PublicSigningKey {
  kid: string;
  alg: string;
  publicKey: string;
  status: string;
}

/** Best-effort public signing-key lookup. This never opens private key material and returns
 *  null instead of throwing so admin/product discovery views can degrade safely. */
export async function loadPublicSigningKey(
  db: Db,
  slug: string,
): Promise<PublicSigningKey | null> {
  try {
    const keyRow = await getActiveProductKey(db, slug);
    if (!keyRow) return null;
    return {
      kid: keyRow.kid,
      alg: keyRow.alg,
      publicKey: keyRow.public_b64url,
      status: keyRow.status,
    };
  } catch {
    return null;
  }
}

export async function loadPublicSigningKeys(
  db: Db,
  slug: string,
  /** Also include keys revoked at/after this time (§2.3's explicit-revocation window).
   *  ONLY the trust manifest passes this — JWKS and discovery build trusted sets. */
  revokedSince?: number,
): Promise<PublicSigningKey[]> {
  try {
    const rows = await listVerificationProductKeys(db, slug, revokedSince);
    return rows.map((row) => ({
      kid: row.kid,
      alg: row.alg,
      publicKey: row.public_b64url,
      status: row.status,
    }));
  } catch {
    return [];
  }
}

/** Load a product + its signing key from the sealed `product_keys` table. Returns null for
 *  an unknown product, a product with no active key, or one whose sealed key fails to open
 *  (fail-closed: no plaintext key ⇒ no Product ⇒ no signed config). */
export async function loadProduct(
  env: Env,
  db: Db,
  slug: string,
): Promise<Product | null> {
  const row = await getProduct(db, slug);
  if (!row) return null;
  const keyRow = await getActiveProductKey(db, slug);
  if (!keyRow) return null;
  try {
    const pem = await open(env, keyRow.enc_private_json, {
      product: slug,
      kind: "signing-key",
      id: keyRow.kid,
    });
    const schema = await getActiveSchema(db, slug);
    const parsedServices = parseServices(row.services_json);
    return {
      slug: row.slug,
      name: row.name,
      signingKid: keyRow.kid,
      signingKeyPem: pem,
      signingPub: keyRow.public_b64url,
      compatMin: row.compat_min,
      compatMax: row.compat_max,
      defaultMaxOfflineDays: row.default_max_offline_days,
      defaultDeviceLimit: row.default_device_limit,
      adminGroup: row.admin_group,
      schemaVersion: schema?.catalog_version ?? 1,
      fingerprintPolicy: parseFingerprintPolicy(row.fingerprint_policy_json),
      autoIssue: parseAutoIssue(row.auto_issue_json),
      services: parsedServices.services,
      registration: resolveRegistration(
        parsedServices.services,
        parsedServices.registration,
      ),
      webOrigins: parseWebOrigins(row.web_origins_json),
    };
  } catch {
    return null;
  }
}

/**
 * What a product secret may be used for (P0-12). `general` is every ordinary secret (stored as
 * NULL); `edge-mint` is key material an operator has explicitly marked for the Config service's
 * edge-mint route. The value is set only through the admin API, never by a `.pkey/` manifest —
 * that is the whole point: a repo writer can NAME a secret in a recipe, but cannot make a
 * secret signable by naming it.
 */
export type SecretUsage = "general" | "edge-mint";

/** The usage a stored `product_secrets.usage` value means, or `null` for a value this code
 *  does not recognise — which matches NO requested usage (fail closed). */
export function secretUsageOf(
  stored: string | null | undefined,
): SecretUsage | null {
  if (stored === null || stored === undefined) return "general";
  if (stored === "edge-mint") return "edge-mint";
  return null;
}

/** The usage of a stored secret by name: `undefined` when there is no such row, `null` when
 *  the stored value is unrecognised. Never opens the sealed value. */
export async function getProductSecretUsage(
  db: Db,
  product: string,
  name: string,
): Promise<SecretUsage | null | undefined> {
  const row = await getProductSecret(db, product, name);
  if (!row) return undefined;
  return secretUsageOf(row.usage);
}

/**
 * Open a sealed per-product secret by name, for ONE required usage. Returns undefined if the
 * row is absent, if its usage is not `usage`, or if the sealed value fails to decrypt
 * (fail-closed — never a wrong/partial value). A usage mismatch deliberately reads as
 * "missing": the caller's existing fail-closed branch (500 `misconfigured`) is the right
 * answer, and the value is never unsealed at all.
 */
export async function openProductSecret(
  db: Db,
  env: Env,
  product: string,
  name: string,
  usage: SecretUsage,
): Promise<string | undefined> {
  const row = await getProductSecret(db, product, name);
  if (!row) return undefined;
  if (secretUsageOf(row.usage) !== usage) return undefined;
  try {
    return await open(env, row.enc_value_json, {
      product,
      kind: "product-secret",
      id: name,
    });
  } catch {
    return undefined;
  }
}

/**
 * Set a product's global compatibility window (spec §8, P2.T3), and CLAIM it for the operator.
 *
 * The window relocated from `PATCH /manage/api/products/<slug>` to `update/settings`: it is a
 * statement about which BUILDS this product supports, which is the Update service's subject, and
 * leaving it on the product PATCH meant one console form edited two unrelated policies. The row
 * stays core-owned (`products` is Core's per spec §5.2), so the writer lives here and Update
 * reaches it through Core rather than reaching into the table.
 *
 * `undefined` leaves a bound alone; the COALESCE keeps a partial patch partial. Either bound
 * flips `compat_source` to `admin` (0022_a), and resync's own UPDATE skips a claimed window — so
 * an operator who narrows the window to stop an incident is not overruled by the next push.
 */
export async function setCompatWindow(
  db: Db,
  slug: string,
  window: { min?: string; max?: string },
  now: number,
): Promise<void> {
  await db.run(
    `UPDATE products
        SET compat_min = COALESCE(?, compat_min),
            compat_max = COALESCE(?, compat_max),
            compat_source = 'admin',
            modified_at = ?
      WHERE slug = ?`,
    window.min ?? null,
    window.max ?? null,
    now,
    slug,
  );
}

/**
 * Hand the compatibility window back to manifest control. Only the owner flips; the stored
 * bounds stay as the operator left them until the next resync re-applies `.pkey/product`.
 */
export async function revertCompatWindowToManifest(
  db: Db,
  slug: string,
  now: number,
): Promise<void> {
  await db.run(
    "UPDATE products SET compat_source = 'manifest', modified_at = ? WHERE slug = ?",
    now,
    slug,
  );
}

/** The stored window and its owner, read fresh (a loaded `Product` may predate a write). */
export async function getCompatWindow(
  db: Db,
  slug: string,
): Promise<{ min: string; max: string; source: "manifest" | "admin" } | null> {
  const row = await getProduct(db, slug);
  if (!row) return null;
  return {
    min: row.compat_min,
    max: row.compat_max,
    source: row.compat_source === "admin" ? "admin" : "manifest",
  };
}
