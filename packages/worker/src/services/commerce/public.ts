/**
 * Commerce's public surface for the console (`test/boundaries.test.ts`): the one module under
 * `services/commerce/` that `console/` may import.
 */

import type { Db } from "../../db/types.js";
import type { Env } from "../../platform/env.js";
import { setupOf } from "./admin.js";
import { readCommerceSettings } from "./settings.js";

/** The stores that can sell now: their settings are saved and the credential resolves. The same
 *  answer as the Commerce overview's per-store status (`setupOf`). */
export async function readyStorefronts(
  env: Env,
  db: Db,
  slug: string,
): Promise<number> {
  const setup = await setupOf(
    { env, db, product: { slug } },
    await readCommerceSettings(db, slug),
  );
  return Object.values(setup).filter((s) => s.configured).length;
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
}

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
  const settings = await readCommerceSettings(db, slug);
  const setup = await setupOf({ env, db, product: { slug } }, settings);
  const has = {
    "app-store": settings.appStore !== null,
    play: settings.play !== null,
    steam: settings.steam !== null,
  };
  return (Object.keys(STORE_CHANNEL) as (keyof typeof STORE_CHANNEL)[]).map(
    (store) => ({
      channel: STORE_CHANNEL[store],
      state: setup[store].configured ? "ready" : "not_set_up",
      reason: setup[store].configured
        ? null
        : has[store]
          ? "no_credential"
          : "no_settings",
    }),
  );
}
