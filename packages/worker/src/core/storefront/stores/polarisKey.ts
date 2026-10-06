/**
 * THE POLARIS KEY STOREFRONT ADAPTER (PS-01; notes/S-21 §6.1, owner decision D1): the customer
 * portal's Discover and Library, seen as one more store an operator lists a product on. Its
 * operations run against Polaris Key's own tables (`first-party`, `firstParty.ts`): no credential,
 * no gate, no spec pin, no vendor call. The conformance suite's first-party branch holds it there.
 *
 * It serves the `direct` outlet kind: the identifier stays `direct` and is shown as "Polaris Key"
 * (D9, PS-10). There is nothing to connect, so it is not one of the console's store connections.
 * The handlers' real reads and writes land with PS-02, PS-03 and PS-06; pricing with S-22.
 */

import type { StorefrontAdapter, StorefrontOp } from "../adapter.js";
import type { Support } from "../../adapters/contract.js";
import { firstPartyHandlerName } from "../firstParty.js";
import {
  adapterListingProfile,
  STORE_LISTING_COLUMNS,
} from "../listingProfiles.js";
import { unsupported } from "./ciShared.js";

const firstParty = (op: StorefrontOp): Support => ({
  mode: "first-party",
  plane: "worker",
  handler: firstPartyHandlerName(op),
});

const OPS: Readonly<Record<StorefrontOp, Support>> = {
  connect: firstParty("connect"),
  listApps: firstParty("listApps"),
  identifiers: firstParty("identifiers"),
  createApp: unsupported(
    "Every Polaris Key product already has a storefront page",
  ),
  readListing: firstParty("readListing"),
  writeListingText: firstParty("writeListingText"),
  writeListingAssets: firstParty("writeListingAssets"),
  category: firstParty("category"),
  contentRating: unsupported(
    "The Polaris Key storefront shows the developer's own policy link",
  ),
  privacyDeclarations: unsupported(
    "The Polaris Key storefront shows the developer's own policy link",
  ),
  pricing: unsupported("Listed products are obtained without payment"),
  iap: unsupported("Listed products are obtained without payment"),
  testers: unsupported("Who can add a product is decided by its obtain paths"),
  uploadBuild: unsupported("Builds come from the product's releases"),
  notificationsUrl: unsupported(
    "Polaris Key is the store, so there are no store notifications to receive",
  ),
  submit: firstParty("submit"),
  release: unsupported("A published release is live on Polaris Key at once"),
  rollout: unsupported("Rollouts are set per outlet in Distribution"),
  status: firstParty("status"),
};

/**
 * The audit projection of a first-party write: the product, and the listing state it set. No
 * listing text is kept (it lives in the listing model, with its own history).
 */
export const FIRST_PARTY_PROJECTION: Readonly<
  Record<string, readonly string[]>
> = {
  product: ["state", "audience"],
};

export const POLARIS_KEY_ADAPTER: StorefrontAdapter = {
  id: "polaris-key",
  label: "Polaris Key",
  outletKinds: ["direct"],
  credential: null,
  gate: null,
  capabilities: { ops: OPS, rate: { kind: "none" }, limits: {} },
  never: {
    delete: [],
    users: [],
    signingKeys: [],
    payments: [],
    ciTokens: [],
  },
  ci: null,
  pr: null,
  listing: adapterListingProfile(STORE_LISTING_COLUMNS["polaris-key"]),
  confirmation: { phrase: "app-name", label: "Polaris Key" },
  audit: { action: "polaris-key", projection: FIRST_PARTY_PROJECTION },
};
