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
 * WIRE-CONTRACT-V4 §3: an integer claim is a plain integer token from the claim's minimum to
 * 2^53 − 1. `nonWire` is the verified payload's `nonWireIntegers` set (from `verifyJws`): a
 * claim at one of those pointers was written with a fraction or an exponent, or is too large,
 * whatever number `JSON.parse` made of it. `Number.isSafeInteger` and the minimum are the
 * second line. `true` and `false` are never numbers. The minimum is the claim's own: 0 for
 * every timestamp, 1 for `schemaVersion` and every `seq` (plans/P3-01.md §2.2 "Minimums").
 */
export function isWireInteger(
  value: unknown,
  pointer: string,
  min: number,
  nonWire: ReadonlySet<string>,
): value is number {
  return (
    !nonWire.has(pointer) &&
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min
  );
}

/** The empty pointer set, for a caller checking an object it built rather than parsed. */
export const NO_NON_WIRE_INTEGERS: ReadonlySet<string> = new Set<string>();
