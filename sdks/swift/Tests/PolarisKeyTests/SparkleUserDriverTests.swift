// @pkey-feature update.driver
//
// `PolarisSparkle.start(..., userDriver:)` (UK-08.5): an app's own `SPUUserDriver` replaces
// Sparkle's standard UI and nothing else. The anchor assertion, the delegate's feed and channels
// and the journal are the same on both paths.

#if os(macOS)
    import Foundation
    import Sparkle
    import XCTest

    @testable import PolarisKeyCore
    @testable import PolarisKeyUpdate

    @testable import PolarisKey

    /// A user driver that records the calls Sparkle makes and answers none of them.
    private final class RecordingDriver: NSObject, SPUUserDriver {
        let checked = XCTestExpectation(description: "the check reached the driver")
        nonisolated(unsafe) var erred: (any Error)?
        func show(_ request: SPUUpdatePermissionRequest) async -> SUUpdatePermissionResponse {
            SUUpdatePermissionResponse(automaticUpdateChecks: false, sendSystemProfile: false)
        }
        func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) { checked.fulfill() }
        func showUpdateFound(
            with appcastItem: SUAppcastItem, state: SPUUserUpdateState
        ) async -> SPUUserUpdateChoice { .dismiss }
        func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {}
        func showUpdateReleaseNotesFailedToDownloadWithError(_ error: any Error) {}
        func showUpdateNotFoundWithError(_ error: any Error, acknowledgement: @escaping () -> Void) {
            acknowledgement()
        }
        func showUpdaterError(_ error: any Error, acknowledgement: @escaping () -> Void) {
            erred = error
            checked.fulfill()
            acknowledgement()
        }
        func showDownloadInitiated(cancellation: @escaping () -> Void) {}
        func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) {}
        func showDownloadDidReceiveData(ofLength length: UInt64) {}
        func showDownloadDidStartExtractingUpdate() {}
        func showExtractionReceivedProgress(_ progress: Double) {}
        func showReadyToInstallAndRelaunch() async -> SPUUserUpdateChoice { .dismiss }
        func showInstallingUpdate(
            withApplicationTerminated applicationTerminated: Bool,
            retryTerminatingApplication: @escaping () -> Void
        ) {}
        func showUpdateInstalledAndRelaunched(
            _ relaunched: Bool, acknowledgement: @escaping () -> Void
        ) { acknowledgement() }
        func showUpdateInFocus() {}
        func dismissUpdateInstallation() {}
    }

    @MainActor
    final class SparkleUserDriverTests: XCTestCase {
        private func client() throws -> PolarisKeyClient {
            try PolarisKeyClient(
                options: PolarisKeyClientOptions(
                    core: CoreOptions(
                        productSlug: "djdl", baseUrl: "https://key.example", version: "1.2.3",
                        pinnedKeys: [:], store: InMemoryStore(deviceId: "d"),
                        transport: StubServer().transport)))
        }

        private func delegate(_ client: PolarisKeyClient) -> PolarisSparkleLiveDelegate {
            PolarisSparkleLiveDelegate(
                journal: client.core.journal, channel: "stable", installedVersion: "1.2.3")
        }

        func testAnInjectedDriverStillNeedsTheAnchor() async throws {
            // The test host's bundle carries no SUPublicEDKey.
            do {
                _ = try await PolarisSparkle.start(
                    client: try client(), userDriver: RecordingDriver())
                XCTFail("start must refuse a bundle without SUPublicEDKey")
            } catch {
                XCTAssertTrue(error is SparkleAnchorError)
            }
        }

        /// SPUUpdater has no public `delegate`, so the wiring is proved by its effect: the updater's
        /// feed URL is the one the delegate was given, and nothing else supplies one.
        private func assertWired(_ sparkle: PolarisSparkle) throws {
            XCTAssertNil(sparkle.updater.feedURL)
            let url = try XCTUnwrap(URL(string: "https://feed.example/appcast.xml?arch=arm64"))
            sparkle.delegate.apply(
                UpdateFeed(url: url, channel: "stable", arch: nil, allowedChannels: ["stable"]))
            XCTAssertEqual(sparkle.updater.feedURL, url)
        }

        func testNoDriverKeepsTheStandardController() throws {
            let c = try client()
            let sparkle = PolarisSparkle(client: c, channel: "stable", delegate: delegate(c))
            XCTAssertNotNil(sparkle.controller)
            XCTAssertTrue(sparkle.controller?.updater === sparkle.updater)
            try assertWired(sparkle)
        }

        func testADriverBuildsAnUpdaterWithoutAController() throws {
            let c = try client()
            let sparkle = PolarisSparkle(
                client: c, channel: "stable", delegate: delegate(c), userDriver: RecordingDriver())
            XCTAssertNil(sparkle.controller)
            try assertWired(sparkle)
        }

        /// A bundle carrying the anchor, so `start` gets past the assertion.
        private func anchoredBundle() throws -> Foundation.Bundle {
            let root = FileManager.default.temporaryDirectory
                .appendingPathComponent("pk-sparkle-\(UUID().uuidString).app")
            let contents = root.appendingPathComponent("Contents")
            try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
            let plist: [String: Any] = [
                "CFBundleIdentifier": "com.example.sparkle-driver-test",
                "CFBundleName": "Test", "CFBundleVersion": "1", "CFBundleShortVersionString": "1.0",
                "CFBundlePackageType": "APPL",
                "SUPublicEDKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
                "SUEnableAutomaticChecks": false,
            ]
            try (plist as NSDictionary).write(to: contents.appendingPathComponent("Info.plist"))
            addTeardownBlock { try? FileManager.default.removeItem(at: root) }
            return try XCTUnwrap(Foundation.Bundle(url: root))
        }

        func testAUserInitiatedCheckReachesTheInjectedDriver() async throws {
            let driver = RecordingDriver()
            let sparkle = try await PolarisSparkle.start(
                client: try client(), bundle: try anchoredBundle(), userDriver: driver)
            XCTAssertNil(sparkle.controller)
            sparkle.checkForUpdates()
            await fulfillment(of: [driver.checked], timeout: 10)
            // The stubbed discovery has no appcast, so Sparkle reports a missing feed to the
            // driver (it skips the "checking" call): the feed comes from the delegate only.
            let erred = try XCTUnwrap(driver.erred as NSError?)
            XCTAssertEqual(erred.domain, "SUSparkleErrorDomain")
            XCTAssertTrue(erred.localizedDescription.contains("SUFeedURL"))
            sparkle.stop()
        }
    }
#endif
