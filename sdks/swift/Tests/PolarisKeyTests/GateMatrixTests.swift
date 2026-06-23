// Exhaustive gate matrix + verifyDoc anti-replay (driven off the shared corpus's signed
// vectors so no in-test signer is needed). The gate precedence is load-bearing, so this
// enumerates every status and every block-reason mapping, plus isUsable across the whole
// LicenseStatus space.

import Foundation
import XCTest

@testable import PolarisKey

private struct Corpus: Decodable {
    let cases: [CorpusCase]
}
private struct CorpusCase: Decodable {
    let id: String
    let jws: String
    let trust: [String: String]
    let expect: Expect
}
private struct Expect: Decodable {
    let verify: String
    let doc: ManagedConfigDoc?
}

final class GateMatrixTests: XCTestCase {
    private func makeDoc(issuedAt: Int, expiresAt: Int, graceUntil: Int) -> ManagedConfigDoc {
        ManagedConfigDoc(
            schemaVersion: 1, aud: "djdl", iss: POLARIS_ISSUER,
            licenseId: "lic_m", deviceId: "dev_m",
            issuedAt: issuedAt, expiresAt: expiresAt, graceUntil: graceUntil,
            profile: DocProfile(name: "M", firstName: "M", email: "m@x.y", enrolledAt: 0),
            payload: ManagedPayload())
    }

    // ── Precedence: blocked beats token/doc/expiry entirely ──────────────────────
    func testBlockedBeatsEverythingEvenWithValidDoc() {
        let doc = makeDoc(issuedAt: 0, expiresAt: 1000, graceUntil: 2000)
        let s = licenseState(
            GateInput(
                hasToken: true, doc: doc, now: 500,
                blocked: BlockInfo(reason: .versionTooNew, allowedRange: AllowedRange(max: "9.9.9"))))
        XCTAssertEqual(s.status, .versionTooNew)
        XCTAssertEqual(s.allowedRange?.max, "9.9.9")
    }

    func testAllThreeBlockReasonsMapToTheirStatus() {
        let cases: [(BlockReason, LicenseStatus)] = [
            (.versionTooOld, .versionTooOld),
            (.versionTooNew, .versionTooNew),
            (.channelNotEntitled, .channelNotEntitled),
        ]
        for (reason, expected) in cases {
            let s = licenseState(
                GateInput(hasToken: true, doc: nil, now: 1, blocked: BlockInfo(reason: reason)))
            XCTAssertEqual(s.status, expected, "reason \(reason) → \(expected)")
        }
    }

    // ── The non-blocked ladder ───────────────────────────────────────────────────
    func testNoTokenBeforeRevokedBeforeNoDoc() {
        // No token wins over a lingering unauthorized flag.
        XCTAssertEqual(
            licenseState(GateInput(hasToken: false, doc: nil, now: 1, lastSyncUnauthorized: true)).status,
            .needsEnroll)
        // With a token, the unauthorized flag → revoked.
        XCTAssertEqual(
            licenseState(GateInput(hasToken: true, doc: nil, now: 1, lastSyncUnauthorized: true)).status,
            .revoked)
        // Token, no flag, no doc → needs-enroll.
        XCTAssertEqual(
            licenseState(GateInput(hasToken: true, doc: nil, now: 1)).status, .needsEnroll)
    }

    func testExpiryLadderWithExactBoundaries() {
        let doc = makeDoc(issuedAt: 100, expiresAt: 200, graceUntil: 300)
        let now = { (n: Int) in licenseState(GateInput(hasToken: true, doc: doc, now: n)).status }
        XCTAssertEqual(now(199), .ok)
        XCTAssertEqual(now(200), .ok)        // now == expiresAt is still ok
        XCTAssertEqual(now(201), .grace)     // first second past expiry
        XCTAssertEqual(now(300), .grace)     // now == graceUntil is still grace
        XCTAssertEqual(now(301), .expired)   // first second past grace
    }

    func testLastVerifiedAtPropagatesInOkAndGraceOnly() {
        let doc = makeDoc(issuedAt: 0, expiresAt: 1000, graceUntil: 2000)
        XCTAssertEqual(
            licenseState(GateInput(hasToken: true, doc: doc, now: 500, lastVerifiedAt: 480)).lastVerifiedAt,
            480)
        XCTAssertEqual(
            licenseState(GateInput(hasToken: true, doc: doc, now: 1500, lastVerifiedAt: 480)).lastVerifiedAt,
            480)
        // Expired carries graceUntil but not lastVerifiedAt.
        let expired = licenseState(GateInput(hasToken: true, doc: doc, now: 2500, lastVerifiedAt: 480))
        XCTAssertEqual(expired.graceUntil, 2000)
        XCTAssertNil(expired.lastVerifiedAt)
    }

    func testIsUsableAcrossEveryStatus() {
        let usable: [LicenseStatus] = [.ok, .grace]
        let notUsable: [LicenseStatus] = [
            .expired, .revoked, .needsEnroll, .versionTooOld, .versionTooNew, .channelNotEntitled,
        ]
        for s in usable { XCTAssertTrue(isUsable(s), "\(s) should be usable") }
        for s in notUsable { XCTAssertFalse(isUsable(s), "\(s) should NOT be usable") }
    }

    // ── verifyDoc anti-replay on the multi-trust corpus vector ───────────────────
    private func loadCase(_ id: String) throws -> CorpusCase {
        guard let url = Bundle.module.url(forResource: "cases", withExtension: "json") else {
            throw NSError(domain: "corpus", code: 1)
        }
        let corpus = try JSONDecoder().decode(Corpus.self, from: Data(contentsOf: url))
        guard let c = corpus.cases.first(where: { $0.id == id }) else {
            throw NSError(domain: "corpus", code: 2)
        }
        return c
    }

    func testVerifyDocAntiReplayOnSecondKeyVector() throws {
        let c = try loadCase("valid-second-key-multi-trust")
        guard let doc = c.expect.doc else { return XCTFail("missing doc") }

        // Correct aud + device + a fresh issuedAt passes.
        XCTAssertNotNil(
            verifyDoc(
                c.jws,
                options: VerifyDocOptions(
                    trust: c.trust, expectedAud: "djdl", deviceId: doc.deviceId,
                    lastAcceptedIssuedAt: doc.issuedAt - 1)))
        // Replay (issuedAt == last accepted) is rejected.
        XCTAssertNil(
            verifyDoc(
                c.jws,
                options: VerifyDocOptions(
                    trust: c.trust, expectedAud: "djdl", deviceId: doc.deviceId,
                    lastAcceptedIssuedAt: doc.issuedAt)))
        // Wrong audience rejected.
        XCTAssertNil(
            verifyDoc(
                c.jws,
                options: VerifyDocOptions(trust: c.trust, expectedAud: "other", deviceId: doc.deviceId)))
        // Wrong device rejected.
        XCTAssertNil(
            verifyDoc(
                c.jws,
                options: VerifyDocOptions(trust: c.trust, expectedAud: "djdl", deviceId: "nope")))
    }
}
