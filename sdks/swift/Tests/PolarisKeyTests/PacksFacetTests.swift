// @pkey-feature packs.state packs.handlers packs.record packs.delegation
//
// `update.packs` end to end against a fake control plane (the port of the Node SDK's
// `test/packs.test.ts`): a `files.tree` pack installed from its pinned record into the platform
// data directory, updated by the file strategy, resumed after a dropped connection, served from
// an embedded baseline, and its `packSetId` reported through `devices/report` as `content`; then
// the directory store's refusals to mistake "cannot read" for "missing".

import Foundation
import PolarisKey
import PolarisKeyCore
import PolarisKeyPacks
import PolarisKeyUpdate
import XCTest

/// The blob route as a `PackObjectTransport`: Range honoured only with a matching `If-Range`,
/// every request's headers logged, `drop` cutting the next body after that many bytes, and
/// `status` answering every request with a refusal (P4-05's 403s).
final class FakeBlobs: PackObjectTransport, @unchecked Sendable {
    struct Seen: Equatable {
        let path: String
        let range: String?
        let ifRange: String?
        let auth: String?
    }
    private let lock = NSLock()
    private var _objects: [String: [UInt8]] = [:]
    private var _seen: [Seen] = []
    private var _drop: Int?
    private var _dropOn: Int?
    private var _status: Int?

    func set(_ packs: [TreePack]) {
        lock.withLock {
            _objects = [:]
            for p in packs { for (h, b) in p.objects { _objects[h] = b } }
        }
    }
    var seen: [Seen] {
        get { lock.withLock { _seen } }
        set { lock.withLock { _seen = newValue } }
    }
    /// Drop the body of the n-th request from now (1-based) after `drop` bytes.
    func drop(after bytes: Int, onRequest n: Int) { lock.withLock { _drop = bytes; _dropOn = n } }
    var status: Int? {
        get { lock.withLock { _status } }
        set { lock.withLock { _status = newValue } }
    }

    func get(_ url: URL, headers: [String: String], timeoutSeconds: Double) async throws -> ObjectResponse {
        func h(_ k: String) -> String? { headers.first { $0.key.lowercased() == k }?.value }
        let sha = url.lastPathComponent
        let (bytes, cut, refusal): ([UInt8]?, Int?, Int?) = lock.withLock {
            _seen.append(Seen(path: url.path, range: h("range"), ifRange: h("if-range"), auth: h("authorization")))
            var cut: Int?
            if let n = _dropOn {
                if n <= 1 {
                    cut = _drop
                    _dropOn = nil
                } else {
                    _dropOn = n - 1
                }
            }
            return (_objects[sha], cut, _status)
        }
        if let refusal {
            return ObjectResponse(
                status: refusal, contentRange: nil,
                chunks: AsyncThrowingStream { c in
                    c.yield(Array(#"{"error":{"code":"delivery_gate_missing"}}"#.utf8))
                    c.finish()
                })
        }
        guard let bytes else {
            return ObjectResponse(status: 404, contentRange: nil, chunks: AsyncThrowingStream { $0.finish() })
        }
        var start = 0
        var status = 200
        if let range = h("range"), h("if-range") == nil || h("if-range") == "\"\(sha)\"",
            let m = wholeMatches("bytes=([0-9]+)-", range), let s = m[1], let v = Int(s)
        {
            start = v
            status = 206
        }
        let body = Array(bytes[start...])
        let stream = AsyncThrowingStream<[UInt8], Error> { c in
            if let cut {
                c.yield(Array(body.prefix(cut)))
                c.finish(throwing: URLError(.networkConnectionLost))
            } else {
                var at = 0
                while at < body.count {
                    c.yield(Array(body[at..<min(at + 4096, body.count)]))
                    at += 4096
                }
                c.finish()
            }
        }
        return ObjectResponse(
            status: status, contentRange: status == 206 ? "bytes \(start)-\(bytes.count - 1)/\(bytes.count)" : nil,
            chunks: stream)
    }
}

final class PacksFacetTests: XCTestCase {
    private var work: URL!
    private let server = StubServer()
    private let blobs = FakeBlobs()

    override func setUp() async throws {
        work = FileManager.default.temporaryDirectory.appendingPathComponent("pkey-packs-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        await server.reset()
        await server.reply(
            "/djdl/.well-known/polaris.json",
            body: """
                {"product":"djdl","services":{"license":{"enabled":false},"config":{"enabled":false},\
                "release":{"enabled":true,"endpoints":{"record":"https://key.example/djdl/release/records/{sha256}"}},\
                "distribution":{"enabled":true,"endpoints":{"blobs":"https://key.example/djdl/distribution/blobs/sha256/{sha256}"}},\
                "update":{"enabled":true,"endpoints":{}}}}
                """)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: work)
    }

    private var v1Files: [String: Any] {
        ["fr/strings.json": #"{"hello":"bonjour"}"#, "fr/menu.json": #"{"play":"jouer"}"#,
         "big.bin": String(repeating: "x", count: 60000)]
    }

    private func serve(_ packs: [TreePack], bodies: [String: String] = [:]) async {
        blobs.set(packs)
        for p in packs {
            await server.reply("/djdl/release/records/\(p.recordSha256)", body: bodies[p.recordSha256] ?? p.jws)
        }
    }

    private var root: URL { work.appendingPathComponent("data/djdl/packs") }

    private func client(
        stamp: PackStampSource?, embedded: [EmbeddedPack] = [], token: Bool = true
    ) async throws -> (PolarisKeyClient, UpdateClient) {
        let store = InMemoryStore(deviceId: "dev_packs")
        if token { await store.setToken("pkeyt_test") }
        let core = CoreOptions(
            productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
            pinnedKeys: PackFixtures.productTrust, store: store, transport: server.transport,
            expectedServices: [.release, .distribution, .update], dataDir: work.appendingPathComponent("data"))
        let client = try await PolarisKeyClient.create(options: PolarisKeyClientOptions(core: core))
        let update = try UpdateClient(
            core: client.core,
            options: UpdateClientOptions(
                pinnedReleaseKeys: PackFixtures.releaseKeys, outlet: .kind("direct"),
                packs: PacksOptions(contentStamp: stamp, embedded: embedded, objectTransport: blobs)))
        return (client, update)
    }

    private func stampFile(_ packs: TreePack...) throws -> PackStampSource {
        let url = work.appendingPathComponent("stamp-\(packs.map(\.version).joined(separator: "-")).json")
        try Data(stampText(AppContent(
            contentApi: 1,
            pins: packs.map { ContentPin(pack: $0.packId, sha256: $0.recordSha256, seq: $0.seq, version: $0.version) },
            expects: packs.map { ContentExpect(pack: $0.packId, required: true, delivery: "essential") })).utf8)
            .write(to: url)
        return .file(url)
    }

    private func treeOnDisk(_ dir: URL, _ files: [String: [UInt8]]) -> Bool {
        for (p, b) in files {
            guard let got = try? Data(contentsOf: dir.appendingPathComponent(p)), [UInt8](got) == b else { return false }
        }
        return true
    }

    private func code(_ body: () async throws -> Void) async -> (String?, String?) {
        do {
            try await body()
            return (nil, nil)
        } catch let e as PackError {
            return (e.code, e.detail)
        } catch let e as PolarisError {
            return (e.code, e.detail)
        } catch {
            return ("other: \(error)", nil)
        }
    }

    /// plans/P4-19.md §2.4: the packs client hands the stamp's holds to the engine, so a release
    /// the stamp holds never takes the delegated path, even when a decision targets it and its
    /// delegation is valid (`record-rejected`, detail `jws`). Without the hold it installs.
    func testAHeldReleaseSignedUnderADelegationIsRefusedThroughThePacksClient() async throws {
        let ck = contentKeyPair()
        let d = delegationFor(deliverable: "djdl.events", publicKey: ck.pub)
        let held = treePack(
            packId: "djdl.events.halloween", version: "1.0.0", seq: 1, files: ["a.json": "{}"],
            signer: (ck.key, d.kid), issuedAt: 1_759_250_000)
        await serve([held])
        await server.reply("/djdl/release/records/\(d.sha256)", body: d.jws)
        let release = ReleasePin(sha256: held.recordSha256, seq: held.seq, version: held.version)
        let target = PackTarget(pack: held.packId, release: release)
        func stamp(_ name: String, holds: Bool) throws -> PackStampSource {
            var o: [String: JSONValue] = [
                "format": .string("pkey-content/1"), "contentApi": .int(1), "pins": .array([]),
                "expects": .array([
                    .object([
                        "pack": .string(held.packId), "required": .bool(true), "delivery": .string("essential"),
                    ])
                ]),
            ]
            if holds {
                o["holds"] = .array([
                    ContentHold(pack: held.packId, release: release, reason: "held in a test").json
                ])
            }
            let url = work.appendingPathComponent(name)
            try Data(canonicalJSON(.object(o)).utf8).write(to: url)
            return .file(url)
        }

        let (c, update) = try await client(stamp: try stamp("stamp-held.json", holds: true))
        let (code, detail) = await code { _ = try await update.packs.ensureReleases([target]) }
        XCTAssertEqual(code, ErrorCode.recordRejected)
        XCTAssertEqual(detail, "jws")
        await c.close()

        let (c2, update2) = try await client(stamp: try stamp("stamp-free.json", holds: false))
        let installs = try await update2.packs.ensureReleases([target])
        XCTAssertEqual(installs.first?.delegation, d.jws)
        await c2.close()
    }

    func testInstallsAFilesTreePackFromTheFakeByteServerAndReportsPackSetId() async throws {
        let v1 = treePack(packId: "djdl.l10n", version: "1.0.0", seq: 1, files: v1Files)
        await serve([v1])
        let (c, update) = try await client(stamp: try stampFile(v1))
        let phases = Locked2<[String]>([])
        update.packs.on { e in phases.with { $0.append(e.phase) } }
        let install = try await update.packs.ensure(["djdl.l10n"])[0]
        XCTAssertEqual(install.recordSha256, v1.recordSha256)
        let dir = try await update.packs.path("djdl.l10n")
        XCTAssertEqual(
            dir?.standardizedFileURL.path,
            root.appendingPathComponent("store/djdl.l10n/\(v1.treeDigest)").standardizedFileURL.path)
        XCTAssertTrue(treeOnDisk(try XCTUnwrap(dir), v1.files))
        XCTAssertTrue(phases.with { $0 }.contains("done"))
        // The device bearer goes to the control plane's own origin.
        XCTAssertFalse(blobs.seen.isEmpty)
        XCTAssertTrue(blobs.seen.allSatisfy { $0.auth == "Bearer pkeyt_test" })
        // The store is excluded from backups.
        let excluded = try root.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup
        XCTAssertEqual(excluded, true)

        let reported = await c.report()
        XCTAssertTrue(reported)
        let want = packSetId([PackSetEntry(packId: "djdl.l10n", releaseSha256: v1.recordSha256)])
        let bodies = await server.requests(forPath: "/djdl/devices/report").compactMap(\.body)
        XCTAssertEqual(bodies.count, 1)
        let body = try JSONDecoder().decode(JSONValue.self, from: try XCTUnwrap(bodies.first))
        XCTAssertEqual(body.objectValue?["content"], .object(["packSetId": .string(try XCTUnwrap(want))]))
        let state = try await update.packs.state()
        XCTAssertEqual(state.active["djdl.l10n"]?.version, "1.0.0")
        let zstd = try await update.packs.zstd()
        XCTAssertEqual(zstd.patchMethods, ["zstd-patch-from"])
        await c.close()
    }

    func testUpdatesByTheFileStrategyAfterARelaunchAndResumesADroppedDownload() async throws {
        let v1 = treePack(packId: "djdl.l10n", version: "1.0.0", seq: 1, files: v1Files)
        var f2 = v1Files
        f2["fr/strings.json"] = #"{"hello":"salut"}"#
        f2["big2.bin"] = String(repeating: "y", count: 40000)
        let v2 = treePack(packId: "djdl.l10n", version: "1.1.0", seq: 2, files: f2)
        await serve([v1, v2])
        var (c, update) = try await client(stamp: try stampFile(v1))
        _ = try await update.packs.ensure(["djdl.l10n"])
        await c.close()

        // A relaunch on the v2 build: the second blob request (after the index) drops at 1,000 bytes.
        blobs.seen = []
        (c, update) = try await client(stamp: try stampFile(v2))
        blobs.drop(after: 1000, onRequest: 2)
        let (failure, _) = await code { _ = try await update.packs.ensure(["djdl.l10n"]) }
        XCTAssertEqual(failure, ErrorCode.networkError)
        await c.close()

        blobs.seen = []
        (c, update) = try await client(stamp: try stampFile(v2))
        let install = try await update.packs.ensure(["djdl.l10n"])[0]
        XCTAssertEqual(install.version, "1.1.0")
        let p2 = try await update.packs.path("djdl.l10n")
        XCTAssertTrue(treeOnDisk(try XCTUnwrap(p2), v2.files))
        let resumed = try XCTUnwrap(blobs.seen.first { $0.range != nil })
        XCTAssertEqual(resumed.range, "bytes=1000-")
        XCTAssertNotNil(wholeMatches(#""[0-9a-f]{64}""#, try XCTUnwrap(resumed.ifRange)))
        // Only the changed files' blobs were fetched, never the full object.
        XCTAssertFalse(blobs.seen.contains { $0.path.hasSuffix(v2.fullSha256) })
        let prev = try await update.packs.state().previous["djdl.l10n"]
        XCTAssertEqual(prev?.version, "1.0.0")
        await c.close()
    }

    func testUsesAnEmbeddedBaselineAsInstalledStateAndFetchesNothing() async throws {
        let v1 = treePack(packId: "djdl.l10n", version: "1.0.0", seq: 1, files: v1Files)
        await serve([v1])
        let emb = work.appendingPathComponent("app/pkey_packs/djdl.l10n")
        for (p, b) in v1.files {
            let abs = emb.appendingPathComponent(p)
            try FileManager.default.createDirectory(at: abs.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(b).write(to: abs)
        }
        try FileManager.default.createDirectory(at: emb.appendingPathComponent(".pkey"), withIntermediateDirectories: true)
        try Data(markerFor(v1).utf8).write(to: emb.appendingPathComponent(".pkey/pack.json"))
        let (c, update) = try await client(stamp: try stampFile(v1), embedded: [EmbeddedPack(path: emb)])
        let refused = try await update.packs.refusedEmbedded()
        XCTAssertTrue(refused.isEmpty)
        let install = try await update.packs.ensure(["djdl.l10n"])[0]
        XCTAssertEqual(install.embedded, true)
        let path = try await update.packs.path("djdl.l10n")
        XCTAssertEqual(path?.standardizedFileURL.path, emb.standardizedFileURL.path)
        XCTAssertTrue(blobs.seen.isEmpty)
        await c.close()
    }

    func testRaisesNotConfiguredWithoutAStampAndContentStampInvalidForABadOne() async throws {
        var (c, update) = try await client(stamp: nil)
        var (failure, _) = await code { _ = try await update.packs.ensure(["djdl.l10n"]) }
        XCTAssertEqual(failure, ErrorCode.notConfigured)
        let none = await update.packs.packSetId()
        XCTAssertNil(none)
        await c.close()
        (c, update) = try await client(stamp: .bytes(Array(#"{"format":"pkey-content/2"}"#.utf8)))
        (failure, _) = await code { _ = try await update.packs.ensure(["djdl.l10n"]) }
        XCTAssertEqual(failure, ErrorCode.contentStampInvalid)
        await c.close()
    }

    func testCapsARecordBodyAtTheRecordBound() async throws {
        let v1 = treePack(packId: "djdl.l10n", version: "1.0.0", seq: 1, files: v1Files)
        await serve([v1], bodies: [v1.recordSha256: v1.jws + String(repeating: "A", count: 200_000)])
        let (c, update) = try await client(stamp: try stampFile(v1))
        let (failure, detail) = await code { _ = try await update.packs.ensure(["djdl.l10n"]) }
        XCTAssertEqual(failure, ErrorCode.recordRejected)
        XCTAssertEqual(detail, "hash")
        await c.close()
    }

    /// P4-05: a 403 `delivery_gate_missing` / `not_entitled` from the blob route is a failed fetch.
    func testABlobRouteRefusalIsAFailedFetch() async throws {
        let v1 = treePack(packId: "djdl.l10n", version: "1.0.0", seq: 1, files: v1Files)
        await serve([v1])
        blobs.status = 403
        let (c, update) = try await client(stamp: try stampFile(v1))
        let (failure, _) = await code { _ = try await update.packs.ensure(["djdl.l10n"]) }
        XCTAssertEqual(failure, ErrorCode.networkError)
        blobs.status = nil
        await c.close()
    }

    func testEmbeddedSingleFileBaselineIsReadFromTheFileItself() throws {
        let file = work.appendingPathComponent("levels.pck")
        try Data("payload bytes".utf8).write(to: file)
        let storage = DirPackStorage(root: work.appendingPathComponent("packs"))
        let m = try measureFile(file.path)
        let install = PackInstall(
            packId: "djdl.levels", record: "x", recordSha256: m.sha256, version: "1.0.0", seq: 1, type: "custom.blob",
            variant: "", layout: "container", payloadSha256: m.sha256, payloadSize: m.size, activation: "restart",
            location: file.path, embedded: true, installedAt: 1)
        XCTAssertEqual(try storage.installed(install)?.payload?.size, m.size)
        XCTAssertTrue(try storage.verify(install))
        var bigger = install
        bigger.payloadSize += 1
        XCTAssertFalse(try storage.verify(bigger))
        // Removing an embedded payload (outside the store) is refused.
        try storage.remove(file.path)
        XCTAssertEqual(try measureFile(file.path).size, m.size)
    }

    // ── state.json that cannot be trusted ────────────────────────────────────────────────

    func testHoldsATornStateJsonAsideAcrossLoadsAndKeepsTheStore() async throws {
        let v1 = treePack(packId: "djdl.l10n", version: "1.0.0", seq: 1, files: v1Files)
        await serve([v1])
        var (c, update) = try await client(stamp: try stampFile(v1))
        _ = try await update.packs.ensure(["djdl.l10n"])
        let dirOpt = try await update.packs.path("djdl.l10n")
        let dir = try XCTUnwrap(dirOpt)
        await c.close()
        try Data(#"{"v":1,"active":{"djdl"#.utf8).write(to: root.appendingPathComponent("state.json"))
        for _ in 0..<2 {
            (c, update) = try await client(stamp: try stampFile(v1))
            let issue = try await update.packs.state().stateIssue
            XCTAssertEqual(issue, "torn")
            XCTAssertTrue(treeOnDisk(dir, v1.files))
            await c.close()
        }
        let torn = try String(contentsOf: root.appendingPathComponent("state.json.torn"), encoding: .utf8)
        XCTAssertTrue(torn.hasPrefix(#"{"v":1"#))
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("state.json.torn.list").path))
    }

    func testRefusesToWriteOrInstallOverAStateJsonItCannotRead() async throws {
        let v1 = treePack(packId: "djdl.l10n", version: "1.0.0", seq: 1, files: v1Files)
        await serve([v1])
        var (c, update) = try await client(stamp: try stampFile(v1))
        _ = try await update.packs.ensure(["djdl.l10n"])
        let stateFile = root.appendingPathComponent("state.json")
        let good = try Data(contentsOf: stateFile)
        await c.close()
        // A directory where the file should be: reading it fails with EISDIR, not ENOENT.
        try FileManager.default.removeItem(at: stateFile)
        try FileManager.default.createDirectory(at: stateFile, withIntermediateDirectories: false)
        (c, update) = try await client(stamp: try stampFile(v1))
        let (failure, _) = await code { _ = try await update.packs.ensure(["djdl.l10n"]) }
        XCTAssertEqual(failure, ErrorCode.packStateUnreadable)
        await c.close()
        try FileManager.default.removeItem(at: stateFile)
        try good.write(to: stateFile)
        (c, update) = try await client(stamp: try stampFile(v1))
        let active = try await update.packs.state().active["djdl.l10n"]
        XCTAssertEqual(active?.version, "1.0.0")
        await c.close()
    }

    func testAPayloadTheProcessCannotReadIsKeptAcrossTwoLoads() async throws {
        try XCTSkipIf(getuid() == 0, "root reads a 000 directory")
        let v1 = treePack(packId: "djdl.l10n", version: "1.0.0", seq: 1, files: v1Files)
        await serve([v1])
        var (c, update) = try await client(stamp: try stampFile(v1))
        _ = try await update.packs.ensure(["djdl.l10n"])
        let dirOpt = try await update.packs.path("djdl.l10n")
        let dir = try XCTUnwrap(dirOpt)
        await c.close()
        chmod(dir.path, 0o000)
        defer { chmod(dir.path, 0o755) }
        for _ in 0..<2 {
            (c, update) = try await client(stamp: try stampFile(v1))
            let s = try await update.packs.state()
            XCTAssertNil(s.active["djdl.l10n"])
            XCTAssertNil(s.running["djdl.l10n"])
            await c.close()
        }
        chmod(dir.path, 0o755)
        (c, update) = try await client(stamp: try stampFile(v1))
        let active = try await update.packs.state().active["djdl.l10n"]
        XCTAssertEqual(active?.location, dir.standardizedFileURL.path)
        XCTAssertTrue(treeOnDisk(dir, v1.files))
        await c.close()
    }

    func testListNeverAnswersAPartialListing() async throws {
        try XCTSkipIf(getuid() == 0, "root reads a 000 directory")
        let a = treePack(packId: "djdl.l10n", version: "1.0.0", seq: 1, files: v1Files)
        let b = treePack(packId: "djdl.extra", version: "1.0.0", seq: 1, files: ["x.txt": "x"])
        await serve([a, b])
        var (c, update) = try await client(stamp: try stampFile(a, b))
        _ = try await update.packs.ensure(["djdl.l10n", "djdl.extra"])
        let dirAOpt = try await update.packs.path("djdl.l10n")
        let dirA = try XCTUnwrap(dirAOpt)
        await c.close()
        try Data(#"{"v":1,"act"#.utf8).write(to: root.appendingPathComponent("state.json"))
        let packDir = root.appendingPathComponent("store/djdl.l10n").path
        chmod(packDir, 0o000)
        defer { chmod(packDir, 0o755) }
        XCTAssertThrowsError(try DirPackStorage(root: root).list()) { error in
            XCTAssertEqual((error as? PackFileError)?.errno, EACCES)
        }
        (c, update) = try await client(stamp: try stampFile(b))
        let issue = try await update.packs.state().stateIssue
        XCTAssertEqual(issue, "torn")
        _ = try await update.packs.ensure(["djdl.extra"])
        await c.close()
        chmod(packDir, 0o755)
        XCTAssertTrue(treeOnDisk(dirA, a.files))
    }

    func testStateReadIsMissingOnlyWhenNotFound() throws {
        let store = DirPackStateStore(root: work.appendingPathComponent("nowhere").path)
        XCTAssertNil(try store.read())
        // ENOTDIR (a file where a directory should be) is missing too.
        let file = work.appendingPathComponent("plain")
        try Data("x".utf8).write(to: file)
        XCTAssertNil(try DirPackStateStore(root: file.path).read())
        // EISDIR is not.
        let dirRoot = work.appendingPathComponent("dirroot")
        try FileManager.default.createDirectory(
            at: dirRoot.appendingPathComponent("state.json"), withIntermediateDirectories: true)
        XCTAssertThrowsError(try DirPackStateStore(root: dirRoot.path).read())
        // The quarantine never overwrites an earlier one, and the hold list is written once.
        let s = DirPackStateStore(root: work.appendingPathComponent("q").path)
        try s.replace("{}")
        try s.quarantine("first")
        try s.quarantine("second")
        XCTAssertTrue(try s.quarantined())
        XCTAssertEqual(
            try String(contentsOfFile: work.appendingPathComponent("q/state.json.torn").path, encoding: .utf8), "first")
        try s.writeHoldList("a")
        try s.writeHoldList("b")
        XCTAssertEqual(try s.readHoldList(), "a")
        try s.clearQuarantine()
        XCTAssertFalse(try s.quarantined())
        XCTAssertNil(try s.readHoldList())
    }
}
