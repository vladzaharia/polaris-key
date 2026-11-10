/**
 * What a pairwise subject is entitled to, for a reader with no device (LX-01 §2.2, §4; I-21.9):
 * the issuer's `pkey:entitlements` claim and a developer backend.
 *
 * A device-less resolution: no anchor, no store identity, the holder is the subject's account, and
 * every usable licence the account holds for the product contributes. Each licence's grants come
 * from `resolveEntitlements`, the function the licence document signs, so this cannot show a grant
 * a device would not hold. The answer is the sorted keys of the catalog flags the developer marked
 * `userGrant` whose value is on (not `false`, `null` or absent), union over the licences; never a
 * licence id, a tier, a key or a state (LX-01 §7). The channels entry is not a flag key here.
 *
 * Read-only: it writes nothing and reads only rows of this product. It is the same function LX-09
 * extends with the `combine` rules; until that lands, "on in any contributing licence" is the rule.
 * An unknown subject, an account with no usable licence and a product with no catalog all answer `[]`.
 */

import { Catalog } from "@polaris-key/catalog";
import type { Db } from "../../db/types.js";
import { accountForSubject } from "../accounts/accountSubjects.js";
import { licenseUsable } from "../devices.js";
import { getActiveSchema } from "../products/store.js";
import { resolveEntitlements } from "./authz.js";
import { listAccountLicenses } from "./store.js";

/** The catalog keys of `userGrant` flags, or `null` when the product has no usable catalog. */
async function userGrantKeys(
  db: Db,
  product: string,
): Promise<string[] | null> {
  const row = await getActiveSchema(db, product);
  if (!row) return null;
  try {
    return new Catalog(JSON.parse(row.catalog_json)).entries
      .filter(
        (e) =>
          e.kind === "flag" && e.userGrant === true && e.key !== "channels",
      )
      .map((e) => e.key);
  } catch {
    return null;
  }
}

export async function resolveSubjectEntitlements(
  db: Db,
  product: string,
  subject: string,
  now: number,
): Promise<string[]> {
  const keys = await userGrantKeys(db, product);
  if (!keys || keys.length === 0) return [];
  const accountId = await accountForSubject(db, product, subject);
  if (!accountId) return [];
  const on = new Set<string>();
  for (const license of await listAccountLicenses(db, accountId, product)) {
    if (!licenseUsable(license, now)) continue;
    const grants = await resolveEntitlements(db, product, license, null, now);
    for (const key of keys) {
      const value = grants[key]?.value;
      if (value !== undefined && value !== null && value !== false) on.add(key);
    }
  }
  return [...on].sort();
}
