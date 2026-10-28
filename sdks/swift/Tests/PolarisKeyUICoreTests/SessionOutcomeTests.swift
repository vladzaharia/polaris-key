// @pkey-feature ui.kit.account ui.kit.keyentry
// I-10b.13: the session outcomes in the kit's vocabulary (UK-02b D3), the two refusals a
// well-formed key can meet (key-entry limit, license in another account) and the signed-in line.

import Foundation
import PolarisKeyCore
import PolarisKeyIdentity
import XCTest

@testable import PolarisKeyUICore

@MainActor
final class SessionOutcomeTests: XCTestCase {
    func testEverySessionOutcomeMapsIntoTheMatrixVocabulary() {
        XCTAssertEqual(PolarisKeyGateModel.kitOutcome(.pending), .pending)
        XCTAssertEqual(PolarisKeyGateModel.kitOutcome(.cancelled), .cancelled)
        XCTAssertEqual(PolarisKeyGateModel.kitOutcome(.expired), .expired)
    }

    func testKeyEntryLimitIsTheMatrixResultWithItsLink() {
        let a = PolarisKeyGateModel.kitActivation(
            .keyEntryLimit(manageUrl: "https://polaris.locker/m", keyEntries: nil))
        XCTAssertEqual(a.result, "key-entry-limit")
        XCTAssertEqual(a.manageUrl, "https://polaris.locker/m")
        var inputs = PolarisKeyPreviewState.base { $0.activation = a }
        inputs.keyField = KitKeyField(text: PolarisKeyPreviewState.key, submitted: true)
        let screen = KitStates.activate(inputs)
        XCTAssertEqual(screen.state, .rejected)
        XCTAssertTrue(screen.shows("core.activation.key-entry-limit.message"))
    }

    func testLicenseOwnedKeepsTheSignInLink() {
        let a = PolarisKeyGateModel.kitActivation(
            .licenseOwned(signInUrl: "https://polaris.locker/s"))
        XCTAssertEqual(a.result, "refused")
        XCTAssertEqual(a.code, "license_owned")
        XCTAssertEqual(a.signInUrl, "https://polaris.locker/s")
        var inputs = PolarisKeyPreviewState.base { $0.activation = a }
        inputs.keyField = KitKeyField(text: PolarisKeyPreviewState.key, submitted: true)
        let screen = KitStates.activate(inputs)
        XCTAssertEqual(screen.state, .rejected)
        XCTAssertTrue(screen.shows("core.codes.license_owned.message"))
    }

    func testSignedInLineCarriesNameAndTierAndKeepsTheMatrixKey() {
        let inputs = PolarisKeyPreviewState.base {
            $0.signIn = KitSignIn(outcome: .signedIn, issuedNow: false, name: "Mara", tier: "Pro")
        }
        let screen = KitStates.signIn(inputs)
        XCTAssertEqual(screen.state, .done)
        XCTAssertEqual(screen.copy.map(\.key), ["signin.desktop.toast"])
        XCTAssertEqual(screen.copy.first?.args["tier"], .text("Pro"))
        XCTAssertEqual(screen.copy.first?.args["name"], .text("Mara"))
    }

    func testLicenseChoicePreviewsReachTheStatesTheChoiceModelYields() {
        let ids = PolarisKeyPreviewState.all.map(\.id)
        for id in ["LicenseChoice.loading", "LicenseChoice.raced", "LicenseChoice.grant-expired"] {
            XCTAssertTrue(ids.contains(id), id)
        }
    }
}
