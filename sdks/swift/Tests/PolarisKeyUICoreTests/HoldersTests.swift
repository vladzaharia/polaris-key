// @pkey-feature ui.signin ui.settings
//
// The holders core (UK-43.3): the maskEmail vectors of ui-matrix.json `holdersFlow`, the lead runs of
// a reason line, and the reasons each service set gives. The rows themselves run in
// UIMatrixTests.testHoldersFamily.

import PolarisKeyUICore
import XCTest

final class HoldersTests: XCTestCase {
    func testMaskEmailVectors() throws {
        let flow = try XCTUnwrap(UIMatrix.load().raw["holdersFlow"] as? [String: Any])
        let vectors = try XCTUnwrap(flow["maskEmail"] as? [[String: Any]])
        XCTAssertFalse(vectors.isEmpty)
        for vector in vectors {
            let email = vector["email"] as? String
            XCTAssertEqual(
                KitFormat.maskEmail(email), vector["masked"] as? String, "\(email ?? "nil")")
        }
    }

    func testLeadPartsSplitOnTheMarkers() {
        XCTAssertEqual(
            KitFormat.leadParts("**Cloud Sync**: saves follow you"),
            [
                KitLeadRun(text: "Cloud Sync", strong: true),
                KitLeadRun(text: ": saves follow you", strong: false),
            ])
        XCTAssertEqual(KitFormat.leadParts("plain"), [KitLeadRun(text: "plain", strong: false)])
        XCTAssertEqual(KitFormat.leadParts(""), [])
        // An unclosed marker leaves its tail strong, as ui-core's leadParts does.
        XCTAssertEqual(
            KitFormat.leadParts("a **b"),
            [KitLeadRun(text: "a ", strong: false), KitLeadRun(text: "b", strong: true)])
    }

    func testReasonsFollowIdentityAndSync() {
        XCTAssertEqual(
            KitStates.recommendReasons(identity: false, sync: true),
            ["activate.recommend.portal"])
        XCTAssertEqual(
            KitStates.recommendReasons(identity: true, sync: false),
            ["activate.recommend.recover", "activate.recommend.devices"])
        XCTAssertEqual(
            KitStates.recommendReasons(identity: true, sync: true).first,
            "activate.recommend.sync")
    }

    func testTheFloatingActionIsTheOnlyAddControl() {
        var inputs = KitInputs()
        inputs.activateDone = KitActivateDone(tier: "Pro", term: "Lifetime")
        let app = KitStates.activateDone(inputs)
        XCTAssertTrue(app.shows("activate.recommend.action"))
        XCTAssertFalse(app.shows("signin.key.addInLocker"))
        inputs.licenseHolder = KitLicenseHolder(email: "", addIn: .portal)
        let portal = KitStates.activateDone(inputs)
        XCTAssertTrue(portal.shows("signin.key.addInLocker") && portal.shows("a11y.externalLink"))
        XCTAssertEqual(portal.actions, [.openManageURL])
    }

    func testAMalformedHolderEmailCountsAsNone() {
        var inputs = KitInputs()
        inputs.activateDone = KitActivateDone()
        inputs.licenseHolder = KitLicenseHolder(email: "not-an-email")
        XCTAssertEqual(KitStates.activateDone(inputs).stateName, "ready")
    }

    func testAHolderEmailWithIdentityOffIsReadyWithThePortalLine() {
        var inputs = KitInputs()
        inputs.services = [.license]
        inputs.activateDone = KitActivateDone()
        inputs.licenseHolder = KitLicenseHolder(email: "ada@example.com")
        let screen = KitStates.activateDone(inputs)
        XCTAssertEqual(screen.stateName, "ready")
        XCTAssertTrue(screen.shows("signin.key.addInLocker") && screen.shows("a11y.externalLink"))
        XCTAssertFalse(screen.shows("activate.waiting"))
        XCTAssertFalse(screen.shows("activate.waitingSignIn"))
        inputs.services = nil
        XCTAssertEqual(KitStates.activateDone(inputs).stateName, "waiting")
    }
}
