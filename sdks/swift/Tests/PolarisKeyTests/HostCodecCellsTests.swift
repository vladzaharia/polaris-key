// @pkey-feature sync.records
// The host codec's merge fields and union elements (WIRE-CONTRACT-V5 §13.10.4): a field sealed under
// `k = id U+0000 field` and sent as `blind("field", c, field)`, an element under `k = id U+0000
// canonicalJson(e)` and `blind("element", c, canonicalJson(e))`, the record id blinded; and a pulled row
// of sealed `fields` or `elements` opened only when every envelope's `k` re-blinds to the names served.

import Foundation
import Testing

@testable import PolarisKey
@testable import PolarisKeyCore

private let root = Data((0..<32).map { UInt8(truncatingIfNeeded: 3 * $0 + 7) })
private let otherRoot = Data((0..<32).map { UInt8(truncatingIfNeeded: 250 - 5 * $0) })
private let prefs = "prefs"
private let tags = "tags"
private let codec = FixtureCodec(root)
private let sealedRow = SyncOpenedRow(sealed: true)
private let invalidRow = SyncOpenedRow(invalid: true)

private func str(_ s: String) -> JSONValue { .string(s) }
private func obj(_ o: [String: JSONValue]) -> JSONValue { .object(o) }
private func arr(_ a: [JSONValue]) -> JSONValue { .array(a) }
private func j(_ s: String) -> JSONValue { try! JSONDecoder().decode(JSONValue.self, from: Data(s.utf8)) }
private func bl(_ kind: SyncBlind.Kind, _ ctx: String, _ n: String) -> String {
    SyncBlind.blind(root: root, kind: kind, ctx: ctx, n: n)
}
private func ct(_ collection: String, _ name: String, _ v: JSONValue, _ r: Data = root) -> String {
    Base64URL.encode(try! SyncEnvelope.seal(root: r, collection: collection, name: name, value: v))
}
private func mutation(_ id: Int, _ op: String, _ collection: String, _ name: String, _ extra: [String: JSONValue])
    -> JSONValue
{
    var m: [String: JSONValue] = [
        "mutationId": .int(id), "target": obj(["record": arr([str(collection), str(name)])]), "op": str(op),
    ]
    for (k, v) in extra { m[k] = v }
    return obj(m)
}
private func sealed(_ ms: [JSONValue]) throws -> [[String: JSONValue]] {
    let body = obj(["clientId": str("c_x"), "cursor": .int(0), "atomic": .bool(false), "mutations": arr(ms)])
    let out = try HostCodec.sealPush(body, codec: codec, declared: [String]())
    return (out.objectValue?["mutations"]?.arrayValue ?? []).map { $0.objectValue ?? [:] }
}
private func pull(_ body: JSONValue, mutations: [JSONValue] = [], recordKeys: [(collection: String, id: String)] = [])
    throws -> SyncOpenedPull
{
    try HostCodec.openPull(body, codec: codec, mutations: mutations, recordKeys: recordKeys)
}
private func changes(_ b: JSONValue) -> [[String: JSONValue]] {
    (b.objectValue?["changes"]?.arrayValue ?? []).map { $0.objectValue ?? [:] }
}
private func cell(_ kind: String, _ blinded: String, _ ct: String) -> JSONValue {
    obj([kind: str(blinded), "ct": str(ct)])
}

@Suite struct HostCodecCellsTests {
    // MARK: sealPush

    @Test func anEmptyFieldsOrElementsListOpensAsAnEmptyRecordUnderTheHeldIdElseTheBlindedId() throws {
        let served = bl(.record, prefs, "main")
        let fields = obj(["record": arr([str(prefs), str(served)]), "fields": arr([]), "version": .int(2)])
        let held = try pull(obj(["changes": arr([fields])]), recordKeys: [(prefs, "main")])
        #expect(held.opened.changes == [sealedRow])
        #expect(changes(held.body)[0]["value"] == obj([:]))
        #expect(changes(held.body)[0]["record"] == arr([str(prefs), str("main")]))
        let bare = try pull(obj(["changes": arr([fields])]))
        #expect(changes(bare.body)[0]["record"] == arr([str(prefs), str(served)]))
        let elements = obj(["record": arr([str(prefs), str(served)]), "elements": arr([]), "version": .int(2)])
        let list = try pull(obj(["changes": arr([elements])]), recordKeys: [(prefs, "main")])
        #expect(changes(list.body)[0]["value"] == arr([]))
    }

    @Test func aFieldSealsUnderIdNulField() throws {
        let ms = try sealed([
            mutation(1, "setField", prefs, "main", ["field": str("volume"), "value": .int(3), "editedHlc": str("h")]),
            mutation(2, "removeField", prefs, "main", ["field": str("old"), "editedHlc": str("h")]),
        ])
        #expect(ms[0]["target"]?.objectValue?["record"] == arr([str(prefs), str(bl(.record, prefs, "main"))]))
        #expect(ms[0]["field"] == str(bl(.field, prefs, "volume")))
        #expect(ms[0]["value"] == nil && ms[0]["editedHlc"] == str("h"))
        let env = Base64URL.decodeStrict(ms[0]["ct"]!.stringValue!)!
        guard
            case .ok(let name, let value) = SyncEnvelope.open(
                root: root, collection: prefs, name: "main\u{0}volume", envelope: env)
        else {
            Issue.record("the ct does not open under its field")
            return
        }
        #expect(name == "main\u{0}volume" && value == .int(3))
        #expect(!SyncEnvelope.open(root: root, collection: prefs, name: "main", envelope: env).isOK)
        // A removal blinds the field and carries no ct.
        #expect(ms[1]["field"] == str(bl(.field, prefs, "old")) && ms[1]["ct"] == nil)
        let wire = String(decoding: try JSONEncoder().encode(JSONValue.array(ms.map { .object($0) })), as: UTF8.self)
        #expect(!wire.contains("volume") && !wire.contains("\"main\"") && !wire.contains("\"old\""))
    }

    @Test func anElementSealsUnderIdNulCanonicalJson() throws {
        let e = j("{\"b\":1,\"a\":[true,null]}")
        let spelled = "{\"a\":[true,null],\"b\":1}"
        let ms = try sealed([
            mutation(1, "add", tags, "t", ["element": e]),
            mutation(2, "remove", tags, "t", ["element": e, "observedSeq": .int(4)]),
        ])
        #expect(ms[0]["element"] == str(bl(.element, tags, spelled)))
        #expect(ms[1]["element"] == str(bl(.element, tags, spelled)) && ms[1]["ct"] == nil)
        #expect(ms[1]["observedSeq"] == .int(4))
        let env = Base64URL.decodeStrict(ms[0]["ct"]!.stringValue!)!
        guard
            case .ok(_, let value) = SyncEnvelope.open(
                root: root, collection: tags, name: "t\u{0}" + spelled, envelope: env)
        else {
            Issue.record("the ct does not open under its element")
            return
        }
        #expect(value == e)
    }

    // MARK: openPull

    private func fieldsRow(_ id: String, _ fields: [(String, JSONValue)], under: String? = nil) -> [String: JSONValue] {
        [
            "record": arr([str(prefs), str(bl(.record, prefs, under ?? id))]),
            "fields": arr(fields.map { cell("field", bl(.field, prefs, $0.0), ct(prefs, "\(id)\u{0}\($0.0)", $0.1)) }),
            "version": .int(7),
        ]
    }

    @Test func sealedFieldsOpenToTheObject() throws {
        let r = try pull(obj(["changes": arr([.object(fieldsRow("main", [("a", .int(1)), ("b", str("x"))]))])]))
        let c = changes(r.body)[0]
        #expect(c["record"] == arr([str(prefs), str("main")]) && c["value"] == j("{\"a\":1,\"b\":\"x\"}"))
        #expect(c["fields"] == nil && c["version"] == .int(7))
        #expect(r.opened.changes == [sealedRow])
    }

    @Test func sealedElementsOpenToTheArrayInServedOrder() throws {
        let spelled = ["\"z\"", "{\"a\":1}"]
        let row: [String: JSONValue] = [
            "record": arr([str(tags), str(bl(.record, tags, "t"))]),
            "elements": arr([
                cell("element", bl(.element, tags, spelled[0]), ct(tags, "t\u{0}" + spelled[0], str("z"))),
                cell("element", bl(.element, tags, spelled[1]), ct(tags, "t\u{0}" + spelled[1], j("{\"a\":1}"))),
            ]), "version": .int(2),
        ]
        let r = try pull(obj(["changes": arr([.object(row)])]))
        #expect(changes(r.body)[0]["value"] == arr([str("z"), j("{\"a\":1}")]))
        #expect(changes(r.body)[0]["elements"] == nil && r.opened.changes == [sealedRow])
    }

    @Test func aRecordWithNoCellsTakesItsIdFromAHeldRecord() throws {
        let row: [String: JSONValue] = [
            "record": arr([str(prefs), str(bl(.record, prefs, "main"))]), "fields": arr([]), "version": .int(2),
        ]
        let held = try pull(obj(["changes": arr([.object(row)])]), recordKeys: [(prefs, "main")])
        #expect(changes(held.body)[0]["record"] == arr([str(prefs), str("main")]))
        #expect(changes(held.body)[0]["value"] == obj([:]) && held.opened.changes == [sealedRow])
        let unknown = try pull(obj(["changes": arr([.object(row)])]))
        #expect(changes(unknown.body)[0]["record"]?.arrayValue?[1] == str(bl(.record, prefs, "main")))
    }

    @Test func hostileCellsAreInvalidWithNoValueAndNoCells() throws {
        let good = fieldsRow("main", [("a", .int(1))])
        var tampered = Base64URL.decodeStrict(ct(prefs, "main\u{0}a", .int(1)))!
        tampered[tampered.count - 1] ^= 1
        func with(_ cells: [JSONValue], record: String? = nil) -> [String: JSONValue] {
            var row = good
            row["fields"] = arr(cells)
            if let record { row["record"] = arr([str(prefs), str(record)]) }
            return row
        }
        let a = cell("field", bl(.field, prefs, "a"), ct(prefs, "main\u{0}a", .int(1)))
        let hostile: [String: [String: JSONValue]] = [
            "another record's cell": with([a], record: bl(.record, prefs, "other")),
            "an id that is not blinded": with([a], record: "main"),
            "a cell of another id": with([
                cell("field", bl(.field, prefs, "a"), ct(prefs, "other\u{0}a", .int(1)))
            ]),
            "two ids in one row": with([
                a, cell("field", bl(.field, prefs, "b"), ct(prefs, "other\u{0}b", .int(1))),
            ]),
            "a field named other than served": with([cell("field", bl(.field, prefs, "z"), ct(prefs, "main\u{0}a", .int(1)))]),
            "a field that is not blinded": with([cell("field", "a", ct(prefs, "main\u{0}a", .int(1)))]),
            "a repeated field": with([a, a]),
            "an empty field name": with([cell("field", bl(.field, prefs, ""), ct(prefs, "main\u{0}", .int(1)))]),
            "a name with no NUL": with([cell("field", bl(.field, prefs, "a"), ct(prefs, "a", .int(1)))]),
            "a NUL in the field": with([
                cell("field", bl(.field, prefs, "a\u{0}b"), ct(prefs, "main\u{0}a\u{0}b", .int(1)))
            ]),
            "another root": with([cell("field", bl(.field, prefs, "a"), ct(prefs, "main\u{0}a", .int(1), otherRoot))]),
            "a tampered ct": with([cell("field", bl(.field, prefs, "a"), Base64URL.encode(tampered))]),
            "a ct that is not canonical": with([cell("field", bl(.field, prefs, "a"), ct(prefs, "main\u{0}a", .int(1)) + "=")]),
            "a cell that is not an object": with([str("a")]),
            "elements named as fields": with([cell("element", bl(.field, prefs, "a"), ct(prefs, "main\u{0}a", .int(1)))]),
            "a ct beside the fields": good.merging(["ct": str(ct(prefs, "main", .int(1)))]) { $1 },
            "fields beside elements": good.merging(["elements": arr([])]) { $1 },
        ]
        for (name, entry) in hostile {
            var e = entry
            e["value"] = str("FORGED")
            let r = try pull(obj(["changes": arr([.object(e)])]))
            #expect(r.opened.changes == [invalidRow], "\(name)")
            let c = changes(r.body)[0]
            #expect(c["value"] == nil && c["fields"] == nil && c["ct"] == nil, "\(name)")
        }
    }

    @Test func anElementThatDoesNotSpellItsNameIsInvalid() throws {
        // The cell's name is `1.0` but the value inside is the number 1: the canonical spelling differs.
        let row: [String: JSONValue] = [
            "record": arr([str(tags), str(bl(.record, tags, "t"))]),
            "elements": arr([cell("element", bl(.element, tags, "1.0"), ct(tags, "t\u{0}1.0", .int(1)))]),
        ]
        let r = try pull(obj(["changes": arr([.object(row)])]))
        #expect(r.opened.changes == [invalidRow])
        let dup: [String: JSONValue] = [
            "record": arr([str(tags), str(bl(.record, tags, "t"))]),
            "elements": arr([
                cell("element", bl(.element, tags, "1"), ct(tags, "t\u{0}1", .int(1))),
                cell("element", bl(.element, tags, "1"), ct(tags, "t\u{0}1", .int(1))),
            ]),
        ]
        #expect(try pull(obj(["changes": arr([.object(dup)])])).opened.changes == [invalidRow])
    }

    @Test func aConflictCopyOpensCellsUnderTheMutationsOwnRecord() throws {
        let ms = [mutation(7, "setField", prefs, "main", ["field": str("a"), "value": .int(1)])]
        func result(_ server: [String: JSONValue]) -> JSONValue {
            obj([
                "results": arr([obj(["mutationId": .int(7), "status": str("conflict"), "server": .object(server)])])
            ])
        }
        let good = fieldsRow("main", [("a", .int(9))])
        let r = try pull(result(good), mutations: ms)
        let server = r.body.objectValue?["results"]?.arrayValue?[0].objectValue?["server"]?.objectValue
        #expect(server?["value"] == j("{\"a\":9}") && server?["fields"] == nil && server?["record"] != nil)
        #expect(r.opened.conflicts[7] == sealedRow)
        // Cells that name another id are not the mutation's record.
        let other = try pull(result(fieldsRow("zzz", [("a", .int(9))])), mutations: ms)
        #expect(other.opened.conflicts[7] == invalidRow)
    }

    @Test func sealThenOpenRoundTripsAField() throws {
        let m = try sealed([mutation(1, "setField", prefs, "main", ["field": str("hp"), "value": j("{\"n\":2}")])])[0]
        let row: [String: JSONValue] = [
            "record": m["target"]!.objectValue!["record"]!,
            "fields": arr([cell("field", m["field"]!.stringValue!, m["ct"]!.stringValue!)]),
        ]
        let r = try pull(obj(["changes": arr([.object(row)])]))
        #expect(changes(r.body)[0]["value"] == j("{\"hp\":{\"n\":2}}"))
        #expect(changes(r.body)[0]["record"] == arr([str(prefs), str("main")]))
    }
}
