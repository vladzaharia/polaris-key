// The Cloud Sync file transfer engine (U-23.S4; WIRE-CONTRACT-V5 §13.8): uploads in modes `single` and
// `multipart` (`FileTransferEngine.upload`) and `chunks` (`uploadChunked`), and downloads of both formats
// (`download`). A port of Python `cloud_sync/transfer.py` over structured concurrency. The engine owns the
// order of calls and the recovery rules, and nothing else. The ports keep it pure: a `FileTransport` (the
// routes of §13.8, typed; a host maps them to HTTP and never lets a server-chosen path through), a
// `JournalStore` (what survives a kill), a `RangedSource` (the bytes to send, read by range, so a part is
// read when it is sent and never held longer), a `FileCodec` (whether and how a collection seals its
// files and chunks) and a `ChunkCache` (the chunk objects a device already holds).
//
//     begin -> parts, at most 4 at once and in any order -> finalize
//
// resume        a journal record for the same transfer id, bytes and record is resumed: the server's
//               `received` list is the truth, so a part the journal calls done but the server lost is sent
//               again. A record past `expiresAt`, or one for other bytes, is dropped and the upload begins
//               afresh.
// 429, 5xx, 408 or no answer (a throw)
//               wait and retry. `Retry-After` is honoured and holds every request of the pass, not just
//               the one that was told; without it the wait doubles from 0.5 s to 30 s, with jitter.
// 410 / 404 inside an upload
//               the upload expired or is gone: forget it and begin again (a few times, then fail). On
//               `begin` and on a download they are a rejection.
// 409           `conflict` (a stale `baseVersion` carries the server's version). Nothing is retried; at
//               finalize the upload is aborted.
// 400 upload_mismatch
//               `mismatch`; no retry can fix the bytes.
//
// A download checks, in order: the declared size and SHA-256 hex, then for each range its status and
// `Content-Range` against what was asked, the ETag held fixed with `If-Match`, the stored length and
// SHA-256 after the last range, then the format's own checks (segment tags; for `chunks` the manifest
// size and hash, the manifest, its size against the record's, per chunk the stored cap, the object's own
// checks and its length, last `plainSize` and `plainSha256`). The sink receives plaintext that is only
// provisional until `download` returns: on a throw the host discards what it wrote. Anything the server
// could have altered is `.fileInvalid`, the client's `sync-file-invalid`.
//
// Cancellation is the task's: cancel the task and the transfer stops at its next step with `.aborted`; the
// journal keeps the progress. A transport is called from several tasks and must be thread-safe.
//
// Nothing here puts a key, a plaintext byte or a bearer token in an error or a log line.

import CryptoKit
import Foundation
import PolarisKeyCore

/// §13.8.1: at most 4 parts in flight.
public let transferMaxParallelParts = SYNC_UPLOAD_PARALLELISM
/// The longest range one request asks for.
public let downloadRangeBytes = 8 * 1024 * 1024
/// The most a stored manifest can be: 16,384 records and the header, before sealing.
private let manifestPlainMaxBytes = SyncManifest.headerBytes + SyncManifest.recordBytes * SYNC_MAX_CHUNKS_PER_FILE

// MARK: Ports

/// The stored bytes of one file, read by half-open range. `size` is fixed for the life of the source.
public protocol RangedSource: Sendable {
    var size: Int { get }
    func read(_ start: Int, _ end: Int) throws -> Data
}

/// A source over bytes already in memory.
public struct DataSource: RangedSource {
    private let data: Data
    public var size: Int { data.count }
    public init(_ data: Data) { self.data = data }
    public func read(_ start: Int, _ end: Int) throws -> Data {
        guard start >= 0, start <= end, end <= data.count else { return Data() }
        return Data(data[data.startIndex + start..<data.startIndex + end])
    }
}

/// Which file a call is about: `record` is the wire id (blinded in E2E mode).
public struct FileTarget: Sendable, Equatable {
    public let collection: String
    public let record: String
    public init(collection: String, record: String) {
        self.collection = collection
        self.record = record
    }
}

/// A refusal is a value; a call that gets no answer at all (the network, a timeout) throws, and the
/// engine retries it. `code` is the server's `error.code`; `body` is the error body (`missing` on
/// `upload_incomplete`, `server.version` on `revision_conflict`).
public struct FileRefusal: Sendable, Equatable {
    public let status: Int
    public let code: String
    public let retryAfterSeconds: Double?
    public let body: JSONValue?
    public init(status: Int, code: String, retryAfterSeconds: Double? = nil, body: JSONValue? = nil) {
        self.status = status
        self.code = code
        self.retryAfterSeconds = retryAfterSeconds
        self.body = body
    }
}

public enum FileReply<T: Sendable>: Sendable {
    case ok(T)
    case refused(FileRefusal)
}

public struct FileQuery: Sendable, Equatable {
    public var version: Int?
    /// Half-open byte range of the stored file.
    public var range: Range<Int>?
    /// An ETag from an earlier answer; a changed file is then 412.
    public var ifMatch: String?
    public init(version: Int? = nil, range: Range<Int>? = nil, ifMatch: String? = nil) {
        self.version = version
        self.range = range
        self.ifMatch = ifMatch
    }
}

/// A file answer, headers parsed.
public struct FileBody: Sendable {
    public let status: Int
    public let data: Data
    /// The `ETag`, verbatim.
    public let etag: String?
    /// A 206's `Content-Range`: bytes `start` up to `end` (exclusive) of `total`.
    public let contentRange: (start: Int, end: Int, total: Int)?
    public init(status: Int, data: Data, etag: String? = nil, contentRange: (start: Int, end: Int, total: Int)? = nil) {
        self.status = status
        self.data = data
        self.etag = etag
        self.contentRange = contentRange
    }
}

/// The upload and download routes of §13.8 under `/<p>/sync/files/{collection}/{id}`. `sha256` is the
/// lowercase hex of the body; a host sends it as `Content-Digest`. Requests and answers are the JSON
/// objects of the wire (`protocol/sync.ts`). A host bounds `getFile` to the range it asked for and
/// `getChunk` to `SYNC_CHUNK_MAX_STORED_BYTES`.
public protocol FileTransport: Sendable {
    func begin(_ target: FileTarget, request: JSONValue) async throws -> FileReply<JSONValue>
    /// `GET …/upload/{uploadId}`.
    func status(_ target: FileTarget, uploadId: String) async throws -> FileReply<JSONValue>
    /// `PUT …/upload/{uploadId}`: the whole body of a `single` upload, or the manifest of a `chunks` one.
    func putSingle(_ target: FileTarget, uploadId: String, body: Data, sha256: String) async throws -> FileReply<Void>
    /// `PUT …/upload/{uploadId}/parts/{n}`, n from 1.
    func putPart(_ target: FileTarget, uploadId: String, n: Int, body: Data, sha256: String) async throws
        -> FileReply<Void>
    /// `DELETE …/upload/{uploadId}`.
    func abort(_ target: FileTarget, uploadId: String) async throws -> FileReply<Void>
    /// `POST …/finalize`.
    func finalize(_ target: FileTarget, request: JSONValue) async throws -> FileReply<JSONValue>
    /// `POST …/upload/{uploadId}/chunks`: at most `SYNC_CHUNK_PLAN_MAX_IDS` ids.
    func planChunks(_ target: FileTarget, uploadId: String, request: JSONValue) async throws -> FileReply<JSONValue>
    /// `PUT …/upload/{uploadId}/chunks/{chunkId}`: one chunk object.
    func putChunk(_ target: FileTarget, uploadId: String, chunkId: String, body: Data, sha256: String) async throws
        -> FileReply<Void>
    /// `GET …/{id}[?version=]`, with `Range` and `If-Match` when asked.
    func getFile(_ target: FileTarget, query: FileQuery) async throws -> FileReply<FileBody>
    /// `GET /<p>/sync/files/{collection}/chunks/{chunkId}`: the object's bytes.
    func getChunk(collection: String, chunkId: String) async throws -> FileReply<Data>
}

// MARK: Errors

/// The reasons of `TransferError`:
///   sourceMismatch      the source's size or hash is not what the caller declared. Nothing was sent.
///   journalVersion      the journal record has a `v` this build does not know. It is left as found.
///   journalMalformed    the journal record is malformed. It is left as found.
///   conflict            a 409: `revision_conflict` (`serverVersion` set) or another.
///   mismatch            `400 upload_mismatch`: the server holds other bytes than were declared.
///   rejected            any other refusal (401, 403, 413, 404 on begin, …): `status` and `code` say which.
///   badReply            the server answered with a mode, part size, plan or range this engine cannot use.
///   retriesExhausted    retries ran out; the journal keeps the progress for a later `upload`.
///   restartsExhausted   the upload kept expiring or vanishing.
///   aborted             the task was cancelled; the journal keeps the progress.
///   fileInvalid         a download failed a check the server could have caused; `detail` says which.
public struct TransferError: Error, Sendable, Equatable, CustomStringConvertible {
    public enum Reason: String, Sendable {
        case sourceMismatch = "source-mismatch"
        case journalVersion = "journal-version"
        case journalMalformed = "journal-malformed"
        case conflict, mismatch, rejected
        case badReply = "bad-reply"
        case retriesExhausted = "retries-exhausted"
        case restartsExhausted = "restarts-exhausted"
        case aborted
        case fileInvalid = "file-invalid"
    }

    public let reason: Reason
    public let status: Int?
    public let code: String?
    /// On a `revision_conflict`: the server's current version.
    public let serverVersion: Int?
    /// On `fileInvalid`: the first check that failed.
    public let detail: String?

    public init(
        _ reason: Reason, status: Int? = nil, code: String? = nil, serverVersion: Int? = nil, detail: String? = nil
    ) {
        self.reason = reason
        self.status = status
        self.code = code
        self.serverVersion = serverVersion
        self.detail = detail
    }

    public var description: String {
        var t = "file transfer: " + reason.rawValue
        if let code { t += " (\(code))" }
        if let detail { t += " [\(detail)]" }
        return t
    }

    /// As the SDK's one error type: a failed check is `sync-file-invalid`.
    public var polarisError: PolarisError {
        switch reason {
        case .fileInvalid:
            return PolarisError(code: ErrorCode.syncFileInvalid, message: description, detail: detail)
        case .aborted:
            return PolarisError(code: ErrorCode.cancelled, message: description)
        default:
            return PolarisError(
                code: code ?? ErrorCode.syncFailed, message: description, detail: detail, status: status)
        }
    }

    fileprivate static func invalid(_ detail: String) -> TransferError { TransferError(.fileInvalid, detail: detail) }
}

private struct Restart: Error {}

// MARK: Requests

public struct UploadRequest: Sendable {
    /// Stable per intended write; the journal key. A rerun with the same id resumes.
    public var id: String
    public var collection: String
    /// The wire record id.
    public var record: String
    public var source: any RangedSource
    /// The stored size, `source.size`.
    public var size: Int
    /// Lowercase hex SHA-256 of the stored bytes.
    public var sha256: String
    public var enc: String
    /// A version number, "*" or nil.
    public var baseVersion: JSONValue?
    /// Stored bytes accepted so far and the stored size.
    public var onProgress: (@Sendable (Int, Int) -> Void)?

    public init(
        id: String, collection: String, record: String, source: any RangedSource, size: Int, sha256: String,
        enc: String, baseVersion: JSONValue? = nil, onProgress: (@Sendable (Int, Int) -> Void)? = nil
    ) {
        self.id = id
        self.collection = collection
        self.record = record
        self.source = source
        self.size = size
        self.sha256 = sha256
        self.enc = enc
        self.baseVersion = baseVersion
        self.onProgress = onProgress
    }
}

public struct ChunkedUploadRequest: Sendable {
    public var id: String
    public var collection: String
    public var record: String
    /// The plaintext of the file.
    public var source: any RangedSource
    public var codec: any FileCodec
    public var baseVersion: JSONValue?
    /// Plaintext bytes accounted for so far (a chunk the server already holds counts at once) and the
    /// file's size.
    public var onProgress: (@Sendable (Int, Int) -> Void)?

    public init(
        id: String, collection: String, record: String, source: any RangedSource, codec: any FileCodec,
        baseVersion: JSONValue? = nil, onProgress: (@Sendable (Int, Int) -> Void)? = nil
    ) {
        self.id = id
        self.collection = collection
        self.record = record
        self.source = source
        self.codec = codec
        self.baseVersion = baseVersion
        self.onProgress = onProgress
    }
}

public struct DownloadRequest: Sendable {
    public var collection: String
    public var record: String
    /// What the record's `file` says: "whole" or "chunks".
    public var format: String
    /// The stored size and SHA-256 (lowercase hex) of that file: for `chunks`, the file's stored size and
    /// the stored manifest's hash.
    public var size: Int
    public var sha256: String
    public var codec: any FileCodec
    /// Receives plaintext in order; provisional until `download` returns.
    public var sink: @Sendable (Data) async throws -> Void
    /// The revision to read (`?version=`); nil is the current one.
    public var version: Int?
    /// Used for `chunks`; the engine reads through it and fills it.
    public var cache: (any ChunkCache)?
    /// Plaintext bytes written and the file's plaintext size.
    public var onProgress: (@Sendable (Int, Int) -> Void)?

    public init(
        collection: String, record: String, format: String, size: Int, sha256: String, codec: any FileCodec,
        version: Int? = nil, cache: (any ChunkCache)? = nil, onProgress: (@Sendable (Int, Int) -> Void)? = nil,
        sink: @escaping @Sendable (Data) async throws -> Void
    ) {
        self.collection = collection
        self.record = record
        self.format = format
        self.size = size
        self.sha256 = sha256
        self.codec = codec
        self.version = version
        self.cache = cache
        self.onProgress = onProgress
        self.sink = sink
    }
}

// MARK: Engine

private func sha256Hex(_ d: Data) -> String { SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined() }

/// A time before which no request is sent: a `Retry-After` holds every part, not just the one told.
private final class Hold: @unchecked Sendable {
    private var until = 0.0
    private let lock = NSLock()
    var value: Double { lock.withLock { until } }
    func raise(to t: Double) { lock.withLock { until = max(until, t) } }
}

public final class FileTransferEngine: Sendable {
    let transport: any FileTransport
    let journal: any JournalStore
    private let now: @Sendable () -> Double
    private let sleeper: @Sendable (Double) async throws -> Void
    private let random: @Sendable () -> Double
    let maxAttempts: Int
    let maxRestarts: Int
    let maxRetryAfter: Double
    let parallelism: Int

    /// `now` is seconds since the epoch; `sleep` waits (and throws when the task is cancelled); `random`
    /// is in [0, 1) for backoff jitter. `maxAttempts` is the attempts per request before
    /// `retriesExhausted`; `maxRestarts` the times it begins afresh after a 410.
    public init(
        transport: any FileTransport, journal: any JournalStore,
        now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 },
        sleep: @escaping @Sendable (Double) async throws -> Void = { try await Task.sleep(for: .seconds($0)) },
        random: @escaping @Sendable () -> Double = { Double.random(in: 0..<1) },
        maxAttempts: Int = 8, maxRestarts: Int = 3, maxRetryAfterSeconds: Double = 900,
        parallelism: Int = transferMaxParallelParts
    ) {
        self.transport = transport
        self.journal = journal
        self.now = now
        self.sleeper = sleep
        self.random = random
        self.maxAttempts = maxAttempts
        self.maxRestarts = maxRestarts
        self.maxRetryAfter = maxRetryAfterSeconds
        self.parallelism = max(1, min(parallelism, transferMaxParallelParts))
    }

    // MARK: Public

    /// Upload one file and finalize it. Returns the `finalize` answer; the journal record is gone by then.
    @discardableResult
    public func upload(_ req: UploadRequest) async throws -> JSONValue {
        guard req.source.size == req.size else { throw TransferError(.sourceMismatch) }
        try verifySource(req)
        // Read before anything is sent: an unreadable record stops the transfer untouched.
        let resume = try await loadRecord(req)
        return try await TransferScope.$id.withValue(req.id) {
            try await restarting(id: req.id) { first in
                try await UploadRun(engine: self, req: req, resume: first ? resume : nil).go()
            }
        }
    }

    /// Upload one file as a manifest over content-defined chunks and finalize it. `req.source` is the
    /// plaintext. Returns the `finalize` answer; the journal record is gone by then.
    @discardableResult
    public func uploadChunked(_ req: ChunkedUploadRequest) async throws -> JSONValue {
        if req.source.size > SYNC_FILE_MAX_BYTES { throw TransferError(.rejected, code: "file_too_large") }
        // Read before anything is sent: an unreadable record stops the transfer untouched. A record of an
        // earlier run only tells which server upload to release.
        try await releasePrior(req.id)
        let cut = try self.cut(req)
        return try await TransferScope.$id.withValue(req.id) {
            try await restarting(id: req.id) { _ in try await ChunkedRun(engine: self, req: req, cut: cut).go() }
        }
    }

    /// Fetch one file and write its plaintext to `req.sink`. Returns when every check has passed; a throw
    /// (`.fileInvalid` for anything the server could have altered) leaves the sink's contents unusable,
    /// and the host discards them.
    public func download(_ req: DownloadRequest) async throws {
        try await TransferScope.$id.withValue("download:\(req.collection)/\(req.record)") {
            try await DownloadRun(engine: self, req: req).go()
        }
    }

    /// Drop a transfer: abort the server's upload (best effort) and forget the record.
    public func cancel(id: String) async {
        // A background transport stops this transfer's tasks and spool files first, whatever the journal holds.
        if let c = transport as? any TransferTaskCancelling { await c.cancelTasks(transferId: id) }
        guard let raw = journal.get(id) else { return }
        guard let rec = try? parseJournalRecord(raw) else { return }  // stays for the build that wrote it
        await abortQuietly(FileTarget(collection: rec.collection, record: rec.record), rec.uploadId)
        journal.delete(id)
    }

    // MARK: Internals

    private func restarting(id: String, _ run: (Bool) async throws -> JSONValue) async throws -> JSONValue {
        var restarts = 0
        while true {
            do {
                return try await run(restarts == 0)
            } catch is Restart {
                if restarts >= maxRestarts { throw TransferError(.restartsExhausted, status: 410) }
                journal.delete(id)
                restarts += 1
            }
        }
    }

    func abortQuietly(_ target: FileTarget, _ uploadId: String) async {
        _ = try? await transport.abort(target, uploadId: uploadId)  // the server expires it within the day
    }

    private func readRecord(_ id: String) throws -> JournalRecord? {
        guard let raw = journal.get(id) else { return nil }
        do { return try parseJournalRecord(raw) } catch let e as TransferJournalError {
            throw TransferError(e.reason == .version ? .journalVersion : .journalMalformed)
        }
    }

    private func releasePrior(_ id: String) async throws {
        guard let rec = try readRecord(id) else { return }
        await abortQuietly(FileTarget(collection: rec.collection, record: rec.record), rec.uploadId)
        journal.delete(id)
    }

    /// The matching journal record, or nil (and the stale one dropped). A record that cannot be read is an
    /// error and stays.
    private func loadRecord(_ req: UploadRequest) async throws -> JournalRecord? {
        guard let rec = try readRecord(req.id) else { return nil }
        let same =
            rec.collection == req.collection && rec.record == req.record && rec.sha256 == req.sha256
            && rec.size == req.size
        // `expiresAt` is epoch MILLISECONDS (V5 §13); `now` is seconds.
        if same && rec.expiresAt > now() * 1000 { return rec }
        if !same { await abortQuietly(FileTarget(collection: rec.collection, record: rec.record), rec.uploadId) }
        journal.delete(req.id)
        return nil
    }

    private func verifySource(_ req: UploadRequest) throws {
        var h = SHA256()
        var at = 0
        while at < req.size {
            let end = min(req.size, at + 1_048_576)
            let piece = try req.source.read(at, end)
            guard piece.count == end - at else { throw TransferError(.sourceMismatch) }
            h.update(data: piece)
            at = end
        }
        guard h.finalize().map({ String(format: "%02x", $0) }).joined() == req.sha256 else {
            throw TransferError(.sourceMismatch)
        }
    }

    /// Pass one over the plaintext: cut it, name the chunks, hash it, and write the manifest.
    fileprivate func cut(_ req: ChunkedUploadRequest) throws -> Cut {
        let source = req.source
        var chunker = SyncCdc.Chunker()
        var whole = SHA256()
        var records: [SyncManifest.Record] = []
        var offsets: [Int] = []
        var at = 0
        func take(_ chunks: [Data]) throws {
            for c in chunks {
                if records.count >= SYNC_MAX_CHUNKS_PER_FILE { throw TransferError(.rejected, code: "file_too_large") }
                records.append(SyncManifest.Record(id: try req.codec.chunkId(c), plainLen: c.count))
                offsets.append(at)
                at += c.count
            }
        }
        var from = 0
        while from < source.size {
            try checkCancelled()
            let end = min(source.size, from + 1_048_576)
            let piece = try source.read(from, end)
            guard piece.count == end - from else { throw TransferError(.sourceMismatch) }
            whole.update(data: piece)
            try take(chunker.push(piece))
            from = end
        }
        try take(chunker.finish())
        let manifest = try SyncManifest.encode(
            SyncManifest.Manifest(plainSize: source.size, plainSha256: Data(whole.finalize()), records: records))
        return Cut(records: records, offsets: offsets, manifest: manifest, plainSize: source.size)
    }

    func checkCancelled() throws {
        if Task.isCancelled { throw TransferError(.aborted) }
    }

    /// One request with the recovery rules: a refusal is returned, a retryable failure is waited out.
    fileprivate func call<T: Sendable>(_ hold: Hold, _ op: () async throws -> FileReply<T>) async throws -> FileReply<T>
    {
        var attempt = 0
        while true {
            try checkCancelled()
            let wait = hold.value - now()
            if wait > 0 {
                do { try await sleeper(wait) } catch { throw TransferError(.aborted) }
            }
            var reply: FileReply<T>?
            do { reply = try await op() } catch is TransferError {
                throw TransferError(.aborted)
            } catch {
                // No answer: the network, a timeout. A cancelled task is not one.
                if Task.isCancelled { throw TransferError(.aborted) }
            }
            if case .ok? = reply { return reply! }
            let refusal: FileRefusal? = { if case .refused(let r)? = reply { return r } else { return nil } }()
            let status = refusal?.status ?? 0
            let retryable = refusal == nil || status == 408 || status == 429 || status >= 500
            if !retryable { return reply! }
            if attempt + 1 >= maxAttempts {
                throw TransferError(.retriesExhausted, status: refusal == nil ? nil : status, code: refusal?.code)
            }
            let delay: Double
            if let told = refusal?.retryAfterSeconds, told >= 0 {
                delay = min(told, maxRetryAfter)
            } else {
                delay = min(30.0, 0.5 * pow(2.0, Double(attempt))) * (0.5 + random() / 2)
            }
            hold.raise(to: now() + delay)
            attempt += 1
        }
    }
}

private struct Cut: Sendable {
    let records: [SyncManifest.Record]
    /// Where each record starts in the plaintext.
    let offsets: [Int]
    /// The plain `pkey-sync-chunks/1` manifest.
    let manifest: Data
    let plainSize: Int
}

/// A refusal that no retry mends, as the error it is. A 410 or 404 starts the upload over.
private func refuseUpload(_ r: FileRefusal) -> Error {
    if r.status == 410 || r.status == 404 { return Restart() }
    if r.status == 409 {
        var v: Int?
        if case .object(let o)? = r.body, case .object(let s)? = o["server"], case .int(let n)? = s["version"] { v = n }
        return TransferError(.conflict, status: 409, code: r.code, serverVersion: v)
    }
    if r.status == 400 && r.code == "upload_mismatch" { return TransferError(.mismatch, status: 400, code: r.code) }
    return TransferError(.rejected, status: r.status, code: r.code)
}

private func unwrap<T: Sendable>(_ reply: FileReply<T>) throws -> T {
    switch reply {
    case .ok(let v): return v
    case .refused(let r): throw refuseUpload(r)
    }
}

/// Run `items` with at most `width` in flight; the first failure cancels the rest and is thrown once
/// they settle.
private func pool<T: Sendable>(_ items: [T], width: Int, _ fn: @escaping @Sendable (T) async throws -> Void)
    async throws
{
    try await withThrowingTaskGroup(of: Void.self) { group in
        var next = 0
        func more() {
            if next < items.count {
                let item = items[next]
                next += 1
                group.addTask { try await fn(item) }
            }
        }
        for _ in 0..<min(width, items.count) { more() }
        while try await group.next() != nil { more() }
    }
}

// MARK: Upload passes

/// A pass that journals: the record, kept in step with what the server holds.
private class UploadPass: @unchecked Sendable {
    let engine: FileTransferEngine
    let target: FileTarget
    let hold = Hold()
    private let lock = NSLock()
    private let progressLock = NSLock()
    private var rec: JournalRecord!

    init(engine: FileTransferEngine, collection: String, record: String) {
        self.engine = engine
        self.target = FileTarget(collection: collection, record: record)
    }

    var record: JournalRecord { lock.withLock { rec } }
    var uploadId: String { record.uploadId }

    func adopt(_ r: JournalRecord) { lock.withLock { rec = r } }

    /// Persist a change to the record. Changes are applied and written under one lock, so a late write
    /// never overtakes an early one.
    func update(_ change: (inout JournalRecord) -> Void) {
        lock.withLock {
            change(&rec)
            engine.journal.put(rec.id, rec)
        }
    }

    func addDone(_ n: Int) {
        update { r in r.done = Array(Set(r.done).union([n])).sorted() }
    }

    func progress(_ body: () -> Void) { progressLock.withLock(body) }

    func send<T: Sendable>(_ op: () async throws -> FileReply<T>) async throws -> FileReply<T> {
        try await engine.call(hold, op)
    }

    func discard() async {
        await engine.abortQuietly(target, uploadId)
        engine.journal.delete(record.id)
    }

    /// `begin`; a refusal is thrown (a 410 or 404 here is not a stale upload, so it surfaces).
    func beginCall(_ request: JSONValue) async throws -> (
        uploadId: String, mode: String, expiresAt: Double, raw: [String: JSONValue]
    ) {
        let reply = try await send { try await engine.transport.begin(target, request: request) }
        switch reply {
        case .refused(let r):
            if r.status == 410 || r.status == 404 { throw TransferError(.rejected, status: r.status, code: r.code) }
            throw refuseUpload(r)
        case .ok(let v):
            guard case .object(let o) = v, case .string(let id)? = o["uploadId"], !id.isEmpty,
                case .string(let mode)? = o["mode"], let exp = o["expiresAt"]?.doubleValue
            else { throw TransferError(.badReply) }
            return (id, mode, exp, o)
        }
    }

    func begun(
        id: String, uploadId: String, mode: String, partBytes: Int?, sha256: String, size: Int, expiresAt: Double
    ) {
        adopt(
            JournalRecord(
                v: transferJournalVersion, id: id, kind: "upload", collection: target.collection,
                record: target.record, uploadId: uploadId, mode: mode, partBytes: partBytes, done: [],
                sha256: sha256, size: size, expiresAt: expiresAt, state: "uploading"))
        update { _ in }
    }

    /// `finalize`. On `409 upload_incomplete` (at most twice) `resend` gets the `missing` list and sends
    /// those again, answering false when the list is not one this upload could have; a 409 or a mismatch
    /// otherwise releases the upload.
    func finalizeCall(resend: (JSONValue?) async throws -> Bool) async throws -> JSONValue {
        var again = 0
        while true {
            let reply = try await send {
                try await engine.transport.finalize(target, request: .object(["uploadId": .string(uploadId)]))
            }
            switch reply {
            case .ok(let v):
                engine.journal.delete(record.id)
                return v
            case .refused(let r):
                var missing: JSONValue?
                if case .object(let o)? = r.body { missing = o["missing"] }
                if r.status == 409 && r.code == "upload_incomplete" && again < 2, try await resend(missing) {
                    again += 1
                    continue
                }
                if r.status == 409 || (r.status == 400 && r.code == "upload_mismatch") { await discard() }
                throw refuseUpload(r)
            }
        }
    }
}

/// One pass at one `single` or `multipart` upload: begin or resume, send what is missing, finalize.
private final class UploadRun: UploadPass, @unchecked Sendable {
    let req: UploadRequest
    let resume: JournalRecord?

    init(engine: FileTransferEngine, req: UploadRequest, resume: JournalRecord?) {
        self.req = req
        self.resume = resume
        super.init(engine: engine, collection: req.collection, record: req.record)
    }

    func go() async throws -> JSONValue {
        if let resume {
            adopt(resume)
            if resume.state == "uploading" { try await reconcile() }
        } else {
            try await begin()
        }
        if record.state == "uploading" {
            try await sendMissing()
            update { $0.state = "finalizing" }
        }
        return try await finalizeCall { missing in
            let parts = self.partCount
            guard case .array(let list)? = missing else { return false }
            var lost = Set<Int>()
            for n in list {
                guard case .int(let k) = n, k >= 1, k <= parts else { return false }
                lost.insert(k)
            }
            self.update {
                $0.state = "uploading"
                $0.done = $0.done.filter { !lost.contains($0) }
            }
            try await self.sendMissing()
            self.update { $0.state = "finalizing" }
            return true
        }
    }

    private var partCount: Int {
        let r = record
        if r.mode == "multipart", let pb = r.partBytes { return (r.size + pb - 1) / pb }
        return 1
    }

    private func begin() async throws {
        let r = req
        var request: [String: JSONValue] = [
            "size": .int(r.size), "sha256": .string(r.sha256), "format": .string("whole"), "enc": .string(r.enc),
        ]
        if let bv = r.baseVersion, bv != .null { request["baseVersion"] = bv }
        let b = try await beginCall(.object(request))
        var partBytes: Int?
        if b.mode == "multipart" {
            let pb = b.raw["partBytes"]?.intValue
            guard let pb, pb >= 1, pb <= SYNC_PART_MAX_BYTES, (r.size + pb - 1) / pb <= SYNC_MAX_PARTS else {
                await engine.abortQuietly(target, b.uploadId)
                throw TransferError(.badReply)
            }
            partBytes = pb
        } else if b.mode != "single" || r.size > SYNC_SINGLE_PUT_MAX_BYTES {
            // `chunks` is the other upload; a file this big is never one PUT.
            await engine.abortQuietly(target, b.uploadId)
            throw TransferError(.badReply)
        }
        begun(
            id: r.id, uploadId: b.uploadId, mode: b.mode, partBytes: partBytes, sha256: r.sha256, size: r.size,
            expiresAt: b.expiresAt)
    }

    /// The server's list of received parts replaces the journal's `done`.
    private func reconcile() async throws {
        let id = uploadId
        let v = try unwrap(try await send { try await engine.transport.status(target, uploadId: id) })
        guard record.mode == "multipart" else { return }
        var got: [Int] = []
        if case .object(let o) = v, case .array(let list)? = o["received"] {
            let parts = partCount
            got = list.compactMap { v in v.intValue.flatMap { $0 >= 1 && $0 <= parts ? $0 : nil } }
        }
        update { $0.done = Array(Set(got)).sorted() }
    }

    /// Part `n` (from 1) as a half-open byte range of the stored file, at the part size `begin` answered.
    private func partRange(_ r: JournalRecord, _ n: Int) -> Range<Int>? {
        guard let pb = r.partBytes, n >= 1, n <= partCount else { return nil }
        let start = (n - 1) * pb
        return start..<min(r.size, start + pb)
    }

    private func reportProgress() {
        let r = record
        var sent = 0
        if r.mode == "single" {
            sent = r.done.isEmpty ? 0 : r.size
        } else {
            for n in r.done { if let range = partRange(r, n) { sent += range.count } }
        }
        if let cb = req.onProgress { progress { cb(sent, r.size) } }
    }

    private func sendMissing() async throws {
        let done = Set(record.done)
        let queue = (1...partCount).filter { !done.contains($0) }
        try await pool(queue, width: engine.parallelism) { n in try await self.sendPart(n) }
    }

    private func sendPart(_ n: Int) async throws {
        let r = record
        let range: Range<Int> =
            r.mode == "single" ? 0..<r.size : (partRange(r, n) ?? 0..<0)
        let body = try req.source.read(range.lowerBound, range.upperBound)
        guard body.count == range.count else { throw TransferError(.sourceMismatch) }
        let digest = sha256Hex(body)
        let id = r.uploadId
        if r.mode == "single" {
            _ = try unwrap(
                try await send {
                    try await engine.transport.putSingle(target, uploadId: id, body: body, sha256: digest)
                })
        } else {
            _ = try unwrap(
                try await send {
                    try await engine.transport.putPart(target, uploadId: id, n: n, body: body, sha256: digest)
                })
        }
        addDone(n)
        reportProgress()
    }
}

/// One pass at one `chunks` upload: begin, plan, send the missing chunks, the manifest, finalize.
private final class ChunkedRun: UploadPass, @unchecked Sendable {
    let req: ChunkedUploadRequest
    let cut: Cut
    private var stored = Data()
    private var storedSha = ""
    /// hex id -> the first record that has it, and the ids in file order.
    private var unique: [String: Int] = [:]
    private var ids: [String] = []
    private var accounted = 0

    init(engine: FileTransferEngine, req: ChunkedUploadRequest, cut: Cut) {
        self.req = req
        self.cut = cut
        super.init(engine: engine, collection: req.collection, record: req.record)
        for (i, r) in cut.records.enumerated() {
            let hex = r.id.map { String(format: "%02x", $0) }.joined()
            if unique[hex] == nil {
                unique[hex] = i
                ids.append(hex)
            }
        }
    }

    func go() async throws -> JSONValue {
        try await begin()
        account(0)
        let missing = try await plan()
        try await pool(missing, width: engine.parallelism) { id in try await self.sendChunk(id) }
        try await sendManifest()
        return try await finalizeCall { lost in
            guard case .array(let list)? = lost else { return false }
            var wanted: [String] = []
            for v in list {
                guard case .string(let s) = v, self.unique[s] != nil else { return false }
                wanted.append(s)
            }
            try await pool(wanted, width: self.engine.parallelism) { id in try await self.sendChunk(id) }
            return true
        }
    }

    private func account(_ add: Int) {
        progress {
            accounted += add
            req.onProgress?(accounted, cut.plainSize)
        }
    }

    private func bad() async throws -> Never {
        await discard()
        throw TransferError(.badReply)
    }

    private func begin() async throws {
        let r = req
        // A sealed manifest is different on every run, so it is sealed per begin.
        stored = try r.codec.sealManifest(cut.manifest)
        storedSha = sha256Hex(stored)
        let size = r.codec.storedSize(cut.plainSize)
        var request: [String: JSONValue] = [
            "size": .int(size), "sha256": .string(storedSha), "format": .string("chunks"), "enc": .string(r.codec.enc),
        ]
        if let bv = r.baseVersion, bv != .null { request["baseVersion"] = bv }
        let b = try await beginCall(.object(request))
        guard b.mode == "chunks" else {
            await engine.abortQuietly(target, b.uploadId)
            throw TransferError(.badReply)
        }
        begun(
            id: r.id, uploadId: b.uploadId, mode: "chunks", partBytes: nil, sha256: storedSha, size: size,
            expiresAt: b.expiresAt)
    }

    /// The ids the server lacks, in file order. Every id sent is answered exactly once or the reply is
    /// refused.
    private func plan() async throws -> [String] {
        var missing = Set<String>()
        var at = 0
        while at < ids.count {
            let batch = Array(ids[at..<min(ids.count, at + SYNC_CHUNK_PLAN_MAX_IDS)])
            at += SYNC_CHUNK_PLAN_MAX_IDS
            let asked = Set(batch)
            let entries: [JSONValue] = batch.map {
                .array([.string($0), .int(req.codec.chunkObjectBytes(cut.records[unique[$0]!].plainLen))])
            }
            let id = uploadId
            let reply = try unwrap(
                try await send {
                    try await engine.transport.planChunks(
                        target, uploadId: id, request: .object(["chunks": .array(entries)]))
                })
            guard case .object(let o) = reply, case .array(let miss)? = o["missing"],
                case .array(let present)? = o["present"]
            else { try await bad() }
            var said = Set<String>()
            for m in miss {
                guard case .string(let s) = m, asked.contains(s), !said.contains(s) else { try await bad() }
                said.insert(s)
                missing.insert(s)
            }
            for entry in present {
                guard case .array(let pair) = entry, case .string(let s)? = pair.first, asked.contains(s),
                    !said.contains(s)
                else { try await bad() }
                said.insert(s)
                account(cut.records[unique[s]!].plainLen)
            }
            if said.count != asked.count { try await bad() }
        }
        return ids.filter { missing.contains($0) }
    }

    private func sendChunk(_ id: String) async throws {
        guard let i = unique[id] else { throw TransferError(.badReply) }
        let rec = cut.records[i]
        let start = cut.offsets[i]
        let codec = req.codec
        let plain = try req.source.read(start, start + rec.plainLen)
        // The file may have changed since it was cut: what is sent must still be the chunk named.
        guard plain.count == rec.plainLen, try codec.chunkId(plain) == rec.id else {
            throw TransferError(.sourceMismatch)
        }
        let object = try codec.sealChunk(id: rec.id, plain: plain)
        let digest = sha256Hex(object)
        let up = uploadId
        _ = try unwrap(
            try await send {
                try await engine.transport.putChunk(target, uploadId: up, chunkId: id, body: object, sha256: digest)
            })
        account(rec.plainLen)
    }

    private func sendManifest() async throws {
        let up = uploadId
        let body = stored
        let sha = storedSha
        _ = try unwrap(
            try await send { try await engine.transport.putSingle(target, uploadId: up, body: body, sha256: sha) })
        update { $0.state = "finalizing" }
    }
}

// MARK: Download

/// One download: fetch the stored bytes, check them, and write the plaintext.
private final class DownloadRun: @unchecked Sendable {
    let engine: FileTransferEngine
    let req: DownloadRequest
    let target: FileTarget
    let hold = Hold()
    private var written = 0
    private var total = 0

    init(engine: FileTransferEngine, req: DownloadRequest) {
        self.engine = engine
        self.req = req
        target = FileTarget(collection: req.collection, record: req.record)
    }

    func go() async throws {
        let size = req.size
        if size <= 0 || size > req.codec.storedSize(SYNC_FILE_MAX_BYTES) { throw TransferError.invalid("size") }
        if req.sha256.count != 64 || !isHex64(req.sha256) { throw TransferError.invalid("sha256") }
        do {
            if req.format == "whole" { try await whole() } else { try await chunked() }
        } catch let f as SyncFileStream.Failure {
            throw TransferError.invalid(f.reason.rawValue)
        }
    }

    private func emit(_ piece: Data) async throws {
        if piece.isEmpty { return }
        try await req.sink(piece)
        written += piece.count
        req.onProgress?(written, total)
    }

    private func refuse(_ r: FileRefusal) -> Error {
        // Nothing here restarts: a 404 or 410 means the revision is gone.
        TransferError(.rejected, status: r.status, code: r.code)
    }

    private func value<T: Sendable>(_ reply: FileReply<T>) throws -> T {
        switch reply {
        case .ok(let v): return v
        case .refused(let r): throw refuse(r)
        }
    }

    /// A whole file: ranges of the stored bytes, opened as they arrive. Every range is asked with the ETag
    /// the first answer gave (`If-Match`), its status and `Content-Range` are checked against what was
    /// asked, and the length and SHA-256 are checked after the last one.
    private func whole() async throws {
        guard let plainSize = req.codec.plainSize(req.size) else { throw TransferError.invalid("size") }
        total = plainSize
        let opener = try req.codec.makeOpener()
        var digest = SHA256()
        var etag: String?
        var at = 0
        while at < req.size {
            try engine.checkCancelled()
            let end = min(req.size, at + downloadRangeBytes)
            let ask = at
            let query = FileQuery(version: req.version, range: ask..<end, ifMatch: etag)
            let body = try value(
                try await engine.call(hold) { try await engine.transport.getFile(target, query: query) })
            if let etag, let got = body.etag, got != etag { throw TransferError(.badReply, detail: "etag") }
            if etag == nil { etag = body.etag }
            let piece = body.data
            if body.status == 206 {
                guard let cr = body.contentRange, cr.start == ask, cr.total == req.size, cr.end > cr.start,
                    cr.end <= end, piece.count == cr.end - cr.start
                else { throw TransferError(.badReply, detail: "content-range") }
            } else if body.status == 200 {
                // A server that ignores `Range` sends the whole file, which only fits from the start.
                guard ask == 0, piece.count == req.size else { throw TransferError(.badReply, detail: "status") }
            } else {
                throw TransferError(.badReply, detail: "status")
            }
            digest.update(data: piece)
            at += piece.count
            for plain in try opener.push(piece) { try await emit(plain) }
        }
        guard digest.finalize().map({ String(format: "%02x", $0) }).joined() == req.sha256 else {
            throw TransferError.invalid("sha256")
        }
        try await emit(try opener.finish())
        if written != plainSize { throw TransferError.invalid("size") }
    }

    /// A chunked file: the manifest, then each chunk from the cache or the server.
    private func chunked() async throws {
        let codec = req.codec
        let manifestMax = codec.storedSize(manifestPlainMaxBytes)
        let query = FileQuery(version: req.version)
        let body = try value(try await engine.call(hold) { try await engine.transport.getFile(target, query: query) })
        let stored = body.data
        if body.status != 200 { throw TransferError(.badReply, detail: "status") }
        if stored.count > manifestMax { throw TransferError.invalid("manifest-size") }
        if sha256Hex(stored) != req.sha256 { throw TransferError.invalid("sha256") }
        let openedManifest = try codec.openManifest(stored)
        guard case .ok(let plainManifest) = openedManifest else {
            if case .invalid(let r) = openedManifest { throw TransferError.invalid("manifest-" + r) }
            throw TransferError.invalid("manifest")
        }
        let manifest: SyncManifest.Manifest
        switch SyncManifest.parse(plainManifest) {
        case .ok(let m): manifest = m
        case .invalid(let r): throw TransferError.invalid("manifest-" + r.rawValue)
        }
        // The record's size and the manifest's must agree.
        if codec.storedSize(manifest.plainSize) != req.size { throw TransferError.invalid("size") }
        total = manifest.plainSize
        var reassembly = try SyncFileStream.Reassembly(plainSize: manifest.plainSize, plainSha256: manifest.plainSha256)
        let records = manifest.records
        // A short window of chunks in flight, delivered in file order.
        var next = 0
        while next < records.count {
            try engine.checkCancelled()
            let batch = Array(records[next..<min(records.count, next + engine.parallelism)])
            next += batch.count
            let plains = try await withThrowingTaskGroup(of: (Int, Data).self) { group -> [Data] in
                for (i, rec) in batch.enumerated() { group.addTask { (i, try await self.fetchOne(rec)) } }
                var out = [Data](repeating: Data(), count: batch.count)
                for try await (i, d) in group { out[i] = d }
                return out
            }
            for plain in plains {
                try reassembly.push(plain)
                try await emit(plain)
            }
        }
        try reassembly.finish()
    }

    private func fetchOne(_ rec: SyncManifest.Record) async throws -> Data {
        let codec = req.codec
        let id = rec.id.map { String(format: "%02x", $0) }.joined()
        if let cache = req.cache {
            if let held = try? cache.get(id) {
                if case .ok(let plain) = try codec.openChunk(id: rec.id, object: held), plain.count == rec.plainLen {
                    return plain
                }
                try? cache.delete(id)  // damage costs a fetch
            }
        }
        let object = try value(
            try await engine.call(hold) { try await engine.transport.getChunk(collection: req.collection, chunkId: id) }
        )
        if object.count > SYNC_CHUNK_MAX_STORED_BYTES { throw TransferError.invalid("chunk-size") }
        switch try codec.openChunk(id: rec.id, object: object) {
        case .invalid(let r): throw TransferError.invalid("chunk-" + r)
        case .ok(let plain):
            if plain.count != rec.plainLen { throw TransferError.invalid("chunk-length") }
            try? req.cache?.put(id, object)
            return plain
        }
    }
}
