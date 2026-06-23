// The client license gate. Computes the renderable status from the cached signed doc +
// current time + the last sync outcome. The server enforces version/channel (a 403 →
// `blocked`); the client reflects that plus offline grace. Mirrors sdk-node's gate.ts.

import Foundation

/// A server 403 block (version/channel), reflected locally so the gate can render it.
public struct BlockInfo: Sendable, Equatable {
    public let reason: BlockReason
    public let allowedRange: AllowedRange?

    public init(reason: BlockReason, allowedRange: AllowedRange? = nil) {
        self.reason = reason
        self.allowedRange = allowedRange
    }
}

public struct LicenseState: Sendable, Equatable {
    public let status: LicenseStatus
    public let graceUntil: Int?
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
    /// Whether a per-machine token is stored.
    public let hasToken: Bool
    /// The cached, verified doc (or nil if none yet).
    public let doc: ManagedConfigDoc?
    /// Epoch seconds.
    public let now: Int
    /// Set when the last /config returned a hard 401 (after a /token retry).
    public let lastSyncUnauthorized: Bool
    /// Set when the last /config returned a 403 version/channel block.
    public let blocked: BlockInfo?
    /// Epoch ms of the last successful online verify.
    public let lastVerifiedAt: Int?

    public init(
        hasToken: Bool,
        doc: ManagedConfigDoc?,
        now: Int,
        lastSyncUnauthorized: Bool = false,
        blocked: BlockInfo? = nil,
        lastVerifiedAt: Int? = nil
    ) {
        self.hasToken = hasToken
        self.doc = doc
        self.now = now
        self.lastSyncUnauthorized = lastSyncUnauthorized
        self.blocked = blocked
        self.lastVerifiedAt = lastVerifiedAt
    }
}

/// Compute the renderable gate state. Order is load-bearing and mirrors gate.ts exactly:
/// blocked → reason; no token → needs-enroll; lastSyncUnauthorized → revoked; no doc →
/// needs-enroll; now > graceUntil → expired; now > expiresAt → grace; else ok.
public func licenseState(_ input: GateInput) -> LicenseState {
    if let blocked = input.blocked {
        let status: LicenseStatus
        switch blocked.reason {
        case .versionTooOld: status = .versionTooOld
        case .versionTooNew: status = .versionTooNew
        case .channelNotEntitled: status = .channelNotEntitled
        }
        return LicenseState(status: status, allowedRange: blocked.allowedRange)
    }
    if !input.hasToken { return LicenseState(status: .needsEnroll) }
    if input.lastSyncUnauthorized { return LicenseState(status: .revoked) }
    guard let doc = input.doc else { return LicenseState(status: .needsEnroll) }
    if input.now > doc.graceUntil {
        return LicenseState(status: .expired, graceUntil: doc.graceUntil)
    }
    if input.now > doc.expiresAt {
        return LicenseState(
            status: .grace, graceUntil: doc.graceUntil, lastVerifiedAt: input.lastVerifiedAt)
    }
    return LicenseState(
        status: .ok, graceUntil: doc.graceUntil, lastVerifiedAt: input.lastVerifiedAt)
}

/// True when the gate permits running (ok or grace).
public func isUsable(_ status: LicenseStatus) -> Bool {
    status == .ok || status == .grace
}
