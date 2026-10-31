// @pkey-feature ui.settings
// The SaveConflict model and the CloudSyncStatus transfer states beyond the matrix rows (U-22 K.3):
// the step machine, "applied once", Retry repeating the same choice, `remote: null` versus an absent
// `remote`, the disabled Keep both, and a pending transfer never reading as synced.

import PolarisKeyUICore
import XCTest

@MainActor
final class SaveConflictModelTests: XCTestCase {
    private func conflict(
        remote: KitSaveConflict.Copy? = .init(when: "yesterday, 21:40", device: "Maya's Steam Deck"),
        deleted: Bool = false, both: Bool? = true
    ) -> KitSaveConflict {
        KitSaveConflict(
            step: .choose, local: .init(when: "today, 14:02"), remote: remote,
            remoteDeleted: deleted, bothAvailable: both)
    }

    func testChooseTakesNoDefaultAndOffersEveryWayOn() {
        let m = SaveConflictModel(conflict: conflict())
        XCTAssertEqual(m.screen.stateName, "choose")
        XCTAssertEqual(m.screen.actions, [.cancel, .keepBoth, .keepLocal, .keepRemote])
        XCTAssertTrue(m.screen.disabledActions.isEmpty)
        XCTAssertEqual(
            m.screen.line("saveConflict.otherDevice")?.args["device"], .text("Maya's Steam Deck"))
        XCTAssertEqual(m.screen.line("saveConflict.savedThis")?.args["when"], .text("today, 14:02"))
    }

    func testKeepBothIsDisabledWithItsReasonWhenEverySlotIsInUse() async {
        for both in [false, nil] as [Bool?] {
            let m = SaveConflictModel(conflict: conflict(both: both))
            XCTAssertTrue(m.screen.shows("saveConflict.keepBoth"))
            XCTAssertTrue(m.screen.shows("saveConflict.bothFull"))
            XCTAssertFalse(m.screen.offers(.keepBoth))
            XCTAssertEqual(m.screen.disabledActions, [.keepBoth])
            await m.keep(.both)
            XCTAssertEqual(m.step, .choose, "a disabled choice does nothing")
        }
    }

    func testADeletionHasItsOwnTitleLedeAndButton() async {
        let m = SaveConflictModel(conflict: conflict(remote: nil, deleted: true))
        XCTAssertTrue(m.isDeletion)
        XCTAssertTrue(m.screen.shows("saveConflict.deletedTitle"))
        XCTAssertTrue(m.screen.shows("saveConflict.deletedLede"))
        XCTAssertTrue(m.screen.shows("saveConflict.acceptDelete"))
        XCTAssertFalse(m.screen.shows("saveConflict.title"))
        XCTAssertFalse(m.screen.shows("saveConflict.keepOther"))
        XCTAssertFalse(m.screen.shows("saveConflict.keepBoth"))
        XCTAssertFalse(m.screen.shows("saveConflict.bothFull"))
        await m.keep(.both)
        XCTAssertEqual(m.step, .choose, "nothing to copy")
        await m.keep(.remote)
        XCTAssertTrue(m.screen.shows("saveConflict.keptDeleted"))
    }

    func testAnAbsentRemoteIsNotADeletion() throws {
        let absent = try JSONDecoder().decode(
            KitSaveConflict.self, from: Data(#"{"step":"choose","local":{"when":"x"}}"#.utf8))
        XCTAssertFalse(absent.remoteDeleted)
        let null = try JSONDecoder().decode(
            KitSaveConflict.self,
            from: Data(#"{"step":"choose","local":{"when":"x"},"remote":null}"#.utf8))
        XCTAssertTrue(null.remoteDeleted)
        let again = try JSONDecoder().decode(KitSaveConflict.self, from: JSONEncoder().encode(null))
        XCTAssertEqual(again, null)
    }

    func testAChoiceIsAppliedOnceAndKeptNamesIt() async {
        let calls = Calls()
        let m = SaveConflictModel(
            conflict: conflict(), host: SaveConflictHost { await calls.add($0); })
        var kept: KitSaveConflict.Keep?
        m.onKept = { kept = $0 }
        await m.keep(.local)
        await m.keep(.remote)  // already kept: ignored
        let applied = await calls.all
        XCTAssertEqual(applied, [.local])
        XCTAssertEqual(kept, .local)
        XCTAssertEqual(m.screen.stateName, "kept")
        XCTAssertTrue(m.screen.shows("saveConflict.keptLocal"))
        XCTAssertFalse(m.screen.shows("saveConflict.keptRemote"))
        XCTAssertEqual(m.screen.actions, [])
    }

    func testAFailedChoiceNeverSaysKeptAndRetryRepeatsTheSameChoice() async {
        let calls = Calls(failFirst: true)
        let m = SaveConflictModel(
            conflict: conflict(), host: SaveConflictHost { try await calls.try($0) })
        await m.keep(.remote)
        XCTAssertEqual(m.screen.stateName, "failed")
        XCTAssertTrue(m.screen.shows("saveConflict.failed"))
        XCTAssertFalse(m.screen.copyKeys.contains { $0.hasPrefix("saveConflict.kept") })
        XCTAssertEqual(m.screen.actions, [.cancel, .retry])
        await m.retry()
        let applied = await calls.all
        XCTAssertEqual(applied, [.remote, .remote])
        XCTAssertEqual(m.screen.stateName, "kept")
        XCTAssertTrue(m.screen.shows("saveConflict.keptRemote"))
    }

    func testCancelAndDoneAreOnlyForTheirSteps() async {
        let m = SaveConflictModel(conflict: conflict())
        var cancelled = 0
        var done = 0
        m.onCancel = { cancelled += 1 }
        m.onDone = { done += 1 }
        m.done()
        XCTAssertEqual(done, 0)
        m.cancel()
        XCTAssertEqual(cancelled, 1)
        await m.keep(.local)
        m.cancel()
        XCTAssertEqual(cancelled, 1, "kept has no Cancel")
        m.done()
        XCTAssertEqual(done, 1)
    }

    func testHiddenWhenCloudSyncIsOff() {
        var inputs = KitInputs()
        inputs.services = [.license]
        let m = SaveConflictModel(conflict: conflict(), inputs: inputs)
        XCTAssertTrue(m.screen.isHidden)
    }

    // MARK: CloudSyncStatus transfer states

    func testAPendingTransferNeverReadsAsSynced() {
        for state in [KitCloudSync.State.transferring, .waiting, .transferFailed] {
            var inputs = KitInputs()
            inputs.cloudSync = KitCloudSync(state: state, lastSynced: "2 min ago")
            let screen = KitStates.cloudSyncStatus(inputs)
            XCTAssertFalse(screen.shows("cloudSync.synced"), "\(state)")
            XCTAssertFalse(screen.copyKeys.contains("cloudSync.synced"))
        }
    }

    func testTheProgressLineNeedsBothSizes() {
        var inputs = KitInputs()
        inputs.cloudSync = KitCloudSync(state: .transferring, transfer: .init(size: "38 MB"))
        XCTAssertFalse(KitStates.cloudSyncStatus(inputs).shows("cloudSync.transferProgress"))
        inputs.cloudSync = KitCloudSync(
            state: .transferring, transfer: .init(size: "38 MB", total: "61 MB", fraction: 0.62))
        let line = KitStates.cloudSyncStatus(inputs).line("cloudSync.transferProgress")
        XCTAssertEqual(line?.args["size"], .text("38 MB"))
        XCTAssertEqual(line?.args["total"], .text("61 MB"))
    }

    func testWaitingNamesItsReason() {
        let keys: [KitCloudSync.Reason?: String] = [
            nil: "cloudSync.waitingNetwork", .network: "cloudSync.waitingNetwork",
            .battery: "cloudSync.waitingBattery", .background: "cloudSync.waitingBackground",
        ]
        for (reason, key) in keys {
            var inputs = KitInputs()
            inputs.cloudSync = KitCloudSync(state: .waiting, reason: reason)
            XCTAssertEqual(KitStates.cloudSyncStatus(inputs).copyKeys, [key])
        }
    }

    func testTransferFailedOffersTryAgain() {
        var inputs = KitInputs()
        inputs.cloudSync = KitCloudSync(state: .transferFailed)
        XCTAssertEqual(KitStates.cloudSyncStatus(inputs).actions, [.retry])
    }
}

private actor Calls {
    private(set) var all: [KitSaveConflict.Keep] = []
    private var failFirst: Bool
    struct Failed: Error {}
    init(failFirst: Bool = false) { self.failFirst = failFirst }
    func add(_ keep: KitSaveConflict.Keep) { all.append(keep) }
    func `try`(_ keep: KitSaveConflict.Keep) throws {
        all.append(keep)
        if failFirst {
            failFirst = false
            throw Failed()
        }
    }
}
