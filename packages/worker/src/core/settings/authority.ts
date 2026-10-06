/**
 * Manifest-authoritative mode (ST-20, notes/S-18 §4.5 items 7–8, owner decision D2), as the one
 * write path reads it (ST-04): `writeSetting()` refuses a console claim on a manifest-authoritative
 * product unless it is a break-glass claim, and `settingsClaims.ts` re-exports this module for
 * the resync, the deploy hook and the console views. Its own module so `write.ts` and
 * `settingsClaims.ts` do not import each other.
 *
 * The mode is the registry setting `core.manifest.authoritative`: a `product_settings` row for a
 * customer product (off by default, D14), and for the system product (`system = 1`) the registry's
 * lock (`systemLock`, which the system-lock rule in `rules.ts` keeps present), never a row.
 */

import type { Db } from "../../db/types.js";
import { CORE_SLICE } from "./core.js";

/** The mode's registry key (Core's product slice, `settings/core.ts`). */
export const MANIFEST_AUTHORITATIVE_KEY = "core.manifest.authoritative";
/** A break-glass claim lives at most this long (S-18 §4.5 item 7: 7 days). */
export const BREAK_GLASS_MAX_SECONDS = 7 * 24 * 60 * 60;
/** A break-glass reason is 1 to 500 characters, like every other operator reason. */
export const BREAK_GLASS_REASON_MAX = 500;

/**
 * The system product's mode: the registry's lock (`systemLock`). Fails closed: a missing lock
 * still reads on.
 */
export const SYSTEM_AUTHORITATIVE: boolean = (() => {
  const lock = CORE_SLICE.find(
    (e) => e.scope === "product" && e.key === MANIFEST_AUTHORITATIVE_KEY,
  )?.systemLock;
  return lock ? lock.value === true : true;
})();

/** Whether a product is manifest-authoritative, and whether that is locked. */
export interface ManifestAuthority {
  authoritative: boolean;
  /** True for the system product: the registry fixes the value, no row is read. */
  locked: boolean;
  /** The stored row's version; 0 when it was never written (and for a locked value). */
  version: number;
  updatedAt: number | null;
  updatedBy: string | null;
}

/**
 * `core.manifest.authoritative` for `product`. The system product's value is the registry's lock,
 * never a row: an operator cannot delete or overwrite it. A customer product's is its
 * `product_settings` row (`value_json` `true`/`false`); no row is the default, off (D14).
 */
export async function manifestAuthorityOf(
  db: Db,
  product: { slug: string; system?: number | null },
): Promise<ManifestAuthority> {
  if (product.system === 1)
    return {
      authoritative: SYSTEM_AUTHORITATIVE,
      locked: true,
      version: 0,
      updatedAt: null,
      updatedBy: null,
    };
  const row = await db.first<{
    value_json: string | null;
    version: number;
    updated_at: number;
    updated_by: string;
  }>(
    "SELECT value_json, version, updated_at, updated_by FROM product_settings WHERE product = ? AND key = ?",
    product.slug,
    MANIFEST_AUTHORITATIVE_KEY,
  );
  return {
    authoritative: row?.value_json === "true",
    locked: false,
    version: row?.version ?? 0,
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
  };
}

/**
 * The refusal text for a console write to a governed setting of a manifest-authoritative product
 * made without a break-glass claim.
 */
export function manifestAuthoritativeRefusal(product: {
  slug: string;
  system?: number | null;
}): string {
  return product.system === 1
    ? "the system product is manifest-authoritative: change the monorepo's .pkey/ (the deploy hook applies it), or make a break-glass claim with a reason"
    : `${product.slug} is manifest-authoritative: edit its .pkey/ instead, or make a break-glass claim with a reason`;
}
