/**
 * Commerce's public surface for the console (`test/boundaries.test.ts`): the one module under
 * `services/commerce/` that `console/` may import.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { setupOf } from "./admin.js";
import { effectiveCommerceSettings } from "./identity.js";

/** The stores that can sell now: their settings are saved and the credential resolves. The same
 *  answer as the Commerce overview's per-store status (`setupOf`). */
export async function readyStorefronts(
  env: Env,
  db: Db,
  slug: string,
): Promise<number> {
  const setup = await setupOf(
    { env, db, product: { slug } },
    await effectiveCommerceSettings(db, slug),
  );
  return Object.values(setup).filter((s) => s.configured).length;
}

export interface StorefrontIdentityMismatch {
  store: "app-store" | "play" | "steam";
  /** The identity typed in the commerce settings (the one in force). */
  typed: string;
  /** The app the product is assigned on that store. */
  assigned: string;
}

/** The stores whose typed identity differs from the assigned app (A-28.3). Read-only. */
export async function storefrontIdentityMismatches(
  db: Db,
  slug: string,
): Promise<StorefrontIdentityMismatch[]> {
  const { identity } = await effectiveCommerceSettings(db, slug);
  const out: StorefrontIdentityMismatch[] = [];
  for (const store of ["app-store", "play", "steam"] as const) {
    const i = identity[store];
    if (i.mismatch && i.value !== null && i.assigned !== null)
      out.push({ store, typed: i.value, assigned: i.assigned });
  }
  return out;
}

export interface StorefrontIdentityAmbiguity {
  store: "app-store" | "play" | "steam";
  /** The identity in force: the lowest-id pin wins (D15). */
  value: string;
}

/**
 * The stores whose own active pins for the identity field disagree (D15). Silent otherwise: a
 * second key pinned elsewhere changes nothing a typed value would not have fixed. Read-only.
 */
export async function storefrontIdentityAmbiguities(
  db: Db,
  slug: string,
): Promise<StorefrontIdentityAmbiguity[]> {
  const { identity } = await effectiveCommerceSettings(db, slug);
  const out: StorefrontIdentityAmbiguity[] = [];
  for (const store of ["app-store", "play", "steam"] as const) {
    const i = identity[store];
    if (i.ambiguous && i.source === "assigned" && i.value !== null)
      out.push({ store, value: i.value });
  }
  return out;
}

/** The channel ids Commerce sells through, by its store key. */
const STORE_CHANNEL = {
  "app-store": "app-store",
  play: "google-play",
  steam: "steam",
} as const;

export interface StorefrontState {
  /** The catalogue channel id the store sells through. */
  channel: string;
  state: "not_set_up" | "ready";
  /** A code, never prose: `no_settings` or `no_credential`; `null` when ready. */
  reason: "no_settings" | "no_credential" | null;
  /**
   * The identity in force (A-28.7): the field it fills (`bundleId`, `packageName`, `appId`), its
   * value and where it comes from. `mismatch`: a typed value differs from the assigned app.
   */
  identity: {
    field: "bundleId" | "packageName" | "appId";
    value: string | null;
    source: "typed" | "assigned" | null;
    mismatch: boolean;
  };
}

const IDENTITY_FIELD = {
  "app-store": "bundleId",
  play: "packageName",
  steam: "appId",
} as const;

/**
 * Each store's commerce facet for the channels read (A-20.4): `ready` when the store's settings
 * are saved and its credential resolves (the same answer as `readyStorefronts`), else `not_set_up`
 * with a reason code. No credential id or app identity leaves this function. The caller maps a
 * disabled Commerce to `commerce_off` itself; this reads settings regardless.
 */
export async function storefrontStates(
  env: Env,
  db: Db,
  slug: string,
): Promise<StorefrontState[]> {
  const effective = await effectiveCommerceSettings(db, slug);
  const setup = await setupOf({ env, db, product: { slug } }, effective);
  const has = {
    "app-store": effective.stored.appStore !== null,
    play: effective.stored.play !== null,
    steam: effective.stored.steam !== null,
  };
  return (Object.keys(STORE_CHANNEL) as (keyof typeof STORE_CHANNEL)[]).map(
    (store) => ({
      channel: STORE_CHANNEL[store],
      identity: {
        field: IDENTITY_FIELD[store],
        value: effective.identity[store].value,
        source: effective.identity[store].source,
        mismatch:
          effective.identity[store].mismatch &&
          effective.identity[store].value !== null &&
          effective.identity[store].assigned !== null,
      },
      state: setup[store].configured ? "ready" : "not_set_up",
      reason: setup[store].configured
        ? null
        : has[store]
          ? "no_credential"
          : "no_settings",
    }),
  );
}
