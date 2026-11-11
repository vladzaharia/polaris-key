// @pkey-feature connect.local
// Scan a code (CC-29K.3) against a fake scanner source: the choose entry only where the device can
// scan, the camera pre-prompt once, the denied and unavailable states, the text handed to join
// unchanged, another app's code that keeps the camera going, and Cancel that returns to it.

import Foundation
import PolarisKeyCore
import XCTest

@testable import PolarisKeyUICore

@MainActor
final class FakeScanner: KitScanSource {
    var status: KitCameraStatus
    var allow = true
    var asked = 0
    var sink: AsyncStream<String>.Continuation?
    init(_ status: KitCameraStatus) { self.status = status }
    func requestAccess() async -> Bool {
        asked += 1
        status = allow ? .authorized : .denied
        return allow
    }
    func codes() -> AsyncStream<String> {
        AsyncStream { sink = $0 }
    }
}

@MainActor
final class ScanModelTests: XCTestCase {
    private func settle() async { for _ in 0..<40 { await Task.yield() } }

    private func make(_ status: KitCameraStatus, _ fake: FakeLinks = FakeLinks())
        -> (LocalPairingModel, FakeLinks, FakeScanner, ManualClock)
    {
        let scanner = FakeScanner(status)
        let clock = ManualClock()
        let model = LocalPairingModel(
            driver: fake.driver, categories: ["crates"], label: "Studio PC", canOpenSettings: true,
            now: { clock.time }, timer: clock.timer, scanner: scanner)
        return (model, fake, scanner, clock)
    }

    func testChooseLeadsWithScanOnlyWhereTheDeviceCanScan() async {
        let (can, _, _, _) = make(.authorized)
        await can.start()
        XCTAssertNotNil(can.screen.line("localPairing.scan"))
        XCTAssertNil(can.screen.line("localPairing.enter"))
        XCTAssertEqual(can.screen.copy.first(where: { $0.key == "localPairing.scan" })?.key, "localPairing.scan")

        let (none, _, _, _) = make(.unavailable)
        await none.start()
        XCTAssertNil(none.screen.line("localPairing.scan"))
        XCTAssertNotNil(none.screen.line("localPairing.enter"))
    }

    func testTheCameraPrePromptComesBeforeTheSystemPromptAndOnlyOnce() async {
        let (m, _, scanner, _) = make(.notDetermined)
        await m.start()
        await m.scan()
        XCTAssertEqual(m.state.step, .scanPrompt)
        XCTAssertEqual(scanner.asked, 0)
        await m.continueToCamera()
        XCTAssertEqual(scanner.asked, 1)
        XCTAssertEqual(m.state.step, .scan)
        await m.cancel()
        await m.scan()
        XCTAssertEqual(m.state.step, .scan)
        XCTAssertEqual(scanner.asked, 1)
    }

    func testDeniedCameraShowsCameraOffWithSettingsAndTyping() async {
        let (m, _, scanner, _) = make(.notDetermined)
        scanner.allow = false
        await m.start()
        await m.scan()
        await m.continueToCamera()
        XCTAssertEqual(m.state.step, .cameraOff)
        XCTAssertNotNil(m.screen.line("localPairing.openSettings"))
        XCTAssertNotNil(m.screen.line("localPairing.enterInstead"))

        let (already, _, _, _) = make(.denied)
        await already.start()
        await already.scan()
        XCTAssertEqual(already.state.step, .cameraOff)
    }

    func testAllowingInSettingsStartsTheCameraWhenTheAppReturns() async {
        let (m, _, scanner, _) = make(.denied)
        await m.start()
        await m.scan()
        scanner.status = .authorized
        await m.cameraChanged()
        XCTAssertEqual(m.state.step, .scan)
    }

    func testAScannedTextGoesToJoinUnchangedAndPairs() async {
        let fake = FakeLinks()
        fake.joinOffer = fake.offer()
        let (m, _, scanner, _) = make(.authorized, fake)
        await m.start()
        await m.scan()
        scanner.sink?.yield("PKP1:DJDL:P1-ABCDEFGHIJKLMNOP:7KQ2M5TXNRB4WV3Y")
        await settle()
        XCTAssertEqual(fake.joined, ["PKP1:DJDL:P1-ABCDEFGHIJKLMNOP:7KQ2M5TXNRB4WV3Y"])
        XCTAssertEqual(fake.confirms, 1)
        XCTAssertEqual(m.scanHits, 1)
        try? await Task.sleep(nanoseconds: 120_000_000)
        await settle()
        XCTAssertEqual(m.state.step, .paired)
    }

    func testAnotherAppsCodeSaysSoAndKeepsScanning() async {
        let fake = FakeLinks()
        fake.joinError = KitLocalError(code: ErrorCode.pairingCodeFailed, reason: PairingCodeFailedReason.otherApp)
        let (m, _, scanner, clock) = make(.authorized, fake)
        await m.start()
        await m.scan()
        scanner.sink?.yield("PKP1:OTHER:P1-AAAAAAAAAAAAAAAA:7KQ2M5TXNRB4WV3Y")
        await settle()
        XCTAssertEqual(m.state.step, .scan)
        XCTAssertEqual(m.state.otherApp, true)
        XCTAssertNotNil(m.screen.line("localPairing.otherApp"))
        XCTAssertEqual(m.scanHits, 0)
        // The same frame again right away is ignored; a later read tries again.
        scanner.sink?.yield("PKP1:OTHER:P1-AAAAAAAAAAAAAAAA:7KQ2M5TXNRB4WV3Y")
        await settle()
        XCTAssertEqual(fake.joined.count, 1)
        clock.advance(LocalPairingModel.rereadSeconds + 1)
        scanner.sink?.yield("PKP1:OTHER:P1-AAAAAAAAAAAAAAAA:7KQ2M5TXNRB4WV3Y")
        await settle()
        XCTAssertEqual(fake.joined.count, 2)
    }

    func testCancelWhileWaitingReturnsToTheCamera() async {
        let fake = FakeLinks()
        fake.joinOffer = fake.offer()
        let (m, _, scanner, _) = make(.authorized, fake)
        await m.start()
        await m.scan()
        scanner.sink?.yield("PKP1:DJDL:P1-ABCDEFGHIJKLMNOP:7KQ2M5TXNRB4WV3Y")
        await settle()
        XCTAssertEqual(m.state.step, .waiting)
        await m.cancel()
        XCTAssertEqual(m.state.step, .scan)
        XCTAssertEqual(fake.declines, 1)
    }

    func testTypingAndScanningReachEachOther() async {
        let (m, _, _, _) = make(.authorized)
        await m.start()
        await m.scan()
        await m.enterInstead()
        XCTAssertEqual(m.state.step, .enter)
        XCTAssertNotNil(m.screen.line("localPairing.scanInstead"))
        XCTAssertNil(m.screen.line("localPairing.toShow"))
        await m.scanInstead()
        XCTAssertEqual(m.state.step, .scan)
    }

    func testCancelOnTheCameraGoesBackToChoose() async {
        let (m, _, _, _) = make(.authorized)
        await m.start()
        await m.scan()
        await m.cancel()
        XCTAssertEqual(m.state.step, .choose)
    }
}
