// Offline activation bundles — wire contract v3 §7.
//
// A bundle (`pkey-bundle+jws`) is the air-gapped activation path (D-12): an operator mints one
// against a device's request code, carries it across on a USB stick, and the client imports it
// with no network at all. It wraps up to three inner compact JWSs — a license document, an
// optional config document, and the trust manifest needed to verify them — so its payload cap
// is `MAX_BUNDLE_BYTES` rather than the 64 KiB every other document gets (§1).
//
// ── WHAT THIS FILE IS, AND WHAT IT IS NOT ───────────────────────────────────────────────────
//
// This is the VERIFIER, and only the verifier: pure, synchronous, and it touches no store.
// Step 5 of §7 — "atomically write cache v3" — belongs to `CoreContext`, because only it has a
// cache. Keeping the write out of here is what makes the ALL-OR-NOTHING rule structural rather
// than disciplinary: there is no partial result available to write, because a refusal returns
// no documents at all — not even the ones that verified before it.
//
// ── THE ORDER IS THE CONTRACT ───────────────────────────────────────────────────────────────
//
// §7 numbers five steps, and `conformance/corpus/v2`'s `bundleCases` pins WHICH ONE refuses for
// each vector, not merely that something did. That is why refusals are an enum rather than a
// bare `nil`: "the bundle was addressed to another device" (step 2) and "the license document
// inside it was addressed to another device" (step 4) are different failures with different
// operator remedies, and a verifier that collapsed them would pass a weaker test than the one
// the four SDKs have to agree on.

import Foundation

/// One inner document that survived every step, kept alongside the exact bytes it arrived as:
/// the host persists the SIGNED artifact, never the decoded object (§4.1).
public struct VerifiedBundleDoc<T: DocClaims>: Sendable, Equatable {
    /// The inner compact JWS, verbatim — this is what goes in the cache.
    public let jws: String
    /// The decoded, fully-validated payload, so the caller need not verify twice.
    public let doc: T
}

/// A bundle that passed all four verification steps. Everything the host needs for §7 step 5's
/// atomic write, and nothing it would have to re-derive.
public struct VerifiedBundle: Sendable, Equatable {
    /// The mint's audit anchor, recorded as `importedBundle.bundleId`.
    public let bundleId: String
    /// The inner trust manifest's compact JWS — cached as `trustJws`, so the imported install
    /// reloads with exactly the key set the bundle shipped with.
    public let trustJws: String
    /// `pinned ∪ non-revoked manifest keys`, with the pins terminal — the set step 4 used.
    public let effectiveTrust: TrustSet
    /// Whichever documents the bundle carried. `license` absent ⇒ NO activation effect: the
    /// gate stays `needs-activation` (or `not-applicable`), never `activation: .bundle` (§7).
    public let license: VerifiedBundleDoc<LicenseDoc>?
    public let config: VerifiedBundleDoc<ConfigDoc>?

    /// Which documents landed, in §7 order — a SEQUENCE, not a set. Pinned by `expect.docs`.
    public var importedSlices: [DocumentSlice] {
        var out: [DocumentSlice] = []
        if license != nil { out.append(.license) }
        if config != nil { out.append(.config) }
        return out
    }
}

/// Which numbered step of §7 refused. Named for the STEP, not for the symptom, because the
/// corpus asserts the attribution and the four SDKs must agree on it.
public enum BundleRefusalReason: String, Sendable, Equatable, CaseIterable {
    /// Step 1 — signature, `typ`, or the 262 144-byte cap.
    case bundleJwsRejected = "bundle-jws-rejected"
    /// Step 2 — `aud`/`deviceId`/import window/vacuous `docs`.
    case bundleClaimsRejected = "bundle-claims-rejected"
    /// Step 3 — the inner manifest failed against the PINS.
    case bundleTrustRejected = "bundle-trust-rejected"
    /// Step 4 — a carried document failed against the effective set.
    case innerDocRejected = "inner-doc-rejected"
}

/// `inspectBundle`'s answer: the bundle, or the step that refused it.
public enum BundleInspection: Sendable, Equatable {
    case ok(VerifiedBundle)
    case refused(BundleRefusalReason)
}

public struct BundleOptions: Sendable {
    /// The ONLY keys a bundle may be verified against (§7.1). The manifest it carries is
    /// verified against these too — an air-gapped device must not be the one place where a
    /// planted key set is accepted.
    public let pinned: TrustSet
    /// The expected `aud` — this client's product slug.
    public let product: String
    /// The LOCAL device id. Step 4 binds inner documents to this, not to the bundle's own
    /// claim, so a mint-side mix-up cannot smuggle a foreign license onto this machine.
    public let deviceId: String
    /// Epoch seconds. Required — a bundle import is a deliberate, timestamped operation, and
    /// defaulting the clock here would hide which clock the decision was made against.
    public let now: Int
    public let clockSkewSeconds: Int

    public init(
        pinned: TrustSet, product: String, deviceId: String, now: Int,
        clockSkewSeconds: Int = CLOCK_SKEW_SECONDS
    ) {
        self.pinned = pinned
        self.product = product
        self.deviceId = deviceId
        self.now = now
        self.clockSkewSeconds = clockSkewSeconds
    }
}

/// Walk §7's numbered order over one bundle, reporting which step refused.
///
/// Nothing is returned until every step has passed, which is the mechanical form of
/// all-or-nothing: a caller physically cannot write half a bundle, because a failure at step 4
/// hands back no documents at all.
public func inspectBundle(_ jws: String, options: BundleOptions) -> BundleInspection {
    // ── 1. The bundle JWS against PINNED keys only ───────────────────────────────────────
    // `requireTyp` closes the replay this artifact would otherwise open: the raised cap travels
    // with the `typ`, so an untyped 256 KiB blob accepted here could be re-presented at an
    // ordinary document call site. The cap comes from the protocol constant, never from the
    // caller — no host gets to choose how big a bundle may be.
    guard
        let bundle = JWSVerifier.verifyDecoding(
            BundleDoc.self, jws, trust: options.pinned, typ: .bundle, requireTyp: true,
            maxPayloadBytes: MAX_BUNDLE_BYTES)
    else { return .refused(.bundleJwsRejected) }

    // ── 2. The bundle's OWN claims, on NETWORK-path freshness ────────────────────────────
    // §7.2: a stale bundle is refused even though the documents it carries are validated with
    // the reload profile. The two windows mean different things — `expiresAt` here is the
    // operator's import deadline, while the inner documents' long bound is `graceUntil`.
    let skew = options.clockSkewSeconds
    guard !bundle.bundleId.isEmpty else { return .refused(.bundleClaimsRejected) }
    guard bundle.aud == options.product else { return .refused(.bundleClaimsRejected) }
    guard bundle.deviceId == options.deviceId else { return .refused(.bundleClaimsRejected) }
    guard bundle.issuedAt <= saturatingAdd(options.now, skew)
    else { return .refused(.bundleClaimsRejected) }
    guard options.now <= saturatingAdd(bundle.expiresAt, skew)
    else { return .refused(.bundleClaimsRejected) }
    // A bundle carrying NEITHER document is vacuous (§7): it can grant nothing and configure
    // nothing, so importing it would write an `importedBundle` marker with no content behind
    // it — an install that looks provisioned and is not. Refused here, at the claims step, for
    // the same reason the addressing failures are.
    guard bundle.docs.license != nil || bundle.docs.config != nil
    else { return .refused(.bundleClaimsRejected) }

    // ── 3. The inner trust manifest, against the PINS, on the RELOAD profile ─────────────
    // Reload, not network: a bundle minted weeks ago carries a manifest whose minutes-long
    // `expiresAt` passed long before it reached the air-gapped machine. Everything else about
    // the manifest still applies — the signature, the `aud`/`iss`/`typ` binding, and above all
    // the pinned-substitution rule, which is what stops a bundle from shipping its own roots.
    let manifest = verifyTrustManifest(
        bundle.trust,
        options: VerifyTrustManifestOptions(
            pinned: options.pinned, expectedAud: options.product, now: options.now,
            checkFreshness: false))
    guard manifest.doc != nil else { return .refused(.bundleTrustRejected) }
    let effectiveTrust = mergeTrust(options.pinned, manifest.discovered)

    // ── 4. Each inner document against the EFFECTIVE set, reload profile ─────────────────
    // Bound to the LOCAL device id — step 2 has only proved the BUNDLE claims this device, and
    // a document inside it may claim another. There is no anti-replay floor here: a bundle
    // import is the act of establishing state on a device that has none, so there is no
    // previously-accepted document to be newer than. (The host applies its own floor after the
    // write, on the next network sync.)
    func reload() -> VerifyOptions {
        VerifyOptions(
            trust: effectiveTrust, expectedAud: options.product, deviceId: options.deviceId,
            now: options.now, clockSkewSeconds: skew, checkFreshness: false)
    }

    var license: VerifiedBundleDoc<LicenseDoc>?
    if let licenseJws = bundle.docs.license {
        guard let doc = verifyLicenseDoc(licenseJws, options: reload())
        else { return .refused(.innerDocRejected) }
        license = VerifiedBundleDoc(jws: licenseJws, doc: doc)
    }
    var config: VerifiedBundleDoc<ConfigDoc>?
    if let configJws = bundle.docs.config {
        guard let doc = verifyConfigDoc(configJws, options: reload())
        else { return .refused(.innerDocRejected) }
        config = VerifiedBundleDoc(jws: configJws, doc: doc)
    }

    // ── 5. The caller's turn ─────────────────────────────────────────────────────────────
    // Everything above passed, so and only so may the host write the cache atomically:
    // `trustJws`, `docs`, and `importedBundle: {bundleId, importedAt}`. No token is created — a
    // bundle-activated install has no credential and never talks to the server.
    return .ok(
        VerifiedBundle(
            bundleId: bundle.bundleId, trustJws: bundle.trust, effectiveTrust: effectiveTrust,
            license: license, config: config))
}

/// Verify an offline activation bundle (§7). Returns the verified contents, or `nil` on ANY
/// refusal — the shape hosts want when they only need to know whether to write.
///
/// Use `inspectBundle` when the refusal REASON matters (telling an operator that the bundle was
/// minted for a different machine is a materially better error than "invalid").
public func verifyBundle(_ jws: String, options: BundleOptions) -> VerifiedBundle? {
    guard case .ok(let bundle) = inspectBundle(jws, options: options) else { return nil }
    return bundle
}
