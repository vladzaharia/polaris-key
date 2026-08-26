// The trust set: how a verifier decides WHICH key may sign a Polaris Key document.
// Normative rules in docs/security/WIRE-CONTRACT-V2.md §1; pinned by the shared corpus's
// `trustCases`, which the Node/Python/Swift runners all drive through this same shape.
//
// Two tiers, in strictly decreasing authority:
//
//   pinned      compiled into the host application. TERMINAL — nothing overrides it.
//   discovered  learned from a trust manifest that a PINNED key signed, replaced wholesale
//               on every accepted manifest.
//
// The on-disk cache is deliberately NOT a tier: it persists the manifest's compact JWS and
// nothing else, so the keys it yields are exactly the keys a pinned key vouched for
// (audit findings R2-01/R2-02/R4-02).

import Foundation

/// The outcome of verifying a trust manifest.
///
/// `doc == nil` means the manifest was refused, in which case the caller MUST keep whatever
/// trust set it already held — a refused manifest never widens or narrows trust.
public struct TrustManifestResult: Sendable, Equatable {
    public let doc: TrustManifestDoc?
    /// The keys this manifest publishes, minus anything `revoked` or not Ed25519. This
    /// REPLACES the previously discovered set; it is never unioned with it (§1.2.4).
    public let discovered: TrustSet

    public init(doc: TrustManifestDoc?, discovered: TrustSet) {
        self.doc = doc
        self.discovered = discovered
    }
}

public struct VerifyTrustManifestOptions: Sendable {
    /// The ONLY keys a manifest may be signed by. A discovered key can never sign the
    /// manifest that would extend its own authority.
    public let pinned: TrustSet
    public let expectedAud: String
    public let expectedIss: String
    public let now: Int?
    public let clockSkewSeconds: Int
    /// Enforce `issuedAt`/`expiresAt` (default). `false` on the CACHE-RELOAD path only: a
    /// manifest's `expiresAt` is `issuedAt + cacheSeconds` — minutes — so re-checking it on
    /// load would drop every discovered key on any restart, and with it the ability to verify
    /// documents signed by a rotated key while offline.
    public let checkFreshness: Bool

    public init(
        pinned: TrustSet,
        expectedAud: String,
        expectedIss: String = POLARIS_ISSUER,
        now: Int? = nil,
        clockSkewSeconds: Int = CLOCK_SKEW_SECONDS,
        checkFreshness: Bool = true
    ) {
        self.pinned = pinned
        self.expectedAud = expectedAud
        self.expectedIss = expectedIss
        self.now = now
        self.clockSkewSeconds = clockSkewSeconds
        self.checkFreshness = checkFreshness
    }
}

/// Verify a compact trust manifest and compute the keys it publishes. Never throws.
public func verifyTrustManifest(
    _ jws: String, options: VerifyTrustManifestOptions
) -> TrustManifestResult {
    let rejected = TrustManifestResult(doc: nil, discovered: [:])
    // Signed by a PINNED key, and typed as a manifest — a config doc replayed here is
    // refused on `typ`, not incidentally on a decode error (R2-10).
    guard let verified = JWSVerifier.verifyPayloadData(jws, trust: options.pinned, typ: .trust),
        let doc = try? JSONDecoder().decode(TrustManifestDoc.self, from: verified.payload)
    else { return rejected }

    let now = options.now ?? Int(Date().timeIntervalSince1970)
    let skew = options.clockSkewSeconds
    // Unlike a config doc's per-product catalog version, the manifest's `schemaVersion` IS a
    // genuine wire version, so an unknown one fails closed (§3.1 correction 1).
    guard SUPPORTED_TRUST_SCHEMA_VERSIONS.contains(doc.schemaVersion) else { return rejected }
    guard doc.aud == options.expectedAud, doc.iss == options.expectedIss else { return rejected }
    if options.checkFreshness {
        guard doc.issuedAt <= saturatingAdd(now, skew) else { return rejected }
        guard doc.expiresAt > saturatingAdd(now, -skew) else { return rejected }
    }

    var discovered: TrustSet = [:]
    for key in doc.keys {
        // §1.1.1 — a manifest presenting a PINNED kid with DIFFERENT bytes is a substitution
        // attempt, not an update: reject the WHOLE manifest, including anything legitimate
        // it carries alongside, and keep the previous trust set.
        if let pinned = options.pinned[key.kid], pinned != key.publicKey { return rejected }
        guard key.alg == "EdDSA", key.kty == "OKP", key.crv == "Ed25519" else { continue }
        // §1.2 — `status` is normative. `active`/`staged`/`retired` all verify (a key must be
        // trusted before it signs, and in-flight documents signed before a rotation must
        // still validate); `revoked` must not enter the set, or stay in it.
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
