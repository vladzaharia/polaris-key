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
// Scope: settings (the `$settings` collection) and records of every policy (§13.10.4). A `set`
// value is sealed under its collection with `k = id`, a `merge` field under `k = id U+0000 field`
// and a `union` element under `k = id U+0000 canonicalJson(element)`; the id, the field and the
// element travel as `blind("record" | "field" | "element", collection, name)`. A pulled record opens
// only when the `k` inside each envelope re-blinds to the names on the wire, so a Worker cannot place
// a sealed value under another record. Nothing here logs or prints a value, a name or a root: errors
// name a rule, never content.
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

    /// The envelope name of a `merge` record's field (§13.10.4): the id, U+0000, the field.
    public static func fieldEnvelopeName(_ id: String, _ field: String) -> String { id + "\u{0}" + field }

    /// The envelope name of a `union` record's element (§13.10.4): the id, U+0000, the element's
    /// canonical JSON.
    public static func elementEnvelopeName(_ id: String, _ canonical: String) -> String {
        id + "\u{0}" + canonical
    }

    /// The id a record goes by on the wire: its blinded name in E2E mode (`codec` given), the id itself
    /// in server mode. The file routes name a record by this id before any push has sealed it.
    public static func wireId(_ codec: SyncCodecPort?, _ collection: String, _ id: String) throws -> String {
        guard let codec else { return id }
        return try codec.blind(kind: .record, ctx: collection, name: id)
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

    /// The ids of the mutations of a push body that cannot be sealed (one at a time, so the others are not
    /// blamed). Empty when the codec is locked: that is not the mutation's fault.
    public static func unsealableMutations(_ body: JSONValue, codec: any SyncCodecPort, routes: [SettingRoute])
        -> [Int]
    {
        guard !codec.locked, case .object(let o) = body, case .array(let list)? = o["mutations"] else { return [] }
        var out: [Int] = []
        for m in list {
            guard case .object(let mo) = m, case .int(let mid)? = mo["mutationId"] else { continue }
            var one = o
            one["mutations"] = .array([m])
            if (try? sealPush(.object(one), codec: codec, routes: routes)) == nil, !codec.locked { out.append(mid) }
        }
        return out
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

    /// The canonical JSON of an element, or a refusal: a number or text that cannot be spelled
    /// identically everywhere is never sent.
    private static func canonical(_ e: JSONValue) throws -> String {
        do { return try CanonicalJSON.encode(e) } catch { throw refuse("an element cannot be spelled canonically") }
    }

    /// A record mutation (§13.10.4). `set` seals the value under `k = id`; `setField` under
    /// `id U+0000 field`; `add` seals the element under `id U+0000 canonicalJson(e)`. `delete`,
    /// `removeField` and `remove` carry no value. Every name goes blinded, the collection in the clear.
    private static func sealRecordMutation(
        _ m: [String: JSONValue], _ target: [String: JSONValue], _ codec: any SyncCodecPort
    ) throws -> [String: JSONValue] {
        guard let (collection, id) = recordRef(target["record"]) else {
            throw refuse("a record reference is malformed")
        }
        if m["ct"] != nil { throw refuse("mutation carries a member this codec does not seal") }
        func absent(_ names: String...) throws {
            for n in names where m[n] != nil { throw refuse("mutation carries a member its operation does not take") }
        }
        func field() throws -> String {
            guard case .string(let f)? = m["field"], !f.isEmpty, !hasNul(f) else {
                throw refuse("a field name is empty or holds U+0000")
            }
            return f
        }
        func seal(_ name: String, _ value: JSONValue) throws -> JSONValue {
            .string(Base64URL.encode(try codec.seal(collection: collection, name: name, value: value)))
        }
        var out = m
        switch m["op"] {
        case .string("set")?:
            try absent("field", "element", "member")
            guard let value = m["value"] else { throw refuse("set needs a value") }
            out["value"] = nil
            out["ct"] = try seal(id, value)
        case .string("delete")?:
            try absent("value", "field", "element", "member")
        case .string("setField")?:
            try absent("element", "member")
            let f = try field()
            guard let value = m["value"] else { throw refuse("setField needs a value") }
            out["value"] = nil
            out["field"] = .string(try codec.blind(kind: .field, ctx: collection, name: f))
            out["ct"] = try seal(fieldEnvelopeName(id, f), value)
        case .string("removeField")?:
            try absent("value", "element", "member")
            out["field"] = .string(try codec.blind(kind: .field, ctx: collection, name: try field()))
        case .string("add")?:
            try absent("value", "field", "member")
            guard let e = m["element"] else { throw refuse("an element is missing") }
            let name = try canonical(e)
            out["element"] = .string(try codec.blind(kind: .element, ctx: collection, name: name))
            out["ct"] = try seal(elementEnvelopeName(id, name), e)
        case .string("remove")?:
            try absent("value", "field", "member")
            guard let e = m["element"] else { throw refuse("an element is missing") }
            out["element"] = .string(try codec.blind(kind: .element, ctx: collection, name: try canonical(e)))
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

        // The records the machine holds: a blinded id maps back to its plaintext id.
        var records: [[UInt8]: String] = [:]
        for k in recordKeys {
            guard let (c, id) = recordRef(.array([.string(k.collection), .string(k.id)])) else { continue }
            records[recordKey(c, try codec.blind(kind: .record, ctx: c, name: id))] = id
        }

        if case .array(let list)? = b["changes"] {
            var changes: [JSONValue] = []
            var rows: [SyncOpenedRow?] = []
            for c in list {
                guard case .object(let co) = c else {
                    changes.append(c)
                    rows.append(nil)
                    continue
                }
                let (entry, row) = try openChange(co, codec, aliases, records)
                changes.append(.object(entry))
                rows.append(row)
            }
            out["changes"] = .array(changes)
            opened.changes = rows
        }

        if case .array(let list)? = b["tombstones"] {
            var names: [String: String] = [:]
            for k in openKeys { names[try codec.blind(kind: .setting, ctx: settingsCollection, name: k)] = k }
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
        out["fields"] = nil
        out["elements"] = nil
        return (out, SyncOpenedRow(invalid: true))
    }

    private static func plainRow(_ e: [String: JSONValue]) -> ([String: JSONValue], SyncOpenedRow) {
        // Sealed cells with no `ct` are not a plaintext row: only the host's open can read them.
        if isArray(e["fields"]) || isArray(e["elements"]) { return invalidRow(e) }
        var seq: Int?
        switch e["version"] {
        case .int(let i)?: seq = i
        case .double(let d)?:
            if d.isFinite, d == d.rounded(.towardZero), abs(d) < 9.0e15 { seq = Int(d) }
        default: break
        }
        return (stripped(e), SyncOpenedRow(seq: seq))
    }

    private static func openChange(
        _ c: [String: JSONValue], _ codec: any SyncCodecPort, _ aliases: [String: String],
        _ held: [[UInt8]: String]
    ) throws -> ([String: JSONValue], SyncOpenedRow) {
        if case .string = c["setting"] { return try openSettingChange(c, codec, aliases) }
        if c["record"] != nil { return try openRecordChange(c, codec, held) }
        // Neither a setting nor a record: a sealed one cannot be placed.
        return c["ct"] != nil ? invalidRow(c) : plainRow(c)
    }

    private enum RecordShape { case ct, fields, elements, plain }

    /// The sealed shape of a record row: one `ct`, sealed `fields`, or sealed `elements`; nil when it
    /// carries more than one.
    private static func recordShape(_ e: [String: JSONValue]) -> RecordShape? {
        var shapes: [RecordShape] = []
        if e["ct"] != nil { shapes.append(.ct) }
        if isArray(e["fields"]) { shapes.append(.fields) }
        if isArray(e["elements"]) { shapes.append(.elements) }
        if shapes.isEmpty { return .plain }
        return shapes.count == 1 ? shapes[0] : nil
    }

    /// A sealed record row's entry: the placed `[collection, id]` and the value it opened to.
    private static func sealedRecord(
        _ e: [String: JSONValue], _ record: JSONValue, _ value: JSONValue
    ) -> ([String: JSONValue], SyncOpenedRow) {
        var entry = stripped(e)
        entry["fields"] = nil
        entry["elements"] = nil
        entry["record"] = record
        entry["value"] = value
        return (entry, SyncOpenedRow(sealed: true))
    }

    /// A record change. A plaintext row is legacy (the machine judges its `seq`, §13.10.7). A sealed
    /// one needs a blinded id and opens only when every envelope's `k` re-blinds to the names the row
    /// came under (HC-5); the row then carries the plaintext id and the opened value (a `merge`
    /// record's object, a `union` record's array in the served order).
    private static func openRecordChange(
        _ c: [String: JSONValue], _ codec: any SyncCodecPort, _ held: [[UInt8]: String]
    ) throws -> ([String: JSONValue], SyncOpenedRow) {
        guard let shape = recordShape(c) else { return invalidRow(c) }
        if shape == .plain { return plainRow(c) }
        guard let (collection, served) = recordRef(c["record"]), SyncBlind.isBlindedName(served) else {
            return invalidRow(c)
        }
        if shape == .ct {
            guard let env = fromCt(c["ct"]),
                case .ok(let id, let value) = try codec.openAny(collection: collection, envelope: env),
                !id.isEmpty, !hasNul(id),
                try codec.blind(kind: .record, ctx: collection, name: id) == served
            else { return invalidRow(c) }
            return sealedRecord(c, .array([.string(collection), .string(id)]), value)
        }
        guard let cells = try openCells(c, shape, collection, nil, codec) else { return invalidRow(c) }
        var id = cells.id
        if let known = id {
            guard try codec.blind(kind: .record, ctx: collection, name: known) == served else {
                return invalidRow(c)
            }
        } else {
            // No cell names the record, so the id comes from a record the machine holds, if any.
            id = held[recordKey(collection, served)]
        }
        return sealedRecord(c, .array([.string(collection), .string(id ?? served)]), cells.value)
    }

    /// A conflict's server copy of the record of the mutation: opened under that id.
    private static func openRecordCopy(
        _ e: [String: JSONValue], _ rec: (String, String), _ codec: any SyncCodecPort
    ) throws -> ([String: JSONValue], SyncOpenedRow) {
        guard let shape = recordShape(e) else { return invalidRow(e) }
        if shape == .plain { return plainRow(e) }
        if shape == .ct {
            guard let env = fromCt(e["ct"]),
                case .ok(_, let value) = try codec.open(collection: rec.0, name: rec.1, envelope: env, aliases: [])
            else { return invalidRow(e) }
            var entry = stripped(e)
            entry["value"] = value
            return (entry, SyncOpenedRow(sealed: true))
        }
        guard let cells = try openCells(e, shape, rec.0, rec.1, codec) else { return invalidRow(e) }
        var entry = stripped(e)
        entry["fields"] = nil
        entry["elements"] = nil
        entry["value"] = cells.value
        return (entry, SyncOpenedRow(sealed: true))
    }

    /// Opens the sealed cells of a `merge` record (`fields`) or a `union` record (`elements`). Each
    /// envelope's `k` splits at its first U+0000 into the id and the cell name; the cell's blinded
    /// name must be what the row carries (and, for an element, the opened value must spell the name),
    /// and every cell must name the same id (`expectId`, when the caller knows it). `id` is nil for a
    /// record with no cells.
    private static func openCells(
        _ e: [String: JSONValue], _ shape: RecordShape, _ collection: String, _ expectId: String?,
        _ codec: any SyncCodecPort
    ) throws -> (id: String?, value: JSONValue)? {
        let isField = shape == .fields
        let kind: SyncBlind.Kind = isField ? .field : .element
        guard case .array(let cells)? = e[isField ? "fields" : "elements"] else { return nil }
        var id = expectId
        var names = Set<[UInt8]>()
        var fields: [String: JSONValue] = [:]
        var elements: [JSONValue] = []
        for cell in cells {
            guard case .object(let co) = cell, case .string(let wire)? = co[isField ? "field" : "element"],
                SyncBlind.isBlindedName(wire), let env = fromCt(co["ct"]),
                case .ok(let envName, let value) = try codec.openAny(collection: collection, envelope: env)
            else { return nil }
            let scalars = Array(envName.unicodeScalars)
            guard let cut = scalars.firstIndex(of: "\u{0}"), cut > 0 else { return nil }
            var cellId = ""
            cellId.unicodeScalars.append(contentsOf: scalars[..<cut])
            var name = ""
            name.unicodeScalars.append(contentsOf: scalars[(cut + 1)...])
            if name.isEmpty || hasNul(name) { return nil }
            if let known = id, !bytesEqual(cellId, known) { return nil }
            id = cellId
            guard try codec.blind(kind: kind, ctx: collection, name: name) == wire else { return nil }
            guard names.insert(Array(name.utf8)).inserted else { return nil }
            if isField {
                fields[name] = value
            } else {
                guard let spelled = try? CanonicalJSON.encode(value), bytesEqual(spelled, name) else { return nil }
                elements.append(value)
            }
        }
        return (id, isField ? .object(fields) : .array(elements))
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
