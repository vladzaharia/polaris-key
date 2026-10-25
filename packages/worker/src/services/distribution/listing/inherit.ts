/**
 * Base fields inherit from Presentation (A-27.9; D3): the product's name and accents, and its
 * icon, reach every store projection, fit report, the CI projection and the AltStore and
 * Obtainium feeds without an operator re-typing them in the listing.
 *
 * The order is HA-12's, unchanged (`core/presentation.ts`, `presentationText`):
 *
 *   name       the listing's `name`, else `products.name`;
 *   tint       `presentation.accent`, else the listing's `tint`;
 *   tintDark   `presentation.accentDark`, else the listing's `tintDark`;
 *   icon-master the listing's own `icon-master` asset when it has one, else the hosted copy of
 *              `presentation.icon`.
 *
 * Each field the product supplied is marked `inherited: "presentation"`. `developerName` has no
 * Presentation source (`presentationText` takes it from the listing alone), so it passes through
 * and is never marked.
 *
 * Applied where a projection or fit report is BUILT, never in `readListing`: a write computes
 * its provenance from the stored row, and an inherited value must never be saved back as if an
 * operator had typed it.
 */

import type { Db } from "../../../db/types.js";
import type { ListingModel } from "../../../core/storefront/listingModel.js";
import type { ProductPublic } from "../../../core/products.js";
import { parseStoredPresentation } from "../../../core/products.js";
import { getProduct } from "../../../core/products/store.js";
import { presentationText } from "../../../core/presentation.js";
import { presentationIcon } from "../../../core/presentation.js";
import type { Env } from "../../../platform/env.js";
import type { DistListingAssetRow, StoredListing } from "./store.js";

/** The fields that can inherit; `icon-master` is an asset slot. */
export type InheritedField = "name" | "tint" | "tintDark" | "icon-master";
export type Inherited = Partial<Record<InheritedField, "presentation">>;

type ProductSource = Pick<ProductPublic, "name" | "presentation">;

const same = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/**
 * `model` with the product's name and accents filled in, and which fields came from the product.
 * `icon` is whether a hosted `presentation.icon` copy should fill an `icon-master` the model has
 * none of: the caller answers it (it needs the image host).
 */
export function inheritPresentation(
  model: ListingModel,
  product: ProductSource,
  icon: boolean,
): { model: ListingModel; inherited: Inherited } {
  const text = presentationText(product, {
    name: model.app.name,
    developerName: model.app.developerName,
    tintColor: model.app.tint,
  });
  const app = { ...model.app };
  const inherited: Inherited = {};
  if (app.name === undefined || app.name === "") {
    app.name = text.name;
    if (text.name !== "") inherited.name = "presentation";
  }
  // HA-12: the presentation's accent outranks the listing's tint (`presentationText`).
  if (
    product.presentation?.accent &&
    !same(text.accent ?? undefined, app.tint)
  ) {
    app.tint = text.accent ?? undefined;
    inherited.tint = "presentation";
  }
  const dark = text.accentDark;
  if (dark !== null && !same(dark, app.tintDark)) {
    app.tintDark = dark;
    inherited.tintDark = "presentation";
  }
  if (icon) inherited["icon-master"] = "presentation";
  return { model: { ...model, app }, inherited };
}

/** The product's name and presentation, read from Core's product row; null for no product. */
export async function productSource(
  db: Db,
  slug: string,
): Promise<ProductSource | null> {
  const row = await getProduct(db, slug);
  return row
    ? {
        name: row.name,
        presentation: parseStoredPresentation(row.presentation_json),
      }
    : null;
}

/**
 * `stored` with its model inherited, for a projection or fit report. The row, locales and
 * overrides stay as stored. `null` stays `null`: a product with no listing has none to fill.
 */
export async function inheritStored(
  db: Db,
  slug: string,
  stored: StoredListing | null,
): Promise<(StoredListing & { inherited: Inherited }) | null> {
  if (!stored) return null;
  const product = await productSource(db, slug);
  if (!product) return { ...stored, inherited: {} };
  const { model, inherited } = inheritPresentation(
    stored.model,
    product,
    false,
  );
  return { ...stored, model, inherited };
}

/**
 * What the admin view reports as inherited: the stored model's name and accents the product
 * supplies, and `icon-master` when the listing has no such asset and `presentation.icon` has a
 * hosted copy. A product with no listing reports only the icon.
 */
export async function inheritedFields(
  env: Env,
  db: Db,
  slug: string,
  stored: StoredListing | null,
  assets: readonly Pick<DistListingAssetRow, "slot">[],
): Promise<Inherited> {
  const product = await productSource(db, slug);
  if (!product) return {};
  const icon =
    !assets.some((a) => a.slot === "icon-master") &&
    (await presentationIcon(env, db, slug)) !== null;
  if (!stored) return icon ? { "icon-master": "presentation" } : {};
  return inheritPresentation(stored.model, product, icon).inherited;
}
