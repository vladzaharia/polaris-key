// The Polaris Key wire types — Codable mirrors of `@polaris-key/protocol`'s v3 tree. These shapes are
// the source of truth every SDK and the Worker share; field drift silently breaks
// cross-platform verification, so they track `packages/shared-protocol/src/{core,license,
// config,trust}.ts` and are pinned by `conformance/corpus/v2`.
//
// Times are epoch SECONDS (the JOSE world the Worker signs in), never millis.
//
// ── WHAT v3 CHANGED ─────────────────────────────────────────────────────────────────────────
//
// v2 had ONE fused document (`pkey-config+jws`) carrying licence, config, secrets and
// entitlements together. v3 splits it in two along the service boundary (§2): `LicenseDoc`
// carries grants, `ConfigDoc` carries settings, and neither knows about the other — which is
// what lets a config-only product issue documents to a device that has no licence at all
// (D-08). What they share is the ENVELOPE (`DocClaims`), declared once here so the two can
// never drift apart on `iss`, `aud`, device binding, or the grace ceiling.

import Foundation

// ── Managed values ──────────────────────────────────────────────────────────────────────────

/// Per-key MDM-style management state. `enforced`/`hidden` ⇒ the server value wins (the user
/// cannot override it); `default` ⇒ the user owns it, but a present `value` is an admin-set
/// default that local/env overrides may replace.
///
/// `default` is a Swift reserved word, so the case is escaped with backticks; the raw value is
/// still the bare `"default"` string the wire carries.
public enum ManagementState: String, Sendable, Codable, Equatable {
    case `default`
    case enforced
    case hidden
}

/// A managed value plus its management state and the epoch-seconds timestamp it last changed
/// server-side. Clients change-detect on `updatedAt`.
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

// ── The shared envelope (§2) ────────────────────────────────────────────────────────────────

/// The claims every per-service signed document carries. `aud` (product slug) + `iss` scope a
/// document to one product as defense-in-depth on top of the per-product signing key; clients
/// MUST assert `aud == their configured product` and `deviceId == their local device id`.
///
/// A protocol rather than a base class so `LicenseDoc` and `ConfigDoc` stay plain value types
/// while `verifyDoc` can validate the envelope generically, in exactly one place.
public protocol DocClaims: Sendable, Codable, Equatable {
    /// Always `POLARIS_ISSUER` ("key.plrs.im").
    var iss: String { get }
    /// Product slug — the audience this document is scoped to.
    var aud: String { get }
    var deviceId: String { get }
    var issuedAt: Int { get }
    /// Short — `issuedAt + DOC_EXPIRY_SECONDS`.
    var expiresAt: Int { get }
    /// The long, server-signed offline window — `issuedAt + maxOfflineDays * 86400`.
    var graceUntil: Int { get }
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

/// The license document (`pkey-license+jws`, §2.1) — the ONLY carrier of grant data (D-20).
///
/// Admin/tier policy arrives as enforced entitlements (`license.tier`, `license.tierLabel`,
/// `channels`, `app.minVersion`, `app.maxVersion`, `deviceLimit`) alongside catalog-declared
/// flags. License STATE (`ok`/`grace`/…) is never carried here; the client gate derives it.
public struct LicenseDoc: DocClaims {
    public let iss: String
    public let aud: String
    public let deviceId: String
    public let issuedAt: Int
    public let expiresAt: Int
    public let graceUntil: Int
    public let licenseId: String
    /// Optional by design — a licence with no holder block is still a licence.
    public let profile: DocProfile?
    public let entitlements: [String: ManagedEntry]

    public init(
        iss: String = POLARIS_ISSUER,
        aud: String,
        deviceId: String,
        issuedAt: Int,
        expiresAt: Int,
        graceUntil: Int,
        licenseId: String,
        profile: DocProfile? = nil,
        entitlements: [String: ManagedEntry] = [:]
    ) {
        self.iss = iss
        self.aud = aud
        self.deviceId = deviceId
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
        self.graceUntil = graceUntil
        self.licenseId = licenseId
        self.profile = profile
        self.entitlements = entitlements
    }
}

/// The config document (`pkey-config+jws`, §2.2) — config + secrets, and no license fields
/// whatsoever. A product with `config` enabled and `license` disabled issues these to any
/// registered device: the wire-level guarantee of service independence (D-08).
public struct ConfigDoc: DocClaims {
    public let iss: String
    public let aud: String
    public let deviceId: String
    public let issuedAt: Int
    public let expiresAt: Int
    public let graceUntil: Int
    /// The product's active CATALOG version — not the wire protocol version.
    public let schemaVersion: Int
    public let config: [String: ManagedEntry]
    public let secrets: [String: ManagedEntry]

    public init(
        iss: String = POLARIS_ISSUER,
        aud: String,
        deviceId: String,
        issuedAt: Int,
        expiresAt: Int,
        graceUntil: Int,
        schemaVersion: Int,
        config: [String: ManagedEntry] = [:],
        secrets: [String: ManagedEntry] = [:]
    ) {
        self.iss = iss
        self.aud = aud
        self.deviceId = deviceId
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
        self.graceUntil = graceUntil
        self.schemaVersion = schemaVersion
        self.config = config
        self.secrets = secrets
    }
}

/// The offline activation bundle payload (`pkey-bundle+jws`, §7). Wraps up to three inner
/// compact JWSs, which is why its payload cap is `MAX_BUNDLE_BYTES` rather than the 64 KiB
/// every other document gets.
///
/// Deliberately NOT a `DocClaims`: it has no `graceUntil`, and its `expiresAt` means something
/// different — the operator's IMPORT deadline, checked with network-path freshness even though
/// the documents inside it are validated on the reload profile (§7.2).
public struct BundleDoc: Sendable, Codable, Equatable {
    /// ULID; the audit anchor for the mint event.
    public let bundleId: String
    public let aud: String
    /// The requesting device's id — bundles are device-bound (the request-code flow).
    public let deviceId: String
    public let issuedAt: Int
    /// Import deadline for the bundle artifact itself.
    public let expiresAt: Int
    /// Inner compact JWSs. `license` is optional by design: a config-only product (D-08)
    /// air-gaps with a bundle carrying only `config`.
    public let docs: BundleDocs
    /// The trust manifest (`pkey-trust+jws`), so an air-gapped device can build its effective
    /// trust set at import time.
    public let trust: String

    public init(
        bundleId: String, aud: String, deviceId: String, issuedAt: Int, expiresAt: Int,
        docs: BundleDocs, trust: String
    ) {
        self.bundleId = bundleId
        self.aud = aud
        self.deviceId = deviceId
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
        self.docs = docs
        self.trust = trust
    }
}

/// The inner-document slice of a bundle. Both members optional; a bundle carrying NEITHER is
/// vacuous and refused at §7 step 2.
public struct BundleDocs: Sendable, Codable, Equatable {
    public let license: String?
    public let config: String?

    public init(license: String? = nil, config: String? = nil) {
        self.license = license
        self.config = config
    }
}

// ── Trust manifest (§2.3) ───────────────────────────────────────────────────────────────────

/// One key entry in a trust manifest.
///
/// ── WHY THE DESCRIPTIVE FIELDS ARE OPTIONAL (A1-06) ─────────────────────────────────────────
///
/// §1 draws a line between two failures that look alike and are not:
///
///   * `kid` / `publicKey` — the entry's IDENTITY and its KEY MATERIAL. An entry without them
///     is not a forward-compatible key this verifier happens not to understand; it is a
///     malformed manifest, and the pinned-substitution rule cannot even be evaluated against
///     it. Missing ⇒ the WHOLE manifest is rejected, which `Codable` gives us by throwing.
///   * `alg` / `kty` / `crv` / `status` — DESCRIPTIVE. §1 says an entry that is not the Ed25519
///     triple is "skipped, not fatal", so a future-alg key never bricks a current verifier. An
///     entry that OMITS `alg` is no more comprehensible to us than one naming an algorithm we
///     lack, so it takes the same path.
///
/// These four used to be non-optional, so a manifest with one field-light entry threw during
/// decode and Swift rejected the whole thing while TS and Python skipped just that entry — the
/// same signed bytes, two trust sets. Optional here, and `verifyTrustManifest` skips any entry
/// that does not present the full Ed25519 triple, which is the same test either way round.
public struct TrustManifestKey: Sendable, Codable, Equatable {
    public let kid: String
    public let alg: String?
    public let kty: String?
    public let crv: String?
    public let publicKey: String
    public let status: String?
    /// §1.1 / §2.3 — `"anchor"` or `"document"`, and **ADVISORY ONLY**.
    ///
    /// It says which key class the server considers this to be: the ANCHOR signs trust manifests
    /// and is what a host application pins; DOCUMENT keys sign licence/config/bundle documents
    /// and rotate underneath it. Surfaced so a provisioning tool can answer "which of these do I
    /// pin?" from the artifact.
    ///
    /// **Never read this in a verification decision.** Not to decide what may sign a manifest,
    /// not to decide what may sign a document, not to prune. A manifest that could name its own
    /// signer's authority would be introducing the key that verifies it — R2-01. What actually
    /// constrains manifest signing is that clients pin the anchor and manifests verify against
    /// pins only; `verifyTrustManifest` below never touches this field, and the corpus pins that
    /// (`trust-role-claim-does-not-grant-manifest-signing`,
    /// `trust-role-is-advisory-not-a-filter`).
    public let role: String?

    public init(
        kid: String, alg: String?, kty: String?, crv: String?, publicKey: String, status: String?,
        role: String? = nil
    ) {
        self.kid = kid
        self.alg = alg
        self.kty = kty
        self.crv = crv
        self.publicKey = publicKey
        self.status = status
        self.role = role
    }

    /// Decodes the descriptive fields LENIENTLY: a wrong-typed `alg` (a number, an object)
    /// reads as absent and skips the entry, exactly as a wrong-VALUED one does. Without this,
    /// `alg: 7` would still throw and still reject the whole manifest — optionality alone only
    /// covers the missing case, not the mistyped one. `role` takes the same lenient path for the
    /// same reason, one step further: it is advisory, so a mistyped one cannot be an error.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kid = try c.decode(String.self, forKey: .kid)
        publicKey = try c.decode(String.self, forKey: .publicKey)
        alg = try? c.decodeIfPresent(String.self, forKey: .alg)
        kty = try? c.decodeIfPresent(String.self, forKey: .kty)
        crv = try? c.decodeIfPresent(String.self, forKey: .crv)
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        role = try? c.decodeIfPresent(String.self, forKey: .role)
    }
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

    public init(
        schemaVersion: Int, aud: String, iss: String, issuedAt: Int, expiresAt: Int,
        jwksUrl: String, cacheSeconds: Int, keys: [TrustManifestKey]
    ) {
        self.schemaVersion = schemaVersion
        self.aud = aud
        self.iss = iss
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
        self.jwksUrl = jwksUrl
        self.cacheSeconds = cacheSeconds
        self.keys = keys
    }
}

// ── Wire constants (§2, §8) ─────────────────────────────────────────────────────────────────

/// Bumped on any wire-breaking change to the document shapes or HTTP contract.
public let POLARIS_PROTOCOL_VERSION = 3

/// The `iss` every Polaris Key document carries. A fixed string (Amendment A1), never derived
/// from the base URL or the serving host; any other issuer is refused.
public let POLARIS_ISSUER = "key.plrs.im"

/// Short signed-document lifetime (seconds).
public let DOC_EXPIRY_SECONDS = 3600

/// Seconds per day, for the offline-grace computation.
public let SECONDS_PER_DAY = 86_400

/// Tolerance applied to every clock comparison, identical in all implementations (§2). Without
/// it a device an hour fast flips a freshly-signed document straight to `grace` (R2-08).
public let CLOCK_SKEW_SECONDS = 300

/// Upper bound on a document's signed offline window, `graceUntil - issuedAt`. Bounds a hostile
/// control plane and a tampered cache alike, and applies at VERIFY time rather than only in the
/// gate (§3.3) — so an over-generous offline bundle is refused before it reaches the cache.
public let MAX_GRACE_SECONDS = 365 * SECONDS_PER_DAY

/// How close to `expiresAt` a cached document may drift before a `304` must be escalated to a
/// full re-fetch (§5). v3 applies the rule PER DOCUMENT — license and config carry independent
/// ETags, so each one escalates on its own half-life.
public let REFRESH_MARGIN_SECONDS = DOC_EXPIRY_SECONDS / 2

/// Maximum decoded payload bytes for `pkey-bundle+jws` (§1). Four times the ordinary document
/// cap because a bundle wraps up to three inner compact JWSs. The raise travels with the `typ`:
/// a call site that does not expect a bundle never grants it.
public let MAX_BUNDLE_BYTES = 262_144

/// Inclusive upper bound on any epoch-seconds claim: 23:59:59 on 9999-12-31 UTC.
///
/// Chosen so the SAME bound is expressible in every implementation without rounding — far below
/// JS's `Number.MAX_SAFE_INTEGER` and far below `Int.max`, with headroom for
/// `issuedAt + MAX_GRACE_SECONDS`.
public let MAX_TIMESTAMP_SECONDS = 253_402_300_799

/// Is `value` a timestamp claim this contract accepts? (A1-04.)
///
/// "It is a number" is not the same test in three languages, which is how the envelope check
/// drifted apart: TS accepted `1700000000.5` and `2**53 + 1`, Python accepted a negative and an
/// unbounded `int`, and `Codable`'s `Int` here refused the float and accepted anything up to
/// `Int.max`. Three implementations, three answers, for identical signed bytes. `Codable` still
/// does the integer half; this is the RANGE half, which nothing in Swift was doing.
public func isTimestamp(_ value: Int) -> Bool {
    value >= 0 && value <= MAX_TIMESTAMP_SECONDS
}

/// TRUST MANIFEST wire versions this SDK understands. An unknown version fails CLOSED — a newer
/// manifest shape may carry key attributes whose enforcement this build lacks.
///
/// Deliberately NOT applied to `ConfigDoc.schemaVersion`: that field is the per-product CATALOG
/// version, which increments every time an operator edits a catalog, so allow-listing it would
/// reject every product that ever republished its schema. That one gets a SHAPE check only.
public let SUPPORTED_TRUST_SCHEMA_VERSIONS: Set<Int> = [1]

/// On-disk cache format version (§4.1). A record carrying any other value is DISCARDED, never
/// migrated: one network round trip is the correct price for not carrying poisoned state
/// forward, and an air-gapped install re-imports its bundle.
public let CACHE_RECORD_VERSION = 3

/// Client→Worker request headers (§5). Every product-scoped call carries all seven.
public let HEADER_DEVICE = "X-PKey-Device"
public let HEADER_VERSION = "X-PKey-Version"
public let HEADER_CHANNEL = "X-PKey-Channel"
public let HEADER_PLATFORM = "X-PKey-Platform"
public let HEADER_ARCH = "X-PKey-Arch"
public let HEADER_SDK_NAME = "X-PKey-SDK"
public let HEADER_SDK_VERSION = "X-PKey-SDK-Version"

/// SDK metadata sent with every product-scoped request.
public let POLARIS_SDK_NAME = "PolarisKeySwift"
public let POLARIS_SDK_VERSION = "0.2.0"

/// The device credential prefix (§6). The withdrawn `plrst_` spelling is not accepted.
public let DEVICE_TOKEN_PREFIX = "pkeyt_"

// ── Gate vocabulary (§5) ────────────────────────────────────────────────────────────────────

/// A 403 block reason returned by `GET /<product>/license/document`.
public enum BlockReason: String, Sendable, Codable, Equatable, CaseIterable {
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
///
/// `notApplicable` is v3's addition: a product that does not enable the license service has no
/// licence to be missing, so it must boot USABLE rather than sitting on `needs-activation`
/// forever (D-08).
public enum LicenseStatus: String, Sendable, Equatable {
    case ok
    case grace
    case expired
    case revoked
    case needsActivation = "needs-activation"
    case versionTooOld = "version-too-old"
    case versionTooNew = "version-too-new"
    case channelNotEntitled = "channel-not-entitled"
    case notApplicable = "not-applicable"
}

/// How this install became activated (§7). An online-minted `pkeyt_` token supersedes a
/// verified offline bundle import; only the absence of both is "not activated".
public enum ActivationSource: String, Sendable, Codable, Equatable {
    case token
    case bundle
}

/// Per-product device registration policy (§6). The default is DERIVED server-side:
/// `requires-license` if the license service is enabled, else `requires-identity` if identity
/// is, else `open`.
public enum RegistrationPolicy: String, Sendable, Codable, Equatable {
    case open
    case requiresIdentity = "requires-identity"
    case requiresLicense = "requires-license"
}
