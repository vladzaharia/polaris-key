// Shared claim-validation constants — wire contract v3 §2. These values are normative and
// MUST be identical in all five implementations (this TS client core, Node, React, Python,
// Swift, and the Worker signer), so they live in one place rather than being re-declared per
// call site.

/**
 * Tolerance applied to every clock comparison, in seconds. v1 had none anywhere, so a device
 * 61 minutes fast flipped a freshly-signed document straight to `grace` (R2-08).
 */
export const CLOCK_SKEW_SECONDS = 300;

/**
 * Upper bound on a signed offline window: `graceUntil <= issuedAt + MAX_GRACE_SECONDS`.
 * Bounds a hostile control plane and a tampered cache file alike — v1 accepted a `graceUntil`
 * a century out with no complaint. A year comfortably exceeds any real `maxOfflineDays`, and
 * v3 applies the same ceiling to operator-minted offline bundles (§3.3, D-22).
 */
export const MAX_GRACE_SECONDS = 365 * 86_400;

/**
 * How close to `expiresAt` a cached document may drift before a `304` must be escalated to a
 * full re-fetch (§5). Half of `DOC_EXPIRY_SECONDS`: a continuously online client re-signs at
 * the doc's half-life instead of coasting into `grace` behind a content-stable ETag (R2-11).
 * v3 applies the rule PER DOCUMENT (license and config carry independent ETags).
 */
export const REFRESH_MARGIN_SECONDS = 1800;

/**
 * The inclusive upper bound on any epoch-seconds claim: 23:59:59 on 9999-12-31 UTC.
 *
 * Chosen so the SAME bound is expressible in every implementation without rounding. It is far
 * below `Number.MAX_SAFE_INTEGER` (so a JS `number` holds it exactly), far below `Int64.max`
 * (so Swift's `Int` holds it), and leaves headroom for `issuedAt + MAX_GRACE_SECONDS` inside
 * the safe range.
 */
export const MAX_TIMESTAMP_SECONDS = 253_402_300_799;

/**
 * Is `v` a timestamp claim this contract accepts? (A1-04.)
 *
 * `typeof v === "number"` is not the same test in three languages, which is exactly how the
 * envelope check drifted apart: TS accepted `1700000000.5` and `2**53 + 1`, Python accepted a
 * negative and an unbounded `int`, and Swift's `Codable` `Int` rejected the float outright and
 * accepted anything up to `Int64.max`. Three implementations, three answers, for identical
 * signed bytes. The rule is now one rule: an INTEGER, not negative, not past
 * `MAX_TIMESTAMP_SECONDS`. Non-integers are refused rather than truncated because a fractional
 * `expiresAt` is a document no signer emits, and silently flooring one is a decision no two
 * languages would make identically.
 */
export function isTimestamp(v: unknown): v is number {
  return (
    typeof v === "number" &&
    Number.isInteger(v) &&
    v >= 0 &&
    v <= MAX_TIMESTAMP_SECONDS
  );
}
