// @pkey-feature ui.signin
//
// I-44.6: the confirm step's license line carries the arguments the consent view gave (license,
// term, device, position, limit). A view draws a line missing any of them not at all, which is
// how the matrix's bare `existing` row loses it; a real consent view must not.

import XCTest

@testable import PolarisKeyUICore

final class AutoSignInConsentTests: XCTestCase {
    private func confirm(_ auto: KitAutoSignIn) -> KitScreen<SignInState> {
        var inputs = KitInputs()
        inputs.provider = "Apple"
        inputs.autoSignIn = auto
        return KitStates.signIn(inputs)
    }

    func testTheLicenseLineIsCompleteWithTheViewsSeat() throws {
        let screen = confirm(
            KitAutoSignIn(
                step: .confirm, license: "existing", licenseName: "Pro", term: 1_900_000_000,
                device: "Mara's Mac", position: 2, limit: 3))
        let line = try XCTUnwrap(screen.line("signin.consent.licenseLine"))
        XCTAssertTrue(line.isComplete())
        let text = KitCopy.bundled.format(line, locale: "en")
        XCTAssertTrue(text.hasPrefix("Pro · Until "), text)
        XCTAssertTrue(text.hasSuffix("Mara's Mac becomes device 2 of 3"), text)
    }

    func testAPerpetualLicenseReadsLifetime() throws {
        let screen = confirm(
            KitAutoSignIn(
                step: .confirm, license: "existing", licenseName: "Pro", position: 1, limit: 1))
        let text = KitCopy.bundled.format(
            try XCTUnwrap(screen.line("signin.consent.licenseLine")), locale: "en")
        XCTAssertTrue(text.hasPrefix("Pro · Lifetime · "), text)
    }

    func testAnUnnamedDeviceReadsLowerCaseMidLine() throws {
        let screen = confirm(
            KitAutoSignIn(
                step: .confirm, license: "existing", licenseName: "Pro", position: 2, limit: 3))
        let text = KitCopy.bundled.format(
            try XCTUnwrap(screen.line("signin.consent.licenseLine")), locale: "en")
        XCTAssertTrue(text.contains(" · this "), text)
        XCTAssertFalse(text.contains(" · This "), text)
    }

    func testANamedLicenseWithNoSeatLeavesTheLineOut() {
        let screen = confirm(
            KitAutoSignIn(step: .confirm, license: "existing", licenseName: "Pro"))
        XCTAssertNil(screen.line("signin.consent.licenseLine"))
        XCTAssertNotNil(screen.line("signin.consent.license"))
    }

    func testTheMatrixRowsAreUnchanged() {
        let screen = confirm(KitAutoSignIn(step: .confirm, license: "existing"))
        XCTAssertNotNil(screen.line("signin.consent.licenseLine"))
    }

    func testTheAppleConfirmFixtureCarriesALicenseLineAndConsentLines() throws {
        let preview = try XCTUnwrap(
            PolarisKeyPreviewState.all.first { $0.id == "SignIn.confirm.apple" })
        let screen = KitStates.signIn(preview.inputs)
        XCTAssertTrue(try XCTUnwrap(screen.line("signin.consent.licenseLine")).isComplete())
        for key in ["signin.consent.alsoGets", "signin.consent.profile", "signin.consent.pairwise"] {
            XCTAssertNotNil(screen.line(key), key)
        }
        XCTAssertNotNil(screen.line("signin.auto.confirm.asApple"))
    }

    func testTheDeviceLimitFixturesCoverNoLinkAndAFullRowThatAllowsReplace() throws {
        let ids = Set(PolarisKeyPreviewState.all.map(\.id))
        XCTAssertTrue(
            ids.isSuperset(of: ["SignIn.device-limit", "SignIn.device-limit.no-link", "SignIn.choose.device-limit"]))
        let rows = try XCTUnwrap(
            PolarisKeyPreviewState.all.first { $0.id == "SignIn.choose.device-limit" })
        XCTAssertTrue(
            rows.inputs.choices?.choices.contains { $0.isFull && $0.replace?.allowed == true } == true)
        let noLink = try XCTUnwrap(
            PolarisKeyPreviewState.all.first { $0.id == "SignIn.device-limit.no-link" })
        let screen = KitStates.signIn(noLink.inputs)
        XCTAssertNotNil(screen.line("deviceLimit.noManage"))
        XCTAssertNil(screen.line("signin.deviceLimit.replace"))
    }
}
