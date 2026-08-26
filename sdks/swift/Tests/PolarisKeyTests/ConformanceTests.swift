// The Swift conformance runner. It drives EVERY case in the shared corpus through the
// native CryptoKit verifier and asserts the expected outcome — the Node (vitest), Python
// (pytest), and React (vitest/WebCrypto) runners mirror this file against the SAME
// corpus/v1/cases.json. That's how the SDKs prove byte-identical verification: one signer,
// four runners.
//
// Four sections, four layers of the wire contract:
//
//   cases            raw compact-JWS verification           → JWSVerifier.verify
//   docCases         §3 claim validation                    → verifyDoc
//   trustCases       §1 trust-set merge / prune / revocation → verifyTrustManifest + mergeTrust
//   clockFloorCases  §4.3 monotonic clock floor              → the reload path + licenseState

import CryptoKit
import Foundation
import XCTest

@testable import PolarisKey

private struct Corpus: Decodable {
    let corpusVersion: Int
    let keys: [CorpusKey]
    let cases: [CorpusCase]
    let docCases: [CorpusDocCase]
    let trustCases: [CorpusTrustCase]
    let clockFloorCases: [CorpusClockFloorCase]
}

private struct CorpusKey: Decodable {
    let kid: String
    let publicKeyRaw: String
}

private struct CorpusCase: Decodable {
    let id: String
    let description: String
    let jws: String
    let trust: [String: String]
    /// The document type the call site expects, when the case pins one (§2.4).
    let typ: String?
    let expect: Expect
}

/// §3 — claim validation over an already-signature-valid document.
private struct CorpusDocCase: Decodable {
    let id: String
    let description: String
    let jws: String
    let trust: [String: String]
    let expectedAud: String
    let expectedIss: String
    let deviceId: String
    let now: Int
    let lastAcceptedIssuedAt: Int?
    /// Absent ⇒ the NETWORK path (freshness enforced); `false` ⇒ the cache-reload path.
    let checkFreshness: Bool?
    let expect: DocExpect
}

private struct DocExpect: Decodable {
    let accept: Bool
}

/// §1 — what a manifest does to a trust set, given what was already held.
private struct CorpusTrustCase: Decodable {
    let id: String
    let description: String
    let pinned: [String: String]
    let before: [String: String]
    let manifestJws: String
    let now: Int
    /// Absent ⇒ the NETWORK path (freshness enforced); `false` ⇒ the cache-reload path.
    let checkFreshness: Bool?
    let expect: TrustExpect
}

private struct TrustExpect: Decodable {
    let accepted: Bool
    let trust: [String: String]
    /// The accepted manifest's `issuedAt` — the value §4.3 folds into the clock floor.
    let issuedAt: Int?
}

/// §4.3 — the cache-RELOAD path replayed as pure data, ending at a gate decision.
private struct CorpusClockFloorCase: Decodable {
    let id: String
    let description: String
    let pinned: [String: String]
    let trustJws: String?
    let configJws: String?
    let expectedAud: String
    let deviceId: String
    let systemClock: Int
    let expect: ClockFloorExpect
}

private struct ClockFloorExpect: Decodable {
    let highWaterMark: Int
    let effectiveNow: Int
    let status: String
}

private struct Expect: Decodable {
    let verify: String
    let kid: String?
    let doc: ManagedConfigDoc?
}

final class ConformanceTests: XCTestCase {
    private func loadCorpus() throws -> Corpus {
        guard let url = Bundle.module.url(forResource: "cases", withExtension: "json") else {
            XCTFail("cases.json not found in test bundle")
            throw NSError(domain: "corpus", code: 1)
        }
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(Corpus.self, from: data)
    }

    func testCorpusHasCases() throws {
        let corpus = try loadCorpus()
        XCTAssertGreaterThan(corpus.cases.count, 0)
        XCTAssertGreaterThan(corpus.docCases.count, 0)
        XCTAssertGreaterThan(corpus.trustCases.count, 0)
        XCTAssertGreaterThan(corpus.clockFloorCases.count, 0)
        XCTAssertGreaterThanOrEqual(corpus.corpusVersion, 1)
    }

    /// §3 — every claim the wire contract makes about a document, at a pinned `now`.
    func testAllCorpusDocCases() throws {
        for c in try loadCorpus().docCases {
            let doc = verifyDoc(
                c.jws,
                options: VerifyDocOptions(
                    trust: c.trust, expectedAud: c.expectedAud, deviceId: c.deviceId,
                    lastAcceptedIssuedAt: c.lastAcceptedIssuedAt, expectedIss: c.expectedIss,
                    now: c.now, checkFreshness: c.checkFreshness ?? true))
            if c.expect.accept {
                XCTAssertNotNil(doc, "\(c.id) should be accepted — \(c.description)")
            } else {
                XCTAssertNil(doc, "\(c.id) must be rejected — \(c.description)")
            }
        }
    }

    /// §1 — a manifest is verified against the PINNED keys only, and what it publishes
    /// REPLACES the discovered set. A refused manifest leaves the previous set untouched.
    func testAllCorpusTrustCases() throws {
        for c in try loadCorpus().trustCases {
            let result = verifyTrustManifest(
                c.manifestJws,
                options: VerifyTrustManifestOptions(
                    pinned: c.pinned, expectedAud: "djdl", now: c.now,
                    checkFreshness: c.checkFreshness ?? true))
            XCTAssertEqual(
                result.doc != nil, c.expect.accepted,
                "\(c.id) acceptance — \(c.description)")
            let discovered = result.doc != nil ? result.discovered : c.before
            XCTAssertEqual(
                mergeTrust(c.pinned, discovered), c.expect.trust,
                "\(c.id) resulting trust set")
            if let issuedAt = c.expect.issuedAt {
                XCTAssertEqual(result.doc?.issuedAt, issuedAt, "\(c.id) issuedAt")
            }
        }
    }

    /// §4.3 — the monotonic clock floor. Each case replays the cache-RELOAD path as pure
    /// data: re-verify the cached manifest (freshness OFF), re-verify the cached document
    /// against the resulting trust set (freshness OFF), take the floor as the max of the
    /// `issuedAt` of whatever actually verified, then gate at `max(systemClock, floor)`.
    ///
    /// Deriving the floor from the document ALONE is inert (R4-04) — that is what
    /// `floor-config-doc-alone-does-not-stop-rollback` pins, and why the manifest must be
    /// the second source.
    func testAllCorpusClockFloorCases() throws {
        for c in try loadCorpus().clockFloorCases {
            var trust = c.pinned
            var highWaterMark = 0

            if let trustJws = c.trustJws {
                let manifest = verifyTrustManifest(
                    trustJws,
                    options: VerifyTrustManifestOptions(
                        pinned: c.pinned, expectedAud: c.expectedAud, now: c.systemClock,
                        checkFreshness: false))
                if let doc = manifest.doc {
                    trust = mergeTrust(c.pinned, manifest.discovered)
                    highWaterMark = max(highWaterMark, doc.issuedAt)
                }
            }

            var doc: ManagedConfigDoc?
            if let configJws = c.configJws {
                doc = verifyDoc(
                    configJws,
                    options: VerifyDocOptions(
                        trust: trust, expectedAud: c.expectedAud, deviceId: c.deviceId,
                        now: c.systemClock, checkFreshness: false))
                if let doc { highWaterMark = max(highWaterMark, doc.issuedAt) }
            }

            XCTAssertEqual(highWaterMark, c.expect.highWaterMark, "\(c.id) highWaterMark")
            XCTAssertEqual(
                max(c.systemClock, highWaterMark), c.expect.effectiveNow,
                "\(c.id) effectiveNow")
            let state = licenseState(
                GateInput(
                    hasToken: true, doc: doc, now: max(c.systemClock, highWaterMark)))
            XCTAssertEqual(
                state.status.rawValue, c.expect.status, "\(c.id) — \(c.description)")
        }
    }

    /// Every corpus case: an `ok` case must verify, expose the expected `kid`, and reproduce
    /// the expected doc byte-for-byte; a `fail` case (tampered / wrong-kid / alg=none /
    /// malformed) must return nil.
    func testAllCorpusCases() throws {
        let corpus = try loadCorpus()
        for c in corpus.cases {
            let result = JWSVerifier.verify(
                c.jws, trust: c.trust, typ: c.typ.flatMap(JwsTyp.init(rawValue:)))
            if c.expect.verify == "ok" {
                guard let result else {
                    XCTFail("\(c.id) should verify but returned nil")
                    continue
                }
                XCTAssertEqual(result.kid, c.expect.kid, "\(c.id): kid mismatch")
                XCTAssertEqual(result.payload, c.expect.doc, "\(c.id): doc mismatch")
            } else {
                XCTAssertNil(result, "\(c.id) must fail verification")
            }
        }
    }

    /// The trusted production test key + a deliberately wrong key, to prove key selection is
    /// driven by the trust set's value, not merely the presence of the kid.
    func testWrongKeyForKnownKidFails() throws {
        let corpus = try loadCorpus()
        guard let valid = corpus.cases.first(where: { $0.id == "valid-stable" }) else {
            XCTFail("missing valid-stable case")
            return
        }
        // Same kid, but the other corpus key's bytes — signature must fail.
        let wrongTrust = ["pkey-test-prod-2026": "H3usSYUdIQXrrJNU0N-HhR7XSSXr4n0cl4JfF_X5g8U"]
        XCTAssertNil(JWSVerifier.verify(valid.jws, trust: wrongTrust))
    }

    /// A 31-byte (non-32) key is rejected before any signature math.
    func testNon32ByteKeyRejected() throws {
        let corpus = try loadCorpus()
        guard let valid = corpus.cases.first(where: { $0.id == "valid-stable" }) else {
            XCTFail("missing valid-stable case")
            return
        }
        let short = Base64URL.encode(Data(repeating: 0, count: 31))
        XCTAssertNil(JWSVerifier.verify(valid.jws, trust: ["pkey-test-prod-2026": short]))
    }

    /// The product-scoped `verifyDoc` wrapper: right aud/device passes, wrong fails, and a
    /// replayed issuedAt is rejected.
    ///
    /// `now` is anchored to the vector's own `issuedAt` because wire contract v2 §3 checks
    /// the whole signed validity window, and these are fixed-timestamp 2023 fixtures.
    func testVerifyDocAntiReplay() throws {
        let corpus = try loadCorpus()
        guard let valid = corpus.cases.first(where: { $0.id == "valid-stable" }),
            let doc = valid.expect.doc
        else {
            XCTFail("missing valid-stable case")
            return
        }
        // Correct product + device.
        XCTAssertNotNil(
            verifyDoc(
                valid.jws,
                options: VerifyDocOptions(
                    trust: valid.trust, expectedAud: "djdl", deviceId: doc.deviceId,
                    now: doc.issuedAt)))
        // Wrong audience.
        XCTAssertNil(
            verifyDoc(
                valid.jws,
                options: VerifyDocOptions(
                    trust: valid.trust, expectedAud: "other", deviceId: doc.deviceId,
                    now: doc.issuedAt)))
        // Wrong device.
        XCTAssertNil(
            verifyDoc(
                valid.jws,
                options: VerifyDocOptions(
                    trust: valid.trust, expectedAud: "djdl", deviceId: "someone-else",
                    now: doc.issuedAt)))
        // Replay: issuedAt not strictly greater than the last accepted.
        XCTAssertNil(
            verifyDoc(
                valid.jws,
                options: VerifyDocOptions(
                    trust: valid.trust, expectedAud: "djdl", deviceId: doc.deviceId,
                    lastAcceptedIssuedAt: doc.issuedAt, now: doc.issuedAt)))
        // Fresh: issuedAt strictly greater than the last accepted passes.
        XCTAssertNotNil(
            verifyDoc(
                valid.jws,
                options: VerifyDocOptions(
                    trust: valid.trust, expectedAud: "djdl", deviceId: doc.deviceId,
                    lastAcceptedIssuedAt: doc.issuedAt - 1, now: doc.issuedAt)))
    }

    // ── P1.7: payload byte-size cap ──────────────────────────────────────────────
    /// Sign a JWS in-test with a fresh key so the signature is valid, then prove the size cap
    /// (not the signature) is what rejects an over-cap payload: an exactly-at-cap blob still
    /// verifies, a 1-byte-over blob does not.
    private func signJws(kid: String, payloadJSON: Data, key: Curve25519.Signing.PrivateKey)
        -> String
    {
        let header = Data(#"{"alg":"EdDSA","kid":"\#(kid)"}"#.utf8)
        let signingInput = Base64URL.encode(header) + "." + Base64URL.encode(payloadJSON)
        let sig = try! key.signature(for: Data(signingInput.utf8))
        return signingInput + "." + Base64URL.encode(sig)
    }

    func testPayloadSizeCapRejectsOversizedButAcceptsAtCap() throws {
        let key = Curve25519.Signing.PrivateKey()
        let kid = "test-cap-key"
        let trust = [kid: Base64URL.encode(key.publicKey.rawRepresentation)]

        // A valid doc whose `licenseId` is padded so the serialized payload lands at an exact
        // byte length. We build at cap, then one byte over.
        func payload(padLen: Int) -> Data {
            let pad = String(repeating: "x", count: padLen)
            let json = """
                {"schemaVersion":1,"aud":"djdl","iss":"key.plrs.im","licenseId":"\(pad)",\
                "deviceId":"d","issuedAt":1,\
                "expiresAt":2,"graceUntil":3,"profile":{"name":"n","firstName":"f",\
                "email":"e","activatedAt":0},"payload":{"config":{},"secrets":{},\
                "entitlements":{}}}
                """
            return Data(json.utf8)
        }

        // Find a pad that puts us exactly AT the cap.
        let base = payload(padLen: 0).count
        let atCapPad = JWSVerifier.maxPayloadBytes - base
        let atCap = payload(padLen: atCapPad)
        XCTAssertEqual(atCap.count, JWSVerifier.maxPayloadBytes)
        let overCap = payload(padLen: atCapPad + 1)
        XCTAssertEqual(overCap.count, JWSVerifier.maxPayloadBytes + 1)

        // At cap: valid signature + within cap ⇒ verifies.
        XCTAssertNotNil(
            JWSVerifier.verify(signJws(kid: kid, payloadJSON: atCap, key: key), trust: trust),
            "payload at the cap must verify")
        // Over cap: valid signature but rejected by the size guard.
        XCTAssertNil(
            JWSVerifier.verify(signJws(kid: kid, payloadJSON: overCap, key: key), trust: trust),
            "payload over the cap must be rejected before decode")
    }
}
