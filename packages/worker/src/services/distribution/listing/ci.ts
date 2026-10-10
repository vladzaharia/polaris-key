/**
 * The listing model's CI read (A-18h; notes/S-15 §4.4): `GET /<p>/distribution/listing/<store>`
 * with a `pkeyci_` token and `distribution:report` (the default CI grant, the same token that
 * reports the step back). It answers the store's projection of the shared listing model (A-18b),
 * so a CI-plane step can carry the listing to a store whose only listing path is its vendor CLI:
 * `pkey storefront snap metadata` writes the Snap projection's summary and description into
 * `snapcraft.yaml` before the snap is built, and `snapcraft upload-metadata` sends them.
 *
 * Only a store whose adapter declares `writeListingText` on the CI plane is served (Snap today);
 * any other store is the not-found, so this never becomes a second read of every store's text.
 * The answer is listing text the product publishes anyway, never a secret.
 */

import { storefrontAdapter } from "../../../core/storefront/adapter.js";
import {
  LISTING_STORES,
  type ListingStore,
} from "../../../core/storefront/listingProfiles.js";
import {
  fitReport,
  type FitReportRow,
} from "../../../core/storefront/projection.js";
import type { ListingModel } from "../../../core/storefront/listingModel.js";
import type { Db } from "../../../db/types.js";
import { readListing } from "./store.js";

const FALLBACK_LOCALE = "en-US";

/** The stores CI may read a projection of: a CI-plane `writeListingText`. */
export function ciListingStore(store: string): ListingStore | null {
  if (!(LISTING_STORES as readonly string[]).includes(store)) return null;
  const adapter = storefrontAdapter(store);
  return adapter?.capabilities.ops.writeListingText.mode === "ci"
    ? (store as ListingStore)
    : null;
}

export interface CiListingProjection {
  store: ListingStore;
  /** False when the product has no listing yet: every required field is then missing. */
  exists: boolean;
  defaultLocale: string;
  status: FitReportRow["status"];
  /** Null when a red issue blocks it. */
  payload: FitReportRow["payload"];
  issues: FitReportRow["issues"];
}

export async function ciListingProjection(
  db: Db,
  product: string,
  store: ListingStore,
): Promise<CiListingProjection> {
  const stored = await readListing(db, product);
  const model: ListingModel = stored?.model ?? {
    app: { defaultLocale: FALLBACK_LOCALE },
    locales: {},
    overrides: [],
  };
  const [row] = fitReport({ model, releaseNotes: null }, [store]);
  return {
    store,
    exists: stored !== null,
    defaultLocale: model.app.defaultLocale ?? FALLBACK_LOCALE,
    status: row!.status,
    payload: row!.payload,
    issues: row!.issues,
  };
}
