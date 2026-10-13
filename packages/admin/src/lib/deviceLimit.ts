/**
 * The device-limit rule the console's forms state and check, one definition.
 *
 * The Worker refuses a device limit outside 1 to `MAX_DEVICE_LIMIT` on every write path (product
 * default, tier, licence, batch, manifest): the number is enumerated seat by seat when a device
 * activates, so the ceiling bounds a cost rather than a count of customers. The console reads the
 * same constant from `@polaris-key/manifest`, so its copy and its field checks move with the
 * Worker's instead of drifting into a second number.
 */

import { MAX_DEVICE_LIMIT } from "@polaris-key/manifest";

export { MAX_DEVICE_LIMIT };

/** Whether `n` is a device limit the Worker accepts: a whole number from 1 to the ceiling. */
export function isDeviceLimit(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= MAX_DEVICE_LIMIT;
}

/**
 * The field error for a device limit, or `null` when it is fine. `blankOk` is the form's own
 * wording for a field that may be left empty (`"leave it blank"`); without it `null` is an error.
 */
export function deviceLimitIssue(
  n: number | null,
  blankOk?: string,
): string | null {
  if (n === null ? blankOk !== undefined : isDeviceLimit(n)) return null;
  const range = `a whole number of devices from 1 to ${MAX_DEVICE_LIMIT}`;
  return blankOk ? `Use ${range}, or ${blankOk}.` : `Use ${range}.`;
}
