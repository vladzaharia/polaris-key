// Cloud Sync client types and JSON helpers (U-07.1). A port of the data half of Python's
// `cloud_sync/machine.py` and client-core's `cloud-sync.ts`: the value helpers every later slice
// (machine, host codec, host) shares, and the plain types the machine and its host exchange.
//
// Absent is `nil`; a JSON `null` is the value `.null` and is never absent (U-06.5). Numbers are
// `.int` or `.double` in `JSONValue`; `jsonEqual` compares them numerically (`1` equals `1.0`) and a
// bool is never a number. Strings order by UTF-16 code unit, as JavaScript's `<` does.
//
// Nothing in here reads or logs a value's content: errors and descriptions name keys and codes only.

import Foundation

// MARK: - JSON helpers

/// The value is a finite number (an `.int`, or a finite `.double`); a bool is not a number.
public func syncIsNumber(_ v: JSONValue?) -> Bool {
    switch v {
    case .int?: return true
    case .double(let d)?: return d.isFinite
    default: return false
    }
}

/// The value is a number with no fraction (`2` and `2.0`; never a bool, `NaN` or an infinity).
public func syncIsInteger(_ v: JSONValue?) -> Bool {
    switch v {
    case .int?: return true
    case .double(let d)?: return d.isFinite && d == d.rounded(.towardZero)
    default: return false
    }
}

/// The finite number as a `Double`, or nil.
public func syncNumber(_ v: JSONValue?) -> Double? {
    guard syncIsNumber(v) else { return nil }
    return v?.doubleValue
}

/// Orders by UTF-16 code unit (JavaScript string order), not by Unicode scalar.
public func syncUTF16Less(_ a: String, _ b: String) -> Bool {
    a.utf16.lexicographicallyPrecedes(b.utf16)
}

/// Keys in UTF-16 order.
public func syncSortedKeys(_ keys: some Sequence<String>) -> [String] {
    keys.sorted(by: syncUTF16Less)
}

/// Structural equality over JSON values: object member order is ignored, numbers compare by value
/// (`1` equals `1.0`), a bool is never a number, and `null` equals only `null`. Two absent values
/// (nil) are equal; an absent value never equals a `null`.
public func jsonEqual(_ a: JSONValue?, _ b: JSONValue?) -> Bool {
    switch (a, b) {
    case (nil, nil): return true
    case (nil, _), (_, nil): return false
    case (.bool(let x)?, .bool(let y)?): return x == y
    case (.bool?, _), (_, .bool?): return false
    case (.null?, .null?): return true
    case (.string(let x)?, .string(let y)?): return x == y
    case (.array(let x)?, .array(let y)?):
        return x.count == y.count && zip(x, y).allSatisfy { jsonEqual($0, $1) }
    case (.object(let x)?, .object(let y)?):
        return x.count == y.count && x.allSatisfy { k, v in y[k].map { jsonEqual(v, $0) } ?? false }
    default:
        guard let x = syncNumber(a), let y = syncNumber(b) else { return false }
        if case .int(let i)? = a, case .int(let j)? = b { return i == j }
        return x == y
    }
}

/// The canonical text of a value: members in UTF-16 order, no whitespace, a whole-valued double
/// spelled as an integer. nil when the value cannot be spelled (a number that is not finite or an
/// integer over 2^53).
public func jsonCanonical(_ v: JSONValue) -> String? { try? CanonicalJSON.encode(v) }

/// The UTF-8 length of a value's canonical JSON (the 8 KiB setting bound). A value that cannot be
/// spelled counts as `Int.max`, so every size bound refuses it.
public func jsonBytes(_ v: JSONValue) -> Int {
    jsonCanonical(v).map { $0.utf8.count } ?? Int.max
}

/// A deep copy is a copy in Swift; this names where the machine hands a value to the app.
@inline(__always) public func jsonClone(_ v: JSONValue?) -> JSONValue? { v }

// MARK: - Results

/// The answer to a setting or record call: ok, or a short error code.
public enum CallResult: Sendable, Equatable {
    case ok
    case failed(String)

    public var isOK: Bool { if case .ok = self { return true } else { return false } }

    /// The corpus's `{ok: true}` / `{ok: false, error}` form.
    public var json: JSONValue {
        switch self {
        case .ok: return .object(["ok": .bool(true)])
        case .failed(let e): return .object(["ok": .bool(false), "error": .string(e)])
        }
    }
}

// MARK: - Partitions, operations and requests

/// The partition of a device nobody has signed in on.
public let syncLocalPartition = "local"

/// The most keys a partition's "ever sealed" latch holds (E2E); the oldest go first.
public let syncSealedLatchMax = 4096

public enum SyncPolicy: String, Sendable, Equatable, CaseIterable {
    case lastWrite, max, min, merge
}

public enum SyncScope: String, Sendable, Equatable {
    case user, platform
}

public enum SyncEncryption: String, Sendable, Equatable {
    case e2e, server
}

/// What a mutation addresses: a setting at a scope, or a record `(collection, id)`.
public enum SyncTarget: Sendable, Equatable {
    case setting(String, SyncScope)
    case record(String, String)

    public var json: JSONValue {
        switch self {
        case .setting(let key, let scope):
            return .object(["setting": .string(key), "scope": .string(scope.rawValue)])
        case .record(let collection, let id):
            return .object(["record": .array([.string(collection), .string(id)])])
        }
    }
}

public enum SyncOpName: String, Sendable, Equatable {
    case set, clear, setMember, removeMember, add, remove
}

/// Why a setting mutation waits on the device instead of being sent.
public enum SyncParkReason: String, Sendable, Equatable {
    case quota, entitlement
}

/// A mutation as the push body carries it, plus the journal-only marks.
public struct SyncOp: Sendable, Equatable {
    public var mutationId: Int
    public var target: SyncTarget
    public var op: SyncOpName
    public var value: JSONValue?
    public var member: String?
    public var element: JSONValue?
    public var observedSeq: Int?
    public var editedHlc: String?
    /// `nil` absent; `.some(nil)` is not used. `baseVersion: "*"` is `baseAny`.
    public var baseVersion: Int?
    public var baseAny: Bool
    public var preContact: Bool
    public var moved: Bool
    public var parked: SyncParkReason?

    public init(
        mutationId: Int, target: SyncTarget, op: SyncOpName, value: JSONValue? = nil,
        member: String? = nil, element: JSONValue? = nil, observedSeq: Int? = nil,
        editedHlc: String? = nil, baseVersion: Int? = nil, baseAny: Bool = false,
        preContact: Bool = false, moved: Bool = false, parked: SyncParkReason? = nil
    ) {
        self.mutationId = mutationId
        self.target = target
        self.op = op
        self.value = value
        self.member = member
        self.element = element
        self.observedSeq = observedSeq
        self.editedHlc = editedHlc
        self.baseVersion = baseVersion
        self.baseAny = baseAny
        self.preContact = preContact
        self.moved = moved
        self.parked = parked
    }

    /// The push body's form (no journal-only marks).
    public var wire: JSONValue {
        var o: [String: JSONValue] = [
            "mutationId": .int(mutationId), "target": target.json, "op": .string(op.rawValue),
        ]
        if let value { o["value"] = value }
        if let member { o["member"] = .string(member) }
        if let element { o["element"] = element }
        if let observedSeq { o["observedSeq"] = .int(observedSeq) }
        if let editedHlc { o["editedHlc"] = .string(editedHlc) }
        if baseAny { o["baseVersion"] = .string("*") } else if let baseVersion { o["baseVersion"] = .int(baseVersion) }
        return .object(o)
    }
}

/// A request the machine would send.
public struct SyncRequest: Sendable, Equatable {
    public enum Method: String, Sendable { case get = "GET", post = "POST" }
    public var method: Method
    public var path: String
    public var body: JSONValue?

    public init(method: Method, path: String, body: JSONValue? = nil) {
        self.method = method
        self.path = path
        self.body = body
    }

    public var json: JSONValue {
        var o: [String: JSONValue] = ["method": .string(method.rawValue), "path": .string(path)]
        if let body { o["body"] = body }
        return .object(o)
    }
}

/// What the transport answered: a status and body, or a transport failure.
public enum SyncResponse: Sendable, Equatable {
    case answer(status: Int, body: JSONValue?)
    case transport
}

// MARK: - The host codec's open results (E2E)

/// What the host's codec found for one row it was given. The host sets these from its own open of
/// the `ct`; the machine never reads them from a body.
public struct SyncOpenedRow: Sendable, Equatable {
    /// The host opened a `ct` for this row.
    public var sealed: Bool
    /// The row carried a `ct` the host could not open.
    public var invalid: Bool
    /// The row's store sequence: the change's `version` (§13.10.7). nil: not legacy.
    public var seq: Int?

    public init(sealed: Bool = false, invalid: Bool = false, seq: Int? = nil) {
        self.sealed = sealed
        self.invalid = invalid
        self.seq = seq
    }
}

/// The host's open results for one response. `changes` is parallel to `body.changes`; `conflicts`
/// is keyed by `mutationId`. Anything absent is a plaintext row with no `seq`.
public struct SyncOpenedBody: Sendable, Equatable {
    public var changes: [SyncOpenedRow?]
    public var conflicts: [Int: SyncOpenedRow]

    public init(changes: [SyncOpenedRow?] = [], conflicts: [Int: SyncOpenedRow] = [:]) {
        self.changes = changes
        self.conflicts = conflicts
    }

    /// Reads the corpus's `opened` object (`changes` parallel, `conflicts` keyed by id).
    public init(json: JSONValue) {
        func row(_ v: JSONValue?) -> SyncOpenedRow? {
            guard case .object(let o)? = v else { return nil }
            return SyncOpenedRow(
                sealed: o["sealed"]?.boolValue ?? false, invalid: o["invalid"]?.boolValue ?? false,
                seq: o["seq"]?.intValue)
        }
        let list = json.objectValue?["changes"]?.arrayValue ?? []
        var map: [Int: SyncOpenedRow] = [:]
        for (k, v) in json.objectValue?["conflicts"]?.objectValue ?? [:] {
            if let id = Int(k), let r = row(v) { map[id] = r }
        }
        self.init(changes: list.map(row), conflicts: map)
    }
}

// MARK: - Events and status

public enum SyncChangeOrigin: String, Sendable, Equatable {
    case local, remote, merge, migration
}

public enum SyncSignedOutReason: String, Sendable, Equatable {
    case signOut, accountRequired, subjectChanged
}

public enum SyncEvent: Sendable, Equatable {
    case change(keys: [String], origin: SyncChangeOrigin)
    case rejected(mutationId: Int, code: String)
    case signedOut(reason: SyncSignedOutReason, unsynced: Int)
    case unsyncedData(count: Int)
    case signInOffered(signInUrl: String?)

    /// The corpus's event form (`type` plus members).
    public var json: JSONValue {
        switch self {
        case .change(let keys, let origin):
            return .object([
                "type": .string("change"), "keys": .array(keys.map { .string($0) }),
                "origin": .string(origin.rawValue),
            ])
        case .rejected(let id, let code):
            return .object(["type": .string("rejected"), "mutationId": .int(id), "code": .string(code)])
        case .signedOut(let reason, let unsynced):
            return .object([
                "type": .string("signedOut"), "reason": .string(reason.rawValue), "unsynced": .int(unsynced),
            ])
        case .unsyncedData(let count):
            return .object(["type": .string("unsyncedData"), "count": .int(count)])
        case .signInOffered(let url):
            return .object(["type": .string("signInOffered"), "signInUrl": url.map { .string($0) } ?? .null])
        }
    }
}

public enum SyncValueFrom: String, Sendable, Equatable {
    case pending, cloud, device, document
}

/// A setting's effective value and where it came from.
public struct SyncEffectiveValue: Sendable, Equatable {
    public var value: JSONValue?
    public var from: SyncValueFrom

    public init(value: JSONValue?, from: SyncValueFrom) {
        self.value = value
        self.from = from
    }

    public var json: JSONValue {
        var o: [String: JSONValue] = ["from": .string(from.rawValue)]
        if let value { o["value"] = value }
        return .object(o)
    }
}

public enum SyncState: String, Sendable, Equatable {
    case local, idle, pending, syncing, offline, paused, blocked, locked, unsupported
}

public enum SyncBlockReason: String, Sendable, Equatable {
    case accountRequired = "account_required"
    case unauthorized, attestation, forbidden, keyring, encryption, quota, entitlement
}

public struct SyncStatus: Sendable, Equatable {
    public var state: SyncState
    public var pending: Int
    public var reason: SyncBlockReason?
    /// `sync-encryption-pinned` while `unsupported`.
    public var code: String?

    public init(state: SyncState, pending: Int, reason: SyncBlockReason? = nil, code: String? = nil) {
        self.state = state
        self.pending = pending
        self.reason = reason
        self.code = code
    }

    public var json: JSONValue {
        var o: [String: JSONValue] = ["state": .string(state.rawValue), "pending": .int(pending)]
        if let reason { o["reason"] = .string(reason.rawValue) }
        if let code { o["code"] = .string(code) }
        return .object(o)
    }
}

public enum SyncSettingSync: String, Sendable, Equatable {
    case local, pending, synced
}

public struct SyncSettingState: Sendable, Equatable {
    public var sync: SyncSettingSync
    public var invalid: Bool
    public var locked: Bool

    public init(sync: SyncSettingSync, invalid: Bool, locked: Bool) {
        self.sync = sync
        self.invalid = invalid
        self.locked = locked
    }

    public var json: JSONValue {
        .object(["sync": .string(sync.rawValue), "invalid": .bool(invalid), "locked": .bool(locked)])
    }
}
