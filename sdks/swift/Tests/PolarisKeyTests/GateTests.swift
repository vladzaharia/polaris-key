// Gate state-machine tests — mirrors sdk-node's gate transitions. The ordering of the
// checks (blocked → no-token → revoked → no-doc → expired → grace → ok) is load-bearing,
// so each branch gets a case that could only pass with the right precedence.

import XCTest

@testable import PolarisKey

final class GateTests: XCTestCase {
    private func makeDoc(issuedAt: Int, expiresAt: Int, graceUntil: Int) -> ManagedConfigDoc {
        ManagedConfigDoc(
            schemaVersion: 1, aud: "djdl", iss: POLARIS_ISSUER,
            licenseId: "lic_x", deviceId: "dev_x",
            issuedAt: issuedAt, expiresAt: expiresAt, graceUntil: graceUntil,
            profile: DocProfile(
                name: "T", firstName: "T", email: "t@example.com", enrolledAt: 0),
            payload: ManagedPayload())
    }

    func testNoTokenIsNeedsEnroll() {
        let s = licenseState(GateInput(hasToken: false, doc: nil, now: 1000))
        XCTAssertEqual(s.status, .needsEnroll)
    }

    func testTokenButNoDocIsNeedsEnroll() {
        let s = licenseState(GateInput(hasToken: true, doc: nil, now: 1000))
        XCTAssertEqual(s.status, .needsEnroll)
    }

    func testUnauthorizedIsRevoked() {
        let s = licenseState(
            GateInput(hasToken: true, doc: nil, now: 1000, lastSyncUnauthorized: true))
        XCTAssertEqual(s.status, .revoked)
    }

    func testBlockedTakesPrecedenceOverEverything() {
        let s = licenseState(
            GateInput(
                hasToken: false, doc: nil, now: 1000,
                blocked: BlockInfo(
                    reason: .versionTooOld, allowedRange: AllowedRange(min: "1.0.0"))))
        XCTAssertEqual(s.status, .versionTooOld)
        XCTAssertEqual(s.allowedRange?.min, "1.0.0")
    }

    func testBlockedChannelMapping() {
        let s = licenseState(
            GateInput(
                hasToken: true, doc: nil, now: 1000,
                blocked: BlockInfo(reason: .channelNotEntitled)))
        XCTAssertEqual(s.status, .channelNotEntitled)
    }

    func testWithinWindowIsOk() {
        let doc = makeDoc(issuedAt: 100, expiresAt: 200, graceUntil: 300)
        let s = licenseState(GateInput(hasToken: true, doc: doc, now: 150))
        XCTAssertEqual(s.status, .ok)
        XCTAssertEqual(s.graceUntil, 300)
    }

    func testPastExpiryWithinGraceIsGrace() {
        let doc = makeDoc(issuedAt: 100, expiresAt: 200, graceUntil: 300)
        let s = licenseState(GateInput(hasToken: true, doc: doc, now: 250))
        XCTAssertEqual(s.status, .grace)
        XCTAssertEqual(s.graceUntil, 300)
    }

    func testPastGraceIsExpired() {
        let doc = makeDoc(issuedAt: 100, expiresAt: 200, graceUntil: 300)
        let s = licenseState(GateInput(hasToken: true, doc: doc, now: 350))
        XCTAssertEqual(s.status, .expired)
        XCTAssertEqual(s.graceUntil, 300)
    }

    func testExactBoundaryAtExpiryIsStillOk() {
        // now > expiresAt is the grace trigger, so now == expiresAt stays ok.
        let doc = makeDoc(issuedAt: 100, expiresAt: 200, graceUntil: 300)
        XCTAssertEqual(licenseState(GateInput(hasToken: true, doc: doc, now: 200)).status, .ok)
    }

    func testExactBoundaryAtGraceIsStillGrace() {
        // now > graceUntil is the expired trigger, so now == graceUntil stays grace.
        let doc = makeDoc(issuedAt: 100, expiresAt: 200, graceUntil: 300)
        XCTAssertEqual(licenseState(GateInput(hasToken: true, doc: doc, now: 300)).status, .grace)
    }

    func testIsUsable() {
        XCTAssertTrue(isUsable(.ok))
        XCTAssertTrue(isUsable(.grace))
        XCTAssertFalse(isUsable(.expired))
        XCTAssertFalse(isUsable(.revoked))
        XCTAssertFalse(isUsable(.needsEnroll))
        XCTAssertFalse(isUsable(.versionTooOld))
    }

    // Semver/channel — pinned by the corpus so all SDKs agree.
    func testChannelForVersion() {
        XCTAssertEqual(Semver.channelForVersion("1.2.3"), .stable)
        XCTAssertEqual(Semver.channelForVersion("0.0.0-dev+abc"), .dev)
        XCTAssertEqual(Semver.channelForVersion("0.0.0-staging.1"), .staging)
        XCTAssertEqual(Semver.channelForVersion("0.0.0-pr42"), .pr)
    }

    func testSemverCompare() {
        XCTAssertEqual(Semver.compare("1.0.0", "1.0.1"), -1)
        XCTAssertEqual(Semver.compare("1.2.0", "1.1.9"), 1)
        XCTAssertEqual(Semver.compare("1.0.0", "1.0.0"), 0)
        // Prerelease sorts before its release.
        XCTAssertEqual(Semver.compare("1.0.0-rc.1", "1.0.0"), -1)
        XCTAssertEqual(Semver.compare("1.0.0-alpha", "1.0.0-beta"), -1)
        XCTAssertEqual(Semver.compare("1.0.0-1", "1.0.0-2"), -1)
        // Unparseable compares equal.
        XCTAssertEqual(Semver.compare("not-a-version", "1.0.0"), 0)
    }
}
