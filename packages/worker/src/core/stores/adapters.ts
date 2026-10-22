/**
 * THE STORE ADAPTER REGISTRY (P0-27.1): one line per storefront id, in `STOREFRONT_ADAPTERS`'
 * order. Adding a store is its declaration module plus one line here.
 */

import type { StorefrontId } from "../storefront/adapter.js";
import type { StoreAdapter } from "./adapter.js";
import { APPLE_STORE } from "./apple/adapter.js";
import { ITCH_STORE } from "./itch/adapter.js";
import { KEYLESS_STORES } from "./keyless.js";
import { MICROSOFT_STORE } from "./microsoftStore/adapter.js";
import { PLAY_STORE } from "./play/adapter.js";
import { STEAM_STORE } from "./steam/adapter.js";

export const STORE_ADAPTERS: readonly StoreAdapter[] = [
  APPLE_STORE,
  PLAY_STORE,
  MICROSOFT_STORE,
  ITCH_STORE,
  STEAM_STORE,
  ...KEYLESS_STORES,
];

/** A store adapter by storefront id, or null. */
export function storeAdapter(id: StorefrontId | string): StoreAdapter | null {
  return STORE_ADAPTERS.find((a) => a.id === id) ?? null;
}
