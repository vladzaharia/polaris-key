// The monotonic clock floor — wire contract v3 §4.2.
//
//   highWaterMark = max(issuedAt of every currently-verified cached artifact)
//   effectiveNow  = max(systemClock, highWaterMark)
//
// The fold is over the WHOLE artifact set — license document, config document, AND the trust
// manifest — not over any single one. A floor built from documents alone is provably inert:
// `doc.issuedAt < doc.graceUntil` always holds, so it can never reach the end of grace, and a
// clock wound back inside a document's own window still reads `ok`. v3 gives the client a
// second document and changes nothing about that, because both are stamped by the same fetch.
// The trust manifest is what makes the floor bite, which is why Core refreshes trust on its own
// schedule instead of riding a service's document fetch. The corpus pins the defective form as
// `floor-config-doc-alone-does-not-stop-rollback` so it cannot silently return.
//
// Only RE-VERIFIED content may be folded in: a rejected artifact must contribute nothing, or
// planting a file would become a way to force every client to `expired`.

import Foundation

/// Anything the client has just re-verified and can therefore date.
public protocol DatedArtifact {
    var issuedAt: Int { get }
}

extension LicenseDoc: DatedArtifact {}
extension ConfigDoc: DatedArtifact {}
extension TrustManifestDoc: DatedArtifact {}

/// The §4.2 floor, and the only place it is computed.
///
/// A value type rather than a bare `Int` so "raise" is the only operation the rest of the SDK
/// can perform on it: monotonicity is then a property of the type, not a convention every call
/// site has to remember.
public struct MonotonicClock: Sendable, Equatable {
    /// Epoch seconds. `0` on a fresh install — no signed clock yet, and `max(now, 0)` is `now`.
    public private(set) var highWaterMark: Int

    public init(highWaterMark: Int = 0) {
        self.highWaterMark = highWaterMark
    }

    /// Fold a freshly verified artifact's `issuedAt` in. Monotonic by construction: it only
    /// ever rises, and only from content whose signature has just been checked against the pins.
    public mutating func raise(_ issuedAt: Int) {
        if issuedAt > highWaterMark { highWaterMark = issuedAt }
    }

    /// Fold every artifact in one call.
    public mutating func raise(over artifacts: [any DatedArtifact]) {
        for artifact in artifacts { raise(artifact.issuedAt) }
    }

    /// Drop to zero. Only `deactivate()` does this, and only alongside wiping every artifact the
    /// floor was derived from — a floor without its sources is a bare counter.
    public mutating func reset() {
        highWaterMark = 0
    }

    /// The time every gate comparison and every network-path claim check runs at.
    ///
    /// The floor is a MINIMUM, never a substitute: with an honest clock ahead of every signed
    /// artifact this returns the system clock unchanged, so the floor costs nothing when the
    /// clock is truthful. Pinned by `floor-honest-clock-is-never-lowered`.
    public func effectiveNow(_ systemNow: Int = Int(Date().timeIntervalSince1970)) -> Int {
        Swift.max(systemNow, highWaterMark)
    }
}

/// Fold a verified artifact set into a single floor. The free-function form, for runners and
/// call sites that hold a list rather than a clock.
public func highWaterMark(_ artifacts: [any DatedArtifact]) -> Int {
    var clock = MonotonicClock()
    clock.raise(over: artifacts)
    return clock.highWaterMark
}

/// `max(systemClock, floor)`.
public func effectiveNow(_ systemNow: Int, _ floor: Int) -> Int {
    Swift.max(systemNow, floor)
}
