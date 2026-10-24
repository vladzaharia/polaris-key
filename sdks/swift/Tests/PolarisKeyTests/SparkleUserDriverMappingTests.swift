// @pkey-feature update.driver
//
// `PolarisSparkleUserDriver` (UK-08.6): the Sparkle-call to kit-state mapping, every reply called
// once, no invented percentage and nothing after an error. No network and no window: the driver
// runs with `presentsWindow: false`, so the replies and the model are the whole surface.

#if os(macOS)
    import Foundation
    import Sparkle
    import XCTest

    import PolarisKeyUI
    import PolarisKeyUICore

    @testable import PolarisKeyUpdateUI

    @MainActor
    final class SparkleUserDriverMappingTests: XCTestCase {
        private var now = Date(timeIntervalSince1970: 1_000)

        private func driver() -> PolarisSparkleUserDriver {
            PolarisSparkleUserDriver(
                preview: KitInputs(bundle: KitBundle(slug: "tidewater", name: "Tidewater Studio")),
                options: .init(presentsWindow: false, now: { [unowned self] in self.now }))
        }

        private func item(
            version: String = "2.5.0", length: Int = 61_000_000, extra: [String: Any] = [:]
        ) throws -> SUAppcastItem {
            var dict: [String: Any] = [
                "title": "Tidewater \(version)",
                "enclosure": [
                    "url": "https://dl.example/Tidewater-\(version).zip",
                    "length": String(length), "sparkle:version": "250",
                    "sparkle:shortVersionString": version,
                    "sparkle:edSignature": "AAAA", "type": "application/octet-stream",
                ],
            ]
            for (k, v) in extra { dict[k] = v }
            return try XCTUnwrap(SUAppcastItem(dictionary: dict))
        }

        private func prompt(_ d: PolarisSparkleUserDriver) -> UpdatePromptState? {
            let screen = d.model.prompt
            return screen.state
        }

        // MARK: The mapping table

        func testFoundIsTheAvailablePrompt() throws {
            let d = driver()
            var replies: [SPUUserUpdateChoice] = []
            d.showFound(try item()) { replies.append($0) }
            XCTAssertEqual(d.model.state.kind, .found)
            XCTAssertEqual(prompt(d), .available)
            XCTAssertEqual(d.model.state.update?.version, "2.5.0")
            XCTAssertEqual(d.model.state.update?.sizeBytes, 61_000_000)
            XCTAssertTrue(replies.isEmpty, "nothing is answered for the person")
        }

        func testPermissionAsksAndNeverSendsTheProfile() {
            let d = driver()
            var out: [SUUpdatePermissionResponse] = []
            d.show(SPUUpdatePermissionRequest(systemProfile: [])) { out.append($0) }
            XCTAssertEqual(d.model.state.kind, .permission)
            XCTAssertTrue(out.isEmpty)
            d.model.handlers.allow()
            d.model.handlers.allow()
            d.model.handlers.decline()
            XCTAssertEqual(out.count, 1)
            XCTAssertTrue(out[0].automaticUpdateChecks)
            XCTAssertFalse(out[0].sendSystemProfile)
        }

        func testDecliningTheAskNeverSendsTheProfileAndClosingAnswersNothing() {
            let d = driver()
            var out: [SUUpdatePermissionResponse] = []
            d.show(SPUUpdatePermissionRequest(systemProfile: [["k": "v"]])) { out.append($0) }
            d.userCloses()  // the close button is hidden in this state: even Command-W answers nothing
            XCTAssertTrue(out.isEmpty)
            d.model.handlers.decline()
            d.model.handlers.allow()
            XCTAssertEqual(out.count, 1)
            XCTAssertFalse(out[0].automaticUpdateChecks)
            XCTAssertFalse(out[0].sendSystemProfile)
        }

        // MARK: Stage, later, install on quit, quit and install

        func testADownloadedOfferInstallsOnQuitAndHasNoSizeToDownload() throws {
            let d = driver()
            var replies: [SPUUserUpdateChoice] = []
            d.showFound(try item(), downloaded: true) { replies.append($0) }
            XCTAssertTrue(d.model.state.downloaded)
            d.model.handlers.later()  // "Install on Quit" dismisses: Sparkle installs at quit
            XCTAssertEqual(replies, [.dismiss])
            d.showReady(toInstallAndRelaunch: { _ in })
            XCTAssertTrue(d.model.state.downloaded)
        }

        func testNothingDownloadedYetIsInstallUpdate() throws {
            let d = driver()
            d.showFound(try item()) { _ in }
            XCTAssertFalse(d.model.state.downloaded)
            XCTAssertTrue(d.model.state.canLater)
        }

        func testNoLaterWithoutAutomaticChecksOrForACriticalUpdate() throws {
            let d = driver()
            d.automaticChecks = { false }
            d.showFound(try item()) { _ in }
            XCTAssertFalse(d.model.state.canLater)
            d.automaticChecks = { true }
            d.showFound(try item(extra: ["sparkle:criticalUpdate": ["sparkle:version": "1.0"]])) { _ in }
            XCTAssertFalse(d.model.state.canLater)
            XCTAssertFalse(d.model.state.canSkip)
        }

        func testAStuckInstallOffersQuitAndInstallThroughTheRetry() {
            let d = driver()
            var retries = 0
            d.showInstallingUpdate(
                withApplicationTerminated: false, retryTerminatingApplication: { retries += 1 })
            XCTAssertEqual(d.model.state.kind, .quitToInstall)
            XCTAssertEqual(retries, 0, "never called unasked")
            d.model.handlers.quitAndInstall()
            XCTAssertEqual(retries, 1)
            d.showInstallingUpdate(withApplicationTerminated: true, retryTerminatingApplication: {})
            XCTAssertEqual(d.model.state.kind, .installing)
        }

        // MARK: Errors

        func testErrorsMapToTheKitsCopyAndOnlyRetryableOnesOfferTryAgain() {
            func kind(_ domain: String, _ code: Int) -> UpdateErrorKind {
                PolarisSparkleUserDriver.errorKind(NSError(domain: domain, code: code))
            }
            XCTAssertEqual(kind("SUSparkleErrorDomain", 3001), .security)
            XCTAssertEqual(kind("SUSparkleErrorDomain", 2001), .network)
            XCTAssertEqual(kind(NSURLErrorDomain, -1009), .network)
            XCTAssertEqual(kind("SUSparkleErrorDomain", 4005), .other)
            XCTAssertFalse(UpdateErrorKind.security.canRetry)
            XCTAssertFalse(UpdateErrorKind.cannotInstall.canRetry)
            XCTAssertTrue(UpdateErrorKind.network.canRetry)
            let d = driver()
            var acks = 0
            d.showUpdaterError(
                NSError(domain: "SUSparkleErrorDomain", code: 3001), acknowledgement: { acks += 1 })
            XCTAssertEqual(d.model.state.errorKind, .security)
            d.model.handlers.done()  // Done acknowledges
            XCTAssertEqual(acks, 1)
        }

        func testSparklesTryAgainLaterSentenceIsDropped() {
            let d = driver()
            d.showUpdaterError(
                NSError(
                    domain: "SUSparkleErrorDomain", code: 4005,
                    userInfo: [NSLocalizedDescriptionKey: "The installer failed. Please try again later."]),
                acknowledgement: {})
            XCTAssertEqual(d.model.state.detail, "The installer failed.")
        }

        func testTheOffersVersionAfterRelaunch() throws {
            let d = driver()
            d.showFound(try item(version: "2.5.0")) { _ in }
            d.showUpdateInstalledAndRelaunched(true) {}
            XCTAssertEqual(d.model.state.update?.currentVersion, "2.5.0")
        }

        // MARK: Learn more opens only a safe URL

        func testLearnMoreRefusesAnyURLThatIsNotHTTPSOrLoopback() throws {
            for (url, opens) in [
                ("http://evil.example/p", false), ("file:///etc/passwd", false),
                ("javascript:alert(1)", false), ("https://tidewater.example/p", true),
                ("http://127.0.0.1:8080/p", true),
            ] {
                var opened: [URL] = []
                let d = PolarisSparkleUserDriver(
                    preview: KitInputs(bundle: KitBundle(slug: "t", name: "T")),
                    options: .init(presentsWindow: false, openURL: { opened.append($0) }))
                var replies: [SPUUserUpdateChoice] = []
                d.showFound(
                    .init(version: "2", infoURL: URL(string: url), infoOnly: true)
                ) { replies.append($0) }
                d.model.handlers.learnMore()
                XCTAssertEqual(opened.count, opens ? 1 : 0, url)
                XCTAssertEqual(replies, [.dismiss], url)
            }
        }

        func testDownloadCountsRealBytesAndTime() throws {
            let d = driver()
            d.showFound(try item()) { _ in }
            d.showDownloadInitiated {}
            now = now.addingTimeInterval(0)
            d.showDownloadDidReceiveExpectedContentLength(61_000_000)
            now = now.addingTimeInterval(4)
            d.showDownloadDidReceiveData(ofLength: 38_000_000)
            XCTAssertEqual(d.model.state.kind, .downloading)
            XCTAssertEqual(prompt(d), .downloading)
            let p = try XCTUnwrap(d.model.state.update?.progress)
            XCTAssertEqual(p.bytes, 38_000_000)
            XCTAssertEqual(p.totalBytes, 61_000_000)
            XCTAssertEqual(try XCTUnwrap(p.fraction), 38.0 / 61.0, accuracy: 1e-9)
            // 9.5 MB/s: 23 MB left is a little over two seconds, measured, not guessed.
            XCTAssertEqual(try XCTUnwrap(p.secondsLeft), 23_000_000 / 9_500_000, accuracy: 1e-6)
            XCTAssertEqual(d.model.state.update?.version, "2.5.0", "the offer stays in view")
        }

        func testExtractingAndInstallingAreIndeterminate() throws {
            let d = driver()
            d.showFound(try item()) { _ in }
            d.showDownloadDidStartExtractingUpdate()
            d.showExtractionReceivedProgress(0.5)
            XCTAssertEqual(d.model.state.kind, .extracting)
            XCTAssertEqual(d.model.progress.state, .installing)
            XCTAssertNil(d.model.state.update?.progress?.fraction)
            d.showInstallingUpdate(withApplicationTerminated: true, retryTerminatingApplication: {})
            XCTAssertEqual(d.model.state.kind, .installing)
            XCTAssertEqual(d.model.progress.state, .installing)
            XCTAssertNil(d.model.state.update?.progress?.fraction)
        }

        func testReadyIsInstallAndRelaunch() throws {
            let d = driver()
            var replies: [SPUUserUpdateChoice] = []
            d.showFound(try item()) { _ in }
            d.showReady(toInstallAndRelaunch: { replies.append($0) })
            XCTAssertEqual(d.model.state.kind, .ready)
            XCTAssertEqual(prompt(d), .ready)
            XCTAssertTrue(replies.isEmpty)
        }

        func testNotFoundIsUpToDate() {
            let d = driver()
            var acks = 0
            d.showUpdateNotFoundWithError(
                NSError(
                    domain: "SUSparkleErrorDomain", code: 1001,
                    userInfo: [SPUNoUpdateFoundReasonKey: NSNumber(value: 1)]),
                acknowledgement: { acks += 1 })
            XCTAssertEqual(d.model.state.kind, .upToDate)
            XCTAssertEqual(prompt(d), .upToDate)
            XCTAssertEqual(acks, 0)
        }

        func testAnUpdateThisMacCannotTakeIsNotUpToDate() {
            let d = driver()
            d.showUpdateNotFoundWithError(
                NSError(
                    domain: "SUSparkleErrorDomain", code: 1001,
                    userInfo: [SPUNoUpdateFoundReasonKey: NSNumber(value: 3)]),
                acknowledgement: {})
            XCTAssertEqual(d.model.state.kind, .failed)
        }

        func testAnErrorIsTheFailedCallout() {
            let d = driver()
            d.showUpdaterError(
                NSError(
                    domain: "x", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "The network connection was lost."]),
                acknowledgement: {})
            XCTAssertEqual(d.model.state.kind, .failed)
            XCTAssertEqual(d.model.progress.state, .failed)
            XCTAssertEqual(d.model.state.detail, "The network connection was lost.")
        }

        func testDismissClosesAndDropsTheUnansweredReply() throws {
            let d = driver()
            var replies = 0
            d.showFound(try item()) { _ in replies += 1 }
            d.dismissUpdateInstallation()
            d.model.handlers.install()  // a stale control after the session ended
            d.model.handlers.later()
            d.userCloses()
            XCTAssertEqual(replies, 0, "an unanswered reply is dropped with the session")
        }

        // MARK: Every reply, once

        func testFoundReplyIsCalledOnce() throws {
            let d = driver()
            var replies: [SPUUserUpdateChoice] = []
            d.showFound(try item()) { replies.append($0) }
            d.model.handlers.install()
            d.model.handlers.later()
            d.model.handlers.skip()
            XCTAssertEqual(replies, [.install])
        }

        func testClosingTheWindowAnswersTheSafeChoiceOnce() throws {
            let d = driver()
            var replies: [SPUUserUpdateChoice] = []
            d.showFound(try item()) { replies.append($0) }
            d.userCloses()
            d.userCloses()
            d.model.handlers.install()
            XCTAssertEqual(replies, [.dismiss])
        }

        func testACriticalUpdateCannotBeSkipped() throws {
            let d = driver()
            d.showFound(try item(extra: ["sparkle:criticalUpdate": ["sparkle:version": "1.0"]])) {
                _ in
            }
            XCTAssertFalse(d.model.state.canSkip)
        }

        func testCancellationAndAcknowledgementsAreCalledOnce() {
            let d = driver()
            var cancels = 0
            var acks = 0
            d.showUserInitiatedUpdateCheck { cancels += 1 }
            d.model.handlers.cancel()
            d.model.handlers.cancel()
            d.userCloses()
            XCTAssertEqual(cancels, 1)
            d.showDownloadInitiated { cancels += 1 }
            d.model.handlers.cancel()
            d.model.handlers.cancel()
            XCTAssertEqual(cancels, 2)
            d.showUpdateInstalledAndRelaunched(true) { acks += 1 }
            d.model.handlers.done()
            d.userCloses()
            XCTAssertEqual(acks, 1)
            d.showUpdaterError(NSError(domain: "x", code: 1), acknowledgement: { acks += 1 })
            d.model.handlers.tryAgain()
            d.model.handlers.tryAgain()
            d.userCloses()
            XCTAssertEqual(acks, 2)
        }

        func testReadyReplyIsCalledOnce() throws {
            let d = driver()
            var replies: [SPUUserUpdateChoice] = []
            d.showReady(toInstallAndRelaunch: { replies.append($0) })
            d.model.handlers.install()
            d.model.handlers.install()
            d.userCloses()
            XCTAssertEqual(replies, [.install])
        }

        // MARK: No invented percentage

        func testNoFractionBeforeTheTotalIsKnown() throws {
            let d = driver()
            d.showFound(try item()) { _ in }
            d.showDownloadInitiated {}
            XCTAssertNil(d.model.state.update?.progress?.fraction)
            d.showDownloadDidReceiveData(ofLength: 5_000_000)
            XCTAssertNil(d.model.state.update?.progress?.fraction)
            XCTAssertNil(d.model.state.update?.progress?.totalBytes)
            XCTAssertNil(d.model.state.update?.progress?.secondsLeft)
            d.showDownloadDidReceiveExpectedContentLength(0)
            XCTAssertNil(d.model.state.update?.progress?.fraction, "0 is not a total")
            d.showDownloadDidReceiveExpectedContentLength(UInt64.max)
            XCTAssertNil(d.model.state.update?.progress?.fraction, "the unknown-size sentinel")
        }

        func testMoreBytesThanTheTotalDropsTheBarRatherThanClampingIt() throws {
            let d = driver()
            d.showFound(try item()) { _ in }
            d.showDownloadInitiated {}
            d.showDownloadDidReceiveExpectedContentLength(1_000)
            d.showDownloadDidReceiveData(ofLength: 2_000)
            XCTAssertNil(d.model.state.update?.progress?.fraction)
        }

        func testNoTimeLeftBeforeASecondOfRate() throws {
            let d = driver()
            d.showFound(try item()) { _ in }
            d.showDownloadInitiated {}
            d.showDownloadDidReceiveExpectedContentLength(10_000)
            now = now.addingTimeInterval(0.4)
            d.showDownloadDidReceiveData(ofLength: 1_000)
            XCTAssertNotNil(d.model.state.update?.progress?.fraction)
            XCTAssertNil(d.model.state.update?.progress?.secondsLeft)
        }

        // MARK: Nothing after an error

        func testNothingShowsAfterAnErrorButTheCallout() throws {
            let d = driver()
            d.showFound(try item()) { _ in }
            d.showDownloadInitiated {}
            d.showDownloadDidReceiveExpectedContentLength(61_000_000)
            d.showDownloadDidReceiveData(ofLength: 1_000_000)
            d.showUpdaterError(NSError(domain: "x", code: 2), acknowledgement: {})
            XCTAssertEqual(d.model.state.kind, .failed)
            // Late progress from the dead session does not bring the bar back.
            d.showDownloadDidReceiveData(ofLength: 1_000_000)
            d.showDownloadDidReceiveExpectedContentLength(61_000_000)
            XCTAssertEqual(d.model.state.kind, .failed)
            XCTAssertNil(d.model.state.update?.version)
            XCTAssertNil(d.model.state.update?.notes)
            XCTAssertEqual(d.model.state.update?.progress?.phase, "failed")
        }

        // MARK: Plain notes

        func testReleaseNotesAreShownOnlyAsPlainText() throws {
            let d = driver()
            d.showFound(try item()) { _ in }
            d.showNotes(data: Data("<b>Hi</b><script>x()</script>".utf8), mimeType: "text/html")
            XCTAssertNil(d.model.state.update?.notes)
            d.showNotes(data: Data("- Stem export\n- Track freeze\n".utf8), mimeType: "text/plain")
            XCTAssertEqual(d.model.state.update?.notes, ["Stem export", "Track freeze"])
        }
    }

    extension PolarisSparkleUserDriver {
        /// The person closes the window (the close button), without a window to click.
        @MainActor func userCloses() { userClosedWindowForTests() }
    }
#endif
