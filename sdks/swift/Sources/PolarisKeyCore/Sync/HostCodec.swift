// The host codec boundary of Cloud Sync's end-to-end mode (WIRE-CONTRACT-V5 §13.10, §13.10.7;
// U-07.5). A port of Python's `cloud_sync/host_codec.py` and client-core's `sync/hostCodec.ts`, with
// every SEC-SYNC-HOST fix. The machine speaks plaintext; this is the one place a host turns the
// machine's requests into sealed ones (`sealPush`) and the Worker's answers into plaintext plus the
// typed open result the machine trusts (`openPull`).
//
//  - HC-1: a result list that repeats a `mutationId` is refused, and a conflict's server copy opens
//    only for a mutation of the request.
//  - HC-2: the open result comes only from this module's own open. `sealed`, `invalid`, `seq` and
//    `ct` members of a served body are removed, never read; `seq` is the change's `version`, set on
//    plaintext rows only.
//  - HC-3: served `aliases` are replaced by the app's; `renamedTo` is kept only for an app alias.
//  - HC-4: a name holding U+0000 is refused on push and pull; a merge member's envelope name is the
//    setting, U+0000, the member.
//  - HC-5: a blinded name is accepted only when the `k` inside its envelope re-blinds to it; an
//    envelope that does not open is `invalid` and its row falls through to the document.
//  - HC-6: a locked codec refuses with `sync-locked` before anything is sealed, so nothing is sent;
//    a seal failure throws, so nothing is sent.
//
// Scope: settings (the `$settings` collection), and records with a scalar value (D-2: saves are
// `revision` records; U-23.S3). A record value is sealed under its collection with `k = id`, its id
// travels as `blind("record", collection, id)`, and a pulled record opens only when the `k` inside
// the envelope re-blinds to the id on the wire (§13.10.4), so a Worker cannot place a sealed value
// under another record. A record mutation other than `set` and `delete` (a `merge` field, a `union`
// element) and a sealed `merge` or `union` change (`fields`, `elements`) are outside this codec: a
// mutation is refused with `invalid-options` and a change reads as `invalid`. Nothing here logs or
// prints a value, a name or a root: errors name a rule, never content.
//
// Names compare as UTF-8 bytes, never by Swift's canonical equivalence, and U+0000 is looked for
// among Unicode scalars, because a NUL followed by a combining mark is one Character.

import Foundation

/// What the host seals and opens with. The ring's `SyncCodec` is the app's one conformer; a test
/// conforms over a fixture root. Every call refuses with `sync-locked` while there is no root.
public protocol SyncCodecPort: Sendable {
    var locked: Bool { get }
    func seal(collection: String, name: String, value: JSONValue) throws -> Data
    func open(collection: String, name: String, envelope: Data, aliases: [String]) throws -> SyncEnvelope.Opened
    func openAny(collection: String, envelope: Data) throws -> SyncEnvelope.Opened
    func blind(kind: SyncBlind.Kind, ctx: String, name: String) throws -> String
}

/// The result of opening an answer: the body with plaintext values, and the machine's typed result.
public struct SyncOpenedPull: Sendable, Equatable {
    public var body: JSONValue
    public var opened: SyncOpenedBody
}

public enum HostCodec {
    public static let settingsCollection = "$settings"

    /// The envelope name of a merge member (D-2): the setting, U+0000, the member.
    public static func memberEnvelopeName(_ setting: String, _ member: String) -> String {
        setting + "\u{0}" + member
    }

    // MARK: Errors

    static func locked() -> PolarisError {
        PolarisError(code: ErrorCode.syncLocked, message: "Cloud Sync is locked: there is no root")
    }

    static func refuse(_ why: String) -> PolarisError {
        PolarisError(code: ErrorCode.invalidOptions, message: "Cloud Sync host codec: \(why)")
    }

    // MARK: Helpers

    private static let strip = ["sealed", "invalid", "seq", "ct"]

    /// The blind input has no length prefix (`kind NUL ctx NUL name`), so a name with a NUL could
    /// collide with another (setting, member) pair; no name may hold one.
    static func hasNul(_ s: String) -> Bool { s.unicodeScalars.contains("\u{0}") }

    private static func bytesEqual(_ a: String, _ b: String) -> Bool { a.utf8.elementsEqual(b.utf8) }

    /// The envelope of a served `ct`, or nil for anything but non-empty canonical base64url.
    private static func fromCt(_ ct: JSONValue?) -> Data? {
        guard case .string(let s)? = ct, !s.isEmpty else { return nil }
        return Base64URL.decodeStrict(s)
    }

    private static func stripped(_ e: [String: JSONValue]) -> [String: JSONValue] {
        var out = e
        for k in strip { out[k] = nil }
        return out
    }

    // MARK: Push

    /// Seals a push body. `declared` holds the catalog's declared setting keys: such a key stays in
    /// the clear; any other key is an open setting and is blinded. The body is not changed; the
    /// answer is a copy. Throws (and so sends nothing) when the codec is locked or a mutation
    /// cannot be sealed.
    public static func sealPush(_ body: JSONValue, codec: any SyncCodecPort, declared: some Sequence<String>)
        throws -> JSONValue
    {
        if codec.locked { throw locked() }
        guard case .object(var o) = body, case .array(let list)? = o["mutations"] else { return body }
        let keys = Set(declared.map { Array($0.utf8) })
        var mutations: [JSONValue] = []
        for m in list {
            guard case .object(let mo) = m else { throw refuse("mutation is not an object") }
            mutations.append(.object(try sealMutation(mo, codec, keys)))
        }
        o["mutations"] = .array(mutations)
        return .object(o)
    }

    /// The same, over the catalog's routes.
    public static func sealPush(_ body: JSONValue, codec: any SyncCodecPort, routes: [SettingRoute]) throws
        -> JSONValue
    {
        try sealPush(body, codec: codec, declared: routes.map(\.key))
    }

    private static func sealMutation(_ m: [String: JSONValue], _ codec: any SyncCodecPort, _ declared: Set<[UInt8]>)
        throws -> [String: JSONValue]
    {
        if case .object(let target)? = m["target"], target["record"] != nil {
            return try sealRecordMutation(m, target, codec)
        }
        guard case .object(let target)? = m["target"], case .string(let setting)? = target["setting"] else {
            throw refuse("only a setting or a record mutation can be sealed")
        }
        if m["ct"] != nil || m["field"] != nil || m["element"] != nil {
            throw refuse("mutation carries a member this codec does not seal")
        }
        var member: String?
        if case .string(let s)? = m["member"] { member = s }
        if hasNul(setting) || (member.map(hasNul) ?? false) { throw refuse("a name holds U+0000") }
        let openKey = !declared.contains(Array(setting.utf8))
        var out = m
        if openKey {
            var t = target
            t["setting"] = .string(try codec.blind(kind: .setting, ctx: settingsCollection, name: setting))
            out["target"] = .object(t)
        }
        func ct(_ name: String, _ value: JSONValue) throws -> JSONValue {
            .string(Base64URL.encode(try codec.seal(collection: settingsCollection, name: name, value: value)))
        }
        switch m["op"] {
        case .string("set")?:
            guard let value = m["value"], m["member"] == nil else { throw refuse("set needs a value and no member") }
            out["value"] = nil
            out["ct"] = try ct(setting, value)
            return out
        case .string("setMember")?:
            guard !openKey, let member, let value = m["value"] else {
                throw refuse("setMember needs a declared setting, a member and a value")
            }
            out["value"] = nil
            out["member"] = .string(try codec.blind(kind: .member, ctx: setting, name: member))
            out["ct"] = try ct(memberEnvelopeName(setting, member), value)
            return out
        case .string("removeMember")?:
            guard !openKey, let member, m["value"] == nil else {
                throw refuse("removeMember needs a declared setting and a member")
            }
            out["member"] = .string(try codec.blind(kind: .member, ctx: setting, name: member))
            return out
        case .string("clear")?:
            if m["value"] != nil || m["member"] != nil { throw refuse("clear carries no value") }
            return out
        default:
            throw refuse("unsupported operation")
        }
    }

    /// A record mutation (scalar value, D-2): `set` seals the value under the collection with `k = id`;
    /// `delete` carries none. Either sends the id blinded. The collection travels in the clear (§13.10.2).
    private static func sealRecordMutation(
        _ m: [String: JSONValue], _ target: [String: JSONValue], _ codec: any SyncCodecPort
    ) throws -> [String: JSONValue] {
        guard let (collection, id) = recordRef(target["record"]) else {
            throw refuse("a record reference is malformed")
        }
        if m["ct"] != nil || m["field"] != nil || m["element"] != nil || m["member"] != nil {
            throw refuse("mutation carries a member this codec does not seal")
        }
        var out = m
        switch m["op"] {
        case .string("set")?:
            guard let value = m["value"] else { throw refuse("set needs a value") }
            out["value"] = nil
            out["ct"] = .string(
                Base64URL.encode(try codec.seal(collection: collection, name: id, value: value)))
        case .string("delete")?:
            if m["value"] != nil { throw refuse("delete carries no value") }
        default:
            throw refuse("unsupported operation")
        }
        var t = target
        t["record"] = .array([
            .string(collection), .string(try codec.blind(kind: .record, ctx: collection, name: id)),
        ])
        out["target"] = .object(t)
        return out
    }

    /// `(collection, id)` when `v` is a pair of non-empty strings that can name a record: no U+0000
    /// (the blind input has no length prefix) and not the settings collection's namespace (`$`).
    static func recordRef(_ v: JSONValue?) -> (String, String)? {
        guard case .array(let a)? = v, a.count == 2, case .string(let c) = a[0], case .string(let id) = a[1],
            !c.isEmpty, !id.isEmpty, !hasNul(c), !hasNul(id), c.utf8.first != UInt8(ascii: "$")
        else { return nil }
        return (c, id)
    }

    /// The lookup key of a collection and a (blinded) id: their UTF-8 bytes joined by a NUL that no
    /// name holds, so names compare as bytes.
    private static func recordKey(_ c: String, _ id: String) -> [UInt8] { Array(c.utf8) + [0] + Array(id.utf8) }

    /// The lookup key of a served `[collection, blinded id]`, or nil when it is not a pair of strings.
    private static func servedKey(_ v: JSONValue?) -> [UInt8]? {
        guard case .array(let a)? = v, a.count == 2, case .string(let c) = a[0], case .string(let id) = a[1] else {
            return nil
        }
        return recordKey(c, id)
    }

    // MARK: Pull

    /// Opens a pull or push answer. The body has plaintext `value`s and plaintext setting names
    /// where they could be proven; `opened` is the typed result for the machine's `receive`. Throws
    /// (and so delivers nothing to the machine) when the codec is locked or the answer repeats a
    /// `mutationId`.
    ///
    /// `mutations` are the plaintext mutations of the request the answer belongs to (a conflict's
    /// server copy carries no name, so it opens against the mutation's own setting). `aliases` are
    /// the renames the app declares, never taken from the body. `openKeys` are the open-setting keys
    /// the machine already holds: a tombstone names a key blinded, and only these map back.
    /// `recordKeys` are the `(collection, id)` pairs of the records it holds, which a record
    /// tombstone's blinded id maps back to likewise.
    public static func openPull(
        _ body: JSONValue, codec: any SyncCodecPort, mutations: [JSONValue] = [],
        aliases: [String: String] = [:], openKeys: some Sequence<String> = [String](),
        recordKeys: some Sequence<(collection: String, id: String)> = [(collection: String, id: String)]()
    ) throws -> SyncOpenedPull {
        if codec.locked { throw locked() }
        guard case .object(let b) = body else { return SyncOpenedPull(body: body, opened: SyncOpenedBody()) }
        var out = b
        var opened = SyncOpenedBody()

        if case .array(let list)? = b["changes"] {
            var changes: [JSONValue] = []
            var rows: [SyncOpenedRow?] = []
            for c in list {
                guard case .object(let co) = c else {
                    changes.append(c)
                    rows.append(nil)
                    continue
                }
                let (entry, row) = try openChange(co, codec, aliases)
                changes.append(.object(entry))
                rows.append(row)
            }
            out["changes"] = .array(changes)
            opened.changes = rows
        }

        if case .array(let list)? = b["tombstones"] {
            var names: [String: String] = [:]
            for k in openKeys { names[try codec.blind(kind: .setting, ctx: settingsCollection, name: k)] = k }
            var records: [[UInt8]: String] = [:]
            for k in recordKeys {
                guard let (c, id) = recordRef(.array([.string(k.collection), .string(k.id)])) else { continue }
                records[recordKey(c, try codec.blind(kind: .record, ctx: c, name: id))] = id
            }
            out["tombstones"] = .array(
                list.map { t in
                    guard case .object(var to) = t else { return t }
                    if case .string(let s)? = to["setting"], let plain = names[s] {
                        to["setting"] = .string(plain)
                        return .object(to)
                    }
                    if let key = servedKey(to["record"]), let plain = records[key],
                        case .array(let a)? = to["record"]
                    {
                        to["record"] = .array([a[0], .string(plain)])
                        return .object(to)
                    }
                    return t
                })
        }

        // Renames come from the app only; a served map or `renamedTo` could swap values between keys.
        if b["aliases"] != nil { out["aliases"] = .object(aliases.mapValues { .string($0) }) }

        if case .array(let list)? = b["results"] {
            var results: [JSONValue] = []
            var seen = Set<String>()
            for r in list {
                guard case .object(let ro) = r else {
                    results.append(r)
                    continue
                }
                // One verdict per mutation. A second result for an id would overwrite the first
                // verdict while the machine reads the first body entry: fail closed (HC-1).
                guard seen.insert(idKey(ro["mutationId"])).inserted else {
                    throw PolarisError(code: ErrorCode.syncFailed, message: "Cloud Sync answer repeats a mutationId")
                }
                var clean = stripped(ro)
                if clean["renamedTo"] != nil {
                    // Kept only for an alias the app declares.
                    var keep = false
                    if case .string(let to)? = clean["renamedTo"],
                        let from = conflictSetting(mutations, ro["mutationId"]),
                        let app = aliases[from]
                    {
                        keep = bytesEqual(app, to)
                    }
                    if !keep { clean["renamedTo"] = nil }
                }
                if case .string("conflict")? = ro["status"], case .object(let server)? = ro["server"] {
                    // Only a conflict for a mutation of this request opens: without one there is no
                    // name to open against and the copy reads as invalid.
                    let expect = conflictSetting(mutations, ro["mutationId"])
                    let (entry, row) =
                        try conflictRecord(mutations, ro["mutationId"]).map { try openRecordCopy(server, $0, codec) }
                        ?? openCopy(server, expect, codec, aliases)
                    clean["server"] = .object(entry)
                    if case .int(let mid)? = ro["mutationId"] { opened.conflicts[mid] = row }
                }
                results.append(.object(clean))
            }
            out["results"] = .array(results)
        }

        for k in strip { out[k] = nil }
        return SyncOpenedPull(body: .object(out), opened: opened)
    }

    /// A hashable identity for a served `mutationId`, as JavaScript's `Set` sees it (`1` and `true`
    /// differ; `1` and `1.0` do not; an absent id and a `null` are the same).
    private static func idKey(_ v: JSONValue?) -> String {
        switch v {
        case .int(let i)?: return "n\(i)"
        case .double(let d)?:
            if d.isFinite, d == d.rounded(.towardZero), abs(d) < 9.0e15 { return "n\(Int(d))" }
            return "d\(d)"
        case nil, .null?: return "null"
        case .bool(let b)?: return "b\(b)"
        case .string(let s)?: return "s" + (jsonCanonical(.string(s)) ?? "")
        case .array?, .object?: return "j" + (v.flatMap(jsonCanonical) ?? "")
        }
    }

    /// The plaintext setting name of mutation `mid`, or nil when the host did not say.
    private static func conflictSetting(_ ms: [JSONValue], _ mid: JSONValue?) -> String? {
        guard case .int(let id)? = mid else { return nil }
        for m in ms {
            guard case .object(let mo) = m, case .int(let mm)? = mo["mutationId"], mm == id else { continue }
            if case .object(let t)? = mo["target"], case .string(let s)? = t["setting"] { return s }
            return nil
        }
        return nil
    }

    /// The `(collection, id)` of record mutation `mid`, or nil when the host did not say.
    private static func conflictRecord(_ ms: [JSONValue], _ mid: JSONValue?) -> (String, String)? {
        guard case .int(let id)? = mid else { return nil }
        for m in ms {
            guard case .object(let mo) = m, case .int(let mm)? = mo["mutationId"], mm == id else { continue }
            if case .object(let t)? = mo["target"] { return recordRef(t["record"]) }
            return nil
        }
        return nil
    }

    private static func aliasesOf(_ name: String, _ aliases: [String: String]) -> [String] {
        aliases.filter { bytesEqual($0.value, name) }.map(\.key)
    }

    private static func invalidRow(_ e: [String: JSONValue]) -> ([String: JSONValue], SyncOpenedRow) {
        var out = stripped(e)
        out["value"] = nil
        out["members"] = nil
        return (out, SyncOpenedRow(invalid: true))
    }

    private static func plainRow(_ e: [String: JSONValue]) -> ([String: JSONValue], SyncOpenedRow) {
        var seq: Int?
        switch e["version"] {
        case .int(let i)?: seq = i
        case .double(let d)?:
            if d.isFinite, d == d.rounded(.towardZero), abs(d) < 9.0e15 { seq = Int(d) }
        default: break
        }
        return (stripped(e), SyncOpenedRow(seq: seq))
    }

    private static func openChange(_ c: [String: JSONValue], _ codec: any SyncCodecPort, _ aliases: [String: String])
        throws -> ([String: JSONValue], SyncOpenedRow)
    {
        if case .string = c["setting"] { return try openSettingChange(c, codec, aliases) }
        if c["record"] != nil { return try openRecordChange(c, codec) }
        // Neither a setting nor a record: a sealed one cannot be placed.
        return c["ct"] != nil ? invalidRow(c) : plainRow(c)
    }

    /// A record change: `{record: [collection, id], ct, version}`. A sealed `merge` or `union` change
    /// (`fields`, `elements`) is outside the scalar codec and reads as invalid; a plaintext row is legacy
    /// (the machine checks its `seq` against `encryptionSince`). A sealed id is accepted only when it is
    /// blinded and the `k` inside the envelope re-blinds to it (HC-5); it is then replaced by the id.
    private static func openRecordChange(_ c: [String: JSONValue], _ codec: any SyncCodecPort) throws
        -> ([String: JSONValue], SyncOpenedRow)
    {
        if isArray(c["fields"]) || isArray(c["elements"]) { return invalidRow(c) }
        if c["ct"] == nil { return plainRow(c) }
        guard let (collection, served) = recordRef(c["record"]), SyncBlind.isBlindedName(served),
            let env = fromCt(c["ct"]),
            case .ok(let id, let value) = try codec.openAny(collection: collection, envelope: env),
            !id.isEmpty, !hasNul(id),
            try codec.blind(kind: .record, ctx: collection, name: id) == served
        else { return invalidRow(c) }
        var entry = stripped(c)
        entry["record"] = .array([.string(collection), .string(id)])
        entry["value"] = value
        return (entry, SyncOpenedRow(sealed: true))
    }

    /// A conflict's server copy of the record of the mutation: one `ct`, opened under that id.
    private static func openRecordCopy(
        _ e: [String: JSONValue], _ rec: (String, String), _ codec: any SyncCodecPort
    ) throws -> ([String: JSONValue], SyncOpenedRow) {
        if isArray(e["fields"]) || isArray(e["elements"]) { return invalidRow(e) }
        if e["ct"] == nil { return plainRow(e) }
        guard let env = fromCt(e["ct"]),
            case .ok(_, let value) = try codec.open(collection: rec.0, name: rec.1, envelope: env, aliases: [])
        else { return invalidRow(e) }
        var entry = stripped(e)
        entry["value"] = value
        return (entry, SyncOpenedRow(sealed: true))
    }

    private static func isArray(_ v: JSONValue?) -> Bool {
        if case .array? = v { return true }
        return false
    }

    private static func openSettingChange(
        _ c: [String: JSONValue], _ codec: any SyncCodecPort, _ aliases: [String: String]
    ) throws -> ([String: JSONValue], SyncOpenedRow) {
        guard case .string(let served)? = c["setting"] else { return invalidRow(c) }
        if hasNul(served) { return invalidRow(c) }
        var hasMembers = false
        if case .array? = c["members"] { hasMembers = true }
        if c["ct"] == nil && !hasMembers { return plainRow(c) }
        guard SyncBlind.isBlindedName(served) else { return try openCopy(c, served, codec, aliases) }
        // An open key: the name is inside the envelope and must re-blind to the served name (HC-5).
        guard c["ct"] != nil, let env = fromCt(c["ct"]) else { return invalidRow(c) }
        guard case .ok(let name, let value) = try codec.openAny(collection: settingsCollection, envelope: env),
            !hasNul(name),
            try codec.blind(kind: .setting, ctx: settingsCollection, name: name) == served
        else { return invalidRow(c) }
        var entry = stripped(c)
        entry["setting"] = .string(name)
        entry["value"] = value
        return (entry, SyncOpenedRow(sealed: true))
    }

    /// Opens a row (or a conflict's server copy) whose setting name is `name`: one `ct`, or a merge
    /// setting's sealed `members`. A nil `name` (a conflict the host cannot place) reads as invalid.
    private static func openCopy(
        _ e: [String: JSONValue], _ name: String?, _ codec: any SyncCodecPort, _ aliases: [String: String]
    ) throws -> ([String: JSONValue], SyncOpenedRow) {
        let hasCt = e["ct"] != nil
        var members: [JSONValue]?
        if case .array(let m)? = e["members"] { members = m }
        if !hasCt && members == nil { return plainRow(e) }
        guard let name, !hasNul(name) else { return invalidRow(e) }
        if hasCt {
            guard let env = fromCt(e["ct"]) else { return invalidRow(e) }
            guard
                case .ok(_, let value) = try codec.open(
                    collection: settingsCollection, name: name, envelope: env, aliases: aliasesOf(name, aliases))
            else { return invalidRow(e) }
            var entry = stripped(e)
            entry["members"] = nil
            entry["value"] = value
            return (entry, SyncOpenedRow(sealed: true))
        }
        let prefix = Array((name + "\u{0}").unicodeScalars)
        var value: [String: JSONValue] = [:]
        var seen = Set<[UInt8]>()
        for m in members ?? [] {
            guard case .object(let mo) = m, case .string(let served)? = mo["member"],
                let env = fromCt(mo["ct"]), SyncBlind.isBlindedName(served)
            else { return invalidRow(e) }
            guard case .ok(let envName, let v) = try codec.openAny(collection: settingsCollection, envelope: env)
            else { return invalidRow(e) }
            let scalars = Array(envName.unicodeScalars)
            guard scalars.count >= prefix.count, Array(scalars[..<prefix.count]) == prefix else {
                return invalidRow(e)
            }
            var member = ""
            member.unicodeScalars.append(contentsOf: scalars[prefix.count...])
            if hasNul(member) { return invalidRow(e) }
            guard try codec.blind(kind: .member, ctx: name, name: member) == served else { return invalidRow(e) }
            guard seen.insert(Array(member.utf8)).inserted, value[member] == nil else { return invalidRow(e) }
            value[member] = v
        }
        var entry = stripped(e)
        entry["members"] = nil
        entry["value"] = .object(value)
        return (entry, SyncOpenedRow(sealed: true))
    }
}
