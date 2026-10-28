// @pkey-feature sync.e2e
// The host codec boundary (U-07.5; WIRE-CONTRACT-V5 §13.10, §13.10.7): what `sealPush` sends, what
// `openPull` proves, and that the machine only ever takes the host's own open result. The cases are
// client-core's `hostCodec.test.ts`; the machine half (`openPull` into `receive`) belongs to the
// host slice, which has the machine. HC-1 to HC-6 each name their test below.

import Foundation
import Testing

@testable import PolarisKey
@testable import PolarisKeyCore

/// A codec over a fixture root, with a switch for "locked" and a count of seals.
final class FixtureCodec: SyncCodecPort, @unchecked Sendable {
    let root: Data
    private let lock = NSLock()
    private var isLocked = false
    private var sealCount = 0
    init(_ root: Data) { self.root = root }
    var locked: Bool { lock.withLock { isLocked } }
    var seals: Int { lock.withLock { sealCount } }
    func lock(_ on: Bool) { lock.withLock { isLocked = on } }
    func seal(collection: String, name: String, value: JSONValue) throws -> Data {
        lock.withLock { sealCount += 1 }
        return try SyncEnvelope.seal(root: root, collection: collection, name: name, value: value)
    }
    func open(collection: String, name: String, envelope: Data, aliases: [String]) throws -> SyncEnvelope.Opened {
        SyncEnvelope.open(root: root, collection: collection, name: name, envelope: envelope, aliases: aliases)
    }
    func openAny(collection: String, envelope: Data) throws -> SyncEnvelope.Opened {
        SyncEnvelope.openAnyName(root: root, collection: collection, envelope: envelope)
    }
    func blind(kind: SyncBlind.Kind, ctx: String, name: String) throws -> String {
        SyncBlind.blind(root: root, kind: kind, ctx: ctx, n: name)
    }
}

private let root = Data((0..<32).map { UInt8(truncatingIfNeeded: 3 * $0 + 7) })
private let otherRoot = Data((0..<32).map { UInt8(truncatingIfNeeded: 250 - 5 * $0) })
private let VOL = "audio.volume"
private let BIND = "input.bindings"
private let OPEN = "my.private.key"
private let declared = [VOL, BIND]
private let C = HostCodec.settingsCollection

private func j(_ s: String) -> JSONValue {
    try! JSONDecoder().decode(JSONValue.self, from: Data(s.utf8))
}
private func str(_ s: String) -> JSONValue { .string(s) }
private func obj(_ o: [String: JSONValue]) -> JSONValue { .object(o) }
private func sealedCt(_ name: String, _ v: JSONValue, _ r: Data = root) -> String {
    Base64URL.encode(try! SyncEnvelope.seal(root: r, collection: C, name: name, value: v))
}
private func bl(_ kind: SyncBlind.Kind, _ ctx: String, _ n: String) -> String {
    SyncBlind.blind(root: root, kind: kind, ctx: ctx, n: n)
}
private func push(_ mutations: [JSONValue]) -> JSONValue {
    obj(["clientId": str("c_x"), "cursor": .int(0), "atomic": .bool(false), "mutations": .array(mutations)])
}
private func set(_ id: Int, _ setting: String, _ value: JSONValue) -> JSONValue {
    obj([
        "mutationId": .int(id), "target": obj(["setting": str(setting), "scope": str("user")]),
        "op": str("set"), "value": value,
    ])
}
private func mutationOf(_ id: Int, _ setting: String) -> JSONValue { set(id, setting, .int(1)) }
private func changes(_ b: JSONValue) -> [[String: JSONValue]] {
    (b.objectValue?["changes"]?.arrayValue ?? []).map { $0.objectValue ?? [:] }
}
private func results(_ b: JSONValue) -> [[String: JSONValue]] {
    (b.objectValue?["results"]?.arrayValue ?? []).map { $0.objectValue ?? [:] }
}
private let codec = FixtureCodec(root)
private let sealedRow = SyncOpenedRow(sealed: true)
private let invalidRow = SyncOpenedRow(invalid: true)

private func pull(
    _ body: JSONValue, mutations: [JSONValue] = [], aliases: [String: String] = [:], openKeys: [String] = [],
    codec c: FixtureCodec = codec
) throws -> SyncOpenedPull {
    try HostCodec.openPull(body, codec: c, mutations: mutations, aliases: aliases, openKeys: openKeys)
}

@Suite struct HostCodecTests {
    @Test func syncCodecIsThePort() {
        let _: any SyncCodecPort.Type = SyncCodec.self
    }

    // MARK: sealPush

    @Test func sealsDeclaredBlindsOpenAndMemberAndSendsNoPlaintext() throws {
        let body = push([
            set(1, VOL, .double(0.5)), set(2, OPEN, str("secret-value")),
            obj([
                "mutationId": .int(3), "target": obj(["setting": str(BIND), "scope": str("user")]),
                "op": str("setMember"), "member": str("jump"), "value": str("space"),
            ]),
            obj([
                "mutationId": .int(4), "target": obj(["setting": str(BIND), "scope": str("user")]),
                "op": str("removeMember"), "member": str("run"),
            ]),
            obj(["mutationId": .int(5), "target": obj(["setting": str(VOL), "scope": str("user")]), "op": str("clear")]),
        ])
        let out = try HostCodec.sealPush(body, codec: codec, declared: declared)
        let ms = (out.objectValue?["mutations"]?.arrayValue ?? []).map { $0.objectValue ?? [:] }
        func target(_ m: [String: JSONValue]) -> String? { m["target"]?.objectValue?["setting"]?.stringValue }
        func open(_ m: [String: JSONValue], _ name: String) -> SyncEnvelope.Opened {
            SyncEnvelope.open(
                root: root, collection: C, name: name, envelope: Base64URL.decodeStrict(m["ct"]!.stringValue!)!)
        }
        #expect(target(ms[0]) == VOL)
        #expect(ms[0]["value"] == nil)
        guard case .ok(let n0, let v0) = open(ms[0], VOL) else { Issue.record("a"); return }
        #expect(n0 == VOL && v0 == .double(0.5))
        #expect(target(ms[1]) == bl(.setting, C, OPEN))
        #expect(SyncBlind.isBlindedName(target(ms[1])!))
        guard case .ok(_, let v1) = open(ms[1], OPEN) else { Issue.record("b"); return }
        #expect(v1 == str("secret-value"))
        #expect(target(ms[2]) == BIND)
        #expect(ms[2]["member"] == str(bl(.member, BIND, "jump")))
        guard case .ok(let n2, let v2) = open(ms[2], HostCodec.memberEnvelopeName(BIND, "jump")) else {
            Issue.record("c"); return
        }
        #expect(n2 == "\(BIND)\u{0}jump" && v2 == str("space"))
        #expect(ms[3]["member"] == str(bl(.member, BIND, "run")))
        #expect(ms[3]["ct"] == nil)
        #expect(
            ms[4]
                == ["mutationId": .int(5), "target": obj(["setting": str(VOL), "scope": str("user")]), "op": str("clear")])
        let wire = String(decoding: try JSONEncoder().encode(out), as: UTF8.self)
        for plain in ["secret-value", "space", OPEN, "\"jump\"", "\"run\""] { #expect(!wire.contains(plain)) }
    }

    @Test func sealPushLeavesTheBodyAlone() throws {
        let body = push([set(1, VOL, .double(0.5))])
        _ = try HostCodec.sealPush(body, codec: codec, declared: declared)
        #expect(body == push([set(1, VOL, .double(0.5))]))
    }

    // HC-6
    @Test func hc6LockedCodecRefusesAndSealsNothing() {
        let c = FixtureCodec(root)
        c.lock(true)
        #expect(throws: PolarisError.self) {
            try HostCodec.sealPush(push([set(1, VOL, .int(1))]), codec: c, declared: declared)
        }
        do { _ = try HostCodec.sealPush(push([set(1, VOL, .int(1))]), codec: c, declared: declared) } catch let e as PolarisError {
            #expect(e.code == ErrorCode.syncLocked)
        } catch { Issue.record("not a PolarisError") }
        #expect(c.seals == 0)
        do { _ = try HostCodec.openPull(obj(["changes": .array([])]), codec: c) } catch let e as PolarisError {
            #expect(e.code == ErrorCode.syncLocked)
        } catch { Issue.record("not a PolarisError") }
    }

    // HC-6: a seal failure sends nothing, and a half-valid batch returns nothing.
    @Test func hc6RefusesRecordMutationHalfValidBatchAndUnsealableValue() {
        func code(_ f: () throws -> JSONValue) -> String? {
            do { _ = try f(); return nil } catch let e as PolarisError { return e.code } catch { return "other" }
        }
        let record = obj([
            "mutationId": .int(2), "target": obj(["record": .array([str("slots"), str("a")])]), "op": str("set"),
            "value": .int(1),
        ])
        let c = FixtureCodec(root)
        #expect(
            code { try HostCodec.sealPush(push([set(1, VOL, .int(1)), record]), codec: c, declared: declared) }
                == ErrorCode.invalidOptions)
        // The valid mutation before it is not returned: the call threw.
        #expect(code { try HostCodec.sealPush(push([set(1, VOL, .double(.nan))]), codec: c, declared: declared) } == "other")
    }

    @Test func refusesAMemberOpOnAnOpenKey() {
        let m = obj([
            "mutationId": .int(1), "target": obj(["setting": str(OPEN), "scope": str("user")]),
            "op": str("setMember"), "member": str("m"), "value": .int(1),
        ])
        #expect(throws: PolarisError.self) { try HostCodec.sealPush(push([m]), codec: codec, declared: declared) }
    }

    @Test func sealPushRoundTripsThroughOpenPull() throws {
        let out = try HostCodec.sealPush(push([set(1, OPEN, j("{\"a\":1}"))]), codec: codec, declared: declared)
        let m = (out.objectValue?["mutations"]?.arrayValue?[0].objectValue)!
        let r = try pull(
            obj([
                "changes": .array([
                    obj([
                        "setting": m["target"]!.objectValue!["setting"]!, "scope": str("user"), "ct": m["ct"]!,
                        "version": .int(4),
                    ])
                ])
            ]))
        #expect(changes(r.body)[0]["setting"] == str(OPEN))
        #expect(changes(r.body)[0]["value"] == j("{\"a\":1}"))
        #expect(r.opened.changes == [sealedRow])
    }

    // MARK: openPull

    @Test func opensDeclaredTakesSeqFromVersionOnPlaintextRowsAndStripsCt() throws {
        let r = try pull(
            obj([
                "changes": .array([
                    obj([
                        "setting": str(VOL), "scope": str("user"), "ct": str(sealedCt(VOL, .double(0.3))),
                        "version": .int(9), "editedHlc": str("h"),
                    ]),
                    obj(["setting": str("legacy"), "scope": str("user"), "value": .int(1), "version": .int(2)]),
                ])
            ]))
        #expect(
            changes(r.body)[0]
                == [
                    "setting": str(VOL), "scope": str("user"), "value": .double(0.3), "version": .int(9),
                    "editedHlc": str("h"),
                ])
        #expect(
            changes(r.body)[1]
                == ["setting": str("legacy"), "scope": str("user"), "value": .int(1), "version": .int(2)])
        #expect(r.opened.changes == [sealedRow, SyncOpenedRow(seq: 2)])
    }

    // HC-2
    @Test func hc2StripsSealedInvalidAndSeqTheBodyClaims() throws {
        let r = try pull(
            obj([
                "sealed": .bool(true),
                "changes": .array([
                    obj([
                        "setting": str("p"), "scope": str("user"), "value": .int(666), "version": .int(50),
                        "sealed": .bool(true), "invalid": .bool(false), "seq": .int(1),
                    ])
                ]),
                "results": .array([
                    obj(["mutationId": .int(1), "status": str("ok"), "version": .int(1), "sealed": .bool(true), "seq": .int(1)])
                ]),
            ]))
        #expect(r.body.objectValue?["sealed"] == nil)
        #expect(
            changes(r.body)[0]
                == ["setting": str("p"), "scope": str("user"), "value": .int(666), "version": .int(50)])
        #expect(results(r.body)[0] == ["mutationId": .int(1), "status": str("ok"), "version": .int(1)])
        #expect(r.opened.changes == [SyncOpenedRow(seq: 50)])
    }

    // HC-5
    @Test func hc5UnopenableCtIsInvalidWithNoValue() throws {
        let good = sealedCt(VOL, .int(1))
        var tampered = Base64URL.decodeStrict(good)!
        tampered[tampered.count - 1] ^= 1
        let cases = [
            sealedCt(VOL, .int(1), otherRoot), Base64URL.encode(tampered), sealedCt("other.key", .int(1)),
            "not base64 !", good + "=", "",
        ]
        for ct in cases {
            let r = try pull(
                obj([
                    "changes": .array([
                        obj([
                            "setting": str(VOL), "scope": str("user"), "ct": str(ct), "value": .int(7), "version": .int(3),
                        ])
                    ])
                ]))
            #expect(changes(r.body)[0]["value"] == nil)
            #expect(changes(r.body)[0]["ct"] == nil)
            #expect(r.opened.changes == [invalidRow])
        }
    }

    // HC-5
    @Test func hc5BlindedNameAcceptedOnlyWhenOpenedKeyReblindsToIt() throws {
        let honest = bl(.setting, C, OPEN)
        let ct = sealedCt(OPEN, str("v"))
        func change(_ name: String, extra: [String: JSONValue]) -> JSONValue {
            obj(["changes": .array([obj(["setting": str(name), "scope": str("user"), "version": .int(1)].merging(extra) { $1 })])])
        }
        let ok = try pull(change(honest, extra: ["ct": str(ct)]))
        #expect(changes(ok.body)[0]["setting"] == str(OPEN))
        let other = bl(.setting, C, "another.key")
        let moved = try pull(change(other, extra: ["ct": str(ct)]))
        #expect(changes(moved.body)[0]["setting"] == str(other))
        #expect(changes(moved.body)[0]["value"] == nil)
        #expect(moved.opened.changes == [invalidRow])
        let bare = try pull(change(honest, extra: ["value": .int(1)]))
        #expect(bare.opened.changes == [SyncOpenedRow(seq: 1)])
    }

    @Test func opensMergeMembersIntoOneValueAndChecksEachBlindedMember() throws {
        func mk(_ member: String, _ v: JSONValue) -> JSONValue {
            obj([
                "member": str(bl(.member, BIND, member)),
                "ct": str(sealedCt(HostCodec.memberEnvelopeName(BIND, member), v)), "editedHlc": str("h"),
            ])
        }
        func body(_ members: [JSONValue]) -> JSONValue {
            obj(["changes": .array([obj(["setting": str(BIND), "scope": str("user"), "members": .array(members), "version": .int(5)])])])
        }
        let members = [mk("jump", str("space")), mk("run", str("shift"))]
        let r = try pull(body(members))
        #expect(changes(r.body)[0]["value"] == j("{\"jump\":\"space\",\"run\":\"shift\"}"))
        #expect(changes(r.body)[0]["members"] == nil)
        #expect(r.opened.changes == [sealedRow])
        // a member moved under another member's blinded name
        var a = members[0].objectValue!
        a["member"] = members[1].objectValue!["member"]
        #expect(try pull(body([.object(a), members[1]])).opened.changes == [invalidRow])
        // a member of another merge setting (the D-2 name binds the setting)
        let foreign = obj([
            "member": str(bl(.member, BIND, "jump")),
            "ct": str(sealedCt(HostCodec.memberEnvelopeName("other.merge", "jump"), .int(1))),
        ])
        #expect(try pull(body([foreign])).opened.changes == [invalidRow])
        // the same member twice
        #expect(try pull(body([members[0], members[0]])).opened.changes == [invalidRow])
    }

    // HC-1
    @Test func hc1ConflictCopyOpensOnlyForAMutationOfTheRequest() throws {
        let ms = [mutationOf(7, VOL), mutationOf(8, OPEN)]
        let r = try pull(
            obj([
                "results": .array([
                    obj([
                        "mutationId": .int(7), "status": str("conflict"),
                        "server": obj(["ct": str(sealedCt(VOL, .double(0.9))), "version": .int(40), "sealed": .bool(true)]),
                    ]),
                    obj([
                        "mutationId": .int(8), "status": str("conflict"),
                        "server": obj(["ct": str(sealedCt("wrong.name", .int(1))), "version": .int(41)]),
                    ]),
                    obj([
                        "mutationId": .int(9), "status": str("conflict"),
                        "server": obj(["ct": str(sealedCt(VOL, .int(1))), "version": .int(42)]),
                    ]),
                    obj([
                        "mutationId": .int(10), "status": str("conflict"),
                        "server": obj(["value": .int(3), "version": .int(3), "seq": .int(0)]),
                    ]),
                ])
            ]), mutations: ms)
        #expect(results(r.body)[0]["server"] == obj(["value": .double(0.9), "version": .int(40)]))
        #expect(r.opened.conflicts == [7: sealedRow, 8: invalidRow, 9: invalidRow, 10: SyncOpenedRow(seq: 3)])
    }

    @Test func mapsTombstonesOfKnownOpenKeysBackToTheirNames() throws {
        let r = try pull(
            obj([
                "tombstones": .array([
                    obj(["setting": str(bl(.setting, C, OPEN)), "editedHlc": str("h")]),
                    obj(["setting": str(VOL), "editedHlc": str("h")]),
                ])
            ]), openKeys: [OPEN])
        let names = (r.body.objectValue?["tombstones"]?.arrayValue ?? []).map { $0.objectValue?["setting"] }
        #expect(names == [str(OPEN), str(VOL)])
    }

    // HC-3
    @Test func hc3RenamesComeFromTheAppNeverTheServedBody() throws {
        let ct = sealedCt("old.name", .int(1))
        let served = obj([
            "changes": .array([obj(["setting": str("new.name"), "scope": str("user"), "ct": str(ct), "version": .int(1)])]),
            "aliases": obj(["old.name": str("new.name")]),
        ])
        #expect(try pull(served).opened.changes == [invalidRow])
        #expect(try pull(served, aliases: ["old.name": "new.name"]).opened.changes == [sealedRow])
    }

    // HC-3 (SEC-SYNC-HOST 3)
    @Test func hc3ServesNoAliasOrRenameTheAppDidNotDeclare() throws {
        let ms = [mutationOf(1, "old.k"), mutationOf(2, "x.k")]
        let body = obj([
            "aliases": obj(["foo": str("bar")]),
            "results": .array([
                obj(["mutationId": .int(1), "status": str("ok"), "version": .int(1), "renamedTo": str("new.k")]),
                obj(["mutationId": .int(2), "status": str("ok"), "version": .int(2), "renamedTo": str("evil")]),
            ]),
        ])
        let r = try pull(body, mutations: ms, aliases: ["old.k": "new.k"])
        #expect(r.body.objectValue?["aliases"] == obj(["old.k": str("new.k")]))
        #expect(results(r.body)[0]["renamedTo"] == str("new.k"))
        #expect(results(r.body)[1]["renamedTo"] == nil)
        #expect(try pull(body).body.objectValue?["aliases"] == obj([:]))
    }

    // HC-1 (SEC-SYNC-HOST 1)
    @Test func hc1RepeatedMutationIdFailsTheWholeAnswerClosed() throws {
        let ms = [mutationOf(1, VOL)]
        func conflict(_ id: JSONValue, _ server: JSONValue) -> JSONValue {
            obj(["mutationId": id, "status": str("conflict"), "server": server])
        }
        let forged = obj(["value": str("FORGED"), "version": .int(90)])
        let real = obj(["ct": str(sealedCt(VOL, .double(0.9))), "version": .int(91)])
        for (a, b) in [(JSONValue.int(1), JSONValue.int(1)), (.int(1), .double(1.0))] {
            do {
                _ = try pull(obj(["results": .array([conflict(a, forged), conflict(b, real)])]), mutations: ms)
                Issue.record("repeated id accepted")
            } catch let e as PolarisError { #expect(e.code == ErrorCode.syncFailed) }
        }
        // 1 and true are different ids.
        _ = try pull(obj(["results": .array([conflict(.int(1), forged), conflict(.bool(true), real)])]), mutations: ms)
    }

    // HC-4 (SEC-SYNC-HOST 9)
    @Test func hc4RefusesU0000InASettingOrMemberNameOnPushAndPull() throws {
        func code(_ f: () throws -> JSONValue) -> String? {
            do { _ = try f(); return nil } catch let e as PolarisError { return e.code } catch { return "other" }
        }
        #expect(
            code { try HostCodec.sealPush(push([set(1, "a\u{0}b", .int(1))]), codec: codec, declared: declared) }
                == ErrorCode.invalidOptions)
        // A NUL followed by a combining mark is one Character: still refused.
        #expect(
            code { try HostCodec.sealPush(push([set(1, "a\u{0}\u{301}b", .int(1))]), codec: codec, declared: declared) }
                == ErrorCode.invalidOptions)
        let setMember = obj([
            "mutationId": .int(1), "target": obj(["setting": str(BIND), "scope": str("user")]),
            "op": str("setMember"), "member": str("j\u{0}k"), "value": .int(1),
        ])
        #expect(code { try HostCodec.sealPush(push([setMember]), codec: codec, declared: declared) } == ErrorCode.invalidOptions)
        // An open key sealed with a NUL by a hostile peer.
        let nul = "a\u{0}b"
        let r = try pull(
            obj([
                "changes": .array([
                    obj([
                        "setting": str(bl(.setting, C, nul)), "scope": str("user"), "ct": str(sealedCt(nul, .int(1))),
                        "version": .int(1),
                    ])
                ])
            ]))
        #expect(r.opened.changes == [invalidRow])
        // A member name with a NUL, sealed under the setting prefix.
        let member = "j\u{0}k"
        let mr = try pull(
            obj([
                "changes": .array([
                    obj([
                        "setting": str(BIND), "scope": str("user"),
                        "members": .array([
                            obj([
                                "member": str(bl(.member, BIND, member)),
                                "ct": str(sealedCt(HostCodec.memberEnvelopeName(BIND, member), .int(1))),
                            ])
                        ]),
                        "version": .int(1),
                    ])
                ])
            ]))
        #expect(mr.opened.changes == [invalidRow])
    }

    @Test func aRecordChangeWithCtReadsAsInvalidAndAPlainOneIsLegacy() throws {
        let r = try pull(
            obj([
                "changes": .array([
                    obj(["record": .array([str("slots"), str("a")]), "ct": str("AAAA"), "version": .int(1)]),
                    obj(["record": .array([str("slots"), str("b")]), "version": .int(2)]),
                    .int(3),
                ])
            ]))
        #expect(r.opened.changes == [invalidRow, SyncOpenedRow(seq: 2), nil])
    }

    // MARK: Member envelope names (the corpus's envelopeCases)

    private struct VectorFile: Decodable {
        struct Case: Decodable {
            struct Expect: Decodable { let result: String; let name: String?; let reason: String? }
            let id, rootHex, name, envelopeHex: String
            let expect: Expect
        }
        let envelopeCases: [Case]
    }

    private static func vector(_ id: String) throws -> VectorFile.Case {
        let data = try Data(contentsOf: CorpusLocator.corpusDir.appendingPathComponent("sync-vectors.json"))
        let all = try JSONDecoder().decode(VectorFile.self, from: data).envelopeCases
        return try #require(all.first { $0.id == id })
    }

    private static func unhex(_ h: String) -> Data {
        var d = Data()
        var i = h.startIndex
        while i < h.endIndex {
            let j = h.index(i, offsetBy: 2)
            d.append(UInt8(h[i..<j], radix: 16)!)
            i = j
        }
        return d
    }

    private func served(_ c: VectorFile.Case, _ setting: String, _ member: String) -> JSONValue {
        let vRoot = Self.unhex(c.rootHex)
        return obj([
            "changes": .array([
                obj([
                    "setting": str(setting), "scope": str("user"), "version": .int(4),
                    "members": .array([
                        obj([
                            "member": str(SyncBlind.blind(root: vRoot, kind: .member, ctx: setting, n: member)),
                            "ct": str(Base64URL.encode(Self.unhex(c.envelopeHex))),
                            "editedHlc": str("0199c82cc000:0000"),
                        ])
                    ]),
                ])
            ])
        ])
    }

    @Test func memberEnvelopeNamesFollowTheCorpusRows() throws {
        let seal = try Self.vector("seal-member")
        #expect(HostCodec.memberEnvelopeName("inventory", "gold") == seal.name)
        #expect(seal.name == "inventory\u{0}gold")
        let vCodec = FixtureCodec(Self.unhex(seal.rootHex))
        let ok = try pull(served(seal, "inventory", "gold"), codec: vCodec)
        #expect(changes(ok.body)[0]["value"] == j("{\"gold\":3}"))
        #expect(ok.opened.changes == [sealedRow])

        let swapped = try Self.vector("member-swapped")
        #expect(swapped.expect.reason == "name")
        #expect(try pull(served(swapped, "inventory", "silver"), codec: vCodec).opened.changes == [invalidRow])

        let wrong = try Self.vector("member-wrong-setting")
        #expect(wrong.expect.reason == "name")
        #expect(try pull(served(wrong, "equipment", "gold"), codec: vCodec).opened.changes == [invalidRow])

        let bare = try Self.vector("member-name-only")
        #expect(bare.name == "gold")
        guard case .invalid(.name) = SyncEnvelope.open(
            root: Self.unhex(bare.rootHex), collection: C, name: bare.name, envelope: Self.unhex(bare.envelopeHex))
        else { Issue.record("bare member name opened"); return }
    }
}
