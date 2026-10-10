/**
 * The hosted-asset kill switch (HA-07 named it, HA-10 made it a setting; notes/S-20 §6.8
 * "Rollback", §6.10).
 *
 * While it is on, every surface that shows a developer's image hands out Polaris Key's own copy
 * on the image host (`core/assets/hostedImages.ts`): the portal's presentation and Discover, the portal's
 * `/media/<p>/*` route (a 302), the AltStore and SideStore sources and the download page. Turned
 * off, each of them goes back to what it did before HA-07: the portal's GitHub-only media proxy,
 * and the developer's URLs in the feeds. Release-file mirroring stops too
 * (`services/release/mirrorSwitch.ts`), and the legacy download alias streams from GitHub again.
 * The stored copies stay either way, and so do their refs.
 *
 * The value is the platform setting `assets.hosting.enabled` (`core/settings/platform.ts`), an
 * A-13 store entry under the row and `[vars]` name `ASSET_HOSTING`: `runtime` precedence, so a
 * console value wins, then `[vars]`, then the default `on`. An unreadable store falls to `[vars]`
 * or the default, never to off: an outage must not flip every surface. Reads come from the
 * store's 30-second per-isolate copy (`core/platformSettings.ts`), so a request costs one read at
 * most every 30 seconds per isolate, and every isolate follows a change within 30 seconds.
 *
 * Not a security gate: turning it off only restores the earlier behaviour. The blob route's
 * refusal of listing and hosted art (`services/distribution/blobAccess.ts`, S-20 §4.6 #2) does
 * NOT follow it; that is a fix, not a serving choice. Nor does the image host itself
 * (`core/assets/imgHost.ts`): with the switch off no surface hands out its URLs, but a URL handed out
 * before keeps working, which is what a rollback that leaves the copies in place means.
 *
 * Its own module on purpose: everything that branches on hosting asks this one function.
 */

import type { Db } from "../../db/types.js";
import type { SettingsEnv } from "../platformSettings.js";
import { platformSetting } from "../settings/platformRead.js";

/** The registry key (`core/settings/platform.ts`). */
export const ASSET_HOSTING_KEY = "assets.hosting.enabled";

/** Is hosted-asset serving on? (See the file comment.) */
export async function assetHostingEnabled(
  env: SettingsEnv,
  db: Db,
): Promise<boolean> {
  return (await platformSetting(env, db, ASSET_HOSTING_KEY)) === "on";
}
