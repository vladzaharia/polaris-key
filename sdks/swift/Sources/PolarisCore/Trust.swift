// The trust set: how a verifier decides WHICH key may sign a Polaris document. Normative rules
// in docs/security/WIRE-CONTRACT-V3.md §1; pinned by `conformance/corpus/v2`'s `trustCases`,
// which the Node/Python/Swift runners all drive through this same shape.
//
// Two tiers, in strictly decreasing authority:
//
//   pinned      compiled into the host application. TERMINAL — nothing overrides it.
//   discovered  learned from a trust manifest that a PINNED key signed, replaced wholesale on
//               every accepted manifest, so absence is revocation.
//
// The on-disk cache is deliberately NOT a tier: it persists the manifest's compact JWS and
// nothing else, so the keys it yields are exactly the keys a pinned key vouched for (audit
// findings R2-01/R2-02/R4-02).

import Foundation

/// The outcome of verifying a trust manifest.
///
/// `doc == nil` means the manifest was refused, in which case the caller MUST keep whatever
/// trust set it already held — a refused manifest never widens or narrows trust.
public struct TrustManifestResult: Sendable, Equatable {
    public let doc: TrustManifestDoc?
    /// The keys this manifest publishes, minus anything `revoked` or not Ed25519. This REPLACES
    /// the previously discovered set; it is never unioned with it (§1 rule 2).
    public let discovered: TrustSet

    public init(doc: TrustManifestDoc?, discovered: TrustSet) {
        self.doc = doc
        self.discovered = discovered
    }
}

public struct VerifyTrustManifestOptions: Sendable {
    /// The ONLY keys a manifest may be signed by. A discovered key can never sign the manifest
    /// that would extend its own authority.
    public let pinned: TrustSet
    public let expectedAud: String
    public let expectedIss: String
    public let now: Int?
    public let clockSkewSeconds: Int
    /// Anti-rollback, derived from the manifest last verified — never from a disk counter
    /// (R4-03: `lastTrustIssuedAt` used to be an attacker-writable JSON field).
    public let lastTrustIssuedAt: Int?
    /// Enforce `issuedAt`/`expiresAt` (default). `false` on the CACHE-RELOAD path and on bundle
    /// import (§7.3): a manifest's `expiresAt` is `issuedAt + cacheSeconds` — minutes — so
    /// re-checking it on load would drop every discovered key on any restart, and with it the
    /// ability to verify documents signed by a rotated key while offline.
    public let checkFreshness: Bool

    public init(
        pinned: TrustSet,
        expectedAud: String,
        expectedIss: String = POLARIS_ISSUER,
        now: Int? = nil,
        clockSkewSeconds: Int = CLOCK_SKEW_SECONDS,
        lastTrustIssuedAt: Int? = nil,
        checkFreshness: Bool = true
    ) {
        self.pinned = pinned
        self.expectedAud = expectedAud
        self.expectedIss = expectedIss
        self.now = now
        self.clockSkewSeconds = clockSkewSeconds
        self.lastTrustIssuedAt = lastTrustIssuedAt
        self.checkFreshness = checkFreshness
    }
}

/// Verify a compact trust manifest and compute the keys it publishes. Never throws.
public func verifyTrustManifest(
    _ jws: String, options: VerifyTrustManifestOptions
) -> TrustManifestResult {
    let rejected = TrustManifestResult(doc: nil, discovered: [:])
    // Signed by a PINNED key, and typed `plrs-trust+jws` — a license document replayed here is
    // refused on `typ`, not incidentally on a decode error (R2-10).
    guard
        let doc = JWSVerifier.verifyDecoding(
            TrustManifestDoc.self, jws, trust: options.pinned, typ: .trust, requireTyp: true)
    else { return rejected }

    let now = options.now ?? Int(Date().timeIntervalSince1970)
    let skew = options.clockSkewSeconds
    // Unlike a config doc's per-product catalog version, the manifest's `schemaVersion` IS a
    // genuine wire version, so an unknown one fails closed.
    guard SUPPORTED_TRUST_SCHEMA_VERSIONS.contains(doc.schemaVersion) else { return rejected }
    guard doc.aud == options.expectedAud, doc.iss == options.expectedIss else { return rejected }
    // Anti-replay: a manifest older than the one already applied is not an update.
    if let last = options.lastTrustIssuedAt, doc.issuedAt <= last { return rejected }
    if options.checkFreshness {
        guard doc.issuedAt <= saturatingAdd(now, skew) else { return rejected }
        guard doc.expiresAt > saturatingAdd(now, -skew) else { return rejected }
    }

    var discovered: TrustSet = [:]
    for key in doc.keys {
        // §1 — a manifest presenting a PINNED kid with DIFFERENT bytes is a substitution
        // attempt, not an update: reject the WHOLE manifest, including anything legitimate it
        // carries alongside, and keep the previous trust set.
        if let pinned = options.pinned[key.kid], pinned != key.publicKey { return rejected }
        // A future-alg key must not brick a current verifier: skipped, not fatal (§1).
        guard key.alg == "EdDSA", key.kty == "OKP", key.crv == "Ed25519" else { continue }
        // `status` is normative. `active`/`staged`/`retired` all verify (a key must be trusted
        // before it signs, and in-flight documents signed before a rotation must still
        // validate); `revoked` must not enter the set, or stay in it.
        guard key.status != "revoked" else { continue }
        discovered[key.kid] = key.publicKey
    }
    return TrustManifestResult(doc: doc, discovered: discovered)
}

/// The effective trust set: discovered keys UNION pinned keys, PINS LAST.
///
/// The single transposition that was R2-01: v1 spread the cache AFTER the pins, so one file
/// write could substitute the key bytes behind a kid the application had pinned in source.
public func mergeTrust(_ pinned: TrustSet, _ discovered: TrustSet) -> TrustSet {
    discovered.merging(pinned) { _, pinnedKey in pinnedKey }
}
