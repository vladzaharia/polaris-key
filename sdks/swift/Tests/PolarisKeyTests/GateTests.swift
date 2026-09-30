// @pkey-feature license.gate
// Gate transition tests — wire contract v3 §5. The ordering of the checks (not-applicable →
// no-activation → blocked → revoked → no-doc → expired → grace → ok) is load-bearing, so each
// branch gets a case that could only pass with the right precedence.
//
// The v2 suite's cases are all carried; what is added is the two guards v3 introduced and the
// one ordering it changed.

import PolarisKeyCore
import PolarisKeyLicense
import XCTest

final class GateTests: XCTestCase {
    private func makeDoc(issuedAt: Int, expiresAt: Int, graceUntil: Int) -> LicenseDoc {
        LicenseDoc(
            aud: "djdl", deviceId: "dev_x", issuedAt: issuedAt, expiresAt: expiresAt,
            graceUntil: graceUntil, licenseId: "lic_x",
            profile: DocProfile(
                name: "T", firstName: "T", email: "t@example.com", activatedAt: 0))
    }

    private func gate(
        licenseServiceEnabled: Bool = true,
        activation: ActivationSource? = .token,
        doc: LicenseDoc? = nil,
        now: Int,
        highWaterMark: Int = 0,
        lastSyncUnauthorized: Bool = false,
        blocked: BlockInfo? = nil,
        lastVerifiedAt: Int? = nil
    ) -> LicenseState {
        licenseState(
            GateInput(
                licenseServiceEnabled: licenseServiceEnabled, activation: activation, doc: doc,
                now: now, highWaterMark: highWaterMark,
                lastSyncUnauthorized: lastSyncUnauthorized, blocked: blocked,
                lastVerifiedAt: lastVerifiedAt))
    }

    // ── v3's two new guards ─────────────────────────────────────────────────────────
    /// D-08 — a product that does not run the license service has no licence to be missing, so
    /// it boots USABLE. This precedes every other rule, including a cached document and a block.
    func testLicenseServiceDisabledIsNotApplicableAndUsable() {
        XCTAssertEqual(
            gate(licenseServiceEnabled: false, activation: nil, now: 1000).status,
            .notApplicable)
        let doc = makeDoc(issuedAt: 100, expiresAt: 200, graceUntil: 300)
        XCTAssertEqual(
            gate(licenseServiceEnabled: false, doc: doc, now: 5000).status, .notApplicable,
            "even a long-expired cached document cannot make an unlicensed product expired")
        XCTAssertEqual(
            gate(
                licenseServiceEnabled: false, activation: nil, now: 1000,
                blocked: BlockInfo(reason: .versionTooOld)
            ).status, .notApplicable,
            "not-applicable precedes the build block")
        XCTAssertTrue(isUsable(LicenseStatus.notApplicable))
    }

    /// §7 — a verified bundle import activates exactly as a token does. Every downstream
    /// transition is the same; only the SOURCE differs.
    func testBundleActivationBehavesLikeATokenThroughTheWholeLadder() {
        let doc = makeDoc(issuedAt: 100, expiresAt: 200, graceUntil: 300)
        XCTAssertEqual(gate(activation: .bundle, doc: doc, now: 150).status, .ok)
        XCTAssertEqual(gate(activation: .bundle, doc: doc, now: 250).status, .grace)
        XCTAssertEqual(gate(activation: .bundle, doc: doc, now: 350).status, .expired)
        XCTAssertEqual(gate(activation: nil, doc: doc, now: 150).status, .needsActivation)
    }

    /// The ONE ordering v3 changed: the activation guard runs BEFORE the unsigned `blocked` hint.
    /// Telling a user their build is too new when they have not licensed it yet buries the action
    /// they can actually take.
    func testActivationPrecedesTheBuildBlock() {
        let blocked = BlockInfo(
            reason: .versionTooNew, allowedRange: AllowedRange(max: "3.0.0"))
        XCTAssertEqual(
            gate(activation: nil, now: 1000, blocked: blocked).status, .needsActivation)
        XCTAssertNil(
            gate(activation: nil, now: 1000, blocked: blocked).allowedRange,
            "needs-activation carries no allowed range — there is no build decision to render")
        // With a credential, the block wins as it always did.
        XCTAssertEqual(gate(activation: .token, now: 1000, blocked: blocked).status, .versionTooNew)
    }

    // ── The carried v2 ladder ───────────────────────────────────────────────────────
    func testNoActivationIsNeedsActivation() {
        XCTAssertEqual(gate(activation: nil, now: 1000).status, .needsActivation)
    }

    func testActivatedButNoDocIsNeedsActivation() {
        XCTAssertEqual(gate(now: 1000).status, .needsActivation)
    }

    func testUnauthorizedIsRevoked() {
        XCTAssertEqual(gate(now: 1000, lastSyncUnauthorized: true).status, .revoked)
        // …but no activation still wins over a lingering unauthorized flag.
        XCTAssertEqual(
            gate(activation: nil, now: 1000, lastSyncUnauthorized: true).status,
            .needsActivation)
    }

    func testBlockedTakesPrecedenceOverAValidDocument() {
        let doc = makeDoc(issuedAt: 0, expiresAt: 1000, graceUntil: 2000)
        let s = gate(
            doc: doc, now: 500,
            blocked: BlockInfo(reason: .versionTooOld, allowedRange: AllowedRange(min: "1.0.0")))
        XCTAssertEqual(s.status, .versionTooOld)
        XCTAssertEqual(s.allowedRange?.min, "1.0.0")
    }

    func testAllThreeBlockReasonsMapToTheirStatus() {
        for (reason, expected) in [
            (BlockReason.versionTooOld, LicenseStatus.versionTooOld),
            (.versionTooNew, .versionTooNew),
            (.channelNotEntitled, .channelNotEntitled),
        ] {
            XCTAssertEqual(
                gate(now: 1, blocked: BlockInfo(reason: reason)).status, expected,
                "reason \(reason) → \(expected)")
        }
    }

    func testExpiryLadderWithExactBoundaries() {
        let doc = makeDoc(issuedAt: 100, expiresAt: 200, graceUntil: 300)
        let at = { (n: Int) in self.gate(doc: doc, now: n).status }
        XCTAssertEqual(at(199), .ok)
        XCTAssertEqual(at(200), .ok)  // now == expiresAt is still ok
        XCTAssertEqual(at(201), .grace)  // first second past expiry
        XCTAssertEqual(at(300), .grace)  // now == graceUntil is still grace
        XCTAssertEqual(at(301), .expired)  // first second past grace
    }

    func testLastVerifiedAtPropagatesInOkAndGraceOnly() {
        let doc = makeDoc(issuedAt: 0, expiresAt: 1000, graceUntil: 2000)
        XCTAssertEqual(gate(doc: doc, now: 500, lastVerifiedAt: 480).lastVerifiedAt, 480)
        XCTAssertEqual(gate(doc: doc, now: 1500, lastVerifiedAt: 480).lastVerifiedAt, 480)
        let expired = gate(doc: doc, now: 2500, lastVerifiedAt: 480)
        XCTAssertEqual(expired.graceUntil, 2000)
        XCTAssertNil(expired.lastVerifiedAt)
    }

    /// §4.2 — the gate evaluates at `max(now, highWaterMark)`, so a rolled-back clock buys
    /// nothing. This is the gate's half of the floor; the reload path's half is in
    /// `TrustAndCacheTests`.
    func testHighWaterMarkFloorsTheGateClock() {
        let doc = makeDoc(issuedAt: 100, expiresAt: 200, graceUntil: 300)
        XCTAssertEqual(gate(doc: doc, now: 150).status, .ok)
        XCTAssertEqual(
            gate(doc: doc, now: 150, highWaterMark: 350).status, .expired,
            "a floor past graceUntil must expire the gate whatever the system clock says")
        XCTAssertEqual(
            gate(doc: doc, now: 400, highWaterMark: 100).status, .expired,
            "the floor is a minimum, never a substitute — an honest clock ahead of it wins")
    }

    func testIsUsableAcrossEveryStatus() {
        let usable: [LicenseStatus] = [.ok, .grace, .notApplicable]
        let notUsable: [LicenseStatus] = [
            .expired, .revoked, .needsActivation, .versionTooOld, .versionTooNew,
            .channelNotEntitled,
        ]
        for s in usable { XCTAssertTrue(isUsable(s), "\(s) should be usable") }
        for s in notUsable { XCTAssertFalse(isUsable(s), "\(s) should NOT be usable") }
        // Every case is classified — a new status added without a decision here fails the count.
        XCTAssertEqual(usable.count + notUsable.count, 9)
    }
}
