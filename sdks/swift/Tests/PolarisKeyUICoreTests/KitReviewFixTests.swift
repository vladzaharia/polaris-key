// @pkey-feature ui.update ui.settings ui.devices
// The UK-07 re-review's blocking findings, each pinned without a simulator: the update verb's
// route (B1), a text setting's commit (B2), what Check for updates reports (B3), and the device
// sentence for an unnamed device (B4's neighbour).

import Foundation
import PolarisKeyCore
import PolarisKeyUICore
import XCTest

@MainActor
final class KitReviewFixTests: XCTestCase {
    // MARK: B1 — the mandatory update is never a dead end

    func testAHandlerRunsTheUpdate() {
        XCTAssertEqual(
            KitUpdateRoute.resolve(hasHandler: true, update: KitUpdate(action: "binary")), .handler)
    }

    func testWithoutAHandlerTheStoreListingOpens() {
        let update = KitUpdate(
            action: "store", outlet: "app-store", listingUrl: "https://apps.apple.com/app/id1")
        XCTAssertEqual(
            KitUpdateRoute.resolve(hasHandler: false, update: update),
            .open(URL(string: "https://apps.apple.com/app/id1")!))
    }

    func testTheReleaseNotesPageIsNeverTheUpdateAction() {
        let update = KitUpdate(
            action: "binary", mandatory: true, notesUrl: "https://example.com/changes")
        XCTAssertEqual(KitUpdateRoute.resolve(hasHandler: false, update: update), .none)
        XCTAssertEqual(KitUpdateRoute.resolve(hasHandler: false, update: nil), .none)
    }

    func testAListingThatIsNotHttpsDoesNotOpen() {
        let update = KitUpdate(action: "store", listingUrl: "http://example.com/app")
        XCTAssertEqual(KitUpdateRoute.resolve(hasHandler: false, update: update), .none)
    }

    func testTheMandatoryVerbFollowsTheOutlet() {
        XCTAssertEqual(KitStates.outletVerb("app-store"), CopyLine("update.appStore"))
        XCTAssertEqual(KitStates.outletVerb("play"), CopyLine("update.googlePlay"))
        XCTAssertNil(KitStates.outletVerb("web"))
        XCTAssertNil(KitStates.outletVerb(nil))
    }

    func testWithNothingToOpenTheScreenSaysWhereToUpdate() {
        XCTAssertEqual(
            KitStates.whereToUpdate(outlet: "app-store", product: "Tidewater Studio"),
            CopyLine("update.appStore"))
        let generic = KitStates.whereToUpdate(outlet: nil, product: "Tidewater Studio")
        XCTAssertEqual(generic.key, "update.platform.generic")
        XCTAssertEqual(KitCopy.bundled.format(generic, locale: "en").contains("Tidewater Studio"), true)
    }

    // MARK: B2 — a text setting is reported once, on Return or on blur

    func testAnEditIsReportedOnceHoweverItEnds() {
        var log = KitCommitLog()
        let old = KitConfigValue.string("Mara")
        let new = KitConfigValue.string("Marie")
        XCTAssertTrue(log.shouldCommit(key: "name", value: new, rowValue: old))
        // Return, then focus leaving: the same value is not sent again.
        XCTAssertFalse(log.shouldCommit(key: "name", value: new, rowValue: old))
    }

    func testABlurWithNoEditSendsNothing() {
        var log = KitCommitLog()
        XCTAssertFalse(log.shouldCommit(key: "name", value: nil, rowValue: .string("Mara")))
        XCTAssertFalse(
            log.shouldCommit(key: "name", value: .string("Mara"), rowValue: .string("Mara")))
    }

    func testAResetMakesTheNextEditNew() {
        var log = KitCommitLog()
        let edit = KitConfigValue.number(7)
        XCTAssertTrue(log.shouldCommit(key: "n", value: edit, rowValue: .number(1)))
        log.forget("n")
        XCTAssertTrue(log.shouldCommit(key: "n", value: edit, rowValue: .number(1)))
    }

    // MARK: B3 — a failed check is never "up to date"

    func testAFailedDocumentIsAFailedCheck() {
        var sync = SyncResult()
        sync.documents = [.license: .unchanged, .config: .error]
        XCTAssertEqual(PolarisKeySettingsModel.CheckOutcome.resolve(sync: sync, probe: .upToDate), .failed)
    }

    func testARefusedSyncIsAFailedCheck() {
        var unauthorized = SyncResult()
        unauthorized.unauthorized = true
        var deviceCap = SyncResult()
        deviceCap.deviceCap = true
        for sync in [unauthorized, deviceCap] {
            XCTAssertEqual(PolarisKeySettingsModel.CheckOutcome.resolve(sync: sync, probe: nil), .failed)
        }
    }

    func testTheUpdateServicesAnswerDecidesTheRest() {
        var ok = SyncResult()
        ok.documents = [.license: .unchanged]
        typealias Outcome = PolarisKeySettingsModel.CheckOutcome
        XCTAssertEqual(Outcome.resolve(sync: ok, probe: .failed), .failed)
        XCTAssertEqual(Outcome.resolve(sync: ok, probe: .offered("2.5.0")), .offered)
        XCTAssertEqual(Outcome.resolve(sync: ok, probe: .upToDate), .upToDate)
        // No signed update decision configured: the sync is the whole answer.
        XCTAssertEqual(Outcome.resolve(sync: ok, probe: nil), .upToDate)
    }

    // MARK: Devices — an unnamed device reads naturally in a failure

    func testAnUnnamedDeviceIsNamedInTheFailureSentence() {
        XCTAssertEqual(
            PolarisKeySettingsModel.deviceArgument(nil), .line(CopyLine("devices.unnamed")))
        XCTAssertEqual(PolarisKeySettingsModel.deviceArgument(""), .line(CopyLine("devices.unnamed")))
        XCTAssertEqual(PolarisKeySettingsModel.deviceArgument("Mara's Mac"), .text("Mara's Mac"))
        let line = CopyLine(
            "devices.removeFailed", ["device": PolarisKeySettingsModel.deviceArgument(nil)])
        XCTAssertEqual(
            KitCopy.bundled.format(line, locale: "en"), "Couldn't remove Unnamed device. Try again.")
    }

    // MARK: Toast — the update re-offer brings the banner back

    func testTheReofferToastReturnsTheBanner() {
        let model = PolarisKeyGateModel(preview: PolarisKeyPreviewState.base())
        model.deferUpdate()
        XCTAssertTrue(model.updateDismissed)
        model.reofferUpdate()
        XCTAssertFalse(model.updateDismissed)
        XCTAssertNil(model.toast)
    }

    // MARK: Update — Restart when ready leads, Later follows

    func testWhileDownloadingRestartWhenReadyComesBeforeLater() {
        let screen = KitStates.updatePrompt(
            PolarisKeyPreviewState.base {
                $0.update = KitUpdate(
                    action: "binary", version: "2.5.0",
                    progress: KitUpdateProgress(phase: "download", fraction: 0.4))
            })
        XCTAssertEqual(screen.state, .downloading)
        let keys = screen.copy.map(\.key)
        let restart = keys.firstIndex(of: "update.restartWhenReady")
        let later = keys.firstIndex(of: "update.later")
        XCTAssertNotNil(restart)
        XCTAssertNotNil(later)
        XCTAssertLessThan(restart!, later!)
    }

    /// The download's time left rounds up to whole minutes: "About 5 min", never "4:12".
    func testTimeLeftRoundsUpToWholeMinutes() {
        XCTAssertEqual(KitFormat.timeLeftLine(20), CopyLine("common.updateTimeLessThanMinute"))
        XCTAssertEqual(
            KitFormat.timeLeftLine(60), CopyLine("common.updateTimeMinutes", ["minutes": 1]))
        XCTAssertEqual(
            KitFormat.timeLeftLine(252), CopyLine("common.updateTimeMinutes", ["minutes": 5]))
    }
}
