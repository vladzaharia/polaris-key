// @pkey-feature sync.files sync.files.delta
//
// The Cloud Sync file transport (U-23.S5): the path allow-list, no redirects, the body bounds, the
// Content-Digest of a PUT, Retry-After and the refusals the Worker's write routes can answer (503
// unavailable from a down limiter, 403 quota_exceeded at finalize), over a stub `PolarisTransport`.

import Foundation
import PolarisKeyCore
import XCTest

@testable import PolarisKey

private final class Stub: PolarisTransport, @unchecked Sendable {
    let lock = NSLock()
    var requests: [PolarisRequest] = []
    var answer: @Sendable (PolarisRequest) throws -> PolarisResponse = { _ in PolarisResponse(status: 200, body: Data())
    }
    var sent: [PolarisRequest] { lock.withLock { requests } }
    func send(_ request: PolarisRequest) async throws -> PolarisResponse {
        lock.withLock { requests.append(request) }
        return try answer(request)
    }
}

private func json(_ s: String) -> Data { Data(s.utf8) }
private let target = FileTarget(collection: "saves", record: "slot1")
private let hex64 = String(repeating: "ab", count: 32)

private func transport(_ stub: Stub, token: String? = "pkeyt_secret") -> CloudSyncFileTransport {
    CloudSyncFileTransport(
        product: "djdl", baseUrl: "https://key.plrs.im", transport: stub,
        headers: { ["x-pkey-device": "d"] }, token: { token })
}

final class CloudSyncFilesTests: XCTestCase {
    func testTheAllowListAcceptsTheRoutesAndNothingElse() {
        func ok(_ p: String) -> Bool { CloudSyncFileTransport.isFilesPath(product: "djdl", p) }
        for p in [
            "/djdl/sync/files/saves/slot1", "/djdl/sync/files/saves/slot1?version=12",
            "/djdl/sync/files/saves/slot1/begin", "/djdl/sync/files/saves/slot1/finalize",
            "/djdl/sync/files/saves/slot1/revisions", "/djdl/sync/files/saves/slot1/upload/up_x-1",
            "/djdl/sync/files/saves/slot1/upload/up_x-1/parts/3", "/djdl/sync/files/saves/slot1/upload/up_x-1/chunks",
            "/djdl/sync/files/saves/slot1/upload/up_x-1/chunks/\(hex64)", "/djdl/sync/files/saves/chunks/\(hex64)",
        ] { XCTAssertTrue(ok(p), p) }
        for p in [
            "/other/sync/files/saves/slot1", "/djdl/sync/files/saves", "/djdl/sync/files/saves/../x",
            "/djdl/sync/files/saves/slot1/upload/..", "/djdl/sync/files/saves/slot1?version=1&x=2",
            "/djdl/sync/files/saves/slot1?version=", "/djdl/sync/files/saves/slot1/begin?version=1",
            "/djdl/sync/files/saves/slot1/upload/up/parts/12345", "/djdl/sync/files/saves/chunks/\(hex64.uppercased())",
            "/djdl/sync/files/saves/slot1/upload/up/chunks/abc", "/djdl/sync/files/saves/sl ot",
            "/djdl/sync/files/saves/slot1/nope", "/djdl/sync/files/saves/slot%2F1", "//djdl/sync/files/saves/slot1",
            "/djdl/sync/files/saves/slot1/upload/up/parts/", "/djdl/sync/files/saves/slot1/upload",
        ] { XCTAssertFalse(ok(p), p) }
    }

    func testAServerChosenStringNeverMakesAPath() async throws {
        let stub = Stub()
        let t = transport(stub)
        do {
            _ = try await t.status(target, uploadId: "../../identity/x")
            XCTFail("a dot-dot upload id was sent")
        } catch let e as TransferError {
            XCTAssertEqual(e.code, "bad_path")
        }
        do {
            _ = try await t.getChunk(collection: "saves", chunkId: "ABC")
            XCTFail("a bad chunk id was sent")
        } catch let e as TransferError {
            XCTAssertEqual(e.code, "bad_path")
        }
        XCTAssertTrue(stub.sent.isEmpty)
    }

    func testNoBearerIsA401AndNothingIsSent() async throws {
        let stub = Stub()
        let r = try await transport(stub, token: nil).abort(target, uploadId: "up1")
        guard case .refused(let f) = r else { return XCTFail("expected a refusal") }
        XCTAssertEqual(f.status, 401)
        XCTAssertTrue(stub.sent.isEmpty)
    }

    func testAPutCarriesItsDigestTheBearerAndNoRedirect() async throws {
        let stub = Stub()
        stub.answer = { _ in PolarisResponse(status: 204, body: Data()) }
        let body = Data("hello".utf8)
        let digest = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        _ = try await transport(stub).putPart(target, uploadId: "up1", n: 2, body: body, sha256: digest)
        let req = try XCTUnwrap(stub.sent.first)
        XCTAssertEqual(req.method, "PUT")
        XCTAssertEqual(req.url.absoluteString, "https://key.plrs.im/djdl/sync/files/saves/slot1/upload/up1/parts/2")
        XCTAssertEqual(req.headers["content-digest"], "sha-256=:LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=:")
        XCTAssertEqual(req.headers["authorization"], "Bearer pkeyt_secret")
        XCTAssertEqual(req.headers["content-type"], "application/octet-stream")
        XCTAssertFalse(req.followRedirects)
        // A body without a real digest is not sent.
        do {
            _ = try await transport(stub).putSingle(target, uploadId: "up1", body: body, sha256: "nothex")
            XCTFail("sent without a digest")
        } catch let e as TransferError { XCTAssertEqual(e.code, "bad_path") }
        XCTAssertEqual(stub.sent.count, 1)
    }

    func testARedirectIsARefusalAndIsNotFollowed() async throws {
        let stub = Stub()
        stub.answer = { _ in PolarisResponse(status: 302, body: Data(), headers: ["Location": "https://evil.example/x"])
        }
        let r = try await transport(stub).status(target, uploadId: "up1")
        guard case .refused(let f) = r else { return XCTFail("expected a refusal") }
        XCTAssertEqual(f.code, "redirect_refused")
        XCTAssertEqual(stub.sent.count, 1)
    }

    func testRetryAfterIsCappedBeforeAnyIntegerConversion() async throws {
        XCTAssertEqual(CloudSyncFileTransport.retryAfter("2800"), 2800)
        XCTAssertEqual(CloudSyncFileTransport.retryAfter(String(repeating: "9", count: 400)), 3600)
        XCTAssertEqual(CloudSyncFileTransport.retryAfter("1e999"), nil)
        XCTAssertEqual(CloudSyncFileTransport.retryAfter("-5"), nil)
        XCTAssertEqual(CloudSyncFileTransport.retryAfter("0"), 0)
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertEqual(CloudSyncFileTransport.retryAfter("Tue, 14 Nov 2023 22:14:00 GMT", now: now), 40)
        XCTAssertEqual(CloudSyncFileTransport.retryAfter("Tue, 14 Nov 2023 22:00:00 GMT", now: now), 0)
        XCTAssertEqual(CloudSyncFileTransport.retryAfter("Fri, 31 Dec 9999 23:59:59 GMT", now: now), 3600)
        XCTAssertNil(CloudSyncFileTransport.retryAfter("soon"))
        XCTAssertNil(CloudSyncFileTransport.retryAfter(nil))
    }

    func testA503FromADownLimiterIsARefusalWithItsBackoff() async throws {
        let stub = Stub()
        stub.answer = { _ in
            PolarisResponse(
                status: 503, body: json(#"{"error":{"code":"unavailable","message":"x"}}"#),
                headers: ["retry-after": String(repeating: "9", count: 30)])
        }
        let r = try await transport(stub).putSingle(target, uploadId: "up1", body: Data([1]), sha256: hex64)
        guard case .refused(let f) = r else { return XCTFail("expected a refusal") }
        XCTAssertEqual(f.status, 503)
        XCTAssertEqual(f.code, "unavailable")
        XCTAssertEqual(f.retryAfterSeconds, 3600)
    }

    // @pkey-feature sync.files
    func testAccountRequiredIsReportedWithItsSignInUrlAndStillRefused() async throws {
        let stub = Stub()
        let told = LockedValue<[String?]>([])
        stub.answer = { _ in
            PolarisResponse(
                status: 403, body: json(#"{"error":{"code":"account_required","signInUrl":"/djdl/signin"}}"#))
        }
        let t = CloudSyncFileTransport(
            product: "djdl", baseUrl: "https://key.plrs.im", transport: stub,
            headers: { ["x-pkey-device": "d"] }, token: { "pkeyt_secret" },
            onAccountRequired: { url, _ in told.with { $0.append(url) } })
        guard case .refused(let f) = try await t.finalize(target, request: .null) else {
            return XCTFail("expected a refusal")
        }
        XCTAssertEqual(f.code, "account_required")
        XCTAssertEqual(told.current, ["/djdl/signin"])
        // Another 403 is not a removal.
        stub.answer = { _ in PolarisResponse(status: 403, body: json(#"{"error":{"code":"quota_exceeded"}}"#)) }
        _ = try await t.finalize(target, request: .null)
        XCTAssertEqual(told.current.count, 1)
    }

    // @pkey-feature sync.files
    func testAccountRequiredReportsThePersonSignedInWhenTheCallStarted() async throws {
        let stub = Stub()
        let who = LockedValue<String?>("ps_alice")
        let told = LockedValue<[[String?]]>([])
        stub.answer = { _ in
            who.set("ps_bob")  // the person changes while the call is out
            return PolarisResponse(
                status: 403, body: json(#"{"error":{"code":"account_required","signInUrl":"/djdl/signin"}}"#))
        }
        let t = CloudSyncFileTransport(
            product: "djdl", baseUrl: "https://key.plrs.im", transport: stub,
            headers: { ["x-pkey-device": "d"] }, token: { "pkeyt_secret" },
            onAccountRequired: { url, subject in told.with { $0.append([url, subject]) } },
            subject: { who.current })
        _ = try await t.finalize(target, request: .null)
        XCTAssertEqual(told.current, [["/djdl/signin", "ps_alice"]])
    }

    // @pkey-feature sync.files
    func testAccountRequiredFromAnotherOriginIsAnOrdinary403() async throws {
        for (finalUrl, redirected) in [("https://evil.example/f", false), ("https://key.plrs.im/f", true)] {
            let stub = Stub()
            let told = LockedValue<[String?]>([])
            stub.answer = { _ in
                PolarisResponse(
                    status: 403, body: json(#"{"error":{"code":"account_required","signInUrl":"/djdl/signin"}}"#),
                    finalUrl: finalUrl, redirected: redirected)
            }
            let t = CloudSyncFileTransport(
                product: "djdl", baseUrl: "https://key.plrs.im", transport: stub,
                headers: { ["x-pkey-device": "d"] }, token: { "pkeyt_secret" },
                onAccountRequired: { url, _ in told.with { $0.append(url) } })
            guard case .refused(let f) = try await t.finalize(target, request: .null) else {
                return XCTFail("expected a refusal")
            }
            XCTAssertEqual(f.code, ErrorCode.forbidden, finalUrl)
            XCTAssertEqual(told.current, [], finalUrl)
        }
    }

    func testFinalizeQuotaIsARefusalWithItsScope() async throws {
        let stub = Stub()
        stub.answer = { _ in
            PolarisResponse(
                status: 403, body: json(#"{"error":{"code":"quota_exceeded","message":"x","scope":"user"}}"#))
        }
        let r = try await transport(stub).finalize(target, request: .object(["uploadId": .string("up1")]))
        guard case .refused(let f) = r else { return XCTFail("expected a refusal") }
        XCTAssertEqual(f.code, "quota_exceeded")
        XCTAssertEqual(f.body?.objectValue?["scope"]?.stringValue, "user")
    }

    func testRefusalExtrasSitBesideOrInsideTheError() async throws {
        let stub = Stub()
        stub.answer = { _ in
            PolarisResponse(status: 409, body: json(#"{"error":{"code":"upload_incomplete"},"missing":[1,2]}"#))
        }
        guard case .refused(let f) = try await transport(stub).finalize(target, request: .null) else {
            return XCTFail("expected a refusal")
        }
        XCTAssertEqual(f.body?.objectValue?["missing"], .array([.int(1), .int(2)]))
        stub.answer = { _ in
            PolarisResponse(status: 409, body: json(#"{"error":{"code":"revision_conflict","server":{"version":7}}}"#))
        }
        guard case .refused(let g) = try await transport(stub).begin(target, request: .null) else {
            return XCTFail("expected a refusal")
        }
        XCTAssertEqual(g.body?.objectValue?["server"]?.objectValue?["version"], .int(7))
    }

    func testAnswersOutsideTheirShapeOrBoundsAreRefused() async throws {
        let stub = Stub()
        // A begin whose mode is not one of the three.
        stub.answer = { _ in PolarisResponse(status: 200, body: json(#"{"uploadId":"u","mode":"weird","expiresAt":1}"#))
        }
        guard case .refused(let a) = try await transport(stub).begin(target, request: .null) else {
            return XCTFail("expected a refusal")
        }
        XCTAssertEqual(a.code, ErrorCode.badResponse)
        // A chunk over the stored cap.
        stub.answer = { _ in PolarisResponse(status: 200, body: Data(count: SYNC_CHUNK_MAX_STORED_BYTES + 1)) }
        guard case .refused(let b) = try await transport(stub).getChunk(collection: "saves", chunkId: hex64) else {
            return XCTFail("expected a refusal")
        }
        XCTAssertEqual(b.code, ErrorCode.badResponse)
        XCTAssertEqual(stub.sent.last?.maxBodyBytes, SYNC_CHUNK_MAX_STORED_BYTES + 1)
        // A server that ignores Range and sends more than was asked.
        stub.answer = { _ in PolarisResponse(status: 200, body: Data(count: 100)) }
        guard case .refused(let c) = try await transport(stub).getFile(target, query: FileQuery(range: 0..<10)) else {
            return XCTFail("expected a refusal")
        }
        XCTAssertEqual(c.code, ErrorCode.badResponse)
        XCTAssertEqual(stub.sent.last?.headers["range"], "bytes=0-9")
    }

    func testARangeOverOneDownloadPieceIsRefusedBeforeAnythingIsSent() async throws {
        let stub = Stub()
        stub.answer = { _ in PolarisResponse(status: 206, body: Data(count: 1)) }
        let t = transport(stub)
        for range in [
            0..<(downloadRangeBytes + 1), 5..<(5 + downloadRangeBytes + 1), 0..<Int.max, (Int.max - 4)..<Int.max,
        ] {
            do {
                _ = try await t.getFile(target, query: FileQuery(range: range))
                XCTFail("range \(range) was sent")
            } catch let e as TransferError {
                XCTAssertEqual(e.reason, .rejected)
                XCTAssertEqual(e.detail, "range")
            }
        }
        XCTAssertTrue(stub.sent.isEmpty)
        // One whole piece is allowed.
        stub.answer = { _ in
            PolarisResponse(
                status: 206, body: Data(count: downloadRangeBytes),
                headers: ["Content-Range": "bytes 0-\(downloadRangeBytes - 1)/\(downloadRangeBytes)"])
        }
        guard case .ok = try await t.getFile(target, query: FileQuery(range: 0..<downloadRangeBytes)) else {
            return XCTFail("a whole piece was refused")
        }
    }

    /// A transport that streams a 1 MiB error body in 64 KiB pieces and counts the pieces asked for.
    private final class Streaming: PolarisTransport, @unchecked Sendable {
        let pulled = LockedValue(0)
        func send(_ request: PolarisRequest) async throws -> PolarisResponse {
            PolarisResponse(status: 599, body: Data())
        }
        func stream(_ request: PolarisRequest) async throws -> PolarisStreamResponse {
            let pulled = self.pulled
            var left = 16
            let body = AsyncThrowingStream<Data, Error> {
                guard left > 0 else { return nil }
                left -= 1
                pulled.with { $0 += 1 }
                return Data(repeating: 0x20, count: 65_536)
            }
            return PolarisStreamResponse(status: 404, headers: [:], body: body)
        }
    }

    func testARangedGetsErrorBodyIsReadToTheErrorCapOnly() async throws {
        let streaming = Streaming()
        let t = CloudSyncFileTransport(
            product: "djdl", baseUrl: "https://key.plrs.im", transport: streaming,
            headers: { [:] }, token: { "pkeyt_secret" })
        guard case .refused(let f) = try await t.getFile(target, query: FileQuery(range: 0..<downloadRangeBytes)) else {
            return XCTFail("expected a refusal")
        }
        XCTAssertEqual(f.status, 404)
        XCTAssertEqual(f.code, ErrorCode.notFound)
        // 64 KiB is the cap: one piece fills it, and the other fifteen are never pulled.
        XCTAssertLessThanOrEqual(streaming.pulled.current, 2)
    }

    func testARangedGetReadsTheContentRangeAndTheETag() async throws {
        let stub = Stub()
        stub.answer = { _ in
            PolarisResponse(
                status: 206, body: Data(count: 10), headers: ["ETag": "\"e1\"", "Content-Range": "bytes 10-19/100"])
        }
        guard
            case .ok(let f) = try await transport(stub).getFile(
                target, query: FileQuery(version: 3, range: 10..<20, ifMatch: "\"e1\""))
        else { return XCTFail("expected a body") }
        XCTAssertEqual(f.etag, "\"e1\"")
        XCTAssertEqual(f.contentRange?.start, 10)
        XCTAssertEqual(f.contentRange?.end, 20)
        XCTAssertEqual(f.contentRange?.total, 100)
        let req = try XCTUnwrap(stub.sent.last)
        XCTAssertEqual(req.url.query, "version=3")
        XCTAssertEqual(req.headers["if-match"], "\"e1\"")
        XCTAssertNil(CloudSyncFileTransport.parseContentRange("bytes 1-2/3 "))
        XCTAssertNil(CloudSyncFileTransport.parseContentRange("bytes a-2/3"))
    }

    func testTheDeadlineGrowsWithTheBody() async throws {
        let stub = Stub()
        stub.answer = { _ in PolarisResponse(status: 204, body: Data()) }
        _ = try await transport(stub).putSingle(
            target, uploadId: "up1", body: Data(count: 4 * 65_536), sha256: hex64)
        XCTAssertEqual(stub.sent.last?.timeoutSeconds, CloudSyncTransport.timeoutSeconds + 4)
    }

    func testALocalOnlyClientIsARejectionNotARetry() async throws {
        let stub = Stub()
        stub.answer = { _ in throw PolarisError(code: ErrorCode.localOnly, message: "local only") }
        do {
            _ = try await transport(stub).abort(target, uploadId: "up1")
            XCTFail("expected a throw")
        } catch let e as TransferError {
            XCTAssertEqual(e.reason, .rejected)
            XCTAssertEqual(e.code, ErrorCode.localOnly)
        }
    }

    func testAConnectionFailureThrowsSoTheEngineRetries() async throws {
        let stub = Stub()
        stub.answer = { _ in throw URLError(.notConnectedToInternet) }
        do {
            _ = try await transport(stub).abort(target, uploadId: "up1")
            XCTFail("expected a throw")
        } catch is URLError {}
    }

    func testRevisionsAreReadFromTheirRoute() async throws {
        let stub = Stub()
        stub.answer = { _ in
            PolarisResponse(
                status: 200,
                body: json(
                    #"{"revisions":[{"version":2,"size":5,"sha256":"\#(hex64)","format":"whole","createdAt":9}]}"#))
        }
        guard case .ok(let v) = try await transport(stub).revisions(target) else {
            return XCTFail("expected revisions")
        }
        XCTAssertEqual(v.objectValue?["revisions"]?.arrayValue?.count, 1)
        XCTAssertEqual(stub.sent.last?.url.path, "/djdl/sync/files/saves/slot1/revisions")
    }
}

/// D-9: a person's transfer journal and chunk cache leave with them.
final class CloudSyncFilesPurgeTests: XCTestCase {
    func testAPurgeRemovesTheTransferJournalAndTheChunkCache() async throws {
        let rig = HostRig()
        let host = try await hSignedIn(rig)
        let journal = FileJournal(stateDir: rig.dir)
        journal.put(
            "saves:slot1:1",
            JournalRecord(
                v: transferJournalVersion, id: "saves:slot1:1", kind: "upload", collection: "saves", record: "slot1",
                uploadId: "up1", mode: "single", partBytes: nil, done: [],
                sha256: String(repeating: "0", count: 64), size: 1, expiresAt: 1, state: "running"))
        let cache = FileChunkCache(
            directory: chunkCacheDirectory(stateDir: rig.dir, subject: hALICE, collection: "saves"))
        try cache.put(String(repeating: "ab", count: 32), Data([1, 2, 3]))
        XCTAssertEqual(journal.list().count, 1)
        try await host.purge()
        XCTAssertTrue(journal.list().isEmpty)
        // Only the person's own directory goes, never the cache root.
        let mine = chunkCachePersonDirectory(stateDir: rig.dir, subject: hALICE).path
        XCTAssertFalse(FileManager.default.fileExists(atPath: mine))
        let root = rig.dir.appendingPathComponent(cloudSyncChunksDirName).path
        XCTAssertTrue(FileManager.default.fileExists(atPath: root))
    }
}
