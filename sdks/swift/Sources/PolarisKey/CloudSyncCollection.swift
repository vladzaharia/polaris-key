// The records handle of a Cloud Sync collection (plans/C-26 D-2): `client.cloudSync.collection(name)`
// over the host's machine, with the catalog checks made before anything is journalled. A refused call
// changes nothing and sends nothing and is returned, never thrown. The refusal names are the registered
// wire codes (errors.json): `collection_unknown` for a name the catalog does not declare,
// `op_invalid_for_policy` for a verb the collection's policy does not allow, `value_invalid` for a value or
// name over a cap; `signed_out` is local. A port of client-core's `SyncCollection`.

import Foundation
import PolarisKeyCore

/// The most bytes of a `merge` field name (§13.3).
let collectionMaxFieldBytes = 1024

/// Why a collection call was refused.
public enum CollectionError: String, Sendable, Equatable {
    case collectionUnknown = "collection_unknown"
    case opInvalidForPolicy = "op_invalid_for_policy"
    case valueInvalid = "value_invalid"
    case signedOut = "signed_out"
}

public enum CollectionResult: Sendable, Equatable {
    /// Accepted. `mutationId` is the ticket of a compare-and-set `put` or a `revision` `delete`: its outcome
    /// goes to the handle's listeners as `.outcome`.
    case ok(mutationId: Int?)
    case refused(CollectionError)

    public var isOK: Bool { if case .ok = self { return true } else { return false } }
}

/// What a collection listener is told.
public enum CollectionEvent: Sendable, Equatable {
    /// Records of the collection changed (ids in byte order), by this device or another.
    case change(ids: [String], origin: SyncChangeOrigin)
    /// The result of a compare-and-set write the handle made.
    case outcome(mutationId: Int, SyncRecordOutcome)
}

/// A registered listener; `cancel()` removes it.
public final class CollectionSubscription: Sendable {
    private let remove: @Sendable () async -> Void
    init(_ remove: @escaping @Sendable () async -> Void) { self.remove = remove }
    public func cancel() async { await remove() }
}

/// `client.cloudSync.collection(name)`.
public final class CloudSyncCollection: Sendable {
    public let name: String
    private let host: CloudSyncHost
    private let state = LockedValue(State())

    private struct State {
        var listeners: [Int: @Sendable (CollectionEvent) -> Void] = [:]
        var next = 0
        var tickets = Set<Int>()
        var watching = false
        var eventListener: Int?
        var tap: Int?
    }

    init(name: String, host: CloudSyncHost) {
        self.name = name
        self.host = host
    }

    /// The declared policy (`revision`, `union`, `lastWrite`, `max`, `min`, `merge`), or nil for a name the
    /// catalog does not declare.
    public func policy() async -> String? { await host.collectionPolicy(name) }

    /// The effective value (pending edits over the cloud copy) or nil. An undeclared name is nil; stored JSON
    /// comes back untouched, so a field this version does not know survives.
    public func get(_ id: String) async -> SyncEffectiveValue? { await host.collectionGet(name, id) }

    /// The ids of the records a person holds, in byte order, pending creates included.
    public func ids() async -> [String] { await host.collectionIds(name) }

    /// `lastWrite`, `max`, `min`: a stamped write. `revision`: a write based on the version held, or on
    /// `ifVersion` (`.version(n)`, or `.any` to create only) as an exact compare-and-set, whose outcome goes to
    /// the listeners as `.outcome`.
    @discardableResult
    public func put(_ id: String, _ value: JSONValue, ifVersion: SyncBase? = nil) async -> CollectionResult {
        await apply(id, .put(value, ifVersion))
    }

    /// `merge`: write the named fields and drop the named ones. Others stay as stored.
    @discardableResult
    public func update(_ id: String, set: [String: JSONValue] = [:], remove: [String] = []) async
        -> CollectionResult
    {
        await apply(id, .update(set: set, remove: remove))
    }

    /// `union`: add an element (at most 1 KiB of canonical JSON).
    @discardableResult
    public func add(_ id: String, _ element: JSONValue) async -> CollectionResult { await apply(id, .add(element)) }

    /// `union`: remove an element, observed at the current cursor.
    @discardableResult
    public func remove(_ id: String, _ element: JSONValue) async -> CollectionResult {
        await apply(id, .remove(element))
    }

    /// Delete the record. For `revision`, `ifVersion` is the compare-and-set base (default: the version held,
    /// else `.any`).
    @discardableResult
    public func delete(_ id: String, ifVersion: SyncBase? = nil) async -> CollectionResult {
        await apply(id, .delete(ifVersion))
    }

    /// Changes to this collection, including the ones this device makes. A listener runs on the host's
    /// turn and must not call back into the handle; `cancel()` on the result removes it.
    public func on(_ listener: @escaping @Sendable (CollectionEvent) -> Void) async -> CollectionSubscription {
        let (id, first) = state.with { s -> (Int, Bool) in
            s.next += 1
            s.listeners[s.next] = listener
            defer { s.watching = true }
            return (s.next, !s.watching)
        }
        if first { await watch() }
        return CollectionSubscription { [weak self] in await self?.unsubscribe(id) }
    }

    // MARK: internals

    private func apply(_ id: String, _ verb: CloudSyncHost.CollectionVerb) async -> CollectionResult {
        let state = self.state
        // Tickets are kept only while a listener is registered, and before the outcome can settle.
        return await host.collectionApply(name, id, verb) { ticket in
            state.with { if !$0.listeners.isEmpty { $0.tickets.insert(ticket) } }
        }
    }

    private func watch() async {
        let name = self.name
        await host.watchCollection(name)
        let eventId = await host.onEvents { [weak self] events in
            for e in events {
                if case .records(let c, let ids, let origin) = e, c == name {
                    self?.emit(.change(ids: ids, origin: origin))
                }
            }
        }
        let tap = await host.addOutcomeTap { [weak self] ticket, outcome in
            guard let self else { return }
            let mine = self.state.with { $0.tickets.remove(ticket) != nil }
            if mine { self.emit(.outcome(mutationId: ticket, outcome)) }
        }
        state.with {
            $0.eventListener = eventId
            $0.tap = tap
        }
    }

    private func unsubscribe(_ id: Int) async {
        let (last, eventId, tap) = state.with { s -> (Bool, Int?, Int?) in
            s.listeners[id] = nil
            guard s.listeners.isEmpty, s.watching else { return (false, nil, nil) }
            defer {
                s.watching = false
                s.eventListener = nil
                s.tap = nil
                s.tickets = []
            }
            return (true, s.eventListener, s.tap)
        }
        guard last else { return }
        if let eventId { await host.removeListener(eventId) }
        if let tap { await host.removeOutcomeTap(tap) }
        await host.unwatchCollection(name)
    }

    private func emit(_ event: CollectionEvent) {
        let fns = state.with { s in s.listeners.keys.sorted().compactMap { s.listeners[$0] } }
        for fn in fns { fn(event) }
    }
}
