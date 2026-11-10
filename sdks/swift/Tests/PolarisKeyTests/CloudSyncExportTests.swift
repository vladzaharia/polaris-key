// @pkey-feature sync.export
//
// `client.cloudSync.export(to:options:)` (U-51.6; WIRE-CONTRACT-V5 §13.12): the host around the export core, over
// a scripted Worker in server mode. A zip of a written save; the destination rules (exclusive create, a
// planted link, a stale partial, a full disk, the old file kept, data protection asked for); cancel; the pull
// and wait bounds; one export at a time; and the live wiring through a client.

import Foundation
import PolarisKeyCore
import XCTest

@testable import PolarisKey
@testable import PolarisKeyIdentity

private let fileA = xStream("file-a", 3000)
private let fileB = xStream("file-b", 1500)

private func sha(_ d: Data) -> String { xHex(Data(SyncCrypto.sha256(d))) }

/// A scripted Worker for product `demo`: a pull, the file routes (ranges served in pieces of `rangeBytes`),
/// the revisions route and the chunk route. Anything else is a 404.
private final class Worker: PolarisTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var log: [PolarisRequest] = []
    var changes = ""
    var more = false
    /// `(path, version)` of a file the Worker serves.
    var files: [String: Data] = [:]
    var revisions: [String: String] = [:]
    var rangeBytes = 1000
    var contentRangeLies = false
    var pullStatus = 200
    var pullHeaders: [String: String] = [:]
    var gate: (@Sendable () async -> Void)?
    var onPull: (@Sendable (Int) -> Void)?
    var pulls: Int { lock.withLock { log.filter { $0.url.path == "/demo/sync" }.count } }
    var requests: [PolarisRequest] { lock.withLock { log } }

    func send(_ request: PolarisRequest) async throws -> PolarisResponse {
        lock.withLock { log.append(request) }
        let path = request.url.path
        if path == "/demo/sync" {
            let n = pulls
            onPull?(n)
            if let gate { await gate() }
            if pullStatus != 200 { return PolarisResponse(status: pullStatus, body: Data(), headers: pullHeaders) }
            let cursor = more ? n : 1
            let body =
                #"{"encryption":"server","cursor":\#(cursor),"more":\#(more),"changes":[\#(changes)],"tombstones":[]}"#
            return PolarisResponse(status: 200, body: Data(body.utf8))
        }
        let prefix = "/demo/sync/files/"
        guard path.hasPrefix(prefix) else { return PolarisResponse(status: 404, body: Data()) }
        let rest = String(path.dropFirst(prefix.count))
        if rest.hasSuffix("/revisions") {
            let key = String(rest.dropLast("/revisions".count))
            return PolarisResponse(status: 200, body: Data((revisions[key] ?? #"{"revisions":[]}"#).utf8))
        }
        let version = request.url.query.flatMap { $0.hasPrefix("version=") ? Int($0.dropFirst(8)) : nil } ?? 0
        guard let bytes = files["\(rest)@\(version)"] else { return PolarisResponse(status: 404, body: Data()) }
        guard let range = request.headers["range"], range.hasPrefix("bytes=") else {
            return PolarisResponse(status: 200, body: bytes, headers: ["etag": "\"e\(version)\""])
        }
        let parts = range.dropFirst(6).split(separator: "-").compactMap { Int($0) }
        let start = parts[0]
        let end = min(parts[1] + 1, start + rangeBytes, bytes.count)
        let shown = contentRangeLies ? start + 1 : start
        return PolarisResponse(
            status: 206, body: bytes.subdata(in: start..<end),
            headers: [
                "content-range": "bytes \(shown)-\(shown + end - start - 1)/\(bytes.count)", "etag": "\"e\(version)\"",
            ])
    }
}

private func recordJSON(_ id: String, version: Int, file: (version: Int, data: Data)? = nil) -> String {
    let f = file.map {
        #","file":{"version":\#($0.version),"size":\#($0.data.count),"sha256":"\#(sha($0.data))","format":"whole"}"#
    }
    return #"{"record":["saves","\#(id)"],"value":{"n":\#(version)},"version":\#(version)\#(f ?? "")}"#
}

private let setting = #"{"setting":"audio.volume","scope":"user","value":7,"version":2}"#

private final class Box<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T
    init(_ value: T) { self.value = value }
    var current: T { lock.withLock { value } }
    func set(_ v: T) { lock.withLock { value = v } }
    func with<R>(_ body: (inout T) -> R) -> R { lock.withLock { body(&value) } }
}

final class CloudSyncExportTests: XCTestCase {
    private var dir = FileManager.default.temporaryDirectory
    private var destination: URL { dir.appendingPathComponent("export.zip") }
    private var partial: URL { dir.appendingPathComponent("export.zip.partial") }

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("pk-export-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDown() async throws { try? FileManager.default.removeItem(at: dir) }

    private func exists(_ url: URL) -> Bool {
        var st = stat()
        return lstat(url.path, &st) == 0
    }

    private func worker(_ changes: [String], files: [String: Data] = [:]) -> Worker {
        let w = Worker()
        w.changes = changes.joined(separator: ",")
        w.files = files
        return w
    }

    private func exporter(
        _ w: Worker, flush: Int = 2, basis: (@Sendable () async throws -> ExportBasis)? = nil,
        sleep: (@Sendable (Double) async throws -> Void)? = nil,
        protect: (@Sendable (String) throws -> Void)? = nil,
        writer: (@Sendable (Int32, UnsafeRawPointer, Int) -> Int)? = nil
    ) -> CloudSyncExporter {
        var deps = ExportDeps(
            product: "demo", baseUrl: "https://key.example", transport: w, headers: { ["x-pkey-device": "d"] },
            token: { "pkeyt_secret" },
            basis: basis ?? { ExportBasis(e2e: false, clientId: "cid", codec: nil, fileCodec: nil) },
            flush: { flush })
        deps.now = { 1_760_000_000_000 }
        if let sleep { deps.sleep = sleep }
        if let protect { deps.protect = protect }
        if let writer { deps.writer = writer }
        return CloudSyncExporter(deps)
    }

    private func entries(_ url: URL) throws -> [ZipEntry] { try readStoredZip(Data(contentsOf: url)) }

    private func dataJSON(_ url: URL) throws -> JSONValue {
        let e = try XCTUnwrap(try entries(url).first { $0.name == "data.json" })
        return try CanonicalJSON.parse(utf8: e.data)
    }

    private func reason(_ error: Error) -> String? { (error as? PolarisError)?.exportFailureReason }

    // MARK: the archive

    func testAWrittenSaveBecomesAReadableZip() async throws {
        let w = worker(
            [setting, recordJSON("slot1", version: 3, file: (7, fileA))], files: ["saves/slot1@7": fileA])
        let got = try await exporter(w).run(to: destination, options: CloudSyncExportOptions())
        XCTAssertEqual(got.url, destination)
        XCTAssertEqual(got.settings, 1)
        XCTAssertEqual(got.records, 1)
        XCTAssertEqual(got.files, 1)
        XCTAssertEqual(got.unsynced, 2)
        XCTAssertEqual(got.entries, 7)
        XCTAssertTrue(got.skipped.isEmpty)
        let zip = try Data(contentsOf: destination)
        XCTAssertEqual(got.bytes, zip.count)
        XCTAssertEqual(
            try entries(destination).map(\.name),
            [
                "README.txt", "stores/sync.cloudSync/settings.json", "stores/sync.cloudSync/records/0.ndjson",
                "stores/sync.cloudSync/files/0.bin", "stores/sync.cloudSync/files.json",
                "stores/sync.cloudSync/index.json", "data.json",
            ])
        let file = try XCTUnwrap(try entries(destination).first { $0.name.hasSuffix("files/0.bin") })
        XCTAssertEqual(file.data, fileA)
        // The ranges were asked for in pieces the Worker chose to serve.
        let ranges = w.requests.compactMap { $0.headers["range"] }
        XCTAssertEqual(ranges.first, "bytes=0-2999")
        XCTAssertEqual(ranges.count, 3)
        XCTAssertFalse(exists(partial))
        if let t = try unzipTest(zip) { XCTAssertTrue(t.ok, t.output) }
        let data = try dataJSON(destination)
        XCTAssertEqual(data.objectValue?["encryption"], .string("server"))
        XCTAssertEqual(data.objectValue?["unsynced"], .int(2))
        XCTAssertEqual(data.objectValue?["exportedAt"], .int(1_760_000_000_000))
        // Owner-only: whatever the umask, no group or other access.
        let mode = try XCTUnwrap(
            FileManager.default.attributesOfItem(atPath: destination.path)[.posixPermissions] as? Int)
        XCTAssertEqual(mode & 0o077, 0)
    }

    func testRevisionsAreWrittenOnRequestAndNotBound() async throws {
        let w = worker(
            [recordJSON("slot1", version: 3, file: (7, fileA))],
            files: ["saves/slot1@7": fileA, "saves/slot1@5": fileB])
        w.revisions["saves/slot1"] =
            #"{"revisions":[{"version":7,"size":3000,"sha256":"\#(sha(fileA))","format":"whole"},"#
            + #"{"version":5,"size":1500,"sha256":"\#(sha(fileB))","format":"whole"},"nope"]}"#
        let live = try await exporter(w).run(to: destination, options: CloudSyncExportOptions())
        XCTAssertEqual(live.files, 1)
        let all = try await exporter(w).run(
            to: dir.appendingPathComponent("all.zip"), options: CloudSyncExportOptions(includeRevisions: true))
        XCTAssertEqual(all.files, 2)
        let index = try XCTUnwrap(
            try entries(dir.appendingPathComponent("all.zip")).first { $0.name.hasSuffix("files.json") })
        let items = try XCTUnwrap(try CanonicalJSON.parse(utf8: index.data).arrayValue)
        XCTAssertEqual(items.map { $0.objectValue?["live"] }, [.bool(true), .bool(false)])
        XCTAssertEqual(items.map { $0.objectValue?["version"] }, [.int(7), .int(5)])
    }

    func testAWorkerThatLiesAboutAContentRangeEndsTheFileShort() async throws {
        let w = worker([recordJSON("slot1", version: 3, file: (7, fileA))], files: ["saves/slot1@7": fileA])
        w.contentRangeLies = true
        let got = try await exporter(w).run(to: destination, options: CloudSyncExportOptions())
        XCTAssertEqual(
            got.skipped,
            [
                CloudSyncExportSkipped(
                    kind: "file", code: "sync-file-invalid", collection: "saves",
                    entry: "stores/sync.cloudSync/files/0.bin", partial: true)
            ])
        let file = try XCTUnwrap(try entries(destination).first { $0.name.hasSuffix("files/0.bin") })
        XCTAssertTrue(file.data.count < fileA.count)
    }

    func testAFileTheWorkerNoLongerHasIsListedPartial() async throws {
        let w = worker([recordJSON("slot1", version: 3, file: (7, fileA))])
        let got = try await exporter(w).run(to: destination, options: CloudSyncExportOptions())
        XCTAssertEqual(got.files, 1)
        XCTAssertEqual(got.skipped.map(\.partial), [true])
    }

    // MARK: the destination

    func testThePartialIsCreatedBeforeTheFirstByteAndAskedToBeProtected() async throws {
        let w = worker([setting])
        let seen = Box<(path: String, size: Int, mode: Int)?>(nil)
        let protect: @Sendable (String) throws -> Void = { path in
            var st = stat()
            _ = lstat(path, &st)
            seen.set((path, Int(st.st_size), Int(st.st_mode & 0o777)))
        }
        _ = try await exporter(w, protect: protect).run(to: destination, options: CloudSyncExportOptions())
        let call = try XCTUnwrap(seen.current)
        XCTAssertEqual(call.path, partial.path)
        XCTAssertEqual(call.size, 0, "before the first byte")
        XCTAssertEqual(call.mode & 0o077, 0, "owner-only at creation")
        XCTAssertFalse(exists(partial))
    }

    func testAProtectionThatCannotBeSetRefusesTheDestination() async throws {
        struct Refused: Error {}
        let w = worker([setting])
        let protect: @Sendable (String) throws -> Void = { _ in throw Refused() }
        do {
            _ = try await exporter(w, protect: protect).run(to: destination, options: CloudSyncExportOptions())
            XCTFail("an unprotected file was written")
        } catch { XCTAssertEqual(reason(error), "destination") }
        XCTAssertFalse(exists(partial))
        XCTAssertFalse(exists(destination))
    }

    func testAStaleRegularPartialIsRemoved() async throws {
        try Data("left by a crash".utf8).write(to: partial)
        let got = try await exporter(worker([setting])).run(to: destination, options: CloudSyncExportOptions())
        XCTAssertEqual(got.settings, 1)
        XCTAssertFalse(exists(partial))
        XCTAssertEqual(try entries(destination).first?.name, "README.txt")
    }

    func testAPlantedLinkAsThePartialIsRefusedAndItsTargetUntouched() async throws {
        let victim = dir.appendingPathComponent("victim")
        try Data("mine".utf8).write(to: victim)
        try FileManager.default.createSymbolicLink(at: partial, withDestinationURL: victim)
        do {
            _ = try await exporter(worker([setting])).run(to: destination, options: CloudSyncExportOptions())
            XCTFail("a link was followed")
        } catch { XCTAssertEqual(reason(error), "destination") }
        XCTAssertEqual(try Data(contentsOf: victim), Data("mine".utf8))
        XCTAssertFalse(exists(destination))
    }

    func testALinkOrADirectoryAsTheDestinationIsRefused() async throws {
        let victim = dir.appendingPathComponent("victim")
        try Data("mine".utf8).write(to: victim)
        try FileManager.default.createSymbolicLink(at: destination, withDestinationURL: victim)
        do {
            _ = try await exporter(worker([setting])).run(to: destination, options: CloudSyncExportOptions())
            XCTFail("a link destination was written")
        } catch { XCTAssertEqual(reason(error), "destination") }
        XCTAssertEqual(try Data(contentsOf: victim), Data("mine".utf8))
        let folder = dir.appendingPathComponent("folder")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
        do {
            _ = try await exporter(worker([setting])).run(to: folder, options: CloudSyncExportOptions())
            XCTFail("a directory destination was written")
        } catch { XCTAssertEqual(reason(error), "destination") }
        do {
            _ = try await exporter(worker([setting])).run(
                to: dir.appendingPathComponent("missing/x.zip"), options: CloudSyncExportOptions())
            XCTFail("a missing folder was written")
        } catch { XCTAssertEqual(reason(error), "destination") }
        do {
            _ = try await exporter(worker([setting])).run(
                to: URL(string: "https://example.com/x.zip")!, options: CloudSyncExportOptions())
            XCTFail("a web address was written")
        } catch { XCTAssertEqual(reason(error), "destination") }
    }

    func testAFullDiskIsADestinationFailureAndTheOldFileSurvives() async throws {
        try Data("the old export".utf8).write(to: destination)
        let w = worker([setting, recordJSON("slot1", version: 3, file: (7, fileA))], files: ["saves/slot1@7": fileA])
        let written = Box(0)
        let writer: @Sendable (Int32, UnsafeRawPointer, Int) -> Int = { fd, bytes, count in
            if written.current > 2000 {
                errno = ENOSPC
                return -1
            }
            let n = exportWriteBytes(fd, bytes, count)
            if n > 0 { written.with { $0 += n } }
            return n
        }
        do {
            _ = try await exporter(w, writer: writer).run(to: destination, options: CloudSyncExportOptions())
            XCTFail("a full disk was not noticed")
        } catch { XCTAssertEqual(reason(error), "destination") }
        XCTAssertEqual(try Data(contentsOf: destination), Data("the old export".utf8))
        XCTAssertFalse(exists(partial))
    }

    func testTheOldFileIsReplacedOnlyOnSuccess() async throws {
        try Data("the old export".utf8).write(to: destination)
        _ = try await exporter(worker([setting])).run(to: destination, options: CloudSyncExportOptions())
        XCTAssertEqual(try entries(destination).first?.name, "README.txt")
    }

    func testAPlanRefusalCreatesNothingAndReadsNoFile() async throws {
        try Data("the old export".utf8).write(to: destination)
        let huge =
            #"{"record":["saves","big"],"value":{},"version":1,"file":{"version":1,"size":5000000000,"sha256":"\#(sha(fileA))","format":"whole"}}"#
        let w = worker([huge])
        do {
            _ = try await exporter(w).run(to: destination, options: CloudSyncExportOptions())
            XCTFail("an over-cap export was written")
        } catch let e as PolarisError { XCTAssertEqual(e.code, ErrorCode.syncExportTooLarge) }
        XCTAssertEqual(try Data(contentsOf: destination), Data("the old export".utf8))
        XCTAssertFalse(exists(partial))
        XCTAssertTrue(w.requests.filter { $0.url.path.contains("/files/") && $0.headers["range"] != nil }.isEmpty)
    }

    // MARK: cancel

    func testACancelMidExportRemovesThePartialAndKeepsTheOldFile() async throws {
        try Data("the old export".utf8).write(to: destination)
        let w = worker(
            [setting, recordJSON("a", version: 1, file: (7, fileA)), recordJSON("b", version: 2, file: (8, fileB))],
            files: ["saves/a@7": fileA, "saves/b@8": fileB])
        let task = Box<Task<CloudSyncExport, Error>?>(nil)
        let options = CloudSyncExportOptions(onProgress: { p in if p.done > 0 { task.current?.cancel() } })
        let ex = exporter(w)
        let dest = destination
        task.set(Task { try await ex.run(to: dest, options: options) })
        do {
            _ = try await task.current!.value
            XCTFail("a cancelled export finished")
        } catch let e as PolarisError { XCTAssertEqual(e.code, ErrorCode.cancelled) }
        XCTAssertEqual(try Data(contentsOf: destination), Data("the old export".utf8))
        XCTAssertFalse(exists(partial))
    }

    func testACancelBeforeTheStartCreatesNothing() async throws {
        let w = worker([setting])
        let ex = exporter(w)
        let dest = destination
        let task = Task {
            while !Task.isCancelled { await Task.yield() }
            return try await ex.run(to: dest, options: CloudSyncExportOptions())
        }
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("a cancelled export ran")
        } catch let e as PolarisError { XCTAssertEqual(e.code, ErrorCode.cancelled) }
        XCTAssertFalse(exists(destination) || exists(partial))
        XCTAssertEqual(w.pulls, 0)
    }

    // MARK: pulls and waits

    func testAnEndlessMoreIsStoppedAtTheBound() async throws {
        let w = worker([setting])
        w.more = true
        do {
            _ = try await exporter(w).run(to: destination, options: CloudSyncExportOptions())
            XCTFail("an endless pull finished")
        } catch { XCTAssertEqual(reason(error), "network") }
        XCTAssertEqual(w.pulls, SYNC_EXPORT_MAX_PULLS)
        XCTAssertFalse(exists(destination) || exists(partial))
    }

    func testRetryAfterIsCutAndTheWaitsAreBounded() async throws {
        let w = worker([setting])
        w.pullStatus = 429
        w.pullHeaders = ["retry-after": "5000"]
        let slept = Box<[Double]>([])
        let sleep: @Sendable (Double) async throws -> Void = { s in slept.with { $0.append(s) } }
        let waiting = Box<[Bool]>([])
        let options = CloudSyncExportOptions(onProgress: { p in waiting.with { $0.append(p.waiting) } })
        do {
            _ = try await exporter(w, sleep: sleep).run(to: destination, options: options)
            XCTFail("a Worker that always waits was waited out")
        } catch { XCTAssertEqual(reason(error), "network") }
        let cut = Double(SYNC_EXPORT_RETRY_AFTER_MAX_MS) / 1000
        XCTAssertEqual(
            slept.current, Array(repeating: cut, count: SYNC_EXPORT_MAX_WAIT_MS / SYNC_EXPORT_RETRY_AFTER_MAX_MS))
        XCTAssertEqual(waiting.current.filter { $0 }.count, slept.current.count)
        XCTAssertFalse(exists(destination) || exists(partial))
    }

    func testACancelEndsAWaitAtOnce() async throws {
        let w = worker([setting])
        w.pullStatus = 429
        w.pullHeaders = ["retry-after": "600"]
        let entered = Box(false)
        let sleep: @Sendable (Double) async throws -> Void = { s in
            entered.set(true)
            try await Task.sleep(for: .seconds(s))
        }
        let ex = exporter(w, sleep: sleep)
        let dest = destination
        let task = Task { try await ex.run(to: dest, options: CloudSyncExportOptions()) }
        let end = Date().addingTimeInterval(10)
        while !entered.current && Date() < end { try await Task.sleep(nanoseconds: 5_000_000) }
        XCTAssertTrue(entered.current)
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("a cancelled wait finished")
        } catch let e as PolarisError { XCTAssertEqual(e.code, ErrorCode.cancelled) }
        XCTAssertFalse(exists(destination) || exists(partial))
    }

    func testAnAnswerThatIsNotJsonIsANetworkFailure() async throws {
        final class Junk: PolarisTransport, @unchecked Sendable {
            func send(_ request: PolarisRequest) async throws -> PolarisResponse {
                PolarisResponse(status: 200, body: Data("<html>".utf8))
            }
        }
        var deps = ExportDeps(
            product: "demo", baseUrl: "https://key.example", transport: Junk(), headers: { [:] },
            token: { "pkeyt_secret" }, basis: { ExportBasis(e2e: false, clientId: "cid", codec: nil, fileCodec: nil) },
            flush: { 0 })
        deps.now = { 0 }
        do {
            _ = try await CloudSyncExporter(deps).run(to: destination, options: CloudSyncExportOptions())
            XCTFail("junk was exported")
        } catch { XCTAssertEqual(reason(error), "network") }
    }

    // MARK: preconditions and one at a time

    func testAPreconditionThatFailsReadsAndWritesNothing() async throws {
        let w = worker([setting])
        let refuse: @Sendable () async throws -> ExportBasis = {
            throw PolarisError(code: ErrorCode.syncLocked, message: "locked")
        }
        do {
            _ = try await exporter(w, basis: refuse).run(to: destination, options: CloudSyncExportOptions())
            XCTFail("a locked export ran")
        } catch let e as PolarisError { XCTAssertEqual(e.code, ErrorCode.syncLocked) }
        XCTAssertEqual(w.requests.count, 0)
        XCTAssertFalse(exists(destination) || exists(partial))
    }

    func testASecondExportOfTheSameClientIsBusy() async throws {
        let w = worker([setting])
        let entered = Box(false)
        let release = Box(false)
        w.gate = {
            entered.set(true)
            while !release.current { try? await Task.sleep(nanoseconds: 2_000_000) }
        }
        let ex = exporter(w)
        let dest = destination
        let first = Task { try await ex.run(to: dest, options: CloudSyncExportOptions()) }
        let end = Date().addingTimeInterval(10)
        while !entered.current && Date() < end { try await Task.sleep(nanoseconds: 2_000_000) }
        XCTAssertTrue(entered.current)
        do {
            _ = try await ex.run(to: dir.appendingPathComponent("two.zip"), options: CloudSyncExportOptions())
            XCTFail("two exports ran at once")
        } catch { XCTAssertEqual(reason(error), "busy") }
        release.set(true)
        _ = try await first.value
        // The flag is released: another export may run now.
        _ = try await ex.run(to: dir.appendingPathComponent("three.zip"), options: CloudSyncExportOptions())
    }

    func testTheBearerIsSentOnlyToTheProductsOwnRoutes() async throws {
        let w = worker([setting, recordJSON("slot1", version: 3, file: (7, fileA))], files: ["saves/slot1@7": fileA])
        _ = try await exporter(w).run(to: destination, options: CloudSyncExportOptions())
        for r in w.requests {
            XCTAssertEqual(r.url.host, "key.example")
            XCTAssertTrue(r.url.path.hasPrefix("/demo/sync"))
            XCTAssertEqual(r.headers["authorization"], "Bearer pkeyt_secret")
            XCTAssertFalse(r.followRedirects)
        }
    }
}

// MARK: the live wiring

private let clientMirror: JSONValue = try! JSONDecoder().decode(
    JSONValue.self,
    from: Data(
        """
        {"schemaVersion":1,"entries":[
          {"key":"audio.volume","kind":"config","schema":{"type":"number"},"user":{"sync":"user","conflict":"lastWrite"}}]}
        """.utf8))

/// Text, because the stub server answers with strings.
private let clientFile = Data(String(repeating: "save-data-", count: 300).utf8)

private let exportAlice = "ps_AliceAliceAliceAlice1"

/// A client over a stub Worker (server mode) whose pull holds a setting and a save with a file.
final class CloudSyncExportClientTests: XCTestCase {
    private let signer = TestSigner(kid: "sync-kid")
    private var server = StubServer()
    private var dir = FileManager.default.temporaryDirectory

    override func setUp() async throws {
        server = StubServer()
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("pk-exportc-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDown() async throws { try? FileManager.default.removeItem(at: dir) }

    private func serve(sync: Bool = true) async {
        let services = sync ? #","sync":{"enabled":true,"encryption":"server"}"# : ""
        await server.reply(
            "/djdl/.well-known/polaris.json",
            body: #"{"product":"djdl","services":{"license":{"enabled":true},"config":{"enabled":true}\#(services)}}"#)
        let file = #"{"version":4,"size":\#(clientFile.count),"sha256":"\#(sha(clientFile))","format":"whole"}"#
        let pull =
            #"{"encryption":"server","subject":"\#(exportAlice)","cursor":1,"more":false,"serverNow":1760000000000,"#
            + #""catalogVersion":1,"lastMutationId":0,"changes":[{"setting":"audio.volume","scope":"user","value":0.5,"version":2},"#
            + #"{"record":["saves","slot1"],"value":{"n":1},"version":3,"file":\#(file)}],"tombstones":[],"aliases":{},"#
            + #""usage":{"bytes":0,"settings":0,"records":0,"files":0},"quota":{"bytes":268435456,"files":true}}"#
        await server.route("/djdl/sync") { _ in StubServer.Reply(body: pull) }
        await server.route("/djdl/sync/ops") { req in
            let ids =
                ((try? JSONSerialization.jsonObject(with: req.body ?? Data())) as? [String: Any])
                .flatMap { $0["mutations"] as? [[String: Any]] }?.compactMap { $0["mutationId"] as? Int } ?? []
            let results = ids.map { #"{"mutationId":\#($0),"status":"ok","version":2}"# }.joined(separator: ",")
            return StubServer.Reply(
                body: pull.replacingOccurrences(of: #""changes":["#, with: #""results":[\#(results)],"changes":["#))
        }
        await server.route("/djdl/sync/files/saves/slot1") { req in
            guard let range = req.headers["range"], range.hasPrefix("bytes=") else {
                return StubServer.Reply(status: 404)
            }
            let ends = range.dropFirst(6).split(separator: "-").compactMap { Int($0) }
            let part = clientFile.subdata(in: ends[0]..<min(clientFile.count, ends[1] + 1))
            return StubServer.Reply(
                status: 206, body: String(decoding: part, as: UTF8.self),
                headers: ["content-range": "bytes \(ends[0])-\(ends[0] + part.count - 1)/\(clientFile.count)"])
        }
    }

    private func client(sync: Bool = true, token: String? = "pkeyt_alice") async throws -> PolarisKeyClient {
        await serve(sync: sync)
        let store = InMemoryStore(deviceId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
        if let token { await store.setToken(token) }
        let keys = try DeviceKeyStore.inMemory(productSlug: "djdl")
        _ = try await keys.ensure()
        let core = CoreOptions(
            productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0", pinnedKeys: signer.trust,
            trustRefresh: false, store: store, transport: server.transport,
            expectedServices: sync ? [.license, .config, .sync] : [.license, .config], stateDir: dir)
        let client = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                core: core, license: LicenseClientOptions(fingerprint: false),
                connect: ConnectOptions(keys: keys, allowEphemeralKeys: true),
                cloudSync: CloudSyncOptions(encryption: .server, catalog: clientMirror)))
        let roots = RingRootStore.inMemory()
        try client.configureKeyring(SyncKeyringOptions(keys: keys, rootStore: roots))
        return client
    }

    private func signedIn() async throws -> PolarisKeyClient {
        let client = try await client()
        client.identity.updateSubject(exportAlice)
        let end = Date().addingTimeInterval(5)
        while Date() < end {
            if try await client.cloudSync.status().state != .local { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        return client
    }

    func testAnExportThroughTheClientWritesTheSyncedData() async throws {
        let client = try await signedIn()
        let destination = dir.appendingPathComponent("mine.zip")
        let got = try await client.cloudSync.export(to: destination)
        XCTAssertEqual(got.settings, 1)
        XCTAssertEqual(got.records, 1)
        XCTAssertEqual(got.files, 1)
        let zip = try Data(contentsOf: destination)
        let names = try readStoredZip(zip).map(\.name)
        XCTAssertEqual(names.first, "README.txt")
        XCTAssertEqual(names.last, "data.json")
        let file = try XCTUnwrap(try readStoredZip(zip).first { $0.name.hasSuffix("files/0.bin") })
        XCTAssertEqual(file.data, clientFile)
        let requests = await server.requests
        XCTAssertTrue(
            requests.contains { $0.url.path == "/djdl/sync" && ($0.url.query ?? "").hasPrefix("cursor=0&clientId=") })
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path + ".partial"))
    }

    func testAProductWithoutTheSyncServiceAnswersTheTypedNotApplicable() async throws {
        let client = try await client(sync: false)
        do {
            _ = try await client.cloudSync.export(to: dir.appendingPathComponent("x.zip"))
            XCTFail("an export ran without the Sync service")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.serviceUnavailable)
            XCTAssertEqual(e.unsupported?.feature, Feature.syncExport)
            XCTAssertEqual(e.unsupported?.reason, UnsupportedReason.product)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("x.zip").path))
    }

    func testASignedOutPersonIsRefusedBeforeAnythingIsRead() async throws {
        let client = try await client(token: nil)
        do {
            _ = try await client.cloudSync.export(to: dir.appendingPathComponent("x.zip"))
            XCTFail("a signed-out export ran")
        } catch let e as PolarisError { XCTAssertEqual(e.code, ErrorCode.accountRequired) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("x.zip").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("x.zip.partial").path))
    }
}
