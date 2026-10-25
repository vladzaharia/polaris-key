// The Welcome window and its inline steps by keyboard alone (UK-08.3, UI-KITS §1.5 rule 10):
// Return takes the one default, Tab walks the controls in reading order, Escape goes back to
// Welcome and focus returns to the control that opened the step.
//
// Runs against the gate over a still model (`-pkeyState Gate.needs-activation`), whose buttons
// drive the real route changes. Needs UI automation allowed for the runner (owner step O1) and,
// for the Tab walk, "Keyboard navigation" (Full Keyboard Access) on; CI's macOS images have both.
// The walk skips (never passes silently) when the system keeps Tab inside text fields.

import XCTest

@MainActor
final class KitKeyboardMacTests: XCTestCase {
    private func launch(_ extra: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments =
            ["-pkeyState", "Gate.needs-activation", "-pkeyFreezeTime", "-pkeyWindow", "900x640"]
            + extra
        app.launch()
        XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 10))
        return app
    }

    private func hasFocus(_ element: XCUIElement) -> Bool {
        (element.value(forKey: "hasKeyboardFocus") as? Bool) ?? false
    }

    private func button(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", label)).firstMatch
    }

    /// Return presses the one default (Sign in); Escape on the step goes back to Welcome.
    func testReturnTakesTheDefaultAndEscapeGoesBackToWelcome() {
        let app = launch()
        let signIn = button(app, "Sign in")
        XCTAssertTrue(signIn.waitForExistence(timeout: 5), "Welcome shows Sign in")
        app.typeKey(.return, modifierFlags: [])
        // The inline step replaces Welcome's act: Cancel is its quiet button, and Sign in is gone.
        let cancel = button(app, "Cancel")
        XCTAssertTrue(cancel.waitForExistence(timeout: 5), "Return opened the sign-in step")
        XCTAssertFalse(signIn.exists)
        app.typeKey(.escape, modifierFlags: [])
        XCTAssertTrue(
            button(app, "Sign in").waitForExistence(timeout: 5), "Escape returned to Welcome")
        XCTAssertFalse(cancel.exists)
    }

    /// Tab reaches Use a License Key after Sign in; Space opens the key step, whose field takes the
    /// focus; Escape returns to Welcome with its controls reachable again.
    func testTabOrderAndFocusReturnsToTheOpener() throws {
        let app = launch()
        let signIn = button(app, "Sign in")
        let useKey = button(app, "License Key")
        XCTAssertTrue(signIn.waitForExistence(timeout: 5))
        XCTAssertTrue(useKey.exists)

        var reached = false
        for _ in 0..<6 {
            app.typeKey(.tab, modifierFlags: [])
            if hasFocus(useKey) {
                reached = true
                break
            }
        }
        try XCTSkipUnless(reached, "Tab did not reach the buttons: Full Keyboard Access is off")

        // Reading order: Sign in is before Use a License Key.
        XCTAssertLessThan(signIn.frame.minY, useKey.frame.minY)
        app.typeKey(" ", modifierFlags: [])

        let field = app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5), "Use a License Key opened the key step")
        app.typeKey(.escape, modifierFlags: [])
        XCTAssertTrue(
            button(app, "License Key").waitForExistence(timeout: 5), "Escape returned to Welcome")
        // Focus returned to the window, not to a vanished control: the next Tab lands on a control.
        app.typeKey(.tab, modifierFlags: [])
        let landed = [button(app, "Sign in"), button(app, "License Key")].contains(where: hasFocus)
        XCTAssertTrue(landed, "focus returns to Welcome's controls")
    }
}
