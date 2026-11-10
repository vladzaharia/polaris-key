// @pkey-feature sync.conflict
// @pkey-feature ui.settings
// The SaveConflict screen bound to a MergeRequest (U-08.K3): the model reads both copies from the request,
// answers the choice with `request.keep`, and a keep that did not apply is `failed`, not lost. The request is
// a saves-style one (the registry's own `open`), so no client is needed.

import Foundation
import PolarisKeyCore
import XCTest

@testable import PolarisKey
@testable import PolarisKeyUICore

@MainActor
final class SaveConflictRequestTests: XCTestCase {
    /// A request holds its registry weakly, so the registry outlives the request here.
    private let registry = MergeRegistry()

    private func side(_ savedAt: Int?, _ device: String?, version: Int) -> MergeSide {
        MergeSide(
            value: .object(["chapter": .string("One")]), version: version, savedAt: savedAt, device: device,
            file: MergeFile(size: 12, format: .whole))
    }

    private func open(
        remote: MergeSide?, choices: [SyncMergeChoice] = [.local, .remote, .both],
        keep: @escaping @Sendable (MergeKeep) async -> MergeOutcome
    ) -> MergeRequest {
        let view = MergeView(
            id: "w:saves/slot1", cause: .write, collection: "saves", record: "slot1",
            local: side(2_000, "Steam Deck", version: 3), remote: remote, choices: choices, state: .open, error: nil)
        return registry.open(view, backend: keep)
    }

    func testTheConflictReadsBothCopiesAndWhichIsNewer() {
        let request = open(remote: side(1_000, "Mac", version: 4)) { _ in .kept(.local, version: 5, copyId: nil) }
        let c = KitSaveConflict(request: request)
        XCTAssertEqual(c.step, .choose)
        XCTAssertEqual(c.local?.device, "Steam Deck")
        XCTAssertEqual(c.remote?.device, "Mac")
        XCTAssertNotNil(c.local?.when)
        XCTAssertFalse(c.remoteDeleted)
        XCTAssertEqual(c.bothAvailable, true)
        XCTAssertEqual(c.newer, .local)
    }

    func testTheHostsDescribeOverridesHowACopyReads() {
        let request = open(remote: side(1_000, "Mac", version: 4)) { _ in .kept(.local, version: 5, copyId: nil) }
        let c = KitSaveConflict(request: request) { s in
            KitSaveConflict.Copy(when: "v\(s.version ?? 0)", device: s.device)
        }
        XCTAssertEqual(c.local?.when, "v3")
        XCTAssertEqual(c.remote?.when, "v4")
    }

    func testADeletedOtherCopyAndAFullSlotTable() {
        let request = open(remote: nil, choices: [.local, .remote]) { _ in .kept(.remote, version: nil, copyId: nil) }
        let c = KitSaveConflict(request: request)
        XCTAssertTrue(c.remoteDeleted)
        XCTAssertNil(c.remote)
        XCTAssertEqual(c.bothAvailable, false)
    }

    func testAChoiceIsAnsweredWithRequestKeepAndKeptNamesIt() async {
        let asked = LockedValue<[SyncMergeChoice]>([])
        let request = open(remote: side(1_000, "Mac", version: 4)) { choice in
            asked.with { $0.append(choice.choice) }
            return .kept(choice.choice, version: 5, copyId: choice == .both ? "slot1.copy" : nil)
        }
        let m = SaveConflictModel(request: request)
        var kept: KitSaveConflict.Keep?
        m.onKept = { kept = $0 }
        await m.keep(.both)
        await m.keep(.remote)  // already kept: ignored
        XCTAssertEqual(asked.current, [.both])
        XCTAssertEqual(kept, .both)
        XCTAssertEqual(m.step, .kept)
    }

    func testAKeepThatFailedIsFailedAndRetryRepeatsTheSameChoice() async {
        let calls = LockedValue<Int>(0)
        let request = open(remote: side(1_000, "Mac", version: 4)) { _ in
            let n = calls.with { c -> Int in
                c += 1
                return c
            }
            return n == 1 ? .failed(code: "offline", reopened: true) : .kept(.local, version: 5, copyId: nil)
        }
        let m = SaveConflictModel(request: request)
        await m.keep(.local)
        XCTAssertEqual(m.step, .failed)
        XCTAssertEqual(m.conflict.keep, .local, "the failed choice stays named")
        await m.retry()
        XCTAssertEqual(m.step, .kept)
        XCTAssertEqual(calls.current, 2)
    }

    /// keep, then a third write: back to the choices on the new remote, nothing applied, and a line says so.
    func testAKeepThatMeetsANewerCopyGoesBackToChooseOnTheNewRemote() async {
        let calls = LockedValue<Int>(0)
        let box = LockedValue<MergeRequest?>(nil)
        let request = open(remote: side(1_000, "Mac", version: 4)) { [registry] _ in
            calls.with { $0 += 1 }
            // The other device saved again while the keep ran: the request reopens with its new side.
            registry.update("w:saves/slot1") { $0.remote = MergeSide(
                value: .object([:]), version: 5, savedAt: 9_000, device: "Mac", file: nil) }
            return .failed(code: "conflict", reopened: true)
        }
        box.with { $0 = request }
        let m = SaveConflictModel(request: request)
        XCTAssertEqual(m.conflict.newer, .local)
        await m.keep(.local)
        XCTAssertEqual(m.step, .choose, "never failed: a Try again would overwrite a copy nobody saw")
        XCTAssertNil(m.conflict.keep)
        XCTAssertEqual(m.conflict.reopened, true)
        XCTAssertEqual(m.conflict.newer, .remote)
        XCTAssertEqual(m.conflict.remote?.when, KitSaveConflict.copy(of: request.remote!).when)
        XCTAssertEqual(calls.current, 1, "nothing ran again by itself")
        XCTAssertTrue(m.screen.copy.contains { $0.key == "saveConflict.reopened" })
        await m.retry()
        XCTAssertEqual(calls.current, 1, "Try again is for a failure only: after a reopen it sends nothing")
        XCTAssertEqual(m.step, .choose)
    }

    func testChooseAgainReadsTheRequestAgain() async {
        let request = open(remote: side(1_000, "Mac", version: 4)) { _ in .failed(code: "offline", reopened: true) }
        let m = SaveConflictModel(request: request)
        await m.keep(.local)
        XCTAssertEqual(m.step, .failed)
        registry.update("w:saves/slot1") { $0.remote = nil }
        m.chooseAgain()
        XCTAssertEqual(m.step, .choose)
        XCTAssertTrue(m.isDeletion, "the cards are the request's, not the ones the screen opened with")
    }

    func testAClosedRequestClosesTheScreen() async {
        let request = open(remote: side(1_000, "Mac", version: 4)) { _ in MergeRegistry.closedOutcome }
        let m = SaveConflictModel(request: request)
        var closed = false
        m.onClosed = { closed = true }
        await m.keep(.local)
        XCTAssertTrue(closed)
        XCTAssertNotEqual(m.step, .failed)
    }

    func testTheDefaultWhenIsAWordedDayOrAShortDate() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let en = Locale(identifier: "en_US")
        func ms(_ y: Int, _ mo: Int, _ d: Int, _ h: Int, _ mi: Int) -> Int {
            Int(cal.date(from: DateComponents(year: y, month: mo, day: d, hour: h, minute: mi))!.timeIntervalSince1970 * 1000)
        }
        let now = cal.date(from: DateComponents(year: 2026, month: 11, day: 5, hour: 12, minute: 0))!
        let today = KitSaveConflict.worded(savedAt: ms(2026, 11, 5, 10, 42), now: now, locale: en, calendar: cal)
        XCTAssertTrue(today.hasPrefix("today"), today)
        XCTAssertTrue(today.contains("10:42"), today)
        XCTAssertTrue(KitSaveConflict.worded(savedAt: ms(2026, 11, 4, 21, 40), now: now, locale: en, calendar: cal).hasPrefix("yesterday"))
        let sameYear = KitSaveConflict.worded(savedAt: ms(2026, 10, 30, 10, 12), now: now, locale: en, calendar: cal)
        XCTAssertTrue(sameYear.contains("Oct 30") && !sameYear.contains("2026"), sameYear)
        let other = KitSaveConflict.worded(savedAt: ms(2025, 10, 30, 10, 12), now: now, locale: en, calendar: cal)
        XCTAssertTrue(other.contains("2025"), other)
        let de = KitSaveConflict.worded(savedAt: ms(2026, 11, 5, 10, 42), now: now, locale: Locale(identifier: "de_DE"), calendar: cal)
        XCTAssertTrue(de.hasPrefix("heute"), de)
    }

    func testAClosedRequestFailsTheScreenWithoutLosingTheChoice() async {
        let request = open(remote: side(1_000, "Mac", version: 4)) { _ in MergeRegistry.closedOutcome }
        let host = SaveConflictHost(request: request)
        do {
            try await host.keep(.local)
            XCTFail("a closed request applies nothing")
        } catch let error as SaveConflictKeepError {
            XCTAssertEqual(error.code, "sync-merge-closed")
        } catch {
            XCTFail("\(error)")
        }
    }
}
