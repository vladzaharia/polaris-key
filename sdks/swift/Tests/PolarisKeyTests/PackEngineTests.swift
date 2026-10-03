// @pkey-feature packs.state packs.handlers
//
// Unit proofs for the pack install-state machine and the pipeline (plans/P4-01.md §2.13; CONTENT
// §9–§10), ported from client-core's `test/packsEngine.test.ts` scenario for scenario, its
// round-2 and round-3 state-safety sections included. The appliers, planner and selection are
// pinned by the content corpus and `plan-matrix.json`; these pin what no corpus row can: commit
// and the pointer swap, resume, rollback, garbage-collection roots, embedded baselines and the
// state reload that trusts nothing it reads back.

import Foundation
import PolarisKeyCore
import PolarisKeyPacks
import XCTest

private let planCounter = Locked2(0)

final class Locked2<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var v: T
    init(_ v: T) { self.v = v }
    func with<R>(_ f: (inout T) -> R) -> R {
        lock.lock()
        defer { lock.unlock() }
        return f(&v)
    }
}

func packEngine(
    server: ByteServer, storage: any PackStorage = memoryPackStorage(),
    state: any PackStateStore = memoryPackStateStore(), stamp: AppContent? = nil,
    strategies: [String] = ["delta", "file", "full"], handlers: [any PackHandler] = [],
    entitlements: Set<String>? = nil, checkpointBytes: Int = 8 << 20
) -> PackEngine {
    PackEngine(
        PackEngineOptions(
            product: PackFixtures.product, releaseKeys: PackFixtures.releaseKeys,
            productTrust: { PackFixtures.productTrust }, stamp: stamp, zstd: LibZstd(),
            patchMethods: ["zstd-patch-from"], memBudget: 1 << 30, strategies: strategies, storage: storage,
            state: state, fetchRecord: server.fetchRecord, fetchObject: server.fetchObject,
            entitlements: { entitlements }, now: { 1_759_400_000 },
            newPlanId: { "plan-\(planCounter.with { $0 += 1; return $0 })" }, handlers: handlers,
            checkpointBytes: checkpointBytes))
}

var v1Files: [String: Any] {
    [
    "fr/strings.json": #"{"hello":"bonjour"}"#,
    "fr/menu.json": #"{"play":"jouer"}"#,
    "probe.txt": PackFixtures.probeBase,
    "big.bin": String(repeating: "x", count: 50000),
    ]
}

func packReleases() -> (v1: TreePack, v2: TreePack, v3: TreePack) {
    let v1 = treePack(packId: "djdl.l10n", version: "1.0.0", seq: 1, files: v1Files)
    var f2 = v1Files
    f2["fr/strings.json"] = #"{"hello":"salut"}"#
    let v2 = treePack(packId: "djdl.l10n", version: "1.1.0", seq: 2, files: f2)
    var f3 = f2
    f3["probe.txt"] = PackFixtures.probeTarget
    f3["fr/new.json"] = "{}"
    let v3 = treePack(packId: "djdl.l10n", version: "1.2.0", seq: 3, files: f3, from: v2)
    return (v1, v2, v3)
}

private func treeOf(_ storage: MemoryPackStorage, _ location: String) -> [String: String] {
    (storage.store[location]?.tree ?? [:]).mapValues { sha256Of($0) }
}

private func hashes(_ files: [String: [UInt8]]) -> [String: String] { files.mapValues { sha256Of($0) } }

private func code(_ body: () async throws -> Void) async -> String? {
    do {
        try await body()
        return nil
    } catch let e as PackError {
        return e.code
    } catch {
        return "other: \(error)"
    }
}

/// A state store that throws on `read` (an unreadable document).
private final class BrokenReadStore: PackStateStore, @unchecked Sendable {
    let base: MemoryPackStateStore
    init(_ base: MemoryPackStateStore) { self.base = base }
    func read() throws -> String? { throw TestIOError() }
    func replace(_ text: String) throws { try base.replace(text) }
    func quarantine(_ text: String) throws { try base.quarantine(text) }
    func quarantined() throws -> Bool { try base.quarantined() }
    func clearQuarantine() throws { try base.clearQuarantine() }
}

/// A store that keeps no hold list and whose quarantine cannot keep the torn text aside.
private final class NoQuarantineStore: PackStateStore, @unchecked Sendable {
    private let lock = NSLock()
    private var _text: String?
    init(_ text: String?) { _text = text }
    var text: String? {
        lock.lock()
        defer { lock.unlock() }
        return _text
    }
    func read() throws -> String? { text }
    func replace(_ text: String) throws {
        lock.lock()
        _text = text
        lock.unlock()
    }
    func quarantine(_ text: String) throws { throw TestIOError() }
    func quarantined() throws -> Bool { false }
    func clearQuarantine() throws {}
}

/// A store with the quarantine members but no hold list.
private final class CustomStore: PackStateStore, @unchecked Sendable {
    private let lock = NSLock()
    var text: String?
    var aside: String?
    init(_ text: String?) { self.text = text }
    func read() throws -> String? { lock.withLock { text } }
    func replace(_ t: String) throws { lock.withLock { text = t } }
    func quarantine(_ t: String) throws { lock.withLock { if aside == nil { aside = t } } }
    func quarantined() throws -> Bool { lock.withLock { aside != nil } }
    func clearQuarantine() throws { lock.withLock { aside = nil } }
}

/// The memory store with `readHoldList` failing.
private final class BrokenHoldListStore: PackStateStore, @unchecked Sendable {
    let base: MemoryPackStateStore
    init(_ base: MemoryPackStateStore) { self.base = base }
    func read() throws -> String? { try base.read() }
    func replace(_ text: String) throws { try base.replace(text) }
    func quarantine(_ text: String) throws { try base.quarantine(text) }
    func quarantined() throws -> Bool { try base.quarantined() }
    func clearQuarantine() throws { try base.clearQuarantine() }
    var keepsHoldList: Bool { true }
    func readHoldList() throws -> String? { throw TestIOError() }
    func writeHoldList(_ text: String) throws { try base.writeHoldList(text) }
}

/// The memory store, dying as it writes the commit that makes `seq` 2 active.
private final class DyingStore: PackStateStore, @unchecked Sendable {
    let base: MemoryPackStateStore
    init(_ base: MemoryPackStateStore) { self.base = base }
    func read() throws -> String? { try base.read() }
    func replace(_ text: String) throws {
        if parseJSON(text)?.objectValue?["active"]?.objectValue?["djdl.l10n"]?.objectValue?["seq"] == .int(2) {
            throw TestIOError()
        }
        try base.replace(text)
    }
    func quarantine(_ text: String) throws { try base.quarantine(text) }
    func quarantined() throws -> Bool { try base.quarantined() }
    func clearQuarantine() throws { try base.clearQuarantine() }
}

final class PackEngineTests: XCTestCase {
    // ── The install-state machine (pure) ─────────────────────────────────────────────────

    private func install(_ packId: String, _ n: Int) -> PackInstall {
        PackInstall(
            packId: packId, record: "r\(n)", recordSha256: PackFixtures.sha("r\(n)"), version: "1.\(n).0", seq: n,
            type: "files.tree", variant: "", layout: "tree", payloadSha256: PackFixtures.sha("p\(n)"),
            payloadSize: n, activation: "hot", location: "\(packId)/\(n)", installedAt: n)
    }

    func testProbeVectorFixture() {
        XCTAssertEqual(sha256Of(PackFixtures.probeTarget), ZstdProbe.sha256)
    }

    func testCommitSwapsAndRollbackRestores() {
        var s = commitInstall(emptyPackState(), install("a", 1))
        s = commitInstall(s, install("a", 2))
        XCTAssertEqual(s.active["a"]?.seq, 2)
        XCTAssertEqual(s.previous["a"]?.seq, 1)
        let r = rollbackInstall(s, packId: "a")
        XCTAssertTrue(r.rolledBack)
        XCTAssertEqual(r.state.active["a"]?.seq, 1)
        XCTAssertNil(r.state.previous["a"])
        XCTAssertFalse(rollbackInstall(r.state, packId: "a").rolledBack)
    }

    func testGcRoots() {
        var s = commitInstall(emptyPackState(), install("a", 1))
        s = commitInstall(s, install("a", 2))
        s.inflight["b"] = PackJournal(
            planId: "p9", packId: "b", record: "x", recordSha256: PackFixtures.sha("x"), variant: "",
            strategy: "full", objects: [], startedAt: 0)
        var emb = install("c", 3)
        emb.location = "emb/c"
        let roots = gcRoots(s, embedded: [emb])
        XCTAssertEqual(roots.locations.sorted(), ["a/1", "a/2", "emb/c"])
        XCTAssertEqual(Array(roots.plans), ["p9"])
    }

    func testParseAndReloadTrustNothing() async {
        XCTAssertEqual(parsePackState("not json"), emptyPackState())
        XCTAssertEqual(parsePackState(#"{"v":2}"#), emptyPackState())
        let s = commitInstall(commitInstall(emptyPackState(), install("a", 1)), install("b", 2))
        let text = serializePackState(s).replacingOccurrences(of: #""payloadSize":2"#, with: #""payloadSize":-2"#)
        XCTAssertEqual(Array(parsePackState(text).active.keys), ["a"])
        let reloaded = await reloadPackState(
            s, PackStateVerifier(install: { $0.packId == "b" }, journal: { _ in true }))
        XCTAssertEqual(Array(reloaded.active.keys), ["b"])
        XCTAssertEqual(reloaded.bootSeq, s.bootSeq + 1)
    }

    // ── A files.tree pack through the pipeline ───────────────────────────────────────────

    func testInstallsByFullReportsPackSetIdAndKeepsTheIndex() async throws {
        let (v1, _, _) = packReleases()
        let server = ByteServer(v1)
        let storage = memoryPackStorage()
        let e = packEngine(server: server, storage: storage, stamp: stampFor(v1))
        _ = try await e.load()
        let progress = Locked2<[Int]>([])
        e.on { p in progress.with { $0.append(p.done) } }
        let i = try await e.ensure(["djdl.l10n"])[0]
        XCTAssertEqual(i.recordSha256, v1.recordSha256)
        XCTAssertEqual(i.payloadSha256, v1.treeDigest)
        XCTAssertEqual(treeOf(storage, i.location), hashes(v1.files))
        XCTAssertEqual(storage.store[i.location]?.index?.files.count, 4)
        let running = try await e.state().running["djdl.l10n"]
        XCTAssertEqual(running?.recordSha256, v1.recordSha256)
        let id = await e.packSetId()
        XCTAssertEqual(id, packSetId([PackSetEntry(packId: "djdl.l10n", releaseSha256: v1.recordSha256)]))
        XCTAssertEqual(server.calls.map(\.sha256), [v1.indexSha256, v1.fullSha256])
        XCTAssertGreaterThan(progress.with { $0.last ?? 0 }, 0)
        // Ensuring the same pin again is a no-op that fetches nothing.
        _ = try await e.ensure(["djdl.l10n"])
        XCTAssertEqual(server.calls.count, 2)
    }

    func testUpdatesByFileStrategyAndByFilesDeltaSet() async throws {
        let (v1, v2, v3) = packReleases()
        let server = ByteServer(v1, v2, v3)
        let storage = memoryPackStorage()
        let state = memoryPackStateStore()
        var e = packEngine(server: server, storage: storage, state: state, stamp: stampFor(v1))
        _ = try await e.load()
        _ = try await e.ensure(["djdl.l10n"])

        server.calls = []
        e = packEngine(server: server, storage: storage, state: state, stamp: stampFor(v2))
        _ = try await e.load()
        let i2 = try await e.ensure(["djdl.l10n"])[0]
        XCTAssertEqual(treeOf(storage, i2.location), hashes(v2.files))
        XCTAssertEqual(server.calls.map(\.sha256), [v2.indexSha256, PackFixtures.sha(#"{"hello":"salut"}"#)])

        server.calls = []
        // Request weight makes a two-file change cheaper by `file` than by a three-object set, so
        // this host lists only `delta` and `full`.
        e = packEngine(server: server, storage: storage, state: state, stamp: stampFor(v3), strategies: ["delta", "full"])
        _ = try await e.load()
        let i3 = try await e.ensure(["djdl.l10n"])[0]
        XCTAssertEqual(treeOf(storage, i3.location), hashes(v3.files))
        let want = v3.objects.keys.filter {
            v2.objects[$0] == nil && $0 != v3.indexSha256 && $0 != v3.fullSha256
                && $0 != PackFixtures.sha(PackFixtures.probeTarget) && $0 != PackFixtures.sha("{}")
        }.sorted()
        XCTAssertEqual(Array(server.calls.map(\.sha256).dropFirst()).sorted(), want)
        let prev = try await e.state().previous["djdl.l10n"]
        XCTAssertEqual(prev?.recordSha256, v2.recordSha256)
        // GC: only active (v3) and previous (v2) stay.
        XCTAssertEqual(storage.store.keys.sorted(), [i2.location, i3.location].sorted())
        XCTAssertTrue(storage.staging.isEmpty)
    }

    func testACrashBeforeThePointerSwapLeavesActiveUntouched() async throws {
        let (v1, v2, _) = packReleases()
        let server = ByteServer(v1, v2)
        let storage = memoryPackStorage()
        let state = memoryPackStateStore()
        var e = packEngine(server: server, storage: storage, state: state, stamp: stampFor(v1))
        _ = try await e.load()
        let i1 = try await e.ensure(["djdl.l10n"])[0]
        let before = state.text

        e = packEngine(server: server, storage: storage, state: DyingStore(state), stamp: stampFor(v2))
        _ = try await e.load()
        do {
            _ = try await e.ensure(["djdl.l10n"])
            XCTFail("the commit's write was killed")
        } catch is TestIOError {}
        XCTAssertEqual(parseJSON(state.text!)?.objectValue?["active"]?.objectValue?["djdl.l10n"]?.objectValue?["seq"], .int(1))
        XCTAssertNotEqual(state.text, before)  // the journal was written

        // Relaunch: active is still v1, the orphaned v2 payload is collected.
        e = packEngine(server: server, storage: storage, state: state, stamp: stampFor(v1))
        _ = try await e.load()
        let active = try await e.state().active["djdl.l10n"]
        XCTAssertEqual(active?.recordSha256, v1.recordSha256)
        XCTAssertEqual(Array(storage.store.keys), [i1.location])
    }

    func testResumesAnInterruptedDownloadWithRangeAndIfRange() async throws {
        let (v1, _, _) = packReleases()
        let server = ByteServer(v1)
        let storage = memoryPackStorage()
        let state = memoryPackStateStore()
        var e = packEngine(server: server, storage: storage, state: state, stamp: stampFor(v1), checkpointBytes: 1)
        _ = try await e.load()
        // Interrupt the full object (the second object) after 1,000 bytes.
        let n = Locked2(0)
        server.override = { [server] req in
            if n.with({ $0 += 1; return $0 }) == 2 { server.cut = 1000 }
            return server.serve(req)
        }
        let c = await code { _ = try await e.ensure(["djdl.l10n"]) }
        XCTAssertEqual(c, ErrorCode.networkError)
        let journal = parseJSON(state.text!)?.objectValue?["inflight"]?.objectValue?["djdl.l10n"]?.objectValue
        let full = journal?["objects"]?.arrayValue?.first { $0.objectValue?["sha256"]?.stringValue == v1.fullSha256 }
        XCTAssertEqual(full?.objectValue?["done"], .int(1000))

        server.override = nil
        server.calls = []
        e = packEngine(server: server, storage: storage, state: state, stamp: stampFor(v1))
        _ = try await e.load()
        let inflight = try await e.state().inflight["djdl.l10n"]
        XCTAssertNotNil(inflight)
        let i = try await e.ensure(["djdl.l10n"])[0]
        XCTAssertEqual(treeOf(storage, i.location), hashes(v1.files))
        let resumed = server.calls.first { $0.sha256 == v1.fullSha256 }
        XCTAssertEqual(resumed, ObjectRequest(sha256: v1.fullSha256, offset: 1000, ifRange: "\"\(v1.fullSha256)\""))
    }

    func testRefetchesFromTheStartWhenTheStagedPrefixNoLongerHashes() async throws {
        let (v1, _, _) = packReleases()
        let server = ByteServer(v1)
        let storage = memoryPackStorage()
        let state = memoryPackStateStore()
        var e = packEngine(server: server, storage: storage, state: state, stamp: stampFor(v1))
        _ = try await e.load()
        let n = Locked2(0)
        server.override = { [server] req in
            if n.with({ $0 += 1; return $0 }) == 2 { server.cut = 1000 }
            return server.serve(req)
        }
        let c = await code { _ = try await e.ensure(["djdl.l10n"]) }
        XCTAssertNotNil(c)
        server.override = nil
        // Corrupt the staged prefix: it must not be trusted.
        var staging = storage.staging
        for (plan, var objs) in staging {
            if var b = objs[v1.fullSha256] {
                b[0] ^= 1
                objs[v1.fullSha256] = b
                staging[plan] = objs
            }
        }
        storage.staging = staging
        server.calls = []
        e = packEngine(server: server, storage: storage, state: state, stamp: stampFor(v1))
        _ = try await e.load()
        let i = try await e.ensure(["djdl.l10n"])[0]
        XCTAssertEqual(treeOf(storage, i.location), hashes(v1.files))
        XCTAssertEqual(server.calls.filter { $0.sha256 == v1.fullSha256 }.map(\.offset), [1000, 0])
    }

    private struct RecordingHandler: PackHandler {
        let events: Locked2<[String]>
        var type: String { "files.tree" }
        var layout: String { "tree" }
        var activation: String { "hot" }
        func supports(_ formatVersion: Int) -> Bool { formatVersion == 1 }
        func activate(_ install: PackInstall) async throws { events.with { $0.append("on \(install.version)") } }
        func deactivate(_ install: PackInstall) async throws { events.with { $0.append("off \(install.version)") } }
    }

    func testRollsBackAndAHotHandlerIsDeactivatedAndActivated() async throws {
        let (v1, v2, _) = packReleases()
        let server = ByteServer(v1, v2)
        let storage = memoryPackStorage()
        let state = memoryPackStateStore()
        let events = Locked2<[String]>([])
        let handler = RecordingHandler(events: events)
        var e = packEngine(server: server, storage: storage, state: state, stamp: stampFor(v1), handlers: [handler])
        _ = try await e.load()
        _ = try await e.ensure(["djdl.l10n"])
        e = packEngine(server: server, storage: storage, state: state, stamp: stampFor(v2), handlers: [handler])
        _ = try await e.load()
        _ = try await e.ensure(["djdl.l10n"])
        let rolled = try await e.rollback("djdl.l10n")
        XCTAssertTrue(rolled)
        let s = try await e.state()
        XCTAssertEqual(s.active["djdl.l10n"]?.version, "1.0.0")
        XCTAssertEqual(s.running["djdl.l10n"]?.version, "1.0.0")
        XCTAssertEqual(
            events.with { $0 }, ["on 1.0.0", "on 1.0.0", "off 1.0.0", "on 1.1.0", "off 1.1.0", "on 1.0.0"])
        let again = try await e.rollback("djdl.l10n")
        XCTAssertFalse(again)
        try await e.confirm()
        let boot = try await e.state().bootSeq
        XCTAssertEqual(parseJSON(state.text!)?.objectValue?["confirmedBootSeq"], .int(boot))
    }

    func testUsesAVerifiedEmbeddedBaselineAndKeepsItAsAGcRoot() async throws {
        let (v1, _, _) = packReleases()
        let other = treePack(packId: "djdl.extra", version: "1.0.0", seq: 1, files: ["a.txt": "a"])
        let server = ByteServer(v1, other)
        let storage = memoryPackStorage()
        storage.store["embedded/djdl.l10n"] = MemoryPayload(layout: "tree", payload: nil, tree: v1.files, index: nil)
        let baseline = EmbeddedBaseline(
            marker: Array(markerFor(v1).utf8), payload: .tree(treeDigest: v1.treeDigest), location: "embedded/djdl.l10n")
        let e = packEngine(server: server, storage: storage, stamp: stampFor(v1, other))
        let refused = try await e.load([baseline])
        XCTAssertTrue(refused.isEmpty)
        let i = try await e.ensure(["djdl.l10n"])[0]
        XCTAssertEqual(i.embedded, true)
        XCTAssertEqual(server.calls.count, 0)
        // Installing another pack runs garbage collection; the embedded payload is a root.
        _ = try await e.ensure(["djdl.extra"])
        XCTAssertNotNil(storage.store["embedded/djdl.l10n"])
        let id = await e.packSetId()
        XCTAssertEqual(
            id,
            packSetId([
                PackSetEntry(packId: "djdl.l10n", releaseSha256: v1.recordSha256),
                PackSetEntry(packId: "djdl.extra", releaseSha256: other.recordSha256),
            ]))

        // A marker whose bytes do not match, or whose release the stamp does not pin, is refused.
        let v2 = treePack(packId: "djdl.l10n", version: "1.1.0", seq: 2, files: ["a": "b"])
        let bad = try await packEngine(server: server, storage: storage, stamp: stampFor(v1)).load([
            EmbeddedBaseline(marker: baseline.marker, payload: .tree(treeDigest: v2.treeDigest), location: baseline.location)
        ])
        XCTAssertEqual(bad.map(\.step), ["payload"])
        XCTAssertEqual(bad.map(\.location), ["embedded/djdl.l10n"])
        let unpinned = try await packEngine(server: server, storage: storage, stamp: stampFor(v2)).load([baseline])
        XCTAssertEqual(unpinned.map(\.step), ["pin"])
        let forged = try await packEngine(server: server, storage: storage, stamp: stampFor(v1)).load([
            EmbeddedBaseline(
                marker: Array(markerFor(v1).replacingOccurrences(of: "\"1.0.0\"", with: "\"1.0.1\"").utf8),
                payload: baseline.payload, location: baseline.location)
        ])
        XCTAssertEqual(forged.map(\.step), ["cross-check"])
    }

    func testReverifiesTheStoredStateOnLoadAndDropsWhatFails() async throws {
        let (v1, _, _) = packReleases()
        let server = ByteServer(v1)
        let storage = memoryPackStorage()
        let state = memoryPackStateStore()
        let e = packEngine(server: server, storage: storage, state: state, stamp: stampFor(v1))
        _ = try await e.load()
        let i = try await e.ensure(["djdl.l10n"])[0]
        // A forged record JWS in the stored state.
        state.text = state.text!.replacingOccurrences(of: v1.jws, with: String(v1.jws.dropLast(4)) + "AAAA")
        let e2 = packEngine(server: server, storage: storage, state: state, stamp: stampFor(v1))
        _ = try await e2.load()
        let a2 = try await e2.state().active["djdl.l10n"]
        XCTAssertNil(a2)
        XCTAssertNil(storage.store[i.location])
        // A payload that changed on disk is dropped too.
        let state3 = memoryPackStateStore()
        let e3 = packEngine(server: server, storage: storage, state: state3, stamp: stampFor(v1))
        _ = try await e3.load()
        let j = try await e3.ensure(["djdl.l10n"])[0]
        var p = storage.store[j.location]!
        p.tree!["fr/menu.json"] = Array("{}".utf8)
        storage.store[j.location] = p
        let e4 = packEngine(server: server, storage: storage, state: state3, stamp: stampFor(v1))
        _ = try await e4.load()
        let a4 = try await e4.state().active["djdl.l10n"]
        XCTAssertNil(a4)
    }

    func testRefusesWithTypedCodes() async throws {
        let (v1, _, _) = packReleases()
        let server = ByteServer(v1)
        let noStamp = packEngine(server: server)
        _ = try await noStamp.load()
        var c = await code { _ = try await noStamp.ensure(["djdl.l10n"]) }
        XCTAssertEqual(c, ErrorCode.notConfigured)
        let e = packEngine(server: server, stamp: stampFor(v1))
        _ = try await e.load()
        c = await code { _ = try await e.ensure(["djdl.other"]) }
        XCTAssertEqual(c, ErrorCode.packNotPinned)

        // P4-16 built in data.json and l10n.table; audio.bank has no Swift handler (a typed N/A).
        let table = treePack(packId: "djdl.table", version: "1.0.0", seq: 1, files: ["a": "1"], type: "audio.bank")
        let t = packEngine(server: ByteServer(table), stamp: stampFor(table))
        _ = try await t.load()
        c = await code { _ = try await t.ensure(["djdl.table"]) }
        XCTAssertEqual(c, ErrorCode.packTypeUnsupported)

        let paid = treePack(packId: "djdl.hd", version: "1.0.0", seq: 1, files: ["a": "1"], entitlement: "hd")
        let p = packEngine(server: ByteServer(paid), stamp: stampFor(paid), entitlements: ["other"])
        _ = try await p.load()
        c = await code { _ = try await p.ensure(["djdl.hd"]) }
        XCTAssertEqual(c, ErrorCode.packNotEntitled)
        let p2 = packEngine(server: ByteServer(paid), stamp: stampFor(paid), entitlements: ["hd"])
        _ = try await p2.load()
        let got = try await p2.ensure(["djdl.hd"])
        XCTAssertEqual(got.count, 1)

        let forged = ByteServer(v1)
        forged.recordOverride = { _ in .ok(v1.jws + "x") }
        let f = packEngine(server: forged, stamp: stampFor(v1))
        _ = try await f.load()
        do {
            _ = try await f.ensure(["djdl.l10n"])
            XCTFail("a forged record must be refused")
        } catch let e as PackError {
            XCTAssertEqual(e.code, ErrorCode.recordRejected)
            XCTAssertEqual(e.detail, "hash")
        }
    }

    private struct BadHandler: PackHandler {
        var type: String { "x" }
        var layout: String { "folder" }
        var activation: String { "hot" }
        func supports(_ formatVersion: Int) -> Bool { true }
    }

    func testRegisterHandlerValidatesItsHandler() {
        let e = packEngine(server: ByteServer())
        XCTAssertThrowsError(try e.registerHandler(BadHandler())) { error in
            XCTAssertEqual((error as? PackError)?.code, ErrorCode.invalidOptions)
        }
    }

    // ── applyDelta and rule 5 ────────────────────────────────────────────────────────────

    private struct SpyZstd: ZstdPort {
        let called: Locked2<Bool>
        var pointerBits: Int { 31 }
        func decode(_ frame: [UInt8], size: Int) throws -> [UInt8] { [] }
        func decodeWithPrefix(_ frame: [UInt8], prefix: [UInt8], size: Int, windowLogMax: Int) throws -> [UInt8] {
            called.with { $0 = true }
            return []
        }
    }

    func testABaseStartingWithTheDictionaryMagicIsRefusedBeforeAnyDecoder() throws {
        let called = Locked2(false)
        let base: [UInt8] = [0x37, 0xa4, 0x30, 0xec, 1, 2, 3]
        let frame: [UInt8] = [0x28, 0xb5, 0x2f, 0xfd, 0x20, 0x05, 0, 0]
        let variant = try XCTUnwrap(
            PackVariant(
                json: .object([
                    "variant": .object([:]),
                    "payload": .object(["size": .int(5), "sha256": .string(PackFixtures.sha("hello"))]),
                    "full": .object([
                        "sha256": .string(PackFixtures.sha("f")), "bytes": .int(1), "size": .int(5), "codec": .string("zstd"),
                    ]),
                    "files": .object([
                        "format": .string("pkey-files/1"), "layout": .string("container"),
                        "sha256": .string(PackFixtures.sha("i")), "bytes": .int(1), "size": .int(1), "codec": .string("zstd"),
                    ]),
                    "deltas": .array([
                        .object([
                            "method": .string("zstd-patch-from"), "scope": .string("payload"),
                            "from": .string(sha256Of(base)), "memBytes": .int(64),
                            "artifact": .object(["sha256": .string(sha256Of(frame)), "bytes": .int(frame.count)]),
                        ])
                    ]),
                ])))
        let r = applyDelta(
            variant, 0, base: MemorySource(base), ApplyPorts(objects: { _ in MemorySource(frame) }, zstd: SpyZstd(called: called)))
        XCTAssertEqual(r.verdict, .failed(error: ErrorCode.deltaApplyFailed, path: nil))
        XCTAssertFalse(called.with { $0 })
    }

    // ── The stage machine's host side (plans/P4-01.md §2.10) ─────────────────────────────

    private final class Boot: @unchecked Sendable {
        private let lock = NSLock()
        private var state: BootState
        private(set) var emits: [String] = []
        init(_ stamp: AppContent) {
            let o = bootPackOptions(stamp)
            state = initialBootState(BootOptions(requiredPacks: o.requiredPacks, essentialPacks: o.essentialPacks))
            for e: BootEvent in [
                .start, .shellDone, .guardDone(.ok), .syncDone(.ok), .gateStatus(.ok), .decideDone(.none),
            ] { send(e) }
        }
        func send(_ event: BootEvent) {
            lock.lock()
            defer { lock.unlock() }
            let t = bootTransition(state, event)
            state = t.state
            for e in t.emits {
                if case .blocked(let reason) = e { emits.append("blocked:\(reason.rawValue)") } else { emits.append(e.type) }
            }
        }
        var current: BootState {
            lock.lock()
            defer { lock.unlock() }
            return state
        }
    }

    func testBootAsksOnAMeteredNetworkDownloadsWithProgressAndReachesReady() async throws {
        let (v1, _, _) = packReleases()
        let stamp = stampFor(v1)
        let e = packEngine(server: ByteServer(v1), stamp: stamp)
        _ = try await e.load()
        let boot = Boot(stamp)
        XCTAssertEqual(boot.current.stage, .fetch)
        let asked = Locked2(0)
        let r = try await runBootFetch(
            e,
            RunBootFetchOptions(
                stamp: stamp, send: { boot.send($0) }, metered: true,
                answer: { bytes, _ in
                    asked.with { $0 = bytes }
                    return true
                }))
        XCTAssertEqual(r.result, .ok)
        XCTAssertEqual(r.installed, ["djdl.l10n"])
        XCTAssertGreaterThan(asked.with { $0 }, 0)
        XCTAssertEqual(boot.current.stage, .mount)
        boot.send(.mountDone)
        XCTAssertEqual(boot.current.outcome, .ready)
        XCTAssertTrue(boot.emits.contains("consent_needed"))
        XCTAssertGreaterThanOrEqual(boot.emits.filter { $0 == "fetch_progress" }.count, 2)
    }

    func testBootADeclinedRequiredDownloadBlocksWithContentDeclined() async throws {
        let (v1, _, _) = packReleases()
        let stamp = stampFor(v1)
        let e = packEngine(server: ByteServer(v1), stamp: stamp)
        _ = try await e.load()
        let boot = Boot(stamp)
        let r = try await runBootFetch(
            e, RunBootFetchOptions(stamp: stamp, send: { boot.send($0) }, consent: .always, answer: { _, _ in false }))
        XCTAssertEqual(r.result, .declined)
        XCTAssertEqual(boot.current.stage, .blocked)
        XCTAssertTrue(boot.emits.contains("blocked:content-declined"))
    }

    func testBootAnUnreachableByteServerIsOfflineAndEssentialContentCanStillPlay() async throws {
        let (v1, _, _) = packReleases()
        var stamp = stampFor(v1)
        stamp.expects = [ContentExpect(pack: "djdl.l10n", required: false, delivery: "essential")]
        let server = ByteServer(v1)
        server.override = { _ in throw URLError(.notConnectedToInternet) }
        let e = packEngine(server: server, stamp: stamp)
        _ = try await e.load()
        let boot = Boot(stamp)
        let r = try await runBootFetch(e, RunBootFetchOptions(stamp: stamp, send: { boot.send($0) }, consent: .never))
        XCTAssertEqual(r.result, .offline)
        XCTAssertEqual(r.installed, [])
        XCTAssertEqual(boot.current.stage, .offline)
        XCTAssertTrue(boot.current.canPlayOffline)
    }

    // ── A load never loses what it could not judge ───────────────────────────────────────

    func testHoldsATornStateDocumentAsideAndCollectsNothingUntilRecoverState() async throws {
        let (v1, _, _) = packReleases()
        let server = ByteServer(v1)
        let storage = memoryPackStorage()
        let state = memoryPackStateStore()
        let e = packEngine(server: server, storage: storage, state: state, stamp: stampFor(v1))
        _ = try await e.load()
        let i = try await e.ensure(["djdl.l10n"])[0]
        let torn = String(state.text!.prefix(20))
        state.text = torn

        let e2 = packEngine(server: server, storage: storage, state: state, stamp: stampFor(v1))
        _ = try await e2.load()
        let issue2 = try await e2.state().stateIssue
        XCTAssertEqual(issue2, "torn")
        XCTAssertEqual(state.torn, torn)
        XCTAssertNotNil(storage.store[i.location])

        let e3 = packEngine(server: server, storage: storage, state: state, stamp: stampFor(v1))
        _ = try await e3.load()
        let issue3 = try await e3.state().stateIssue
        XCTAssertEqual(issue3, "torn")
        XCTAssertNotNil(storage.store[i.location])
        _ = try await e3.ensure(["djdl.l10n"])
        try await e3.recoverState()
        XCTAssertNil(state.torn)
        let s = try await e3.state()
        XCTAssertNil(s.stateIssue)
        XCTAssertEqual(s.active["djdl.l10n"]?.location, i.location)
        XCTAssertNotNil(storage.store[i.location])
    }

    func testKeepsAnInstallWhoseCheckThrewOutOfUseAndRestoresItOnTheNextLoad() async throws {
        let (v1, _, _) = packReleases()
        let server = ByteServer(v1)
        let storage = memoryPackStorage()
        let state = memoryPackStateStore()
        let e = packEngine(server: server, storage: storage, state: state, stamp: stampFor(v1))
        _ = try await e.load()
        let i = try await e.ensure(["djdl.l10n"])[0]
        let flaky = WrappedStorage(storage)
        flaky.verifyOverride = { _ in throw TestIOError() }
        let e2 = packEngine(server: server, storage: flaky, state: state, stamp: stampFor(v1))
        _ = try await e2.load()
        let s2 = try await e2.state()
        XCTAssertNil(s2.active["djdl.l10n"])
        XCTAssertNil(s2.running["djdl.l10n"])
        XCTAssertNotNil(storage.store[i.location])
        XCTAssertEqual(
            parseJSON(state.text!)?.objectValue?["active"]?.objectValue?["djdl.l10n"]?.objectValue?["location"],
            .string(i.location))

        let e3 = packEngine(server: server, storage: storage, state: state, stamp: stampFor(v1))
        _ = try await e3.load()
        let s3 = try await e3.state()
        XCTAssertEqual(s3.active["djdl.l10n"]?.recordSha256, v1.recordSha256)
        XCTAssertNotNil(s3.running["djdl.l10n"])
    }

    func testWritesNothingAndInstallsNothingWhenTheStateCannotBeRead() async throws {
        let (v1, _, _) = packReleases()
        let server = ByteServer(v1)
        let storage = memoryPackStorage()
        let state = memoryPackStateStore()
        let e = packEngine(server: server, storage: storage, state: state, stamp: stampFor(v1))
        _ = try await e.load()
        let i = try await e.ensure(["djdl.l10n"])[0]
        let before = state.text
        let e2 = packEngine(server: server, storage: storage, state: BrokenReadStore(state), stamp: stampFor(v1))
        _ = try await e2.load()
        let issue = try await e2.state().stateIssue
        XCTAssertEqual(issue, "unreadable")
        var c = await code { _ = try await e2.ensure(["djdl.l10n"]) }
        XCTAssertEqual(c, ErrorCode.packStateUnreadable)
        c = await code { _ = try await e2.estimate(["djdl.l10n"]) }
        XCTAssertEqual(c, ErrorCode.packStateUnreadable)
        c = await code { try await e2.confirm() }
        XCTAssertEqual(c, ErrorCode.packStateUnreadable)
        c = await code { _ = try await e2.rollback("djdl.l10n") }
        XCTAssertEqual(c, ErrorCode.packStateUnreadable)
        c = await code { try await e2.recoverState() }
        XCTAssertEqual(c, ErrorCode.packStateUnreadable)
        XCTAssertEqual(state.text, before)
        XCTAssertNotNil(storage.store[i.location])

        let e3 = packEngine(server: server, storage: storage, state: state, stamp: stampFor(v1))
        _ = try await e3.load()
        let a = try await e3.state().active["djdl.l10n"]
        XCTAssertEqual(a?.location, i.location)
    }

    func testANoOpCommitOverTheEmbeddedCopyStaysEmbedded() async throws {
        let (v1, _, _) = packReleases()
        let server = ByteServer(v1)
        let storage = memoryPackStorage()
        let other = treePack(packId: "djdl.l10n", version: "0.9.0", seq: 1, files: ["a.txt": "a"])
        let state = memoryPackStateStore()
        let first = packEngine(server: ByteServer(other), storage: storage, state: state, stamp: stampFor(other))
        _ = try await first.load()
        _ = try await first.ensure(["djdl.l10n"])
        storage.store["embedded/djdl.l10n"] = MemoryPayload(layout: "tree", payload: nil, tree: v1.files, index: nil)
        let e = packEngine(server: server, storage: storage, state: state, stamp: stampFor(v1))
        _ = try await e.load([
            EmbeddedBaseline(
                marker: Array(markerFor(v1).utf8), payload: .tree(treeDigest: v1.treeDigest), location: "embedded/djdl.l10n")
        ])
        let i = try await e.ensure(["djdl.l10n"])[0]
        XCTAssertEqual(i.location, "embedded/djdl.l10n")
        XCTAssertEqual(i.embedded, true)
        XCTAssertEqual(
            parseJSON(state.text!)?.objectValue?["active"]?.objectValue?["djdl.l10n"]?.objectValue?["embedded"], .bool(true))
    }

    func testRefusesAnIndexOverTheSizeLimitBeforeStagingAByte() async throws {
        let big = treePack(packId: "djdl.l10n", version: "1.0.0", seq: 1, files: v1Files, indexBytes: 33_554_433)
        let server = ByteServer(big)
        let e = packEngine(server: server, stamp: stampFor(big))
        _ = try await e.load()
        let c = await code { _ = try await e.ensure(["djdl.l10n"]) }
        XCTAssertEqual(c, ErrorCode.packNoVariant)
        XCTAssertTrue(server.calls.isEmpty)
    }

    // ── Round-2 state safety ─────────────────────────────────────────────────────────────

    func testKeepsAPreviousWhoseCheckThrewAcrossTwoLoads() async throws {
        let (v1, v2, _) = packReleases()
        let server = ByteServer(v1, v2)
        let storage = memoryPackStorage()
        let state = memoryPackStateStore()
        var e = packEngine(server: server, storage: storage, state: state, stamp: stampFor(v1))
        _ = try await e.load()
        let i1 = try await e.ensure(["djdl.l10n"])[0]
        e = packEngine(server: server, storage: storage, state: state, stamp: stampFor(v2))
        _ = try await e.load()
        _ = try await e.ensure(["djdl.l10n"])
        let flaky = WrappedStorage(storage)
        let loc = i1.location
        flaky.verifyOverride = { [storage] i in
            if i.location == loc { throw TestIOError() }
            return try storage.verify(i)
        }
        for _ in 0..<2 {
            let f = packEngine(server: server, storage: flaky, state: state, stamp: stampFor(v2))
            _ = try await f.load()
            let prev = try await f.state().previous["djdl.l10n"]
            XCTAssertNil(prev)
            XCTAssertEqual(
                parseJSON(state.text!)?.objectValue?["previous"]?.objectValue?["djdl.l10n"]?.objectValue?["location"],
                .string(i1.location))
            XCTAssertNotNil(storage.store[i1.location])
        }
        let ok = packEngine(server: server, storage: storage, state: state, stamp: stampFor(v2))
        _ = try await ok.load()
        let prev = try await ok.state().previous["djdl.l10n"]
        XCTAssertEqual(prev?.version, "1.0.0")
        let rolled = try await ok.rollback("djdl.l10n")
        XCTAssertTrue(rolled)
    }

    func testAFreshCommitCarriesADeferredActiveOverAsPreviousReverifiedAtRollback() async throws {
        let (v1, v2, _) = packReleases()
        let server = ByteServer(v1, v2)
        let storage = memoryPackStorage()
        let state = memoryPackStateStore()
        let e = packEngine(server: server, storage: storage, state: state, stamp: stampFor(v1))
        _ = try await e.load()
        let i1 = try await e.ensure(["djdl.l10n"])[0]
        let broken = Locked2(true)
        let flaky = WrappedStorage(storage)
        let loc = i1.location
        flaky.verifyOverride = { [storage] i in
            if broken.with({ $0 }) && i.location == loc { throw TestIOError() }
            return try storage.verify(i)
        }
        let f = packEngine(server: server, storage: flaky, state: state, stamp: stampFor(v2))
        _ = try await f.load()
        _ = try await f.ensure(["djdl.l10n"])
        let prev = try await f.state().previous["djdl.l10n"]
        XCTAssertEqual(prev?.location, i1.location)
        // Still unreadable: the rollback refuses rather than switch to unverified bytes.
        let first = try await f.rollback("djdl.l10n")
        XCTAssertFalse(first)
        broken.with { $0 = false }
        let second = try await f.rollback("djdl.l10n")
        XCTAssertTrue(second)
        let active = try await f.state().active["djdl.l10n"]
        XCTAssertEqual(active?.version, "1.0.0")
    }

    /// Swift's `PackStateStore` makes the quarantine members required, so a store that lacks them
    /// cannot be written; the nearest case is one whose quarantine fails, which client-core treats
    /// the same way: a torn document becomes unreadable, nothing is written over it.
    func testAStoreThatCannotQuarantineTreatsATornDocumentAsUnreadable() async throws {
        let (v1, _, _) = packReleases()
        let server = ByteServer(v1)
        let storage = memoryPackStorage()
        let good = memoryPackStateStore()
        let e = packEngine(server: server, storage: storage, state: good, stamp: stampFor(v1))
        _ = try await e.load()
        let i = try await e.ensure(["djdl.l10n"])[0]
        let torn = String(good.text!.prefix(15))
        let minimal = NoQuarantineStore(torn)
        let events = Locked2<[String]>([])
        let f = packEngine(server: server, storage: storage, state: minimal, stamp: stampFor(v1))
        f.on { p in events.with { $0.append("\(p.phase):\(p.issue ?? "")") } }
        _ = try await f.load()
        let issue = try await f.state().stateIssue
        XCTAssertEqual(issue, "unreadable")
        XCTAssertEqual(events.with { $0 }, ["state-issue:unreadable"])
        XCTAssertEqual(minimal.text, torn)
        XCTAssertNotNil(storage.store[i.location])
        var c = await code { _ = try await f.estimate(["djdl.l10n"]) }
        XCTAssertEqual(c, ErrorCode.packStateUnreadable)
        c = await code { try await f.confirm() }
        XCTAssertEqual(c, ErrorCode.packStateUnreadable)
    }

    func testACustomStoreWithTheQuarantineMembersHoldsATornDocument() async throws {
        let (v1, _, _) = packReleases()
        let server = ByteServer(v1)
        let storage = memoryPackStorage()
        let good = memoryPackStateStore()
        let e = packEngine(server: server, storage: storage, state: good, stamp: stampFor(v1))
        _ = try await e.load()
        let i = try await e.ensure(["djdl.l10n"])[0]
        let torn = String(good.text!.prefix(15))
        let custom = CustomStore(torn)
        let f = packEngine(server: server, storage: storage, state: custom, stamp: stampFor(v1))
        _ = try await f.load()
        let issue = try await f.state().stateIssue
        XCTAssertEqual(issue, "torn")
        XCTAssertEqual(custom.aside, torn)
        XCTAssertNotNil(storage.store[i.location])
    }

    func testBoundsTheTornHold() async throws {
        let (v1, v2, _) = packReleases()
        let server = ByteServer(v1, v2)
        let storage = memoryPackStorage()
        let state = memoryPackStateStore()
        var e = packEngine(server: server, storage: storage, state: state, stamp: stampFor(v1))
        _ = try await e.load()
        let i1 = try await e.ensure(["djdl.l10n"])[0]
        state.text = String(state.text!.prefix(15))
        storage.staging["old-orphan"] = [:]
        e = packEngine(server: server, storage: storage, state: state, stamp: stampFor(v2))
        _ = try await e.load()
        let issue = try await e.state().stateIssue
        XCTAssertEqual(issue, "torn")
        // Garbage this process creates during the hold is not protected by it.
        storage.staging["new-orphan"] = [:]
        storage.store["djdl.l10n/new-orphan"] = MemoryPayload(layout: "tree", payload: nil, tree: [:], index: nil)
        _ = try await e.ensure(["djdl.l10n"])
        XCTAssertNotNil(storage.store[i1.location])
        XCTAssertNotNil(storage.staging["old-orphan"])
        XCTAssertNil(storage.staging["new-orphan"])
        XCTAssertNil(storage.store["djdl.l10n/new-orphan"])
    }

    // ── The torn hold's snapshot (round 3) ───────────────────────────────────────────────

    private func tornSetup() async throws -> (v1: TreePack, v2: TreePack, server: ByteServer, storage: MemoryPackStorage, state: MemoryPackStateStore, i1: PackInstall) {
        let (v1, v2, _) = packReleases()
        let server = ByteServer(v1, v2)
        let storage = memoryPackStorage()
        let state = memoryPackStateStore()
        let e = packEngine(server: server, storage: storage, state: state, stamp: stampFor(v1))
        _ = try await e.load()
        let i1 = try await e.ensure(["djdl.l10n"])[0]
        state.text = String(state.text!.prefix(15))
        return (v1, v2, server, storage, state, i1)
    }

    private let later = MemoryPayload(layout: "tree", payload: nil, tree: [:], index: nil)

    func testAListingThatErrorsHoldsGcEntirely() async throws {
        let t = try await tornSetup()
        let failing = WrappedStorage(t.storage)
        failing.listOverride = { throw TestIOError() }
        let e = packEngine(server: t.server, storage: failing, state: t.state, stamp: stampFor(t.v2))
        _ = try await e.load()
        t.storage.store["djdl.l10n/new-orphan"] = later
        _ = try await e.ensure(["djdl.l10n"])
        XCTAssertNotNil(t.storage.store[t.i1.location])
        XCTAssertNotNil(t.storage.store["djdl.l10n/new-orphan"])
    }

    func testSavesTheFirstSnapshotAndReusesItOnLaterLoads() async throws {
        let t = try await tornSetup()
        _ = try await packEngine(server: t.server, storage: t.storage, state: t.state, stamp: stampFor(t.v1)).load()
        XCTAssertEqual(
            parseJSON(t.state.holdList!)?.objectValue?["locations"], .array([.string(t.i1.location)]))
        // Between restarts something unnamed appears: the saved snapshot does not protect it.
        t.storage.store["djdl.l10n/later"] = later
        let e = packEngine(server: t.server, storage: t.storage, state: t.state, stamp: stampFor(t.v1))
        _ = try await e.load()
        let issue = try await e.state().stateIssue
        XCTAssertEqual(issue, "torn")
        XCTAssertNotNil(t.storage.store[t.i1.location])
        XCTAssertNil(t.storage.store["djdl.l10n/later"])
        try await e.recoverState()
        XCTAssertNil(t.state.holdList)
    }

    func testAnUnreadableSavedSnapshotHoldsGcEntirely() async throws {
        let t = try await tornSetup()
        _ = try await packEngine(server: t.server, storage: t.storage, state: t.state, stamp: stampFor(t.v1)).load()
        t.storage.store["djdl.l10n/later"] = later
        _ = try await packEngine(
            server: t.server, storage: t.storage, state: BrokenHoldListStore(t.state), stamp: stampFor(t.v1)
        ).load()
        XCTAssertNotNil(t.storage.store[t.i1.location])
        XCTAssertNotNil(t.storage.store["djdl.l10n/later"])
    }
}
