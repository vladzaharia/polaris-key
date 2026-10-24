/**
 * THE STORE ADAPTER DECLARATION (P0-27.1; one adapter per store).
 *
 * A store is one thing with two faces: DELIVERY (getting a build to the store: Distribution's
 * connector and flow runtime) and COMMERCE (verifying what a buyer paid the store: Commerce's
 * bridge). Rule 6 forbids Distribution and Commerce from importing each other, so no module can
 * hold both faces. This file is the Core half: pure data that names each store once, says which
 * facets it has, what identity it pins and what credentials each facet needs. The services
 * register their facets by id (P0-27.2 and .4) and a two-way test binds the two.
 *
 * Slots and kinds are plain strings (a `PLATFORM_CREDENTIALS` id and an outlet-credential kind)
 * so this layer never imports the credential custody modules (`test/outletCredentialReach.test.ts`);
 * `test/storeAdapters.test.ts` checks them against those modules instead.
 *
 * Nothing calls the declarations yet. Wire ids are untouched: `commerce.store` is the claim body's
 * `store` (`app-store`, `play`, `steam`), which differs from the storefront id for Google Play.
 */

import type { StorefrontAdapter, StorefrontId } from "../storefront/adapter.js";

/** The Distribution connector kinds (`services/distribution/connectors/`). */
export type ConnectorKind = "asc" | "play" | "ms-store";

/** The commerce store ids, as a claim body's `store` carries them (wire). */
export type CommerceStore = "app-store" | "play" | "steam";

/** The outlet identity fields a product's pin may name. */
export type StoreIdentityField =
  | "appleId"
  | "bundleId"
  | "packageName"
  | "productId"
  | "appId";

/** A credential a facet needs: the team slot, or the product's own credential of the slot's kind. */
export interface StoreCredentialRequirement {
  readonly kind: "credential";
  readonly facet: "delivery" | "commerce";
  /** A `PLATFORM_CREDENTIALS` id: the team slot. */
  readonly slot: string;
  /** The outlet-credential kind a product's own credential of this slot has. */
  readonly ownKind: string;
}

/**
 * An app the product must be assigned on the store (P0-27.6): `field` is present in the product's
 * store-app binding (`storeAppBinding`, A-28.1), from a pin on its own credential or a platform pin.
 */
export interface StoreAppRequirement {
  readonly kind: "app";
  readonly facet: "delivery" | "commerce";
  readonly field: StoreIdentityField;
}

/** What a facet needs before it can run. Human steps are not requirements (A-23). */
export type StoreRequirement = StoreCredentialRequirement | StoreAppRequirement;

export interface StoreDelivery {
  /** The Distribution connector kind; null when the store has none. */
  readonly connector: ConnectorKind | null;
  /** Whether the store has a flow runtime (`services/distribution/storefronts/`). */
  readonly flow: boolean;
}

export interface StoreCommerce {
  readonly store: CommerceStore;
  /** The catalogue's `storefront.verification`: the credential slot that verifies purchases. */
  readonly verification: string;
  /** The catalogue's `storefront.notification`: the store's server-notification kind. */
  readonly notification: string;
  /** The catalogue's `storefront.sku`: the store product kind a deliverable maps to. */
  readonly sku: string;
}

export interface StoreAdapter {
  readonly id: StorefrontId;
  /** The existing storefront declaration, by reference. */
  readonly storefront: StorefrontAdapter;
  readonly delivery: StoreDelivery;
  /** Null when the store has no commerce facet. */
  readonly commerce: StoreCommerce | null;
  readonly identity: readonly StoreIdentityField[];
  readonly requirements: readonly StoreRequirement[];
}
