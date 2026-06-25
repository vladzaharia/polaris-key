// The Swift conformance runner. It drives EVERY case in the shared corpus through the
// native CryptoKit verifier (`JWSVerifier`) and asserts the expected verify outcome — the
// Node (vitest), Python (pytest), and React (vitest/WebCrypto) runners mirror this file
// against the SAME corpus/v1/cases.json. That's how the SDKs prove byte-identical
// verification: one signer, four runners.

import CryptoKit
import Foundation
import XCTest

@testable import PolarisKey

private struct Corpus: Decodable {
    let corpusVersion: Int
    let keys: [CorpusKey]
    let cases: [CorpusCase]
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
    let expect: Expect
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
        XCTAssertEqual(corpus.corpusVersion, 1)
    }

    /// Every corpus case: an `ok` case must verify, expose the expected `kid`, and reproduce
    /// the expected doc byte-for-byte; a `fail` case (tampered / wrong-kid / alg=none /
    /// malformed) must return nil.
    func testAllCorpusCases() throws {
        let corpus = try loadCorpus()
        for c in corpus.cases {
            let result = JWSVerifier.verify(c.jws, trust: c.trust)
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
                    trust: valid.trust, expectedAud: "djdl", deviceId: doc.deviceId)))
        // Wrong audience.
        XCTAssertNil(
            verifyDoc(
                valid.jws,
                options: VerifyDocOptions(
                    trust: valid.trust, expectedAud: "other", deviceId: doc.deviceId)))
        // Wrong device.
        XCTAssertNil(
            verifyDoc(
                valid.jws,
                options: VerifyDocOptions(
                    trust: valid.trust, expectedAud: "djdl", deviceId: "someone-else")))
        // Replay: issuedAt not strictly greater than the last accepted.
        XCTAssertNil(
            verifyDoc(
                valid.jws,
                options: VerifyDocOptions(
                    trust: valid.trust, expectedAud: "djdl", deviceId: doc.deviceId,
                    lastAcceptedIssuedAt: doc.issuedAt)))
        // Fresh: issuedAt strictly greater than the last accepted passes.
        XCTAssertNotNil(
            verifyDoc(
                valid.jws,
                options: VerifyDocOptions(
                    trust: valid.trust, expectedAud: "djdl", deviceId: doc.deviceId,
                    lastAcceptedIssuedAt: doc.issuedAt - 1)))
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
                {"schemaVersion":1,"licenseId":"\(pad)","deviceId":"d","issuedAt":1,\
                "expiresAt":2,"graceUntil":3,"profile":{"name":"n","firstName":"f",\
                "email":"e","enrolledAt":0},"payload":{"config":{},"secrets":{},\
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
