// `client.events` — one multi-subscriber stream of what changed (notes/SDK-PARITY-PASS.md §3.11).
//
// Every subscriber gets its own `AsyncStream`; an event is delivered to every live subscriber, and
// a subscriber that stops iterating (its task cancelled, its view gone) is dropped. Nothing is
// replayed: read the current state (`status()`, `licenseInfo()`) when you subscribe, then react.
//
// The kinds and their fields are the ones every SDK uses (Python's `client.events`):
//
//   license         the gate status changed (`status`, `previous`): a sync, an activation,
//                   enrolment, sign-in or registration, a deactivation or sign-out, an import
//   entitlement     one entitlement's value changed (`name`, `value`, `previous`); a revoked or
//                   expired gate reads every entitlement as nil (S-19 G11)
//   config          one setting's effective value changed (`key`, `value`, `previous`,
//                   `source`), from a sync or from `config.set` / `config.clear`; the same
//                   diff reaches `config.onConfigChange(key, listener)` listeners
//   updateAvailable `client.update.decide()` offers a newer build (`version`, `action`,
//                   `mandatory`, `channel`; PolarisKeyUpdate emits it)
//   packs           pack install progress (`pack`, `phase`, `done`, `total`)
//   store           the credential store is degraded or failed (`reason`, `detail`)
//
// license, entitlement and config are derived the same way everywhere: after anything that can
// move them, the facade takes a fresh observation (gate status, every entitlement through the
// gate, every setting's effective value) and emits one event per difference from the last one.
//
// Plus `lifecycle`: `syncOnForeground()` syncs when the app becomes active (UIKit/AppKit), with a
// floor between passes so a flurry of activations is one request.

import Foundation
import PolarisKeyConfig
import PolarisKeyCore
import PolarisKeyLicense

#if canImport(UIKit)
    import UIKit
#endif
#if canImport(AppKit)
    import AppKit
#endif

/// One change event. The kind names and field names are the same in every SDK.
public enum PolarisKeyEvent: Sendable, Equatable {
    /// The gate status changed.
    case license(status: LicenseStatus, previous: LicenseStatus)
    /// One entitlement's value changed; nil while absent or while the gate is not usable.
    case entitlement(name: String, value: JSONValue?, previous: JSONValue?)
    /// One setting's effective value changed; nil while it has none.
    case config(key: String, value: JSONValue?, previous: JSONValue?, source: ConfigSource)
    /// A decision offers a newer build.
    case updateAvailable(version: String, action: String, mandatory: Bool, channel: String)
    /// Pack install progress: `download`, `apply`, `done` or `state-issue`.
    case packs(pack: String, phase: String, done: Int, total: Int)
    /// The credential store is degraded (`StoreDegradedReason`) or a write failed
    /// (`store-failed`).
    case store(reason: String, detail: String?)

    /// The event's kind name (`license`, `entitlement`, `config`, `updateAvailable`, `packs`,
    /// `store`).
    public var kind: String {
        switch self {
        case .license: return "license"
        case .entitlement: return "entitlement"
        case .config: return "config"
        case .updateAvailable: return "updateAvailable"
        case .packs: return "packs"
        case .store: return "store"
        }
    }

    /// Every kind name, in the shared order.
    public static let kinds = ["license", "entitlement", "config", "updateAvailable", "packs", "store"]
}

/// The fan-out behind `client.events`.
public final class PolarisEventHub: Sendable {
    private let subscribers = LockedValue<[UUID: AsyncStream<PolarisKeyEvent>.Continuation]>([:])

    public init() {}

    /// A new subscription.
    public func stream() -> AsyncStream<PolarisKeyEvent> {
        let id = UUID()
        let (stream, continuation) = AsyncStream<PolarisKeyEvent>.makeStream(
            bufferingPolicy: .bufferingNewest(64))
        subscribers.with { $0[id] = continuation }
        continuation.onTermination = { [subscribers] _ in
            subscribers.with { $0[id] = nil }
        }
        return stream
    }

    /// Deliver `event` to every live subscriber.
    public func emit(_ event: PolarisKeyEvent) {
        for c in subscribers.current.values { c.yield(event) }
    }

    /// The number of live subscribers (diagnostics, tests).
    public var subscriberCount: Int { subscribers.current.count }
}

/// What the license, entitlement and config events are diffed from.
struct ChangeObservation: Sendable, Equatable {
    var status: LicenseStatus
    var entitlements: [String: JSONValue]
    var config: [String: JSONValue]
    var storeFailure: StoreError?
}

/// Turns "something may have changed" into one event per difference. Publishes are serialised, so
/// two overlapping ones cannot emit the same change twice or lose one.
actor ChangePublisher {
    let hub: PolarisEventHub
    private let observe: @Sendable () async -> ChangeObservation
    private let source: @Sendable (String) async -> ConfigSource
    private let deliver: @Sendable (ConfigChange) -> Void
    private var observed: ChangeObservation?
    private var tail: Task<Void, Never>?

    init(
        hub: PolarisEventHub,
        observe: @escaping @Sendable () async -> ChangeObservation,
        source: @escaping @Sendable (String) async -> ConfigSource,
        deliver: @escaping @Sendable (ConfigChange) -> Void = { _ in }
    ) {
        self.hub = hub
        self.observe = observe
        self.source = source
        self.deliver = deliver
    }

    /// Take the baseline without emitting (the client's `start()`).
    func baseline() async {
        await publish(emitting: false)
    }

    /// Observe again and emit what differs from the last observation. Before a baseline exists
    /// this only takes one.
    func publish() async {
        await publish(emitting: true)
    }

    private func publish(emitting: Bool) async {
        let previous = tail
        let task = Task { await previous?.value; await self.run(emitting: emitting) }
        tail = task
        await task.value
    }

    private func run(emitting: Bool) async {
        let after = await observe()
        let before = observed
        observed = after
        guard emitting, let before else { return }
        if before.status != after.status {
            hub.emit(.license(status: after.status, previous: before.status))
        }
        for name in Set(before.entitlements.keys).union(after.entitlements.keys).sorted() {
            let a = after.entitlements[name]
            let b = before.entitlements[name]
            if a != b { hub.emit(.entitlement(name: name, value: a, previous: b)) }
        }
        for key in Set(before.config.keys).union(after.config.keys).sorted() {
            let a = after.config[key]
            let b = before.config[key]
            if a != b {
                let src = await source(key)
                hub.emit(.config(key: key, value: a, previous: b, source: src))
                deliver(ConfigChange(key: key, value: a, previous: b, source: src))
            }
        }
        if let failure = after.storeFailure, failure != before.storeFailure {
            hub.emit(.store(reason: ErrorCode.storeFailed, detail: String(describing: failure)))
        }
    }
}

extension PolarisKeyClient {
    /// A new subscription to every change event. Each access returns its own stream.
    public nonisolated var events: AsyncStream<PolarisKeyEvent> { eventHub.stream() }

    /// The earlier name of `events`.
    @available(*, deprecated, renamed: "events")
    public nonisolated var changes: AsyncStream<PolarisKeyEvent> { events }

    /// Publish an event to every `events` subscriber. A host rarely needs to; the SDK's own
    /// modules raise theirs through Core.
    public nonisolated func emit(_ event: PolarisKeyEvent) { eventHub.emit(event) }

    /// Sync whenever the app becomes active (UIKit `didBecomeActive`, AppKit `didBecomeActive`),
    /// at most once per `minimumInterval` seconds. Idempotent; `stopForegroundSync()` ends it.
    /// SwiftUI hosts get this from `.polarisKey(client)` (scene phase), so they need not call it.
    public func syncOnForeground(minimumInterval: Double = 60) {
        guard foregroundObserver == nil, !core.localOnly else { return }
        #if canImport(UIKit) && !os(watchOS)
            let name = UIApplication.didBecomeActiveNotification
        #elseif canImport(AppKit)
            let name = NSApplication.didBecomeActiveNotification
        #else
            return
        #endif
        #if canImport(UIKit) || canImport(AppKit)
            foregroundObserver = ForegroundObserver(name: name) { [weak self] in
                Task { await self?.syncIfStale(minimumInterval: minimumInterval) }
            }
        #endif
    }

    public func stopForegroundSync() {
        foregroundObserver = nil
    }

    /// Sync unless one ran within `minimumInterval` seconds. Returns nil when skipped.
    @discardableResult
    public func syncIfStale(minimumInterval: Double = 60) async -> SyncResult? {
        let now = Date().timeIntervalSince1970
        if let last = lastForegroundSync, now - last < minimumInterval { return nil }
        lastForegroundSync = now
        return await sync()
    }
}

/// A NotificationCenter observation that ends when released.
final class ForegroundObserver: @unchecked Sendable {
    private let token: NSObjectProtocol

    init(name: Notification.Name, _ action: @escaping @Sendable () -> Void) {
        token = NotificationCenter.default.addObserver(forName: name, object: nil, queue: nil) { _ in
            action()
        }
    }

    deinit { NotificationCenter.default.removeObserver(token) }
}
