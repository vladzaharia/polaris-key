// @pkey-feature packs.type.l10n.table packs.type.data.json packs.type.ml.model packs.handlers
//
// P4-16: the v3 pack-type handlers. The shared cases (`packages/client-core/test/fixtures/
// pack-type-cases.json`, read from the checkout through `#filePath`) run through each handler's
// check and must reach client-core's verdicts; the engine tests drive each type through the
// pipeline against the fake byte server: stage, verify and activate, rollback, uninstall (a
// collected older release), one rejection each, and a game-registered `custom.dialogue`.

import Foundation
import PolarisKeyCore
import PolarisKeyPacks
import XCTest

private enum PackTypeCases {
    static var url: URL {
        var u = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { u.deleteLastPathComponent() }
        return u.appendingPathComponent("packages/client-core/test/fixtures/pack-type-cases.json")
    }

    static func load() throws -> [String: JSONValue] {
        let data = try Data(contentsOf: url)
        return try XCTUnwrap(JSONDecoder().decode(JSONValue.self, from: data).objectValue)
    }
}

/// A case's files, in the listed (index) order.
private func caseFiles(_ c: [String: JSONValue]) -> [(path: String, bytes: [UInt8])] {
    (c["files"]?.arrayValue ?? []).map { f in
        let o = f.objectValue!
        let path = o["path"]!.stringValue!
        if let t = o["text"]?.stringValue { return (path, Array(t.utf8)) }
        return (path, [UInt8](Data(base64Encoded: o["base64"]!.stringValue!)!))
    }
}

private func installedFiles(_ files: [(path: String, bytes: [UInt8])]) -> [InstalledFile] {
    files.map { InstalledFile(path: $0.path, sha256: sha256Of($0.bytes), size: $0.bytes.count, source: MemorySource($0.bytes)) }
}

private let zeroSha = String(repeating: "0", count: 64)

/// A staged pack of these files, under a minimal record of `type` with one variant.
private func staged(
    _ files: [(path: String, bytes: [UInt8])], type: String, variant: [String: String] = [:]
) -> StagedPack {
    let ref: JSONValue = .object([
        "sha256": .string(zeroSha), "bytes": .int(0), "size": .int(0), "codec": .string("none"),
    ])
    let v: JSONValue = .object([
        "variant": .object(variant.mapValues { .string($0) }),
        "payload": .object(["size": .int(0), "sha256": .string(zeroSha)]), "full": ref,
        "files": .object([
            "format": .string("pkey-files/1"), "layout": .string("tree"), "sha256": .string(zeroSha),
            "bytes": .int(0), "size": .int(0), "codec": .string("none"),
        ]),
    ])
    let rec = PackRecordDoc(
        json: .object([
            "kind": .string("pack"), "deliverable": .string("djdl.case"), "version": .string("1.0.0"),
            "seq": .int(1), "issuedAt": .int(1), "type": .string(type), "formatVersion": .int(1),
            "variants": .array([v]),
        ]))!
    return StagedPack(
        packId: "djdl.case", record: rec, variant: rec.variants[0], location: "mem:case",
        files: installedFiles(files), payload: nil)
}

private func reader(_ files: [(path: String, bytes: [UInt8])]) -> PackPayloadReader {
    let fs = installedFiles(files)
    return PackPayloadReader { InstalledPayload(payload: nil, files: fs) }
}

private func probeInstall(_ packId: String = "djdl.case") -> PackInstall {
    PackInstall(
        packId: packId, record: "", recordSha256: zeroSha, version: "1.0.0", seq: 1, type: "x",
        variant: "", layout: "tree", payloadSha256: zeroSha, payloadSize: 0, activation: "hot",
        location: "mem:case", installedAt: 0)
}

private func expected(_ v: JSONValue?) -> (ok: Bool, detail: String?, path: String?) {
    let o = v!.objectValue!
    return (o["ok"] == .bool(true), o["detail"]?.stringValue, o["path"]?.stringValue)
}

private func messageJSON(_ m: L10nMessage) -> JSONValue {
    .object([
        "context": m.context.map { .string($0) } ?? .null, "id": .string(m.id),
        "plural": m.plural.map { .string($0) } ?? .null, "strings": .array(m.strings.map { .string($0) }),
    ])
}

private func tableJSON(_ t: L10nTable) -> JSONValue {
    .object(["path": .string(t.path), "locale": .string(t.locale), "messages": .array(t.messages.map(messageJSON))])
}

private func packErrorOf(_ body: () async throws -> Void) async -> PackError? {
    do {
        try await body()
        return nil
    } catch let e as PackError {
        return e
    } catch {
        XCTFail("not a PackError: \(error)")
        return nil
    }
}

private let typePlans = Locked2(0)

private func typedEngine(
    server: ByteServer, storage: any PackStorage, state: any PackStateStore = memoryPackStateStore(),
    stamp: AppContent?, handlers: [any PackHandler] = [], prefs: VariantPrefs = VariantPrefs()
) -> PackEngine {
    PackEngine(
        PackEngineOptions(
            product: PackFixtures.product, releaseKeys: PackFixtures.releaseKeys,
            productTrust: { PackFixtures.productTrust }, stamp: stamp, prefs: prefs, zstd: LibZstd(),
            patchMethods: ["zstd-patch-from"], memBudget: 1 << 30, strategies: ["delta", "file", "full"],
            storage: storage, state: state, fetchRecord: server.fetchRecord, fetchObject: server.fetchObject,
            entitlements: { nil }, now: { 1_759_400_000 },
            newPlanId: { "tplan-\(typePlans.with { $0 += 1; return $0 })" }, handlers: handlers))
}

final class PackTypeHandlersTests: XCTestCase {
    // ── The shared cases ─────────────────────────────────────────────────────────────────

    func testBcp47Cases() throws {
        let cases = try XCTUnwrap(try PackTypeCases.load()["bcp47"]?.arrayValue)
        XCTAssertGreaterThan(cases.count, 10)
        for c in cases {
            let o = c.objectValue!
            let tag = o["tag"]!.stringValue!
            let got = bcp47Canonical(tag)
            if o["ok"] == .bool(true) {
                XCTAssertEqual(got, o["canonical"]?.stringValue ?? tag, "bcp47 \(tag)")
            } else {
                XCTAssertNil(got, "bcp47 \(tag)")
            }
        }
    }

    func testDataJsonCases() async throws {
        let cases = try XCTUnwrap(try PackTypeCases.load()["dataJson"]?.arrayValue)
        for c in cases {
            let o = c.objectValue!
            let name = o["name"]!.stringValue!
            let max = o["options"]?.objectValue?["maxFileBytes"]?.intValue ?? PACK_TEXT_MAX_FILE_BYTES
            let h = DataJsonHandler(maxFileBytes: max)
            let files = caseFiles(o)
            let r = try await h.check(staged(files, type: "data.json"))
            let want = expected(o["expect"])
            if want.ok {
                XCTAssertNil(r, name)
                try await h.activate(probeInstall(), payload: reader(files))
                let docs = try XCTUnwrap(h.documents("djdl.case"), name)
                var got: [String: JSONValue] = [:]
                for d in docs { got[d.path] = d.value }
                XCTAssertEqual(docs.map(\.path), files.map(\.path), name)
                XCTAssertEqual(JSONValue.object(got), o["expect"]!.objectValue!["documents"]!, name)
            } else {
                XCTAssertEqual(r?.detail, want.detail, name)
                XCTAssertEqual(r?.path, want.path, name)
            }
        }
    }

    func testL10nTableCases() async throws {
        let cases = try XCTUnwrap(try PackTypeCases.load()["l10nTable"]?.arrayValue)
        for c in cases {
            let o = c.objectValue!
            let name = o["name"]!.stringValue!
            let max = o["options"]?.objectValue?["maxFileBytes"]?.intValue ?? PACK_TEXT_MAX_FILE_BYTES
            var variant: [String: String] = [:]
            for (k, v) in o["variant"]?.objectValue ?? [:] { variant[k] = v.stringValue! }
            let h = L10nTableHandler(maxFileBytes: max)
            let files = caseFiles(o)
            let r = try await h.check(staged(files, type: "l10n.table", variant: variant))
            let want = expected(o["expect"])
            if want.ok {
                XCTAssertNil(r, name)
                try await h.activate(probeInstall(), payload: reader(files))
                let tables = try XCTUnwrap(h.tables("djdl.case"), name)
                XCTAssertEqual(JSONValue.array(tables.map(tableJSON)), o["expect"]!.objectValue!["tables"]!, name)
            } else {
                XCTAssertEqual(r?.detail, want.detail, name)
                XCTAssertEqual(r?.path, want.path, name)
            }
        }
    }

    func testMlModelCases() async throws {
        let cases = try XCTUnwrap(try PackTypeCases.load()["mlModel"]?.arrayValue)
        for c in cases {
            let o = c.objectValue!
            let name = o["name"]!.stringValue!
            let opts = o["options"]!.objectValue!
            let lt = o["loadTest"]
            let seen = Locked2<[String]>([])
            let pass = lt == .bool(true)
            let test: (@Sendable (MlModelLoadTest) async throws -> Bool)? =
                lt == .null || lt == nil
                ? nil
                : { @Sendable [seen] m in
                    seen.with { $0.append(m.file.path) }
                    return pass
                }
            let h = try MlModelHandler(
                runtimes: opts["runtimes"]!.arrayValue!.map { $0.stringValue! }, ramBytes: opts["ramBytes"]!.intValue!,
                vramBytes: opts["vramBytes"]?.intValue ?? 0,
                quantizations: opts["quantizations"]?.arrayValue?.map { $0.stringValue! }, loadTest: test)
            let files = caseFiles(o)
            let r = try await h.check(staged(files, type: "ml.model"))
            let want = expected(o["expect"])
            if want.ok {
                XCTAssertNil(r, name)
                try await h.activate(probeInstall(), payload: reader(files))
                XCTAssertEqual(h.model("djdl.case")?.path, o["expect"]!.objectValue!["file"]!.stringValue!, name)
                if test != nil { XCTAssertEqual(seen.with { $0 }, [h.model("djdl.case")!.path], name) }
            } else {
                XCTAssertEqual(r?.detail, want.detail, name)
                XCTAssertEqual(r?.path, want.path, name)
            }
        }
    }

    func testMlModelHandlerValidatesItsOptions() {
        XCTAssertThrowsError(try MlModelHandler(runtimes: [], ramBytes: 1))
        XCTAssertThrowsError(try MlModelHandler(runtimes: ["onnx"], ramBytes: -1))
    }

    func testALoadTestThatThrowsIsARefusal() async throws {
        struct Boom: Error {}
        let h = try MlModelHandler(runtimes: ["onnx"], ramBytes: 10, loadTest: { _ in throw Boom() })
        let files = [
            ("model.json", Array(#"{"runtime":"onnx","file":"m.onnx","memBytes":1}"#.utf8)), ("m.onnx", Array("x".utf8)),
        ]
        let r = try await h.check(staged(files, type: "ml.model"))
        XCTAssertEqual(r, PackCheckRefusal("load-test", path: "m.onnx"))
    }

    // ── Through the engine ───────────────────────────────────────────────────────────────

    private func frTable(_ hello: String) -> [String: Any] {
        ["fr.po": "msgid \"\"\nmsgstr \"Language: fr\\n\"\n\nmsgid \"hello\"\nmsgstr \"\(hello)\"\n"]
    }

    func testL10nTableInstallsActivatesRollsBackAndCollectsAnOldRelease() async throws {
        let packId = "djdl.l10n"
        let rels = [("1.0.0", "Bonjour"), ("1.1.0", "Salut"), ("1.2.0", "Coucou")].enumerated().map { i, r in
            treePack(packId: packId, version: r.0, seq: i + 1, files: frTable(r.1), type: "l10n.table")
        }
        let server = ByteServer(rels[0], rels[1], rels[2])
        let storage = memoryPackStorage()
        let state = memoryPackStateStore()
        let events = Locked2<[String]>([])
        let h = L10nTableHandler(
            onActivate: { _, t in events.with { $0.append("on \(t[0].messages[0].strings[0])") } },
            onDeactivate: { _, t in events.with { $0.append("off \(t.first?.messages[0].strings[0] ?? "-")") } })
        var locations: [String] = []
        for rel in rels.prefix(2) {
            let e = typedEngine(server: server, storage: storage, state: state, stamp: stampFor(rel), handlers: [h])
            _ = try await e.load()
            let i = try await e.ensure([packId])[0]
            locations.append(i.location)
            XCTAssertEqual(h.tables(packId)?[0].messages[0].strings[0], rel.version == "1.0.0" ? "Bonjour" : "Salut")
        }
        // Rollback re-points to the previous release and swaps the tables back.
        var e = typedEngine(server: server, storage: storage, state: state, stamp: stampFor(rels[1]), handlers: [h])
        _ = try await e.load()
        let rolled = try await e.rollback(packId)
        XCTAssertTrue(rolled)
        XCTAssertEqual(h.tables(packId)?[0].messages[0].strings[0], "Bonjour")
        XCTAssertEqual(events.with { $0 }.suffix(2), ["off Salut", "on Bonjour"])
        // Uninstall: a newer release and another make the oldest no root, so it is collected.
        e = typedEngine(server: server, storage: storage, state: state, stamp: stampFor(rels[2]), handlers: [h])
        _ = try await e.load()
        let i3 = try await e.ensure([packId])[0]
        XCTAssertEqual(h.tables(packId)?[0].messages[0].strings[0], "Coucou")
        let s = try await e.state()
        XCTAssertEqual(s.active[packId]?.version, "1.2.0")
        XCTAssertEqual(s.previous[packId]?.version, "1.0.0")
        XCTAssertNotNil(storage.store[i3.location])
        XCTAssertNotNil(storage.store[locations[0]])
        XCTAssertNil(storage.store[locations[1]], "1.1.0 is no GC root any more")
    }

    func testL10nTableWrongLocaleIsRefusedAndNothingStays() async throws {
        let pack = treePack(
            packId: "djdl.fr", version: "1.0.0", seq: 1,
            files: ["de.json": #"{"locale":"de","messages":{"a":"b"}}"#], type: "l10n.table",
            variantExtra: ["variant": .object(["locale": .string("fr")])])
        let storage = memoryPackStorage()
        let h = L10nTableHandler()
        let e = typedEngine(
            server: ByteServer(pack), storage: storage, stamp: stampFor(pack), handlers: [h],
            prefs: VariantPrefs(axes: ["locale": ["fr"]]))
        _ = try await e.load()
        let err = await packErrorOf { _ = try await e.ensure(["djdl.fr"]) }
        XCTAssertEqual(err?.code, ErrorCode.packTypeCheckFailed)
        XCTAssertEqual(err?.detail, "locale")
        XCTAssertEqual(err?.path, "de.json")
        let s = try await e.state()
        XCTAssertNil(s.active["djdl.fr"])
        XCTAssertTrue(s.inflight.isEmpty)
        XCTAssertTrue(storage.store.isEmpty, "the refused location is collected")
        XCTAssertNil(h.tables("djdl.fr"))
    }

    func testDataJsonBuiltInInstallsAndAFormatVersionTooNewIsUnsupported() async throws {
        let ok = treePack(packId: "djdl.events", version: "1.0.0", seq: 1, files: ["e.json": #"{"events":[{"id":"snow"}]}"#], type: "data.json")
        let e = typedEngine(server: ByteServer(ok), storage: memoryPackStorage(), stamp: stampFor(ok))
        _ = try await e.load()
        let i = try await e.ensure(["djdl.events"])[0]
        XCTAssertEqual(i.activation, "hot")
        let running = try await e.state().running["djdl.events"]
        XCTAssertEqual(running?.version, "1.0.0")

        let newer = treePack(
            packId: "djdl.events", version: "2.0.0", seq: 2, files: ["e.json": "{}"], type: "data.json",
            recordExtra: ["formatVersion": .int(2)])
        let e2 = typedEngine(server: ByteServer(newer), storage: memoryPackStorage(), stamp: stampFor(newer))
        _ = try await e2.load()
        let err = await packErrorOf { _ = try await e2.ensure(["djdl.events"]) }
        XCTAssertEqual(err?.code, ErrorCode.packTypeUnsupported)
        // A host that lists v2 holds it.
        let e3 = typedEngine(
            server: ByteServer(newer), storage: memoryPackStorage(), stamp: stampFor(newer),
            handlers: [DataJsonHandler(formatVersions: [1, 2])])
        _ = try await e3.load()
        _ = try await e3.ensure(["djdl.events"])
    }

    func testDataJsonActivatesRollsBackAndRefusesLooseJson() async throws {
        let v1 = treePack(packId: "djdl.bal", version: "1.0.0", seq: 1, files: ["b.json": #"{"hp":1}"#], type: "data.json")
        let v2 = treePack(packId: "djdl.bal", version: "1.1.0", seq: 2, files: ["b.json": #"{"hp":2}"#], type: "data.json")
        let bad = treePack(packId: "djdl.bal", version: "1.2.0", seq: 3, files: ["b.json": #"{"hp":3,}"#], type: "data.json")
        let server = ByteServer(v1, v2, bad)
        let storage = memoryPackStorage()
        let state = memoryPackStateStore()
        let h = DataJsonHandler()
        for rel in [v1, v2] {
            let e = typedEngine(server: server, storage: storage, state: state, stamp: stampFor(rel), handlers: [h])
            _ = try await e.load()
            _ = try await e.ensure(["djdl.bal"])
        }
        XCTAssertEqual(h.documents("djdl.bal")?[0].value, .object(["hp": .int(2)]))
        let e = typedEngine(server: server, storage: storage, state: state, stamp: stampFor(bad), handlers: [h])
        _ = try await e.load()
        let err = await packErrorOf { _ = try await e.ensure(["djdl.bal"]) }
        XCTAssertEqual(err?.code, ErrorCode.packTypeCheckFailed)
        XCTAssertEqual(err?.detail, "json")
        XCTAssertEqual(err?.path, "b.json")
        XCTAssertEqual(h.documents("djdl.bal")?[0].value, .object(["hp": .int(2)]), "the live release keeps running")
        let rolled = try await e.rollback("djdl.bal")
        XCTAssertTrue(rolled)
        XCTAssertEqual(h.documents("djdl.bal")?[0].value, .object(["hp": .int(1)]))
    }

    private func modelPack(_ version: String, _ seq: Int, mem: Int) -> TreePack {
        treePack(
            packId: "djdl.model", version: version, seq: seq,
            files: [
                "model.json": #"{"runtime":"onnx","file":"net.onnx","memBytes":\#(mem)}"#,
                "net.onnx": "ONNX-\(version)",
            ], type: "ml.model")
    }

    func testMlModelNeedsARegisteredHandlerAndSwapsOnlyAfterTheLoadTest() async throws {
        let v1 = modelPack("1.0.0", 1, mem: 100)
        let v2 = modelPack("1.1.0", 2, mem: 200)
        let big = modelPack("1.2.0", 3, mem: 5000)
        let server = ByteServer(v1, v2, big)
        // Not built in: an unregistered ml.model is unsupported.
        let bare = typedEngine(server: server, storage: memoryPackStorage(), stamp: stampFor(v1))
        _ = try await bare.load()
        let none = await packErrorOf { _ = try await bare.ensure(["djdl.model"]) }
        XCTAssertEqual(none?.code, ErrorCode.packTypeUnsupported)

        let tested = Locked2<[String]>([])
        let h = try MlModelHandler(
            runtimes: ["onnx"], ramBytes: 1000,
            loadTest: { m in
                let text = String(decoding: try readAll(m.file.source), as: UTF8.self)
                tested.with { $0.append(text) }
                return true
            })
        let storage = memoryPackStorage()
        let state = memoryPackStateStore()
        for rel in [v1, v2] {
            let e = typedEngine(server: server, storage: storage, state: state, stamp: stampFor(rel), handlers: [h])
            _ = try await e.load()
            _ = try await e.ensure(["djdl.model"])
        }
        XCTAssertEqual(tested.with { $0 }, ["ONNX-1.0.0", "ONNX-1.1.0"])
        XCTAssertEqual(h.model("djdl.model")?.descriptor.memBytes, 200)
        // Above the budget: refused before the load test runs; the live model stays.
        let e = typedEngine(server: server, storage: storage, state: state, stamp: stampFor(big), handlers: [h])
        _ = try await e.load()
        let err = await packErrorOf { _ = try await e.ensure(["djdl.model"]) }
        XCTAssertEqual(err?.code, ErrorCode.packTypeCheckFailed)
        XCTAssertEqual(err?.detail, "memory")
        XCTAssertEqual(err?.path, "model.json")
        XCTAssertEqual(tested.with { $0.count }, 2)
        XCTAssertEqual(h.model("djdl.model")?.descriptor.memBytes, 200)
        let rolled = try await e.rollback("djdl.model")
        XCTAssertTrue(rolled)
        XCTAssertEqual(h.model("djdl.model")?.descriptor.memBytes, 100)
    }

    // ── custom.dialogue: a game-registered handler, end to end ───────────────────────────

    private final class DialogueHandler: PackHandler, Sendable {
        let type = "custom.dialogue"
        let layout = "tree"
        let activation = "hot"
        let events = Locked2<[String]>([])
        func supports(_ formatVersion: Int) -> Bool { formatVersion == 1 }
        func check(_ staged: StagedPack) async throws -> PackCheckRefusal? {
            events.with { $0.append("check \(staged.files.map(\.path).joined(separator: ","))") }
            return staged.file("lines.txt") == nil ? PackCheckRefusal("no-lines", path: "lines.txt") : nil
        }
        func activate(_ install: PackInstall, payload: PackPayloadReader) async throws {
            let files = try payload.read()?.files ?? []
            let lines = try files.first { $0.path == "lines.txt" }.map { String(decoding: try readAll($0.source), as: UTF8.self) }
            events.with { $0.append("on \(lines ?? "-")") }
        }
        func deactivate(_ install: PackInstall) async throws { events.with { $0.append("off \(install.version)") } }
    }

    func testACustomDialoguePackInstallsEndToEndThroughTheGamesHandler() async throws {
        let pack = treePack(
            packId: "djdl.dialogue", version: "1.0.0", seq: 1,
            files: ["lines.txt": "hello", "npc/bob.txt": "hi"], type: "custom.dialogue")
        let h = DialogueHandler()
        let storage = memoryPackStorage()
        // Before registration the type is unsupported.
        let bare = typedEngine(server: ByteServer(pack), storage: storage, stamp: stampFor(pack))
        _ = try await bare.load()
        let none = await packErrorOf { _ = try await bare.ensure(["djdl.dialogue"]) }
        XCTAssertEqual(none?.code, ErrorCode.packTypeUnsupported)
        try bare.registerHandler(h)
        let i = try await bare.ensure(["djdl.dialogue"])[0]
        XCTAssertEqual(i.type, "custom.dialogue")
        XCTAssertEqual(h.events.with { $0 }, ["check lines.txt,npc/bob.txt", "on hello"])

        // The game's check refuses with its own token.
        let missing = treePack(packId: "djdl.dialogue2", version: "1.0.0", seq: 1, files: ["x.txt": "x"], type: "custom.dialogue")
        let e = typedEngine(server: ByteServer(missing), storage: memoryPackStorage(), stamp: stampFor(missing), handlers: [h])
        _ = try await e.load()
        let err = await packErrorOf { _ = try await e.ensure(["djdl.dialogue2"]) }
        XCTAssertEqual(err?.code, ErrorCode.packTypeCheckFailed)
        XCTAssertEqual(err?.detail, "no-lines")
    }

    func testACustomPayloadPassesTheSamePathRulesAsAFilesTree() async throws {
        for path in ["../escape.txt", "a/./b.txt", ".pkey/x", "CON.txt"] {
            for type in ["custom.dialogue", "files.tree"] {
                let pack = treePack(packId: "djdl.unsafe", version: "1.0.0", seq: 1, files: [path: "x"], type: type)
                let h = DialogueHandler()
                let e = typedEngine(server: ByteServer(pack), storage: memoryPackStorage(), stamp: stampFor(pack), handlers: [h])
                _ = try await e.load()
                let err = await packErrorOf { _ = try await e.ensure(["djdl.unsafe"]) }
                XCTAssertEqual(err?.code, ErrorCode.filesUnsafePath, "\(type) \(path)")
                XCTAssertTrue(h.events.with { $0 }.isEmpty, "\(type) \(path): nothing reached the handler")
            }
        }
    }

    private struct OddHandler: PackHandler {
        let type = "custom.odd"
        let layout = "tree"
        let activation = "hot"
        let mode: String
        func supports(_ formatVersion: Int) -> Bool { true }
        func check(_ staged: StagedPack) async throws -> PackCheckRefusal? {
            struct Boom: Error {}
            if mode == "throw" { throw Boom() }
            return PackCheckRefusal("Not A Token", path: "a.txt")
        }
    }

    func testAThrowingCheckOrAnOffVocabularyDetailReadsAsCheck() async throws {
        for mode in ["throw", "token"] {
            let pack = treePack(packId: "djdl.odd", version: "1.0.0", seq: 1, files: ["a.txt": "a"], type: "custom.odd")
            let storage = memoryPackStorage()
            let e = typedEngine(server: ByteServer(pack), storage: storage, stamp: stampFor(pack), handlers: [OddHandler(mode: mode)])
            _ = try await e.load()
            let err = await packErrorOf { _ = try await e.ensure(["djdl.odd"]) }
            XCTAssertEqual(err?.code, ErrorCode.packTypeCheckFailed, mode)
            XCTAssertEqual(err?.detail, "check", mode)
            XCTAssertTrue(storage.store.isEmpty, mode)
        }
    }
}
