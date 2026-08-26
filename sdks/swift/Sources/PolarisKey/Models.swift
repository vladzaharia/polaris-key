// The Polaris Key wire types — Codable mirrors of @plrs/protocol's ManagedConfigDoc
// tree. These shapes are the source of truth every SDK + the Worker share; field drift
// silently breaks cross-platform verification, so they track `shared-protocol/src/index.ts`.
//
// Times are epoch SECONDS (the JOSE world the Worker signs in), never millis.
//
// Product binding (`aud == expected`) is enforced in `verifyDoc` after signature checks.

import Foundation

/// Per-key MDM-style management state (wire v2). `enforced`/`hidden` ⇒ the server value
/// wins (the user cannot override it); `default` ⇒ the user owns it, but a present `value`
/// is an admin-set default that local/env overrides may replace.
///
/// `default` is a Swift reserved word, so the case is escaped with backticks; the raw value
/// is still the bare `"default"` string the wire carries.
public enum ManagementState: String, Sendable, Codable, Equatable {
    case `default`
    case enforced
    case hidden
}

/// A managed value plus its management state and the epoch-seconds timestamp it last
/// changed server-side (wire v2). Clients change-detect on `updatedAt`.
public struct ManagedEntry: Sendable, Codable, Equatable {
    public let state: ManagementState
    public let value: JSONValue
    /// Epoch SECONDS the entry was last set/changed server-side.
    public let updatedAt: Int

    public init(state: ManagementState, value: JSONValue, updatedAt: Int) {
        self.state = state
        self.value = value
        self.updatedAt = updatedAt
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
    /// Epoch seconds the key was first activated.
    public let activatedAt: Int

    public init(name: String, firstName: String, email: String, activatedAt: Int) {
        self.name = name
        self.firstName = firstName
        self.email = email
        self.activatedAt = activatedAt
    }
}

/// The JWS payload — the whole object the Worker signs (EdDSA/Ed25519) and clients verify.
public struct ManagedConfigDoc: Sendable, Codable, Equatable {
    public let schemaVersion: Int
    /// Product slug — the audience this document is scoped to.
    public let aud: String
    /// Issuer — always `key.plrs.im`.
    public let iss: String
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
        aud: String,
        iss: String,
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

public struct TrustManifestKey: Sendable, Codable, Equatable {
    public let kid: String
    public let alg: String
    public let kty: String
    public let crv: String
    public let publicKey: String
    public let status: String
}

public struct TrustManifestDoc: Sendable, Codable, Equatable {
    public let schemaVersion: Int
    public let aud: String
    public let iss: String
    public let issuedAt: Int
    public let expiresAt: Int
    public let jwksUrl: String
    public let cacheSeconds: Int
    public let keys: [TrustManifestKey]
}

// ── Gate / wire constants (mirror shared-protocol) ───────────────────────────────

/// The `iss` every Polaris Key document carries.
public let POLARIS_ISSUER = "key.plrs.im"

/// Short signed-token lifetime (seconds).
public let DOC_EXPIRY_SECONDS = 3600

/// Seconds per day, for the offline-grace computation.
public let SECONDS_PER_DAY = 86_400

/// Tolerance applied to every time claim, identical in all five implementations (wire
/// contract v2 §3). Without it a device an hour fast flips a freshly-signed document
/// straight to `grace` (audit finding R2-08).
public let CLOCK_SKEW_SECONDS = 300

/// Upper bound on a document's signed offline-grace window, `graceUntil - issuedAt`. Bounds
/// a hostile control plane and a tampered cache alike; a year comfortably exceeds any real
/// `maxOfflineDays` (the product default is 30 days). Normative — identical in every
/// implementation (`packages/sdk-node/src/claims.ts`).
public let MAX_GRACE_SECONDS = 365 * SECONDS_PER_DAY

/// TRUST MANIFEST wire versions this SDK understands. An unknown version fails CLOSED — a
/// newer manifest shape may carry key attributes whose enforcement this build lacks.
///
/// Deliberately NOT applied to `ManagedConfigDoc.schemaVersion` (§3.1 correction 1): that
/// field is the per-product CATALOG version, which increments every time an operator edits a
/// catalog, so allow-listing it would reject every product that ever republished its schema.
/// The doc's version gets a shape check only — which, in Swift, is what `Codable` already
/// enforces by requiring an `Int`.
public let SUPPORTED_TRUST_SCHEMA_VERSIONS: Set<Int> = [1]

/// How long before `expiresAt` a `304` must be escalated to a full re-fetch, so a
/// continuously ONLINE client can never drift into `grace` on a stable ETag (§5, R2-11).
public let REFRESH_MARGIN_SECONDS = DOC_EXPIRY_SECONDS / 2

/// On-disk cache format version. A `v1` record is DISCARDED, never migrated (§7.3): it holds
/// unsigned state that security decisions used to read.
public let CACHE_RECORD_VERSION = 2

/// Client→Worker request headers.
public let HEADER_DEVICE = "X-PKey-Device"
public let HEADER_VERSION = "X-PKey-Version"
public let HEADER_CHANNEL = "X-PKey-Channel"
public let HEADER_PLATFORM = "X-PKey-Platform"
public let HEADER_ARCH = "X-PKey-Arch"
public let HEADER_SDK_NAME = "X-PKey-SDK"
public let HEADER_SDK_VERSION = "X-PKey-SDK-Version"

/// SDK metadata sent with activation and config requests.
public let POLARIS_KEY_SDK_NAME = "PolarisKeySwift"
public let POLARIS_KEY_SDK_VERSION = "0.1.0"

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
    case needsActivation = "needs-activation"
    case versionTooOld = "version-too-old"
    case versionTooNew = "version-too-new"
    case channelNotEntitled = "channel-not-entitled"
}
