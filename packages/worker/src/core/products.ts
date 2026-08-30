// Product context — assembled from the `products` row + active schema version + the
// per-product signing key. The signing key is now KEK-custodied: it lives sealed in the
// `product_keys` table and is opened under `env.PLATFORM_KEK` (src/keyvault.ts), NOT resolved
// from a Worker secret by name. Fails closed if there is no active product key or it can't be
// decrypted: a product with no usable key can never sign config.
//
// The unseal is LAZY (B5-12): `loadProduct` runs before dispatch on every product-scoped
// request, and the overwhelming majority of routes never sign anything, so opening the private
// key eagerly made an AES-GCM decrypt the price of admission to `/jwks`, `/discovery`,
// `/devices`, `/config/schema` and the whole release surface. See `Product.signingKey`.

import type { Env } from "../env.js";
import type { Db } from "../db/types.js";
import {
  getActiveAnchorKey,
  getActiveProductKey,
  getActiveProductKeys,
  getActiveSchema,
  getProduct,
  getProductSecret,
  listVerificationProductKeys,
  productKeyRole,
  type ProductKeyRow,
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

export interface Product {
  slug: string;
  name: string;
  signingKid: string;
  /**
   * Open the product's sealed signing key (PEM), or `null` if it cannot be opened (B5-12).
   *
   * A FUNCTION, not a field, because unsealing is the single most expensive thing a
   * product-scoped request used to do and almost no route needs it: `loadProduct` runs before
   * dispatch and before rate limiting, so every `/jwks`, `/discovery`, `/devices`, `/register`,
   * `/config/schema` and `/release/*` request paid one AES-GCM open of the private key it was
   * never going to use — an unauthenticated CPU amplifier reachable by URL alone. The unseal now
   * happens on first call and is MEMOISED, so the routes that do sign (and the bundle mint,
   * which signs three times) pay for exactly one.
   *
   * `null` rather than a throw, so the type forces every caller to answer "what do I do when
   * this product cannot sign?" — the answer is always the same as it was when `loadProduct`
   * itself returned null: refuse. What did NOT move is the `getActiveProductKey` lookup, which
   * is a cheap indexed read and is what keeps "no active key ⇒ no Product ⇒ 404" true for every
   * route, signing or not. Only the "the row exists but the KEK cannot open it" case is
   * deferred, and every signing site below turns that into the same refusal it produced before.
   */
  signingKey: () => Promise<string | null>;
  signingPub: string | null;
  /**
   * The product's TRUST ANCHOR (wire v3 §1.1) — the only key that may sign a `pkey-trust+jws`,
   * and the key host applications pin.
   *
   * Separate from `signingKid`/`signingKey` above, and that separation is the whole of B3-01:
   * the manifest used to be signed by the same rotating active key that signs documents, while
   * clients verify a manifest against PINNED keys only, so the first rotation made every
   * installed client refuse every later manifest — and with it every revocation. The anchor is a
   * longer-lived key that rotation does not touch, NOT a relaxation of the pinning rule.
   *
   * Same lazy+memoised open as `signingKey`, and the SAME promise when the two are the same row:
   * migration 0026 promotes each existing product's active key to be its anchor, because minting
   * a second keypair needs Ed25519 keygen and a KEK seal that SQL cannot do. Until that product's
   * first document-key rotation the anchor signs documents too — exactly what it did before —
   * and the split becomes real the moment a document key is activated.
   */
  trustAnchorKid: string;
  trustAnchorKey: () => Promise<string | null>;
  trustAnchorPub: string | null;
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
}

export interface PublicSigningKey {
  kid: string;
  alg: string;
  publicKey: string;
  status: string;
  /** `'anchor' | 'document'` (wire v3 §1.1). Published as ADVISORY metadata — it tells an
   *  operator which key to pin and is never an input to any verification decision. */
  role: "anchor" | "document";
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
      role: productKeyRole(keyRow),
    };
  } catch {
    return null;
  }
}

/** The product's active TRUST ANCHOR, public half only (§1.1) — what an adopter pins. Same
 *  degrade-safely contract as `loadPublicSigningKey`: null rather than a throw. */
export async function loadPublicAnchorKey(
  db: Db,
  slug: string,
): Promise<PublicSigningKey | null> {
  try {
    const keyRow = await getActiveAnchorKey(db, slug);
    if (!keyRow) return null;
    return {
      kid: keyRow.kid,
      alg: keyRow.alg,
      publicKey: keyRow.public_b64url,
      status: keyRow.status,
      role: productKeyRole(keyRow),
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
      role: productKeyRole(row),
    }));
  } catch {
    return [];
  }
}

/** Load a product + a lazy handle on its signing key. Returns null for an unknown product or a
 *  product with no ACTIVE ANCHOR row (fail-closed: no key ⇒ no Product ⇒ no route at all). A key
 *  that exists but cannot be decrypted is fail-closed too, one level down — see `signingKey`. */
export async function loadProduct(
  env: Env,
  db: Db,
  slug: string,
): Promise<Product | null> {
  const row = await getProduct(db, slug);
  if (!row) return null;
  const active = await getActiveProductKeys(db, slug);
  // TWO roles, ONE fail-closed condition — still "no active key ⇒ no Product ⇒ 404", exactly as
  // before. Neither role introduces a NEW way for a product to disappear, and that is a
  // deliberate choice rather than an oversight:
  //
  //   * anchor missing  ⇒ fall back to the document key. Post-0026 this is unreachable (the
  //     migration promotes every product's active key to anchor, both create paths mint one, and
  //     retiring or revoking an active key is refused with a 409). It exists for the one shape
  //     that IS reachable in this repo's history: a migration that dies part way, which R11-04
  //     documents as a real event. In that state the fallback reproduces exactly the behaviour
  //     the product had before 0026 — B3-01, i.e. rotation does not yet help it — while the
  //     alternative, refusing the product outright, would take every route it has to 404,
  //     revocation included. A degraded rotation story beats a total outage.
  //   * document missing ⇒ fall back to the anchor. This is the ORDINARY 0026 state for an
  //     existing product: no keypair can be minted in SQL, so the promoted key is both until the
  //     first document-key rotation splits them for real.
  const anchorRow = active.anchor ?? active.document;
  const keyRow = active.document ?? active.anchor;
  if (!anchorRow || !keyRow) return null;
  try {
    // Deferred and memoised (B5-12). `.catch(() => null)` is attached HERE, at construction, so
    // the memoised promise can never be an unhandled rejection no matter how many callers (or
    // none) await it, and every caller sees the same `null` for "this product cannot sign".
    const opener = (keyRow: ProductKeyRow): (() => Promise<string | null>) => {
      let opened: Promise<string | null> | undefined;
      return () => {
        opened ??= open(env, keyRow.enc_private_json, {
          product: slug,
          kind: "signing-key",
          id: keyRow.kid,
        }).catch(() => null);
        return opened;
      };
    };
    const signingKey = opener(keyRow);
    // ONE memoised open when the two roles are the same row (the 0026 transitional state), so a
    // bundle mint — which signs a licence, a config document and a manifest — still pays for a
    // single AES-GCM open rather than two.
    const trustAnchorKey =
      anchorRow.kid === keyRow.kid ? signingKey : opener(anchorRow);
    const schema = await getActiveSchema(db, slug);
    const parsedServices = parseServices(row.services_json);
    return {
      slug: row.slug,
      name: row.name,
      signingKid: keyRow.kid,
      signingKey,
      signingPub: keyRow.public_b64url,
      trustAnchorKid: anchorRow.kid,
      trustAnchorKey,
      trustAnchorPub: anchorRow.public_b64url,
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
    };
  } catch {
    return null;
  }
}

/** Open a sealed per-product secret by name. Returns undefined if the row is absent or the
 *  sealed value fails to decrypt (fail-closed — never a wrong/partial value). */
export async function openProductSecret(
  db: Db,
  env: Env,
  product: string,
  name: string,
): Promise<string | undefined> {
  const row = await getProductSecret(db, product, name);
  if (!row) return undefined;
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
 * Set a product's global compatibility window (spec §8, P2.T3).
 *
 * The window relocated from `PATCH /manage/api/products/<slug>` to `update/settings`: it is a
 * statement about which BUILDS this product supports, which is the Update service's subject, and
 * leaving it on the product PATCH meant one console form edited two unrelated policies. The row
 * stays core-owned (`products` is Core's per spec §5.2), so the writer lives here and Update
 * reaches it through Core rather than reaching into the table.
 *
 * `undefined` leaves a bound alone; the COALESCE keeps a partial patch partial.
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
            modified_at = ?
      WHERE slug = ?`,
    window.min ?? null,
    window.max ?? null,
    now,
    slug,
  );
}
