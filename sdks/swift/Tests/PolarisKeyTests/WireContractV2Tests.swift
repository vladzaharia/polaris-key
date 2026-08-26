// Wire contract v2 §2/§3 regression tests: the parser hardening and the claim checks.
//
// Each test corresponds to a finding whose proof-of-concept PASSED against the previous
// build — they are written so that reverting the fix fails the test, not so that they merely
// exercise the happy path.

import CryptoKit
import Foundation
import XCTest

@testable import PolarisKey

final class WireContractV2Tests: XCTestCase {
    private let signer = TestSigner(kid: "wire-v2-key")

    private func docJSON(issuedAt: Int) -> String {
        String(decoding: try! JSONEncoder().encode(Fixtures.doc(issuedAt: issuedAt)), as: UTF8.self)
    }

    // ── §2.2 duplicate keys (R2-06) ────────────────────────────────────────────────
    /// The sharp one. `JSONSerialization` resolved duplicates FIRST-wins while TS/Python
    /// resolve LAST-wins, so `{"alg":"none","kid":K,"alg":"EdDSA"}` read as `none` in Swift
    /// and `EdDSA` everywhere else — the algorithm-downgrade guard answering differently for
    /// identical signed bytes. v2 rejects duplicates outright, in BOTH orderings.
    func testDuplicateAlgInHeaderIsRejectedInBothOrderings() {
        let payload = docJSON(issuedAt: 1_700_000_000)
        let noneFirst = signer.signRaw(
            header: #"{"alg":"none","kid":"\#(signer.kid)","alg":"EdDSA"}"#, payload: payload)
        let eddsaFirst = signer.signRaw(
            header: #"{"alg":"EdDSA","kid":"\#(signer.kid)","alg":"none"}"#, payload: payload)

        XCTAssertNil(
            JWSVerifier.verify(noneFirst, trust: signer.trust),
            "a header declaring `alg` twice must be REJECTED, not resolved")
        XCTAssertNil(
            JWSVerifier.verify(eddsaFirst, trust: signer.trust),
            "duplicate rejection must not depend on which member comes first")
        // Control: the same signer, the same payload, one `alg` ⇒ verifies. So the rejection
        // above is the duplicate scan, not a broken signature.
        XCTAssertNotNil(
            JWSVerifier.verify(
                signer.signRaw(header: signer.header(), payload: payload), trust: signer.trust))
    }

    func testDuplicateKidInHeaderIsRejected() {
        let jws = signer.signRaw(
            header: #"{"alg":"EdDSA","kid":"\#(signer.kid)","kid":"other"}"#,
            payload: docJSON(issuedAt: 1_700_000_000))
        XCTAssertNil(JWSVerifier.verify(jws, trust: signer.trust))
    }

    func testDuplicateKeyInPayloadIsRejected() {
        let dup = #"{"schemaVersion":1,"schemaVersion":2,"aud":"djdl"}"#
        XCTAssertNil(JWSVerifier.verifyPayloadData(signer.sign(payloadJSON: dup), trust: signer.trust))
    }

    /// Duplicates nested inside an object, and inside an object inside an ARRAY, are caught
    /// too — a scan that only tracked the top level would miss both.
    func testDuplicateKeyNestedAndInsideArrayIsRejected() {
        let nested = #"{"a":{"x":1,"x":2}}"#
        let inArray = #"{"a":[{"x":1,"x":2}]}"#
        // Array ELEMENTS are not keys: repeated values must not be mistaken for duplicates.
        let legit = #"{"a":["x","x"],"b":{"x":1},"c":{"x":2}}"#
        XCTAssertTrue(StrictJSON.hasDuplicateKeys(Data(nested.utf8)))
        XCTAssertTrue(StrictJSON.hasDuplicateKeys(Data(inArray.utf8)))
        XCTAssertFalse(StrictJSON.hasDuplicateKeys(Data(legit.utf8)))
    }

    /// Escaped and unescaped spellings of the same key collide, exactly as a JSON parser
    /// would collapse them — a byte-comparison scan would let `a` smuggle a second `a`.
    func testEscapedDuplicateKeyIsRejected() {
        XCTAssertTrue(StrictJSON.hasDuplicateKeys(Data(#"{"a":1,"a":2}"#.utf8)))
        XCTAssertTrue(StrictJSON.hasDuplicateKeys(Data(#"{"a\"b":1,"a\"b":2}"#.utf8)))
        XCTAssertFalse(StrictJSON.hasDuplicateKeys(Data(#"{"a\"b":1,"ab":2}"#.utf8)))
    }

    // ── §2.1 size caps (R2-04) ─────────────────────────────────────────────────────
    /// The payload cap was bypassable by moving the blob into the PROTECTED HEADER, which no
    /// implementation bounded. The signature here is VALID, so only the cap can reject it.
    func testOversizedHeaderIsRejectedDespiteValidSignature() {
        let junk = String(repeating: "x", count: 8 * 1024 * 1024)
        let jws = signer.signRaw(
            header: #"{"alg":"EdDSA","kid":"\#(signer.kid)","junk":"\#(junk)"}"#,
            payload: docJSON(issuedAt: 1_700_000_000))
        XCTAssertNil(JWSVerifier.verify(jws, trust: signer.trust))
    }

    /// The boundary: a header exactly at 1024 decoded bytes verifies, one byte over does not.
    func testHeaderCapBoundary() {
        func header(padding: Int) -> String {
            #"{"alg":"EdDSA","kid":"\#(signer.kid)","p":"\#(String(repeating: "x", count: padding))"}"#
        }
        let base = header(padding: 0).utf8.count
        let atCap = header(padding: JWSVerifier.maxHeaderBytes - base)
        let overCap = header(padding: JWSVerifier.maxHeaderBytes - base + 1)
        XCTAssertEqual(atCap.utf8.count, JWSVerifier.maxHeaderBytes)

        let payload = docJSON(issuedAt: 1_700_000_000)
        XCTAssertNotNil(
            JWSVerifier.verify(
                signer.signRaw(header: atCap, payload: payload), trust: signer.trust),
            "a header at the cap must verify")
        XCTAssertNil(
            JWSVerifier.verify(
                signer.signRaw(header: overCap, payload: payload), trust: signer.trust),
            "a header one byte over the cap must be rejected")
    }

    /// The ENCODED segments are bounded before any decode, so an oversized blob is rejected
    /// without ever being allocated.
    func testEncodedSegmentCapsAreDerivedFromTheDecodedCaps() {
        XCTAssertEqual(JWSVerifier.maxHeaderB64, (1024 * 4 + 2) / 3 + 4)
        XCTAssertEqual(JWSVerifier.maxPayloadB64, (65536 * 4 + 2) / 3 + 4)
        let huge = String(repeating: "A", count: JWSVerifier.maxPayloadB64 + 1)
        XCTAssertNil(JWSVerifier.verify("aGVhZGVy.\(huge).c2ln", trust: signer.trust))
    }

    // ── §2.3 strict base64url (R2-05) ──────────────────────────────────────────────
    /// Out-of-alphabet bytes anywhere in a segment are a hard failure — not silently
    /// discarded (Python) and not accepted via the standard alphabet.
    func testOutOfAlphabetSegmentsAreRejected() {
        let valid = signer.sign(payloadJSON: docJSON(issuedAt: 1_700_000_000))
        let parts = valid.split(separator: ".").map(String.init)
        for junk in ["***", "\n", "====", "++", "//", " "] {
            XCTAssertNil(
                JWSVerifier.verify(
                    "\(parts[0]).\(parts[1]).\(parts[2])\(junk)", trust: signer.trust),
                "signature segment with \(junk.debugDescription) must be rejected")
        }
        XCTAssertNil(Base64URL.decodeStrict("ab+c"))
        XCTAssertNil(Base64URL.decodeStrict("ab/c"))
        XCTAssertNil(Base64URL.decodeStrict("abc="))
        XCTAssertNotNil(Base64URL.decodeStrict("a-b_"))
    }

    // ── §2.4 domain separation (R2-10) ─────────────────────────────────────────────
    /// A trust manifest presented where a config doc is expected is rejected on `typ`, not by
    /// accident on a downstream decode error.
    func testWrongTypIsRejectedAtTheCallSite() {
        let payload = docJSON(issuedAt: 1_700_000_000)
        let asTrust = signer.sign(payloadJSON: payload, typ: JwsTyp.trust.rawValue)
        XCTAssertNil(JWSVerifier.verify(asTrust, trust: signer.trust, typ: .config))
        XCTAssertNotNil(JWSVerifier.verify(asTrust, trust: signer.trust, typ: .trust))
    }

    /// v1 compatibility (§7.2): a header carrying NO `typ` is still accepted for one release.
    func testAbsentTypIsAcceptedForV1Compatibility() {
        let v1 = signer.sign(payloadJSON: docJSON(issuedAt: 1_700_000_000), typ: nil)
        XCTAssertNotNil(JWSVerifier.verify(v1, trust: signer.trust, typ: .config))
    }

    /// A non-string `typ`/`kid`/`alg` fails at parse, not on property access.
    func testNonObjectAndWrongTypedHeadersAreRejected() {
        let payload = docJSON(issuedAt: 1_700_000_000)
        for header in ["\"x\"", "1", "null", "[]", #"{"alg":1,"kid":"k"}"#,
                       #"{"alg":"EdDSA","kid":7}"#, #"{"alg":"EdDSA","typ":7,"kid":"k"}"#] {
            XCTAssertNil(
                JWSVerifier.verify(
                    signer.signRaw(header: header, payload: payload), trust: signer.trust),
                "header \(header) must be rejected")
        }
    }

    // ── §3 claim checks (R2-08) ────────────────────────────────────────────────────
    private func options(
        now: Int, lastAcceptedIssuedAt: Int? = nil, checkFreshness: Bool = true
    ) -> VerifyDocOptions {
        VerifyDocOptions(
            trust: signer.trust, expectedAud: "djdl", deviceId: "dev",
            lastAcceptedIssuedAt: lastAcceptedIssuedAt, now: now,
            checkFreshness: checkFreshness)
    }

    func testClaimChecks() {
        let t = 1_700_000_000
        // Happy path.
        XCTAssertNotNil(
            verifyDoc(signer.sign(Fixtures.doc(issuedAt: t)), options: options(now: t)))

        // `iss` — documented as always `key.plrs.im`, never enforced before v2.
        XCTAssertNil(
            verifyDoc(
                signer.sign(Fixtures.doc(iss: "https://evil.example", issuedAt: t)),
                options: options(now: t)))
        // `schemaVersion` is the per-product CATALOG version, so an unfamiliar one is
        // ACCEPTED — allow-listing it would brick every product that republished its schema
        // (§3.1 correction 1). The shape check is that it must be an integer at all.
        XCTAssertNotNil(
            verifyDoc(
                signer.sign(Fixtures.doc(schemaVersion: 999, issuedAt: t)),
                options: options(now: t)))
        XCTAssertNil(
            verifyDoc(
                signer.sign(
                    payloadJSON: docJSON(issuedAt: t)
                        .replacingOccurrences(
                            of: #""schemaVersion":1"#, with: #""schemaVersion":"1""#)),
                options: options(now: t)),
            "a non-integer schemaVersion must fail the shape check")
        // A 400-day-expired doc is rejected AT VERIFY, not merely at the gate.
        XCTAssertNil(
            verifyDoc(
                signer.sign(Fixtures.doc(issuedAt: t)),
                options: options(now: t + 400 * SECONDS_PER_DAY)))
        // A far-future `issuedAt` is prima facie tampering (there was no upper bound at all).
        XCTAssertNil(
            verifyDoc(
                signer.sign(Fixtures.doc(issuedAt: t + 10 * SECONDS_PER_DAY)),
                options: options(now: t)))
        // graceUntil must not precede expiresAt…
        XCTAssertNil(
            verifyDoc(
                signer.sign(
                    Fixtures.doc(issuedAt: t, expiresAt: t + 3600, graceUntil: t + 60)),
                options: options(now: t)))
        // …nor run past the bound that keeps a hostile server honest.
        XCTAssertNil(
            verifyDoc(
                signer.sign(
                    Fixtures.doc(issuedAt: t, graceUntil: t + MAX_GRACE_SECONDS + 1)),
                options: options(now: t)))
        // Anti-replay is unchanged: strictly newer than the last accepted.
        XCTAssertNil(
            verifyDoc(
                signer.sign(Fixtures.doc(issuedAt: t)),
                options: options(now: t, lastAcceptedIssuedAt: t)))
    }

    /// `CLOCK_SKEW_SECONDS` is applied in both directions: a device five minutes fast no
    /// longer flips a freshly signed document, and a doc five minutes past `expiresAt` is
    /// still installable.
    func testClockSkewToleranceIsSymmetric() {
        let t = 1_700_000_000
        let doc = Fixtures.doc(issuedAt: t)
        let jws = signer.sign(doc)
        XCTAssertNotNil(verifyDoc(jws, options: options(now: t - CLOCK_SKEW_SECONDS)))
        XCTAssertNil(verifyDoc(jws, options: options(now: t - CLOCK_SKEW_SECONDS - 1)))
        XCTAssertNotNil(
            verifyDoc(jws, options: options(now: doc.expiresAt + CLOCK_SKEW_SECONDS - 1)))
        XCTAssertNil(
            verifyDoc(jws, options: options(now: doc.expiresAt + CLOCK_SKEW_SECONDS)))
    }

    /// The cache-reload path (`checkFreshness: false`) accepts a document that is past its
    /// short `expiresAt` — being past it is what offline operation IS — while every other
    /// claim, including the device and product binding, still applies.
    func testCacheReloadPathSkipsFreshnessOnly() {
        let t = 1_700_000_000
        let doc = Fixtures.doc(issuedAt: t)
        let jws = signer.sign(doc)
        let midGrace = doc.expiresAt + SECONDS_PER_DAY
        XCTAssertNil(verifyDoc(jws, options: options(now: midGrace)))
        XCTAssertNotNil(
            verifyDoc(jws, options: options(now: midGrace, checkFreshness: false)))
        // …but a doc bound to another device is still refused on the reload path — that is
        // the check the old cache path skipped entirely (R4-01).
        XCTAssertNil(
            verifyDoc(
                signer.sign(Fixtures.doc(deviceId: "someone-else", issuedAt: t)),
                options: options(now: midGrace, checkFreshness: false)))
    }

    /// Extreme timestamps must be REJECTED, not trap. Swift traps on integer overflow, so a
    /// signed doc carrying `Int.max` would crash the host application inside the claim
    /// arithmetic — a remote DoS reachable by anyone holding a signing key.
    func testExtremeTimestampsAreRejectedWithoutTrapping() {
        let t = 1_700_000_000
        for doc in [
            Fixtures.doc(issuedAt: Int.max, expiresAt: Int.max, graceUntil: Int.max),
            Fixtures.doc(issuedAt: Int.min, expiresAt: Int.min, graceUntil: Int.max),
            Fixtures.doc(issuedAt: t, expiresAt: Int.max, graceUntil: Int.max),
        ] {
            XCTAssertNil(verifyDoc(signer.sign(doc), options: options(now: t)))
            XCTAssertNil(
                verifyDoc(signer.sign(doc), options: options(now: t, checkFreshness: false)))
        }
    }

    /// The trust set is consulted for the key, never the document — and an unknown or pruned
    /// kid simply is not in it.
    func testKeySelectionIsFromTheTrustSetOnly() {
        let jws = signer.sign(Fixtures.doc(issuedAt: 1_700_000_000))
        XCTAssertNil(JWSVerifier.verify(jws, trust: [:]))
        XCTAssertNil(
            JWSVerifier.verify(
                jws, trust: [signer.kid: TestSigner(kid: signer.kid).publicKeyB64]))
    }
}
