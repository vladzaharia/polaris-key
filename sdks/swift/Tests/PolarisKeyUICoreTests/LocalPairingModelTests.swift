// @pkey-feature connect.local
// LocalPairingModel and PairedDevicesModel against a fake driver, with an injected clock and timer
// (the reference is packages/ui-core/test/localPairingModel.test.ts): the stale-code guard, the 30 s
// wait and its warning, the prompt that outlives a changed code, a busy Pair, and the list's rows.

import Foundation
import PolarisKeyCore
import XCTest

@testable import PolarisKeyUICore

/// A driver the test plays both devices of.
final class FakeLinks: @unchecked Sendable {
    var gate = true
    var rows: [KitPairedDevice] = []
    var dials: Int? = 2
    var events: KitLocalEvents?
    var joinError: Error?
    var joinOffer: KitLocalOffer?
    var joinResult: KitLocalPaired?
    var renameError: Error?
    var removeError: Error?
    var renewError: Error?
    var pairError: Error?
    var changed: (@Sendable () -> Void)?
    var stops = 0
    var declines = 0
    var confirms = 0
    var renewCode: KitLocalCode?

    var driver: LocalLinksDriver {
        let me = self
        return LocalLinksDriver(
            localPairing: { me.gate },
            list: { me.rows },
            rename: { id, label in
                if let e = me.renameError { throw e }
                me.rows = me.rows.map {
                    $0.id == id
                        ? KitPairedDevice(id: id, label: label, lastSeen: $0.lastSeen, reachable: $0.reachable) : $0
                }
            },
            remove: { id in
                if let e = me.removeError { throw e }
                me.rows.removeAll { $0.id == id }
            },
            setReachable: { _, _ in },
            onChange: { fn in
                me.changed = fn
                return {}
            },
            dialsLeft: { _ in me.dials },
            pair: { _, _, events in
                if let e = me.pairError { throw e }
                me.events = events
                return KitLocalWindow(
                    stop: { me.stops += 1 },
                    renew: {
                        if let e = me.renewError { throw e }
                        return me.renewCode ?? code("5000 0000", "opened")
                    })
            },
            join: { _, _, _, onConfirm in
                if let o = me.joinOffer { onConfirm(o) }
                if let e = me.joinError { throw e }
                try await Task.sleep(nanoseconds: 50_000_000)
                return me.joinResult ?? KitLocalPaired(id: "L9", label: "Maya")
            })
    }

    func offer(_ label: String? = "Maya") -> KitLocalOffer {
        KitLocalOffer(
            label: label, categories: ["crates"], confirm: { self.confirms += 1 },
            decline: { self.declines += 1 })
    }
}

func code(_ text: String, _ reason: String, expires: Int = 1300) -> KitLocalCode {
    KitLocalCode(code: text, qr: "PKP1:T:X:Y", reason: reason, expiresAt: expires)
}

/// A clock and a timer a test advances by hand.
@MainActor final class ManualClock {
    var time = 1000.0
    var pending: [(Double, @MainActor () -> Void)] = []
    var timer: @MainActor (Double, @escaping @MainActor () -> Void) -> () -> Void {
        { [self] seconds, fn in
            pending.append((time + seconds, fn))
            return { [self] in pending.removeAll { _ in false } }
        }
    }
    func advance(_ s: Double) {
        time += s
        let due = pending
        pending = []
        for (_, fn) in due { fn() }
    }
}

@MainActor
final class LocalPairingModelTests: XCTestCase {
    private func settle() async { for _ in 0..<20 { await Task.yield() } }

    private func make(
        _ fake: FakeLinks = FakeLinks(), clock: ManualClock = ManualClock(), prePrompt: Bool = false,
        canOpenSettings: Bool = false
    ) -> (LocalPairingModel, FakeLinks, ManualClock) {
        let model = LocalPairingModel(
            driver: fake.driver, categories: ["crates"], label: "Studio PC", prePrompt: prePrompt,
            canOpenSettings: canOpenSettings, now: { clock.time }, timer: clock.timer)
        return (model, fake, clock)
    }

    private func shown(_ m: LocalPairingModel, _ f: FakeLinks, _ text: String = "4812 3456") async {
        await m.start()
        await m.show()
        XCTAssertEqual(m.state.step, .opening)
        f.events?.onCode(code(text, "opened"))
        await settle()
    }

    func testStartReadsTheGateAndTheCap() async {
        let off = FakeLinks()
        off.gate = false
        let (a, _, _) = make(off)
        await a.start()
        XCTAssertEqual(a.state.step, .off)
        let full = FakeLinks()
        full.rows = (0..<kitMaxPaired).map { KitPairedDevice(id: "L\($0)") }
        let (b, _, _) = make(full)
        await b.start()
        XCTAssertEqual(b.state.step, .choose)
        XCTAssertEqual(b.state.full, true)
        XCTAssertEqual(b.screen.disabledKeys, ["localPairing.enter", "localPairing.show"])
        await b.show()
        XCTAssertEqual(b.state.step, .choose)
    }

    func testShowIsAPlaceholderUntilTheFirstCode() async {
        let (m, f, _) = make()
        await m.start()
        await m.show()
        XCTAssertEqual(m.state.step, .opening)
        f.events?.onCode(code("4812 3456", "opened"))
        await settle()
        XCTAssertEqual(m.state.step, .show)
        XCTAssertEqual(m.state.secondsLeft, 300)
        XCTAssertNil(m.state.notice)
    }

    func testOnlyACodeThatReplacedOneIsMarkedReplacedSoItIsAnnouncedOnce() async {
        let (m, f, _) = make()
        await shown(m, f)
        XCTAssertFalse(m.replaced)
        f.events?.onCode(code("4812 1111", "wrong-code"))
        await settle()
        XCTAssertTrue(m.replaced)
    }

    func testAWrongCodeLightsTheChangedDigitsAndAnnounces() async {
        let (m, f, _) = make()
        await shown(m, f)
        let before = m.rotation
        f.events?.onCode(code("4812 9999", "wrong-code"))
        await settle()
        XCTAssertEqual(m.state.notice, .rotated)
        XCTAssertEqual(m.changed, [5, 6, 7, 8])
        XCTAssertEqual(m.rotation, before + 1)
    }

    func testFiveWrongCodesWarnThatSomeoneMayBeGuessing() async {
        let (m, f, _) = make()
        await shown(m, f)
        for n in 0..<5 {
            f.events?.onCode(code("48\(n)2 0000", "wrong-code"))
            await settle()
        }
        XCTAssertEqual(m.state.notice, .guessing)
    }

    func testTooManyTriesWaitsThirtySecondsThenTheSecondTimeWarns() async {
        let (m, f, clock) = make()
        await shown(m, f)
        f.events?.onEnd("too-many-tries")
        await settle()
        XCTAssertEqual(m.state.step, .closed)
        XCTAssertEqual(m.state.cooldownLeft, 30)
        await m.showNew()
        XCTAssertEqual(m.state.step, .closed, "a press during the wait does nothing")
        clock.advance(10)
        XCTAssertEqual(m.state.cooldownLeft, 20)
        clock.advance(25)
        XCTAssertEqual(m.state.cooldownLeft, 0)
        XCTAssertNil(m.state.warn)
        await m.showNew()
        f.events?.onCode(code("5000 0000", "opened"))
        await settle()
        f.events?.onEnd("too-many-tries")
        await settle()
        XCTAssertEqual(m.state.warn, true)
    }

    func testAWindowThatRanOutHasNoWait() async {
        let (m, f, _) = make()
        await shown(m, f)
        f.events?.onEnd("expired")
        await settle()
        XCTAssertEqual(m.state.closedBy, .expired)
        XCTAssertNil(m.state.cooldownLeft)
    }

    func testTheSdkFloorIsWaitedOutNotShownAsAFailure() async {
        let f = FakeLinks()
        f.pairError = KitLocalError(code: ErrorCode.peerClosed, reason: "cooldown")
        let (m, _, _) = make(f)
        await m.start()
        await m.show()
        XCTAssertEqual(m.state.step, .closed)
        XCTAssertEqual(m.state.closedBy, .tooManyTries)
        XCTAssertGreaterThan(m.state.cooldownLeft ?? 0, 0)
    }

    func testThePromptOutlivesAChangedCodeSoTheNextDeviceIsNotRefused() async {
        let (m, f, _) = make()
        await shown(m, f)
        f.events?.onConfirm(f.offer("Maya"))
        await settle()
        XCTAssertEqual(m.state.step, .confirm)
        f.events?.onCode(code("4812 1111", "timeout"))
        await settle()
        XCTAssertEqual(m.state.step, .show)
        XCTAssertEqual(m.state.notice, .declined)
        XCTAssertEqual(m.state.device, "Maya")
        let next = f.offer("Theo")
        f.events?.onConfirm(next)
        await settle()
        XCTAssertEqual(m.state.step, .confirm)
        XCTAssertEqual(m.state.device, "Theo")
        XCTAssertEqual(f.declines, 0)
    }

    func testASecondDeviceAtThePromptIsDeclined() async {
        let (m, f, _) = make()
        await shown(m, f)
        f.events?.onConfirm(f.offer("Maya"))
        await settle()
        f.events?.onConfirm(f.offer("Theo"))
        await settle()
        XCTAssertEqual(m.state.device, "Maya")
        XCTAssertEqual(f.declines, 1)
    }

    func testPairIsBusyAfterThePressAndARepeatDoesNothing() async {
        let (m, f, _) = make()
        await shown(m, f)
        f.events?.onConfirm(f.offer())
        await settle()
        await m.confirm()
        XCTAssertEqual(m.state.busy, .pair)
        XCTAssertEqual(m.screen.disabledKeys, ["common.notNow", "localPairing.pair"])
        await m.confirm()
        await m.notNow()
        XCTAssertEqual(f.confirms, 1)
        XCTAssertEqual(f.declines, 0)
    }

    func testBlockedNoticeAtThreeInterruptionsAndTheNextCodeClearsIt() async {
        let (m, f, _) = make()
        await shown(m, f)
        f.events?.onInterrupted(2)
        await settle()
        XCTAssertNil(m.state.notice)
        f.events?.onInterrupted(3)
        await settle()
        XCTAssertEqual(m.state.notice, .blocked)
        f.events?.onCode(code("4812 2222", "wrong-code"))
        await settle()
        XCTAssertEqual(m.state.notice, .rotated)
    }

    func testStoredWindowGoesToPairedWithTheNameFieldPrefilled() async {
        let f = FakeLinks()
        f.rows = [KitPairedDevice(id: "L1", label: "Maya", reachable: false)]
        let (m, _, _) = make(f)
        await shown(m, f)
        f.events?.onLinked(KitLocalPaired(id: "L1", label: "Maya"))
        await settle()
        XCTAssertEqual(m.state.step, .paired)
        XCTAssertEqual(m.name, "Maya")
        XCTAssertEqual(m.state.cantConnect, true)
        m.setName("Maya's phone")
        await m.done()
        XCTAssertEqual(f.rows.first?.label, "Maya's phone")
        XCTAssertTrue(m.left)
    }

    func testAFailedRenameKeepsThePairedScreen() async {
        let f = FakeLinks()
        f.renameError = KitLocalError(code: "store-failed")
        let (m, _, _) = make(f)
        await shown(m, f)
        f.events?.onLinked(KitLocalPaired(id: "L1", label: "Maya"))
        await settle()
        m.setName("Other")
        await m.done()
        XCTAssertEqual(m.state.step, .paired)
        XCTAssertEqual(m.state.nameError, "failed")
        XCTAssertFalse(m.left)
    }

    func testCancelOnTheCodeWithdrawsTheWindow() async {
        let (m, f, _) = make()
        await shown(m, f)
        await m.cancel()
        XCTAssertEqual(m.state.step, .choose)
        XCTAssertEqual(f.stops, 1)
    }

    func testEnterWrongKeepsTheFirstTwoDigitsAndHoldsPairUntilTheyDiffer() async {
        let f = FakeLinks()
        f.joinError = KitLocalError(code: ErrorCode.pairingCodeFailed, reason: "wrong")
        let (m, _, _) = make(f)
        await m.start()
        await m.enter()
        XCTAssertEqual(m.state.pairDisabled, true)
        m.setEntry("48123456")
        XCTAssertEqual(m.state.entry, "4812 3456")
        XCTAssertEqual(m.state.pairDisabled, false)
        await m.pair()
        XCTAssertEqual(m.state.step, .enter)
        XCTAssertEqual(m.state.error, .wrong)
        XCTAssertEqual(m.state.entry, "48")
        m.setEntry("48123456")
        XCTAssertEqual(m.state.pairDisabled, true, "the failed code is held")
        await m.pair()
        XCTAssertEqual(m.state.error, .wrong)
        m.setEntry("48123457")
        XCTAssertEqual(m.state.pairDisabled, false)
    }

    func testPairUnderEightDigitsAnswersItsReason() async {
        let (m, _, _) = make()
        await m.start()
        await m.enter()
        m.setEntry("4873")
        await m.pair()
        XCTAssertEqual(m.state.error, .notACode)
        XCTAssertEqual(m.screen.disabledKeys, ["localPairing.pair"])
    }

    func testSpentLeavesAnEmptyEditableField() async {
        let f = FakeLinks()
        f.joinError = KitLocalError(code: ErrorCode.pairingCodeFailed, reason: "spent")
        let (m, _, _) = make(f)
        await m.start()
        await m.enter()
        m.setEntry("48123456")
        await m.pair()
        XCTAssertEqual(m.state.error, .tooMany)
        XCTAssertEqual(m.state.entry, "")
    }

    func testNotFoundKeepsTheCode() async {
        let f = FakeLinks()
        f.joinError = KitLocalError(code: ErrorCode.pairingNotFound)
        let (m, _, _) = make(f)
        await m.start()
        await m.enter()
        m.setEntry("48123456")
        await m.pair()
        XCTAssertEqual(m.state.error, .notFound)
        XCTAssertEqual(m.state.entry, "4812 3456")
    }

    func testTheOtherPromptConfirmsAtOnceAndWaits() async {
        let f = FakeLinks()
        f.joinOffer = f.offer("Theo")
        let (m, _, _) = make(f)
        await m.start()
        await m.enter()
        m.setEntry("48123456")
        async let paired: Void = m.pair()
        await settle()
        XCTAssertEqual(m.state.step, .waiting)
        XCTAssertEqual(m.state.device, "Theo")
        XCTAssertEqual(f.confirms, 1)
        await paired
        XCTAssertEqual(m.state.step, .paired)
    }

    func testCancelWhileJoiningReturnsToTheFieldWithTheTypedCode() async {
        let f = FakeLinks()
        let (m, _, _) = make(f)
        await m.start()
        await m.enter()
        m.setEntry("48123456")
        async let paired: Void = m.pair()
        await settle()
        XCTAssertEqual(m.state.step, .joining)
        await m.cancel()
        XCTAssertEqual(m.state.step, .enter)
        XCTAssertEqual(m.state.entry, "4812 3456")
        await paired
        XCTAssertEqual(m.state.step, .enter, "the late answer is dropped")
    }

    func testTheNetworkAnswerReturnsToTheStepItCameFrom() async {
        let f = FakeLinks()
        f.pairError = KitLocalError(code: ErrorCode.nearbyPermissionDenied)
        let (m, _, _) = make(f, canOpenSettings: true)
        await m.start()
        await m.show()
        XCTAssertEqual(m.state.step, .networkBlocked)
        XCTAssertEqual(m.state.canOpenSettings, true)
        f.pairError = nil
        await m.retry()
        XCTAssertEqual(m.state.step, .opening)
    }

    func testFullOnShowReturnsToChooseSaidBeforeEitherButton() async {
        let f = FakeLinks()
        f.pairError = KitLocalError(code: ErrorCode.localLinksFull, cap: LocalLinksCap.stored)
        let (m, _, _) = make(f)
        await m.start()
        await m.show()
        XCTAssertEqual(m.state.step, .choose)
        XCTAssertEqual(m.state.full, true)
    }

    func testShowNewRingsBusyAndIgnoresARepeat() async {
        let f = FakeLinks()
        let (m, _, _) = make(f)
        await shown(m, f)
        f.events?.onCode(code("4812 1111", "wrong-code"))
        await settle()
        f.renewCode = code("5000 0000", "opened")
        await m.showNew()
        XCTAssertEqual(m.state.step, .show)
        XCTAssertEqual(m.state.code, "5000 0000")
        XCTAssertNil(m.state.busy)
    }
}

@MainActor
final class PairedDevicesModelTests: XCTestCase {
    private func rows(_ n: Int) -> [KitPairedDevice] {
        (1...n).map { KitPairedDevice(id: "L\($0)", label: "Device \($0)", lastSeen: 1_700_000_000) }
    }

    func testTheFirstReadShowsNothingAboutWhatIsPairedUntilItAnswers() async {
        let f = FakeLinks()
        f.rows = rows(2)
        let m = PairedDevicesModel(driver: f.driver)
        XCTAssertEqual(m.screen.state, .loading)
        await m.start()
        XCTAssertEqual(m.screen.state, .list)
        XCTAssertTrue(m.entryVisible)
        XCTAssertFalse(m.screen.shows("pairedDevices.canConnect"), "8 or fewer, all on: no switch column")
    }

    func testTheSwitchColumnShowsWhenOneIsOffOrMoreThanEight() async {
        XCTAssertFalse(kitShowSwitchColumn(rows(8)))
        XCTAssertTrue(kitShowSwitchColumn(rows(9)))
        var r = rows(3)
        r[1].reachable = false
        XCTAssertTrue(kitShowSwitchColumn(r))
    }

    func testAChangeFromTheSdkIsReadAgain() async {
        let f = FakeLinks()
        f.rows = rows(1)
        let m = PairedDevicesModel(driver: f.driver)
        await m.start()
        f.rows = rows(3)
        f.changed?()
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(m.state.devices?.count, 3)
    }

    func testGateOffKeepsTheRowsAndTheHostEntryWhileALinkIsHeld() async {
        let f = FakeLinks()
        f.rows = rows(2)
        f.gate = false
        let m = PairedDevicesModel(driver: f.driver)
        await m.start()
        XCTAssertEqual(m.screen.state, .off)
        XCTAssertTrue(m.entryVisible)
    }

    func testUnreadableStoreIsLoadFailedAndTryAgainShowsLoadingThenTheList() async {
        let f = FakeLinks()
        struct Boom: Error {}
        let broken = LocalLinksDriver(
            localPairing: { true }, list: { throw Boom() }, rename: { _, _ in }, remove: { _ in },
            setReachable: { _, _ in }, onChange: { _ in {} }, dialsLeft: { _ in nil },
            pair: f.driver.pair, join: f.driver.join)
        let m = PairedDevicesModel(driver: broken)
        await m.start()
        XCTAssertEqual(m.screen.state, .loadFailed)
        XCTAssertEqual(m.screen.disabledKeys, [])
    }

    func testRenameRefusalsKeepTheTextAndSayWhy() async {
        let f = FakeLinks()
        f.rows = rows(2)
        let m = PairedDevicesModel(driver: f.driver)
        await m.start()
        m.startRename("L1")
        XCTAssertEqual(m.draft, "Device 1")
        m.setDraft("   ")
        await m.saveRename()
        XCTAssertEqual(m.state.renameError, .empty)
        m.setDraft(String(repeating: "x", count: 65))
        await m.saveRename()
        XCTAssertEqual(m.state.renameError, .long)
        XCTAssertEqual(m.draft.count, 65)
        f.renameError = KitLocalError(code: "unknown")
        m.setDraft("New")
        await m.saveRename()
        XCTAssertEqual(m.state.renameError, .failed)
        XCTAssertEqual(m.draft, "New")
        f.renameError = nil
        await m.saveRename()
        XCTAssertEqual(m.state.step, .list)
        XCTAssertEqual(m.focus, .row("L1"))
        XCTAssertEqual(m.state.devices?.first?.label, "New")
    }

    func testForgetMovesFocusToTheNextRowThenTheTitle() async {
        let f = FakeLinks()
        f.rows = rows(2)
        let m = PairedDevicesModel(driver: f.driver)
        await m.start()
        m.askForget("L1")
        XCTAssertEqual(m.screen.state, .forgetting)
        await m.confirmForget()
        XCTAssertEqual(m.focus, .row("L2"))
        m.askForget("L2")
        await m.confirmForget()
        XCTAssertEqual(m.focus, .title)
        XCTAssertEqual(m.screen.state, .empty)
    }

    func testAFailedForgetKeepsTheQuestion() async {
        let f = FakeLinks()
        f.rows = rows(2)
        f.removeError = KitLocalError(code: "unknown")
        let m = PairedDevicesModel(driver: f.driver)
        await m.start()
        m.askForget("L1")
        await m.confirmForget()
        XCTAssertEqual(m.state.step, .forgetting)
        XCTAssertEqual(m.state.forgetError, true)
        XCTAssertTrue(m.screen.shows("pairedDevices.forgetFailed"))
    }

    func testTryAgainOnTheBusyNoticeShowsItBusyUntilTheHostAnswers() async {
        let f = FakeLinks()
        f.rows = rows(2)
        let m = PairedDevicesModel(driver: f.driver)
        await m.start()
        var tried: [String] = []
        m.onRetry = { tried.append($0) }
        m.report("L2", .busy)
        m.retryNotice("L2")
        XCTAssertTrue(m.noticeBusy)
        XCTAssertEqual(tried, ["L2"])
        m.report("L2", nil)
        XCTAssertFalse(m.noticeBusy)
    }

    func testTheAppsOwnAnswersAreShownWithTheList() async {
        let f = FakeLinks()
        f.rows = rows(2)
        let m = PairedDevicesModel(driver: f.driver)
        await m.start()
        m.report("L2", .notFound)
        XCTAssertEqual(m.screen.state, .list)
        XCTAssertTrue(m.screen.shows("pairedDevices.notFoundTitle"))
        m.report("L2", nil)
        XCTAssertFalse(m.screen.shows("pairedDevices.notFoundTitle"))
    }
}
