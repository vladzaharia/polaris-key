// @pkey-feature update.driver
//
// DB-3: a host delegate and a relaunch gate on `PolarisSparkle.start`, and the sandbox check.

import Foundation
import XCTest

@testable import PolarisKeyUpdate

#if os(macOS)
    import Sparkle
    @testable import PolarisKeyCore
    @testable import PolarisKey
    import PolarisKeyUI

    private final class HostDelegate: NSObject, SPUUpdaterDelegate, @unchecked Sendable {
        let calls = LockedValue<[String]>([])
        var postpone = false
        var resume: (() -> Void)?
        func feedURLString(for updater: SPUUpdater) -> String? {
            calls.with { $0.append("feed") }
            return "https://host.example/feed.xml"
        }
        func allowedChannels(for updater: SPUUpdater) -> Set<String> {
            calls.with { $0.append("channels") }
            return ["host"]
        }
        func updater(_ updater: SPUUpdater, didDownloadUpdate item: SUAppcastItem) {
            calls.with { $0.append("download") }
        }
        func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
            calls.with { $0.append("install") }
        }
        func updaterWillRelaunchApplication(_ updater: SPUUpdater) {
            calls.with { $0.append("relaunching") }
        }
        func updater(
            _ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem,
            untilInvokingBlock installHandler: @escaping () -> Void
        ) -> Bool {
            calls.with { $0.append("postpone") }
            resume = installHandler
            return postpone
        }
    }

    private final class SilentDriver: NSObject, SPUUserDriver {
        func show(_ request: SPUUpdatePermissionRequest) async -> SUUpdatePermissionResponse {
            SUUpdatePermissionResponse(automaticUpdateChecks: false, sendSystemProfile: false)
        }
        func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {}
        func showUpdateFound(with appcastItem: SUAppcastItem, state: SPUUserUpdateState) async
            -> SPUUserUpdateChoice
        { .dismiss }
        func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {}
        func showUpdateReleaseNotesFailedToDownloadWithError(_ error: any Error) {}
        func showUpdateNotFoundWithError(_ error: any Error, acknowledgement: @escaping () -> Void) {
            acknowledgement()
        }
        func showUpdaterError(_ error: any Error, acknowledgement: @escaping () -> Void) {
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
    final class SparkleHostDelegateTests: XCTestCase {
        private func client() throws -> PolarisKeyClient {
            try PolarisKeyClient(
                options: PolarisKeyClientOptions(
                    core: CoreOptions(
                        productSlug: "djdl", baseUrl: "https://key.example", version: "1.2.3",
                        pinnedKeys: [:], store: InMemoryStore(deviceId: "d"),
                        transport: StubServer().transport)))
        }

        private func updater() -> SPUUpdater {
            SPUUpdater(
                hostBundle: .main, applicationBundle: .main, userDriver: SilentDriver(),
                delegate: nil)
        }

        private func make(
            host: HostDelegate?, gate: PolarisSparkleRelaunchGate? = nil
        ) throws -> PolarisSparkleLiveDelegate {
            let c = try client()
            return PolarisSparkleLiveDelegate(
                journal: c.core.journal, channel: "stable", installedVersion: "1.2.3", host: host,
                relaunchGate: gate)
        }

        func testOtherCallbacksReachTheHost() throws {
            let host = HostDelegate()
            let live = try make(host: host)
            let sel = #selector(SPUUpdaterDelegate.updaterWillRelaunchApplication(_:))
            XCTAssertTrue(live.responds(to: sel))
            (live as SPUUpdaterDelegate).updaterWillRelaunchApplication?(updater())
            XCTAssertEqual(host.calls.current, ["relaunching"])
        }

        func testWithoutAHostTheOptionalCallbacksAreAbsent() throws {
            let live = try make(host: nil)
            XCTAssertFalse(
                live.responds(to: #selector(SPUUpdaterDelegate.updaterWillRelaunchApplication(_:))))
        }

        func testTheSDKKeepsFeedAndChannels() throws {
            let host = HostDelegate()
            let live = try make(host: host)
            let url = try XCTUnwrap(URL(string: "https://sdk.example/appcast.xml"))
            live.apply(UpdateFeed(url: url, channel: "stable", arch: nil, allowedChannels: ["beta"]))
            XCTAssertEqual(live.feedURLString(for: updater()), url.absoluteString)
            XCTAssertEqual(live.allowedChannels(for: updater()), ["beta"])
            XCTAssertEqual(host.calls.current, [])
        }

        func testDownloadAndInstallAreForwardedAfterTheSDKJournals() throws {
            let host = HostDelegate()
            let live = try make(host: host)
            let item = SUAppcastItem.empty()
            live.updater(updater(), didDownloadUpdate: item)
            live.updater(updater(), willInstallUpdate: item)
            XCTAssertEqual(host.calls.current, ["download", "install"])
        }

        func testTheHostDelegateCanHoldTheRelaunch() throws {
            let host = HostDelegate()
            host.postpone = true
            let live = try make(host: host)
            XCTAssertTrue(
                live.updater(updater(), shouldPostponeRelaunchForUpdate: .empty(), untilInvokingBlock: {}))
            XCTAssertEqual(host.calls.current, ["postpone"])
        }

        func testNoGateAndNoHostLetsTheRelaunchGo() throws {
            let live = try make(host: nil)
            XCTAssertFalse(
                live.updater(updater(), shouldPostponeRelaunchForUpdate: .empty(), untilInvokingBlock: {}))
        }

        func testTheGateHoldsTheRelaunchUntilResumed() throws {
            let recording = LockedValue<Bool>(true)
            let resumeBox = LockedValue<(@Sendable () -> Void)?>(nil)
            let host = HostDelegate()
            let live = try make(
                host: host,
                gate: { _, resume in
                    guard recording.current else { return false }
                    resumeBox.set(resume)
                    return true
                })
            let installed = LockedValue<Int>(0)
            XCTAssertTrue(
                live.updater(
                    updater(), shouldPostponeRelaunchForUpdate: .empty(),
                    untilInvokingBlock: { installed.with { $0 += 1 } }))
            XCTAssertEqual(installed.current, 0)
            // The gate answered, so the host delegate was not asked.
            XCTAssertEqual(host.calls.current, [])
            recording.set(false)
            resumeBox.current?()
            resumeBox.current?()
            XCTAssertEqual(installed.current, 1, "resume continues the install exactly once")
        }

        func testTheGateCanLetItGo() throws {
            let live = try make(host: nil, gate: { _, _ in false })
            XCTAssertFalse(
                live.updater(updater(), shouldPostponeRelaunchForUpdate: .empty(), untilInvokingBlock: {}))
        }
    }
#endif

final class SparkleSandboxTests: XCTestCase {
    private let id = "com.example.app"
    private let allInfo: [String: Any] = ["SUEnableInstallerLauncherService": true]

    private func reader(_ values: [String: Any]) -> SparkleSandbox.EntitlementReader {
        nonisolated(unsafe) let values = values
        return { values[$0] }
    }

    func testAnUnsandboxedAppPassesWithNothing() throws {
        try SparkleSandbox.assertConfigured(
            infoDictionary: [:], bundleIdentifier: id, entitlements: reader([:]))
    }

    func testASandboxedAppWithEverythingPasses() throws {
        try SparkleSandbox.assertConfigured(
            infoDictionary: allInfo, bundleIdentifier: id,
            entitlements: reader([
                SparkleSandbox.appSandboxEntitlement: true,
                SparkleSandbox.networkClientEntitlement: true,
                SparkleSandbox.machLookupEntitlement: ["\(id)-spks", "\(id)-spki"],
            ]))
    }

    func testASandboxedAppWithNothingNamesEverythingMissing() {
        XCTAssertThrowsError(
            try SparkleSandbox.assertConfigured(
                infoDictionary: [:], bundleIdentifier: id,
                entitlements: reader([SparkleSandbox.appSandboxEntitlement: true]))
        ) { error in
            XCTAssertEqual(
                error as? SparkleSandboxError,
                .notConfigured(
                    bundleIdentifier: id,
                    missing: [
                        "SUEnableInstallerLauncherService = YES in Info.plist",
                        "mach-lookup name \(id)-spks", "mach-lookup name \(id)-spki",
                        "SUEnableDownloaderService = YES in Info.plist (the app lacks com.apple.security.network.client)",
                    ]))
            XCTAssertTrue("\(error)".contains("-spks"))
        }
    }

    func testOneMachLookupNameMissing() {
        XCTAssertThrowsError(
            try SparkleSandbox.assertConfigured(
                infoDictionary: allInfo, bundleIdentifier: id,
                entitlements: reader([
                    SparkleSandbox.appSandboxEntitlement: true,
                    SparkleSandbox.networkClientEntitlement: true,
                    SparkleSandbox.machLookupEntitlement: ["\(id)-spks"],
                ]))
        ) { error in
            XCTAssertEqual(
                error as? SparkleSandboxError,
                .notConfigured(bundleIdentifier: id, missing: ["mach-lookup name \(id)-spki"]))
        }
    }

    func testTheDownloaderServiceStandsInForTheNetworkEntitlement() throws {
        try SparkleSandbox.assertConfigured(
            infoDictionary: allInfo.merging(["SUEnableDownloaderService": true]) { $1 },
            bundleIdentifier: id,
            entitlements: reader([
                SparkleSandbox.appSandboxEntitlement: true,
                SparkleSandbox.machLookupEntitlement: ["\(id)-spks", "\(id)-spki"],
            ]))
    }

    func testTheRunningTestProcessIsNotSandboxed() throws {
        try SparkleSandbox.assertConfigured(infoDictionary: [:], bundleIdentifier: id)
    }
}
