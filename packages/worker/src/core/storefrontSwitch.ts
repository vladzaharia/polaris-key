/**
 * `storefront.polarisKey.enabled` (PS-02 registered it, PS-03 is its first reader): the
 * deployment-wide switch for the Polaris Key storefront (notes/S-21 §6.2). Off hides every
 * listing on this deployment, so the storefront engine (`services/identity/portal/store/
 * obtain.ts`) has no candidates and Discover lists, counts and adds nothing. Licences, sign-in and
 * auto-issue keep working: the switch narrows what the portal SHOWS, never a policy.
 *
 * Storage is the registry's `scalar` kind with no row alias: a `platform_settings` row keyed by
 * the registry key itself, holding the JSON string `"on"` or `"off"`. It is not an A-13 store key
 * (`core/platformSettings.ts`), so the A-13 route cannot write it; ST-05's generic settings API
 * is its writer. Until then no row exists and the default (`on`) applies.
 *
 * Read like an A-13 kill switch, fail-safe: no row, or a tombstone (`null`), is the default `on`;
 * `"off"` is off; and so is any other stored value or an unreadable table, so a hand-edited row or
 * a store outage can only hide the storefront, never widen it. Core-owned (the table is Core's),
 * product-less, no outbound call.
 */

import type { Db } from "../db/types.js";

/** The registry key, which is also the `platform_settings` row key (no `storedAs` alias). */
export const STOREFRONT_ENABLED_KEY = "storefront.polarisKey.enabled";

/** Is the Polaris Key storefront on for this deployment? One primary-key read. */
export async function polarisKeyStorefrontEnabled(db: Db): Promise<boolean> {
  let raw: string | undefined;
  try {
    raw = (
      await db.first<{ value_json: string }>(
        "SELECT value_json FROM platform_settings WHERE key = ?",
        STOREFRONT_ENABLED_KEY,
      )
    )?.value_json;
  } catch {
    return false;
  }
  if (raw === undefined) return true;
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return false;
  }
  if (value === null) return true;
  return value === "on";
}
