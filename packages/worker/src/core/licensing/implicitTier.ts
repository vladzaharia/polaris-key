/**
 * LX-33.2: the implicit Default tier is invisible.
 *
 * Every product that has a Default tier (`tiers.implicit = 1`, at most one per product) gives it to
 * the licences that were issued without a tier. A licence on it must render exactly the bytes a
 * licence with `tier_id` NULL renders: no `license.tier` / `license.tierLabel` stamp, no
 * tier-sourced limit, no tier in a customer answer, no tier profile. The console and the admin API
 * may still show it as "Default".
 *
 * This file is the one place that knows. Every reader that hands a tier to the old limits chain, or
 * puts a tier in front of a device or a customer, goes through it (`test/implicitTier.test.ts`
 * scans for strays).
 */
import type { Db } from "../../db/types.js";
import type { LicenseRow, TierRow } from "../repo.js";

/** Whether `tier` is its product's implicit Default tier. */
export function isImplicitTier(
  tier: { implicit?: number | null } | null | undefined,
): boolean {
  return tier?.implicit === 1;
}

/** The tier the old limits chain sees: an implicit tier is no tier. */
export function chainTier<T extends { implicit?: number | null }>(
  tier: T | null | undefined,
): T | null {
  return tier && !isImplicitTier(tier) ? tier : null;
}

/**
 * The tier a device or customer sees on a licence: `null` for no tier and for the implicit tier.
 * A dangling `tier_id` (no row) keeps its id with no label, as it always has.
 */
export function customerTierOf(
  license: Pick<LicenseRow, "tier_id">,
  tier: Pick<TierRow, "label" | "implicit"> | null | undefined,
): { id: string; label: string | null } | null {
  if (!license.tier_id || isImplicitTier(tier)) return null;
  return { id: license.tier_id, label: tier?.label ?? null };
}

/** The product's implicit tier id, or null when it has none. */
export async function implicitTierIdOf(
  db: Db,
  product: string,
): Promise<string | null> {
  const row = await db.first<{ id: string }>(
    "SELECT id FROM tiers WHERE product = ? AND implicit = 1",
    product,
  );
  return row?.id ?? null;
}

/** {@link customerTierOf}'s id for a caller that holds no tier row (one small read). */
export async function customerTierId(
  db: Db,
  license: Pick<LicenseRow, "product" | "tier_id">,
): Promise<string | null> {
  if (!license.tier_id) return null;
  return (await implicitTierIdOf(db, license.product)) === license.tier_id
    ? null
    : license.tier_id;
}
