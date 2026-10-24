// @pkey-feature update.driver
//
// `PolarisSparkleUserDriver` (UK-08.6): Sparkle's `SPUUserDriver` drawn by the SwiftUI kit, in the
// one utility window of the `desktop-update` mockup. It replaces Sparkle's standard UI and nothing
// else: the feed, the EdDSA check and the install stay Sparkle's (`PolarisSparkle.start(client:
// userDriver:)`, SparkleAnchor.swift).
//
// The rules the driver keeps:
//
//   - A reply is Sparkle's question and the person's answer. The permission reply, the update
//     choice, the cancellation and every acknowledgement are called ONLY from a control the person
//     pressed or by closing the window, and each goes through a `Reply` that fires once, however
//     many controls race (Sparkle asserts on a second call). Nothing is answered for the person,
//     and a reply that no one answered when `dismissUpdateInstallation` arrives is dropped, as
//     Sparkle's own driver drops it.
//   - Progress is the download's own counts: a bar only once the total is known, and never a
//     percentage that was not counted. Extraction and install are indeterminate.
//   - After an error the window shows the error callout with Try Again and nothing else.
//   - The system profile is never sent (`sendSystemProfile: false`, whatever the person answers).
//
// The mapping (UK-08.6, pinned by SparkleUserDriverMappingTests):
//
//   permission request     the automatic-updates ask           `.permission`
//   update found           UpdatePrompt `available`            `.found`
//   expected length, data  UpdatePrompt `downloading`          `.downloading`
//   extracting             UpdateProgress `installing`         `.extracting`
//   ready to install       UpdatePrompt `ready`                `.ready`
//   installing             UpdateProgress `installing`         `.installing`
//   not found, installed   UpdatePrompt `up-to-date`           `.upToDate`
//   error                  UpdateProgress `failed` + Try Again `.failed`
//   dismiss                the window closes

import Foundation
import PolarisKey
import PolarisKeyCore
import PolarisKeyUI
import PolarisKeyUICore
import PolarisKeyUpdate

#if os(macOS)
    import AppKit
    import Sparkle
    import SwiftUI

    /// A reply to Sparkle that can be called once. The second call, from a control and the window's
    /// close button or any other race, does nothing.
    @MainActor
    final class Reply<Value> {
        private var send: ((Value) -> Void)?
        init(_ send: @escaping (Value) -> Void) { self.send = send }

        /// Whether the reply has gone to Sparkle.
        var isSent: Bool { send == nil }

        func callAsFunction(_ value: Value) {
            guard let send else { return }
            self.send = nil
            send(value)
        }
    }

    @MainActor
    public final class PolarisSparkleUserDriver: NSObject, SPUUserDriver, PolarisSparkleUpdaterAware {
        /// What the driver reads; defaults are the integration, P2-11's updater config plugs in here.
        public struct Options {
            /// The theme the window draws in (the product's accent, preset and scheme).
            public var theme: PolarisKeyTheme
            /// The window's title; nil titles it with the product's name.
            public var windowTitle: String?
            /// False for a host that draws `UpdateWindowView(model:)` itself: no window is made.
            public var presentsWindow: Bool
            /// The clock the time-left estimate reads.
            public var now: @MainActor () -> Date

            public init(
                theme: PolarisKeyTheme = PolarisKeyTheme(), windowTitle: String? = nil,
                presentsWindow: Bool = true, now: @escaping @MainActor () -> Date = { Date() }
            ) {
                self.theme = theme
                self.windowTitle = windowTitle
                self.presentsWindow = presentsWindow
                self.now = now
            }
        }

        /// The window's model: its state is the mapping table's answer for the last Sparkle call.
        public let model: UpdateWindowModel
        let options: Options
        private lazy var window = UpdateWindowController(model: model, options: options)
        private weak var updater: SPUUpdater?

        // Where the download stands (counted, never assumed).
        private var received: UInt64 = 0
        private var total: UInt64?
        private var downloadStarted: Date?
        private var offer: KitUpdate?
        /// What closing the window answers for the screen showing (the safe choice), nil when no
        /// reply is waiting.
        private var closeAnswer: (@MainActor () -> Void)?
        private var retryAfterDismiss = false

        public init(client: PolarisKeyClient, options: Options = Options()) {
            self.options = options
            self.model = UpdateWindowModel(gate: PolarisKeyGateModel(client: client))
            super.init()
        }

        /// A driver over a still model: fixtures and previews draw the same screens with no client.
        public init(preview inputs: KitInputs, iconData: Data? = nil, options: Options = Options()) {
            self.options = options
            self.model = UpdateWindowModel(
                gate: PolarisKeyGateModel(preview: inputs, presentationIcon: iconData))
            super.init()
        }

        public func attach(updater: SPUUpdater) { self.updater = updater }

        /// The window, for a host that places it itself.
        public var nsWindow: NSWindow? { options.presentsWindow ? window.window : nil }

        // MARK: Replies

        /// Shows `state` with its controls wired to `handlers`; closing the window answers `close`.
        private func present(
            _ state: UpdateWindowState, handlers: UpdateWindowHandlers = UpdateWindowHandlers(),
            close: (@MainActor () -> Void)? = nil
        ) {
            if state.kind != .failed { retryAfterDismiss = false }
            model.state = state
            model.handlers = handlers
            closeAnswer = close
            guard options.presentsWindow else { return }
            window.onUserClose = { [weak self] in self?.userClosedWindow() }
            // A check the person asked for brings the app forward; a scheduled offer does not steal
            // focus (Sparkle calls `showUpdateInFocus` when the person asks for it again).
            window.show(
                title: options.windowTitle ?? model.gate.inputs.bundle.name
                    ?? model.gate.inputs.bundle.slug,
                activate: state.kind == .checking)
        }

        /// The window's close button, for a test without a window.
        func userClosedWindowForTests() { userClosedWindow() }

        private func userClosedWindow() {
            let answer = closeAnswer
            closeAnswer = nil
            answer?()
        }

        /// A control answered: the reply goes out once and the window follows Sparkle from there.
        private func once<V>(_ send: @escaping (V) -> Void) -> Reply<V> { Reply(send) }

        // MARK: The permission request

        public func show(
            _ request: SPUUpdatePermissionRequest,
            reply: @escaping (SUUpdatePermissionResponse) -> Void
        ) {
            let reply = once(reply)
            // Never the system profile, whatever the person answers.
            func answer(_ checks: Bool) {
                reply(
                    SUUpdatePermissionResponse(
                        automaticUpdateChecks: checks, sendSystemProfile: false))
            }
            present(
                UpdateWindowState(kind: .permission),
                handlers: UpdateWindowHandlers(
                    allow: { answer(true) }, notNow: { answer(false) }),
                close: { answer(false) })
        }

        // MARK: A check

        public func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {
            let cancel = once { (_: Void) in cancellation() }
            present(
                UpdateWindowState(kind: .checking),
                handlers: UpdateWindowHandlers(cancel: { cancel(()) }),
                close: { cancel(()) })
        }

        // MARK: An update is found

        public func showUpdateFound(
            with appcastItem: SUAppcastItem, state: SPUUserUpdateState,
            reply: @escaping (SPUUserUpdateChoice) -> Void
        ) {
            showFound(appcastItem, reply: reply)
        }

        /// An offered update, in plain values: what the found screen needs of Sparkle's item.
        struct Offer {
            var version: String
            var currentVersion: String?
            var size: UInt64
            var critical: Bool
            var notes: [String]?
            var notesURL: URL?
            var infoURL: URL?
            var infoOnly: Bool

            init(
                version: String, currentVersion: String? = nil, size: UInt64 = 0,
                critical: Bool = false, notes: [String]? = nil, notesURL: URL? = nil,
                infoURL: URL? = nil, infoOnly: Bool = false
            ) {
                self.version = version
                self.currentVersion = currentVersion
                self.size = size
                self.critical = critical
                self.notes = notes
                self.notesURL = notesURL
                self.infoURL = infoURL
                self.infoOnly = infoOnly
            }

            @MainActor init(_ item: SUAppcastItem, current: String?) {
                self.init(
                    version: item.displayVersionString, currentVersion: current,
                    size: item.contentLength, critical: item.isCriticalUpdate,
                    notes: PolarisSparkleUserDriver.plainNotes(item),
                    notesURL: item.fullReleaseNotesURL ?? item.releaseNotesURL,
                    infoURL: item.infoURL, infoOnly: item.isInformationOnlyUpdate)
            }
        }

        /// The found screen (the entry the tests drive: `SPUUserUpdateState` has no public init).
        func showFound(_ item: SUAppcastItem, reply: @escaping (SPUUserUpdateChoice) -> Void) {
            showFound(Offer(item, current: Self.hostVersion(updater: updater)), reply: reply)
        }

        func showFound(_ found: Offer, reply: @escaping (SPUUserUpdateChoice) -> Void) {
            let reply = once(reply)
            let infoOnly = found.infoOnly
            let size = found.size
            offer = KitUpdate(
                action: "binary", version: found.version,
                critical: found.critical ? true : nil,
                currentVersion: found.currentVersion ?? Self.hostVersion(updater: updater),
                sizeBytes: size > 0 ? Int(clamping: size) : nil, notes: found.notes,
                notesUrl: KitLinks.valid(found.notesURL?.absoluteString)?.absoluteString)
            received = 0
            total = nil
            let url = infoOnly ? found.infoURL : nil
            present(
                UpdateWindowState(
                    kind: .found, update: offer, canSkip: !found.critical, infoOnly: infoOnly),
                handlers: UpdateWindowHandlers(
                    install: { reply(.install) },
                    later: { reply(.dismiss) },
                    skip: { reply(.skip) },
                    learnMore: {
                        // An information-only update has a web page and nothing to install: the
                        // page opens only when it is https, then the offer is set aside.
                        if let url = KitLinks.valid(url?.absoluteString) {
                            NSWorkspace.shared.open(url)
                        }
                        reply(.dismiss)
                    }),
                close: { reply(.dismiss) })
        }

        public func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {
            showNotes(data: downloadData.data, mimeType: downloadData.mimeType)
        }

        /// Plain text only: markup is never run, and HTML notes are not shown (the changes link
        /// is the way to read them).
        func showNotes(data: Data, mimeType: String?) {
            guard model.state.kind == .found, data.count <= 64 * 1024,
                mimeType?.lowercased() == "text/plain",
                let text = String(data: data, encoding: .utf8)
            else { return }
            let lines = KitUpdateFacts.notes(summary: text)
            guard !lines.isEmpty else { return }
            offer?.notes = lines
            model.state.update = offer
        }

        public func showUpdateReleaseNotesFailedToDownloadWithError(_ error: any Error) {
            // The offer stands without notes; the changes link still opens the page.
        }

        // MARK: Not found, errors

        public func showUpdateNotFoundWithError(
            _ error: any Error, acknowledgement: @escaping () -> Void
        ) {
            let ack = once { (_: Void) in acknowledgement() }
            let nsError = error as NSError
            let reason = (nsError.userInfo[SPUNoUpdateFoundReasonKey] as? NSNumber)
                .flatMap { SPUNoUpdateFoundReason(rawValue: $0.int32Value) }
            switch reason {
            case .some(.systemIsTooOld), .some(.systemIsTooNew),
                .some(.hardwareDoesNotSupportARM64):
                // An update exists that this Mac cannot take: not "up to date".
                showError(error, ack)
            default:
                present(
                    UpdateWindowState(
                        kind: .upToDate,
                        update: KitUpdate(
                            action: "none", currentVersion: Self.hostVersion(updater: updater))),
                    handlers: UpdateWindowHandlers(done: { ack(()) }),
                    close: { ack(()) })
            }
        }

        public func showUpdaterError(_ error: any Error, acknowledgement: @escaping () -> Void) {
            showError(error, once { (_: Void) in acknowledgement() })
        }

        private func showError(_ error: any Error, _ ack: Reply<Void>) {
            // Nothing but the callout: the offer, the numbers and the notes are gone.
            offer = nil
            let retry: @MainActor () -> Void = { [weak self] in
                guard let self else { return }
                self.retryAfterDismiss = true
                ack(())
            }
            present(
                UpdateWindowState(
                    kind: .failed,
                    update: KitUpdate(
                        action: "binary", progress: KitUpdateProgress(phase: "failed")),
                    detail: error.localizedDescription),
                handlers: UpdateWindowHandlers(tryAgain: retry),
                close: { ack(()) })
        }

        // MARK: The download

        public func showDownloadInitiated(cancellation: @escaping () -> Void) {
            let cancel = once { (_: Void) in cancellation() }
            received = 0
            total = nil
            downloadStarted = options.now()
            publishDownload(
                handlers: UpdateWindowHandlers(cancel: { cancel(()) }), close: { cancel(()) })
        }

        public func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) {
            // 0 and the unknown-size sentinel (-1 as unsigned) mean "not known".
            total = expectedContentLength > 0 && expectedContentLength < UInt64(Int.max)
                ? expectedContentLength : nil
            republishDownload()
        }

        public func showDownloadDidReceiveData(ofLength length: UInt64) {
            let (sum, overflow) = received.addingReportingOverflow(length)
            received = overflow ? UInt64.max : sum
            republishDownload()
        }

        /// Backdates the download's start (the fixture states: a measured rate needs elapsed time).
        func rewindDownloadClock(by seconds: TimeInterval) {
            downloadStarted = options.now().addingTimeInterval(-seconds)
        }

        private func publishDownload(
            handlers: UpdateWindowHandlers, close: (@MainActor () -> Void)?
        ) {
            present(
                UpdateWindowState(
                    kind: .downloading, update: downloadOffer(), canSkip: model.state.canSkip,
                    infoOnly: false),
                handlers: handlers, close: close)
        }

        private func republishDownload() {
            // Only the numbers change: the window, its controls and what closing answers stay.
            guard model.state.kind == .downloading else { return }
            model.state.update = downloadOffer()
        }

        /// The offer with the download's counted progress. `fraction` is set only while the total
        /// is known and the bytes received do not exceed it; the time left only from a measured rate.
        func downloadOffer() -> KitUpdate {
            var update = offer ?? KitUpdate(action: "binary")
            update.action = "binary"
            var progress = KitUpdateProgress(phase: "download")
            if let total, received <= total {
                progress.bytes = Int(clamping: received)
                progress.totalBytes = Int(clamping: total)
                progress.fraction = Double(received) / Double(total)
                if let started = downloadStarted {
                    let elapsed = options.now().timeIntervalSince(started)
                    if elapsed >= 1, received > 0 {
                        let rate = Double(received) / elapsed
                        progress.secondsLeft = Double(total - received) / rate
                    }
                }
            }
            update.progress = progress
            return update
        }

        public func showDownloadDidStartExtractingUpdate() {
            var update = offer ?? KitUpdate(action: "binary")
            update.progress = KitUpdateProgress(phase: "install")
            present(UpdateWindowState(kind: .extracting, update: update))
        }

        public func showExtractionReceivedProgress(_ progress: Double) {
            // Extraction is indeterminate: Sparkle's fraction is not drawn as a percentage.
        }

        // MARK: Ready, installing, installed

        public func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
            let reply = once(reply)
            var update = offer ?? KitUpdate(action: "binary")
            update.action = "code-ready"
            update.progress = nil
            present(
                UpdateWindowState(kind: .ready, update: update),
                handlers: UpdateWindowHandlers(
                    install: { reply(.install) }, later: { reply(.dismiss) }),
                close: { reply(.dismiss) })
        }

        public func showInstallingUpdate(
            withApplicationTerminated applicationTerminated: Bool,
            retryTerminatingApplication: @escaping () -> Void
        ) {
            // The retry is an offer Sparkle makes, not a reply it waits for: it is not called.
            var update = offer ?? KitUpdate(action: "binary")
            update.progress = KitUpdateProgress(phase: "install")
            present(UpdateWindowState(kind: .installing, update: update))
        }

        public func showUpdateInstalledAndRelaunched(
            _ relaunched: Bool, acknowledgement: @escaping () -> Void
        ) {
            let ack = once { (_: Void) in acknowledgement() }
            present(
                UpdateWindowState(
                    kind: .upToDate,
                    update: KitUpdate(
                        action: "none", currentVersion: Self.hostVersion(updater: updater))),
                handlers: UpdateWindowHandlers(done: { ack(()) }),
                close: { ack(()) })
        }

        public func showUpdateInFocus() { if options.presentsWindow { window.bringForward() } }

        public func dismissUpdateInstallation() {
            // The session is over: drop what no one answered (Sparkle drops it too) and close.
            closeAnswer = nil
            // A control left over from the session answers nothing: its reply is Sparkle's no more.
            model.handlers = UpdateWindowHandlers()
            offer = nil
            if options.presentsWindow { window.close() }
            if retryAfterDismiss {
                retryAfterDismiss = false
                // After Sparkle has finished this session, the person asked to try again.
                let updater = self.updater
                Task { @MainActor in updater?.checkForUpdates() }
            }
        }

        // MARK: Facts from the appcast

        /// The running version, from the host bundle.
        static func hostVersion(updater: SPUUpdater?) -> String? {
            updater?.hostBundle.infoDictionary?["CFBundleShortVersionString"] as? String
                ?? Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        }

        /// The item's notes when the feed carries them as plain text or Markdown; HTML never.
        static func plainNotes(_ item: SUAppcastItem) -> [String]? {
            guard let text = item.itemDescription,
                let format = item.itemDescriptionFormat?.lowercased(),
                format == "plain-text" || format == "markdown"
            else { return nil }
            let lines = KitUpdateFacts.notes(summary: text)
            return lines.isEmpty ? nil : lines
        }
    }
#endif
