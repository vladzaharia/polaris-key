// The Cloud Sync client state machine, local half (U-07.2): a port of Python's
// `cloud_sync/machine.py` up to the first server answer (HLC, value schema, setting operations,
// journal, drafts and debounce, partitions, routes, `importLocal`, `get`, `settingState`, `status`,
// `persist`, `relaunch`, the sign-in and sign-out moves, the E2E gate and the request builder).
// `receive` and everything it drives (conflict rebase, records answers, pulls) arrive in U-07.3,
// the E2E open half and the X-1 `copyRow` cursor in U-07.4.
//
// The machine does no I/O and reads no catalog: the host derives the setting routes with
// `syncedSettings` and passes them in. It owns a fake-able clock (`advance`), queues the requests it
// would send (`takeRequests`) and the events it would emit (`takeEvents`). At most one request is in
// flight. It is a non-`Sendable` class confined to its host actor. Nothing here touches licence
// state, and no value is ever put in an error, log or `description` (H-11).

import Foundation

// MARK: - Options and persisted state

public struct SyncCollectionDecl: Sendable, Equatable {
    public var name: String
    /// `revision`, `union`, `lastWrite`, `max`, `min` or `merge`.
    public var policy: String
    public var field: String?
    public var resolve: String?

    public init(name: String, policy: String, field: String? = nil, resolve: String? = nil) {
        self.name = name
        self.policy = policy
        self.field = field
        self.resolve = resolve
    }
}

public struct SyncMachineCatalog: Sendable, Equatable {
    public var settings: [SettingRoute]
    public var collections: [SyncCollectionDecl]

    public init(settings: [SettingRoute], collections: [SyncCollectionDecl] = []) {
        self.settings = settings
        self.collections = collections
    }
}

/// The rest of the resolution chain under the `local` slot, and the keys the current signed config
/// document marks `enforced` or `hidden`.
public struct SyncMachineDocument: Sendable, Equatable {
    public var values: [String: JSONValue]
    public var locked: [String]

    public init(values: [String: JSONValue] = [:], locked: [String] = []) {
        self.values = values
        self.locked = locked
    }
}

public enum SyncNetwork: String, Sendable, Equatable { case online, offline }

public enum SyncOnSignOut: String, Sendable, Equatable { case clear, keep }

/// What discovery says about `services.sync.encryption`: `e2e`, `server`, or a Worker that omits it.
public enum SyncAdvertised: String, Sendable, Equatable { case e2e, server, omitted }

/// A host-supplied client id that does not match `SYNC_CLIENT_ID_PATTERN`.
public enum SyncMachineError: Error, Equatable { case badClientId }

public struct SyncMachineOptions {
    public var product: String
    public var catalog: SyncMachineCatalog
    public var document: SyncMachineDocument
    public var now: Int
    public var offsetMs: Int = 0
    public var contacted: Bool = false
    public var subject: String?
    public var network: SyncNetwork = .online
    public var onSignOut: SyncOnSignOut = .clear
    public var deviceLocal: [String: JSONValue] = [:]
    public var imported: Bool = false
    public var newClientId: () -> String
    /// The app's mode; default `e2e`.
    public var encryption: SyncEncryption = .e2e
    public var hasRoot: Bool = false
    public var discovery: SyncAdvertised?

    public init(
        product: String, catalog: SyncMachineCatalog, document: SyncMachineDocument, now: Int,
        newClientId: @escaping () -> String
    ) {
        self.product = product
        self.catalog = catalog
        self.document = document
        self.now = now
        self.newClientId = newClientId
    }
}

/// A server row held in a partition's snapshot (a setting or a record).
public struct SyncRow: Sendable, Equatable {
    public var value: JSONValue
    public var version: Int
    /// The row could not be read (E2E open failed).
    public var bad: Bool = false
    /// A plaintext row's store sequence (legacy only while below `encryptionSince`).
    public var plain: Int?

    public init(value: JSONValue, version: Int, bad: Bool = false, plain: Int? = nil) {
        self.value = value
        self.version = version
        self.bad = bad
        self.plain = plain
    }
}

/// A setting held in the local partition.
public struct SyncDeviceSetting: Sendable, Equatable {
    public var value: JSONValue?
    public var cleared: Bool
    public var editedHlc: String
    public var preContact: Bool

    public init(value: JSONValue? = nil, cleared: Bool = false, editedHlc: String, preContact: Bool = false) {
        self.value = value
        self.cleared = cleared
        self.editedHlc = editedHlc
        self.preContact = preContact
    }

    var json: JSONValue {
        var o: [String: JSONValue] = ["editedHlc": .string(editedHlc)]
        if cleared { o["cleared"] = .bool(true) } else if let value { o["value"] = value }
        if preContact { o["preContact"] = .bool(true) }
        return .object(o)
    }
}

public struct SyncPartition: Sendable, Equatable {
    public var clientId: String?
    public var nextMutationId: Int = 1
    public var cursor: Int = 0
    public var pending: [SyncOp] = []
    /// Revision records written while their push was in flight, by `collection/id`.
    public var held: [String: JSONValue] = [:]
    public var settings: [String: SyncRow] = [:]
    public var records: [String: SyncRow] = [:]
    public var device: [String: SyncDeviceSetting] = [:]
    public var signedOutAt: Int?
    public var encryptionSince: Int?
    /// The keys this machine has seen sealed (E2E latch), oldest first, at most `syncSealedLatchMax`.
    public var sealedKeys: [String] = []
    /// The lowest version this machine pushed or opened sealed.
    public var sealedFloor: Int?
    /// Quota minus usage on the last response, in bytes.
    public var headroom: Double?

    public init(clientId: String?) { self.clientId = clientId }
}

/// What survives a relaunch.
public struct SyncMachineState: Sendable, Equatable {
    public var subject: String?
    public var partitions: [String: SyncPartition]
    public var hlc: (physical: Int, counter: Int)
    public var offsetMs: Int
    public var contacted: Bool
    public var aliases: [String: String] = [:]
    public var blocked: SyncBlockReason?
    public var deviceLocal: [String: JSONValue]
    public var imported: Bool
    public var e2eSeen: Bool = false

    public init(
        subject: String?, partitions: [String: SyncPartition], hlc: (physical: Int, counter: Int), offsetMs: Int,
        contacted: Bool, aliases: [String: String] = [:], blocked: SyncBlockReason? = nil,
        deviceLocal: [String: JSONValue] = [:], imported: Bool = false, e2eSeen: Bool = false
    ) {
        self.subject = subject
        self.partitions = partitions
        self.hlc = hlc
        self.offsetMs = offsetMs
        self.contacted = contacted
        self.aliases = aliases
        self.blocked = blocked
        self.deviceLocal = deviceLocal
        self.imported = imported
        self.e2eSeen = e2eSeen
    }

    public static func == (a: Self, b: Self) -> Bool {
        a.subject == b.subject && a.partitions == b.partitions && a.hlc == b.hlc && a.offsetMs == b.offsetMs
            && a.contacted == b.contacted && a.aliases == b.aliases && a.blocked == b.blocked
            && a.deviceLocal == b.deviceLocal && a.imported == b.imported && a.e2eSeen == b.e2eSeen
    }
}

extension SyncOp {
    /// The journal's form: the wire form plus the journal-only marks.
    public var journalJSON: JSONValue {
        guard case .object(var o) = wire else { return wire }
        if preContact { o["preContact"] = .bool(true) }
        if moved { o["moved"] = .bool(true) }
        if let parked { o["parked"] = .string(parked.rawValue) }
        return .object(o)
    }
}

extension SettingRoute {
    /// Reads a corpus or catalog route object (`key`, `route`, `scope`, `policy`, `schema`).
    public init?(json: JSONValue) {
        guard let o = json.objectValue, let key = o["key"]?.stringValue,
            let kind = o["route"]?.stringValue.flatMap(SettingRouteKind.init(rawValue:))
        else { return nil }
        self.init(
            key: key, route: kind, scope: o["scope"]?.stringValue.flatMap(SyncScope.init(rawValue:)),
            policy: o["policy"]?.stringValue.flatMap(SyncPolicy.init(rawValue:)),
            listed: o["listed"]?.boolValue, schema: o["schema"],
            encryption: o["encryption"]?.stringValue.flatMap(SyncEncryption.init(rawValue:)))
    }
}

// MARK: - Pure rules

/// "HLC": 12 hex digits of physical milliseconds, a colon, 4 of counter.
public func syncFormatHLC(physical: Int, counter: Int) -> String {
    func hex(_ n: Int, _ width: Int) -> String {
        let s = String(max(0, n), radix: 16)
        return String(repeating: "0", count: max(0, width - s.count)) + s
    }
    return hex(physical, 12) + ":" + hex(counter, 4)
}

/// Whether `value` satisfies the schema subset (absent schema: anything).
public func syncValueValid(_ value: JSONValue?, _ schema: JSONValue?) -> Bool {
    guard case .object(let s)? = schema, !s.isEmpty else { return true }
    switch s["type"]?.stringValue {
    case "number", "integer":
        guard let n = syncNumber(value) else { return false }
        if s["type"]?.stringValue == "integer" && !syncIsInteger(value) { return false }
        if let lo = syncNumber(s["minimum"]), n < lo { return false }
        if let hi = syncNumber(s["maximum"]), n > hi { return false }
    case "string": if value?.stringValue == nil { return false }
    case "boolean": if value?.boolValue == nil { return false }
    case "object": if value?.objectValue == nil { return false }
    default: break
    }
    guard let en = s["enum"]?.arrayValue else { return true }
    return en.contains { jsonEqual($0, value) }
}

/// One setting operation applied to a value under the key's policy. nil is "no value"; a JSON
/// `null` is a value.
public func syncApplySettingOp(_ policy: String, _ base: JSONValue?, _ op: SyncOp) -> JSONValue? {
    switch op.op {
    case .clear: return nil
    case .set:
        let v = op.value ?? .null
        if policy == "max" || policy == "min", let b = syncNumber(base), let n = syncNumber(v) {
            // Python's max/min keep the first operand on a tie.
            if policy == "max" { return n > b ? v : base }
            return n < b ? v : base
        }
        return v
    case .setMember:
        var o = base?.objectValue ?? [:]
        if let m = op.member { o[m] = op.value ?? .null }
        return .object(o)
    case .removeMember:
        var o = base?.objectValue ?? [:]
        if let m = op.member { o.removeValue(forKey: m) }
        return .object(o)
    default: return base
    }
}

func syncApplyRecordOp(_ base: JSONValue?, _ op: SyncOp) -> JSONValue? {
    switch op.op {
    case .set: return op.value ?? .null
    case .setMember, .removeMember: return syncApplySettingOp("merge", base, op)
    case .add:
        var arr = base?.arrayValue ?? []
        if !arr.contains(where: { jsonEqual($0, op.element) }) { arr.append(op.element ?? .null) }
        return .array(arr)
    case .remove:
        return .array((base?.arrayValue ?? []).filter { !jsonEqual($0, op.element) })
    default: return base
    }
}

func syncRecordKey(_ c: String, _ i: String) -> String { "\(c)/\(i)" }

private let dayMs = 86_400_000

// MARK: - The machine

public final class CloudSyncMachine {
    struct Draft {
        var value: JSONValue?
        var clear: Bool
        var editedHlc: String
        var preContact: Bool
        var due: Int
    }

    struct InFlight {
        enum Kind { case push, pull }
        var kind: Kind
        var partition: String
        var cursor: Int
        var mutationIds: [Int]
    }

    struct SigningOut {
        var deadline: Int
        var discard: Bool
    }

    struct Layer {
        var value: JSONValue?
        var from: SyncValueFrom
        var pending: Bool
    }

    let product: String
    let catalog: SyncMachineCatalog
    var document: SyncMachineDocument
    let onSignOut: SyncOnSignOut
    let newClientId: () -> String
    let appEncryption: SyncEncryption
    var root: Bool
    /// What the Worker advertised this session; nil: not yet known.
    var advertised: SyncAdvertised?
    var now: Int
    var network: SyncNetwork
    var drafts: [String: Draft] = [:]
    var inFlight: InFlight?
    var signingOut: SigningOut?
    var needSnapshot = false
    var pullWanted = false
    var paused = false
    var outbox: [SyncRequest] = []
    var events: [SyncEvent] = []
    var s: SyncMachineState

    public init(_ opts: SyncMachineOptions, persisted: SyncMachineState? = nil) throws {
        product = opts.product
        catalog = opts.catalog
        document = opts.document
        onSignOut = opts.onSignOut
        newClientId = opts.newClientId
        appEncryption = opts.encryption
        root = opts.hasRoot
        now = opts.now
        network = opts.network
        if let persisted {
            s = persisted
        } else {
            s = SyncMachineState(
                subject: opts.subject, partitions: [syncLocalPartition: SyncPartition(clientId: nil)],
                hlc: (0, 0), offsetMs: opts.offsetMs, contacted: opts.contacted, deviceLocal: opts.deviceLocal,
                imported: opts.imported)
        }
        if s.partitions[syncLocalPartition] == nil { s.partitions[syncLocalPartition] = SyncPartition(clientId: nil) }
        if let d = opts.discovery { advertised = d }
        if let subject = s.subject { _ = try partitionFor(subject) }
        expirePartitions()
        pullWanted = true
        kick()
    }

    // MARK: host surface

    public var clockNow: Int { now }
    /// The person the machine is signed in as; nil while signed out. (Read-only, for the host's
    /// request binding; `persist()` is not a read, it commits drafts.)
    public var subject: String? { s.subject }
    /// A request was taken and has no answer yet: `receive` is only valid while this holds.
    public var awaitingAnswer: Bool { inFlight != nil }
    public var networkState: SyncNetwork { network }

    /// What survives a relaunch (the drafts are committed first, as the exit flush does).
    public func persist() -> SyncMachineState {
        commitAllDrafts()
        return s
    }

    public func takeRequests() -> [SyncRequest] {
        defer { outbox = [] }
        return outbox
    }

    public func takeEvents() -> [SyncEvent] {
        defer { events = [] }
        return events
    }

    // MARK: SDK calls

    /// `config.set` while Cloud Sync is on.
    public func set(_ key: String, _ value: JSONValue) -> CallResult { edit(key, value: value, clear: false) }

    /// `config.clear` while Cloud Sync is on.
    public func clear(_ key: String) -> CallResult { edit(key, value: nil, clear: true) }

    /// Once per install, with the legacy `config.local` contents. Synced and undeclared keys enter at
    /// the HLC floor, so a newer cloud value always wins; `local` keys stay on the device; locked,
    /// refused, invalid and over-size values are not imported. A second call does nothing.
    public func importLocal(_ values: [String: JSONValue]) -> CallResult {
        if s.imported { return .ok }
        s.imported = true
        let before = valueMap()
        for key in syncSortedKeys(values.keys) {
            let value = values[key]!
            let r = route(key)
            if let r, r.route == .locked || r.route == .refused { continue }
            if let r, r.route == .synced, !syncValueValid(value, r.schema) { continue }
            if jsonBytes(value) > SYNC_MAX_VALUE_BYTES { continue }
            if let r, r.route == .local {
                if s.deviceLocal[key] == nil { s.deviceLocal[key] = value }
                continue
            }
            if s.subject == nil {
                if s.partitions[syncLocalPartition]!.device[key] == nil {
                    s.partitions[syncLocalPartition]!.device[key] = SyncDeviceSetting(
                        value: value, editedHlc: SYNC_IMPORT_HLC)
                }
                continue
            }
            enqueueSetting(activeName, key, value, SYNC_IMPORT_HLC, moved: true, preContact: false)
        }
        emitChanges(before, [:], .local)
        kick()
        return .ok
    }

    /// Commit every debounced edit now and push.
    public func flush() -> CallResult {
        commitAllDrafts()
        kick()
        return .ok
    }

    /// A licence or config document fetch succeeded: the only thing that lifts a `/sync` 401 or a
    /// non-`account_required` 403.
    public func refresh() -> CallResult {
        if let b = s.blocked, b == .unauthorized || b == .attestation || b == .forbidden {
            s.blocked = nil
            kick()
        }
        return .ok
    }

    /// The effective mode: E2E when the app requires it or this device has ever accepted E2E.
    public var encryptionMode: SyncEncryption { requiresE2E ? .e2e : .server }

    /// `encryptionSince` of the active partition's last E2E pull, or nil.
    public var encryptionSince: Int? { s.subject == nil ? nil : s.partitions[activeName]?.encryptionSince }

    /// The ring's root arrived (unlock) or went away (lock). Unlocking sends the held operations in
    /// `mutationId` order; locking sends and reads nothing more.
    public func setRoot(_ present: Bool) {
        if root == present { return }
        root = present
        gateChanged()
    }

    /// What discovery says about `services.sync.encryption`. nil forgets it.
    public func setDiscovery(_ discovery: SyncAdvertised?) {
        let before = advertised
        advertised = discovery
        if advertised == .e2e && requiresE2E { s.e2eSeen = true }
        if before != advertised { gateChanged() }
    }

    public func setNetwork(_ state: SyncNetwork) {
        precondition(!(state == .offline && inFlight != nil), "network: a request is in flight; respond first")
        network = state
        if state == .online {
            pullWanted = true
            kick()
        }
    }

    /// Write a record: compare-and-swap for `revision`, a stamped `set` for `lastWrite`, `max` and
    /// `min`, member operations for `merge`.
    public func put(_ collection: String, _ recordId: String, _ value: JSONValue) -> CallResult {
        guard let decl = collectionDecl(collection), decl.policy != "union" else { return .failed("collection-unknown") }
        guard s.subject != nil else { return .failed("signed-out") }
        let name = activeName
        let rk = syncRecordKey(collection, recordId)
        let target = SyncTarget.record(collection, recordId)
        func isRecord(_ o: SyncOp) -> Bool {
            if case .record(let c, let i) = o.target { return syncRecordKey(c, i) == rk }
            return false
        }
        if decl.policy == "revision" {
            if inFlightTouches(rk) {
                s.partitions[name]!.held[rk] = value
            } else if let idx = s.partitions[name]!.pending.firstIndex(where: isRecord) {
                s.partitions[name]!.pending[idx].value = value
            } else {
                let row = s.partitions[name]!.records[rk]
                _ = enqueue(
                    name,
                    SyncOp(
                        mutationId: 0, target: target, op: .set, value: value, baseVersion: row?.version,
                        baseAny: row == nil))
            }
        } else {
            let edited = tickHLC()
            let pre = !s.contacted
            if decl.policy == "merge" {
                let current = record(collection, recordId)?.value
                let cur = current?.objectValue ?? [:]
                let nxt = value.objectValue ?? [:]
                for m in syncSortedKeys(nxt.keys) where cur[m] == nil || !jsonEqual(cur[m], nxt[m]) {
                    _ = enqueue(
                        name,
                        SyncOp(
                            mutationId: 0, target: target, op: .setMember, value: nxt[m], member: m,
                            editedHlc: edited, preContact: pre))
                }
                for m in syncSortedKeys(cur.keys) where nxt[m] == nil {
                    _ = enqueue(
                        name,
                        SyncOp(
                            mutationId: 0, target: target, op: .removeMember, member: m, editedHlc: edited,
                            preContact: pre))
                }
            } else {
                let idx =
                    inFlightTouches(rk)
                    ? nil : s.partitions[name]!.pending.firstIndex(where: { isRecord($0) && $0.op == .set })
                if let idx {
                    s.partitions[name]!.pending[idx].value = value
                    s.partitions[name]!.pending[idx].editedHlc = edited
                } else {
                    _ = enqueue(
                        name,
                        SyncOp(
                            mutationId: 0, target: target, op: .set, value: value, editedHlc: edited,
                            preContact: pre))
                }
            }
        }
        kick()
        return .ok
    }

    /// Add to a `union` record (an OR-set).
    public func add(_ collection: String, _ recordId: String, _ element: JSONValue) -> CallResult {
        unionOp(collection, recordId, element, .add)
    }

    /// Remove from a `union` record, observed at the current cursor.
    public func remove(_ collection: String, _ recordId: String, _ element: JSONValue) -> CallResult {
        unionOp(collection, recordId, element, .remove)
    }

    @discardableResult
    public func signIn(_ subject: String) throws -> CallResult {
        if s.subject == subject { return .ok }
        // Created first, so a bad host client id throws before any state moves.
        _ = try partitionFor(subject)
        if s.subject != nil { leave(.signOut, discard: false) }
        commitAllDrafts()
        let before = valueMap()
        s.blocked = nil
        signingOut = nil
        expirePartitions()
        _ = try partitionFor(subject)
        s.partitions[subject]!.signedOutAt = nil
        let local = s.partitions[syncLocalPartition]!
        let moving = syncSortedKeys(local.device.keys).filter { syncs($0) }
        // A sign-in change re-sends every parked edit (R5), except one a moved local edit replaces.
        for key in moving { dropParkedByLocalEdit(subject, key) }
        unpark(subject) { _ in true }
        for key in moving {
            let d = local.device[key]!
            if d.cleared {
                _ = enqueue(
                    subject,
                    SyncOp(
                        mutationId: 0, target: targetOf(key), op: .clear, editedHlc: d.editedHlc,
                        preContact: d.preContact, moved: true))
            } else {
                enqueueSetting(subject, key, d.value, d.editedHlc, moved: true, preContact: d.preContact)
            }
            s.partitions[syncLocalPartition]!.device.removeValue(forKey: key)
        }
        s.subject = subject
        pullWanted = true
        needSnapshot = false
        emitChanges(before, [:], .remote)
        kick()
        return .ok
    }

    @discardableResult
    public func signOut(discardUnsynced: Bool = false) -> CallResult {
        guard s.subject != nil else { return .ok }
        commitAllDrafts()
        let p = s.partitions[activeName]!
        if !discardUnsynced && network == .online && s.blocked == nil && mayTalk && sendable(p) > 0 {
            signingOut = SigningOut(deadline: now + SYNC_SIGNOUT_FLUSH_MS, discard: discardUnsynced)
            kick()
        } else {
            leave(.signOut, discard: discardUnsynced)
        }
        return .ok
    }

    /// Move the clock, firing debounce commits and the sign-out flush deadline in time order.
    public func advance(_ ms: Int) {
        let target = now + ms
        while true {
            var nxt: Int?
            for d in drafts.values where d.due <= target && (nxt == nil || d.due < nxt!) { nxt = d.due }
            let so = signingOut
            if let so, so.deadline <= target, nxt == nil || so.deadline < nxt! { nxt = so.deadline }
            guard let n = nxt else { break }
            now = n
            if let so, so.deadline == n {
                inFlight = nil
                leave(.signOut, discard: so.discard)
                continue
            }
            for k in syncSortedKeys(drafts.filter { $0.value.due == n }.keys) { commitDraft(k) }
            kick()
        }
        now = target
    }

    // MARK: reads

    public func get(_ key: String) -> SyncEffectiveValue {
        let doc = SyncEffectiveValue(value: document.values[key] ?? .null, from: .document)
        let r = route(key)
        // A lock beats the person's own choice, the `local` slot included.
        if isLocked(key) || (r != nil && (r!.route == .locked || r!.route == .refused)) { return doc }
        if let r, r.route == .local {
            if let v = s.deviceLocal[key] { return SyncEffectiveValue(value: v, from: .device) }
            return doc
        }
        guard let l = layer(key), let v = l.value else { return doc }
        if !syncValueValid(v, schemaOf(key)) { return doc }
        return SyncEffectiveValue(value: v, from: l.from)
    }

    public func settingState(_ key: String) -> SyncSettingState {
        let r = route(key)
        let l = syncs(key) ? layer(key) : nil
        let sync: SyncSettingSync
        if s.subject == nil || r?.route == .local {
            sync = .local
        } else if let l, l.pending {
            sync = .pending
        } else {
            sync = .synced
        }
        var invalid = false
        if let l, let v = l.value, !syncValueValid(v, schemaOf(key)) { invalid = true }
        if syncs(key) && snapshotUnreadable(alias(key)) && !(l?.pending ?? false) { invalid = true }
        return SyncSettingState(sync: sync, invalid: invalid, locked: isLocked(key) || r?.route == .locked)
    }

    public func record(_ collection: String, _ recordId: String) -> SyncEffectiveValue? {
        guard s.subject != nil else { return nil }
        let p = s.partitions[activeName]!
        let rk = syncRecordKey(collection, recordId)
        var value: JSONValue? = nil
        if let row = p.records[rk], !rowUnreadable(row) { value = row.value }
        var pending = false
        for op in p.pending {
            if case .record(let c, let i) = op.target, syncRecordKey(c, i) == rk {
                value = syncApplyRecordOp(value, op)
                pending = true
            }
        }
        if let h = p.held[rk] {
            value = h
            pending = true
        }
        guard let v = value else { return nil }
        return SyncEffectiveValue(value: v, from: pending ? .pending : .cloud)
    }

    public func status() -> SyncStatus {
        let pending = pendingCount
        if pinnedOut {
            return SyncStatus(state: .unsupported, pending: pending, reason: .encryption, code: "sync-encryption-pinned")
        }
        if let b = s.blocked { return SyncStatus(state: .blocked, pending: pending, reason: b) }
        if s.subject == nil { return SyncStatus(state: .local, pending: pending) }
        if lockedOut { return SyncStatus(state: .locked, pending: pending, reason: .keyring) }
        let parked = parkedReason
        func at(_ state: SyncState) -> SyncStatus { SyncStatus(state: state, pending: pending, reason: parked) }
        if network == .offline { return at(.offline) }
        if inFlight != nil { return at(.syncing) }
        if paused { return at(.paused) }
        return at(pending > 0 ? .pending : .idle)
    }

    /// The journal, normalised: what every SDK's journal must hold, whatever its encoding.
    public func journal() -> JSONValue {
        var out: [String: JSONValue] = [:]
        for (name, p) in s.partitions {
            if name == syncLocalPartition {
                if !p.device.isEmpty { out[name] = .object(["settings": .object(p.device.mapValues(\.json))]) }
                continue
            }
            var view: [String: JSONValue] = [
                "clientId": p.clientId.map { .string($0) } ?? .null,
                "nextMutationId": .int(p.nextMutationId), "cursor": .int(p.cursor),
                "pending": .array(p.pending.map(\.journalJSON)),
            ]
            if !p.held.isEmpty { view["held"] = .object(p.held) }
            out[name] = .object(view)
        }
        return .object(out)
    }

    // MARK: internals: gate

    /// The app requires E2E, or this device has accepted it before: the pin cannot be undone.
    var requiresE2E: Bool { appEncryption == .e2e || s.e2eSeen }

    /// The Worker's answer contradicts the mode: nothing is sent to it and nothing it says is read.
    var pinnedOut: Bool {
        guard let a = advertised else { return false }
        return requiresE2E ? a != .e2e : a == .e2e
    }

    /// E2E with no root for the ring.
    var lockedOut: Bool { requiresE2E && !root }

    var mayTalk: Bool { !pinnedOut && !lockedOut }

    func rowUnreadable(_ row: SyncRow) -> Bool {
        if row.bad || lockedOut { return true }
        guard let plain = row.plain, requiresE2E else { return false }
        let since = s.subject == nil ? nil : s.partitions[activeName]?.encryptionSince
        guard let since else { return true }
        return !(plain < since)
    }

    func snapshotUnreadable(_ serverKey: String) -> Bool {
        guard s.subject != nil, let row = s.partitions[activeName]?.settings[serverKey] else { return false }
        return rowUnreadable(row)
    }

    /// A lock, an unlock or a discovery answer changed what may be sent.
    func gateChanged() {
        if let so = signingOut, s.subject != nil, !mayTalk {
            leave(.signOut, discard: so.discard)
            return
        }
        kick()
    }

    // MARK: internals: routes

    func route(_ key: String) -> SettingRoute? {
        if let f = catalog.settings.first(where: { $0.key == key }) { return f }
        let a = alias(key)
        return catalog.settings.first { $0.key == a }
    }

    func syncs(_ key: String) -> Bool { route(key).map { $0.route == .synced } ?? true }

    func policyOf(_ key: String) -> String {
        if let r = route(key), r.route == .synced { return (r.policy ?? .lastWrite).rawValue }
        return "lastWrite"
    }

    func schemaOf(_ key: String) -> JSONValue? {
        if let r = route(key), r.route == .synced { return r.schema }
        return nil
    }

    func targetOf(_ key: String) -> SyncTarget {
        if let r = route(key), r.route == .synced { return .setting(key, r.scope ?? .user) }
        return .setting(key, .user)
    }

    func collectionDecl(_ name: String) -> SyncCollectionDecl? { catalog.collections.first { $0.name == name } }
    func alias(_ key: String) -> String { s.aliases[key] ?? key }
    func isLocked(_ key: String) -> Bool { document.locked.contains(key) }

    var activeName: String { s.subject ?? syncLocalPartition }

    func partitionFor(_ name: String) throws -> SyncPartition {
        if let p = s.partitions[name] { return p }
        let p = SyncPartition(clientId: name == syncLocalPartition ? nil : try freshClientId())
        s.partitions[name] = p
        return p
    }

    func freshClientId() throws -> String {
        let cid = newClientId()
        guard cid.range(of: SYNC_CLIENT_ID_PATTERN, options: .regularExpression) != nil else {
            throw SyncMachineError.badClientId
        }
        return cid
    }

    var pendingCount: Int {
        guard s.subject != nil, let p = s.partitions[activeName] else { return drafts.count }
        return drafts.count + p.pending.count + p.held.count
    }

    /// What a push can still carry: every journalled operation that is not parked, plus held.
    func sendable(_ p: SyncPartition) -> Int { p.pending.filter { $0.parked == nil }.count + p.held.count }

    var parkedReason: SyncBlockReason? {
        guard s.subject != nil, let p = s.partitions[activeName] else { return nil }
        if p.pending.contains(where: { $0.parked == .quota }) { return .quota }
        if p.pending.contains(where: { $0.parked == .entitlement }) { return .entitlement }
        return nil
    }

    func tickHLC() -> String {
        let physical = now + s.offsetMs
        if physical > s.hlc.physical { s.hlc = (physical, 0) } else { s.hlc = (s.hlc.physical, s.hlc.counter + 1) }
        return syncFormatHLC(physical: s.hlc.physical, counter: s.hlc.counter)
    }

    // MARK: internals: the view

    func layer(_ key: String) -> Layer? {
        guard syncs(key) else { return nil }
        let policy = policyOf(key)
        let target = alias(key)
        func matches(_ k: String) -> Bool { alias(k) == target }
        var value: JSONValue?
        var has = false
        var pending = false
        let p = s.partitions[activeName]!
        if s.subject != nil {
            if let snap = p.settings[target], !rowUnreadable(snap) {
                value = snap.value
                has = true
            }
            for op in p.pending {
                if case .setting(let k, _) = op.target, matches(k) {
                    value = syncApplySettingOp(policy, value, op)
                    pending = true
                }
            }
        } else {
            for k in syncSortedKeys(p.device.keys) where matches(k) {
                let d = p.device[k]!
                value = d.cleared ? nil : d.value
                has = true
            }
        }
        for k in syncSortedKeys(drafts.keys) where matches(k) {
            let d = drafts[k]!
            if d.clear {
                value = nil
            } else if policy == "merge" {
                value = d.value
            } else {
                value = syncApplySettingOp(
                    policy, value, SyncOp(mutationId: 0, target: .setting(k, .user), op: .set, value: d.value))
            }
            pending = true
        }
        if !has && !pending { return nil }
        let origin: SyncValueFrom = pending ? .pending : (s.subject != nil ? .cloud : .device)
        return Layer(value: value, from: origin, pending: pending)
    }

    func openKeys() -> [String] {
        var keys: [String] = []
        func add(_ k: String) { if route(k) == nil && !keys.contains(k) { keys.append(k) } }
        if s.subject != nil {
            let p = s.partitions[activeName]!
            for k in syncSortedKeys(p.settings.keys) { add(k) }
            for op in p.pending { if case .setting(let k, _) = op.target { add(k) } }
        } else {
            for k in syncSortedKeys(s.partitions[syncLocalPartition]!.device.keys) { add(k) }
        }
        for k in syncSortedKeys(drafts.keys) { add(k) }
        return keys
    }

    func valueMap() -> [String: JSONValue] {
        var m: [String: JSONValue] = [:]
        for r in catalog.settings where r.route == .synced || r.route == .local { m[r.key] = get(r.key).value }
        for k in openKeys() { m[k] = get(k).value }
        return m
    }

    func emitChanges(_ before: [String: JSONValue], _ overrides: [String: SyncChangeOrigin], _ origin: SyncChangeOrigin) {
        let after = valueMap()
        var groups: [SyncChangeOrigin: [String]] = [:]
        for k in Set(before.keys).union(after.keys) {
            // A key known on one side only read as the document's value on the other.
            let was = before[k] ?? document.values[k]
            let isNow = after[k] ?? get(k).value
            if jsonEqual(was, isNow) { continue }
            groups[overrides[k] ?? origin, default: []].append(k)
        }
        for o in [SyncChangeOrigin.local, .remote, .merge, .migration] {
            if let keys = groups[o], !keys.isEmpty { events.append(.change(keys: syncSortedKeys(keys), origin: o)) }
        }
    }

    // MARK: internals: edits

    /// `set` and `clear`, journalling nothing on a refusal: a declared `secret` or `flag` is
    /// `bad_request`; a catalog lock or a lock in the current document is `managed_by_admin`; a value
    /// that fails the key's schema, or is over `SYNC_MAX_VALUE_BYTES`, is `bad_request`. A `local` key
    /// is written to `deviceLocal`; anything else is drafted, an undeclared key as an open setting.
    func edit(_ key: String, value: JSONValue?, clear: Bool) -> CallResult {
        let r = route(key)
        if r?.route == .refused { return .failed("bad_request") }
        if r?.route == .locked || isLocked(key) { return .failed("managed_by_admin") }
        if !clear {
            let v = value ?? .null
            if let r, r.route == .synced, !syncValueValid(v, r.schema) { return .failed("bad_request") }
            if jsonBytes(v) > SYNC_MAX_VALUE_BYTES { return .failed("bad_request") }
        }
        let before = valueMap()
        if r?.route == .local {
            if clear { s.deviceLocal.removeValue(forKey: key) } else { s.deviceLocal[key] = value ?? .null }
            emitChanges(before, [:], .local)
            return .ok
        }
        drafts[key] = Draft(
            value: clear ? nil : (value ?? .null), clear: clear, editedHlc: tickHLC(), preContact: !s.contacted,
            due: now + SYNC_DEBOUNCE_MS)
        emitChanges(before, [:], .local)
        return .ok
    }

    func commitAllDrafts() { for k in syncSortedKeys(drafts.keys) { commitDraft(k) } }

    func commitDraft(_ key: String) {
        guard let d = drafts[key] else { return }
        let policy = policyOf(key)
        if s.subject == nil {
            // The local partition keeps one value per key, its policy already applied.
            let prior = s.partitions[syncLocalPartition]!.device[key]
            drafts.removeValue(forKey: key)
            if d.clear {
                s.partitions[syncLocalPartition]!.device[key] = SyncDeviceSetting(
                    cleared: true, editedHlc: d.editedHlc, preContact: d.preContact)
            } else {
                let base = (prior != nil && !prior!.cleared) ? prior!.value : nil
                let value =
                    policy == "merge"
                    ? d.value
                    : syncApplySettingOp(
                        policy, base, SyncOp(mutationId: 0, target: .setting(key, .user), op: .set, value: d.value))
                s.partitions[syncLocalPartition]!.device[key] = SyncDeviceSetting(
                    value: value, editedHlc: d.editedHlc, preContact: d.preContact)
            }
            return
        }
        let name = activeName
        drafts.removeValue(forKey: key)
        dropParkedByLocalEdit(name, key)
        if d.clear {
            _ = enqueue(
                name,
                SyncOp(mutationId: 0, target: targetOf(key), op: .clear, editedHlc: d.editedHlc, preContact: d.preContact))
            return
        }
        enqueueSetting(name, key, d.value, d.editedHlc, moved: false, preContact: d.preContact)
    }

    /// Journal a whole value for `key`: one `set`, or, for a `merge` key, one member operation per
    /// member that differs from the current view (the view without this edit).
    func enqueueSetting(
        _ name: String, _ key: String, _ value: JSONValue?, _ editedHlc: String, moved: Bool, preContact: Bool
    ) {
        let target = targetOf(key)
        guard policyOf(key) == "merge", let obj = value?.objectValue else {
            _ = enqueue(
                name,
                SyncOp(
                    mutationId: 0, target: target, op: .set, value: value ?? .null, editedHlc: editedHlc,
                    preContact: preContact, moved: moved))
            return
        }
        let current = s.subject == nil ? nil : layer(key)?.value
        let cur = current?.objectValue ?? [:]
        for m in syncSortedKeys(obj.keys) where cur[m] == nil || !jsonEqual(cur[m], obj[m]) {
            _ = enqueue(
                name,
                SyncOp(
                    mutationId: 0, target: target, op: .setMember, value: obj[m], member: m, editedHlc: editedHlc,
                    preContact: preContact, moved: moved))
        }
        for m in syncSortedKeys(cur.keys) where obj[m] == nil {
            _ = enqueue(
                name,
                SyncOp(
                    mutationId: 0, target: target, op: .removeMember, member: m, editedHlc: editedHlc,
                    preContact: preContact, moved: moved))
        }
    }

    func enqueue(_ name: String, _ op: SyncOp) -> SyncOp {
        var full = op
        full.mutationId = s.partitions[name]!.nextMutationId
        s.partitions[name]!.nextMutationId += 1
        s.partitions[name]!.pending.append(full)
        return full
    }

    /// A newer local edit of a `lastWrite` or `merge` key replaces its parked edits (R5). A `max` or
    /// `min` key keeps them: the server decides by value, so the older edit may still win.
    func dropParkedByLocalEdit(_ name: String, _ key: String) {
        guard policyOf(key) == "lastWrite" || policyOf(key) == "merge" else { return }
        let target = alias(key)
        s.partitions[name]!.pending.removeAll { o in
            if o.parked != nil, case .setting(let k, _) = o.target { return alias(k) == target }
            return false
        }
    }

    /// Re-send parked edits as NEW mutations with their original clock (a processed mutationId is
    /// never resent).
    func unpark(_ name: String, _ which: (SyncParkReason) -> Bool) {
        let parked = s.partitions[name]!.pending.filter { $0.parked.map(which) ?? false }
        if parked.isEmpty { return }
        let ids = Set(parked.map(\.mutationId))
        s.partitions[name]!.pending.removeAll { ids.contains($0.mutationId) }
        for var o in parked {
            o.parked = nil
            _ = enqueue(name, o)
        }
    }

    func unionOp(_ collection: String, _ recordId: String, _ element: JSONValue, _ op: SyncOpName) -> CallResult {
        guard let decl = collectionDecl(collection), decl.policy == "union" else { return .failed("collection-unknown") }
        guard s.subject != nil else { return .failed("signed-out") }
        let name = activeName
        _ = enqueue(
            name,
            SyncOp(
                mutationId: 0, target: .record(collection, recordId), op: op, element: element,
                observedSeq: op == .remove ? s.partitions[name]!.cursor : nil))
        kick()
        return .ok
    }

    func inFlightTouches(_ rk: String) -> Bool {
        guard let f = inFlight, f.kind == .push, let p = s.partitions[f.partition] else { return false }
        return p.pending.contains { o in
            if f.mutationIds.contains(o.mutationId), case .record(let c, let i) = o.target {
                return syncRecordKey(c, i) == rk
            }
            return false
        }
    }

    // MARK: internals: requests

    /// Send the next request, if one is due and allowed.
    func kick() {
        if inFlight != nil || s.subject == nil || s.blocked != nil { return }
        if network != .online { return }
        // Pinned out or locked: nothing is sent, pulled or read, and the journal waits.
        if !mayTalk { return }
        let name = activeName
        let p = s.partitions[name]!
        func pullPath(_ cursor: Int) -> String {
            "/\(product)/sync?cursor=\(cursor)&clientId=\(p.clientId ?? "")"
        }
        // E2E: a push waits for the Worker to be confirmed `e2e` this session, by discovery or by a
        // pull. A pull carries nothing of ours.
        let unconfirmed = requiresE2E && advertised != .e2e
        if !s.contacted || needSnapshot || unconfirmed {
            let cursor = needSnapshot ? 0 : p.cursor
            inFlight = InFlight(kind: .pull, partition: name, cursor: cursor, mutationIds: [])
            outbox.append(SyncRequest(method: .get, path: pullPath(cursor)))
            return
        }
        let batch = Array(p.pending.filter { $0.parked == nil }.prefix(SYNC_MAX_MUTATIONS))
        if !batch.isEmpty {
            inFlight = InFlight(kind: .push, partition: name, cursor: p.cursor, mutationIds: batch.map(\.mutationId))
            outbox.append(
                SyncRequest(
                    method: .post, path: "/\(product)/sync/ops",
                    body: .object([
                        "clientId": .string(p.clientId ?? ""), "cursor": .int(p.cursor), "atomic": .bool(false),
                        "mutations": .array(batch.map { sendForm(p, $0) }),
                    ])))
            return
        }
        if let so = signingOut {
            leave(.signOut, discard: so.discard)
            return
        }
        if pullWanted {
            inFlight = InFlight(kind: .pull, partition: name, cursor: p.cursor, mutationIds: [])
            outbox.append(SyncRequest(method: .get, path: pullPath(p.cursor)))
        }
    }

    /// The wire form of a pending operation. In E2E mode a `max`/`min` setting is a compare-and-swap
    /// register on the server, so its `set` names the version it was made against.
    func sendForm(_ p: SyncPartition, _ op: SyncOp) -> JSONValue {
        guard requiresE2E, op.op == .set, op.baseVersion == nil, !op.baseAny, case .setting(let k, _) = op.target,
            ["max", "min"].contains(policyOf(k)), case .object(var w) = op.wire
        else { return op.wire }
        if let row = p.settings[alias(k)] { w["baseVersion"] = .int(row.version) } else { w["baseVersion"] = .string("*") }
        return .object(w)
    }

    // MARK: internals: leaving

    /// Sign-out, and every principal change handled like it.
    func leave(_ reason: SyncSignedOutReason, discard: Bool) {
        guard let name = s.subject else { return }
        commitAllDrafts()
        let before = valueMap()
        let unsynced = s.partitions[name]!.pending.count + s.partitions[name]!.held.count
        if discard {
            s.partitions[name]!.pending = []
            s.partitions[name]!.held = [:]
        }
        if onSignOut == .clear || reason != .signOut {
            s.partitions[name]!.settings = [:]
            s.partitions[name]!.records = [:]
            s.partitions[name]!.cursor = 0
        }
        s.partitions[name]!.signedOutAt = now
        s.subject = nil
        signingOut = nil
        inFlight = nil
        needSnapshot = false
        pullWanted = false
        events.append(.signedOut(reason: reason, unsynced: unsynced))
        if unsynced > 0 && !discard { events.append(.unsyncedData(count: unsynced)) }
        emitChanges(before, [:], .remote)
    }

    func expirePartitions() {
        for (name, p) in s.partitions {
            if name == syncLocalPartition || name == s.subject { continue }
            if let at = p.signedOutAt, now - at >= SYNC_PENDING_DAYS * dayMs { s.partitions.removeValue(forKey: name) }
        }
    }

    /// Relaunch: persist, then restore with the same host options (`journalLost` drops the journal;
    /// the device binding, `subject`, is device state and survives, and so does the `config.local`
    /// store behind `deviceLocal`).
    public static func relaunch(_ m: CloudSyncMachine, _ opts: SyncMachineOptions, journalLost: Bool = false)
        throws -> CloudSyncMachine
    {
        let saved = m.persist()
        var o = opts
        o.now = m.now
        o.network = m.network
        if journalLost {
            o.offsetMs = 0
            o.contacted = false
            o.subject = saved.subject
            o.deviceLocal = saved.deviceLocal
            o.imported = saved.imported
            return try CloudSyncMachine(o)
        }
        return try CloudSyncMachine(o, persisted: saved)
    }
}
