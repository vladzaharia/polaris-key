// @pkey-feature sync.transfer.background
//
// Cloud Sync background transfers (U-41.1, U-41.2) over a stubbed session port: the spool and its
// protection, the task tag, a fresh bearer per task and one refresh on a 401, a cancel that wins, the close
// that sign-out, forget and lock share, the delegate feeding the journal after a relaunch, reconcile, the
// app-delegate completion, and the engine running over the channel. The real `URLSession` is not run here.
//
// NEEDS A SIMULATOR (follow-up, CI macOS only): `BackgroundSessionSimulatorTests` below runs the real
// background session in an iOS simulator and is skipped everywhere else. Do not run it on a machine whose
// simulators hang.

import CryptoKit
import Foundation
import PolarisKeyCore
import XCTest

@testable import PolarisKey

// MARK: Stubs

private final class StubTask: BackgroundTaskRef, @unchecked Sendable {
    let taskIdentifier: Int
    let tag: String?
    let url: URL?
    let upload: URL?
    let request: URLRequest
    let lock = NSLock()
    var resumed = false
    var cancelled = false
    var start: (@Sendable (StubTask) -> Void)?
    init(id: Int, request: URLRequest, tag: String, upload: URL?) {
        taskIdentifier = id
        self.tag = tag
        self.request = request
        url = request.url
        self.upload = upload
    }
    func resume() {
        lock.withLock { resumed = true }
        start?(self)
    }
    func cancel() { lock.withLock { cancelled = true } }
    var isCancelled: Bool { lock.withLock { cancelled } }
    var isResumed: Bool { lock.withLock { resumed } }
}

private final class StubSession: BackgroundSessionPort, @unchecked Sendable {
    let lock = NSLock()
    private(set) var tasks: [StubTask] = []
    private var next = 1
    weak var sink: (any BackgroundSink)?
    /// Called when a task is resumed; may complete it.
    var onStart: (@Sendable (StubTask) -> Void)?
    var uploadedBodies: [Int: Data] = [:]

    func start(sink: any BackgroundSink) { self.sink = sink }

    private func make(_ r: URLRequest, _ tag: String, _ file: URL?) -> StubTask {
        lock.withLock {
            let t = StubTask(id: next, request: r, tag: tag, upload: file)
            t.start = { [weak self] t in self?.onStart?(t) }
            next += 1
            tasks.append(t)
            if let file { uploadedBodies[t.taskIdentifier] = try? Data(contentsOf: file) }
            return t
        }
    }
    func makeUpload(_ r: URLRequest, from file: URL, tag: String, maxBody: Int) -> any BackgroundTaskRef {
        make(r, tag, file)
    }
    func makeDownload(_ r: URLRequest, tag: String, maxBody: Int) -> any BackgroundTaskRef { make(r, tag, nil) }
    func liveTasks() async -> [any BackgroundTaskRef] { lock.withLock { tasks.filter { !$0.isCancelled } } }

    /// Add a task the system kept across a relaunch.
    func adopt(url: String, tag: String) -> StubTask {
        var r = URLRequest(url: URL(string: url)!)
        r.httpMethod = "PUT"
        return make(r, tag, nil)
    }

    func finish(
        _ t: StubTask, status: Int = 200, body: Data = Data(), headers: [String: String] = [:],
        error: (any Error)? = nil
    ) {
        sink?.taskFinished(
            BackgroundResult(
                taskIdentifier: t.taskIdentifier, tag: t.tag, url: t.url, status: status, headers: headers,
                body: body, error: error))
    }
    func finishEvents() { sink?.sessionFinishedEvents() }
}

private final class Token: @unchecked Sendable {
    let lock = NSLock()
    var value: String? = "tok-1"
    var refreshes = 0
    var next: String? = "tok-2"
    var tokens: BackgroundTokens {
        BackgroundTokens(
            current: { self.lock.withLock { self.value } },
            refresh: {
                self.lock.withLock {
                    self.refreshes += 1
                    self.value = self.next
                    return self.value
                }
            })
    }
}

private struct Rig {
    let dir: URL
    let session = StubSession()
    let token = Token()
    let journal = MemoryJournal()
    let channel: CloudSyncBackground
    let resumed = Collected<[String]>([])
    var spool: URL { dir.appendingPathComponent(cloudSyncSpoolDirName, isDirectory: true) }

    init(maxTaskAge: Double = 1800, now: @escaping @Sendable () -> Double = { 1_000_000 }) {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("pkbg-\(UUID().uuidString)")
        let session = self.session
        let token = self.token
        let resumed = self.resumed
        channel = CloudSyncBackground(
            product: "djdl", stateDir: dir, journal: journal, port: session, tokens: token.tokens,
            maxTaskAge: maxTaskAge, now: now, onResume: { ids in resumed.update { $0 += ids } })
    }

    var spoolFiles: [String] { ((try? FileManager.default.contentsOfDirectory(atPath: spool.path)) ?? []).sorted() }
    func cleanup() { try? FileManager.default.removeItem(at: dir) }
}

private final class Collected<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var v: T
    init(_ v: T) { self.v = v }
    var value: T { lock.withLock { v } }
    func update(_ f: (inout T) -> Void) { lock.withLock { f(&v) } }
}

private let hex64 = String(repeating: "ab", count: 32)
private let partURL = URL(string: "https://key.plrs.im/djdl/sync/files/saves/rec1/upload/up1/parts/2")!

private func putRequest(_ body: Data, url: URL = partURL, token: String = "stale-from-engine") -> PolarisRequest {
    PolarisRequest(
        url: url, method: "PUT",
        headers: ["authorization": "Bearer \(token)", "content-digest": "sha-256=:AAAA:"], body: body,
        timeoutSeconds: 30, maxBodyBytes: 65_537, followRedirects: false)
}

private func waitFor(_ cond: @autoclosure () -> Bool, _ what: String = "") async throws {
    for _ in 0..<400 {
        if cond() { return }
        try await Task.sleep(nanoseconds: 5_000_000)
    }
    XCTFail("timed out: \(what)")
}

private func journalRecord(mode: String = "multipart", done: [Int] = [1], uploadId: String = "up1") -> JournalRecord {
    JournalRecord(
        v: 1, id: "t1", kind: "upload", collection: "saves", record: "rec1", uploadId: uploadId, mode: mode,
        partBytes: mode == "multipart" ? 5 : nil, done: mode == "chunks" ? [] : done, sha256: hex64, size: 20,
        expiresAt: 9e15, state: "uploading")
}

// MARK: Tests

final class CloudSyncBackgroundTests: XCTestCase {
    func testTheTagRoundTripsAndRefusesWhatIsNotOurs() {
        let t = BackgroundTag(
            idHash: hex64, kind: .up, part: 3, enqueuedAt: 99, spool: String(repeating: "0a", count: 16) + ".bin")
        XCTAssertEqual(BackgroundTag.parse(t.text), t)
        XCTAssertEqual(
            BackgroundTag.parse(BackgroundTag(idHash: hex64, kind: .dn, part: 0, enqueuedAt: 1, spool: nil).text)?
                .spool, nil)
        for bad in [
            nil, "", "pkbg2|\(hex64)|up|1|1|-", "pkbg1|xyz|up|1|1|-", "pkbg1|\(hex64)|sideways|1|1|-",
            "pkbg1|\(hex64)|up|-1|1|-", "pkbg1|\(hex64)|up|1|1|../../etc/passwd", "pkbg1|\(hex64)|up|1|1",
        ] { XCTAssertNil(BackgroundTag.parse(bad), bad ?? "nil") }
    }

    func testAPartIsSpooledProtectedAndSentFromAFileWithAFreshBearer() async throws {
        let rig = Rig()
        defer { rig.cleanup() }
        let body = Data("sealed bytes".utf8)
        // Start the call, look at the task while it waits.
        let call = Task {
            try await TransferScope.$id.withValue("transfer-7") { try await rig.channel.perform(putRequest(body)) }
        }
        try await waitFor(rig.session.tasks.first?.isResumed == true, "task resumed")
        let task = rig.session.tasks[0]
        // The bearer is the store's, read now; the engine's older one is gone.
        XCTAssertEqual(task.request.value(forHTTPHeaderField: "Authorization"), "Bearer tok-1")
        XCTAssertEqual(task.request.value(forHTTPHeaderField: "content-digest"), "sha-256=:AAAA:")
        // Uploaded from a file in the spool, which holds the body and is private.
        let file = try XCTUnwrap(task.upload)
        XCTAssertEqual(rig.session.uploadedBodies[task.taskIdentifier], body)
        XCTAssertEqual(file.deletingLastPathComponent().standardizedFileURL, rig.spool.standardizedFileURL)
        let attrs = try FileManager.default.attributesOfItem(atPath: file.path)
        XCTAssertEqual((attrs[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        let dirAttrs = try FileManager.default.attributesOfItem(atPath: rig.spool.path)
        XCTAssertEqual((dirAttrs[.posixPermissions] as? NSNumber)?.intValue, 0o700)
        let values = try rig.spool.resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, true)
        // The tag has the id's hash and the part, never the id.
        let tag = try XCTUnwrap(BackgroundTag.parse(task.tag))
        XCTAssertEqual(tag.idHash, backgroundIdHash("transfer-7"))
        XCTAssertEqual(tag.part, 2)
        XCTAssertEqual(tag.kind, .up)
        XCTAssertFalse(try XCTUnwrap(task.tag).contains("transfer-7"))
        XCTAssertFalse(task.request.allHTTPHeaderFields?.values.contains { $0.contains("stale-from-engine") } ?? false)
        rig.session.finish(task, status: 204)
        let res = try await call.value
        XCTAssertEqual(res.status, 204)
        XCTAssertEqual(rig.spoolFiles, [], "the spool file goes with the task")
    }

    func testA401RefreshesOnceAndSendsTheTaskAgainWithTheNewToken() async throws {
        let rig = Rig()
        defer { rig.cleanup() }
        let call = Task { try await rig.channel.perform(putRequest(Data("x".utf8))) }
        try await waitFor(rig.session.tasks.first?.isResumed == true)
        rig.session.finish(rig.session.tasks[0], status: 401)
        try await waitFor(rig.session.tasks.count == 2 && rig.session.tasks[1].isResumed)
        XCTAssertEqual(rig.token.refreshes, 1)
        XCTAssertEqual(rig.session.tasks[1].request.value(forHTTPHeaderField: "Authorization"), "Bearer tok-2")
        rig.session.finish(rig.session.tasks[1], status: 401)
        let res = try await call.value
        XCTAssertEqual(res.status, 401, "a second 401 is the answer")
        XCTAssertEqual(rig.token.refreshes, 1)
        XCTAssertEqual(rig.session.tasks.count, 2)
    }

    func testNoTokenSendsNothing() async throws {
        let rig = Rig()
        defer { rig.cleanup() }
        rig.token.value = nil
        let res = try await rig.channel.perform(putRequest(Data("x".utf8)))
        XCTAssertEqual(res.status, 401)
        XCTAssertTrue(rig.session.tasks.isEmpty)
        XCTAssertEqual(rig.spoolFiles, [])
    }

    func testANetworkErrorThrowsSoTheEngineRetries() async throws {
        let rig = Rig()
        defer { rig.cleanup() }
        let call = Task { try await rig.channel.perform(putRequest(Data("x".utf8))) }
        try await waitFor(rig.session.tasks.first?.isResumed == true)
        rig.session.finish(rig.session.tasks[0], status: 0, error: URLError(.networkConnectionLost))
        do {
            _ = try await call.value
            XCTFail("expected a throw")
        } catch is URLError {
        }
        XCTAssertEqual(rig.spoolFiles, [])
    }

    func testACancelWinsAndALateCompletionNeverWritesTheJournal() async throws {
        let rig = Rig()
        defer { rig.cleanup() }
        rig.journal.put("t1", journalRecord(done: [1]))
        let call = Task {
            try await TransferScope.$id.withValue("t1") { try await rig.channel.perform(putRequest(Data("x".utf8))) }
        }
        try await waitFor(rig.session.tasks.first?.isResumed == true)
        let task = rig.session.tasks[0]
        await rig.channel.cancelTasks(transferId: "t1")
        XCTAssertTrue(task.isCancelled)
        do {
            _ = try await call.value
            XCTFail("expected aborted")
        } catch let e as TransferError {
            XCTAssertEqual(e.reason, .aborted)
        }
        XCTAssertEqual(rig.spoolFiles, [])
        // The task had already finished at the server: its completion arrives after the cancel.
        rig.session.finish(task, status: 204)
        let rec = try parseJournalRecord(rig.journal.get("t1"))
        XCTAssertEqual(rec.done, [1], "a cancelled transfer's journal is not touched")
    }

    func testCloseEndsEverythingAndNothingEnqueuesUntilOpen() async throws {
        let rig = Rig()
        defer { rig.cleanup() }
        let call = Task { try await rig.channel.perform(putRequest(Data("secret".utf8))) }
        try await waitFor(rig.session.tasks.first?.isResumed == true)
        let stranger = rig.session.adopt(url: "https://key.plrs.im/x", tag: "other")
        await rig.channel.close()
        do {
            _ = try await call.value
            XCTFail("expected aborted")
        } catch let e as TransferError {
            XCTAssertEqual(e.reason, .aborted)
        }
        XCTAssertTrue(rig.session.tasks.allSatisfy { $0.isCancelled })
        XCTAssertTrue(stranger.isCancelled)
        XCTAssertFalse(FileManager.default.fileExists(atPath: rig.spool.path), "the spool is gone")
        let before = rig.session.tasks.count
        do {
            _ = try await rig.channel.perform(putRequest(Data("later".utf8)))
            XCTFail("expected aborted")
        } catch let e as TransferError {
            XCTAssertEqual(e.reason, .aborted)
        }
        XCTAssertEqual(rig.session.tasks.count, before, "nothing is enqueued while closed")
        XCTAssertEqual(rig.spoolFiles, [])
        rig.channel.open()
        let again = Task { try await rig.channel.perform(putRequest(Data("later".utf8))) }
        try await waitFor(rig.session.tasks.count == before + 1)
        rig.session.finish(rig.session.tasks[before], status: 204)
        _ = try await again.value
    }

    func testACancelledCallerCancelsTheTask() async throws {
        let rig = Rig()
        defer { rig.cleanup() }
        let call = Task { try await rig.channel.perform(putRequest(Data("x".utf8))) }
        try await waitFor(rig.session.tasks.first?.isResumed == true)
        call.cancel()
        do {
            _ = try await call.value
            XCTFail("expected aborted")
        } catch let e as TransferError {
            XCTAssertEqual(e.reason, .aborted)
        }
        XCTAssertTrue(rig.session.tasks[0].isCancelled)
        XCTAssertEqual(rig.spoolFiles, [])
    }

    // MARK: relaunch

    private func orphan(_ rig: Rig, id: String = "t1", part: Int = 2, url: String? = nil, at: Int = 1_000_000)
        -> StubTask
    {
        let tag = BackgroundTag(idHash: backgroundIdHash(id), kind: .up, part: part, enqueuedAt: at, spool: nil)
        return rig.session.adopt(
            url: url ?? "https://key.plrs.im/djdl/sync/files/saves/rec1/upload/up1/parts/\(part)", tag: tag.text)
    }

    func testALateCompletionFeedsTheJournal() throws {
        let rig = Rig()
        defer { rig.cleanup() }
        rig.journal.put("t1", journalRecord(done: [1]))
        rig.session.finish(orphan(rig), status: 204)
        XCTAssertEqual(try parseJournalRecord(rig.journal.get("t1")).done, [1, 2])
    }

    func testALateCompletionThatDoesNotMatchTheRecordIsIgnored() throws {
        let rig = Rig()
        defer { rig.cleanup() }
        rig.journal.put("t1", journalRecord(done: [1]))
        // Another upload id; a failure; a non-2xx; a transfer with no record; a chunks upload.
        rig.session.finish(
            orphan(rig, url: "https://key.plrs.im/djdl/sync/files/saves/rec1/upload/other/parts/2"), status: 204)
        rig.session.finish(orphan(rig), status: 500)
        rig.session.finish(orphan(rig), status: 0, error: URLError(.timedOut))
        rig.session.finish(orphan(rig, id: "nobody"), status: 204)
        rig.session.finish(
            orphan(rig, part: 9, url: "https://key.plrs.im/djdl/sync/files/saves/rec1/upload/up1/parts/2"), status: 204)
        XCTAssertEqual(try parseJournalRecord(rig.journal.get("t1")).done, [1])
        rig.journal.put("t1", journalRecord(mode: "chunks"))
        rig.session.finish(
            orphan(rig, part: 0, url: "https://key.plrs.im/djdl/sync/files/saves/rec1/upload/up1/chunks/\(hex64)"),
            status: 204)
        XCTAssertEqual(try parseJournalRecord(rig.journal.get("t1")).done, [])
    }

    func testAnOrphan401AsksForAResume() {
        let rig = Rig()
        defer { rig.cleanup() }
        rig.journal.put("t1", journalRecord())
        rig.session.finish(orphan(rig), status: 401)
        XCTAssertEqual(rig.resumed.value, ["t1"])
    }

    func testReconcileCancelsWhatCannotBeTrustedAndRefreshesTheTokenOnce() async throws {
        let rig = Rig(maxTaskAge: 600, now: { 1_000_000 })
        defer { rig.cleanup() }
        rig.journal.put("t1", journalRecord())
        rig.journal.put("t2", journalRecord())
        let fresh = orphan(rig, id: "t1", part: 2, at: 999_900)
        let stale1 = orphan(rig, id: "t1", part: 3, at: 1_000_000 - 601)
        let stale2 = orphan(rig, id: "t2", part: 3, at: 1_000_000 - 9000)
        let nobody = orphan(rig, id: "gone", at: 999_900)
        let foreign = rig.session.adopt(url: "https://example.com/", tag: "not-ours")
        // Spool: one file a live task owns, one nobody owns.
        let owned = String(repeating: "1a", count: 16) + ".bin"
        let loose = String(repeating: "2b", count: 16) + ".bin"
        try FileManager.default.createDirectory(at: rig.spool, withIntermediateDirectories: true)
        try Data("a".utf8).write(to: rig.spool.appendingPathComponent(owned))
        try Data("b".utf8).write(to: rig.spool.appendingPathComponent(loose))
        let keeper = BackgroundTag(
            idHash: backgroundIdHash("t1"), kind: .up, part: 4, enqueuedAt: 999_950, spool: owned)
        _ = rig.session.adopt(
            url: "https://key.plrs.im/djdl/sync/files/saves/rec1/upload/up1/parts/4", tag: keeper.text)

        let report = await rig.channel.reconcile()
        XCTAssertFalse(fresh.isCancelled)
        XCTAssertTrue(stale1.isCancelled && stale2.isCancelled && nobody.isCancelled && foreign.isCancelled)
        XCTAssertEqual(report.cancelledTasks, 4)
        XCTAssertEqual(report.resume, ["t1", "t2"])
        XCTAssertEqual(rig.token.refreshes, 1, "one refresh for the whole pass, before anything is re-enqueued")
        XCTAssertEqual(rig.resumed.value, ["t1", "t2"])
        XCTAssertEqual(rig.spoolFiles, [owned])
        XCTAssertEqual(report.sweptFiles, 1)
    }

    func testReconcileWithNothingStaleDoesNotTouchTheToken() async {
        let rig = Rig()
        defer { rig.cleanup() }
        rig.journal.put("t1", journalRecord())
        let t = orphan(rig)
        let report = await rig.channel.reconcile()
        XCTAssertFalse(t.isCancelled)
        XCTAssertEqual(report, BackgroundReconcileReport())
        XCTAssertEqual(rig.token.refreshes, 0)
    }

    // MARK: the app delegate

    func testTheSystemCompletionRunsOnMainAfterTheSessionsEvents() async throws {
        let rig = Rig()
        defer { rig.cleanup() }
        let ran = Collected(0)
        rig.channel.handleEvents { ran.update { $0 += 1 } }
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(ran.value, 0, "not before the delegate has delivered its events")
        rig.session.finishEvents()
        try await waitFor(ran.value == 1, "completion")
        // Events that finished before the delegate call: it runs at once.
        rig.session.finishEvents()
        rig.channel.handleEvents { ran.update { $0 += 1 } }
        try await waitFor(ran.value == 2, "completion after events")
    }

    func testTheRegistryHoldsACompletionUntilTheClientsSessionExists() async throws {
        let id = "pkey.sync.regtest-\(UUID().uuidString.prefix(6).lowercased())"
        let ran = Collected(0)
        XCTAssertFalse(PolarisKeyClient.handleBackgroundEvents(identifier: "com.other.session") { ran.update { $0 += 1 } })
        XCTAssertTrue(PolarisKeyClient.handleBackgroundEvents(identifier: id) { ran.update { $0 += 1 } })
        // The product is the identifier's tail.
        let product = String(id.dropFirst("pkey.sync.".count))
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("pkbg-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let session = StubSession()
        let channel = CloudSyncBackground(
            product: product, stateDir: dir, journal: MemoryJournal(), port: session, tokens: Token().tokens)
        XCTAssertEqual(channel.identifier, id)
        CloudSyncBackgroundRegistry.shared.register(channel)
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(ran.value, 0)
        session.finishEvents()
        try await waitFor(ran.value == 1, "held completion")
        CloudSyncBackgroundRegistry.shared.unregister(channel)
    }

    // MARK: the engine over the channel

    func testAnUploadRunsThroughTheEngineOverTheChannelAndACancelStopsItsTasks() async throws {
        let rig = Rig()
        defer { rig.cleanup() }
        let foreground = JSONStub()
        let transport = CloudSyncFileTransport(
            product: "djdl", baseUrl: "https://key.plrs.im", transport: foreground, headers: { [:] },
            token: { "tok-1" }, bulk: rig.channel)
        let engine = FileTransferEngine(transport: transport, journal: rig.journal)
        let data = Data("a small save".utf8)
        rig.session.onStart = { [session = rig.session] t in session.finish(t, status: 204) }
        let req = UploadRequest(
            id: "save-1", collection: "saves", record: "rec1", source: DataSource(data), size: data.count,
            sha256: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(), enc: "none")
        let answer = try await engine.upload(req)
        XCTAssertEqual(answer.objectValue?["version"], .int(1))
        let puts = rig.session.tasks
        XCTAssertEqual(puts.count, 1, "the body went through the background session")
        XCTAssertEqual(BackgroundTag.parse(puts[0].tag)?.idHash, backgroundIdHash("save-1"))
        XCTAssertEqual(foreground.paths.filter { $0.contains("/begin") || $0.contains("/finalize") }.count, 2)
        XCTAssertFalse(foreground.paths.contains { $0.contains("/parts/") }, "no body went through the foreground")

        // engine.cancel reaches the channel even with no journal record.
        rig.session.onStart = nil
        let t = rig.session.adopt(
            url: "https://key.plrs.im/djdl/sync/files/saves/rec1/upload/up1/parts/1",
            tag: BackgroundTag(idHash: backgroundIdHash("save-2"), kind: .up, part: 1, enqueuedAt: 1, spool: nil).text)
        await engine.cancel(id: "save-2")
        XCTAssertTrue(t.isCancelled)
    }
}

/// Answers `begin` (single mode) and `finalize` in the foreground.
private final class JSONStub: PolarisTransport, @unchecked Sendable {
    let lock = NSLock()
    private var seen: [String] = []
    var paths: [String] { lock.withLock { seen } }
    func send(_ request: PolarisRequest) async throws -> PolarisResponse {
        lock.withLock { seen.append(request.url.path) }
        let path = request.url.path
        if path.hasSuffix("/begin") {
            return PolarisResponse(
                status: 200,
                body: Data(#"{"uploadId":"up1","mode":"single","expiresAt":9000000000000000}"#.utf8))
        }
        if path.hasSuffix("/finalize") {
            return PolarisResponse(
                status: 200,
                body: Data(
                    #"{"version":1,"size":12,"sha256":"\#(String(repeating: "a", count: 64))","format":"whole"}"#.utf8))
        }
        return PolarisResponse(status: 404, body: Data())
    }
    func stream(_ request: PolarisRequest) async throws -> PolarisStreamResponse {
        let r = try await send(request)
        return PolarisStreamResponse(
            status: r.status, headers: r.headers,
            body: AsyncThrowingStream {
                $0.yield(r.body)
                $0.finish()
            })
    }
}

// MARK: Simulator (CI macOS only)

#if os(iOS)
    /// NEEDS A SIMULATOR. Runs the real `URLSession` adapter in an iOS simulator: a background session with
    /// the product's identifier starts, a task made through the port is listed by `liveTasks`, and cancelling
    /// it delivers a result to the sink. CI's macOS job runs it with `xcodebuild test -destination
    /// 'platform=iOS Simulator,…'`; it is not run on a development machine whose simulators hang.
    final class BackgroundSessionSimulatorTests: XCTestCase {
        private final class Sink: BackgroundSink, @unchecked Sendable {
            let finished = XCTestExpectation(description: "task finished")
            func taskFinished(_ result: BackgroundResult) { finished.fulfill() }
            func sessionFinishedEvents() {}
        }

        func testTheRealBackgroundSessionListsAndCancelsATask() async throws {
            let port = URLSessionBackgroundPort(identifier: "pkey.sync.simtest")
            let sink = Sink()
            port.start(sink: sink)
            var request = URLRequest(url: URL(string: "https://127.0.0.1:9/never")!)
            request.httpMethod = "GET"
            let task = port.makeDownload(request, tag: "pkbg1|\(hex64)|dn|0|1|-", maxBody: 1024)
            task.resume()
            let live = await port.liveTasks()
            XCTAssertTrue(live.contains { $0.taskIdentifier == task.taskIdentifier })
            task.cancel()
            await fulfillment(of: [sink.finished], timeout: 30)
        }
    }
#endif
