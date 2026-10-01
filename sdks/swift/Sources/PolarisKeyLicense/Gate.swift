// The client license gate — wire contract v3 §5. Computes the renderable status from the
// cached signed license document + the monotonic clock floor + the last sync outcome. The
// server enforces version/channel on `GET /<p>/license/document` (a 403 → `blocked`); the
// client reflects that plus offline grace.
//
// Two things are new in v3, both consequences of the suite service model:
//
//   * `licenseServiceEnabled: false` ⇒ `notApplicable` (isUsable true). A config-only or
//     release-only product has no licence to be missing, so it must boot USABLE rather than
//     sitting on `needs-activation` forever (D-08).
//   * `activation` replaces v2's `hasToken` boolean: a device is activated either by an
//     online-minted `pkeyt_` token or by a verified offline bundle import (§7). Both are
//     activated; only `nil` is not.
//
// And one ORDERING changed: the activation guard now runs BEFORE the unsigned `blocked` hint.
// An unactivated device that also happens to be running a blocked build is `needs-activation` —
// telling a user their build is too new when they have not licensed it yet buries the action
// they can actually take. Pinned by gate-matrix v2's activation-precedes-blocked row.
//
// Everything below those guards is the v2 state machine, unchanged. That is deliberate and the
// corpus enforces it: gate-matrix v2 carries v1's rows verbatim under the smallest possible
// shim (fourteen of them; P0-04 retired the pre-R3-01 dev-bypass row, a server-gate decision),
// so a v3 gate that changes any v2 decision goes red.

import Foundation
import PolarisKeyCore

/// A server 403 block (version/channel), reflected locally so the gate can render it. Unsigned
/// is safe because it can only ever make the gate STRICTER (§4.1).
public struct BlockInfo: Sendable, Equatable {
    public let reason: BlockReason
    public let allowedRange: AllowedRange?

    public init(reason: BlockReason, allowedRange: AllowedRange? = nil) {
        self.reason = reason
        self.allowedRange = allowedRange
    }

    /// Lift the on-disk hint into the gate's input type.
    public init(_ record: BlockInfoRecord) {
        self.reason = record.reason
        self.allowedRange = record.allowedRange
    }
}

public struct LicenseState: Sendable, Equatable {
    public let status: LicenseStatus
    public let graceUntil: Int?
    /// Epoch MILLIseconds of the last successful verify, surfaced for "last checked" UI.
    public let lastVerifiedAt: Int?
    public let allowedRange: AllowedRange?

    public init(
        status: LicenseStatus,
        graceUntil: Int? = nil,
        lastVerifiedAt: Int? = nil,
        allowedRange: AllowedRange? = nil
    ) {
        self.status = status
        self.graceUntil = graceUntil
        self.lastVerifiedAt = lastVerifiedAt
        self.allowedRange = allowedRange
    }
}

public struct GateInput: Sendable {
    /// Whether this product enables the license service at all. `false` short-circuits the whole
    /// machine to `notApplicable` — the product simply is not licensed.
    public let licenseServiceEnabled: Bool
    /// How this install became activated, or `nil` when it has not. Replaces v2's `hasToken`.
    public let activation: ActivationSource?
    /// The cached, re-verified license document (or nil if none yet).
    public let doc: LicenseDoc?
    /// Epoch seconds.
    public let now: Int
    /// Monotonic time floor (§4.2). The gate evaluates at `max(now, highWaterMark)`, which makes
    /// clock rollback inert without requiring a trusted local clock.
    public let highWaterMark: Int
    /// Set when the last document fetch returned a hard 401 (after a single re-acquire).
    public let lastSyncUnauthorized: Bool
    /// Set when the last `/license/document` returned a 403 version/channel block.
    public let blocked: BlockInfo?
    /// Epoch MILLIseconds of the last successful online verify.
    public let lastVerifiedAt: Int?

    public init(
        licenseServiceEnabled: Bool = true,
        activation: ActivationSource?,
        doc: LicenseDoc?,
        now: Int,
        highWaterMark: Int = 0,
        lastSyncUnauthorized: Bool = false,
        blocked: BlockInfo? = nil,
        lastVerifiedAt: Int? = nil
    ) {
        self.licenseServiceEnabled = licenseServiceEnabled
        self.activation = activation
        self.doc = doc
        self.now = now
        self.highWaterMark = highWaterMark
        self.lastSyncUnauthorized = lastSyncUnauthorized
        self.blocked = blocked
        self.lastVerifiedAt = lastVerifiedAt
    }
}

/// Compute the renderable gate state. The order is load-bearing and mirrors client-core's
/// `licenseState` exactly: not-applicable → no activation → blocked → revoked → no doc →
/// expired → grace → ok.
public func licenseState(_ input: GateInput) -> LicenseState {
    // §4.2 — winding the system clock back below the newest signed `issuedAt` already verified
    // buys nothing: the gate never sees a time earlier than that floor.
    let now = max(input.now, input.highWaterMark)
    // §5 — a product without the license service has no license state to report, and must not
    // be held hostage by one. This precedes every other rule, including `blocked`.
    guard input.licenseServiceEnabled else { return LicenseState(status: .notApplicable) }
    // §5 — neither a token nor an imported bundle: nothing has been granted yet.
    guard let activation = input.activation else {
        return LicenseState(status: .needsActivation)
    }
    _ = activation
    if let blocked = input.blocked {
        let status: LicenseStatus
        switch blocked.reason {
        case .versionTooOld: status = .versionTooOld
        case .versionTooNew: status = .versionTooNew
        case .channelNotEntitled: status = .channelNotEntitled
        }
        return LicenseState(status: status, allowedRange: blocked.allowedRange)
    }
    if input.lastSyncUnauthorized { return LicenseState(status: .revoked) }
    guard let doc = input.doc else { return LicenseState(status: .needsActivation) }
    if now > doc.graceUntil {
        return LicenseState(status: .expired, graceUntil: doc.graceUntil)
    }
    if now > doc.expiresAt {
        return LicenseState(
            status: .grace, graceUntil: doc.graceUntil, lastVerifiedAt: input.lastVerifiedAt)
    }
    return LicenseState(
        status: .ok, graceUntil: doc.graceUntil, lastVerifiedAt: input.lastVerifiedAt)
}

/// True when the gate permits running: `ok`, `grace`, or `notApplicable`.
public func isUsable(_ status: LicenseStatus) -> Bool {
    status == .ok || status == .grace || status == .notApplicable
}

/// The `LicenseState` overload, so a caller can write `isUsable(client.status())` without
/// reaching for `.status` first.
public func isUsable(_ state: LicenseState) -> Bool {
    isUsable(state.status)
}
