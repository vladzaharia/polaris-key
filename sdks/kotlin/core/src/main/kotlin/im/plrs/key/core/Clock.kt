// The monotonic clock floor — wire contract v3 §4.2.
//
//   highWaterMark = max(issuedAt of every currently-verified cached artifact)
//   effectiveNow  = max(systemClock, highWaterMark)
//
// The fold is over the licence document, the config document AND the trust manifest: a floor
// built from documents alone is provably inert (`floor-config-doc-alone-does-not-stop-rollback`),
// and the trust manifest, refreshed on Core's own cadence, is what makes it bite. Only
// re-verified content may be folded in.

package im.plrs.key.core

/** The §4.2 floor. "raise" is the only operation, so monotonicity is a property of the type. */
public class MonotonicClock(highWaterMark: Long = 0) {
    public var highWaterMark: Long = highWaterMark
        private set

    /** Fold a freshly verified artifact's `issuedAt` in. */
    public fun raise(issuedAt: Long) {
        if (issuedAt > highWaterMark) highWaterMark = issuedAt
    }

    /** Drop to zero; only a full wipe of the artifacts it came from does this. */
    public fun reset() {
        highWaterMark = 0
    }

    /** The time every gate comparison and network-path claim check runs at. */
    public fun effectiveNow(systemNow: Long): Long = maxOf(systemNow, highWaterMark)
}

/** Fold a verified artifact set's `issuedAt` values into one floor. */
public fun highWaterMark(issuedAts: Iterable<Long>): Long = issuedAts.fold(0L) { a, b -> maxOf(a, b) }

/** `max(systemClock, floor)`. */
public fun effectiveNow(systemNow: Long, floor: Long): Long = maxOf(systemNow, floor)
