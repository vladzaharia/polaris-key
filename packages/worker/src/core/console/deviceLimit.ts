/**
 * The one definition of "a device limit an operator is allowed to write".
 *
 * A device limit used to be validated for its LOWER bound on every write path (`limit > 0` gates
 * the seat check in the licence core, so 0 or -1 read as UNLIMITED) and bounded from above on
 * none of them. That matters because the number is not only displayed: it is fed to
 * `claimDeviceSeat`, whose recursive CTE enumerates seat ordinals 1..limit inside a single
 * statement to find the lowest free one. The cost of that statement is O(limit), so a
 * `defaultDeviceLimit` of 100000000 does not create a hundred million seats, it creates one
 * activation request that never returns, from a field an admin (or a fuzzer, or a mistyped zero)
 * can set.
 *
 * The ceiling is therefore an availability control, not a commercial one, and it is deliberately
 * far above any real seat count: a thousand devices on one licence is already a site licence.
 *
 * It is `MAX_DEVICE_LIMIT` from `@polaris-key/manifest`, never a second copy. A `.pkey/product`
 * sets `defaultDeviceLimit` and each tier's `policyDeviceLimit` through the manifest validator,
 * the product registry and License's tier editor set the same numbers through the admin API, and
 * a ceiling that holds on one of those ways in is a detour, not a ceiling. They share this
 * constant so it moves in all of them in one change.
 */

import { MAX_DEVICE_LIMIT } from "@polaris-key/manifest";

/**
 * True for a supplied device limit the admin surface must refuse.
 *
 * `undefined`, `null` and an absent field are not rejections: on every one of these fields,
 * omitting it means "leave it alone" and null means "inherit the default". Only a number that is
 * present and out of range is an error, and it is reported as one rather than clamped, because
 * silently storing a different number than the operator typed is how a console shows one seat
 * count while the enforcement path uses another.
 */
export function invalidDeviceLimit(raw: unknown): boolean {
  if (typeof raw !== "number") return false;
  return !Number.isInteger(raw) || raw <= 0 || raw > MAX_DEVICE_LIMIT;
}

/** The message every surface refuses with, so the console can match on one string. */
export function deviceLimitMessage(field: string): string {
  return `${field} must be an integer between 1 and ${MAX_DEVICE_LIMIT}`;
}
