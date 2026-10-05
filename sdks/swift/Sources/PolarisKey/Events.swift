// `client.changes` — one multi-subscriber stream of what changed (notes/SDK-PARITY-PASS.md §3.11).
//
// Every subscriber gets its own `AsyncStream`; an event is delivered to every live subscriber, and
// a subscriber that stops iterating (its task cancelled, its view gone) is dropped. Nothing is
// replayed: read the current state (`status()`, `licenseInfo()`) when you subscribe, then react.
//
//   license         the gate inputs changed: a sync applied a new licence document, a credential
//                   was minted (activation, enrolment, sign-in, registration) or wiped
//                   (deactivation), or an offline bundle was imported
//   config          a sync applied a new config document, or a local override changed
//   updateAvailable `client.update.decide()` found a newer build (PolarisKeyUpdate emits it)
//   packs           a pack finished installing or failed (PolarisKeyUpdate emits it)
//   store           the credential store reported a failure
//
// Plus `lifecycle`: `syncOnForeground()` syncs when the app becomes active (UIKit/AppKit), with a
// floor between passes so a flurry of activations is one request.

import Foundation
import PolarisKeyCore
import PolarisKeyLicense

#if canImport(UIKit)
    import UIKit
#endif
#if canImport(AppKit)
    import AppKit
#endif

/// One change event.
public enum PolarisKeyEvent: Sendable, Equatable {
    case license(LicenseState)
    /// `key` is the changed key for a local override, nil for a whole new document.
    case config(key: String?)
    case updateAvailable(version: String)
    case packs(packId: String, result: String)
    case store(code: String)

    /// The event's kind name (`license`, `config`, `updateAvailable`, `packs`, `store`).
    public var kind: String {
        switch self {
        case .license: return "license"
        case .config: return "config"
        case .updateAvailable: return "updateAvailable"
        case .packs: return "packs"
        case .store: return "store"
        }
    }
}

/// The fan-out behind `client.changes`.
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

extension PolarisKeyClient {
    /// A new subscription to every change event. Each access returns its own stream.
    public nonisolated var changes: AsyncStream<PolarisKeyEvent> { events.stream() }

    /// Publish an event to every `changes` subscriber. The SDK's own modules call this
    /// (PolarisKeyUpdate for `updateAvailable` and `packs`); a host rarely needs to.
    public nonisolated func emit(_ event: PolarisKeyEvent) { events.emit(event) }

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
