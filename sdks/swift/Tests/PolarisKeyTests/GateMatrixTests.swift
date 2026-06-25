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

    // ── Cross-SDK gate-matrix parity (shared conformance/corpus/v1/gate-matrix.json) ──
    // Drives the SAME fixture the Node/React/Python suites run through the Swift gate, so
    // the four matrices can't silently diverge. Each row's build-gate half is reduced to a
    // `BlockInfo` via the port below (mirroring the Worker's `checkBuildGate`, rebuilt from
    // `Semver.*`), then fed with the license half into `licenseState`; the resulting
    // status / ok / reason / allowedRange must match the fixture exactly.
    private struct GateMatrix: Decodable {
        let gateMatrixVersion: Int
        let rows: [Row]
    }
    private struct Row: Decodable {
        let name: String
        let gate: GateInputs
        let license: LicenseInputs
        let expect: ExpectDecision
    }
    private struct GateInputs: Decodable {
        let version: String
        let channel: String?
        let compatMin: String
        let compatMax: String
        let entitlements: [String: ManagedEntry]
    }
    private struct LicenseInputs: Decodable {
        let hasToken: Bool
        let now: Int
        let issuedAt: Int?
        let expiresAt: Int?
        let graceUntil: Int?
        let lastSyncUnauthorized: Bool?
        let lastVerifiedAt: Int?
    }
    private struct ExpectDecision: Decodable {
        let status: String
        let ok: Bool
        let reason: BlockReason?
        let allowedRange: AllowedRange?
    }

    private func loadMatrix() throws -> GateMatrix {
        guard let url = Bundle.module.url(forResource: "gate-matrix", withExtension: "json") else {
            throw NSError(domain: "gate-matrix", code: 1)
        }
        return try JSONDecoder().decode(GateMatrix.self, from: Data(contentsOf: url))
    }

    private func strEnt(_ e: ManagedEntry?) -> String? { e?.value.stringValue }
    private func arrEnt(_ e: ManagedEntry?) -> [String]? {
        e?.value.arrayValue?.compactMap { $0.stringValue }
    }
    private func tighterMin(_ a: String?, _ b: String?) -> String? {
        guard let a else { return b }
        guard let b else { return a }
        return Semver.compare(a, b) >= 0 ? a : b
    }
    private func tighterMax(_ a: String?, _ b: String?) -> String? {
        guard let a else { return b }
        guard let b else { return a }
        return Semver.compare(a, b) <= 0 ? a : b
    }
    private func normalizeChannel(_ header: String) -> Channel {
        if header == "staging" { return .staging }
        if header == "pr" || header.hasPrefix("pr") { return .pr }
        if header == "dev" { return .dev }
        return .stable
    }

    /// Port of the Worker's `checkBuildGate` over `Semver.*` — the surface every SDK keeps
    /// in lockstep, with the fixture as the oracle.
    private func checkBuildGate(_ g: GateInputs) -> BlockInfo? {
        if Semver.isDevBuild(g.version) { return nil }
        let minV = tighterMin(g.compatMin, strEnt(g.entitlements["app.minVersion"]))
        let maxV = tighterMax(g.compatMax, strEnt(g.entitlements["app.maxVersion"]))
        let range = AllowedRange(min: minV, max: maxV)
        if let minV, Semver.compare(g.version, minV) < 0 {
            return BlockInfo(reason: .versionTooOld, allowedRange: range)
        }
        if let maxV, Semver.compare(g.version, maxV) > 0 {
            return BlockInfo(reason: .versionTooNew, allowedRange: range)
        }
        let channel = normalizeChannel(g.channel ?? Semver.channelForVersion(g.version).rawValue)
        if channel != .stable && channel != .dev {
            let granted = arrEnt(g.entitlements["channels"]) ?? ["stable"]
            if !granted.contains(channel.rawValue) {
                return BlockInfo(reason: .channelNotEntitled)
            }
        }
        return nil
    }

    private func buildDoc(_ l: LicenseInputs) -> ManagedConfigDoc? {
        guard let issuedAt = l.issuedAt, let expiresAt = l.expiresAt, let graceUntil = l.graceUntil
        else { return nil }
        return ManagedConfigDoc(
            schemaVersion: 1, aud: "djdl", iss: POLARIS_ISSUER,
            licenseId: "lic_matrix", deviceId: "dev_matrix",
            issuedAt: issuedAt, expiresAt: expiresAt, graceUntil: graceUntil,
            profile: DocProfile(name: "M", firstName: "M", email: "m@x.y", enrolledAt: 0),
            payload: ManagedPayload())
    }

    func testGateMatrixHasRows() throws {
        XCTAssertGreaterThan(try loadMatrix().rows.count, 0)
    }

    func testGateMatrixParityAcrossEveryRow() throws {
        for row in try loadMatrix().rows {
            let blocked = checkBuildGate(row.gate)
            let state = licenseState(
                GateInput(
                    hasToken: row.license.hasToken,
                    doc: buildDoc(row.license),
                    now: row.license.now,
                    lastSyncUnauthorized: row.license.lastSyncUnauthorized ?? false,
                    blocked: blocked,
                    lastVerifiedAt: row.license.lastVerifiedAt))

            XCTAssertEqual(state.status.rawValue, row.expect.status, row.name)
            XCTAssertEqual(isUsable(state.status), row.expect.ok, "\(row.name) usable")
            if let reason = row.expect.reason {
                XCTAssertEqual(blocked?.reason, reason, "\(row.name) reason")
            }
            if let range = row.expect.allowedRange {
                XCTAssertEqual(state.allowedRange, range, "\(row.name) allowedRange")
            } else {
                XCTAssertNil(state.allowedRange, "\(row.name) no allowedRange")
            }
        }
    }
}
