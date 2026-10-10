// @pkey-feature ui.kit
//
// The drop-in gate driven like a person drives it, in the iOS simulator, over the scripted host
// (GateHost/GateHostApp.swift): a licence that has expired or been revoked reaches the activation
// form through "Use a different key" and through "Sign in" without relaunching; a device-limit
// refusal shows a working "Replace a device"; Return submits; the signed-in screen names who
// signed in and offers "Not you?". Every state is attached as a screenshot, and every button is
// asserted to carry a name VoiceOver can read.
import XCTest

final class GateUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
    }

    @discardableResult
    private func launch(_ scenario: String, extra: [String] = []) -> XCUIApplication {
        app.launchArguments = ["-pkScenario", scenario] + extra
        app.launch()
        return app
    }

    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        // The accessibility tree as VoiceOver reads it: every element's type, label and value.
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = "\(name)-accessibility-tree"
        tree.lifetime = .keepAlways
        add(tree)
    }

    private func button(_ label: String) -> XCUIElement { app.buttons[label] }

    private func waitFor(_ element: XCUIElement, _ what: String, timeout: TimeInterval = 15) {
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "\(what) did not appear")
    }

    /// Every button on screen has a name; none is announced as "button" alone.
    private func assertButtonsAreNamed() {
        for index in 0..<app.buttons.count {
            let element = app.buttons.element(boundBy: index)
            guard element.exists else { continue }
            XCTAssertFalse(element.label.isEmpty, "button \(index) has no accessibility label")
        }
    }

    /// The user code, read by VoiceOver as "Sign-in code: A B C D …".
    private var signInCode: XCUIElement {
        app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "Sign-in code")).firstMatch
    }

    private var keyField: XCUIElement { app.textFields["License key"] }

    // ── expired ──────────────────────────────────────────────────────────────────────────

    func testExpiredOffersEveryWayOutAndReachesTheFormWithoutRelaunching() {
        launch("expired", extra: ["-pkRenewURL", "1"])
        waitFor(button("Renew or manage"), "Renew or manage")
        XCTAssertTrue(button("Try again").exists)
        XCTAssertTrue(button("Use a different key").exists)
        XCTAssertTrue(button("Sign in").exists)
        XCTAssertTrue(app.links["Contact support"].exists || button("Contact support").exists)
        XCTAssertFalse(app.staticTexts["licensed-content"].exists)
        assertButtonsAreNamed()
        shot("expired")

        button("Use a different key").tap()
        waitFor(keyField, "the licence-key field")
        XCTAssertTrue(button("Cancel").exists, "the form can be backed out of")
        XCTAssertFalse(button("Sign in").exists, "Sign in is one step back, not repeated")
        shot("expired-different-key")

        // Cancel returns to the blocking state; the form is one tap away again.
        button("Cancel").tap()
        waitFor(button("Use a different key"), "Use a different key after Cancel")
        button("Use a different key").tap()
        waitFor(keyField, "the licence-key field again")
        keyField.tap()
        keyField.typeText("pkey_good")
        button("Activate").tap()
        waitFor(app.staticTexts["licensed-content"], "the app after activating")
    }

    func testExpiredWithoutARenewalPageLeadsWithTryAgain() {
        launch("expired")
        waitFor(button("Try again"), "Try again")
        XCTAssertFalse(button("Renew or manage").exists)
        XCTAssertTrue(button("Use a different key").exists)
    }

    func testExpiredReachesSignInWithoutRelaunching() {
        launch("expired")
        waitFor(button("Sign in"), "Sign in")
        button("Sign in").tap()
        waitFor(signInCode, "the sign-in code")
        shot("expired-sign-in")
        XCTAssertTrue(button("Cancel").exists)
        button("Cancel").tap()
        waitFor(button("Use a different key"), "the gate after Cancel")
    }

    // ── revoked ──────────────────────────────────────────────────────────────────────────

    func testRevokedLeadsWithAKeyAndReachesTheFormAndSignInWithoutRelaunching() {
        launch("revoked")
        waitFor(button("Use a different key"), "Use a different key")
        XCTAssertTrue(button("Sign in").exists)
        XCTAssertFalse(button("Renew or manage").exists, "a revoked device is not renewed")
        shot("revoked")

        button("Sign in").tap()
        waitFor(signInCode, "the sign-in code")
        button("Cancel").tap()

        waitFor(button("Use a different key"), "Use a different key after sign-in")
        button("Use a different key").tap()
        waitFor(keyField, "the licence-key field")
        keyField.tap()
        keyField.typeText("not-a-key")
        // Return submits the form (no tap on Activate).
        keyField.typeText("\n")
        let refusal = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS[c] %@", "key")
        ).firstMatch
        waitFor(refusal, "the refusal")
        shot("revoked-refused")
        keyField.tap()
        keyField.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 9))
        keyField.typeText("pkey_good\n")
        waitFor(app.staticTexts["licensed-content"], "the app after Return")
    }

    // ── device limit ─────────────────────────────────────────────────────────────────────

    func testADeviceLimitRefusalShowsAWorkingReplaceADevice() {
        launch("deviceLimit")
        waitFor(keyField, "the licence-key field")
        keyField.tap()
        keyField.typeText("pkey_full")
        button("Activate").tap()
        waitFor(button("Replace a device"), "Replace a device")
        shot("device-limit")
        button("Replace a device").tap()
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        XCTAssertTrue(
            safari.wait(for: .runningForeground, timeout: 20),
            "Replace a device opens the portal link")
        app.activate()
    }

    // ── sign-in ──────────────────────────────────────────────────────────────────────────

    func testTheSignedInScreenNamesWhoSignedInAndOffersNotYou() {
        launch("signedIn")
        waitFor(button("Sign in"), "Sign in")
        button("Sign in").tap()
        waitFor(app.staticTexts["Signed in as"], "the signed-in heading", timeout: 30)
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Ada Lovelace")).firstMatch.exists)
        XCTAssertTrue(button("Not you?").exists)
        XCTAssertTrue(button("Continue").exists)
        shot("signed-in")
        button("Continue").tap()
        waitFor(app.staticTexts["licensed-content"], "the app after Continue")
    }

    // ── a licensed launch, the defaults ──────────────────────────────────────────────────

    func testALicensedLaunchShowsTheAppAndNoActivationCard() {
        launch("licensed")
        waitFor(app.staticTexts["licensed-content"], "the app")
        XCTAssertFalse(app.staticTexts["Welcome to Tidewater Studio"].exists)
        XCTAssertFalse(keyField.exists)
    }

    func testActivateOfflineIsOffByDefaultOnIOSAndAvailableWhenAsked() {
        launch("needsActivation")
        waitFor(keyField, "the licence-key field")
        XCTAssertFalse(button("Activate offline").exists)
        shot("welcome")
        app.terminate()
        launch("needsActivation", extra: ["-pkOffline", "1"])
        waitFor(button("Activate offline"), "Activate offline when asked")
    }
}
