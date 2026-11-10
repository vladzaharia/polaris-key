// @pkey-feature license.gate
// Gate transition tests — wire contract v3 §5. The ordering of the checks (not-applicable →
// no-activation → blocked → revoked → no-doc → expired → grace → ok) is load-bearing, so each
// branch gets a case that could only pass with the right precedence.
//
// The v2 suite's cases are all carried; what is added is the two guards v3 introduced and the
// one ordering it changed.

import Foundation
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

    /// No activation wins over a cached document: the gate-matrix rows pin the same device with no
    /// document, not with one.
    func testNoActivationIgnoresACachedDocument() {
        let doc = makeDoc(issuedAt: 100, expiresAt: 200, graceUntil: 300)
        XCTAssertEqual(gate(activation: nil, doc: doc, now: 150).status, .needsActivation)
    }

    // ── The carried v2 ladder ───────────────────────────────────────────────────────
    func testUnauthorizedIsRevoked() {
        XCTAssertEqual(gate(now: 1000, lastSyncUnauthorized: true).status, .revoked)
        // …but no activation still wins over a lingering unauthorized flag.
        XCTAssertEqual(
            gate(activation: nil, now: 1000, lastSyncUnauthorized: true).status,
            .needsActivation)
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

    /// The decode edge, from the one side Swift can express it.
    ///
    /// `BlockReason` is a closed `String` enum, so the out-of-vocabulary value that would license a
    /// client that returns the hint's reason as the status (`{"v":3,"blocked":{"reason":"ok"}}` on
    /// disk, no document and no signature anywhere) is UNREPRESENTABLE here. What Swift owns is the
    /// decode, and the failure mode to avoid is too harsh rather than too lax: a throwing decode
    /// would discard the WHOLE verified cache record over a poisoned two-field hint. It drops just
    /// the hint, which is what the other SDKs do.
    func testAPoisonedBlockedReasonDropsTheHintNotTheWholeRecord() throws {
        let poisoned = Data(
            #"{"v":\#(CACHE_RECORD_VERSION),"trustJws":"a.b.c","blocked":{"reason":"ok"}}"#.utf8)
        let record = try JSONDecoder().decode(CacheRecord.self, from: poisoned)
        XCTAssertNil(record.blocked, "an unknown reason is not a hint")
        XCTAssertEqual(record.trustJws, "a.b.c", "the rest of the record survives")

        // …and an IN-vocabulary reason still round-trips, so the drop is a narrowing rather than
        // a deletion.
        let kept = try JSONDecoder().decode(
            CacheRecord.self,
            from: Data(
                #"{"v":\#(CACHE_RECORD_VERSION),"blocked":{"reason":"version-too-new"}}"#.utf8))
        XCTAssertEqual(kept.blocked?.reason, .versionTooNew)
    }

    /// The gate half: every reason it CAN hold is a non-usable status, so a hint can only ever
    /// tighten. The corpus's gate-matrix rows drive the same assertion through every SDK's gate
    /// against a value none of them may honour.
    func testEveryRepresentableBlockReasonIsNonUsable() {
        XCTAssertEqual(BlockReason.allCases.count, 3)
        for reason in BlockReason.allCases {
            let state = gate(now: 1, blocked: BlockInfo(reason: reason))
            XCTAssertFalse(isUsable(state), "reason \(reason) must never be usable")
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
