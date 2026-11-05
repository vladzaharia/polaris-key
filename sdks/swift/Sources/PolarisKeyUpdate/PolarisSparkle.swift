// `PolarisSparkle.start(client:)` — Sparkle in one call on macOS (notes/SDK-PARITY-PASS.md §2.4,
// SP-S10).
//
// It asserts `SUPublicEDKey` (Sparkle stays the terminal anchor, SparkleAnchor.swift), starts an
// `SPUStandardUpdaterController` (or an `SPUUpdater` on the app's own `SPUUserDriver`), points it at the product's appcast from DISCOVERY, attaches the
// device bearer its requests need, and narrows its channels to the licence's `channels`
// entitlement. Then it keeps all three current: on every `license` change (activation, a new
// licence document, sign-out) it re-derives the feed, the headers and the channels.
//
// The P6-03 events ride Sparkle's own delegate callbacks: `update_downloaded` when Sparkle
// finished a download and `update_applied` when it is about to install. It also registers as
// `UpdateClient.install`'s binary hand-off, so `client.update.install(check)` on a binary
// decision opens Sparkle's own update flow.

import Foundation
import PolarisKey
import PolarisKeyCore

#if os(macOS)
    import Sparkle

    /// Holds an update's relaunch. Sparkle asks once the update is installed and about to
    /// relaunch the app. Return `true` to hold it and call `resume` exactly once when it may
    /// go on (from any thread); return `false` to let it relaunch now.
    public typealias PolarisSparkleRelaunchGate =
        @Sendable (_ item: SUAppcastItem, _ resume: @escaping @Sendable () -> Void) -> Bool

    /// A Sparkle delegate whose feed, channels and journal follow the client.
    ///
    /// A host delegate (`PolarisSparkle.start(hostDelegate:)`) sees every other
    /// `SPUUpdaterDelegate` callback. Where both answer, the SDK wins for the feed URL and the
    /// allowed channels (the host's answers to those two are never asked); `didDownloadUpdate`
    /// and `willInstallUpdate` are journaled and then also forwarded; the relaunch gate, when
    /// given, answers `shouldPostponeRelaunchForUpdate` before the host delegate does.
    public final class PolarisSparkleLiveDelegate: NSObject, SPUUpdaterDelegate, @unchecked Sendable {
        private let state = LockedValue<(feed: String?, channels: Set<String>)>((nil, ["stable"]))
        private let journal: UpdateJournal
        private let channel: String
        private let installedVersion: String
        // Read by the NSObject forwarding overrides, which are nonisolated; Sparkle's delegate
        // protocol is main-actor, so older compilers isolate this property with the class.
        nonisolated(unsafe) private let host: (any SPUUpdaterDelegate)?
        private let relaunchGate: PolarisSparkleRelaunchGate?

        init(
            journal: UpdateJournal, channel: String, installedVersion: String,
            host: (any SPUUpdaterDelegate)? = nil, relaunchGate: PolarisSparkleRelaunchGate? = nil
        ) {
            self.journal = journal
            self.channel = channel
            self.installedVersion = installedVersion
            self.host = host
            self.relaunchGate = relaunchGate
            super.init()
        }

        // Every selector the SDK does not implement goes to the host delegate.
        public override func responds(to selector: Selector!) -> Bool {
            if super.responds(to: selector) { return true }
            return (host as? NSObject)?.responds(to: selector) ?? false
        }

        public override func forwardingTarget(for selector: Selector!) -> Any? {
            if let host = host as? NSObject, host.responds(to: selector) { return host }
            return super.forwardingTarget(for: selector)
        }

        public func updater(
            _ updater: SPUUpdater, shouldPostponeRelaunchForUpdate item: SUAppcastItem,
            untilInvokingBlock installHandler: @escaping () -> Void
        ) -> Bool {
            if let relaunchGate {
                let once = LockedValue<Bool>(false)
                // Sparkle hands the block over unmarked; it is invoked at most once, from whichever thread resumes.
                nonisolated(unsafe) let install = installHandler
                let resume: @Sendable () -> Void = {
                    let first = once.with { done -> Bool in
                        defer { done = true }
                        return !done
                    }
                    if first { install() }
                }
                return relaunchGate(item, resume)
            }
            return host?.updater?(
                updater, shouldPostponeRelaunchForUpdate: item, untilInvokingBlock: installHandler)
                ?? false
        }

        func apply(_ feed: UpdateFeed?) {
            state.set((feed?.url.absoluteString, feed?.allowedChannels ?? ["stable"]))
        }

        public func feedURLString(for updater: SPUUpdater) -> String? { state.current.feed }

        public func allowedChannels(for updater: SPUUpdater) -> Set<String> {
            state.current.channels
        }

        public func updater(_ updater: SPUUpdater, didDownloadUpdate item: SUAppcastItem) {
            record(UpdateEvent.updateDownloaded, item)
            host?.updater?(updater, didDownloadUpdate: item)
        }

        public func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
            record(UpdateEvent.updateApplied, item)
            host?.updater?(updater, willInstallUpdate: item)
        }

        private func record(_ event: String, _ item: SUAppcastItem) {
            let release = item.displayVersionString
            let journal = self.journal
            let channel = item.channel ?? self.channel
            let from = installedVersion
            Task { await journal.record(event, release: release, fromRelease: from, channel: channel) }
        }
    }

    /// A user driver that wants the updater it runs under, to start a check again (the update
    /// window's Try Again). `PolarisSparkle` hands it over when it builds the updater.
    @MainActor
    public protocol PolarisSparkleUpdaterAware: AnyObject {
        func attach(updater: SPUUpdater)
    }

    @MainActor
    public final class PolarisSparkle {
        /// The standard controller; `nil` when an app injected its own `userDriver`.
        public let controller: SPUStandardUpdaterController?
        /// The updater on both paths.
        public let updater: SPUUpdater
        public let delegate: PolarisSparkleLiveDelegate
        private let client: PolarisKeyClient
        private let channel: String
        private var observation: Task<Void, Never>?

        /// With no `userDriver`, Sparkle's standard controller (its own UI). With one, an
        /// `SPUUpdater` on that driver: only the UI changes, the delegate (feed, channels,
        /// journal) and the anchor are the same.
        init(
            client: PolarisKeyClient, channel: String, delegate: PolarisSparkleLiveDelegate,
            bundle: Foundation.Bundle = .main, userDriver: (any SPUUserDriver)? = nil
        ) {
            self.client = client
            self.channel = channel
            self.delegate = delegate
            if let userDriver {
                self.controller = nil
                self.updater = SPUUpdater(
                    hostBundle: bundle, applicationBundle: bundle, userDriver: userDriver,
                    delegate: delegate)
                (userDriver as? any PolarisSparkleUpdaterAware)?.attach(updater: updater)
            } else {
                let controller = SPUStandardUpdaterController(
                    startingUpdater: false, updaterDelegate: delegate, userDriverDelegate: nil)
                self.controller = controller
                self.updater = controller.updater
            }
        }

        /// Start Sparkle for `client`. Throws `SparkleAnchorError` when the bundle has no
        /// `SUPublicEDKey`, or what `SPUUpdater.start()` throws. Retain the returned object for
        /// the app's lifetime (it owns the updater and its delegate, and Sparkle holds the
        /// `userDriver` it is given). `userDriver` replaces Sparkle's standard UI only: the feed,
        /// the EdDSA check and the install path are Sparkle's, as without it.
        ///
        /// `bundle` is the bundle the updater reads and replaces when a `userDriver` is given. With
        /// no `userDriver` the standard controller always updates `Bundle.main` and `bundle` only
        /// supplies the `SUPublicEDKey` check, so pass a custom `bundle` together with a driver.
        ///
        /// `hostDelegate` receives every `SPUUpdaterDelegate` callback the SDK does not answer
        /// itself, and also `didDownloadUpdate` and `willInstallUpdate`. The SDK keeps the feed
        /// URL and the allowed channels: the host's answers to those are ignored. Sparkle holds
        /// its delegate weakly and `PolarisSparkle` holds the host delegate strongly. `relaunchGate`
        /// holds the relaunch after an install (for example while recording); it answers
        /// `updater(_:shouldPostponeRelaunchForUpdate:untilInvokingBlock:)` before `hostDelegate`.
        ///
        /// Also throws `SparkleSandboxError` for a sandboxed app that lacks Sparkle's installer
        /// setup. `entitlements` reads the task's entitlements, and exists for tests.
        public static func start(
            client: PolarisKeyClient, channel: String? = nil, bundle: Foundation.Bundle = .main,
            userDriver: (any SPUUserDriver)? = nil, hostDelegate: (any SPUUpdaterDelegate)? = nil,
            relaunchGate: PolarisSparkleRelaunchGate? = nil,
            entitlements: SparkleSandbox.EntitlementReader = SparkleSandbox.currentTask
        ) async throws -> PolarisSparkle {
            try SparkleAnchor.assertPresent(in: bundle)
            try SparkleSandbox.assertConfigured(in: bundle, entitlements: entitlements)
            let channel = channel ?? client.core.channel
            if await client.core.discoveryDocument == nil { _ = await client.discover() }
            let delegate = PolarisSparkleLiveDelegate(
                journal: client.core.journal, channel: channel, installedVersion: client.core.version,
                host: hostDelegate, relaunchGate: relaunchGate)
            let sparkle = PolarisSparkle(
                client: client, channel: channel, delegate: delegate, bundle: bundle,
                userDriver: userDriver)
            await sparkle.reconfigure()
            try sparkle.updater.start()
            sparkle.observe()
            BinaryUpdateHandoff.shared.set { @MainActor [weak sparkle] in
                guard let sparkle else { return false }
                sparkle.checkForUpdates()
                return true
            }
            return sparkle
        }

        /// Re-derive the feed, headers and channels from the client's current state.
        public func reconfigure() async {
            let entitlements = await client.entitlements.all()
            let feed = await client.update.feed(channel: channel, entitlements: entitlements)
            let headers = await client.update.feedHeaders(channel: channel)
            delegate.apply(feed)
            updater.httpHeaders = headers.isEmpty ? nil : headers
        }

        /// Ask Sparkle to check now, with its UI.
        public func checkForUpdates() { updater.checkForUpdates() }

        /// Stop following the client (the updater keeps its last configuration).
        public func stop() {
            observation?.cancel()
            observation = nil
            BinaryUpdateHandoff.shared.set(nil)
        }

        private func observe() {
            let stream = client.events
            observation = Task { [weak self] in
                for await event in stream {
                    // The gate, or an entitlement (the entitled channels), moved.
                    switch event {
                    case .license, .entitlement: await self?.reconfigure()
                    default: break
                    }
                }
            }
        }
    }
#endif
