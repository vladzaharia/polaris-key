// @pkey-feature connect.local
// The show step's two views (UI-KITS 4.9): one window serves the code and the QR, switching renews
// nothing, a new window opens on the view the person last chose, and a window that ran out stays in
// its view, dimmed, until a new code is asked for in place.

import Foundation
import XCTest

@testable import PolarisKeyUICore

@MainActor
final class ShowSplitTests: XCTestCase {
    private func settle() async { for _ in 0..<20 { await Task.yield() } }

    private func make() -> (LocalPairingModel, FakeLinks, ManualClock) {
        let fake = FakeLinks()
        let clock = ManualClock()
        let model = LocalPairingModel(
            driver: fake.driver, categories: ["crates"], label: "Studio PC", now: { clock.time },
            timer: clock.timer)
        return (model, fake, clock)
    }

    private func shown(_ m: LocalPairingModel, _ f: FakeLinks) async {
        await m.start()
        await m.show()
        f.events?.onCode(code("4812 3456", "opened"))
        await settle()
    }

    func testTheCodeViewIsTheDefaultAndTheQrViewHoldsNoDigits() async {
        let (m, f, _) = make()
        await shown(m, f)
        XCTAssertEqual(m.screen.state, .show)
        XCTAssertNotNil(m.screen.line("localPairing.toQr"))
        XCTAssertNil(m.screen.line("a11y.qrPairing"))
        m.showQr()
        XCTAssertEqual(m.screen.state, .showQr)
        XCTAssertNotNil(m.screen.line("localPairing.toCode"))
        XCTAssertNotNil(m.screen.line("a11y.qrPairing"))
        XCTAssertNil(m.screen.line("a11y.linkCode"))
        XCTAssertNil(m.screen.line("localPairing.toQr"))
    }

    func testSwitchingNeverRenewsTheWindowOrTheCode() async {
        let (m, f, _) = make()
        await shown(m, f)
        let first = m.state.code
        let rotation = m.rotation
        m.showQr()
        m.showCode()
        m.showQr()
        XCTAssertEqual(m.state.code, first)
        XCTAssertEqual(m.rotation, rotation)
        XCTAssertEqual(m.switches, 3)
        XCTAssertEqual(f.stops, 0)
        // A switch to the view already open is not a switch.
        m.showQr()
        XCTAssertEqual(m.switches, 3)
    }

    func testARotationKeepsTheViewAndANewWindowOpensOnTheLastChoice() async {
        let (m, f, _) = make()
        await shown(m, f)
        m.showQr()
        f.events?.onCode(code("4899 0000", "wrong-code"))
        await settle()
        XCTAssertEqual(m.state.view, .qr)
        XCTAssertEqual(m.state.notice, .rotated)
        XCTAssertEqual(m.screen.state, .showQr)
        // Leaving the show flow forgets the choice: the next window opens on the code.
        await m.cancel()
        XCTAssertEqual(m.state.step, .choose)
        await m.show()
        f.events?.onCode(code("5000 1111", "opened"))
        await settle()
        XCTAssertNil(m.state.view)
    }

    func testAWindowThatRanOutStaysInItsViewAndRenewsInPlace() async {
        let (m, f, _) = make()
        await shown(m, f)
        m.showQr()
        f.events?.onEnd("expired")
        await settle()
        XCTAssertEqual(m.state.step, .show)
        XCTAssertEqual(m.state.expired, true)
        XCTAssertEqual(m.state.view, .qr)
        XCTAssertEqual(m.screen.state, .showQr)
        // It says "Code expired" once, in the title: no instruction, no time, no waiting row, no switch.
        XCTAssertEqual(m.screen.copy.first?.key, "core.codes.sign-in-expired.title")
        let absent = [
            "localPairing.expires", "localPairing.waitingDevice", "localPairing.qrBody", "localPairing.toCode",
        ]
        for key in absent { XCTAssertNil(m.screen.line(key), key) }
        XCTAssertNotNil(m.screen.line("localPairing.showNew"))
        await m.showNew()
        // Still on screen, busy, until the next window's first code arrives, in the same view.
        XCTAssertEqual(m.state.step, .show)
        XCTAssertEqual(m.state.busy, .newCode)
        f.events?.onCode(code("7000 1234", "opened"))
        await settle()
        XCTAssertEqual(m.state.view, .qr)
        XCTAssertNil(m.state.expired)
        XCTAssertEqual(m.state.code, "7000 1234")
        XCTAssertTrue(m.renewedFromExpired)
    }

    func testTheCodeViewExpiresInPlaceToo() async {
        let (m, f, _) = make()
        await shown(m, f)
        f.events?.onEnd("expired")
        await settle()
        XCTAssertEqual(m.screen.state, .show)
        XCTAssertEqual(m.state.expired, true)
        XCTAssertNotNil(m.screen.line("localPairing.showNew"))
    }

    func testTheLayoutIsOneColumnAndTheQrViewSplitsInALaptopWindow() {
        XCTAssertEqual(KitLocalPairingLayout.of(width: 1280, height: 800).panes, 1)
        XCTAssertEqual(KitLocalPairingLayout.of(width: 720, height: 420).scrolls, true)
        XCTAssertTrue(kitQrTwoColumns(width: 852, height: 393))
        XCTAssertTrue(kitQrTwoColumns(width: 1194, height: 834))
        XCTAssertTrue(kitQrTwoColumns(width: 1440, height: 900))
        XCTAssertFalse(kitQrTwoColumns(width: 1440, height: 901))
        XCTAssertFalse(kitQrTwoColumns(width: 393, height: 852))
        XCTAssertFalse(kitQrTwoColumns(width: 1100, height: 800, textScale: 2))
    }
}
