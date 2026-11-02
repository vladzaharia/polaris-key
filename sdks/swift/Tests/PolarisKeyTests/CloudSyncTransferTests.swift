// @pkey-feature sync.files
//
// The Cloud Sync file transfer engine, journal, chunk cache and file codecs (U-23.S4), against a fake of
// the Worker's file routes behind the `FileTransport` port. A port of the Python test_cloud_sync_files.py:
// kill-and-resume from the journal, the Retry-After hold, the 410 restart, a tampered chunk or manifest
// is `sync-file-invalid`, cache damage is a miss, journal and cache names that no id can steer, and the
// real zstd decoder behind codec 1 chunks.

import Foundation
import PolarisKeyCore
import XCTest
import libzstd

@testable import PolarisKey
#if canImport(CryptoKit)
    import CryptoKit
#else
    import Crypto
#endif

private let mib = 1_048_576
private let clockNow = 1000.0

private func noise(_ n: Int) -> Data { SyncCrypto.random(n) }
private func shaHex(_ d: Data) -> String { SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined() }
private func hexOf(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

/// A fake U-10 and U-37 server behind the port: parts in any order, chunks per collection, files by version.
private final class FakeServer: FileTransport, @unchecked Sendable {
    struct Upload {
        var size: Int
        var sha256: String
        var mode: String
        var format = "whole"
        var parts: [Int: Data] = [:]
        var manifest: Data?
    }

    let lock = NSLock()
    var uploads: [String: Upload] = [:]
    var chunks: [String: Data] = [:]
    var files: [Data] = []
    var calls: [String] = []
    var partPuts: [Int] = []
    var chunkPuts: [String] = []
    var chunkGets: [String] = []
    var fileQueries: [FileQuery] = []
    var aborted: [String] = []
    var beginRequests: [JSONValue] = []
    var planSizes: [Int] = []
    var seq = 0
    var multipartAlways = false
    var partBytes = 100_000
    var etag = "\"e1\""
    /// Breaks one kind of call: return a refusal to override, or throw for "no answer".
    var hook: @Sendable (String) throws -> FileRefusal? = { _ in nil }
    var tamperChunk: @Sendable (String, Data) -> Data = { $1 }
    var tamperFile: @Sendable (FileQuery, FileBody) -> FileBody = { $1 }
    /// Replace the answer to `begin` or to a plan call (a server that answers what it should not).
    var beginAnswer: JSONValue?
    var planAnswer: JSONValue?
    /// Rewrites the answer to `finalize` (the stored file is untouched).
    var finalizeAnswer: (@Sendable (JSONValue) -> JSONValue)?
    var versionBase = 0

    private func enter<T: Sendable>(_ kind: String, _: T.Type) throws -> FileReply<T>? {
        lock.withLock { calls.append(kind) }
        if let r = try hook(kind) { return .refused(r) }
        return nil
    }

    func begin(_ target: FileTarget, request: JSONValue) async throws -> FileReply<JSONValue> {
        lock.withLock { beginRequests.append(request) }
        if let r = try enter("begin", JSONValue.self) { return r }
        if let a = beginAnswer { return .ok(a) }
        guard case .object(let o) = request, case .int(let size)? = o["size"], case .string(let sha)? = o["sha256"]
        else {
            return .refused(FileRefusal(status: 400, code: "value_invalid"))
        }
        return lock.withLock {
            seq += 1
            let id = "up\(seq)"
            let mode =
                o["format"] == .string("chunks")
                ? "chunks" : (size <= 16 * mib && !multipartAlways ? "single" : "multipart")
            uploads[id] = Upload(
                size: size, sha256: sha, mode: mode, format: o["format"]?.stringValue ?? "whole")
            var out: [String: JSONValue] = [
                "uploadId": .string(id), "mode": .string(mode), "expiresAt": .double((clockNow + 86400) * 1000),
            ]
            if mode == "multipart" { out["partBytes"] = .int(partBytes) }
            return .ok(.object(out))
        }
    }

    func status(_ target: FileTarget, uploadId: String) async throws -> FileReply<JSONValue> {
        if let r = try enter("status", JSONValue.self) { return r }
        return lock.withLock {
            guard let u = uploads[uploadId] else { return .refused(FileRefusal(status: 410, code: "upload_expired")) }
            return .ok(.object(["received": .array(u.parts.keys.sorted().map { .int($0) })]))
        }
    }

    func putSingle(_ target: FileTarget, uploadId: String, body: Data, sha256: String) async throws -> FileReply<Void> {
        if let r = try enter("putSingle", Void.self) { return r }
        return lock.withLock {
            guard uploads[uploadId] != nil else { return .refused(FileRefusal(status: 410, code: "upload_expired")) }
            guard shaHex(body) == sha256 else { return .refused(FileRefusal(status: 400, code: "upload_mismatch")) }
            if uploads[uploadId]!.mode == "chunks" {
                uploads[uploadId]!.manifest = body
            } else {
                uploads[uploadId]!.parts[1] = body
            }
            return .ok(())
        }
    }

    func putPart(_ target: FileTarget, uploadId: String, n: Int, body: Data, sha256: String) async throws -> FileReply<
        Void
    > {
        if let r = try enter("putPart", Void.self) { return r }
        return lock.withLock {
            guard uploads[uploadId] != nil else { return .refused(FileRefusal(status: 410, code: "upload_expired")) }
            guard shaHex(body) == sha256 else { return .refused(FileRefusal(status: 400, code: "upload_mismatch")) }
            uploads[uploadId]!.parts[n] = body
            partPuts.append(n)
            return .ok(())
        }
    }

    func abort(_ target: FileTarget, uploadId: String) async throws -> FileReply<Void> {
        lock.withLock {
            calls.append("abort")
            aborted.append(uploadId)
            uploads[uploadId] = nil
        }
        return .ok(())
    }

    func planChunks(_ target: FileTarget, uploadId: String, request: JSONValue) async throws -> FileReply<JSONValue> {
        if let r = try enter("plan", JSONValue.self) { return r }
        if let a = planAnswer { return .ok(a) }
        return lock.withLock {
            guard uploads[uploadId] != nil else { return .refused(FileRefusal(status: 410, code: "upload_expired")) }
            guard case .object(let o) = request, case .array(let list)? = o["chunks"] else {
                return .refused(FileRefusal(status: 400, code: "value_invalid"))
            }
            planSizes.append(list.count)
            var missing: [JSONValue] = []
            var present: [JSONValue] = []
            for e in list {
                guard case .array(let pair) = e, case .string(let id)? = pair.first else { continue }
                if chunks[id] != nil { present.append(e) } else { missing.append(.string(id)) }
            }
            return .ok(.object(["missing": .array(missing), "present": .array(present)]))
        }
    }

    func putChunk(_ target: FileTarget, uploadId: String, chunkId: String, body: Data, sha256: String) async throws
        -> FileReply<Void>
    {
        if let r = try enter("putChunk", Void.self) { return r }
        return lock.withLock {
            guard uploads[uploadId] != nil else { return .refused(FileRefusal(status: 410, code: "upload_expired")) }
            guard shaHex(body) == sha256 else { return .refused(FileRefusal(status: 400, code: "upload_mismatch")) }
            chunks[chunkId] = body
            chunkPuts.append(chunkId)
            return .ok(())
        }
    }

    func finalize(_ target: FileTarget, request: JSONValue) async throws -> FileReply<JSONValue> {
        if let r = try enter("finalize", JSONValue.self) { return r }
        return lock.withLock {
            guard case .object(let o) = request, case .string(let id)? = o["uploadId"], let u = uploads[id] else {
                return .refused(FileRefusal(status: 410, code: "upload_expired"))
            }
            var data = Data()
            if u.mode == "chunks" {
                guard let m = u.manifest else {
                    return .refused(
                        FileRefusal(status: 409, code: "upload_incomplete", body: .object(["missing": .array([])])))
                }
                data = m
            } else {
                for k in u.parts.keys.sorted() { data.append(u.parts[k]!) }
            }
            guard shaHex(data) == u.sha256 else { return .refused(FileRefusal(status: 400, code: "upload_mismatch")) }
            files.append(data)
            uploads[id] = nil
            let answer = JSONValue.object([
                "version": .int(versionBase + files.count), "size": .int(u.size), "sha256": .string(u.sha256),
                "format": .string(u.format),
            ])
            return .ok(finalizeAnswer?(answer) ?? answer)
        }
    }

    func getFile(_ target: FileTarget, query: FileQuery) async throws -> FileReply<FileBody> {
        if let r = try enter("getFile", FileBody.self) { return r }
        let (data, tag, tamper): (Data, String, @Sendable (FileQuery, FileBody) -> FileBody) = lock.withLock {
            fileQueries.append(query)
            return (query.version.map { files[$0 - 1] } ?? files[files.count - 1], etag, tamperFile)
        }
        if let m = query.ifMatch, m != tag { return .refused(FileRefusal(status: 412, code: "precondition_failed")) }
        var body = FileBody(status: 200, data: data, etag: tag)
        if let r = query.range {
            let end = min(data.count, r.upperBound)
            body = FileBody(
                status: 206, data: data.subdata(in: r.lowerBound..<end), etag: tag,
                contentRange: (r.lowerBound, end, data.count))
        }
        return .ok(tamper(query, body))
    }

    func getChunk(collection: String, chunkId: String) async throws -> FileReply<Data> {
        if let r = try enter("getChunk", Data.self) { return r }
        return lock.withLock {
            chunkGets.append(chunkId)
            guard let obj = chunks[chunkId] else { return .refused(FileRefusal(status: 404, code: "not_found")) }
            return .ok(tamperChunk(chunkId, obj))
        }
    }
}

private final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var _sleeps: [Double] = []
    var sleeps: [Double] { lock.withLock { _sleeps } }
    func add(_ s: Double) { lock.withLock { _sleeps.append(s) } }
}

private final class Collected: @unchecked Sendable {
    private let lock = NSLock()
    private var _data = Data()
    private var _writes = 0
    var data: Data { lock.withLock { _data } }
    var writes: Int { lock.withLock { _writes } }
    func add(_ d: Data) {
        lock.withLock {
            _data.append(d)
            _writes += 1
        }
    }
}

private final class TaskBox: @unchecked Sendable {
    private let lock = NSLock()
    private var task: Task<JSONValue, Error>?
    private var cancelRequested = false
    /// A cancel asked before the task is stored is applied as soon as it is (the hook can run first).
    func set(_ t: Task<JSONValue, Error>) {
        let late = lock.withLock { () -> Bool in
            task = t
            return cancelRequested
        }
        if late { t.cancel() }
    }
    func cancel() {
        let t = lock.withLock { () -> Task<JSONValue, Error>? in
            cancelRequested = true
            return task
        }
        t?.cancel()
    }
}

private let root = Data(repeating: 7, count: 32)

final class CloudSyncTransferTests: XCTestCase {
    private func engine(
        _ s: FakeServer, _ j: any JournalStore = MemoryJournal(), recorder: Recorder = Recorder(), parallelism: Int = 4
    ) -> FileTransferEngine {
        FileTransferEngine(
            transport: s, journal: j, now: { clockNow }, sleep: { recorder.add($0) }, random: { 0.5 },
            parallelism: parallelism)
    }

    private func upReq(_ id: String, _ data: Data, enc: String = "none", baseVersion: JSONValue? = nil) -> UploadRequest
    {
        UploadRequest(
            id: id, collection: "saves", record: "rec1", source: DataSource(data), size: data.count,
            sha256: shaHex(data), enc: enc,
            baseVersion: baseVersion)
    }

    private func chunkedReq(_ id: String, _ data: Data, _ codec: any FileCodec) -> ChunkedUploadRequest {
        ChunkedUploadRequest(id: id, collection: "saves", record: "rec1", source: DataSource(data), codec: codec)
    }

    private func expect(
        _ reason: TransferError.Reason, _ detail: String? = nil, file: StaticString = #filePath, line: UInt = #line,
        _ body: () async throws -> Void
    ) async {
        do {
            try await body()
            XCTFail("expected \(reason)", file: file, line: line)
        } catch let e as TransferError {
            XCTAssertEqual(e.reason, reason, "\(e)", file: file, line: line)
            if let detail { XCTAssertEqual(e.detail, detail, file: file, line: line) }
        } catch {
            XCTFail("unexpected \(error)", file: file, line: line)
        }
    }

    private func record(
        _ id: String, uploadId: String = "u", expiresAt: Double = (clockNow + 100) * 1000,
        sha: String = String(repeating: "a", count: 64), size: Int = 5
    ) -> JournalRecord {
        JournalRecord(
            v: 1, id: id, kind: "upload", collection: "saves", record: "rec1", uploadId: uploadId, mode: "single",
            partBytes: nil,
            done: [], sha256: sha, size: size, expiresAt: expiresAt, state: "uploading")
    }

    // MARK: codecs

    func testCodecsRoundTripChunksAndHideTheRoot() {
        let e2e = E2eFileCodec(root: root, collection: "saves")
        let srv = ServerFileCodec()
        let plain = noise(5000)
        for c in [e2e as any FileCodec, srv] {
            let id = try! c.chunkId(plain)
            let obj = try! c.sealChunk(id: id, plain: plain)
            XCTAssertEqual(obj.count, c.chunkObjectBytes(plain.count), c.enc)
            XCTAssertEqual(try! c.openChunk(id: id, object: obj), .ok(plain), c.enc)
            XCTAssertNotEqual(try! c.openChunk(id: try! c.chunkId(noise(10)), object: obj), .ok(plain), c.enc)
            XCTAssertEqual(c.plainSize(c.storedSize(4096)), 4096, c.enc)
        }
        XCTAssertFalse("\(e2e)".contains(hexOf(root)))
        XCTAssertEqual(Mirror(reflecting: e2e).children.count, 0)
        let id = srv.chunkId(plain)
        XCTAssertEqual(srv.openChunk(id: id, object: Data(count: SYNC_CHUNK_MAX_STORED_BYTES + 1)), .invalid("size"))
        XCTAssertEqual(srv.openChunk(id: id, object: Data([0, 9, 1])), .invalid("codec"))
        XCTAssertEqual(srv.openChunk(id: id, object: Data([7, 0, 1])), .invalid("version"))
    }

    func testZstdChunksDecodeAndABombIsRefusedBeforeDecoding() throws {
        let srv = ServerFileCodec()
        let plain = Data(repeating: 0x41, count: 200_000)
        var frame = [UInt8](repeating: 0, count: ZSTD_compressBound(plain.count))
        let n = plain.withUnsafeBytes { src in
            frame.withUnsafeMutableBytes { dst in
                ZSTD_compress(dst.baseAddress, dst.count, src.baseAddress, src.count, 3)
            }
        }
        XCTAssertEqual(ZSTD_isError(n), 0)
        let object = Data([0, 1]) + Data(frame.prefix(n))
        XCTAssertEqual(srv.openChunk(id: srv.chunkId(plain), object: object), .ok(plain), "a real zstd frame decodes")
        XCTAssertEqual(srv.openChunk(id: srv.chunkId(Data([1])), object: object), .invalid("id"))
        // A frame that declares more than 1 mib is refused before any decode.
        let big = Data(repeating: 0, count: 2 * mib)
        var bigFrame = [UInt8](repeating: 0, count: ZSTD_compressBound(big.count))
        let m = big.withUnsafeBytes { src in
            bigFrame.withUnsafeMutableBytes { dst in
                ZSTD_compress(dst.baseAddress, dst.count, src.baseAddress, src.count, 3)
            }
        }
        XCTAssertEqual(
            srv.openChunk(id: srv.chunkId(big), object: Data([0, 1]) + Data(bigFrame.prefix(m))), .invalid("size"))
        // Truncated frames are not a decode.
        XCTAssertEqual(
            srv.openChunk(id: srv.chunkId(plain), object: Data([0, 1]) + Data(frame.prefix(12))), .invalid("decode"))
    }

    // MARK: uploads

    func testSingleUploadFinalizesAndClearsTheJournal() async throws {
        let s = FakeServer()
        let j = MemoryJournal()
        let data = noise(50_000)
        let seen = Collected()
        var req = upReq("t1", data)
        req.onProgress = { sent, total in seen.add(Data([UInt8(sent == total ? 1 : 0)])) }
        let out = try await engine(s, j).upload(req)
        XCTAssertEqual(out.objectValue?["version"], .int(1))
        XCTAssertEqual(out.objectValue?["sha256"], .string(shaHex(data)))
        XCTAssertEqual(s.files, [data])
        XCTAssertTrue(j.list().isEmpty)
        XCTAssertEqual(seen.data, Data([1]))
    }

    func testMultipartSendsAllPartsAndJournalsThemAscending() async throws {
        let s = FakeServer()
        s.multipartAlways = true
        let j = MemoryJournal()
        let big = noise(350_000)
        try await engine(s, j).upload(upReq("t2", big))
        XCTAssertEqual(Set(s.partPuts), [1, 2, 3, 4])
        XCTAssertEqual(s.files, [big])
        // Sequential: ascending order too.
        let s2 = FakeServer()
        s2.multipartAlways = true
        try await engine(s2, parallelism: 1).upload(upReq("t2b", big))
        XCTAssertEqual(s2.partPuts, [1, 2, 3, 4])
    }

    func testKillThenResumeSendsOnlyTheMissingParts() async throws {
        let s = FakeServer()
        s.multipartAlways = true
        let j = MemoryJournal()
        let big = noise(350_000)
        let box = TaskBox()
        // Cancel when the second part's call starts; with one part in flight it still completes.
        let counter = Collected()
        s.hook = { kind in
            if kind == "putPart" {
                counter.add(Data([1]))
                if counter.writes == 2 { box.cancel() }
            }
            return nil
        }
        let e = engine(s, j, parallelism: 1)
        let req = upReq("k1", big)
        let task = Task<JSONValue, Error> { try await e.upload(req) }
        box.set(task)
        await expect(.aborted) { _ = try await task.value }
        let rec = try parseJournalRecord(j.get("k1"))
        XCTAssertEqual(rec.done, [1, 2])
        XCTAssertEqual(rec.state, "uploading")
        s.hook = { _ in nil }
        try await engine(s, j).upload(req)
        XCTAssertEqual(s.partPuts.sorted(), [1, 2, 3, 4], "only the missing parts are sent, each once")
        XCTAssertEqual(s.beginRequests.count, 1)
        XCTAssertEqual(s.files, [big])
    }

    func testAPartTheServerLostIsSentAgain() async throws {
        let s = FakeServer()
        s.multipartAlways = true
        let j = MemoryJournal()
        let big = noise(350_000)
        let box = TaskBox()
        let counter = Collected()
        s.hook = { kind in
            if kind == "putPart" {
                counter.add(Data([1]))
                if counter.writes == 2 { box.cancel() }
            }
            return nil
        }
        let e = engine(s, j, parallelism: 1)
        let req = upReq("k2", big)
        let task = Task<JSONValue, Error> { try await e.upload(req) }
        box.set(task)
        _ = try? await task.value
        let up = try XCTUnwrap(s.uploads.keys.first, "the upload had started before the cancel")
        s.uploads[up]?.parts[2] = nil
        s.hook = { _ in nil }
        try await engine(s, j).upload(req)
        XCTAssertEqual(s.files, [big])
        XCTAssertEqual(s.partPuts.filter { $0 == 2 }.count, 2)
    }

    func testA410RestartsTheUploadAndRepeatedOnesGiveUp() async throws {
        let data = noise(2000)
        let s = FakeServer()
        let first = Collected()
        s.hook = { kind in
            if kind == "putSingle", first.writes == 0 {
                first.add(Data([1]))
                return FileRefusal(status: 410, code: "upload_expired")
            }
            return nil
        }
        try await engine(s).upload(upReq("g1", data))
        XCTAssertEqual(s.beginRequests.count, 2)
        XCTAssertEqual(s.files, [data])

        let s2 = FakeServer()
        s2.hook = { $0 == "putSingle" ? FileRefusal(status: 410, code: "upload_expired") : nil }
        await expect(.restartsExhausted) { try await self.engine(s2).upload(self.upReq("g2", data)) }
        XCTAssertEqual(s2.beginRequests.count, 4)

        for status in [404, 410] {
            let s3 = FakeServer()
            s3.hook = { $0 == "begin" ? FileRefusal(status: status, code: "gone") : nil }
            await expect(.rejected) { try await self.engine(s3).upload(self.upReq("g3", data)) }
            XCTAssertEqual(s3.beginRequests.count, 1, "\(status) on begin is not a restart")
        }
    }

    func testAFinalizeAnswerThatIsNotTheFileBegunIsRefused() async throws {
        let lies: [(String, @Sendable (JSONValue) -> JSONValue)] = [
            ("size", { a in Self.changed(a, "size", .int(a.objectValue!["size"]!.intValue! + 1)) }),
            ("sha256", { a in Self.changed(a, "sha256", .string(String(repeating: "ab", count: 32))) }),
            ("format", { a in Self.changed(a, "format", .string("chunks")) }),
            ("version", { a in Self.changed(a, "version", .int(0)) }),
        ]
        for (name, lie) in lies {
            for data in [noise(100), noise(300_000)] {
                let s = FakeServer()
                s.finalizeAnswer = lie
                let request = self.upReq("f-\(name)", data)
                await expect(.fileInvalid, "finalize") { try await self.engine(s).upload(request) }
            }
            let s = FakeServer()
            s.finalizeAnswer = name == "format" ? { a in Self.changed(a, "format", .string("whole")) } : lie
            await expect(.fileInvalid, "finalize") {
                try await self.engine(s).uploadChunked(self.chunkedReq("fc-\(name)", noise(200_000), ServerFileCodec()))
            }
        }
        // A version that is not newer than the base is refused.
        let s = FakeServer()
        s.finalizeAnswer = { a in Self.changed(a, "version", .int(3)) }
        await expect(.fileInvalid, "finalize") {
            try await self.engine(s).upload(self.upReq("f-base", noise(100), baseVersion: .int(3)))
        }
    }

    private static func changed(_ a: JSONValue, _ key: String, _ v: JSONValue) -> JSONValue {
        var o = a.objectValue!
        o[key] = v
        return .object(o)
    }

    func testA409CarriesTheServersVersion() async {
        let s = FakeServer()
        s.hook = {
            $0 == "begin"
                ? FileRefusal(
                    status: 409, code: "revision_conflict", body: .object(["server": .object(["version": .int(7)])]))
                : nil
        }
        do {
            try await engine(s).upload(upReq("g4", noise(100), baseVersion: .int(3)))
            XCTFail("expected a conflict")
        } catch let e as TransferError {
            XCTAssertEqual(e.reason, .conflict)
            XCTAssertEqual(e.serverVersion, 7)
        } catch { XCTFail("\(error)") }
        guard case .object(let o) = s.beginRequests[0] else { return XCTFail() }
        XCTAssertEqual(o["baseVersion"], .int(3))
    }

    func testRetryAfterHoldsAndBackoffDoublesWithJitter() async throws {
        let data = noise(3000)
        let s = FakeServer()
        let n = Collected()
        s.hook = { kind in
            if kind == "begin", n.writes < 2 {
                n.add(Data([1]))
                return FileRefusal(status: 429, code: "rate_limited", retryAfterSeconds: 7)
            }
            return nil
        }
        let rec = Recorder()
        // The clock does not advance, so the hold stays; every retry waits the told time.
        try await engine(s, recorder: rec).upload(upReq("r1", data))
        XCTAssertEqual(rec.sleeps.first, 7)

        let s2 = FakeServer()
        s2.hook = { kind in
            if kind == "begin" { throw URLError(.notConnectedToInternet) }
            return nil
        }
        let rec2 = Recorder()
        await expect(.retriesExhausted) { try await self.engine(s2, recorder: rec2).upload(self.upReq("r2", data)) }
        XCTAssertEqual(s2.beginRequests.count, 8)
        XCTAssertEqual(rec2.sleeps.count, 7)
        XCTAssertEqual(rec2.sleeps[0], 0.375, accuracy: 1e-9)
        XCTAssertEqual(rec2.sleeps[1], 0.75, accuracy: 1e-9)

        let s3 = FakeServer()
        s3.hook = { $0 == "begin" ? FileRefusal(status: 403, code: "forbidden") : nil }
        await expect(.rejected) { try await self.engine(s3).upload(self.upReq("r3", data)) }
        XCTAssertEqual(s3.beginRequests.count, 1, "a 403 is not retried")

        let s4 = FakeServer()
        s4.hook = { $0 == "finalize" ? FileRefusal(status: 400, code: "upload_mismatch") : nil }
        await expect(.mismatch) { try await self.engine(s4).upload(self.upReq("r4", data)) }
        XCTAssertEqual(s4.aborted.count, 1, "a mismatch releases the upload")
    }

    func testASourceThatIsNotTheDeclaredHashIsRefusedWithNothingSent() async {
        let s = FakeServer()
        var req = upReq("m1", noise(1000))
        req.sha256 = shaHex(noise(3))
        await expect(.sourceMismatch) { try await self.engine(s).upload(req) }
        XCTAssertTrue(s.calls.isEmpty)
    }

    func testAnExpiredRecordBeginsAfreshAndAnUnknownVersionIsLeftAlone() async throws {
        let data = noise(2000)
        let s = FakeServer()
        let j = MemoryJournal()
        j.put("e1", record("e1", expiresAt: (clockNow - 5) * 1000, sha: shaHex(data), size: data.count))
        try await engine(s, j).upload(upReq("e1", data))
        XCTAssertEqual(s.beginRequests.count, 1)

        // expiresAt is milliseconds: a record live in ms is resumed (a status call); one past in ms is not,
        // although its number would read as live in seconds.
        let live = MemoryJournal()
        live.put("e2", record("e2", expiresAt: (clockNow + 100) * 1000, sha: shaHex(data), size: data.count))
        let s5 = FakeServer()
        try await engine(s5, live).upload(upReq("e2", data))
        XCTAssertTrue(s5.calls.contains("status"), "a record live in milliseconds is resumed")
        XCTAssertFalse(s.calls.contains("status"), "a record past in milliseconds is not")

        let foreign = JSONValue.object(["v": .int(2), "id": .string("v2"), "anything": .bool(true)])
        j.putRaw("v2", foreign)
        s.calls.removeAll()
        await expect(.journalVersion) { try await self.engine(s, j).upload(self.upReq("v2", data)) }
        XCTAssertTrue(s.calls.isEmpty)
        XCTAssertEqual(j.get("v2"), foreign, "the record is left as found")

        j.putRaw("bad", .object(["v": .int(1), "id": .string("bad")]))
        await expect(.journalMalformed) { try await self.engine(s, j).upload(self.upReq("bad", data)) }
    }

    func testEngineCancelAbortsTheServersUploadAndForgetsTheRecord() async {
        let s = FakeServer()
        let j = MemoryJournal()
        j.put("z", record("z", uploadId: "upX"))
        await engine(s, j).cancel(id: "z")
        XCTAssertEqual(s.aborted, ["upX"])
        XCTAssertNil(j.get("z"))
        j.putRaw("y", .object(["v": .int(9)]))
        await engine(s, j).cancel(id: "y")
        XCTAssertNotNil(j.get("y"), "a record this build cannot read stays")
    }

    // MARK: chunks

    func testChunkedUploadSendsOnlyWhatChangedAndAKillLeavesARecordTheNextRunReleases() async throws {
        let codec = ServerFileCodec()
        let s = FakeServer()
        let j = MemoryJournal()
        let data = noise(2 * mib + 12_345)
        try await engine(s, j).uploadChunked(chunkedReq("c1", data, codec))
        let first = s.chunkPuts.count
        XCTAssertGreaterThanOrEqual(first, 4)
        XCTAssertTrue(j.list().isEmpty)
        guard case .object(let b) = s.beginRequests[0] else { return XCTFail() }
        XCTAssertEqual(b["format"], .string("chunks"))
        XCTAssertEqual(b["enc"], .string("none"))

        var edited = data
        edited[mib + 5] = edited[mib + 5] &+ 1
        s.chunkPuts.removeAll()
        try await engine(s, j).uploadChunked(chunkedReq("c2", edited, codec))
        XCTAssertGreaterThanOrEqual(s.chunkPuts.count, 1)
        XCTAssertLessThan(s.chunkPuts.count, first, "only the changed chunks")
        s.chunkPuts.removeAll()
        try await engine(s, j).uploadChunked(chunkedReq("c3", edited, codec))
        XCTAssertTrue(s.chunkPuts.isEmpty, "an identical reupload sends nothing")
        XCTAssertTrue(s.planSizes.allSatisfy { $0 <= 1024 })

        // Kill after the first chunk: the record names the upload for the next run to abort.
        let s2 = FakeServer()
        let j2 = MemoryJournal()
        let box = TaskBox()
        let counter = Collected()
        s2.hook = { kind in
            if kind == "putChunk" {
                counter.add(Data([1]))
                if counter.writes == 2 { box.cancel() }
            }
            return nil
        }
        let e = engine(s2, j2, parallelism: 1)
        let req = chunkedReq("c4", data, codec)
        let task = Task<JSONValue, Error> { try await e.uploadChunked(req) }
        box.set(task)
        await expect(.aborted) { _ = try await task.value }
        let rec = try parseJournalRecord(j2.get("c4"))
        XCTAssertEqual(rec.mode, "chunks")
        XCTAssertTrue(rec.done.isEmpty)
        s2.hook = { _ in nil }
        let before = s2.chunkPuts.count
        try await engine(s2, j2).uploadChunked(req)
        XCTAssertEqual(s2.aborted.count, 1, "the previous upload was released")
        XCTAssertEqual(s2.chunkPuts.count, first, "chunks already stored are not sent again")
        XCTAssertGreaterThan(before, 0)
    }

    func testAPlanThatNamesAnUnaskedIdOrAWrongModeIsABadReply() async {
        let codec = ServerFileCodec()
        let s = FakeServer()
        s.planAnswer = .object(["missing": .array([.string(String(repeating: "f", count: 64))]), "present": .array([])])
        await expect(.badReply) { try await self.engine(s).uploadChunked(self.chunkedReq("c5", noise(200_000), codec)) }
        XCTAssertEqual(s.aborted.count, 1)
        let s2 = FakeServer()
        s2.beginAnswer = .object([
            "uploadId": .string("x"), "mode": .string("single"), "expiresAt": .double((clockNow + 5) * 1000),
        ])
        await expect(.badReply) { try await self.engine(s2).uploadChunked(self.chunkedReq("c6", noise(1000), codec)) }
    }

    func testEndToEndChunksAreSealedAndAFileEditedAfterCuttingIsRefused() async throws {
        let e2e = E2eFileCodec(root: root, collection: "saves")
        let s = FakeServer()
        let small = noise(180_000)
        try await engine(s).uploadChunked(chunkedReq("c7", small, e2e))
        guard case .object(let b) = s.beginRequests[0] else { return XCTFail() }
        XCTAssertEqual(b["enc"], .string("e2e"))
        let needle = small.subdata(in: 1000..<1064)
        for obj in s.chunks.values { XCTAssertNil(obj.range(of: needle), "no stored chunk carries the plaintext") }

        struct Shifty: RangedSource {
            let data: Data
            let box: Collected
            var size: Int { data.count }
            func read(_ start: Int, _ end: Int) throws -> Data {
                box.add(Data([1]))
                var d = data.subdata(in: start..<end)
                if box.writes > 1, !d.isEmpty { d[0] = d[0] &+ 1 }
                return d
            }
        }
        let raw = noise(300_000)
        let s2 = FakeServer()
        let req = ChunkedUploadRequest(
            id: "c8", collection: "saves", record: "rec1", source: Shifty(data: raw, box: Collected()),
            codec: ServerFileCodec())
        await expect(.sourceMismatch) { try await self.engine(s2).uploadChunked(req) }
    }

    // MARK: downloads

    private func dlReq(
        _ data: Data, stored: Data? = nil, codec: any FileCodec = ServerFileCodec(), format: String = "whole",
        cache: (any ChunkCache)? = nil, sink: Collected
    ) -> DownloadRequest {
        let st = stored ?? data
        return DownloadRequest(
            collection: "saves", record: "rec1", format: format, size: st.count, sha256: shaHex(st), codec: codec,
            cache: cache
        ) { sink.add($0) }
    }

    func testWholeDownloadsReadRangesHoldTheETagAndRefuseBadAnswers() async throws {
        let s = FakeServer()
        let data = noise(3000)
        try await engine(s).upload(upReq("d1", data))
        let sink = Collected()
        try await engine(s).download(dlReq(data, sink: sink))
        XCTAssertEqual(sink.data, data)

        let big = noise(9 * mib)
        let s2 = FakeServer()
        try await engine(s2).upload(upReq("d2", big))
        let sink2 = Collected()
        try await engine(s2).download(dlReq(big, sink: sink2))
        XCTAssertEqual(sink2.data, big)
        XCTAssertEqual(s2.fileQueries.count, 2)
        XCTAssertNil(s2.fileQueries[0].ifMatch)
        XCTAssertEqual(s2.fileQueries[1].ifMatch, "\"e1\"")

        let flip = Collected()
        s2.tamperFile = { _, b in
            flip.add(Data([1]))
            return flip.writes == 2
                ? FileBody(status: b.status, data: b.data, etag: "\"e2\"", contentRange: b.contentRange) : b
        }
        await expect(.badReply) { try await self.engine(s2).download(self.dlReq(big, sink: Collected())) }
        s2.tamperFile = { _, b in
            b.status == 206
                ? FileBody(status: 206, data: b.data.prefix(10), etag: b.etag, contentRange: b.contentRange) : b
        }
        await expect(.badReply) { try await self.engine(s2).download(self.dlReq(big, sink: Collected())) }
        s2.tamperFile = { _, b in
            guard let c = b.contentRange else { return b }
            return FileBody(status: 206, data: b.data, etag: b.etag, contentRange: (c.start + 1, c.end, c.total))
        }
        await expect(.badReply) { try await self.engine(s2).download(self.dlReq(big, sink: Collected())) }
        // A 200 for the whole file is taken from the start only.
        s2.tamperFile = { _, b in FileBody(status: 200, data: big, etag: b.etag) }
        let sink3 = Collected()
        try await engine(s2).download(dlReq(big, sink: sink3))
        XCTAssertEqual(sink3.data, big)
    }

    func testStoredBytesThatDoNotHashAreSyncFileInvalid() async throws {
        let s = FakeServer()
        let data = noise(4000)
        try await engine(s).upload(upReq("d3", data))
        var req = dlReq(data, sink: Collected())
        req.sha256 = shaHex(noise(2))
        do {
            try await engine(s).download(req)
            XCTFail("expected file-invalid")
        } catch let e as TransferError {
            XCTAssertEqual(e.reason, .fileInvalid)
            XCTAssertEqual(e.polarisError.code, ErrorCode.syncFileInvalid)
        }
        req.sha256 = "XYZ"
        await expect(.fileInvalid, "sha256") { try await self.engine(s).download(req) }
        req = dlReq(data, sink: Collected())
        req.size = 0
        await expect(.fileInvalid, "size") { try await self.engine(s).download(req) }
        s.hook = { $0 == "getFile" ? FileRefusal(status: 404, code: "not_found") : nil }
        await expect(.rejected) { try await self.engine(s).download(self.dlReq(data, sink: Collected())) }
        XCTAssertEqual(s.beginRequests.count, 1, "a 404 on a download is a rejection")
    }

    func testEndToEndWholeFileFlippedByteFailsItsTag() async throws {
        let e2e = E2eFileCodec(root: root, collection: "saves")
        let plain = noise(20_000)
        let stored = try e2e.sealWhole(plain)
        let s = FakeServer()
        try await engine(s).upload(upReq("d4", stored, enc: "e2e"))
        let sink = Collected()
        try await engine(s).download(dlReq(plain, stored: stored, codec: e2e, sink: sink))
        XCTAssertEqual(sink.data, plain)
        var bad = stored
        bad[bad.count - 40] = bad[bad.count - 40] &+ 1
        s.files[0] = bad
        await expect(.fileInvalid) {
            try await self.engine(s).download(self.dlReq(plain, stored: bad, codec: e2e, sink: Collected()))
        }
    }

    func testChunkedDownloadFillsTheCacheAndTreatsDamageAsAMiss() async throws {
        let codec = ServerFileCodec()
        let data = noise(2 * mib + 77)
        let s = FakeServer()
        try await engine(s).uploadChunked(chunkedReq("d5", data, codec))
        let manifest = s.files[0]
        let cache = MemoryChunkCache()
        let sink = Collected()
        var req = dlReq(data, stored: manifest, codec: codec, format: "chunks", cache: cache, sink: sink)
        req.size = data.count
        try await engine(s).download(req)
        XCTAssertEqual(sink.data, data)
        let fetched = s.chunkGets.count
        XCTAssertGreaterThanOrEqual(fetched, 4)
        let again = Collected()
        var req2 = req
        req2.sink = { again.add($0) }
        try await engine(s).download(req2)
        XCTAssertEqual(again.data, data)
        XCTAssertEqual(s.chunkGets.count, fetched, "a second read is served from the cache")
        let firstId = s.chunks.keys.first!
        try cache.put(firstId, noise(500))
        let third = Collected()
        var req3 = req
        req3.sink = { third.add($0) }
        try await engine(s).download(req3)
        XCTAssertEqual(third.data, data)
        XCTAssertEqual(s.chunkGets.count, fetched + 1, "a damaged entry is a miss")
        XCTAssertEqual(try cache.get(firstId), s.chunks[firstId], "...and is replaced by the good object")
    }

    func testTheSpoolAndTheChunkCacheHoldNoPlaintextInE2E() async throws {
        // The chunk cache half (the spool half is `CloudSyncBackgroundCloseTests.testTheSpoolHoldsNoPlaintextInE2E`):
        // a marker in the plaintext through a real end-to-end codec, then every cache file is scanned.
        let marker = Data("PLAINTEXT-MARKER-0123456789".utf8)
        var data = noise(300_000)
        data.replaceSubrange(1000..<(1000 + marker.count), with: marker)
        let codec = E2eFileCodec(root: root, collection: "saves")
        let s = FakeServer()
        try await engine(s).uploadChunked(chunkedReq("c9", data, codec))
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let cache = FileChunkCache(directory: dir.appendingPathComponent("cache"), maxBytes: 64 * mib)
        let sink = Collected()
        var req = dlReq(data, stored: s.files[0], codec: codec, format: "chunks", cache: cache, sink: sink)
        req.size = codec.storedSize(data.count)
        try await engine(s).download(req)
        XCTAssertEqual(sink.data, data)
        let files = try FileManager.default.contentsOfDirectory(atPath: dir.appendingPathComponent("cache").path)
        XCTAssertFalse(files.isEmpty, "the download filled the cache")
        for name in files {
            let bytes = try Data(contentsOf: dir.appendingPathComponent("cache").appendingPathComponent(name))
            XCTAssertNil(bytes.range(of: marker), "a cache file holds the plaintext")
            XCTAssertNil(bytes.range(of: data.subdata(in: 5000..<5064)), "a cache file holds the plaintext")
        }
    }

    func testTamperedChunksAndManifestsAreSyncFileInvalid() async throws {
        let codec = ServerFileCodec()
        let data = noise(mib + 4321)
        let s = FakeServer()
        try await engine(s).uploadChunked(chunkedReq("x1", data, codec))
        let manifest = s.files[0]
        func request(_ sink: Collected, size: Int? = nil, stored: Data? = nil) -> DownloadRequest {
            var r = dlReq(data, stored: stored ?? manifest, codec: codec, format: "chunks", sink: sink)
            r.size = size ?? data.count
            return r
        }
        s.tamperChunk = { _, o in
            var d = o
            d[d.count - 1] = d[d.count - 1] &+ 1
            return d
        }
        let sink = Collected()
        await expect(.fileInvalid) { try await self.engine(s).download(request(sink)) }
        s.tamperChunk = { _, o in Data(count: SYNC_CHUNK_MAX_STORED_BYTES + 1) + o }
        await expect(.fileInvalid, "chunk-size") { try await self.engine(s).download(request(Collected())) }
        let keys = Array(s.chunks.keys)
        let other = s.chunks[keys[1]]!
        s.tamperChunk = { id, o in id == keys[0] ? other : o }
        await expect(.fileInvalid) { try await self.engine(s).download(request(Collected())) }
        s.tamperChunk = { $1 }
        var tm = manifest
        tm[12] = 1  // the header's flags word
        s.files[0] = tm
        await expect(.fileInvalid, "sha256") { try await self.engine(s).download(request(Collected())) }
        await expect(.fileInvalid) { try await self.engine(s).download(request(Collected(), stored: tm)) }
        s.files[0] = manifest
        await expect(.fileInvalid, "size") {
            try await self.engine(s).download(request(Collected(), size: data.count + 1))
        }

        let e2e = E2eFileCodec(root: root, collection: "saves")
        let small = noise(120_000)
        let s2 = FakeServer()
        try await engine(s2).uploadChunked(chunkedReq("x2", small, e2e))
        var er = DownloadRequest(
            collection: "saves", record: "rec1", format: "chunks", size: e2e.storedSize(small.count),
            sha256: shaHex(s2.files[0]), codec: e2e
        ) { _ in }
        let ok = Collected()
        er.sink = { ok.add($0) }
        try await engine(s2).download(er)
        XCTAssertEqual(ok.data, small)
        s2.tamperChunk = { _, o in
            var d = o
            d[d.count - 20] = d[d.count - 20] &+ 1
            return d
        }
        let bad = Collected()
        er.sink = { bad.add($0) }
        await expect(.fileInvalid) { try await self.engine(s2).download(er) }
        XCTAssertEqual(bad.writes, 0, "nothing is delivered from a tampered chunk")
    }

    // MARK: journal and cache on disk

    private func tempDir() -> URL {
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("u23s4-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    private func mode(_ url: URL) -> Int {
        ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.posixPermissions] as? Int) ?? -1
    }

    func testAFileJournalNamesFilesByHashAtMode0600AndRefusesToBeSteered() throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let j = FileJournal(stateDir: dir)
        let evil = "../../etc/passwd"
        var rec = record(evil)
        rec.mode = "multipart"
        rec.partBytes = 2
        rec.size = 5
        rec.done = [1, 2]
        j.put(evil, rec)
        let names = try FileManager.default.contentsOfDirectory(atPath: j.directory.path)
        XCTAssertEqual(names, [journalFileName(evil)])
        XCTAssertEqual(names[0].count, 69)
        XCTAssertEqual(mode(j.directory.appendingPathComponent(names[0])), 0o600)
        XCTAssertEqual(mode(j.directory), 0o700)
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("../../etc/passwd").path))
        XCTAssertEqual(j.get(evil), rec.json)
        XCTAssertEqual(try parseJournalRecord(j.get(evil)), rec)
        XCTAssertEqual(j.list(), [evil])
        // Strangers in the directory are ignored by list.
        try Data("{}".utf8).write(to: j.directory.appendingPathComponent("evil.json"))
        try JSONEncoder().encode(rec).write(to: j.directory.appendingPathComponent(journalFileName("someone-else")))
        XCTAssertEqual(j.list(), [evil])
        // Garbage is a miss; a foreign version is returned as found and refused by the parser.
        try Data("not json".utf8).write(to: j.directory.appendingPathComponent(journalFileName("junk")))
        XCTAssertNil(j.get("junk"))
        try Data(#"{"v":9,"id":"fv"}"#.utf8).write(to: j.directory.appendingPathComponent(journalFileName("fv")))
        XCTAssertThrowsError(try parseJournalRecord(j.get("fv"))) {
            XCTAssertEqual(($0 as? TransferJournalError)?.reason, .version)
        }
        // Record contents: ids, counts and hashes only.
        let text = String(decoding: try JSONEncoder().encode(rec), as: UTF8.self)
        XCTAssertFalse(text.contains("token"))
        j.delete(evil)
        XCTAssertNil(j.get(evil))
        j.clear()
        XCTAssertTrue(j.list().isEmpty)
    }

    func testTheParserRefusesMalformedRecords() {
        var multi = record("m")
        multi.mode = "multipart"
        multi.partBytes = 100
        multi.size = 350
        var unordered = multi
        unordered.done = [2, 1]
        var beyond = multi
        beyond.done = [9]
        var chunks = record("c")
        chunks.mode = "chunks"
        chunks.done = [1]
        for bad: JSONValue? in [nil, .string("x"), .object(["v": .int(1)]), unordered.json, beyond.json, chunks.json] {
            XCTAssertThrowsError(try parseJournalRecord(bad))
        }
        XCTAssertNoThrow(try parseJournalRecord(multi.json))
    }

    func testChunkCacheNamesAreHexIdsOnlyAndTheFileCacheIsAnLRUThatSurvivesDamage() throws {
        let id = String(repeating: "ab", count: 32)
        XCTAssertTrue(isChunkCacheId(id))
        for bad in ["../x", id + "0", id.uppercased(), ""] { XCTAssertFalse(isChunkCacheId(bad), bad) }
        let m = MemoryChunkCache(maxBytes: 10)
        XCTAssertThrowsError(try m.put("../escape", Data([1])))
        XCTAssertThrowsError(try m.get("../escape"))
        let a = String(repeating: "01", count: 32)
        let b = String(repeating: "02", count: 32)
        let c = String(repeating: "03", count: 32)
        try m.put(a, noise(4))
        try m.put(b, noise(4))
        _ = try m.get(a)
        try m.put(c, noise(4))
        XCTAssertNil(try m.get(b), "the least recently used goes first")
        XCTAssertNotNil(try m.get(a))
        XCTAssertEqual(chunkCacheBudget(largestSave: 0), 256 * mib)
        XCTAssertEqual(chunkCacheBudget(largestSave: 300 * mib), 600 * mib)

        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let da = chunkCacheDirectory(stateDir: dir, subject: "subject-a", collection: "saves")
        let db = chunkCacheDirectory(stateDir: dir, subject: "subject-b", collection: "saves")
        XCTAssertNotEqual(da, db)
        XCTAssertFalse(chunkCacheDirectory(stateDir: dir, subject: "s", collection: "../../x").path.contains(".."))
        let fc = FileChunkCache(directory: da, maxBytes: 1000)
        let obj = noise(400)
        try fc.put(a, obj)
        XCTAssertEqual(try fc.get(a), obj)
        XCTAssertEqual(mode(da.appendingPathComponent(a)), 0o600)
        try fc.put(b, noise(400))
        try fc.put(c, noise(400))
        XCTAssertNil(try fc.get(a), "the file cache keeps the newest within its budget")
        XCTAssertNotNil(try fc.get(c))
        try Data([1, 2]).write(to: da.appendingPathComponent(c))
        XCTAssertNil(try fc.get(c), "a truncated entry is a miss")
        let fresh = FileChunkCache(directory: da, maxBytes: 1000)
        try Data("x".utf8).write(to: da.appendingPathComponent("stranger.txt"))
        XCTAssertNotNil(try fresh.get(b))
        XCTAssertThrowsError(try fresh.get("stranger.txt"))
        fc.clear()
        XCTAssertNil(try fc.get(b))
    }
}
