// The trust set: how a verifier decides WHICH key may sign a Polaris Key document. Normative rules
// in docs/security/WIRE-CONTRACT-V3.md §1; pinned by `conformance/corpus/v2`'s `trustCases`,
// which the Node/Python/Swift/Godot runners all drive through this same shape.
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
    /// The pinned kids this manifest NEWLY tombstones: listed `revoked` with their exact pinned
    /// bytes by another usable pin. Ascending UTF-8 byte order; empty when refused. The host
    /// files this manifest as the evidence for each (`pinRevocations[kid]`, §4.1).
    public let revokedPins: [String]

    public init(doc: TrustManifestDoc?, discovered: TrustSet, revokedPins: [String] = []) {
        self.doc = doc
        self.discovered = discovered
        self.revokedPins = revokedPins
    }
}

public struct VerifyTrustManifestOptions: Sendable {
    /// The ONLY keys a manifest may be signed by. A discovered key can never sign the manifest
    /// that would extend its own authority.
    public let pinned: TrustSet
    /// Pinned kids already tombstoned on this install. The manifest verifies against the USABLE
    /// pins (these removed), and no manifest can bring one of them back.
    public let tombstones: [String]
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
        tombstones: [String] = [],
        expectedAud: String,
        expectedIss: String = POLARIS_ISSUER,
        now: Int? = nil,
        clockSkewSeconds: Int = CLOCK_SKEW_SECONDS,
        lastTrustIssuedAt: Int? = nil,
        checkFreshness: Bool = true
    ) {
        self.pinned = pinned
        self.tombstones = tombstones
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
    // Signed by a PINNED key, and typed `pkey-trust+jws` — a license document replayed here is
    // refused on `typ`, not incidentally on a decode error (R2-10).
    guard
        let verified = JWSVerifier.verify(
            jws, trust: usablePins(options.pinned, options.tombstones), typ: .trust,
            requireTyp: true),
        let doc = try? JSONDecoder().decode(TrustManifestDoc.self, from: verified.payload)
    else { return rejected }
    // V4 §3: integer claims decided from their tokens (`1.0` and `true` are refused).
    let nonWire = verified.nonWireIntegers
    guard wireInteger(doc.schemaVersion, pointer: "/schemaVersion", min: 1, in: nonWire),
        wireInteger(doc.issuedAt, pointer: "/issuedAt", min: 0, in: nonWire),
        wireInteger(doc.expiresAt, pointer: "/expiresAt", min: 0, in: nonWire)
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
    var revoked = Set<String>()
    let dead = Set(options.tombstones)
    for key in doc.keys {
        // §1 — a manifest presenting a PINNED kid with DIFFERENT bytes is a substitution
        // attempt, not an update: reject the WHOLE manifest, including anything legitimate it
        // carries alongside, and keep the previous trust set. A tombstoned pin keeps this.
        let pinnedBytes = options.pinned[key.kid]
        if let pinnedBytes, pinnedBytes != key.publicKey { return rejected }
        if key.status == "revoked" {
            if pinnedBytes != nil {
                // A manifest cannot revoke the key that signed it: refused in full (§1 rule 2).
                if key.kid == verified.kid { return rejected }
                if !dead.contains(key.kid) { revoked.insert(key.kid) }
            }
            continue
        }
        // `status` is an allow-list: exactly active / staged / retired keeps a key. Anything
        // else (absent, non-string, unknown, a case variant) skips the entry, never fatally.
        guard TRUST_LIVE_STATUSES.contains(key.status) else { continue }
        // A future-alg key must not brick a current verifier: skipped, not fatal (§1).
        guard key.alg == "EdDSA", key.kty == "OKP", key.crv == "Ed25519" else { continue }
        guard Base64URL.isCanonical(key.publicKey) else { continue }
        discovered[key.kid] = key.publicKey
    }
    // A tombstoned kid leaves every set; a later manifest cannot restore it (§1 rule 3).
    for kid in dead.union(revoked) { discovered[kid] = nil }
    return TrustManifestResult(
        doc: doc, discovered: discovered, revokedPins: revoked.sorted(by: kidBytesLess))
}

private let TRUST_LIVE_STATUSES: Set<String> = ["active", "staged", "retired"]

/// Ascending order of the UTF-8 encodings of two kids (the order every SDK reproduces exactly).
public func kidBytesLess(_ a: String, _ b: String) -> Bool {
    a.utf8.lexicographicallyPrecedes(b.utf8)
}

/// The usable pins: the pins minus the tombstoned kids (§1 tombstone rule 4).
public func usablePins(_ pinned: TrustSet, _ tombstones: [String] = []) -> TrustSet {
    if tombstones.isEmpty { return pinned }
    let dead = Set(tombstones)
    return pinned.filter { !dead.contains($0.key) }
}

/// What `loadPinRevocations` derives from the cached evidence.
public struct PinRevocations: Sendable, Equatable {
    /// The tombstoned pinned kids, ascending byte order.
    public let tombstones: [String]
    /// The evidence that re-verified, keyed by the kid it revokes. Write this back.
    public let kept: [String: String]
}

/// Re-derive the tombstones from the cache's `pinRevocations` slice (§4.1): `kid → the revoking
/// manifest's compact JWS`. Each entry is re-verified on the RELOAD profile, in ascending
/// manifest `issuedAt` (ties: the revoked kid's byte order), against the pins minus the
/// tombstones already applied; one that does not verify, or does not revoke the kid it is filed
/// under, is dropped.
public func loadPinRevocations(
    _ evidence: [String: String], pinned: TrustSet, expectedAud: String,
    expectedIss: String = POLARIS_ISSUER
) -> PinRevocations {
    var candidates: [(kid: String, jws: String, issuedAt: Int)] = []
    for (kid, jws) in evidence where pinned[kid] != nil {
        let pre = verifyTrustManifest(
            jws,
            options: VerifyTrustManifestOptions(
                pinned: pinned, expectedAud: expectedAud, expectedIss: expectedIss,
                checkFreshness: false))
        if let doc = pre.doc { candidates.append((kid, jws, doc.issuedAt)) }
    }
    candidates.sort {
        $0.issuedAt != $1.issuedAt ? $0.issuedAt < $1.issuedAt : kidBytesLess($0.kid, $1.kid)
    }
    var tombstones: [String] = []
    var kept: [String: String] = [:]
    for c in candidates {
        let result = verifyTrustManifest(
            c.jws,
            options: VerifyTrustManifestOptions(
                pinned: pinned, tombstones: tombstones, expectedAud: expectedAud,
                expectedIss: expectedIss, checkFreshness: false))
        guard result.doc != nil, result.revokedPins.contains(c.kid) else { continue }
        tombstones.append(c.kid)
        kept[c.kid] = c.jws
    }
    return PinRevocations(tombstones: tombstones.sorted(by: kidBytesLess), kept: kept)
}

/// The header `kid` of a compact JWS, unverified, or nil. For the signer retry only.
public func jwsHeaderKid(_ jws: String) -> String? {
    guard let first = jws.split(separator: ".", omittingEmptySubsequences: false).first,
        let data = Base64URL.decode(String(first)),
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    return object["kid"] as? String
}

/// The `?signer=<kid>` retry order (§2.3). When the default manifest's header `kid` is a usable
/// pin there is nothing to retry: empty. Otherwise each usable pin in ascending kid byte order,
/// at most `MAX_TRUST_SIGNER_ATTEMPTS`; the client stops at the first manifest it accepts.
public func trustSignerOrder(usable: TrustSet, headerKid: String?) -> [String] {
    if let headerKid, usable[headerKid] != nil { return [] }
    return usable.keys.filter { $0 != headerKid }.sorted(by: kidBytesLess)
        .prefix(MAX_TRUST_SIGNER_ATTEMPTS).map { $0 }
}

/// The effective trust set: discovered keys UNION pinned keys, PINS LAST.
///
/// The single transposition that was R2-01: v1 spread the cache AFTER the pins, so one file
/// write could substitute the key bytes behind a kid the application had pinned in source.
public func mergeTrust(_ pinned: TrustSet, _ discovered: TrustSet) -> TrustSet {
    discovered.merging(pinned) { _, pinnedKey in pinnedKey }
}
