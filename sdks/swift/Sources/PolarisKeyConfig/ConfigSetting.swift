// Per-key reads and change delivery over the local overrides (notes/SDK-PARITY-PASS.md §3.11,
// `config.local`): `config.setting(key)` and `config.onConfigChange(key, listener)`, the names
// Node uses (S-17 §5.11 adds Cloud Sync state under the same API later).
//
// A change is one key's EFFECTIVE value moving, whatever moved it: `config.set` / `clear` /
// `clearAll`, or a sync that brought a new signed document. Under `PolarisKeyClient` the facade's
// one change observation feeds both `client.events` (`config` events) and these listeners, so a
// listener and an `events` subscriber see the same changes, once each. A bare `ConfigClient`
// (no facade) diffs its own snapshot around `set` / `clear` / `clearAll`.
//
// Listeners for `"*"` get every key's changes. Delivery happens before `set` / `clear` return.

import Foundation
import PolarisKeyCore

/// One setting's effective value changed (`onConfigChange`, `client.events` `config`).
public struct ConfigChange: Sendable, Equatable {
    public let key: String
    /// The new effective value; nil when the key has none now.
    public let value: JSONValue?
    /// The effective value before; nil when it had none.
    public let previous: JSONValue?
    /// Where the new value comes from.
    public let source: ConfigSource

    public init(key: String, value: JSONValue?, previous: JSONValue?, source: ConfigSource) {
        self.key = key
        self.value = value
        self.previous = previous
        self.source = source
    }
}

/// A listener registration. `cancel()` stops delivery; it is idempotent. Releasing the handle
/// does NOT cancel (as Node's unsubscribe function), so a fire-and-forget listener stays live.
public final class ConfigSubscription: Sendable {
    private let onCancel: LockedValue<(@Sendable () -> Void)?>

    init(_ onCancel: @escaping @Sendable () -> Void) { self.onCancel = LockedValue(onCancel) }

    public func cancel() {
        let action = onCancel.with { value -> (@Sendable () -> Void)? in
            defer { value = nil }
            return value
        }
        action?()
    }

    /// Whether `cancel()` has run.
    public var isCancelled: Bool { onCancel.current == nil }
}

/// One setting now: its effective value, where it comes from and whether the operator locked it.
public struct ConfigSettingState: Sendable, Equatable {
    /// The effective value; nil when no layer has one (source `fallback`).
    public let value: JSONValue?
    public let source: ConfigSource
    /// `enforced` or `hidden` in the signed document: `set` would be refused.
    public let locked: Bool

    public init(value: JSONValue?, source: ConfigSource, locked: Bool) {
        self.value = value
        self.source = source
        self.locked = locked
    }
}

/// A handle on one key (`config.setting(key)`): read it, write it, follow it.
public struct ConfigSetting: Sendable {
    public let key: String
    let client: ConfigClient

    /// The effective value, its source and whether it is locked, read together.
    public func current() async -> ConfigSettingState { await client.settingState(key) }

    /// The effective value, or `fallback` when no layer has one.
    public func value(default fallback: JSONValue) async -> JSONValue {
        await client.config(key, default: fallback)
    }

    /// Where the effective value comes from.
    public func source() async -> ConfigSource { await client.configSource(key) }

    /// Whether the operator locked the key (`enforced` or `hidden`).
    public func isLocked() async -> Bool { await client.isLocked(key) }

    /// `config.set(key, value)`.
    public func set(_ value: JSONValue) async throws { try await client.set(key, value) }

    /// `config.clear(key)`.
    public func clear() async { await client.clear(key) }

    /// `config.onConfigChange(key, listener)`.
    @discardableResult
    public func onChange(_ listener: @escaping @Sendable (ConfigChange) -> Void) -> ConfigSubscription {
        client.onConfigChange(key, listener)
    }

    /// This key's changes as a stream (ends when the iterating task is cancelled).
    public var changes: AsyncStream<ConfigChange> { client.configChanges(key) }
}

/// The listener registry (`ConfigClient.listeners`).
final class ConfigListeners: Sendable {
    private let entries = LockedValue<[UUID: (key: String, listener: @Sendable (ConfigChange) -> Void)]>([:])

    func add(_ key: String, _ listener: @escaping @Sendable (ConfigChange) -> Void) -> ConfigSubscription {
        let id = UUID()
        entries.with { $0[id] = (key, listener) }
        return ConfigSubscription { [entries] in _ = entries.with { $0.removeValue(forKey: id) } }
    }

    func deliver(_ change: ConfigChange) {
        let targets = entries.current.values.filter { $0.key == change.key || $0.key == "*" }
        for t in targets { t.listener(change) }
    }
}

extension ConfigClient {
    /// A handle on `key`: its value and source, `set` / `clear`, and its changes.
    public nonisolated func setting(_ key: String) -> ConfigSetting { ConfigSetting(key: key, client: self) }

    /// Call `listener` whenever `key`'s effective value changes (`"*"`: any key's), from a local
    /// `set` / `clear` / `clearAll` or a sync. Returns the handle that cancels it.
    @discardableResult
    public nonisolated func onConfigChange(
        _ key: String, _ listener: @escaping @Sendable (ConfigChange) -> Void
    ) -> ConfigSubscription {
        listeners.add(key, listener)
    }

    /// `onConfigChange` as an `AsyncStream` (`"*"`: every key). The registration ends when the
    /// stream terminates (the iterating task cancelled or the stream released).
    public nonisolated func configChanges(_ key: String = "*") -> AsyncStream<ConfigChange> {
        let (stream, continuation) = AsyncStream<ConfigChange>.makeStream(bufferingPolicy: .bufferingNewest(64))
        let subscription = listeners.add(key) { continuation.yield($0) }
        continuation.onTermination = { _ in subscription.cancel() }
        return stream
    }

    /// Deliver one change to the listeners. The facade calls it from its change observation (the
    /// same diff that raises `client.events` `config`); a host rarely needs to.
    public nonisolated func deliver(_ change: ConfigChange) { listeners.deliver(change) }

    /// Route local changes through the facade's change observation instead of this client's own
    /// diff (`PolarisKeyClient` installs it, so a change is observed once for `events` and for
    /// listeners). `set` / `clear` await it before returning.
    public nonisolated func setChangeObserver(_ observe: (@Sendable () async -> Void)?) {
        changeObserver.set(observe)
    }
}
