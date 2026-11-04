// @pkey-feature connect.links connect.transfer
// LinkPairingModel and TransferOfferModel (CC-19.10) over fake drivers: the order of the steps, one device
// at a time, a failure nobody saw changing nothing, a late answer from a closed window dropped (the epoch),
// and a transfer answered once.

import Foundation
import PolarisKeyUICore
import XCTest

private final class Log: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String] = []
    func add(_ s: String) { lock.withLock { items.append(s) } }
    var all: [String] { lock.withLock { items } }
}

private final class PairingRig: @unchecked Sendable {
    let log = Log()
    private let lock = NSLock()
    private var events: LinkPairingEvents?
    var failWith: Error?

    var driver: LinkPairingDriver {
        LinkPairingDriver(
            pair: { [self] _, _, _, events in
                if let failWith { throw failWith }
                lock.withLock { self.events = events }
                log.add("open")
                return { [log] in log.add("stop") }
            },
            isUnavailable: { ($0 as? Off) != nil })
    }

    struct Off: Error {}

    func offer(_ code: String, label: String? = "Maya's laptop") -> LinkPairingOffer {
        LinkPairingOffer(
            label: label, code: code, categories: ["photos"],
            confirm: { [log] in log.add("confirm \(code)") },
            decline: { [log] in log.add("decline \(code)") })
    }

    var current: LinkPairingEvents { lock.withLock { events! } }
}

@MainActor
final class LinkPairingModelTests: XCTestCase {
    private func settle() async { for _ in 0..<5 { await Task.yield() } }

    private func model(_ rig: PairingRig) -> LinkPairingModel {
        LinkPairingModel(driver: rig.driver, categories: ["photos"], label: "My Mac")
    }

    func testIdleIsHiddenAndStartOpensTheWindow() async {
        let rig = PairingRig()
        let m = model(rig)
        XCTAssertEqual(m.screen.stateName, "hidden")
        await m.start()
        XCTAssertEqual(m.screen.stateName, "open")
        XCTAssertEqual(rig.log.all, ["open"])
    }

    func testACodeConfirmAndLink() async {
        let rig = PairingRig()
        let m = model(rig)
        await m.start()
        rig.current.onCode(rig.offer("123 456"))
        await settle()
        XCTAssertEqual(m.screen.stateName, "code")
        XCTAssertEqual(m.link?.device, "Maya's laptop")
        XCTAssertEqual(m.link?.code, "123 456")
        await m.confirm()
        XCTAssertEqual(m.screen.stateName, "confirm")
        XCTAssertEqual(m.link?.code, "123 456", "the code stays through confirm")
        XCTAssertTrue(rig.log.all.contains("confirm 123 456"))
        var told = 0
        m.onLinked = { told += 1 }
        rig.current.onLinked("Maya's laptop", ["photos"])
        await settle()
        XCTAssertEqual(m.screen.stateName, "linked")
        XCTAssertEqual(told, 1)
    }

    func testASecondDeviceMeanwhileIsDeclined() async {
        let rig = PairingRig()
        let m = model(rig)
        await m.start()
        rig.current.onCode(rig.offer("111 111"))
        await settle()
        rig.current.onCode(rig.offer("222 222", label: "Other"))
        await settle()
        XCTAssertEqual(m.link?.code, "111 111")
        XCTAssertTrue(rig.log.all.contains("decline 222 222"))
    }

    func testDeclineReturnsToTheOpenWindow() async {
        let rig = PairingRig()
        let m = model(rig)
        await m.start()
        rig.current.onCode(rig.offer("123 456"))
        await settle()
        await m.decline()
        XCTAssertEqual(m.screen.stateName, "open")
        XCTAssertTrue(rig.log.all.contains("decline 123 456"))
        XCTAssertFalse(rig.log.all.contains("stop"), "the window stays open for the next device")
    }

    func testAFailureNobodySawChangesNothing() async {
        let rig = PairingRig()
        let m = model(rig)
        await m.start()
        rig.current.onFailed(.timeout)
        await settle()
        XCTAssertEqual(m.screen.stateName, "open")
        rig.current.onCode(rig.offer("123 456"))
        await settle()
        rig.current.onFailed(.declined)
        await settle()
        XCTAssertEqual(m.screen.stateName, "failed")
        XCTAssertEqual(m.link?.reason, .declined)
    }

    func testALateAnswerFromAClosedWindowIsDropped() async {
        let rig = PairingRig()
        let m = model(rig)
        await m.start()
        let old = rig.current
        await m.cancel()
        XCTAssertEqual(m.screen.stateName, "hidden")
        XCTAssertTrue(rig.log.all.contains("stop"))
        old.onCode(rig.offer("999 999"))
        old.onLinked("Maya's laptop", ["photos"])
        await settle()
        XCTAssertEqual(m.screen.stateName, "hidden", "an old window cannot draw a screen")
    }

    func testTryAgainOpensANewWindowAndTheOldOneIsDropped() async {
        let rig = PairingRig()
        let m = model(rig)
        await m.start()
        let old = rig.current
        await m.start()
        old.onCode(rig.offer("111 111"))
        await settle()
        XCTAssertEqual(m.screen.stateName, "open")
        XCTAssertEqual(rig.log.all.filter { $0 == "open" }.count, 2)
    }

    func testLinksOffIsItsOwnState() async {
        let rig = PairingRig()
        rig.failWith = PairingRig.Off()
        let m = model(rig)
        await m.start()
        XCTAssertEqual(m.screen.stateName, "unavailable")
    }

    func testAnyOtherFailureToOpenIsAClosedFailure() async {
        struct Boom: Error {}
        let rig = PairingRig()
        rig.failWith = Boom()
        let m = model(rig)
        await m.start()
        XCTAssertEqual(m.screen.stateName, "failed")
        XCTAssertEqual(m.link?.reason, .closed)
    }

    func testFinishClosesTheWindowThenTellsTheHost() async {
        let rig = PairingRig()
        let m = model(rig)
        var closed = 0
        m.onClose = { closed += 1 }
        await m.start()
        await m.finish()
        XCTAssertEqual(closed, 1)
        XCTAssertEqual(m.screen.stateName, "hidden")
    }
}

@MainActor
final class TransferOfferModelTests: XCTestCase {
    private func driver(_ log: Log, accept: @escaping @Sendable () async throws -> Void = {}) -> TransferOfferDriver {
        TransferOfferDriver(
            accept: {
                log.add("accept")
                try await accept()
            },
            decline: { log.add("decline") },
            cancel: { log.add("cancel") })
    }

    private let offer = KitTransferOffer(step: .ask, name: "holiday.zip", device: "Maya's laptop")

    func testAcceptReceivesThenIsDone() async {
        let log = Log()
        let m = TransferOfferModel(offer: offer, driver: driver(log))
        await m.accept()
        XCTAssertEqual(m.screen.stateName, "done")
        XCTAssertEqual(log.all, ["accept"])
    }

    func testAnAnswerIsGivenOnce() async {
        let log = Log()
        let m = TransferOfferModel(offer: offer, driver: driver(log))
        await m.accept()
        await m.accept()
        await m.decline()
        XCTAssertEqual(log.all, ["accept"])
    }

    func testDeclineClosesAndAnswersOnce() async {
        let log = Log()
        let m = TransferOfferModel(offer: offer, driver: driver(log))
        var closed = 0
        m.onClose = { closed += 1 }
        await m.decline()
        await m.decline()
        XCTAssertEqual(m.screen.stateName, "hidden")
        XCTAssertEqual(log.all, ["decline"])
        XCTAssertEqual(closed, 1)
    }

    func testAFailedTransferSaysNothingWasSaved() async {
        struct Boom: Error {}
        let log = Log()
        let m = TransferOfferModel(offer: offer, driver: driver(log, accept: { throw Boom() }))
        await m.accept()
        XCTAssertEqual(m.screen.stateName, "failed")
        XCTAssertTrue(m.screen.shows("transferOffer.failedBody"))
    }

    func testCancelStopsATransferInFlight() async {
        let log = Log()
        let gate = AsyncStream<Void>.makeStream()
        let m = TransferOfferModel(
            offer: offer, driver: driver(log, accept: { for await _ in gate.stream { break } }))
        let accepting = Task { await m.accept() }
        for _ in 0..<20 where m.screen.stateName != "receiving" { await Task.yield() }
        XCTAssertEqual(m.screen.stateName, "receiving")
        await m.cancel()
        XCTAssertEqual(m.screen.stateName, "failed")
        XCTAssertTrue(log.all.contains("cancel"))
        gate.continuation.yield()
        await accepting.value
        XCTAssertEqual(m.screen.stateName, "failed", "a late finish cannot turn a cancel into done")
    }

    func testCancelDoesNothingBeforeAccept() async {
        let log = Log()
        let m = TransferOfferModel(offer: offer, driver: driver(log))
        await m.cancel()
        XCTAssertEqual(m.screen.stateName, "ask")
        XCTAssertEqual(log.all, [])
    }

    func testAWithdrawnOfferClosesWithoutAnAnswer() async {
        let log = Log()
        let m = TransferOfferModel(offer: offer, driver: driver(log))
        m.withdraw()
        XCTAssertEqual(m.screen.stateName, "hidden")
        XCTAssertEqual(log.all, [])
    }

    func testLongNamesAreElidedInTheMiddleOfTheTitle() {
        let name = String(repeating: "a", count: 100) + ".zip"
        let m = TransferOfferModel(offer: KitTransferOffer(step: .ask, name: name))
        let title = m.screen.copy.first
        guard case .text(let shown) = title?.args["name"] else { return XCTFail("no name") }
        XCTAssertLessThanOrEqual(shown.count, 40)
        XCTAssertTrue(shown.hasSuffix(".zip"))
        XCTAssertTrue(shown.contains("…"))
        XCTAssertEqual(kitShortName("short.txt"), "short.txt")
    }

    func testCategoryFallback() {
        XCTAssertEqual(kitCategoryFallback("photos"), "Photos")
        XCTAssertEqual(kitCategoryFallback("tax-forms"), "Tax forms")
        XCTAssertEqual(kitCategoryFallback("voice_memos"), "Voice memos")
    }
}
