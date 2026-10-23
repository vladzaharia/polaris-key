/**
 * Which app each store's purchases must belong to (A-28.2, CM-20 D12 / §14).
 *
 * The identity fields of `commerce.stores` (`bundleId`, `packageName`, `appId`) are optional. A
 * typed value wins; left out, the value is the app the product is ASSIGNED on that store
 * (`storeAppBinding`: the pin of its own active credential, else its platform pin). The binding
 * is the operator's assignment, not proof that a key exists: `deletePlatformCredential` keeps
 * pins, so an assigned value is used whether or not the credential is present. Anything that
 * needs the key keeps its own credential check (`appStoreCredential` and friends) and refuses as
 * before.
 *
 * A store with no `commerce.stores` block stays off (D13); a block with no typed value and no
 * assignment is off too (`no_app_assigned`). Reads: `dist_connector_settings` (the commerce row),
 * and, per store that has a block, `storeAppBinding`'s metadata reads. Nothing is opened.
 */

import type { Db } from "../../db/types.js";
import { storeAppBinding } from "../../core/platformCredentials.js";
import type { Store } from "../../core/licensing/storeGrants.js";
import {
  readStoredCommerceSettings,
  type CommerceSettings,
  type StoredCommerceSettings,
} from "./settings.js";

export interface StoreIdentity {
  /** The identity in force (the bundle id, package name or Steam app id), or null: store off. */
  value: string | null;
  source: "typed" | "assigned" | null;
  /** The assigned app's value, whether or not it is used. */
  assigned: string | null;
  /** A typed value that differs from the assigned one (the typed value is the one in force). */
  mismatch: boolean;
  /** The store's own active pins disagree (D15; the lowest id won). Only for an assigned value. */
  ambiguous: boolean;
}

export interface EffectiveCommerce {
  /** What every reader acts on: a block with no identity in force reads as off (`null`). */
  settings: CommerceSettings;
  stored: StoredCommerceSettings;
  identity: Record<Store, StoreIdentity>;
}

const NONE: StoreIdentity = {
  value: null,
  source: null,
  assigned: null,
  mismatch: false,
  ambiguous: false,
};

function resolve(
  typed: string | null,
  assigned: string | null,
  ambiguous: boolean,
): StoreIdentity {
  if (typed !== null)
    return {
      value: typed,
      source: "typed",
      assigned,
      mismatch: assigned !== null && assigned !== typed,
      // The keys' disagreement decides nothing while a typed value is in force.
      ambiguous: false,
    };
  return {
    value: assigned,
    source: assigned !== null ? "assigned" : null,
    assigned,
    mismatch: false,
    ambiguous,
  };
}

/**
 * `only` limits the binding reads to the named stores (the unauthenticated hooks resolve just
 * the store they serve, so a junk request costs the reads it always did); the others read as off.
 */
export async function effectiveCommerceSettings(
  db: Db,
  product: string,
  only?: readonly Store[],
): Promise<EffectiveCommerce> {
  const stored = await readStoredCommerceSettings(db, product);
  const identity: Record<Store, StoreIdentity> = {
    "app-store": NONE,
    play: NONE,
    steam: NONE,
  };
  const settings: CommerceSettings = {
    appStore: null,
    play: null,
    steam: null,
  };
  const wanted = (s: Store) => only === undefined || only.includes(s);

  if (stored.appStore && wanted("app-store")) {
    const b = await storeAppBinding(db, product, "app-store");
    const id = resolve(
      stored.appStore.bundleId,
      b.fields.bundleId?.value ?? null,
      b.ambiguous.includes("bundleId"),
    );
    identity["app-store"] = id;
    // `appAppleId` is typed only: the Apple ID and the bundle id sit in different key slots and
    // can name different apps, so deriving it could only add false `wrong_app` refusals.
    if (id.value !== null)
      settings.appStore = {
        bundleId: id.value,
        appAppleId: stored.appStore.appAppleId,
        acceptSandbox: stored.appStore.acceptSandbox,
      };
  }
  if (stored.play && wanted("play")) {
    const b = await storeAppBinding(db, product, "google-play");
    const id = resolve(
      stored.play.packageName,
      b.fields.packageName?.value ?? null,
      b.ambiguous.includes("packageName"),
    );
    identity.play = id;
    if (id.value !== null)
      settings.play = { ...stored.play, packageName: id.value };
  }
  if (stored.steam && wanted("steam")) {
    const b = await storeAppBinding(db, product, "steam");
    const id = resolve(
      stored.steam.appId,
      b.fields.appId?.value ?? null,
      b.ambiguous.includes("appId"),
    );
    identity.steam = id;
    if (id.value !== null) settings.steam = { appId: id.value };
  }
  return { settings, stored, identity };
}
