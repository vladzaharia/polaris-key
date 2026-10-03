// @pkey-feature packs.provides
//
// Unit proofs for save compatibility on the device (P4-20, CONTENT §6.7 item 8), ported from
// client-core's `test/packsProvides.test.ts` case for case: `providesOf`, the reader of a pack
// record's reserved record-level `provides`, and the engine's `isAvailable` (the active set) and
// `packFor` (the target set).

import Foundation
import PolarisKeyCore
import PolarisKeyPacks
import XCTest

private let providesPlans = Locked2(0)

private func engine(
    server: ByteServer, storage: any PackStorage = memoryPackStorage(), stamp: AppContent?,
    entitlements: @escaping @Sendable () async -> Set<String>? = { nil }
) -> PackEngine {
    PackEngine(
        PackEngineOptions(
            product: PackFixtures.product, releaseKeys: PackFixtures.releaseKeys,
            productTrust: { PackFixtures.productTrust }, stamp: stamp, zstd: LibZstd(),
            patchMethods: ["zstd-patch-from"], memBudget: 1 << 30, storage: storage,
            state: memoryPackStateStore(), fetchRecord: server.fetchRecord, fetchObject: server.fetchObject,
            entitlements: entitlements, now: { 1_759_400_000 },
            newPlanId: { "plan-\(providesPlans.with { $0 += 1; return $0 })" }))
}

private func strings(_ ids: [String]) -> JSONValue { .array(ids.map { .string($0) }) }

private func pack(_ packId: String, _ provides: JSONValue?, entitlement: String? = nil) -> TreePack {
    treePack(
        packId: packId, version: "1.0.0", seq: 1, files: ["\(packId).txt": packId], entitlement: entitlement,
        recordExtra: provides.map { ["provides": $0] } ?? [:])
}

private func target(_ p: TreePack) -> PackTarget {
    PackTarget(pack: p.packId, release: ReleasePin(sha256: p.recordSha256, seq: p.seq, version: p.version))
}

private func provider(_ p: TreePack) -> PackProvider {
    PackProvider(packId: p.packId, release: target(p).release)
}

final class PackProvidesTests: XCTestCase {
    // ── providesOf ───────────────────────────────────────────────────────────────────────────

    func testProvidesOfReadsAWellFormedList() {
        XCTAssertEqual(
            providesOf(.object(["provides": strings(["foe.goblin", "item.sword"])])), ["foe.goblin", "item.sword"])
        XCTAssertEqual(providesOf(.object(["provides": .array([])])), [])
    }

    func testProvidesOfReadsAbsentAsNothingProvided() {
        XCTAssertEqual(providesOf(.object([:])), [])
        XCTAssertEqual(providesOf(.null), [])
        XCTAssertEqual(providesOf(nil), [])
        XCTAssertEqual(providesOf(.array([])), [])
    }

    func testProvidesOfReadsAnUnusableListAsNothingProvided() {
        let unusable: [JSONValue] = [
            .string("foe.goblin"),
            .object(["foe.goblin": .bool(true)]),
            strings(["foe.goblin", "foe.goblin"]),
            strings(["foe goblin"]),
            strings([""]),
            strings([String(repeating: "x", count: 129)]),
            strings(["é"]),
            .array([.int(7)]),
            strings((0...maxProvides).map { "id.\($0)" }),
        ]
        for provides in unusable {
            XCTAssertEqual(providesOf(.object(["provides": provides])), [], "\(provides)")
        }
        XCTAssertEqual(
            providesOf(.object(["provides": strings((0..<maxProvides).map { "id.\($0)" })])).count, maxProvides)
        XCTAssertTrue(isContentId(String(repeating: "x", count: 128)))
        XCTAssertTrue(isContentId("~!res://a/b#c"))
        XCTAssertFalse(isContentId("a\u{7F}"))
        XCTAssertFalse(isContentId("tab\there"))
    }

    // ── isAvailable and packFor ──────────────────────────────────────────────────────────────

    func testAnswersFromAnInstalledAndActivePack() async throws {
        let foes = pack("djdl.foes", strings(["foe.goblin", "foe.orc"]))
        let server = ByteServer(foes)
        let e = engine(server: server, stamp: stampFor(foes))
        _ = try await e.load()
        var available = try await e.isAvailable("foe.goblin")
        XCTAssertFalse(available)
        _ = try await e.ensure(["djdl.foes"])
        available = try await e.isAvailable("foe.goblin")
        XCTAssertTrue(available)
        available = try await e.isAvailable("foe.dragon")
        XCTAssertFalse(available)
        let p = try await e.packFor("foe.orc")
        XCTAssertEqual(p, provider(foes))
    }

    func testNamesAPackOnlyTheTargetSetProvidesWithoutInstallingIt() async throws {
        let l10n = pack("djdl.l10n", strings(["l10n.en"]))
        let foes = pack("djdl.foes", strings(["foe.goblin"]))
        let server = ByteServer(l10n, foes)
        let e = engine(server: server, stamp: stampFor(l10n, foes))
        _ = try await e.load()
        _ = try await e.ensure(["djdl.l10n"])
        let before = server.calls.count
        var available = try await e.isAvailable("foe.goblin")
        XCTAssertFalse(available)
        let p = try await e.packFor("foe.goblin")
        XCTAssertEqual(p, provider(foes))
        // Only the record was read: no object was fetched and nothing was installed.
        XCTAssertEqual(server.calls.count, before)
        let state = try await e.state()
        XCTAssertNil(state.active["djdl.foes"])
        available = try await e.isAvailable("foe.goblin")
        XCTAssertFalse(available)
    }

    func testTakesAPacksDecisionsTargetsInsteadOfTheStampsPins() async throws {
        let v1 = pack("djdl.events", strings(["event.halloween"]))
        let v2 = treePack(
            packId: "djdl.events", version: "1.1.0", seq: 2, files: ["e.txt": "e2"],
            recordExtra: ["provides": strings(["event.halloween", "event.winter"])])
        let server = ByteServer(v1, v2)
        let e = engine(server: server, stamp: stampFor(v1))
        _ = try await e.load()
        var p = try await e.packFor("event.winter")
        XCTAssertNil(p)
        p = try await e.packFor("event.winter", targets: [target(v2)])
        XCTAssertEqual(p, provider(v2))
        p = try await e.packFor("event.winter", targets: [])
        XCTAssertNil(p)
    }

    func testCountsAnEmbeddedBaselinesRecord() async throws {
        let core = pack("djdl.core", strings(["dice.d6"]))
        let storage = memoryPackStorage()
        storage.store["embedded/djdl.core"] = MemoryPayload(layout: "tree", payload: nil, tree: core.files, index: nil)
        // The server holds nothing: the embedded marker's record answers both questions.
        let server = ByteServer()
        let e = engine(server: server, storage: storage, stamp: stampFor(core))
        let refused = try await e.load([
            EmbeddedBaseline(
                marker: Array(markerFor(core).utf8), payload: .tree(treeDigest: core.treeDigest),
                location: "embedded/djdl.core")
        ])
        XCTAssertTrue(refused.isEmpty)
        let available = try await e.isAvailable("dice.d6")
        XCTAssertTrue(available)
        let p = try await e.packFor("dice.d6")
        XCTAssertEqual(p, provider(core))
    }

    func testAnswersNothingForAnIdNoPackProvides() async throws {
        let plain = pack("djdl.plain", nil)
        let broken = pack("djdl.broken", strings(["ok.id", "ok.id"]))
        let server = ByteServer(plain, broken)
        let e = engine(server: server, stamp: stampFor(plain, broken))
        _ = try await e.load()
        _ = try await e.ensure(["djdl.plain", "djdl.broken"])
        let available = try await e.isAvailable("ok.id")
        XCTAssertFalse(available)
        var p = try await e.packFor("ok.id")
        XCTAssertNil(p)
        p = try await e.packFor("anything")
        XCTAssertNil(p)
    }

    func testSkipsATargetThatNamesAnotherPacksRecord() async throws {
        let foes = pack("djdl.foes", strings(["foe.goblin"]))
        let e = engine(server: ByteServer(foes), stamp: stampFor(foes))
        _ = try await e.load()
        let first = try await e.packFor("foe.goblin")
        XCTAssertEqual(first, provider(foes))
        let forged = PackTarget(pack: "djdl.other", release: target(foes).release)
        let p = try await e.packFor("foe.goblin", targets: [forged])
        XCTAssertNil(p)
    }

    func testSkipsATargetWhoseRecordCannotBeFetched() async throws {
        let gone = pack("djdl.gone", strings(["foe.ghost"]))
        let e = engine(server: ByteServer(), stamp: stampFor(gone))
        _ = try await e.load()
        let p = try await e.packFor("foe.ghost")
        XCTAssertNil(p)
    }

    func testHidesAPackTheLicenceIsNotEntitledTo() async throws {
        let skins = pack("djdl.skins", strings(["skin.gold"]), entitlement: "extras.skins")
        let server = ByteServer(skins)
        let granted = Locked2<Set<String>>([])
        let e = engine(server: server, stamp: stampFor(skins), entitlements: { granted.with { $0 } })
        _ = try await e.load()
        var p = try await e.packFor("skin.gold")
        XCTAssertNil(p)
        granted.with { $0 = ["extras.skins"] }
        p = try await e.packFor("skin.gold")
        XCTAssertEqual(p, provider(skins))
    }

    func testRequiresLoad() async {
        let e = engine(server: ByteServer(), stamp: nil)
        do {
            _ = try await e.isAvailable("x")
            XCTFail("isAvailable before load")
        } catch let err as PackError {
            XCTAssertEqual(err.code, ErrorCode.notConfigured)
        } catch { XCTFail("\(error)") }
    }
}
