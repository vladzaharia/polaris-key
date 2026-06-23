// The Polaris Key wire types — Codable mirrors of @polaris-key/protocol's ManagedConfigDoc
// tree. These shapes are the source of truth every SDK + the Worker share; field drift
// silently breaks cross-platform verification, so they track `shared-protocol/src/index.ts`.
//
// Times are epoch SECONDS (the JOSE world the Worker signs in), never millis.
//
// `aud`/`iss` are decoded as optional: the frozen corpus's `legacy-djdl-baseline` vector
// predates product-scoping and omits them, so the verifier must accept their absence and
// reproduce the payload exactly. Product binding (aud == expected) is enforced separately
// in `verifyDoc`, not by the decoder.

import Foundation

/// Per-key MDM-style management state. `managed`/`hidden` ⇒ the server value wins;
/// `unmanaged` ⇒ the user owns it, but a present `value` is an admin-set default.
public enum ManagementState: String, Sendable, Codable, Equatable {
    case unmanaged
    case managed
    case hidden
}

/// A managed value plus its management state.
public struct ManagedEntry: Sendable, Codable, Equatable {
    public let state: ManagementState
    public let value: JSONValue

    public init(state: ManagementState, value: JSONValue) {
        self.state = state
        self.value = value
    }
}

/// The three payload kinds, each routed to a different store on arrival.
public struct ManagedPayload: Sendable, Codable, Equatable {
    public let config: [String: ManagedEntry]
    public let secrets: [String: ManagedEntry]
    public let entitlements: [String: ManagedEntry]

    public init(
        config: [String: ManagedEntry] = [:],
        secrets: [String: ManagedEntry] = [:],
        entitlements: [String: ManagedEntry] = [:]
    ) {
        self.config = config
        self.secrets = secrets
        self.entitlements = entitlements
    }
}

/// The signed profile block — a tamper-proof, offline greeting.
public struct DocProfile: Sendable, Codable, Equatable {
    public let name: String
    public let firstName: String
    public let email: String
    /// Epoch seconds the key was first enrolled.
    public let enrolledAt: Int

    public init(name: String, firstName: String, email: String, enrolledAt: Int) {
        self.name = name
        self.firstName = firstName
        self.email = email
        self.enrolledAt = enrolledAt
    }
}

/// The JWS payload — the whole object the Worker signs (EdDSA/Ed25519) and clients verify.
public struct ManagedConfigDoc: Sendable, Codable, Equatable {
    public let schemaVersion: Int
    /// Product slug — the audience this document is scoped to (absent in legacy vectors).
    public let aud: String?
    /// Issuer — always `key.plrs.im` (absent in legacy vectors).
    public let iss: String?
    public let licenseId: String
    public let deviceId: String
    public let issuedAt: Int
    /// Short — `issuedAt + DOC_EXPIRY_SECONDS`.
    public let expiresAt: Int
    /// Offline-grace anchor — `issuedAt + maxOfflineDays * 86400`.
    public let graceUntil: Int
    public let profile: DocProfile
    public let payload: ManagedPayload

    public init(
        schemaVersion: Int,
        aud: String?,
        iss: String?,
        licenseId: String,
        deviceId: String,
        issuedAt: Int,
        expiresAt: Int,
        graceUntil: Int,
        profile: DocProfile,
        payload: ManagedPayload
    ) {
        self.schemaVersion = schemaVersion
        self.aud = aud
        self.iss = iss
        self.licenseId = licenseId
        self.deviceId = deviceId
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
        self.graceUntil = graceUntil
        self.profile = profile
        self.payload = payload
    }
}

// ── Gate / wire constants (mirror shared-protocol) ───────────────────────────────

/// The `iss` every Polaris Key document carries.
public let POLARIS_ISSUER = "key.plrs.im"

/// Short signed-token lifetime (seconds).
public let DOC_EXPIRY_SECONDS = 3600

/// Seconds per day, for the offline-grace computation.
public let SECONDS_PER_DAY = 86_400

/// Client→Worker request headers.
public let HEADER_DEVICE = "X-PKey-Device"
public let HEADER_VERSION = "X-PKey-Version"
public let HEADER_CHANNEL = "X-PKey-Channel"

/// A 403 block reason returned by `GET /<product>/config`.
public enum BlockReason: String, Sendable, Codable, Equatable {
    case versionTooOld = "version-too-old"
    case versionTooNew = "version-too-new"
    case channelNotEntitled = "channel-not-entitled"
}

/// The version window a blocked client may run within.
public struct AllowedRange: Sendable, Codable, Equatable {
    public let min: String?
    public let max: String?

    public init(min: String? = nil, max: String? = nil) {
        self.min = min
        self.max = max
    }
}

/// The terminal gate state a client renders from.
public enum LicenseStatus: String, Sendable, Equatable {
    case ok
    case grace
    case expired
    case revoked
    case needsEnroll = "needs-enroll"
    case versionTooOld = "version-too-old"
    case versionTooNew = "version-too-new"
    case channelNotEntitled = "channel-not-entitled"
}
