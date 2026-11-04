// @pkey-feature ui.kit.holders
// The holder screens' rules that need no window (UK-43.5): which button leads, which are disabled,
// that Cancel stays live, and the one body of form, invalid and busy.

import PolarisKeyUICore
import XCTest

@testable import PolarisKeyUI

final class HolderScreensTests: XCTestCase {
    private func buttons(
        _ component: KitComponent, _ state: String, keys: [String], working: Bool = false,
        opened: Bool = false, noVerify: Bool = false
    ) -> [HolderButtonSpec] {
        HolderPlan.buttons(
            component, state: state, keys: Set(keys),
            HolderExtras(working: working, opened: opened, noVerify: noVerify))
    }

    func testEmailBoundLeadsWithVerifyAndStartUsingIsAQuietLink() {
        let b = buttons(
            .addToAccount, "email-bound",
            keys: [
                "activate.otherEmail.verify", "signin.auto.confirm.other", "signin.done.start",
            ])
        XCTAssertEqual(b.map(\.action), [.verify, .otherAccount, .start])
        XCTAssertEqual(b.map(\.kind), [.primary, .secondary, .quiet])
        XCTAssertTrue(b[0].external)
    }

    func testEmailBoundWithNoEmailKnownLeadsWithUseAnotherAccount() {
        let b = buttons(
            .addToAccount, "email-bound", keys: ["signin.auto.confirm.other", "signin.done.start"])
        XCTAssertEqual(b.map(\.action), [.otherAccount, .start])
        XCTAssertEqual(b.first?.kind, .primary)
        // No page to verify on: Verify is left out, never a button that opens nothing.
        let noPage = buttons(
            .addToAccount, "email-bound",
            keys: [
                "activate.otherEmail.verify", "signin.auto.confirm.other", "signin.done.start",
            ], noVerify: true)
        XCTAssertEqual(noPage.map(\.action), [.otherAccount, .start])
    }

    func testOtherAccountLeadsWithTryAgain() {
        let b = buttons(
            .addToAccount, "other-account", keys: ["common.tryAgain", "signin.done.start"])
        XCTAssertEqual(b.map(\.action), [.tryAgain, .start])
        XCTAssertEqual(b.map(\.kind), [.primary, .quiet])
    }

    func testTheWaitsPageButtonSaysOpenBrowserThenOpenPolarisLockerAgain() {
        let keys = ["common.cancel"]
        let first = buttons(.addToAccount, "waiting", keys: keys)
        XCTAssertEqual(first.first?.key, "signin.handoff.openBrowser")
        let again = buttons(.addToAccount, "waiting", keys: keys, opened: true)
        XCTAssertEqual(again.first?.key, "activate.attach.reopen")
        XCTAssertEqual(first.map(\.action), [.reopen, .cancel])
    }

    func testABusyActionDisablesTheOthersButCancelAndTheirPageStayLive() {
        let b = buttons(
            .addToAccount, "owned", keys: ["signin.key.ownedSignIn", "common.cancel"], working: true)
        XCTAssertEqual(b.map(\.action), [.signIn, .cancel])
        XCTAssertTrue(b[0].busy)
        XCTAssertTrue(b[1].enabled)
        let busy = buttons(
            .addToAccount, "busy",
            keys: ["common.continue", "signin.handoff.again", "common.cancel"], working: true)
        XCTAssertEqual(busy.map(\.action), [.submit, .reopen, .cancel])
        XCTAssertEqual(busy.map(\.enabled), [true, true, true])
    }

    func testCancelIsThereWhileAnAccountSignInRunsOnDone() {
        let b = buttons(
            .activateDone, "waiting", keys: ["signin.done.start", "activate.waitingSignIn"],
            working: true)
        XCTAssertEqual(b.map(\.action), [.start, .signInAs, .cancel])
        // Start using waits for the sign-in; Cancel lets it go.
        XCTAssertEqual(b.map(\.enabled), [false, true, true])
        let idle = buttons(
            .activateDone, "waiting", keys: ["signin.done.start", "activate.waitingSignIn"])
        XCTAssertEqual(idle.map(\.action), [.start, .signInAs])
    }

    func testStartUsingIsTheOnePrimaryOnDoneAndEscapeIsNotAnAction() {
        let b = buttons(.activateDone, "ready", keys: ["signin.done.start"])
        XCTAssertEqual(b.map(\.kind), [.primary])
        XCTAssertFalse(b.contains { $0.action == .cancel })
    }

    func testAddedClosesWithDoneFromSettingsAndGoesOnToTheProductOtherwise() {
        XCTAssertEqual(
            buttons(.addToAccount, "added", keys: ["common.done"]).map(\.action), [.done])
        XCTAssertEqual(
            buttons(.addToAccount, "added", keys: ["signin.done.start"]).map(\.action), [.start])
    }

    func testFormInvalidAndBusyAreOneBodyAndTheRestAreNot() {
        for state in ["form", "invalid", "busy"] {
            XCTAssertEqual(HolderPlan.group(.addToAccount, state: state), "form")
        }
        for state in ["waiting", "added", "owned", "failed"] {
            XCTAssertEqual(HolderPlan.group(.addToAccount, state: state), state)
        }
        XCTAssertEqual(HolderPlan.group(.activateDone, state: "ready"), "ready")
    }

    func testEveryHolderPreviewHasTitleAndButtonsFromItsOwnCopy() {
        for preview in PolarisKeyPreviewState.all
        where preview.component == .addToAccount || preview.component == .activateDone {
            switch preview.component {
            case .activateDone:
                let step = HolderStep(KitStates.activateDone(preview.inputs))
                XCTAssertTrue(step.keys.contains(HolderPlan.titleKey(.activateDone, state: step.state)), preview.id)
                XCTAssertFalse(step.buttons.isEmpty, preview.id)
            default:
                let step = HolderStep(KitStates.addToAccount(preview.inputs))
                XCTAssertTrue(step.keys.contains(HolderPlan.titleKey(.addToAccount, state: step.state)), preview.id)
                XCTAssertFalse(step.buttons.isEmpty, preview.id)
                for spec in step.buttons where spec.key != "signin.handoff.openBrowser" {
                    XCTAssertTrue(step.keys.contains(spec.key), "\(preview.id): \(spec.key)")
                }
            }
        }
    }

    func testNoHolderLabelIsFormattedWithAnEmptyArgument() {
        for preview in PolarisKeyPreviewState.all
        where preview.component == .addToAccount || preview.component == .activateDone {
            let step =
                preview.component == .activateDone
                ? HolderStep(KitStates.activateDone(preview.inputs))
                : HolderStep(KitStates.addToAccount(preview.inputs))
            for generic in [false, true] {
                for spec in step.buttons {
                    let line = HolderActions.label(spec, step: step, generic: generic)
                    for (name, value) in line.args {
                        XCTAssertNotEqual(value, .text(""), "\(preview.id) \(line.key) \(name)")
                    }
                    if generic, spec.key == "signin.done.start" {
                        XCTAssertEqual(line.key, "common.continue", preview.id)
                    }
                }
            }
        }
    }

    func testALeadInIsSemiboldAndTheSentenceStaysWhole() {
        let runs = KitFormat.leadParts("**Sync your settings** across your devices")
        XCTAssertEqual(runs.map(\.strong), [true, false])
        XCTAssertEqual(runs.map(\.text).joined(), "Sync your settings across your devices")
    }
}
