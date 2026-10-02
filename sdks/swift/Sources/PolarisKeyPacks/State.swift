// The pack install-state machine (CONTENT §9 "Install state", §10; plans/P4-01.md §2.13;
// client-core `packs/state.ts`, whose fields and transitions this follows exactly).
//
// One document per product, written by atomic replace:
//
//   active            pack id → the install the next boot (and, for `hot` packs, this process)
//                     uses
//   previous          pack id → the install `active` replaced, kept for `rollback`
//   inflight          pack id → the journal of an install in progress, for resume
//   observed          what a platform transport reported (P5-08); carried, never interpreted
//   confirmedBootSeq  the last boot `confirm` marked healthy; `bootSeq` counts loads
//
// The document is NEVER trusted from storage. Each install and journal carries its pack record's
// compact JWS verbatim, and `reloadPackState` re-verifies every one through the caller's verifier
// before anything uses it; the host then re-checks the stored payload itself. What fails is
// dropped, never repaired. Pure functions: each returns a new document.

import Foundation
import PolarisKeyCore

public let PACK_STATE_VERSION = 1

/// One installed pack release.
public struct PackInstall: Sendable, Equatable, Hashable {
    public var packId: String
    /// The pack record's compact JWS, verbatim: re-verified on every load.
    public var record: String
    public var recordSha256: String
    public var version: String
    public var seq: Int
    public var type: String
    /// The selected variant's key (`variantKey`).
    public var variant: String
    public var layout: String
    public var payloadSha256: String
    public var payloadSize: Int
    /// `hot` (live at commit) or `restart` (live from the next boot).
    public var activation: String
    /// Where the host keeps the payload (a store directory, an embedded path).
    public var location: String
    /// True for an embedded baseline the host registered.
    public var embedded: Bool?
    /// Epoch seconds of the commit.
    public var installedAt: Int

    public init(
        packId: String, record: String, recordSha256: String, version: String, seq: Int,
        type: String, variant: String, layout: String, payloadSha256: String, payloadSize: Int,
        activation: String, location: String, embedded: Bool? = nil, installedAt: Int
    ) {
        self.packId = packId
        self.record = record
        self.recordSha256 = recordSha256
        self.version = version
        self.seq = seq
        self.type = type
        self.variant = variant
        self.layout = layout
        self.payloadSha256 = payloadSha256
        self.payloadSize = payloadSize
        self.activation = activation
        self.location = location
        self.embedded = embedded
        self.installedAt = installedAt
    }

    public var json: JSONValue {
        var o: [String: JSONValue] = [
            "packId": .string(packId), "record": .string(record),
            "recordSha256": .string(recordSha256), "version": .string(version), "seq": .int(seq),
            "type": .string(type), "variant": .string(variant), "layout": .string(layout),
            "payloadSha256": .string(payloadSha256), "payloadSize": .int(payloadSize),
            "activation": .string(activation), "location": .string(location),
            "installedAt": .int(installedAt),
        ]
        if let embedded { o["embedded"] = .bool(embedded) }
        return .object(o)
    }
}

/// One object of an in-flight plan: its stored ref and how many bytes are staged.
public struct JournalObject: Sendable, Equatable {
    public var sha256: String
    public var bytes: Int
    public var done: Int

    public init(sha256: String, bytes: Int, done: Int) {
        self.sha256 = sha256
        self.bytes = bytes
        self.done = done
    }
}

/// The journal of an install in progress (CONTENT §10 step 2).
public struct PackJournal: Sendable, Equatable {
    public var planId: String
    public var packId: String
    public var record: String
    public var recordSha256: String
    public var variant: String
    public var strategy: String
    public var delta: String?
    public var objects: [JournalObject]
    public var startedAt: Int

    public init(
        planId: String, packId: String, record: String, recordSha256: String, variant: String,
        strategy: String, delta: String? = nil, objects: [JournalObject], startedAt: Int
    ) {
        self.planId = planId
        self.packId = packId
        self.record = record
        self.recordSha256 = recordSha256
        self.variant = variant
        self.strategy = strategy
        self.delta = delta
        self.objects = objects
        self.startedAt = startedAt
    }

    public var json: JSONValue {
        var o: [String: JSONValue] = [
            "planId": .string(planId), "packId": .string(packId), "record": .string(record),
            "recordSha256": .string(recordSha256), "variant": .string(variant),
            "strategy": .string(strategy),
            "objects": .array(
                objects.map {
                    .object(["sha256": .string($0.sha256), "bytes": .int($0.bytes), "done": .int($0.done)])
                }),
            "startedAt": .int(startedAt),
        ]
        if let delta { o["delta"] = .string(delta) }
        return .object(o)
    }
}

/// The install state document.
public struct PackStateDoc: Sendable, Equatable {
    public var v = PACK_STATE_VERSION
    public var active: [String: PackInstall] = [:]
    public var previous: [String: PackInstall] = [:]
    public var inflight: [String: PackJournal] = [:]
    public var observed: [String: JSONValue] = [:]
    public var confirmedBootSeq = 0
    public var bootSeq = 0
    /// Set by the engine, in the same atomic write sequence, when it first stores a revocation in
    /// the sibling `revocations.json` (plans/P4-13.md §2.5): written before the sibling file, never
    /// cleared. False (and absent from the document) for a product that has never had a
    /// revocation. With an unreadable `revocations.json`, it is what makes the engine refuse the
    /// stamp's embedded baselines.
    public var revocationsStored = false

    public init() {}

    public var json: JSONValue {
        var o: [String: JSONValue] = [
            "v": .int(v), "active": .object(active.mapValues(\.json)),
            "previous": .object(previous.mapValues(\.json)),
            "inflight": .object(inflight.mapValues(\.json)), "observed": .object(observed),
            "confirmedBootSeq": .int(confirmedBootSeq), "bootSeq": .int(bootSeq),
        ]
        if revocationsStored { o["revocationsStored"] = .bool(true) }
        return .object(o)
    }
}

/// Where the document lives: read it whole, replace it atomically.
///
/// `read` answers nil ONLY when there is no document (not found) and throws for anything else: an
/// unreadable document is never the empty state. The quarantine members are REQUIRED: they keep a
/// torn document (one that exists but does not parse) aside, as `state.json.torn`, before the
/// first write replaces it; while one is held the engine collects no garbage, so payloads the
/// lost document named survive until an operator calls `recoverState()`.
public protocol PackStateStore: Sendable {
    func read() throws -> String?
    func replace(_ text: String) throws
    /// Keep the torn text aside (never overwriting an earlier one).
    func quarantine(_ text: String) throws
    /// Whether a quarantined document is held.
    func quarantined() throws -> Bool
    /// Drop the quarantined document and its hold list (operator recovery).
    func clearQuarantine() throws
    /// Whether this store keeps the torn hold's snapshot (`readHoldList`/`writeHoldList`).
    /// Without it the snapshot is retaken at every load.
    var keepsHoldList: Bool { get }
    /// The hold's saved snapshot (`state.json.torn.list`): nil when none was saved; throws when
    /// it cannot be read.
    func readHoldList() throws -> String?
    /// Save the hold's snapshot, atomically, the first time a hold starts.
    func writeHoldList(_ text: String) throws
}

extension PackStateStore {
    public var keepsHoldList: Bool { false }
    public func readHoldList() throws -> String? { nil }
    public func writeHoldList(_ text: String) throws {}
}

public func emptyPackState() -> PackStateDoc { PackStateDoc() }

private func nat(_ v: JSONValue?) -> Int? {
    guard case .int(let i)? = v, i >= 0, i <= MAX_WIRE_INTEGER else { return nil }
    return i
}

private func asInstall(_ v: JSONValue, _ packId: String) -> PackInstall? {
    guard let o = v.objectValue, o["packId"]?.stringValue == packId, isPackId(packId) else {
        return nil
    }
    var s: [String: String] = [:]
    for k in ["record", "version", "type", "variant", "layout", "location"] {
        guard let x = o[k]?.stringValue else { return nil }
        s[k] = x
    }
    guard let rs = o["recordSha256"]?.stringValue, isSha256Hex(rs),
        let ps = o["payloadSha256"]?.stringValue, isSha256Hex(ps),
        let seq = nat(o["seq"]), let size = nat(o["payloadSize"]), let at = nat(o["installedAt"])
    else { return nil }
    var embedded: Bool?
    if let e = o["embedded"] {
        guard let b = e.boolValue else { return nil }
        embedded = b
    }
    guard let activation = o["activation"]?.stringValue, activation == "hot" || activation == "restart"
    else { return nil }
    return PackInstall(
        packId: packId, record: s["record"]!, recordSha256: rs, version: s["version"]!, seq: seq,
        type: s["type"]!, variant: s["variant"]!, layout: s["layout"]!, payloadSha256: ps,
        payloadSize: size, activation: activation, location: s["location"]!, embedded: embedded,
        installedAt: at)
}

private func asJournal(_ v: JSONValue, _ packId: String) -> PackJournal? {
    guard let o = v.objectValue, o["packId"]?.stringValue == packId, isPackId(packId) else {
        return nil
    }
    guard let planId = o["planId"]?.stringValue, let record = o["record"]?.stringValue,
        let variant = o["variant"]?.stringValue, let strategy = o["strategy"]?.stringValue,
        let rs = o["recordSha256"]?.stringValue, isSha256Hex(rs)
    else { return nil }
    var delta: String?
    if let d = o["delta"] {
        guard let s = d.stringValue else { return nil }
        delta = s
    }
    guard wholeMatches("[A-Za-z0-9_-]{1,64}", planId) != nil else { return nil }
    guard let started = nat(o["startedAt"]), let list = o["objects"]?.arrayValue else { return nil }
    var objects: [JournalObject] = []
    for x in list {
        guard let xo = x.objectValue, let sha = xo["sha256"]?.stringValue, isSha256Hex(sha),
            let bytes = nat(xo["bytes"]), let done = nat(xo["done"]), done <= bytes
        else { return nil }
        objects.append(JournalObject(sha256: sha, bytes: bytes, done: done))
    }
    return PackJournal(
        planId: planId, packId: packId, record: record, recordSha256: rs, variant: variant,
        strategy: strategy, delta: delta, objects: objects, startedAt: started)
}

/// Whether stored text is at least a version-1 state document's shape.
func looksLikeState(_ text: String) -> Bool {
    guard let v = parseJSON(text), let o = v.objectValue else { return false }
    return o["v"] == .int(PACK_STATE_VERSION)
}

/// Parse the stored document's shape. Anything malformed is dropped entry by entry (a document
/// that does not parse at all is the empty state). Shape only: `reloadPackState` decides what is
/// trusted.
public func parsePackState(_ text: String?) -> PackStateDoc {
    var out = emptyPackState()
    guard let text, let doc = parseJSON(text)?.objectValue, doc["v"] == .int(PACK_STATE_VERSION)
    else { return out }
    for (id, v) in doc["active"]?.objectValue ?? [:] {
        if let i = asInstall(v, id) { out.active[id] = i }
    }
    for (id, v) in doc["previous"]?.objectValue ?? [:] {
        if let i = asInstall(v, id) { out.previous[id] = i }
    }
    for (id, v) in doc["inflight"]?.objectValue ?? [:] {
        if let j = asJournal(v, id) { out.inflight[id] = j }
    }
    if let observed = doc["observed"]?.objectValue { out.observed = observed }
    if let c = nat(doc["confirmedBootSeq"]) { out.confirmedBootSeq = c }
    if let b = nat(doc["bootSeq"]) { out.bootSeq = b }
    if out.confirmedBootSeq > out.bootSeq { out.confirmedBootSeq = out.bootSeq }
    if doc["revocationsStored"] == .bool(true) { out.revocationsStored = true }
    return out
}

public func serializePackState(_ state: PackStateDoc) -> String { canonicalJSON(state.json) }

/// What `reloadPackState` asks of the host for each entry. Throwing counts as false.
public struct PackStateVerifier: Sendable {
    public var install: @Sendable (PackInstall) async throws -> Bool
    public var journal: @Sendable (PackJournal) async throws -> Bool

    public init(
        install: @escaping @Sendable (PackInstall) async throws -> Bool,
        journal: @escaping @Sendable (PackJournal) async throws -> Bool
    ) {
        self.install = install
        self.journal = journal
    }
}

/// The reload path: every install and journal goes through the verifier, and only what passes
/// survives. `bootSeq` counts this load. A `previous` equal to its `active` is dropped.
public func reloadPackState(_ state: PackStateDoc, _ verify: PackStateVerifier) async -> PackStateDoc {
    var out = emptyPackState()
    out.observed = state.observed
    out.confirmedBootSeq = state.confirmedBootSeq
    out.bootSeq = state.bootSeq + 1
    out.revocationsStored = state.revocationsStored
    for id in state.active.keys.sorted() {
        let i = state.active[id]!
        if (try? await verify.install(i)) == true { out.active[id] = i }
    }
    for id in state.previous.keys.sorted() {
        let i = state.previous[id]!
        if out.active[id]?.recordSha256 == i.recordSha256 { continue }
        if (try? await verify.install(i)) == true { out.previous[id] = i }
    }
    for id in state.inflight.keys.sorted() {
        let j = state.inflight[id]!
        if (try? await verify.journal(j)) == true { out.inflight[id] = j }
    }
    return out
}

/// Start (or restart) a plan: its journal becomes the pack's `inflight`.
public func beginInstall(_ state: PackStateDoc, _ journal: PackJournal) -> PackStateDoc {
    var s = state
    s.inflight[journal.packId] = journal
    return s
}

/// Record how many bytes of one staged object are done.
public func checkpoint(_ state: PackStateDoc, packId: String, sha256: String, done: Int) -> PackStateDoc {
    guard var j = state.inflight[packId] else { return state }
    j.objects = j.objects.map {
        var o = $0
        if o.sha256 == sha256 { o.done = Swift.min(done, o.bytes) }
        return o
    }
    var s = state
    s.inflight[packId] = j
    return s
}

/// Abandon a plan (its staging becomes garbage).
public func abandonInstall(_ state: PackStateDoc, packId: String) -> PackStateDoc {
    var s = state
    s.inflight[packId] = nil
    return s
}

/// Commit a verified install: the pointer swap. `active` becomes the new install, the install it
/// replaces becomes `previous` (unless it is the same release), and the journal is closed.
public func commitInstall(_ state: PackStateDoc, _ install: PackInstall) -> PackStateDoc {
    var s = state
    if let old = s.active[install.packId], old.recordSha256 != install.recordSha256 {
        s.previous[install.packId] = old
    }
    s.inflight[install.packId] = nil
    s.active[install.packId] = install
    return s
}

/// Roll a pack back to `previous`. Unchanged (and false) when there is none.
public func rollbackInstall(_ state: PackStateDoc, packId: String) -> (state: PackStateDoc, rolledBack: Bool) {
    guard let prev = state.previous[packId] else { return (state, false) }
    var s = state
    s.previous[packId] = nil
    s.active[packId] = prev
    return (s, true)
}

/// Mark this boot healthy (CONTENT §10 step 7).
public func confirmBoot(_ state: PackStateDoc) -> PackStateDoc {
    var s = state
    s.confirmedBootSeq = s.bootSeq
    return s
}

/// What garbage collection must keep.
public struct PackGcRoots: Sendable, Equatable {
    /// Locations of active, previous and embedded installs.
    public var locations: Set<String>
    /// Plan ids of in-flight installs (their staging).
    public var plans: Set<String>
}

/// `roots()` (CONTENT §4.1): the locations of every active and previous install and of every
/// embedded baseline the host registered, and the plan ids of every in-flight journal.
public func gcRoots(_ state: PackStateDoc, embedded: [PackInstall] = []) -> PackGcRoots {
    var locations = Set<String>()
    for i in state.active.values { locations.insert(i.location) }
    for i in state.previous.values { locations.insert(i.location) }
    for e in embedded { locations.insert(e.location) }
    return PackGcRoots(locations: locations, plans: Set(state.inflight.values.map(\.planId)))
}
