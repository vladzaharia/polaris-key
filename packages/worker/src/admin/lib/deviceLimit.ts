/**
 * The one definition of "a device limit an operator is allowed to write".
 *
 * A7-05. `deviceLimit` was validated for its LOWER bound on every write path (R11-02 part 2:
 * `licenseCore` gates the seat check on `limit > 0`, so 0 or -1 read as UNLIMITED) and bounded
 * from above on none of them. That matters because the number is not just displayed — it is fed
 * to `claimDeviceSeat`, whose recursive CTE enumerates seat ordinals 1..limit inside a single
 * statement to find the lowest free one. The cost of that statement is O(limit), so
 * `deviceLimit: 100000000` does not create a hundred million seats, it creates one activation
 * request that never returns, from a field an admin (or a fuzzer, or a mistyped zero) can set.
 *
 * The ceiling is therefore an availability control, not a commercial one, and it is deliberately
 * far above any real seat count: a thousand devices on one licence is already a site licence.
 *
 * MUST AGREE WITH THE MANIFEST. `.pkey/product` can set `defaultDeviceLimit` and each tier's
 * `policyDeviceLimit`, and that path is validated by `@polaris-key/manifest` rather than here.
 * A ceiling enforced on one of the two paths is not a ceiling — it is a detour. If this number
 * ever moves, it moves in both places in the same change.
 */
export const MAX_DEVICE_LIMIT = 1000;

/**
 * True for a supplied device limit the admin surface must refuse.
 *
 * `undefined`/`null`/absent is not a rejection: on every one of these fields, omitting it means
 * "leave it alone" and null means "inherit the default". Only a number that is present and out
 * of range is an error — and it is reported as one rather than clamped, because silently
 * storing a different number than the operator typed is how a console shows one seat count and
 * the enforcement path uses another.
 */
export function invalidDeviceLimit(raw: unknown): boolean {
  if (typeof raw !== "number") return false;
  return !Number.isInteger(raw) || raw <= 0 || raw > MAX_DEVICE_LIMIT;
}

/** The message every surface rejects with, so the console can match on one string. */
export function deviceLimitMessage(field: string): string {
  return `${field} must be an integer between 1 and ${MAX_DEVICE_LIMIT}`;
}
