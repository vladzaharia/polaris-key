// @pkey-feature core.verify
// Wire contract v3 §1–§3 regression tests: the parser hardening and the claim checks.
//
// The heir to `WireContractV2Tests`. Every v2 case is carried — each one corresponds to a
// finding whose proof-of-concept PASSED against an earlier build, and they are written so that
// reverting the fix fails the test rather than merely exercising the happy path. Three v3
// additions sit alongside them: `typ` is now REQUIRED (the v1 tolerance window closed), the
// payload cap is raise-only and coupled to a proven `typ`, and the two document types must
// refuse each other.

import CryptoKit
import Foundation
@testable import PolarisKeyCore
import XCTest

final class WireContractV3Tests: XCTestCase {
    private let signer = TestSigner(kid: "wire-v3-key")
    private let issued = 1_700_000_000

    private func licenseJSON(issuedAt: Int) -> String {
        String(
            decoding: try! JSONEncoder().encode(Fixtures.license(issuedAt: issuedAt)),
            as: UTF8.self)
    }

    // ── §1 duplicate keys (R2-06) ──────────────────────────────────────────────────
    /// The sharp one. `JSONSerialization` resolved duplicates FIRST-wins while TS/Python resolve
    /// LAST-wins, so `{"alg":"none","kid":K,"alg":"EdDSA"}` read as `none` in Swift and `EdDSA`
    /// everywhere else — the algorithm-downgrade guard answering differently for identical signed
    /// bytes. v2 rejected duplicates outright, in BOTH orderings, and v3 carries that unchanged.
    func testDuplicateAlgInHeaderIsRejectedInBothOrderings() {
        let payload = licenseJSON(issuedAt: issued)
        let typ = JwsTyp.license.rawValue
        let noneFirst = signer.signRaw(
            header: #"{"alg":"none","typ":"\#(typ)","kid":"\#(signer.kid)","alg":"EdDSA"}"#,
            payload: payload)
        let eddsaFirst = signer.signRaw(
            header: #"{"alg":"EdDSA","typ":"\#(typ)","kid":"\#(signer.kid)","alg":"none"}"#,
            payload: payload)

        XCTAssertNil(
            JWSVerifier.verify(noneFirst, trust: signer.trust, typ: .license),
            "a header declaring `alg` twice must be REJECTED, not resolved")
        XCTAssertNil(
            JWSVerifier.verify(eddsaFirst, trust: signer.trust, typ: .license),
            "duplicate rejection must not depend on which member comes first")
        // Control: the same signer, the same payload, one `alg` ⇒ verifies.
        XCTAssertNotNil(
            JWSVerifier.verify(
                signer.sign(payloadJSON: payload, typ: typ), trust: signer.trust, typ: .license))
    }

    func testDuplicateKidInHeaderIsRejected() {
        let typ = JwsTyp.license.rawValue
        let jws = signer.signRaw(
            header: #"{"alg":"EdDSA","typ":"\#(typ)","kid":"\#(signer.kid)","kid":"other"}"#,
            payload: licenseJSON(issuedAt: issued))
        XCTAssertNil(JWSVerifier.verify(jws, trust: signer.trust, typ: .license))
    }

    func testDuplicateKeyInPayloadIsRejected() {
        let dup = #"{"licenseId":"a","licenseId":"b","aud":"djdl"}"#
        XCTAssertNil(
            JWSVerifier.verify(
                signer.sign(payloadJSON: dup, typ: JwsTyp.license.rawValue),
                trust: signer.trust, typ: .license))
    }

    /// Duplicates nested inside an object, and inside an object inside an ARRAY, are caught too —
    /// a scan that only tracked the top level would miss both.
    func testDuplicateKeyNestedAndInsideArrayIsRejected() {
        let nested = #"{"a":{"x":1,"x":2}}"#
        let inArray = #"{"a":[{"x":1,"x":2}]}"#
        // Array ELEMENTS are not keys: repeated values must not be mistaken for duplicates.
        let legit = #"{"a":["x","x"],"b":{"x":1},"c":{"x":2}}"#
        XCTAssertTrue(StrictJSON.hasDuplicateKeys(Data(nested.utf8)))
        XCTAssertTrue(StrictJSON.hasDuplicateKeys(Data(inArray.utf8)))
        XCTAssertFalse(StrictJSON.hasDuplicateKeys(Data(legit.utf8)))
    }

    /// Escaped and unescaped spellings of the same key collide, exactly as a JSON parser would
    /// collapse them — a byte-comparison scan would let `a` smuggle a second `a`.
    func testEscapedDuplicateKeyIsRejected() {
        XCTAssertTrue(StrictJSON.hasDuplicateKeys(Data(#"{"a":1,"a":2}"#.utf8)))
        XCTAssertTrue(StrictJSON.hasDuplicateKeys(Data(#"{"a\"b":1,"a\"b":2}"#.utf8)))
        XCTAssertFalse(StrictJSON.hasDuplicateKeys(Data(#"{"a\"b":1,"ab":2}"#.utf8)))
    }

    // ── §1 size caps (R2-04) ───────────────────────────────────────────────────────
    /// The payload cap was bypassable by moving the blob into the PROTECTED HEADER, which no
    /// implementation bounded. The signature here is VALID, so only the cap can reject it.
    func testOversizedHeaderIsRejectedDespiteValidSignature() {
        let junk = String(repeating: "x", count: 8 * 1024 * 1024)
        let typ = JwsTyp.license.rawValue
        let jws = signer.signRaw(
            header: #"{"alg":"EdDSA","typ":"\#(typ)","kid":"\#(signer.kid)","junk":"\#(junk)"}"#,
            payload: licenseJSON(issuedAt: issued))
        XCTAssertNil(JWSVerifier.verify(jws, trust: signer.trust, typ: .license))
    }

    /// The boundary: a header exactly at 1024 decoded bytes verifies, one byte over does not.
    func testHeaderCapBoundary() {
        let typ = JwsTyp.license.rawValue
        func header(padding: Int) -> String {
            #"{"alg":"EdDSA","typ":"\#(typ)","kid":"\#(signer.kid)","p":"\#(String(repeating: "x", count: padding))"}"#
        }
        let base = header(padding: 0).utf8.count
        let atCap = header(padding: JWSVerifier.maxHeaderBytes - base)
        let overCap = header(padding: JWSVerifier.maxHeaderBytes - base + 1)
        XCTAssertEqual(atCap.utf8.count, JWSVerifier.maxHeaderBytes)

        let payload = licenseJSON(issuedAt: issued)
        XCTAssertNotNil(
            JWSVerifier.verify(
                signer.signRaw(header: atCap, payload: payload), trust: signer.trust,
                typ: .license),
            "a header at the cap must verify")
        XCTAssertNil(
            JWSVerifier.verify(
                signer.signRaw(header: overCap, payload: payload), trust: signer.trust,
                typ: .license),
            "a header one byte over the cap must be rejected")
    }

    /// The ENCODED segments are bounded before any decode, so an oversized blob is rejected
    /// without ever being allocated.
    func testEncodedSegmentCapsAreDerivedFromTheDecodedCaps() {
        XCTAssertEqual(JWSVerifier.maxHeaderB64, (1024 * 4 + 2) / 3 + 4)
        XCTAssertEqual(JWSVerifier.maxPayloadB64, (65536 * 4 + 2) / 3 + 4)
        let huge = String(repeating: "A", count: JWSVerifier.maxPayloadB64 + 1)
        XCTAssertNil(
            JWSVerifier.verify("aGVhZGVy.\(huge).c2ln", trust: signer.trust, typ: .license))
    }

    /// §1's bundle exception: the cap is RAISE-ONLY, and the raise travels with the `typ`.
    ///
    /// A caller cannot lower the frozen cap (so an over-eager host cannot break legitimate
    /// documents), and a raise offered without a required `typ` is refused outright — otherwise
    /// a 256 KiB untyped blob accepted here could be re-presented at an ordinary document call
    /// site with the raise still in force.
    func testPayloadCapOverrideIsRaiseOnlyAndRequiresATyp() {
        let payload = licenseJSON(issuedAt: issued)
        let jws = signer.sign(payloadJSON: payload, typ: JwsTyp.license.rawValue)
        // A "lower" cap is ignored: this document is well under 64 KiB and still verifies.
        XCTAssertNotNil(
            JWSVerifier.verify(
                jws, trust: signer.trust, typ: .license, maxPayloadBytes: 16),
            "the frozen cap is a floor the caller cannot lower")
        // A RAISE with no expected typ is refused, even though everything else about the JWS is
        // valid.
        XCTAssertNil(
            JWSVerifier.verify(
                jws, trust: signer.trust, typ: nil, maxPayloadBytes: MAX_BUNDLE_BYTES),
            "a raised cap must be coupled to a proven typ")
        // …and with `requireTyp` switched off, likewise.
        XCTAssertNil(
            JWSVerifier.verify(
                jws, trust: signer.trust, typ: .license, requireTyp: false,
                maxPayloadBytes: MAX_BUNDLE_BYTES))
    }

    // ── §1 strict base64url (R2-05) ────────────────────────────────────────────────
    /// Out-of-alphabet bytes anywhere in a segment are a hard failure — not silently discarded
    /// (Python) and not accepted via the standard alphabet.
    func testOutOfAlphabetSegmentsAreRejected() {
        let valid = signer.sign(
            payloadJSON: licenseJSON(issuedAt: issued), typ: JwsTyp.license.rawValue)
        let parts = valid.split(separator: ".").map(String.init)
        for junk in ["***", "\n", "====", "++", "//", " "] {
            XCTAssertNil(
                JWSVerifier.verify(
                    "\(parts[0]).\(parts[1]).\(parts[2])\(junk)", trust: signer.trust,
                    typ: .license),
                "signature segment with \(junk.debugDescription) must be rejected")
        }
        XCTAssertNil(Base64URL.decodeStrict("ab+c"))
        XCTAssertNil(Base64URL.decodeStrict("ab/c"))
        XCTAssertNil(Base64URL.decodeStrict("abc="))
        XCTAssertNotNil(Base64URL.decodeStrict("a-b_"))
    }

    // ── §2 domain separation (R2-10) ───────────────────────────────────────────────
    /// A trust manifest presented where a license document is expected is rejected on `typ`, not
    /// by accident on a downstream decode error.
    func testWrongTypIsRejectedAtTheCallSite() {
        let payload = licenseJSON(issuedAt: issued)
        let asTrust = signer.sign(payloadJSON: payload, typ: JwsTyp.trust.rawValue)
        XCTAssertNil(JWSVerifier.verify(asTrust, trust: signer.trust, typ: .license))
        XCTAssertNotNil(JWSVerifier.verify(asTrust, trust: signer.trust, typ: .trust))
    }

    /// The two v3 documents refuse EACH OTHER. One signing key signs both, so without domain
    /// separation a config document — which carries no entitlements — could be presented as a
    /// licence, or a licence smuggled in where settings are read.
    func testTheTwoDocumentTypesRefuseEachOther() {
        let license = signer.sign(Fixtures.license(issuedAt: issued))
        let config = signer.sign(Fixtures.config(issuedAt: issued))
        let opts = VerifyOptions(
            trust: signer.trust, expectedAud: "djdl", deviceId: "dev", lastAcceptedIssuedAt: nil,
            now: issued)
        XCTAssertNotNil(verifyLicenseDoc(license, options: opts))
        XCTAssertNotNil(verifyConfigDoc(config, options: opts))
        XCTAssertNil(verifyConfigDoc(license, options: opts), "a licence is not a config doc")
        XCTAssertNil(verifyLicenseDoc(config, options: opts), "a config doc is not a licence")
    }

    /// v3's tolerance change: a header carrying NO `typ` is now REFUSED. v2 accepted it for one
    /// release as v1 compatibility; that window is over (§2), and the corpus pins it as
    /// `typ-missing-rejected`.
    func testAbsentTypIsNowRejected() {
        let untyped = signer.sign(payloadJSON: licenseJSON(issuedAt: issued), typ: nil)
        XCTAssertNil(
            JWSVerifier.verify(untyped, trust: signer.trust, typ: .license),
            "an untyped document is a document whose call site cannot be proved")
        // The escape hatch exists, but only for a caller that deliberately opts out.
        XCTAssertNotNil(
            JWSVerifier.verify(
                untyped, trust: signer.trust, typ: .license, requireTyp: false))
    }

    /// A non-string `typ`/`kid`/`alg` fails at parse, not on property access.
    func testNonObjectAndWrongTypedHeadersAreRejected() {
        let payload = licenseJSON(issuedAt: issued)
        for header in [
            "\"x\"", "1", "null", "[]", #"{"alg":1,"kid":"k"}"#,
            #"{"alg":"EdDSA","kid":7}"#, #"{"alg":"EdDSA","typ":7,"kid":"k"}"#,
        ] {
            XCTAssertNil(
                JWSVerifier.verify(
                    signer.signRaw(header: header, payload: payload), trust: signer.trust,
                    typ: .license),
                "header \(header) must be rejected")
        }
    }

    // ── §3 claim checks (R2-08) ────────────────────────────────────────────────────
    private func options(
        now: Int, lastAcceptedIssuedAt: Int? = nil, checkFreshness: Bool = true
    ) -> VerifyOptions {
        VerifyOptions(
            trust: signer.trust, expectedAud: "djdl", deviceId: "dev",
            lastAcceptedIssuedAt: lastAcceptedIssuedAt, now: now,
            checkFreshness: checkFreshness)
    }

    func testClaimChecks() {
        let t = issued
        // Happy path.
        XCTAssertNotNil(
            verifyLicenseDoc(signer.sign(Fixtures.license(issuedAt: t)), options: options(now: t)))

        // `iss` — a fixed string, never a suffix match. The bare apex is one label away and
        // must still be REJECTED (§8).
        XCTAssertNil(
            verifyLicenseDoc(
                signer.sign(Fixtures.license(iss: "plrs.im", issuedAt: t)),
                options: options(now: t)),
            "the bare `plrs.im` apex must not be accepted for `key.plrs.im`")
        XCTAssertNil(
            verifyLicenseDoc(
                signer.sign(Fixtures.license(iss: "https://evil.example", issuedAt: t)),
                options: options(now: t)))
        // A 400-day-expired doc is rejected AT VERIFY, not merely at the gate.
        XCTAssertNil(
            verifyLicenseDoc(
                signer.sign(Fixtures.license(issuedAt: t)),
                options: options(now: t + 400 * SECONDS_PER_DAY)))
        // A far-future `issuedAt` is prima facie tampering.
        XCTAssertNil(
            verifyLicenseDoc(
                signer.sign(Fixtures.license(issuedAt: t + 10 * SECONDS_PER_DAY)),
                options: options(now: t)))
        // graceUntil must not precede expiresAt…
        XCTAssertNil(
            verifyLicenseDoc(
                signer.sign(
                    Fixtures.license(issuedAt: t, expiresAt: t + 3600, graceUntil: t + 60)),
                options: options(now: t)))
        // …nor run past the bound that keeps a hostile server honest.
        XCTAssertNil(
            verifyLicenseDoc(
                signer.sign(
                    Fixtures.license(issuedAt: t, graceUntil: t + MAX_GRACE_SECONDS + 1)),
                options: options(now: t)))
        // Exactly AT the ceiling is fine — the bound is inclusive.
        XCTAssertNotNil(
            verifyLicenseDoc(
                signer.sign(Fixtures.license(issuedAt: t, graceUntil: t + MAX_GRACE_SECONDS)),
                options: options(now: t)))
        // Anti-replay: strictly newer than the last accepted, per TYPE.
        XCTAssertNil(
            verifyLicenseDoc(
                signer.sign(Fixtures.license(issuedAt: t)),
                options: options(now: t, lastAcceptedIssuedAt: t)))
        // An empty licenseId is not a licence.
        XCTAssertNil(
            verifyLicenseDoc(
                signer.sign(Fixtures.license(licenseId: "", issuedAt: t)),
                options: options(now: t)))
    }

    /// A config document's `schemaVersion` is the per-product CATALOG version, so an unfamiliar
    /// one is ACCEPTED — allow-listing it would brick every product that republished its schema.
    /// The SHAPE is what is enforceable, and `"4"` is the shape R2-08 slipped through.
    func testConfigSchemaVersionIsShapeCheckedNotAllowListed() {
        let t = issued
        XCTAssertNotNil(
            verifyConfigDoc(
                signer.sign(Fixtures.config(schemaVersion: 999, issuedAt: t)),
                options: options(now: t)))
        let asString = String(
            decoding: try! JSONEncoder().encode(Fixtures.config(issuedAt: t)), as: UTF8.self
        ).replacingOccurrences(of: #""schemaVersion":1"#, with: #""schemaVersion":"1""#)
        XCTAssertNil(
            verifyConfigDoc(
                signer.sign(payloadJSON: asString, typ: JwsTyp.config.rawValue),
                options: options(now: t)),
            "a non-integer schemaVersion must fail the shape check")
        XCTAssertNil(
            verifyConfigDoc(
                signer.sign(Fixtures.config(schemaVersion: 0, issuedAt: t)),
                options: options(now: t)),
            "a non-positive schemaVersion is not a catalog version")
    }

    /// `CLOCK_SKEW_SECONDS` is applied in both directions: a device five minutes fast no longer
    /// flips a freshly signed document, and a doc five minutes past `expiresAt` is still
    /// installable.
    func testClockSkewToleranceIsSymmetric() {
        let t = issued
        let doc = Fixtures.license(issuedAt: t)
        let jws = signer.sign(doc)
        XCTAssertNotNil(verifyLicenseDoc(jws, options: options(now: t - CLOCK_SKEW_SECONDS)))
        XCTAssertNil(verifyLicenseDoc(jws, options: options(now: t - CLOCK_SKEW_SECONDS - 1)))
        XCTAssertNotNil(
            verifyLicenseDoc(jws, options: options(now: doc.expiresAt + CLOCK_SKEW_SECONDS - 1)))
        XCTAssertNil(
            verifyLicenseDoc(jws, options: options(now: doc.expiresAt + CLOCK_SKEW_SECONDS)))
    }

    /// The cache-reload path (`checkFreshness: false`) accepts a document past its short
    /// `expiresAt` — being past it is what offline operation IS — while every other claim,
    /// including the device and product binding, still applies.
    func testCacheReloadPathSkipsFreshnessOnly() {
        let t = issued
        let doc = Fixtures.license(issuedAt: t)
        let jws = signer.sign(doc)
        let midGrace = doc.expiresAt + SECONDS_PER_DAY
        XCTAssertNil(verifyLicenseDoc(jws, options: options(now: midGrace)))
        XCTAssertNotNil(
            verifyLicenseDoc(jws, options: options(now: midGrace, checkFreshness: false)))
        // …but a doc bound to another device is still refused on the reload path — that is the
        // check the old cache path skipped entirely (R4-01).
        XCTAssertNil(
            verifyLicenseDoc(
                signer.sign(Fixtures.license(deviceId: "someone-else", issuedAt: t)),
                options: options(now: midGrace, checkFreshness: false)))
    }

    /// Extreme timestamps must be REJECTED, not trap. Swift traps on integer overflow, so a
    /// signed doc carrying `Int.max` would crash the host application inside the claim
    /// arithmetic — a remote DoS reachable by anyone holding a signing key.
    ///
    /// Every one of these is refused on the NETWORK path. On the RELOAD path the far-future
    /// guard is deliberately absent — `checkFreshness: false` turns off both halves of the
    /// freshness window, exactly as `@polaris-key/client-core` does, because a cached document is
    /// expected to be outside it. The bound that still applies there is
    /// `CoreContext.verifyCached`'s explicit `issuedAt <= effectiveNow + MAX_GRACE_SECONDS`,
    /// which is what stops one artifact from dragging the clock floor decades forward; see
    /// `TrustAndCacheTests.testCachedDocIsReVerifiedOnLoad`.
    func testExtremeTimestampsAreRejectedWithoutTrapping() {
        let t = issued
        let saturated = Fixtures.license(
            issuedAt: Int.max, expiresAt: Int.max, graceUntil: Int.max)
        let graceBeyondCeiling = [
            Fixtures.license(issuedAt: Int.min, expiresAt: Int.min, graceUntil: Int.max),
            Fixtures.license(issuedAt: t, expiresAt: Int.max, graceUntil: Int.max),
        ]

        // The network path refuses all three, and — the actual point — none of them trap.
        for doc in [saturated] + graceBeyondCeiling {
            XCTAssertNil(verifyLicenseDoc(signer.sign(doc), options: options(now: t)))
        }
        // On the reload path the grace ceiling still bites, because it is a claim invariant
        // rather than a freshness one.
        for doc in graceBeyondCeiling {
            XCTAssertNil(
                verifyLicenseDoc(
                    signer.sign(doc), options: options(now: t, checkFreshness: false)))
        }
        // …and the fully saturated document survives the arithmetic rather than trapping on it.
        // Wire contract v4 §3 then refuses it: `Int.max` is above `MAX_WIRE_INTEGER`, 2^53 − 1.
        XCTAssertNil(
            verifyLicenseDoc(
                signer.sign(saturated), options: options(now: t, checkFreshness: false)))
    }

    /// The trust set is consulted for the key, never the document — and an unknown or pruned kid
    /// simply is not in it.
    func testKeySelectionIsFromTheTrustSetOnly() {
        let jws = signer.sign(Fixtures.license(issuedAt: issued))
        XCTAssertNil(JWSVerifier.verify(jws, trust: [:], typ: .license))
        XCTAssertNil(
            JWSVerifier.verify(
                jws, trust: [signer.kid: TestSigner(kid: signer.kid).publicKeyB64],
                typ: .license))
    }

    /// The manifest's `schemaVersion` IS a genuine wire version, so an unknown one fails closed —
    /// unlike a config doc's, which is the per-product catalog version.
    func testUnknownManifestSchemaVersionIsRefused() {
        let t = issued
        let manifest = Fixtures.manifest(
            issuedAt: t,
            keys: [Fixtures.manifestKey(kid: signer.kid, publicKey: signer.publicKeyB64)])
        let good = verifyTrustManifest(
            signer.sign(manifest),
            options: VerifyTrustManifestOptions(
                pinned: signer.trust, expectedAud: "djdl", now: t))
        XCTAssertNotNil(good.doc)

        let future = signer.sign(
            payloadJSON: String(
                decoding: try! JSONEncoder().encode(manifest), as: UTF8.self
            ).replacingOccurrences(of: #""schemaVersion":1"#, with: #""schemaVersion":99"#),
            typ: JwsTyp.trust.rawValue)
        let refused = verifyTrustManifest(
            future,
            options: VerifyTrustManifestOptions(
                pinned: signer.trust, expectedAud: "djdl", now: t))
        XCTAssertNil(refused.doc)
        XCTAssertTrue(refused.discovered.isEmpty)
    }

    /// §8 — the identifier registry, asserted rather than assumed. Every one of these is a value
    /// the Worker and the other three SDKs also hardcode, so a typo here is a silent
    /// cross-language break rather than a local bug.
    func testV3IdentifierRegistry() {
        XCTAssertEqual(POLARIS_ISSUER, "key.plrs.im")
        XCTAssertEqual(POLARIS_PROTOCOL_VERSION, 4)
        XCTAssertEqual(CACHE_RECORD_VERSION, 3)
        XCTAssertEqual(DEVICE_TOKEN_PREFIX, "pkeyt_")
        XCTAssertEqual(MAX_BUNDLE_BYTES, 262_144)
        XCTAssertEqual(REFRESH_MARGIN_SECONDS, 1800)
        XCTAssertEqual(CLOCK_SKEW_SECONDS, 300)
        XCTAssertEqual(MAX_GRACE_SECONDS, 31_536_000)
        XCTAssertEqual(HEADER_DEVICE, "X-PKey-Device")
        XCTAssertEqual(HEADER_VERSION, "X-PKey-Version")
        XCTAssertEqual(HEADER_CHANNEL, "X-PKey-Channel")
        XCTAssertEqual(HEADER_PLATFORM, "X-PKey-Platform")
        XCTAssertEqual(HEADER_ARCH, "X-PKey-Arch")
        XCTAssertEqual(HEADER_SDK_NAME, "X-PKey-SDK")
        XCTAssertEqual(HEADER_SDK_VERSION, "X-PKey-SDK-Version")
        XCTAssertEqual(
            Set(JwsTyp.allCases.map(\.rawValue)),
            [
                "pkey-license+jws", "pkey-config+jws", "pkey-trust+jws", "pkey-bundle+jws",
                "pkey-feed+jws", "pkey-release+jws",
            ])
    }
}
