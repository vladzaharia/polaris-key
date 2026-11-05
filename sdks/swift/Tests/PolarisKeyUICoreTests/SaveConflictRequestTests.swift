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

    func testAKeepThatDidNotApplyIsFailedAndRetryRepeatsTheSameChoice() async {
        let calls = LockedValue<Int>(0)
        let request = open(remote: side(1_000, "Mac", version: 4)) { _ in
            let n = calls.with { c -> Int in
                c += 1
                return c
            }
            return n == 1 ? .failed(code: "conflict", reopened: true) : .kept(.local, version: 5, copyId: nil)
        }
        let m = SaveConflictModel(request: request)
        await m.keep(.local)
        XCTAssertEqual(m.step, .failed)
        XCTAssertEqual(m.conflict.keep, .local, "the failed choice stays named")
        await m.retry()
        XCTAssertEqual(m.step, .kept)
        XCTAssertEqual(calls.current, 2)
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
