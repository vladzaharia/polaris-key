/**
 * Output shaping for the admin surface: license summaries, the product-registry view, and
 * the active-catalog loader used for value validation + redaction.
 */

import { Catalog } from "@polaris-key/catalog";
import type { Db } from "../../db/types.js";
import {
  listMachinesByLicense,
  getActiveSchema,
  type LicenseRow,
  type ProductRow,
} from "../../repo.js";
import { loadPublicSigningKey } from "../../product.js";
import { countKeysByLicense } from "../repo.js";

/** Load + compile a product's active catalog (for value validation). Null if none/invalid. */
export async function loadCatalog(
  db: Db,
  product: string,
): Promise<Catalog | null> {
  const row = await getActiveSchema(db, product);
  if (!row) return null;
  try {
    return new Catalog(JSON.parse(row.catalog_json));
  } catch {
    return null;
  }
}

/** The list/detail summary projection of a license row (with derived key + machine counts). */
export async function licenseSummary(
  db: Db,
  product: string,
  row: LicenseRow,
): Promise<Record<string, unknown>> {
  const keyCounts = await countKeysByLicense(db, product, row.id);
  const machines = await listMachinesByLicense(db, product, row.id);
  return {
    id: row.id,
    name: row.name ?? "",
    email: row.email ?? "",
    status: row.status,
    enrolledAt: row.enrolled_at,
    expiresAt: row.expires_at,
    keyCount: keyCounts.total,
    activeKeyCount: keyCounts.active,
    machineCount: machines.filter((m) => m.status === "authorized").length,
    profile: row.profile_id,
    tier: row.tier_id,
    channels: row.channels_json
      ? (JSON.parse(row.channels_json) as string[])
      : [],
    minVersion: row.min_version,
    maxVersion: row.max_version,
    identityProvider: row.sub ? "oidc" : "manual",
    oidcSubject: row.sub ?? undefined,
    modifiedBy: row.modified_by ?? undefined,
    modifiedAt: row.modified_at,
  };
}

/** The registry projection of a product row. */
export async function productView(
  db: Db,
  p: ProductRow,
): Promise<Record<string, unknown>> {
  const activeKey = await loadPublicSigningKey(db, p.slug);
  const signingKid = activeKey?.kid ?? p.signing_kid;
  const signingPublicKey = activeKey?.publicKey ?? p.signing_pub;
  const signingAlg = activeKey?.alg ?? "Ed25519";
  const jwksUrl = `/${p.slug}/.well-known/jwks.json`;
  const signing = signingPublicKey
    ? {
        kid: signingKid,
        alg: signingAlg,
        publicKey: signingPublicKey,
        jwksUrl,
        trustKeys: { [signingKid]: signingPublicKey },
      }
    : null;
  return {
    slug: p.slug,
    name: p.name,
    releaseSource: p.release_source ?? "manual",
    signingKid,
    signingPublicKey,
    publicKey: signingPublicKey,
    trustKey: signingPublicKey,
    trustKeys: signingPublicKey ? { [signingKid]: signingPublicKey } : {},
    jwksUrl,
    signing,
    signingKey: signing,
    compatMin: p.compat_min,
    compatMax: p.compat_max,
    defaultMaxOfflineDays: p.default_max_offline_days,
    defaultMachineLimit: p.default_machine_limit,
    adminGroup: p.admin_group,
    createdAt: p.created_at,
    modifiedAt: p.modified_at,
  };
}
