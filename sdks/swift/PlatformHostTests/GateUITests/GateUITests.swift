// @pkey-feature ui.kit
//
// The drop-in kit gate (`.polarisKey(client)` draws PolarisKeyGate) driven like a person drives it,
// in the iOS simulator, over the scripted host (GateHost/GateHostApp.swift). Copy and ids are the
// kit's own (packages/brand/kit-copy/en.json, conformance/parity/copy.en.json): Welcome, the key
// form, the Expired and Revoked status screens, the device-limit callout, the sign-in hand-off.
// Every state is attached as a screenshot and every button is asserted to carry a name VoiceOver
// can read.
//
// Dropped with the 0.8 gate (D-17), no counterpart in the kit gate:
//  - "Renew or manage" / -pkRenewURL: the kit's Expired screen offers "Use another license" and
//    never a renewal button the host can hang a page on.
//  - "Try again" on Expired and "Contact support": the kit's Expired screen carries neither.
//  - "Replace a device" through a Welcome-card sign-in refusal and the device-code screen ("Sign-in
//    code: ..."): sign-in is a browser hand-off now, so the test follows it to the app instead.
//  - "Signed in as" / "Not you?" / "Continue" screen: the kit finishes a sign-in by opening the app
//    (or its license choice); a signed-in summary and sign-out live in the Settings drop-in, not
//    in the gate.
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


    private var keyField: XCUIElement { app.textFields["License key"] }

    private var content: XCUIElement { app.staticTexts["licensed-content"] }

    // Well-formed keys, `pkey_<slug>_` and 22 characters, because the kit checks the shape on
    // the device before it asks the server; the scripted server tells them apart by the secret.
    private static let goodKey = "pkey_djdl_goodGoodGoodGoodGoodGo"
    private static let fullKey = "pkey_djdl_fullFullFullFullFullFu"
    private static let unknownKey = "pkey_djdl_nopeNopeNopeNopeNopeNo"

    private func openKeyForm() {
        waitFor(button("Use a license key"), "Use a license key")
        button("Use a license key").tap()
        waitFor(keyField, "the license-key field")
    }

    private func enter(_ key: String) {
        keyField.tap()
        keyField.typeText(key)
    }

    // ── welcome and the key form ─────────────────────────────────────────────────────────

    func testWelcomeOffersSignInAndAKeyAndTheKeyFormActivates() {
        launch("needsActivation")
        waitFor(app.staticTexts["Welcome to Tidewater Studio"], "Welcome")
        XCTAssertTrue(button("Sign in").exists)
        XCTAssertFalse(content.exists)
        assertButtonsAreNamed()
        shot("welcome")

        button("Use a license key").tap()
        waitFor(keyField, "the license-key field")
        XCTAssertTrue(button("Cancel").exists, "the form can be backed out of")
        shot("key-form")

        // Cancel returns to Welcome with the choice intact.
        button("Cancel").tap()
        waitFor(button("Use a license key"), "Welcome after Cancel")
        openKeyForm()
        enter(Self.goodKey)
        button("Activate license").tap()
        waitFor(content, "the app after activating")
    }

    func testRefusalsSitUnderTheFieldAndReturnSubmits() {
        launch("needsActivation")
        openKeyForm()
        // Not a key at all: the kit says so on the device, before it asks the server.
        enter("not-a-key")
        keyField.typeText("\n")
        waitFor(
            app.staticTexts["That doesn't look like a license key. Keys start with pkey_."],
            "the malformed-key refusal")
        shot("key-malformed")
        clearKey("not-a-key")

        // A well-formed key the server does not know. Return submits (no tap on Activate license).
        keyField.typeText(Self.unknownKey + "\n")
        let refusal = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS %@", "That license key wasn't accepted")
        ).firstMatch
        waitFor(refusal, "the server's refusal")
        XCTAssertFalse(content.exists)
        shot("key-refused")
        clearKey(Self.unknownKey)
        keyField.typeText(Self.goodKey + "\n")
        waitFor(content, "the app after Return")
    }

    private func clearKey(_ typed: String) {
        keyField.tap()
        keyField.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: typed.count))
    }

    // ── expired ──────────────────────────────────────────────────────────────────────────

    func testExpiredOffersUseAnotherLicenseAndReachesTheFormWithoutRelaunching() {
        launch("expired")
        waitFor(app.staticTexts["License expired"], "the Expired screen")
        waitFor(button("Use another license"), "Use another license")
        XCTAssertFalse(button("Try again").exists, "Expired offers no Try again")
        XCTAssertFalse(content.exists)
        assertButtonsAreNamed()
        shot("expired")

        button("Use another license").tap()
        waitFor(keyField, "the license-key field")
        XCTAssertTrue(button("Cancel").exists, "the form can be backed out of")
        shot("expired-different-key")

        // Cancel returns to the blocking state; the form is one tap away again.
        button("Cancel").tap()
        waitFor(button("Use another license"), "Use another license after Cancel")
        button("Use another license").tap()
        waitFor(keyField, "the license-key field again")
        enter(Self.goodKey)
        button("Activate license").tap()
        waitFor(content, "the app after activating")
    }

    // ── revoked ──────────────────────────────────────────────────────────────────────────

    func testRevokedLeadsWithSignInAndReachesTheFormWithoutRelaunching() {
        launch("revoked")
        waitFor(app.staticTexts["Signed out"], "the Revoked screen")
        waitFor(button("Sign in"), "Sign in")
        XCTAssertTrue(button("Use a different key").exists)
        XCTAssertFalse(content.exists)
        shot("revoked")

        button("Use a different key").tap()
        waitFor(keyField, "the license-key field")
        enter(Self.goodKey)
        button("Activate license").tap()
        waitFor(content, "the app after activating")
    }

    // ── device limit ─────────────────────────────────────────────────────────────────────

    func testADeviceLimitRefusalShowsAWorkingReplaceADevice() {
        launch("needsActivation")
        openKeyForm()
        enter(Self.fullKey)
        button("Activate license").tap()
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

    func testSignInHandsOffToTheBrowserAndFinishesInTheApp() {
        launch("signedIn")
        waitFor(button("Sign in"), "Sign in")
        button("Sign in").tap()
        shot("sign-in")
        // The kit opens the verification page in the browser, then the poll answers ready.
        app.activate()
        waitFor(content, "the app after the sign-in finished", timeout: 60)
    }

    // ── a licensed launch, the defaults ──────────────────────────────────────────────────

    func testALicensedLaunchShowsTheAppAndNoActivationCard() {
        launch("licensed")
        waitFor(content, "the app")
        XCTAssertFalse(app.staticTexts["Welcome to Tidewater Studio"].exists)
        XCTAssertFalse(keyField.exists)
    }

    func testActivateOfflineIsOffByDefaultOnIOSAndAvailableWhenAsked() {
        launch("needsActivation")
        waitFor(button("Use a license key"), "Welcome")
        XCTAssertFalse(button("Activate offline").exists)
        app.terminate()
        launch("needsActivation", extra: ["-pkOffline", "1"])
        waitFor(button("Activate offline"), "Activate offline when asked")
    }
}
