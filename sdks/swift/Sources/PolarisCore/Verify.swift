// Per-document claim validation — wire contract v3 §2–§3.
//
// Cryptographic verification is the frozen `JWSVerifier` path (encoded-length caps, strict
// base64url, duplicate-key rejection, verify-before-parse, `kid` selected only from the
// caller's trust set). On top of it this file asserts the full v3 claim set, so a document that
// is expired, foreign, far-future, or wearing the wrong `typ` never becomes a document at all.
//
// v3 splits v2's single `pkey-config+jws` document into TWO: `plrs-license+jws` (grants) and
// `plrs-config+jws` (config + secrets). The ENVELOPE they share (§2) is validated once, in
// `validateEnvelope`; only the per-document claims differ, and those live in the two
// `DocTypeSpec`s below. `verifyDoc` is generic so §7's bundle verifier reuses it verbatim.

import Foundation

/// Options for the product-scoped, anti-replay document check layered over raw JWS verify.
public struct VerifyOptions: Sendable {
    public let trust: TrustSet
    public let expectedAud: String
    /// Required `iss`. Host-neutral in v3 — `plrs.im`, never the serving hostname (D-09).
    public let expectedIss: String
    public let deviceId: String
    /// Per-TYPE anti-replay floor: reject a document not strictly newer than the one already
    /// accepted for this document type (§3). License and config carry INDEPENDENT floors.
    public let lastAcceptedIssuedAt: Int?
    /// Epoch seconds to evaluate the time claims against. Pass the client's monotonic-floored
    /// `effectiveNow` so a rolled-back clock cannot widen the window (§4.2).
    public let now: Int?
    public let clockSkewSeconds: Int
    /// Assert the freshness window. Every other claim is checked either way.
    ///
    /// `true` — the NETWORK path: a document that arrives already expired, or stamped in the
    /// far future, is neither accepted nor cached. `false` — the CACHE-RELOAD path (and bundle
    /// import, §7): a cached document is *expected* to be past its short `expiresAt` — that is
    /// what offline operation is — so its signed outer bound there is `graceUntil`, which the
    /// gate enforces against the clock floor. Asserting freshness on reload would delete
    /// offline grace outright. Pinned by the `*-expired` / `*-expired-reload-path` pairs.
    public let checkFreshness: Bool

    public init(
        trust: TrustSet,
        expectedAud: String,
        deviceId: String,
        lastAcceptedIssuedAt: Int? = nil,
        expectedIss: String = POLARIS_ISSUER,
        now: Int? = nil,
        clockSkewSeconds: Int = CLOCK_SKEW_SECONDS,
        checkFreshness: Bool = true
    ) {
        self.trust = trust
        self.expectedAud = expectedAud
        self.deviceId = deviceId
        self.lastAcceptedIssuedAt = lastAcceptedIssuedAt
        self.expectedIss = expectedIss
        self.now = now
        self.clockSkewSeconds = clockSkewSeconds
        self.checkFreshness = checkFreshness
    }
}

/// Everything that distinguishes one document type from another: its `typ` domain separator and
/// the claims that exist only on it. The shared envelope is NOT repeated here.
public struct DocTypeSpec<T: DocClaims>: Sendable {
    public let typ: JwsTyp
    /// Per-document claim validation, run only after the envelope passes.
    public let validate: @Sendable (T) -> Bool

    public init(typ: JwsTyp, validate: @escaping @Sendable (T) -> Bool) {
        self.typ = typ
        self.validate = validate
    }
}

/// `plrs-license+jws` — grants. `entitlements` is the sole carrier of grant data (D-20), and
/// `Codable` already asserts its shape by requiring a `[String: ManagedEntry]`.
public let LICENSE_DOC = DocTypeSpec<LicenseDoc>(typ: .license) { doc in
    !doc.licenseId.isEmpty
}

/// `plrs-config+jws` — config + secrets, and no license fields whatsoever (§2.2, D-08).
///
/// §3 asks for `schemaVersion` to fail closed on an unknown version. That cannot be an
/// allow-list here: on a config document the field carries the PRODUCT CATALOG version, which
/// the Worker increments on every catalog edit and is unbounded per product — allow-listing it
/// would reject every product that has ever revised its catalog. (Contrast
/// `TrustManifestDoc.schemaVersion`, which IS a wire version and IS allow-listed, in Trust.swift.)
/// What is enforceable, and what R2-08's payload actually violated, is the SHAPE: `Codable`
/// requiring an `Int` rejects `"4"`, and this rejects a non-positive one.
public let CONFIG_DOC = DocTypeSpec<ConfigDoc>(typ: .config) { doc in
    doc.schemaVersion >= 1
}

/// The shared envelope every per-service document carries (§2 / §3). Checked in one place so
/// license and config can never drift apart on `iss`, `aud`, device binding, the grace ceiling,
/// or the freshness split.
private func validateEnvelope<T: DocClaims>(_ doc: T, _ opts: VerifyOptions, _ now: Int) -> Bool {
    guard doc.aud == opts.expectedAud else { return false }
    // v3 is host-neutral: `plrs.im`, NOT the serving hostname. A `key.plrs.im` issuer is a v2
    // artifact and is refused (§8).
    guard doc.iss == opts.expectedIss else { return false }
    guard doc.deviceId == opts.deviceId else { return false }
    // Anti-replay: strictly newer than the last document accepted FOR THIS TYPE.
    if let last = opts.lastAcceptedIssuedAt, doc.issuedAt <= last { return false }
    // A grace window shorter than the expiry, or longer than a year, is not a document this
    // client will honour — whoever authored it. The ceiling applies at VERIFY time, not only in
    // the gate (§3.3), so an over-generous bundle is refused before it can reach the cache.
    guard doc.graceUntil >= doc.expiresAt,
        doc.graceUntil <= saturatingAdd(doc.issuedAt, MAX_GRACE_SECONDS)
    else { return false }
    if opts.checkFreshness {
        // A far-future stamp is prima facie tampering (or a badly wrong server clock).
        guard doc.issuedAt <= saturatingAdd(now, opts.clockSkewSeconds) else { return false }
        guard doc.expiresAt > saturatingAdd(now, -opts.clockSkewSeconds) else { return false }
    }
    return true
}

/// Verify one signed Polaris document of a known type. Returns the payload, or `nil` on ANY
/// failure — never a throw, so every call site fails closed identically.
public func verifyDoc<T: DocClaims>(
    _ jws: String, spec: DocTypeSpec<T>, options: VerifyOptions
) -> T? {
    // Size caps, strict base64url, duplicate-key rejection and verify-before-parse all live in
    // `JWSVerifier`; it never JSON-parses an unauthenticated payload. `typ` closes
    // cross-protocol replay — a trust manifest, or the *other* document type, presented here.
    guard
        let doc = JWSVerifier.verifyDecoding(
            T.self, jws, trust: options.trust, typ: spec.typ, requireTyp: true)
    else { return nil }
    let now = options.now ?? Int(Date().timeIntervalSince1970)
    guard validateEnvelope(doc, options, now) else { return nil }
    guard spec.validate(doc) else { return nil }
    return doc
}

/// Verify a `plrs-license+jws` document (§2.1).
public func verifyLicenseDoc(_ jws: String, options: VerifyOptions) -> LicenseDoc? {
    verifyDoc(jws, spec: LICENSE_DOC, options: options)
}

/// Verify a `plrs-config+jws` document (§2.2).
public func verifyConfigDoc(_ jws: String, options: VerifyOptions) -> ConfigDoc? {
    verifyDoc(jws, spec: CONFIG_DOC, options: options)
}
