// Shared claim-validation constants — wire contract v2 §3. These values are normative and
// MUST be identical in all five implementations (TS shared core, Node, Python, Swift, Worker),
// so they live in one place rather than being re-declared per call site.

/**
 * Tolerance applied to every clock comparison, in seconds. v1 had none anywhere, so a device
 * 61 minutes fast flipped a freshly-signed document straight to `grace` (R2-08).
 */
export const CLOCK_SKEW_SECONDS = 300;

/**
 * Upper bound on a signed offline window: `graceUntil <= issuedAt + MAX_GRACE_SECONDS`.
 * Bounds a hostile control plane and a tampered cache file alike — v1 accepted a `graceUntil`
 * a century out with no complaint. A year comfortably exceeds any real `maxOfflineDays`.
 */
export const MAX_GRACE_SECONDS = 365 * 86_400;

/**
 * How close to `expiresAt` a cached document may drift before a `304` must be escalated to a
 * full re-fetch (§5). Half of `DOC_EXPIRY_SECONDS`: a continuously online client re-signs at
 * the doc's half-life instead of coasting into `grace` behind a content-stable ETag (R2-11).
 */
export const REFRESH_MARGIN_SECONDS = 1800;
