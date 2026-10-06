/**
 * The hosted-asset kill switch (HA-07; notes/S-20 §6.8 "Rollback", §6.10).
 *
 * While it is on, every surface that shows a developer's image hands out Polaris Key's own copy
 * on the image host (`core/hostedImages.ts`): the portal's presentation and Discover, the portal's
 * `/media/<p>/*` route (a 302), the AltStore and SideStore sources and the download page. Turned
 * off, each of them goes back to what it did before HA-07: the portal's GitHub-only media proxy,
 * and the developer's URLs in the feeds. The stored copies stay either way, and so do their refs.
 *
 * Today it is a code constant, on. HA-10 replaces the body with a read of the platform runtime
 * setting `assets.hosting.enabled` (a switch, default on); every reader already asks this
 * function, so that change touches nothing else. It is deliberately its own module: a test that
 * proves the rollback mocks exactly this export.
 *
 * Not a security gate: turning it off only restores the earlier behaviour. The blob route's
 * refusal of listing and hosted art (`services/distribution/blobAccess.ts`, S-20 §4.6 #2) does
 * NOT follow it; that is a fix, not a serving choice.
 */

import type { Env } from "../env.js";

/** Until HA-10: the switch's value everywhere. */
export const ASSET_HOSTING_ENABLED = true;

/** Is hosted-asset serving on? (See the file comment; HA-10 makes this a settings read.) */
export function assetHostingEnabled(_env: Partial<Env>): boolean {
  return ASSET_HOSTING_ENABLED;
}
