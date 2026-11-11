// @pkey-feature ui.settings
// The Cloud Sync kit host (U-42.3T, Q-7): drives the status row from the real Cloud Sync host and
// switches between the UnlockSync, RingChange and RecoveryCode screens. `CloudSyncKitHostModel` is
// the model; `CloudSyncKitView` (PolarisKeyUI) draws it. A source stands in for `client.cloudSync`,
// `client.events` and the keyring, so the binding is testable with a fake. Nothing here holds a
// recovery code beyond the screens' own models, and no event carries a value.

import Foundation
import Observation
import PolarisKey
import PolarisKeyCore

/// What the host reads of the client. `init(client:)` is the live form.
public struct CloudSyncSource: Sendable {
    /// `client.cloudSync.status()`.
    public var status: @Sendable () async throws -> SyncStatus
    /// `client.cloudSync.flush()`.
    public var flush: @Sendable () async throws -> SyncStatus
    /// Asks the key ring whether this device unlocks: `keyring.unlock()`. Used while the machine is
    /// locked, to tell a changed ring from a plain lock. Never accepts a ring.
    public var probe: @Sendable () async throws -> SyncUnlockResult
    /// `client.events`, narrowed to Cloud Sync's.
    public var events: @Sendable () -> AsyncStream<CloudSyncEvent>
    /// The screens' actions.
    public var screens: CloudSyncScreenHost

    public init(
        status: @escaping @Sendable () async throws -> SyncStatus,
        flush: @escaping @Sendable () async throws -> SyncStatus,
        probe: @escaping @Sendable () async throws -> SyncUnlockResult,
        events: @escaping @Sendable () -> AsyncStream<CloudSyncEvent>, screens: CloudSyncScreenHost
    ) {
        self.status = status
        self.flush = flush
        self.probe = probe
        self.events = events
        self.screens = screens
    }

    /// The live form: `client.cloudSync`, `client.events` and `client.keyring`. "New recovery code" goes
    /// through `client.cloudSync`.
    public init(client: PolarisKeyClient) {
        let keyringHost = CloudSyncScreenHost(keyring: client.keyring)
        let cloud = client.cloudSync
        self.init(
            status: { try await cloud.status() }, flush: { try await cloud.flush() },
            probe: { try await client.keyring.unlock() },
            events: {
                let source = client.events
                return AsyncStream { continuation in
                    let task = Task {
                        for await event in source {
                            if case .cloudSync(let e) = event { continuation.yield(e) }
                        }
                        continuation.finish()
                    }
                    continuation.onTermination = { _ in task.cancel() }
                }
            },
            screens: CloudSyncScreenHost(
                recover: keyringHost.recover, reset: keyringHost.reset,
                acceptRingChange: keyringHost.acceptRingChange,
                newRecoveryCode: { try await cloud.newRecoveryCode() }))
    }
}

/// The screen the host shows over the settings.
public enum CloudSyncKitScreen: Equatable, Sendable { case unlock, ringChange, recoveryCode }

@MainActor
@Observable
public final class CloudSyncKitHostModel {
    /// The status row's inputs; nil while Cloud Sync has nothing to say (local, or the service off).
    public private(set) var status: CloudSyncStatusModel?
    /// The screen in front, if any.
    public private(set) var screen: CloudSyncKitScreen?
    public private(set) var unlockModel: UnlockSyncModel?
    public private(set) var ringModel: RingChangeModel?
    public private(set) var recoveryModel: RecoveryCodeModel?
    /// "New recovery code" could not make one (the previous code still works).
    public private(set) var newCodeFailed = false
    /// Where the sign-in offer goes: the host app opens its own sign-in. nil leaves it to the kit's
    /// own sign-in, when the host was made over a client (`init(client:)`; `CloudSyncKitView` shows
    /// it as a sheet); with neither, the row has no button.
    public var onSignIn: (@MainActor () -> Void)? { didSet { rebuildStatus() } }
    /// The kit's own sign-in, while it is open: the model behind `CloudSyncKitView`'s sign-in sheet.
    public private(set) var signInModel: PolarisKeyGateModel?

    private let source: CloudSyncSource
    private let client: PolarisKeyClient?
    private let services: Set<KitService>?
    private var shown: KitCloudSync.State?
    private var signedOut = false
    private var served: (pin: SyncRingPin, by: String?)?
    private var lastSynced: Date?
    private var pump: Task<Void, Never>?
    private var generation = 0

    public init(source: CloudSyncSource, services: Set<KitService>? = nil) {
        self.source = source
        self.services = services
        self.client = nil
    }

    /// The live host over `client`: the row follows `client.cloudSync`, and Sign in to sync opens the
    /// kit's own sign-in unless `onSignIn` handles it.
    public init(client: PolarisKeyClient, services: Set<KitService>? = nil) {
        self.source = CloudSyncSource(client: client)
        self.services = services
        self.client = client
    }

    /// Opens the kit's own sign-in (a fresh gate model over the client, the form already started).
    public func openSignIn() {
        guard let client, signInModel == nil else { return }
        let model = PolarisKeyGateModel(client: client)
        model.beginSignIn()
        signInModel = model
    }

    /// Closes the kit's own sign-in; the row follows the machine's own events.
    public func closeSignIn() {
        signInModel?.cancelSignIn()
        signInModel = nil
        Task { await refresh() }
    }

    /// Starts following `client.events`, and reads the status once. Call from the view's `.task`.
    public func start() async {
        pump?.cancel()
        let stream = source.events()
        pump = Task { [weak self] in
            for await event in stream {
                guard !Task.isCancelled else { return }
                await self?.handle(event)
            }
        }
        await refresh()
    }

    public func stop() {
        pump?.cancel()
        pump = nil
    }

    // MARK: status

    /// Reads the machine's status and redraws the row.
    public func refresh() async {
        generation += 1
        let mine = generation
        let status: SyncStatus
        do { status = try await source.status() } catch {
            // The service is off (typed N/A) or unreadable: no row, never a dead one.
            if mine == generation { setRow(nil) }
            return
        }
        guard mine == generation else { return }
        signedOut = false
        switch status.state {
        case .local, .unsupported:
            setRow(nil)
        case .locked:
            // Locked: the key ring says whether the ring changed under this device.
            do {
                switch try await source.probe() {
                case .ringChanged(_, let now, _, let by):
                    guard mine == generation else { return }
                    served = (now, by)
                    setRow(.ringChanged)
                case .unlocked:
                    guard mine == generation else { return }
                    served = nil
                    if let next = try? await source.status(), next.state != .locked {
                        await refresh()
                    } else {
                        setRow(.locked)
                    }
                case .locked:
                    guard mine == generation else { return }
                    served = nil
                    setRow(.locked)
                }
            } catch {
                guard mine == generation else { return }
                served = nil
                setRow(.locked)
            }
        case .idle, .pending:
            setRow(.synced)
        case .syncing:
            setRow(.syncing)
        case .offline, .paused:
            setRow(.offline)
        case .blocked:
            let out = status.reason == .accountRequired || status.reason == .unauthorized
            signedOut = out
            setRow(.error)
        }
    }

    private func handle(_ event: CloudSyncEvent) async {
        switch event {
        case .signedOut, .signInOffered:
            // Not a fault: the row says so and offers to sign in.
            generation += 1
            signedOut = true
            setRow(.error)
        case .change:
            lastSynced = Date()
            await refresh()
        case .rejected, .unsyncedData, .purgeFailed:
            await refresh()
        case .transferProgress, .transferDone, .transferFailed:
            // The kit's transfer states are the save screens' (U-23 .3 to .5); the sync row has nothing to say.
            break
        case .conflictOpened, .conflictClosed:
            // A request is the SaveConflict screen's (U-08.K3); the sync row has nothing to say.
            break
        }
    }

    private func setRow(_ state: KitCloudSync.State?) {
        shown = state
        rebuildStatus()
    }

    /// Whether this stop has been announced: one announcement per stop, not per appearance.
    private var stopAnnounced = false

    private func rebuildStatus() {
        guard let state = shown else {
            status = nil
            return
        }
        var inputs = KitInputs()
        inputs.services = services
        inputs.cloudSync = KitCloudSync(
            state: state, signedIn: state == .error && signedOut ? false : nil,
            lastSynced: state == .synced ? lastSynced.map(Self.relative) : nil)
        let row = CloudSyncStatusModel(
            inputs: inputs, onUnlock: { [weak self] in self?.openUnlock() },
            onReview: { [weak self] in self?.openReview() }, onSignIn: signedOut ? (onSignIn ?? ownSignIn) : nil)
        if !(state == .error && signedOut) { stopAnnounced = false }
        row.claimStopAnnouncement = { [weak self] in
            guard let self, !self.stopAnnounced else { return false }
            self.stopAnnounced = true
            return true
        }
        status = row
    }

    /// The kit's own sign-in as the row's action, where the host has a client.
    private var ownSignIn: (@MainActor () -> Void)? {
        guard client != nil else { return nil }
        return { [weak self] in self?.openSignIn() }
    }

    private static func relative(_ date: Date) -> String {
        #if canImport(Darwin)
            RelativeDateTimeFormatter().localizedString(for: date, relativeTo: Date())
        #else
            // swift-corelibs-foundation has no relative formatter: whole days, in English.
            KitFormat.daysAgo(max(0, Int(Date().timeIntervalSince(date) / 86_400)))
        #endif
    }

    // MARK: screens

    private func baseInputs() -> KitInputs {
        var inputs = KitInputs()
        inputs.services = services
        return inputs
    }

    /// Unlock: the status row's button, or "use recovery code" from RingChange.
    public func openUnlock() {
        let model = UnlockSyncModel(inputs: baseInputs(), host: source.screens)
        model.onUnlocked = { [weak self] in self?.finish(refreshing: true) }
        // Start over made a new ring: its new recovery code is shown once; with none, the sheet ends.
        model.onStartedOver = { [weak self] code in self?.startedOver(code) }
        model.onCancel = { [weak self] in self?.finish(refreshing: false) }
        unlockModel = model
        screen = .unlock
    }

    /// Review a changed ring: the ring the row was drawn for, never a fresh read.
    public func openReview() {
        guard let served else {
            // Nothing to accept: only the recovery code remains.
            openUnlock()
            return
        }
        let model = RingChangeModel(by: served.by, served: served.pin, host: source.screens)
        model.onAccepted = { [weak self] in self?.finish(refreshing: true) }
        model.onUseRecoveryCode = { [weak self] in self?.openUnlock() }
        model.onCancel = { [weak self] in self?.finish(refreshing: false) }
        ringModel = model
        screen = .ringChange
    }

    /// Settings' "New recovery code": makes one through `client.cloudSync` and shows it once. The
    /// previous code stops working only once the new one is held.
    public func requestNewRecoveryCode() async {
        newCodeFailed = false
        let model = makeRecoveryModel()
        do {
            try await model.generate()
            recoveryModel = model
            screen = .recoveryCode
        } catch {
            newCodeFailed = true
        }
    }

    private func startedOver(_ code: String?) {
        guard let code else { return finish(refreshing: true) }
        let model = makeRecoveryModel()
        model.show(code: code)
        unlockModel = nil
        recoveryModel = model
        screen = .recoveryCode
    }

    private func makeRecoveryModel() -> RecoveryCodeModel {
        let model = RecoveryCodeModel(inputs: baseInputs(), host: source.screens)
        model.onDone = { [weak self] in self?.finish(refreshing: true) }
        return model
    }

    /// Leaves every screen and drops its models (and with them any code in memory).
    public func dismiss() {
        // A running start-over and an unsaved new code are never dropped.
        if unlockModel?.minting == true || screen == .recoveryCode { return }
        finish(refreshing: false)
    }

    private func finish(refreshing: Bool) {
        screen = nil
        unlockModel = nil
        ringModel = nil
        recoveryModel?.clear()
        recoveryModel = nil
        guard refreshing else { return }
        Task {
            // The key is held: send what was waiting, then redraw from the machine.
            _ = try? await source.flush()
            await refresh()
        }
    }
}
