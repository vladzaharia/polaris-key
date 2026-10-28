// Cloud Sync under `config` (U-07.8): the port the umbrella installs, and what routes through it.
// While a principal is held and the port is `active`, `set` and `clear` go through the sync machine, the
// effective value of a synced key is the machine's, and `setting(key).sync()` reports where it stands.
// Without a port (no Sync service, no signed-in person) nothing here changes: `config.local` decides.

import Foundation
import PolarisKeyCore

/// `local` with Cloud Sync off, no signed-in person or a `local` key; `pending` while an edit waits to be
/// sent; `synced` otherwise.
public typealias SettingSyncState = SyncSettingSync

/// What the Cloud Sync API gives the config client. The machine answers the refusals in its own order
/// (`bad_request`, then `managed_by_admin`).
public protocol ConfigSyncPort: Sendable {
    /// Cloud Sync is on and a principal is signed in.
    func active() async -> Bool
    func set(_ key: String, _ value: JSONValue) async -> CallResult
    func clear(_ key: String) async -> CallResult
    /// The machine's effective value; `from == .document` means the signed document decides.
    func get(_ key: String) async -> SyncEffectiveValue?
    func state(_ key: String) async -> SettingSyncState
}

extension ConfigClient {
    /// Cloud Sync's port (the client sets it once the host runs). Not an app verb.
    public func useSync(_ port: (any ConfigSyncPort)?) { syncPort = port }

    /// The legacy local values, for the one-time import into Cloud Sync. Not an app verb.
    public func importable() -> [String: JSONValue] { persisted }

    /// The machine changed these keys. The change observation diffs the values and raises each change
    /// once; this names where it came from. Not an app verb.
    public func noteSyncChange(keys: [String], origin: SyncChangeOrigin) async {
        for k in keys {
            syncKeys.insert(k)
            syncOrigins[k] = origin
        }
        let observer = changeObserver.current
        await observer?()
    }

    /// Where the last change of `key` came from, once; `local` when nothing named one.
    public func takeSyncOrigin(_ key: String) -> SyncChangeOrigin {
        syncOrigins.removeValue(forKey: key) ?? .local
    }

    /// A synced value the machine holds for `key`, or nil (the signed document or `config.local` decides).
    func syncedValue(_ key: String) async -> JSONValue? {
        guard let port = syncPort, await port.active(), let e = await port.get(key), e.from != .document,
            let v = e.value
        else { return nil }
        return v
    }

    /// The `sync()` of a handle.
    func settingSyncState(_ key: String) async -> SettingSyncState {
        guard let port = syncPort, await port.active() else { return .local }
        return await port.state(key)
    }
}

extension ConfigClient {
    /// The signed config document's values and the keys it locks, for the Cloud Sync machine.
    public func syncDocument() async -> SyncMachineDocument {
        let entries = await doc()?.config ?? [:]
        return SyncMachineDocument(
            values: entries.mapValues(\.value),
            locked: entries.filter { $0.value.state == .enforced || $0.value.state == .hidden }.map(\.key))
    }

    /// `GET /config/schema` as JSON, or nil on any failure.
    public func schemaJSON() async -> JSONValue? {
        guard let data = await fetchSchema() else { return nil }
        return try? JSONDecoder().decode(JSONValue.self, from: data)
    }
}
