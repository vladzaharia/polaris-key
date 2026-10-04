/**
 * The platform apps listing, shared by every store (A-16): what a store's TEAM credential can
 * see, normalised so the platform admin surface can show it and assign an app to a product.
 *
 * Each store's lister (`asc/platform.ts`, …) answers `PlatformStoreApp`s from the store's API with
 * its own client — fixed host, `redirect: "manual"`, bounded bodies (`readCapped`), bounded pages —
 * and this module caches the result briefly in KV, keyed by the credential's non-secret version
 * marker so a rotated or replaced key never serves its predecessor's list. The cache holds app ids,
 * names and release states: nothing secret. Assignments (which product holds which app) are NOT
 * cached: the admin handler joins them fresh from D1 on every read.
 */

import type { Env } from "../../../core/platform.js";
import type {
  PlatformCredentialId,
  PlatformCredentialSource,
  PlatformStore,
} from "../../../core/platformCredentials.js";

/** One app a team credential can see. */
export interface PlatformStoreApp {
  /** The value an assignment pins on the store's primary credential (App Store: the numeric
   *  Apple ID; Play: the package name; Microsoft Store: the Store ID; Steam: the app id). */
  appId: string;
  name: string | null;
  /** Pins on OTHER platform credentials an assignment sets too (the App Store's bundle id for
   *  the In-App Purchase key). */
  pins: Partial<Record<PlatformCredentialId, string>>;
  /** Store identifiers worth showing (bundle id, SKU, package family name, app type). */
  identifiers: Record<string, string | null>;
  /** The store's distribution status, in its own vocabulary. */
  status: Record<string, unknown>;
}

export interface PlatformAppsListing {
  store: PlatformStore;
  source: PlatformCredentialSource;
  fetchedAt: number;
  cached: boolean;
  /** More apps (or more detail) existed than the bounded read fetched. */
  truncated: boolean;
  apps: PlatformStoreApp[];
}

/** KV's minimum `expirationTtl`, and long enough to absorb a console page's re-renders. */
export const PLATFORM_APPS_TTL_SECONDS = 60;

function cacheKey(store: PlatformStore, version: string): string {
  // Outside the `p:` product namespace: no slug can reach it.
  return `plat:store-apps:${store}:${version}`;
}

/**
 * The cached listing for `store` at credential `version`, or a fresh one from `fetch` (cached for
 * `PLATFORM_APPS_TTL_SECONDS`). `refresh` skips the read, not the write. A KV failure serves
 * uncached; a fetch failure throws to the caller (nothing is cached).
 */
export async function cachedPlatformApps(
  env: Env,
  store: PlatformStore,
  version: string,
  refresh: boolean,
  fetch: () => Promise<Omit<PlatformAppsListing, "cached">>,
): Promise<PlatformAppsListing> {
  const key = cacheKey(store, version);
  if (!refresh) {
    try {
      const raw = await env.HOT.get(key);
      if (raw) {
        const hit = JSON.parse(raw) as Omit<PlatformAppsListing, "cached">;
        if (hit && hit.store === store && Array.isArray(hit.apps))
          return { ...hit, cached: true };
      }
    } catch {
      /* a miss */
    }
  }
  const fresh = await fetch();
  try {
    await env.HOT.put(key, JSON.stringify(fresh), {
      expirationTtl: PLATFORM_APPS_TTL_SECONDS,
    });
  } catch {
    /* serve uncached */
  }
  return { ...fresh, cached: false };
}

/** A store's lister could not be used: no usable team credential. */
export class PlatformStoreNotConfigured extends Error {
  constructor(readonly store: PlatformStore) {
    super(`the platform ${store} connection is not configured`);
    this.name = "PlatformStoreNotConfigured";
  }
}

/** A store answered the listing with an error. The message is a status line, never a body. */
export class PlatformStoreUnavailable extends Error {
  constructor(
    readonly store: PlatformStore,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PlatformStoreUnavailable";
  }
}
