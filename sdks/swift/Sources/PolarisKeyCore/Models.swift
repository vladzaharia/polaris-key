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

    private enum CodingKeys: String, CodingKey { case state, value, updatedAt }

    /// TOTAL — never throws (WIRE-CONTRACT-V4 §3 "Members outside the claims"). An entry decides
    /// no verdict, so it decodes the way Python's `ManagedEntry.from_any` does: a non-object
    /// reads `{default, null, 0}`, an unknown or non-string `state` reads `default`, a missing
    /// `value` reads null, and a non-integer `updatedAt` reads 0.
    public init(from decoder: Decoder) throws {
        guard let c = try? decoder.container(keyedBy: CodingKeys.self) else {
            self.init(state: .default, value: .null, updatedAt: 0)
            return
        }
        let state = (try? c.decode(String.self, forKey: .state)).flatMap(ManagementState.init)
        let value = (try? c.decodeIfPresent(JSONValue.self, forKey: .value)) ?? nil
        self.init(
            state: state ?? .default,
            value: value ?? .null,
            updatedAt: (try? c.decode(Int.self, forKey: .updatedAt)) ?? 0)
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

/// The person signed in on this device: `profile.user` (V4 §2.1, plans/SP-54.md). Carries the
/// pairwise subject only: no name, email or account id.
public struct SignedInUser: Sendable, Codable, Equatable {
    public let subject: String

    public init(subject: String) { self.subject = subject }

    /// Whole-string match of `PAIRWISE_SUBJECT_PATTERN` (V4 §3.3 rule 1): `$` would also match
    /// before a trailing newline, so the match must span the entire string.
    static func isSubject(_ value: String) -> Bool {
        guard let re = try? NSRegularExpression(pattern: PAIRWISE_SUBJECT_PATTERN) else { return false }
        let whole = NSRange(location: 0, length: (value as NSString).length)
        guard let m = re.firstMatch(in: value, options: [], range: whole) else { return false }
        return m.range == whole
    }

    private struct Raw: Decodable { let subject: String }

    /// Total over any value: an object whose `subject` is a matching string, else nil. Unknown
    /// members are ignored.
    static func decode(from container: KeyedDecodingContainer<DocProfile.CodingKeys>) -> SignedInUser? {
        guard let raw = try? container.decode(Raw.self, forKey: .user), isSubject(raw.subject) else {
            return nil
        }
        return SignedInUser(subject: raw.subject)
    }
}

/// The signed profile block — a tamper-proof, offline greeting.
public struct DocProfile: Sendable, Codable, Equatable {
    public let name: String
    public let firstName: String
    public let email: String
    /// Epoch seconds the key was first activated.
    public let activatedAt: Int
    /// The account signed in on this device (`profile.user`, SP-54); nil on a key-activated
    /// device even though `email` (the licence holder's) is set.
    public let user: SignedInUser?

    public init(
        name: String, firstName: String, email: String, activatedAt: Int, user: SignedInUser? = nil
    ) {
        self.name = name
        self.firstName = firstName
        self.email = email
        self.activatedAt = activatedAt
        self.user = user
    }

    enum CodingKeys: String, CodingKey { case name, firstName, email, activatedAt, user }

    /// Total over the members (V4 §3): a non-string member reads "", a non-integer
    /// `activatedAt` reads 0. Only a profile that is not an object throws, which refuses the
    /// licence, as every SDK does.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            name: (try? c.decode(String.self, forKey: .name)) ?? "",
            firstName: (try? c.decode(String.self, forKey: .firstName)) ?? "",
            email: (try? c.decode(String.self, forKey: .email)) ?? "",
            activatedAt: (try? c.decode(Int.self, forKey: .activatedAt)) ?? 0,
            user: SignedInUser.decode(from: c))
    }
}

/// Port of client-core `licenseUserOf`: the signed-in subject of a VERIFIED licence document,
/// or nil. Total: a malformed or absent member is nil, never an error.
public func licenseUser(_ doc: LicenseDoc?) -> SignedInUser? {
    doc?.profile?.user
}

/// The same reader over a decoded profile.
public func licenseUser(_ profile: DocProfile?) -> SignedInUser? {
    profile?.user
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

    private enum CodingKeys: String, CodingKey {
        case iss, aud, deviceId, issuedAt, expiresAt, graceUntil, licenseId, profile, entitlements
    }

    /// V4 §3 presence: `profile` is absent or an object. A present `null` throws (refusing the
    /// licence, as Node and Godot always did) instead of reading as absent.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        var profile: DocProfile?
        if c.contains(.profile) {
            if try c.decodeNil(forKey: .profile) {
                throw DecodingError.valueNotFound(
                    DocProfile.self,
                    .init(codingPath: [CodingKeys.profile], debugDescription: "profile: null"))
            }
            profile = try c.decode(DocProfile.self, forKey: .profile)
        }
        self.init(
            iss: try c.decode(String.self, forKey: .iss),
            aud: try c.decode(String.self, forKey: .aud),
            deviceId: try c.decode(String.self, forKey: .deviceId),
            issuedAt: try c.decode(Int.self, forKey: .issuedAt),
            expiresAt: try c.decode(Int.self, forKey: .expiresAt),
            graceUntil: try c.decode(Int.self, forKey: .graceUntil),
            licenseId: try c.decode(String.self, forKey: .licenseId),
            profile: profile,
            entitlements: try c.decode([String: ManagedEntry].self, forKey: .entitlements))
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

    private enum CodingKeys: String, CodingKey {
        case bundleId, aud, deviceId, issuedAt, expiresAt, docs, trust
    }

    /// Refuses instead of coercing (V4 §3): a missing or mistyped member throws, and
    /// `inspectBundle` reports that at the claims step, never at the signature step.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            bundleId: try c.decode(String.self, forKey: .bundleId),
            aud: try c.decode(String.self, forKey: .aud),
            deviceId: try c.decode(String.self, forKey: .deviceId),
            issuedAt: try c.decode(Int.self, forKey: .issuedAt),
            expiresAt: try c.decode(Int.self, forKey: .expiresAt),
            docs: try c.decode(BundleDocs.self, forKey: .docs),
            trust: try c.decode(String.self, forKey: .trust))
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

    private enum CodingKeys: String, CodingKey { case license, config }

    /// Each member is absent or a string; a present `null` throws (V4 §3 presence), so it is
    /// never read as absent and the other document imported.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func member(_ key: CodingKeys) throws -> String? {
            guard c.contains(key) else { return nil }
            return try c.decode(String.self, forKey: key)
        }
        self.init(license: try member(.license), config: try member(.config))
    }
}

// ── Trust manifest (§2.3) ───────────────────────────────────────────────────────────────────

public struct TrustManifestKey: Sendable, Codable, Equatable {
    public let kid: String
    public let alg: String
    public let kty: String
    public let crv: String
    public let publicKey: String
    public let status: String

    public init(
        kid: String, alg: String, kty: String, crv: String, publicKey: String, status: String
    ) {
        self.kid = kid
        self.alg = alg
        self.kty = kty
        self.crv = crv
        self.publicKey = publicKey
        self.status = status
    }

    private enum CodingKeys: String, CodingKey { case kid, alg, kty, crv, publicKey, status }

    /// `kid` and `publicKey` must be strings (anything else refuses the manifest); a missing or
    /// mistyped `alg`, `kty`, `crv` or `status` reads "", so the key is skipped (not Ed25519) or
    /// kept (only `revoked` drops one), as in every SDK (V4 §3).
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func text(_ key: CodingKeys) -> String { (try? c.decode(String.self, forKey: key)) ?? "" }
        self.init(
            kid: try c.decode(String.self, forKey: .kid),
            alg: text(.alg), kty: text(.kty), crv: text(.crv),
            publicKey: try c.decode(String.self, forKey: .publicKey),
            status: text(.status))
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

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, aud, iss, issuedAt, expiresAt, jwksUrl, cacheSeconds, keys
    }

    /// The claims must decode (`schemaVersion`, `aud`, `iss`, `issuedAt`, `expiresAt`, `keys`);
    /// `jwksUrl` and `cacheSeconds` decide nothing and read "" and 0 when missing or mistyped.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            schemaVersion: try c.decode(Int.self, forKey: .schemaVersion),
            aud: try c.decode(String.self, forKey: .aud),
            iss: try c.decode(String.self, forKey: .iss),
            issuedAt: try c.decode(Int.self, forKey: .issuedAt),
            expiresAt: try c.decode(Int.self, forKey: .expiresAt),
            jwksUrl: (try? c.decode(String.self, forKey: .jwksUrl)) ?? "",
            cacheSeconds: (try? c.decode(Int.self, forKey: .cacheSeconds)) ?? 0,
            keys: try c.decode([TrustManifestKey].self, forKey: .keys))
    }
}

// ── Wire constants (§2, §8) ─────────────────────────────────────────────────────────────────

/// Bumped on any wire-breaking change to the document shapes or HTTP contract.
public let POLARIS_PROTOCOL_VERSION = 4

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

/// SDK metadata sent with every product-scoped request: `X-PKey-SDK` is the short SDK id
/// (WIRE-CONTRACT-V3 §5.2, the generated `SdkId`), and the version is `X-PKey-SDK-Version`.
public let POLARIS_SDK_NAME = SdkId.swift
public let POLARIS_SDK_VERSION = "0.2.0"

/// The device credential prefix (§6). The withdrawn `plrst_` spelling is not accepted.
public let DEVICE_TOKEN_PREFIX = "pkeyt_"

// ── Gate vocabulary (§5) ────────────────────────────────────────────────────────────────────

/// A 403 block reason returned by `GET /<product>/license/document`.
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
