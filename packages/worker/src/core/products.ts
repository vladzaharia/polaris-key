// Product context — assembled from the `products` row + active schema version + the
// per-product signing key. The signing key is KEK-custodied: it lives sealed in the
// `product_keys` table and is opened under `env.PLATFORM_KEK` only when a route signs. A
// product without an active key does not exist to product routes; an unreadable key cannot sign.

import {
  isHexColour,
  normalizeAssetRef,
  type ManifestAssetRef,
  type ManifestPresentation,
} from "@polaris-key/manifest";
import type { Env } from "../platform/env.js";
import type { Db } from "../db/types.js";
import {
  getActiveProductKey,
  getActiveSchema,
  getProduct,
  getProductSecret,
  listVerificationProductKeys,
} from "./products/store.js";
import type { ProductRow } from "./repo.js";
import { open } from "../platform/keyvault.js";
import {
  parseAutoIssue,
  parseFingerprintPolicy,
  type AutoIssuePolicy,
  type FingerprintPolicy,
} from "./fingerprint.js";
import {
  parseServices,
  resolveRegistration,
  type RegistrationPolicy,
  type ServicesMap,
} from "./services.js";
import { parseWebOrigins } from "./cors.js";
import { parseTrustPolicy, type TrustPolicy } from "./trust/deviceTrust.js";

export interface Product {
  slug: string;
  name: string;
  signingKid: string;
  /**
   * Opens the active signing key only when a route needs to sign. An unreadable sealed key
   * answers `null`, and the result is memoized for this loaded product.
   */
  signingKey: () => Promise<string | null>;
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
  /** The operator's device-trust policy (P6-02, `core/trust/deviceTrust.ts`). Optional so a hand-built
   *  product reads as the default policy; the loader always sets it. */
  trustPolicy?: TrustPolicy;
  /**
   * `.pkey/product` `presentation` (HA-04), stored by the manifest writers in
   * `products.presentation_json` (HA-12): the icon ref and the light and dark accents. `null` when
   * undeclared or unreadable. Optional so a hand-built product reads as none; the loaders always
   * set it. Discovery's `core.presentation` (`core/presentation.ts`) reads the accents from it;
   * the icon ref itself never leaves the Worker.
   */
  presentation?: ManifestPresentation | null;
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

/**
 * A product without its signing-key accessor: everything a route that never signs needs.
 *
 * The bytes host (`core/assets/bytesHost.ts`) serves downloads; no byte route signs anything, so
 * handing it the accessor would give private-key capability to code that has no use for it. Byte
 * routes get this shape instead (least privilege), and every Core check a download needs
 * (`validateDeviceToken`, `usableLicensedDevice`, `entitledAccessCheck`) takes it.
 */
export type ProductPublic = Omit<Product, "signingKey">;

/** A stored icon ref (`ManifestAssetRef`, as `serializePresentation` wrote it), or `null`. */
function storedAssetRef(v: unknown): ManifestAssetRef | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const ref = normalizeAssetRef(
    typeof r.sha256 === "string"
      ? { src: r.src, sha256: r.sha256 }
      : { src: r.src },
  );
  return ref && ref.kind === r.kind ? ref : null;
}

/**
 * `products.presentation_json` read back (HA-12), defensively: anything that is not the shape
 * `serializePresentation` writes reads as `null`, and a member that fails the manifest's own rule
 * (an `#rrggbb` accent, a valid asset ref) is dropped. `null` too when nothing is declared, so
 * "unset" has one spelling. The `core.presentation` setting's column adapter decodes with this.
 */
export function parseStoredPresentation(
  raw: unknown,
): ManifestPresentation | null {
  if (typeof raw !== "string" || raw === "") return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const out: ManifestPresentation = {};
  const icon = storedAssetRef(r.icon);
  if (icon) out.icon = icon;
  if (isHexColour(r.accent)) out.accent = r.accent;
  if (isHexColour(r.accentDark)) out.accentDark = r.accentDark;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The value the manifest writers store in `products.presentation_json` (link, resync, the system
 * product's deploy hook): the parsed manifest's `presentation` as canonical JSON (members in a
 * fixed order), or `null` (SQL NULL) when the manifest declares none.
 */
export function serializePresentation(
  presentation: ManifestPresentation | null | undefined,
): string | null {
  if (!presentation) return null;
  const out: ManifestPresentation = {};
  if (presentation.icon)
    out.icon = {
      kind: presentation.icon.kind,
      src: presentation.icon.src,
      ...(presentation.icon.sha256 ? { sha256: presentation.icon.sha256 } : {}),
    };
  if (presentation.accent) out.accent = presentation.accent;
  if (presentation.accentDark) out.accentDark = presentation.accentDark;
  return Object.keys(out).length > 0 ? JSON.stringify(out) : null;
}

/** The row-derived half of a product, shared by both loaders below. */
function productFields(
  row: NonNullable<Awaited<ReturnType<typeof getProduct>>>,
  keyRow: NonNullable<Awaited<ReturnType<typeof getActiveProductKey>>>,
  schemaVersion: number,
): ProductPublic {
  const parsedServices = parseServices(row.services_json);
  return {
    slug: row.slug,
    name: row.name,
    signingKid: keyRow.kid,
    signingPub: keyRow.public_b64url,
    compatMin: row.compat_min,
    compatMax: row.compat_max,
    defaultMaxOfflineDays: row.default_max_offline_days,
    defaultDeviceLimit: row.default_device_limit,
    adminGroup: row.admin_group,
    schemaVersion,
    fingerprintPolicy: parseFingerprintPolicy(row.fingerprint_policy_json),
    autoIssue: parseAutoIssue(row.auto_issue_json),
    services: parsedServices.services,
    registration: resolveRegistration(parsedServices.services),
    webOrigins: parseWebOrigins(row.web_origins_json),
    trustPolicy: parseTrustPolicy(row.trust_policy_json),
    presentation: parseStoredPresentation(row.presentation_json),
  };
}

/** Build a product from a row already read, with a lazy accessor for its sealed signing key.
 *  `null` when it has no active key. An unreadable sealed key remains a product-level signing
 *  refusal rather than making unrelated product routes unavailable. */
async function productFromRow(
  env: Env,
  db: Db,
  row: ProductRow,
): Promise<Product | null> {
  const slug = row.slug;
  const keyRow = await getActiveProductKey(db, slug);
  if (!keyRow) return null;
  try {
    const schema = await getActiveSchema(db, slug);
    let opened: Promise<string | null> | undefined;
    const signingKey = (): Promise<string | null> => {
      opened ??= open(env, keyRow.enc_private_json, {
        product: slug,
        kind: "signing-key",
        id: keyRow.kid,
      }).catch(() => null);
      return opened;
    };
    return {
      ...productFields(row, keyRow, schema?.catalog_version ?? 1),
      signingKey,
    };
  } catch {
    return null;
  }
}

/** Load a product with a lazy accessor for its sealed signing key. Returns null for an unknown
 *  product or one with no active key. */
export async function loadProduct(
  env: Env,
  db: Db,
  slug: string,
): Promise<Product | null> {
  const row = await getProduct(db, slug);
  return row ? productFromRow(env, db, row) : null;
}

/**
 * One product, for the length of one request (P0-22). The dispatcher reads the row once to route
 * and check the area; everything after it asks the context, so a request reads the product row
 * once and, if a handler needs the full `Product`, loads it once (`load()` memoises, and the
 * sealed signing key stays lazy inside it: nothing is unsealed until `signingKey()` is called).
 */
export interface ProductContext {
  /** The row the dispatcher read. */
  readonly row: ProductRow;
  /** The full product, loaded at most once per context. `null` when it has no active key. */
  load(): Promise<Product | null>;
}

export function loadProductContext(
  env: Env,
  db: Db,
  row: ProductRow,
): ProductContext {
  let loaded: Promise<Product | null> | undefined;
  return {
    row,
    load: () => (loaded ??= productFromRow(env, db, row)),
  };
}

/**
 * Load a product without its signing-key accessor (`ProductPublic`). Same existence rule as
 * `loadProduct` — an unknown product, or one with no active key, is `null` — so the two can
 * never disagree about whether a product exists.
 */
export async function loadProductPublic(
  db: Db,
  slug: string,
): Promise<ProductPublic | null> {
  const row = await getProduct(db, slug);
  if (!row) return null;
  const keyRow = await getActiveProductKey(db, slug);
  if (!keyRow) return null;
  const schema = await getActiveSchema(db, slug);
  return productFields(row, keyRow, schema?.catalog_version ?? 1);
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
