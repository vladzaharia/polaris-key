// @pkey-feature sync.e2e
// The host codec's record half (U-23.S3; WIRE-CONTRACT-V5 §13.10.4): scalar record values sealed under
// their collection with `k = id`, the id sent as `blind("record", c, id)`, and a pulled record opened
// only when the `k` inside the envelope re-blinds to the id on the wire. Merge and union records are
// outside the native codec (D-2). The corpus's record rows run in SyncVectorsTests.

import Foundation
import Testing

@testable import PolarisKey
@testable import PolarisKeyCore

private let root = Data((0..<32).map { UInt8(truncatingIfNeeded: 3 * $0 + 7) })
private let otherRoot = Data((0..<32).map { UInt8(truncatingIfNeeded: 250 - 5 * $0) })
private let saves = "saves"
private let vol = "audio.volume"
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
private func push(_ mutations: [JSONValue]) -> JSONValue {
    obj(["clientId": str("c_x"), "cursor": .int(0), "atomic": .bool(false), "mutations": arr(mutations)])
}
private func rec(_ id: Int, _ op: String, _ collection: String, _ name: String, _ value: JSONValue? = nil)
    -> JSONValue
{
    var m: [String: JSONValue] = [
        "mutationId": .int(id), "target": obj(["record": arr([str(collection), str(name)])]), "op": str(op),
        "baseVersion": .int(3),
    ]
    if let value { m["value"] = value }
    return obj(m)
}
private func setting(_ id: Int, _ key: String, _ value: JSONValue) -> JSONValue {
    obj([
        "mutationId": .int(id), "target": obj(["setting": str(key), "scope": str("user")]), "op": str("set"),
        "value": value,
    ])
}
private func sealed(_ body: JSONValue) throws -> [[String: JSONValue]] {
    let out = try HostCodec.sealPush(body, codec: codec, declared: [vol])
    return (out.objectValue?["mutations"]?.arrayValue ?? []).map { $0.objectValue ?? [:] }
}
private func code<T>(_ f: () throws -> T) -> String? {
    do {
        _ = try f()
        return nil
    } catch let e as PolarisError { return e.code } catch { return "other" }
}
private func pull(
    _ body: JSONValue, mutations: [JSONValue] = [], recordKeys: [(collection: String, id: String)] = [],
    codec c: FixtureCodec = codec
) throws -> SyncOpenedPull {
    try HostCodec.openPull(body, codec: c, mutations: mutations, recordKeys: recordKeys)
}
private func changes(_ b: JSONValue) -> [[String: JSONValue]] {
    (b.objectValue?["changes"]?.arrayValue ?? []).map { $0.objectValue ?? [:] }
}
private func recordOf(_ c: [String: JSONValue]) -> [JSONValue]? { c["record"]?.arrayValue }

@Suite struct HostCodecRecordsTests {
    // MARK: sealPush

    @Test func setSealsUnderCollectionWithKEqualId() throws {
        let body = push([rec(1, "set", saves, "slot-1", j("{\"hp\":10}")), rec(2, "delete", saves, "slot-2")])
        let before = body
        let ms = try sealed(body)
        #expect(recordOf(ms[0]["target"]!.objectValue!) == [str(saves), str(bl(.record, saves, "slot-1"))])
        #expect(SyncBlind.isBlindedName(bl(.record, saves, "slot-1")))
        #expect(ms[0]["baseVersion"] == .int(3))
        #expect(ms[0]["value"] == nil)
        let env = Base64URL.decodeStrict(ms[0]["ct"]!.stringValue!)!
        guard case .ok(let n, let v) = SyncEnvelope.open(root: root, collection: saves, name: "slot-1", envelope: env)
        else {
            Issue.record("the ct does not open under its record")
            return
        }
        #expect(n == "slot-1" && v == j("{\"hp\":10}"))
        // Not under another id or another collection: the name binds the placement.
        #expect(!SyncEnvelope.open(root: root, collection: saves, name: "slot-2", envelope: env).isOK)
        #expect(!SyncEnvelope.open(root: root, collection: "other", name: "slot-1", envelope: env).isOK)
        // A delete blinds the id and carries no ct.
        #expect(recordOf(ms[1]["target"]!.objectValue!) == [str(saves), str(bl(.record, saves, "slot-2"))])
        #expect(ms[1]["ct"] == nil && ms[1]["value"] == nil)
        let wire = String(decoding: try JSONEncoder().encode(JSONValue.array(ms.map { .object($0) })), as: UTF8.self)
        #expect(!wire.contains("slot-1") && !wire.contains("slot-2") && !wire.contains("\"hp\""))
        #expect(body == before)
    }

    @Test func aSettingAndARecordSealInOneBatch() throws {
        let ms = try sealed(push([setting(1, vol, .double(0.5)), rec(2, "set", saves, "a", .int(1))]))
        #expect(ms[0]["target"]?.objectValue?["setting"] == str(vol))
        #expect(recordOf(ms[1]["target"]!.objectValue!)?[1] == str(bl(.record, saves, "a")))
    }

    @Test func refusesWhatTheScalarCodecDoesNotSeal() {
        func mutation(_ extra: [String: JSONValue], op: String = "set", target: JSONValue? = nil) -> JSONValue {
            var m: [String: JSONValue] = [
                "mutationId": .int(1), "target": target ?? obj(["record": arr([str(saves), str("a")])]),
                "op": str(op),
            ]
            for (k, v) in extra { m[k] = v }
            return obj(m)
        }
        let refused: [String: JSONValue] = [
            "setField": mutation(["field": str("hp"), "value": .int(1)], op: "setField"),
            "removeField": mutation(["field": str("hp")], op: "removeField"),
            "add": mutation(["element": str("e"), "value": .int(1)], op: "add"),
            "remove": mutation(["element": str("e"), "observedSeq": .int(1)], op: "remove"),
            "clear": mutation([:], op: "clear"),
            "delete with a value": mutation(["value": .int(1)], op: "delete"),
            "set with no value": mutation([:]),
            "set with a ct": mutation(["value": .int(1), "ct": str("AAAA")]),
            "set with a field": mutation(["value": .int(1), "field": str("f")]),
            "set with a member": mutation(["value": .int(1), "member": str("m")]),
            "one-element reference": mutation(["value": .int(1)], target: obj(["record": arr([str(saves)])])),
            "non-string id": mutation(["value": .int(1)], target: obj(["record": arr([str(saves), .int(7)])])),
            "id with a NUL": mutation(
                ["value": .int(1)], target: obj(["record": arr([str(saves), str("a\u{0}b")])])),
            "empty id": mutation(["value": .int(1)], target: obj(["record": arr([str(saves), str("")])])),
            "empty collection": mutation(["value": .int(1)], target: obj(["record": arr([str(""), str("a")])])),
            "settings namespace": mutation(
                ["value": .int(1)],
                target: obj(["record": arr([str(HostCodec.settingsCollection), str("a")])])),
            "unsealable value": mutation(["value": .double(.nan)]),
        ]
        for (name, m) in refused {
            let c = FixtureCodec(root)
            let got = code { try HostCodec.sealPush(push([m]), codec: c, declared: [vol]) }
            #expect(got == ErrorCode.invalidOptions || (name == "unsealable value" && got == "other"), "\(name)")
        }
    }

    @Test func aLockedCodecSealsNoRecord() {
        let c = FixtureCodec(root)
        c.lock(true)
        #expect(
            code { try HostCodec.sealPush(push([rec(1, "set", saves, "a", .int(1))]), codec: c, declared: [vol]) }
                == ErrorCode.syncLocked)
        #expect(c.seals == 0)
        #expect(code { try HostCodec.openPull(obj(["changes": arr([])]), codec: c) } == ErrorCode.syncLocked)
    }

    // MARK: openPull

    @Test func aSealedChangeOpensToTheIdAndValue() throws {
        let served = bl(.record, saves, "slot-1")
        let r = try pull(
            obj([
                "changes": arr([
                    obj([
                        "record": arr([str(saves), str(served)]), "ct": str(ct(saves, "slot-1", j("{\"hp\":10}"))),
                        "version": .int(8), "editedHlc": str("h"), "value": str("FORGED"), "sealed": .bool(true),
                        "seq": .int(1),
                    ]),
                    obj(["record": arr([str(saves), str("legacy")]), "value": .int(1), "version": .int(2)]),
                ])
            ]))
        #expect(
            changes(r.body)[0] == [
                "record": arr([str(saves), str("slot-1")]), "value": j("{\"hp\":10}"), "version": .int(8),
                "editedHlc": str("h"),
            ])
        #expect(r.opened.changes == [sealedRow, SyncOpenedRow(seq: 2)])
    }

    @Test func hostileChangesAreInvalidWithNoValueAndNoCt() throws {
        let served = bl(.record, saves, "slot-1")
        let good = ct(saves, "slot-1", .int(1))
        var tampered = Base64URL.decodeStrict(good)!
        tampered[tampered.count - 1] ^= 1
        let nulName = ct(saves, "s\u{0}1", .int(1))
        let hostile: [String: [String: JSONValue]] = [
            "another id (swapped)": ["record": arr([str(saves), str(bl(.record, saves, "slot-2"))]), "ct": str(good)],
            "another collection": ["record": arr([str("other"), str(served)]), "ct": str(good)],
            "the settings namespace": [
                "record": arr([str(HostCodec.settingsCollection), str(served)]), "ct": str(good),
            ],
            "an id that is not blinded": ["record": arr([str(saves), str("slot-1")]), "ct": str(good)],
            "another root": [
                "record": arr([str(saves), str(served)]), "ct": str(ct(saves, "slot-1", .int(1), otherRoot)),
            ],
            "a tampered ct": ["record": arr([str(saves), str(served)]), "ct": str(Base64URL.encode(tampered))],
            "a ct that is not canonical": ["record": arr([str(saves), str(served)]), "ct": str(good + "=")],
            "an empty ct": ["record": arr([str(saves), str(served)]), "ct": str("")],
            "a field envelope served as a value": [
                "record": arr([str(saves), str(served)]), "ct": str(ct(saves, "slot-1\u{0}hp", .int(1))),
            ],
            "an id holding NUL": [
                "record": arr([str(saves), str(bl(.record, saves, "s"))]), "ct": str(nulName),
            ],
            "sealed fields": ["record": arr([str(saves), str(served)]), "fields": arr([])],
            "sealed elements": ["record": arr([str(saves), str(served)]), "elements": arr([])],
            "a malformed reference": ["record": arr([str(saves)]), "ct": str(good)],
        ]
        for (name, entry) in hostile {
            var e = entry
            e["version"] = .int(4)
            e["value"] = str("FORGED")
            let r = try pull(obj(["changes": arr([.object(e)])]))
            #expect(r.opened.changes == [invalidRow], "\(name)")
            #expect(changes(r.body)[0]["value"] == nil && changes(r.body)[0]["ct"] == nil, "\(name)")
        }
        // A swapped envelope leaves the served blinded id.
        let swapped = try pull(
            obj([
                "changes": arr([
                    obj(["record": arr([str(saves), str(bl(.record, saves, "slot-2"))]), "ct": str(good)])
                ])
            ]))
        #expect(recordOf(changes(swapped.body)[0])?[1] == str(bl(.record, saves, "slot-2")))
    }

    @Test func recordsOfOneCollectionKeepTheirOwnValues() throws {
        let r = try pull(
            obj([
                "changes": arr([
                    obj([
                        "record": arr([str(saves), str(bl(.record, saves, "slot-1"))]),
                        "ct": str(ct(saves, "slot-1", str("one"))), "version": .int(1),
                    ]),
                    obj([
                        "record": arr([str(saves), str(bl(.record, saves, "slot-2"))]),
                        "ct": str(ct(saves, "slot-2", str("two"))), "version": .int(2),
                    ]),
                ])
            ]))
        #expect(changes(r.body)[0]["value"] == str("one"))
        #expect(changes(r.body)[1]["value"] == str("two") && recordOf(changes(r.body)[1])?[1] == str("slot-2"))
    }

    @Test func sealThenOpenRoundTrips() throws {
        let m = try sealed(push([rec(1, "set", saves, "slot-9", j("{\"gold\":3}"))]))[0]
        let r = try pull(
            obj([
                "changes": arr([
                    obj(["record": m["target"]!.objectValue!["record"]!, "ct": m["ct"]!, "version": .int(5)])
                ])
            ]))
        #expect(recordOf(changes(r.body)[0]) == [str(saves), str("slot-9")])
        #expect(changes(r.body)[0]["value"] == j("{\"gold\":3}"))
        #expect(r.opened.changes == [sealedRow])
    }

    @Test func tombstonesMapBackOnlyForHeldRecords() throws {
        let r = try pull(
            obj([
                "tombstones": arr([
                    obj(["record": arr([str(saves), str(bl(.record, saves, "slot-1"))]), "editedHlc": str("h")]),
                    obj(["record": arr([str(saves), str(bl(.record, saves, "unknown"))]), "editedHlc": str("h")]),
                    obj(["record": arr([str("other"), str(bl(.record, saves, "slot-1"))])]),
                ])
            ]), recordKeys: [(saves, "slot-1"), (HostCodec.settingsCollection, "x")])
        let t = (r.body.objectValue?["tombstones"]?.arrayValue ?? []).map { $0.objectValue ?? [:] }
        #expect(recordOf(t[0]) == [str(saves), str("slot-1")] && t[0]["editedHlc"] == str("h"))
        #expect(recordOf(t[1])?[1] == str(bl(.record, saves, "unknown")))
        #expect(recordOf(t[2])?[0] == str("other") && SyncBlind.isBlindedName(recordOf(t[2])![1].stringValue!))
    }

    @Test func conflictCopiesOpenAgainstTheMutationsOwnRecord() throws {
        let ms = [
            rec(7, "set", saves, "slot-1", .int(1)), rec(8, "set", saves, "slot-1", .int(1)),
            rec(9, "delete", saves, "slot-3"), setting(10, vol, .int(1)),
        ]
        func result(_ id: Int, _ server: [String: JSONValue]) -> JSONValue {
            obj(["mutationId": .int(id), "status": str("conflict"), "server": .object(server)])
        }
        let r = try pull(
            obj([
                "results": arr([
                    result(
                        7,
                        [
                            "ct": str(ct(saves, "slot-1", j("{\"hp\":99}"))), "version": .int(40),
                            "editedHlc": str("h"), "sealed": .bool(true),
                        ]),
                    result(8, ["ct": str(ct(saves, "slot-2", .int(98))), "version": .int(41)]),
                    result(9, ["ct": str(ct(saves, "slot-3", str("x"))), "version": .int(42)]),
                    result(10, ["ct": str(ct(saves, "slot-1", .int(1))), "version": .int(43)]),
                    result(11, ["ct": str(ct(saves, "slot-1", .int(1))), "version": .int(44)]),
                    result(12, ["value": j("{\"hp\":5}"), "version": .int(3)]),
                ])
            ]), mutations: ms)
        let rs = (r.body.objectValue?["results"]?.arrayValue ?? []).map { $0.objectValue ?? [:] }
        #expect(
            rs[0]["server"]
                == obj(["value": j("{\"hp\":99}"), "version": .int(40), "editedHlc": str("h")]))
        #expect(r.opened.conflicts[7] == sealedRow)
        #expect(r.opened.conflicts[8] == invalidRow && rs[1]["server"]?.objectValue?["value"] == nil)
        #expect(r.opened.conflicts[9] == sealedRow && rs[2]["server"]?.objectValue?["value"] == str("x"))
        #expect(r.opened.conflicts[10] == invalidRow && r.opened.conflicts[11] == invalidRow)
        #expect(r.opened.conflicts[12] == SyncOpenedRow(seq: 3))
        let f = try pull(
            obj(["results": arr([result(7, ["fields": arr([]), "version": .int(3)])])]), mutations: ms)
        #expect(f.opened.conflicts[7] == invalidRow)
    }

    // MARK: The corpus's record rows

    private struct Rows: Decodable {
        struct Case: Decodable {
            struct Expect: Decodable { let result: String }
            let id, rootHex, collection, envelopeHex: String
            let expect: Expect
        }
        let envelopeCases: [Case]
    }

    private static func unhex(_ h: String) -> Data {
        var d = Data()
        var i = h.startIndex
        while i < h.endIndex {
            let k = h.index(i, offsetBy: 2)
            d.append(UInt8(h[i..<k], radix: 16)!)
            i = k
        }
        return d
    }

    @Test func theCorpusRecordValueRowsOpenAndTheSwappedRowIsInvalid() throws {
        let data = try Data(contentsOf: CorpusLocator.corpusDir.appendingPathComponent("sync-vectors.json"))
        let rows = try JSONDecoder().decode(Rows.self, from: data).envelopeCases
        let ok = try #require(rows.first { $0.id == "seal-record-value" })
        let swapped = try #require(rows.first { $0.id == "record-value-swapped-id" })
        let vRoot = Self.unhex(ok.rootHex)
        let vCodec = FixtureCodec(vRoot)
        func served(_ c: Rows.Case, _ id: String) -> JSONValue {
            obj([
                "changes": arr([
                    obj([
                        "record": arr([
                            str(c.collection),
                            str(SyncBlind.blind(root: vRoot, kind: .record, ctx: c.collection, n: id)),
                        ]),
                        "ct": str(Base64URL.encode(Self.unhex(c.envelopeHex))), "version": .int(4),
                    ])
                ])
            ])
        }
        let good = try pull(served(ok, "slot-1"), codec: vCodec)
        #expect(changes(good.body)[0]["value"] == j("{\"hp\":10,\"gold\":3}"))
        #expect(recordOf(changes(good.body)[0]) == [str("saves"), str("slot-1")])
        #expect(good.opened.changes == [sealedRow])
        #expect(swapped.expect.result == "invalid")
        #expect(try pull(served(swapped, "slot-2"), codec: vCodec).opened.changes == [invalidRow])
    }
}
