/**
 * Whether a product's issuer is served (I-21.4; V5 §12.13 "When it is served"): the product's
 * Identity service is on AND `identity.issuer.enabled` is true. Every issuer route and
 * `ensureIssuerKeys` ask this first, so a product that never turned it on never gets a key ring and
 * answers the registry's `404`. The caller has already established that Identity is on for the
 * product, as the registry does before it dispatches any `/identity/*` route; `issuerServed` also
 * reads the toggle itself for the callers that did not (a background job).
 */

import type { Db } from "../../../db/types.js";
import { getProduct } from "../../../core/products/store.js";
import {
  readRowSettings,
  type RowSettingProduct,
} from "../../../core/rowSettings.js";
import { IDENTITY_ISSUER } from "./setting.js";

/** The product's `identity.issuer.enabled` in force: false unless the developer turned it on. */
export async function readIssuerSetting(
  db: Db,
  product: RowSettingProduct,
): Promise<boolean> {
  const [view] = await readRowSettings(db, product, [IDENTITY_ISSUER]);
  return view!.value === true;
}

/** Is the issuer served for this slug now? `false` for an unknown or deleted product. */
export async function issuerServed(db: Db, slug: string): Promise<boolean> {
  const row = await getProduct(db, slug);
  if (!row) return false;
  return readIssuerSetting(db, row);
}
