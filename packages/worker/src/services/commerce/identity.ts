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
};

function resolve(typed: string | null, assigned: string | null): StoreIdentity {
  if (typed !== null)
    return {
      value: typed,
      source: "typed",
      assigned,
      mismatch: assigned !== null && assigned !== typed,
    };
  return {
    value: assigned,
    source: assigned !== null ? "assigned" : null,
    assigned,
    mismatch: false,
  };
}

export async function effectiveCommerceSettings(
  db: Db,
  product: string,
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

  if (stored.appStore) {
    const b = await storeAppBinding(db, product, "app-store");
    const id = resolve(
      stored.appStore.bundleId,
      b.fields.bundleId?.value ?? null,
    );
    identity["app-store"] = id;
    if (id.value !== null) {
      // The Apple ID check on Production notifications: typed, else the assigned Apple ID, but
      // only when the bundle id in force is the assigned app's (the two pins name one app).
      const assignedApple = b.fields.appleId?.value ?? null;
      const derivedApple =
        assignedApple !== null &&
        /^[1-9][0-9]{0,15}$/.test(assignedApple) &&
        id.value === id.assigned
          ? Number(assignedApple)
          : null;
      settings.appStore = {
        bundleId: id.value,
        appAppleId:
          stored.appStore.appAppleId ??
          (Number.isSafeInteger(derivedApple) ? derivedApple : null),
        acceptSandbox: stored.appStore.acceptSandbox,
      };
    }
  }
  if (stored.play) {
    const b = await storeAppBinding(db, product, "google-play");
    const id = resolve(
      stored.play.packageName,
      b.fields.packageName?.value ?? null,
    );
    identity.play = id;
    if (id.value !== null)
      settings.play = { ...stored.play, packageName: id.value };
  }
  if (stored.steam) {
    const b = await storeAppBinding(db, product, "steam");
    const id = resolve(stored.steam.appId, b.fields.appId?.value ?? null);
    identity.steam = id;
    if (id.value !== null) settings.steam = { appId: id.value };
  }
  return { settings, stored, identity };
}
