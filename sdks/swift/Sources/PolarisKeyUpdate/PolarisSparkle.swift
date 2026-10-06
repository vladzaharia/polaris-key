// `PolarisSparkle.start(client:)` — Sparkle in one call on macOS (notes/SDK-PARITY-PASS.md §2.4,
// SP-S10).
//
// It asserts `SUPublicEDKey` (Sparkle stays the terminal anchor, SparkleAnchor.swift), starts an
// `SPUStandardUpdaterController`, points it at the product's appcast from DISCOVERY, attaches the
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

    /// A Sparkle delegate whose feed, channels and journal follow the client.
    public final class PolarisSparkleLiveDelegate: NSObject, SPUUpdaterDelegate, @unchecked Sendable {
        private let state = LockedValue<(feed: String?, channels: Set<String>)>((nil, ["stable"]))
        private let journal: UpdateJournal
        private let channel: String
        private let installedVersion: String

        init(journal: UpdateJournal, channel: String, installedVersion: String) {
            self.journal = journal
            self.channel = channel
            self.installedVersion = installedVersion
            super.init()
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
        }

        public func updater(_ updater: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
            record(UpdateEvent.updateApplied, item)
        }

        private func record(_ event: String, _ item: SUAppcastItem) {
            let release = item.displayVersionString
            let journal = self.journal
            let channel = item.channel ?? self.channel
            let from = installedVersion
            Task { await journal.record(event, release: release, fromRelease: from, channel: channel) }
        }
    }

    @MainActor
    public final class PolarisSparkle {
        public let controller: SPUStandardUpdaterController
        public let delegate: PolarisSparkleLiveDelegate
        private let client: PolarisKeyClient
        private let channel: String
        private var observation: Task<Void, Never>?

        private init(client: PolarisKeyClient, channel: String, delegate: PolarisSparkleLiveDelegate) {
            self.client = client
            self.channel = channel
            self.delegate = delegate
            self.controller = SPUStandardUpdaterController(
                startingUpdater: false, updaterDelegate: delegate, userDriverDelegate: nil)
        }

        /// Start Sparkle for `client`. Throws `SparkleAnchorError` when the bundle has no
        /// `SUPublicEDKey`, or what `SPUUpdater.start()` throws. Retain the returned object for
        /// the app's lifetime (it owns the updater and its delegate).
        public static func start(
            client: PolarisKeyClient, channel: String? = nil, bundle: Foundation.Bundle = .main
        ) async throws -> PolarisSparkle {
            try SparkleAnchor.assertPresent(in: bundle)
            let channel = channel ?? client.core.channel
            if await client.core.discoveryDocument == nil { _ = await client.discover() }
            let delegate = PolarisSparkleLiveDelegate(
                journal: client.core.journal, channel: channel, installedVersion: client.core.version)
            let sparkle = PolarisSparkle(client: client, channel: channel, delegate: delegate)
            await sparkle.reconfigure()
            try sparkle.controller.updater.start()
            sparkle.observe()
            BinaryUpdateHandoff.shared.set { @MainActor [weak sparkle] in
                guard let sparkle else { return false }
                sparkle.controller.checkForUpdates(nil)
                return true
            }
            return sparkle
        }

        /// Re-derive the feed, headers and channels from the client's current state.
        public func reconfigure() async {
            let entitlements = await client.license.entitlements()
            let feed = await client.update.feed(channel: channel, entitlements: entitlements)
            let headers = await client.update.feedHeaders(channel: channel)
            delegate.apply(feed)
            let updater = controller.updater
            updater.httpHeaders = headers.isEmpty ? nil : headers
        }

        /// Ask Sparkle to check now, with its UI.
        public func checkForUpdates() { controller.checkForUpdates(nil) }

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
