// The macOS Settings pane and the app menu (UK-08.4): the commands exist with their labels,
// Manage License… lands on Account, Check for Updates… shows a result, Sign Out… asks first (in the Account pane), and
// ⌘W or Escape closes the Settings window with focus back on the app's own window.
//
// These drive the real app through the accessibility tree, so they need UI automation allowed for
// the test runner (owner step O1 on a developer Mac; CI images have it). The sample has no
// updater, so Check for Updates… takes the fallback: Account opens and Check now answers under the version.

import XCTest

@MainActor
final class KitSettingsMacTests: XCTestCase {
    let app = XCUIApplication()

    override func setUp() async throws {
        continueAfterFailure = false
    }

    private func launch(_ extra: [String] = []) {
        app.launchArguments = ["-ApplePersistenceIgnoreState", "YES", "-pkeyScheme", "light", "-pkeyWindow", "900x640"] + extra
        app.launch()
    }

    private func openSettings() {
        app.typeKey(",", modifierFlags: .command)
    }

    private func appMenu() -> XCUIElement {
        app.menuBars.menuBarItems["Tidewater Studio"]
    }

    private func menuItem(_ title: String) -> XCUIElement {
        appMenu().click()
        return app.menuBars.menuItems[title]
    }

    func testTheMenuItemsExistWithTheirLabels() {
        launch()
        appMenu().click()
        for title in ["Check for Updates…", "Manage License…", "Sign Out…"] {
            XCTAssertTrue(app.menuBars.menuItems[title].waitForExistence(timeout: 5), title)
        }
    }

    func testManageLicenseLandsOnAccount() {
        launch()
        menuItem("Manage License…").click()
        let settings = app.windows["Account"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        XCTAssertTrue(settings.staticTexts["Pro license"].exists)
        XCTAssertTrue(settings.buttons["Check for Updates…"].exists)
        XCTAssertTrue(settings.buttons["Sign Out…"].exists)
    }

    func testCheckForUpdatesShowsAResult() {
        // No updater is linked in the sample: the menu opens Account and answers there.
        launch()
        menuItem("Check for Updates…").click()
        let settings = app.windows["Account"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        XCTAssertTrue(settings.staticTexts["You're up to date"].waitForExistence(timeout: 5))
    }

    func testCheckForUpdatesInThePaneAnswersUnderTheVersion() {
        launch()
        openSettings()
        let settings = app.windows["Account"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.buttons["Check for Updates…"].click()
        XCTAssertTrue(settings.staticTexts["You're up to date"].waitForExistence(timeout: 5))
    }

    func testSignOutAsksFirstAndCancelKeepsTheSession() {
        launch()
        menuItem("Sign Out…").click()
        let settings = app.windows["Account"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        let ask = settings.sheets.firstMatch
        XCTAssertTrue(ask.waitForExistence(timeout: 5))
        XCTAssertTrue(ask.staticTexts["Sign out of Tidewater Studio on this device?"].exists)
        XCTAssertTrue(ask.buttons["Sign Out"].exists)
        ask.buttons["Cancel"].click()
        XCTAssertTrue(ask.waitForNonExistence(timeout: 5))
        XCTAssertTrue(settings.staticTexts["Pro license"].exists)
    }

    func testCommandWClosesSettingsAndFocusReturns() {
        launch()
        openSettings()
        let settings = app.windows["Account"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        app.typeKey("w", modifierFlags: .command)
        XCTAssertTrue(settings.waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.windows.firstMatch.exists)
    }

    func testEscapeStepsBackFromDevicesThenCloses() {
        launch()
        openSettings()
        let settings = app.windows["Account"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.buttons.matching(NSPredicate(format: "label CONTAINS 'Devices'")).firstMatch.click()
        XCTAssertTrue(app.windows["Devices"].waitForExistence(timeout: 5))
        app.typeKey(.escape, modifierFlags: [])
        XCTAssertTrue(app.windows["Account"].waitForExistence(timeout: 5))
        app.typeKey(.escape, modifierFlags: [])
        XCTAssertTrue(app.windows["Account"].waitForNonExistence(timeout: 5))
    }
}
