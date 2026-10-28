// @pkey-feature ui.signin
// The v7 additions that the matrix rows cannot say alone: the refusal's primary is a sign-in, and
// NearbyApproval is hidden without Identity.

import PolarisKeyUICore
import XCTest

final class NearbyApprovalTests: XCTestCase {
    func testAKeyRefusalsPrimaryIsSigningIn() {
        var i = KitInputs(platform: KitPlatform(os: .ios, formFactor: .iphone))
        i.keyField = KitKeyField(text: "pkey_tidewater_Q2xvdWRzT3ZlclRoZUhpbG", submitted: true)
        i.activation = KitActivation(result: "refused", code: "license_owned")
        let s = KitStates.activate(i)
        XCTAssertEqual(s.state, .licenseOwned)
        XCTAssertTrue(s.offers(.startSignIn))
        XCTAssertFalse(s.shows("part.keyField.label"))
    }

    func testAppleIsPerDeveloperEvenWhenReachIsGlobal() {
        var i = KitInputs()
        i.provider = "Apple"
        i.autoSignIn = KitAutoSignIn(step: .linkOffer, reach: .global)
        let s = KitStates.signIn(i)
        XCTAssertTrue(s.shows("signin.linkOffer.bodyApp"))
        XCTAssertFalse(s.shows("signin.linkOffer.bodyGlobal"))
    }

    @MainActor func testTheModelFollowsItsStep() {
        let model = NearbyApprovalModel()
        XCTAssertEqual(model.screen.state, .entry)
        model.show(.ask, device: "Kitchen iPad")
        XCTAssertEqual(model.screen.state, .ask)
        XCTAssertTrue(model.screen.shows("signin.approve.deny"))
        model.show(.approved, device: "Kitchen iPad")
        XCTAssertEqual(model.screen.state, .approved)
    }

    func testHiddenWithoutIdentity() {
        var i = KitInputs()
        i.services = [.license]
        XCTAssertTrue(KitStates.nearbyApproval(i).isHidden)
    }
}
