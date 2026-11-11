// `client.cloudSync.export(to:options:)` (U-51.6; WIRE-CONTRACT-V5 §13.12): everything around the export core
// (`Sync/SyncExport.swift`). It checks the preconditions, flushes the machine, pulls the rows as the Worker
// serves them, gives the core a file source over the SDK's transfer engine and a destination, and commits
// the archive. A port of Python's `cloud_sync/export_host.py`.
//
//  - Preconditions. Sync on (the typed `product` N/A, checked by the API), one export per client
//    (`sync-export-failed`, reason `busy`), a signed-in person (`account_required`), the pin
//    (`sync-encryption-pinned`) and the unlocked root in end-to-end mode (`sync-locked`). Nothing is read
//    before they hold.
//  - Pulls. `flush()` (bounded by the sign-out flush window), then the host's own pulls from cursor 0 until
//    `more` is false: at most `SYNC_EXPORT_MAX_PULLS`. Waits (a `Retry-After`, a retry's backoff) add up to at
//    most `SYNC_EXPORT_MAX_WAIT_MS` and one is cut to `SYNC_EXPORT_RETRY_AFTER_MAX_MS`; past either bound the
//    export fails with reason `network`; a cancel ends a wait at once. The rows are the Worker's, so the core
//    opens each as the host codec opens a pull.
//  - Files. Whole files by `Range` of the stored bytes (the engine's `If-Match`), a chunked file by its
//    manifest and its chunks, through the same `FileTransferEngine` that `saves.read` uses (its retries,
//    `Retry-After` and backoff), so they spend the device's hourly file allowance. A file the Worker no
//    longer has, or serves inconsistently, ends short and the core flags it partial.
//  - Destination. A file URL. `<destination>.partial` is created exclusively (`O_CREAT | O_EXCL | O_NOFOLLOW`)
//    at `0600`, with iOS data protection `completeUnlessOpen`, written, flushed to disk and renamed over the
//    destination atomically. A stale `.partial` an earlier crash left is removed first; a destination or
//    partial that is not a regular file (a link, a directory) is refused (reason `destination`). An error or
//    a cancel removes the partial and leaves the old destination as it was. No other plaintext copy exists.
//
// Nothing here logs, or puts in an error, a value, an id or a path.

import Foundation
import PolarisKeyCore

#if canImport(Darwin)
    import Darwin
#elseif canImport(Glibc)
    import Glibc
#elseif canImport(Musl)
    import Musl
#endif

// MARK: the public surface

/// What app code sets for `cloudSync.export`.
public struct CloudSyncExportOptions: Sendable {
    /// Also write each record's kept earlier versions of its file (newest first, after the live one).
    public var includeRevisions: Bool
    /// Plaintext file bytes written and planned, and whether the export is waiting out a `429`.
    public var onProgress: (@Sendable (CloudSyncExportProgress) -> Void)?

    public init(includeRevisions: Bool = false, onProgress: (@Sendable (CloudSyncExportProgress) -> Void)? = nil) {
        self.includeRevisions = includeRevisions
        self.onProgress = onProgress
    }
}

public struct CloudSyncExportProgress: Sendable, Equatable {
    public let done: Int
    public let total: Int
    public let waiting: Bool
}

/// What an export wrote.
public struct CloudSyncExport: Sendable, Equatable {
    public let url: URL
    /// The size of the archive.
    public let bytes: Int
    /// The archive's entries.
    public let entries: Int
    public let settings: Int
    public let records: Int
    public let files: Int
    /// What the export left out or wrote short; see `CloudSyncExportSkipped`.
    public let skipped: [CloudSyncExportSkipped]
    /// Edits not yet pushed when the export read the data: they are not in the archive.
    public let unsynced: Int

    public var path: String { url.path }
}

extension PolarisError {
    /// For `sync-export-failed`: `destination` (the destination cannot be written: a disk that is full, a
    /// path that is not a regular file), `network` (offline, retries spent, or a wait past its bound) or
    /// `busy` (another export of this client is running). Nil for any other error.
    public var exportFailureReason: String? { code == ErrorCode.syncExportFailed ? detail : nil }
}

func syncExportFailed(_ reason: String) -> PolarisError {
    PolarisError(code: ErrorCode.syncExportFailed, message: "The export failed: \(reason)", detail: reason)
}

private func accountRequired() -> PolarisError {
    PolarisError(code: ErrorCode.accountRequired, message: "Cloud Sync needs a signed-in account")
}

// MARK: what the exporter runs on

/// The facts the preconditions settled, and what the core needs for them.
struct ExportBasis: Sendable {
    let e2e: Bool
    let clientId: String
    let codec: (any SyncCodecPort)?
    let fileCodec: (@Sendable (String) throws -> any FileCodec)?
}

struct ExportDeps: Sendable {
    var product: String
    var baseUrl: String
    var transport: any PolarisTransport
    var headers: @Sendable () async -> [String: String]
    var token: @Sendable () async -> String?
    /// The preconditions: throws the typed refusal, else the mode and what the pulls need.
    var basis: @Sendable () async throws -> ExportBasis
    /// Send what is waiting (bounded) and answer how many edits are still unsent.
    var flush: @Sendable () async -> Int
    var now: @Sendable () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }
    var sleep: @Sendable (Double) async throws -> Void = { try await Task.sleep(for: .seconds($0)) }
    /// Data protection for the partial file, applied to it as soon as it exists and before the first byte.
    var protect: @Sendable (String) throws -> Void = exportProtectPartial
    /// `write(2)`, replaceable so a test can fill the disk.
    var writer: @Sendable (Int32, UnsafeRawPointer, Int) -> Int = exportWriteBytes
}

/// iOS data protection of the partial file: `completeUnlessOpen`. It is stricter than the default
/// (`completeUntilFirstUserAuthentication`): once the file is closed it is unreadable while the device is
/// locked. It is not `complete`, because the partial stays open for the whole export, and a device that
/// locks while an export runs must not fail it (an open `completeUnlessOpen` file stays writable; a
/// `complete` one does not). The finished file keeps the class through the rename. macOS has no such
/// attribute; the `0600` mode is the protection there.
@Sendable func exportProtectPartial(_ path: String) throws {
    #if os(iOS) || os(tvOS) || os(visionOS) || os(watchOS)
        try FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUnlessOpen], ofItemAtPath: path)
    #endif
}

// MARK: waiting, bounded

/// Everything the export waits for, added up: past `SYNC_EXPORT_MAX_WAIT_MS` it fails (reason `network`). A
/// cancel ends a wait at once.
final class ExportBudget: @unchecked Sendable {
    private let sleeper: @Sendable (Double) async throws -> Void
    private let onWait: @Sendable (Bool) -> Void
    private let state = LockedValue<(waitedMs: Double, exceeded: Bool)>((0, false))

    init(sleep: @escaping @Sendable (Double) async throws -> Void, onWait: @escaping @Sendable (Bool) -> Void) {
        sleeper = sleep
        self.onWait = onWait
    }

    var exceeded: Bool { state.current.exceeded }
    var waitedMs: Double { state.current.waitedMs }

    func check() throws {
        if Task.isCancelled { throw exportCancelled() }
    }

    /// The engine's `sleep` port as well as the pull loop's.
    func sleep(_ seconds: Double) async throws {
        try check()
        let cut = max(0, min(seconds, Double(SYNC_EXPORT_RETRY_AFTER_MAX_MS) / 1000))
        let over = state.with { s -> Bool in
            if s.waitedMs + cut * 1000 > Double(SYNC_EXPORT_MAX_WAIT_MS) {
                s.exceeded = true
                return true
            }
            s.waitedMs += cut * 1000
            return false
        }
        if over { throw syncExportFailed("network") }
        onWait(true)
        defer { onWait(false) }
        try await sleeper(cut)
        try check()
    }
}

// MARK: the file source

private struct NoJournal: JournalStore {
    func get(_ id: String) -> JSONValue? { nil }
    func put(_ id: String, _ record: JournalRecord) { preconditionFailure("an export keeps no journal") }
    func delete(_ id: String) {}
    func list() -> [String] { [] }
}

/// An `ExportFileSource` over the file routes and the transfer engine.
final class ExportHttpSource: ExportFileSource, @unchecked Sendable {
    private let transport: CloudSyncFileTransport
    private let engine: FileTransferEngine
    private let budget: ExportBudget
    private let hold = Hold()

    init(transport: CloudSyncFileTransport, engine: FileTransferEngine, budget: ExportBudget) {
        self.transport = transport
        self.engine = engine
        self.budget = budget
    }

    /// One route call with the engine's recovery rules. nil is "the Worker has none" (a path the routes
    /// refuse to build, a 404, a 410); any other refusal is the export's failure.
    private func call<T: Sendable>(_ op: () async throws -> FileReply<T>) async throws -> T? {
        let refused = LockedValue<TransferError?>(nil)
        let reply: FileReply<T>
        do {
            reply = try await engine.call(hold) {
                do { return try await op() } catch let e as TransferError {
                    refused.set(e)
                    return .refused(FileRefusal(status: 400, code: "export_rejected"))
                }
            }
        } catch let e as TransferError {
            switch e.reason {
            case .aborted: throw budget.exceeded ? syncExportFailed("network") : exportCancelled()
            case .closed: throw exportCancelled()
            default: throw syncExportFailed("network")
            }
        }
        switch reply {
        case .ok(let v): return v
        case .refused(let r):
            if let e = refused.current {
                if e.code == "bad_path" { return nil }
                if e.code == PolarisError.localOnly {
                    throw PolarisError(code: PolarisError.localOnly, message: "This client is local-only")
                }
                throw syncExportFailed("network")
            }
            if r.status == 404 || r.status == 410 { return nil }
            // An answer the routes cannot use (a body past its bound, no `revisions`): the Worker has no usable
            // copy, which the core flags as a file written short, not as a failure of the export.
            if (200..<300).contains(r.status) && r.code == ErrorCode.badResponse { return nil }
            if r.status == 403 && r.code == ErrorCode.accountRequired { throw accountRequired() }
            throw syncExportFailed("network")
        }
    }

    func pointers(collection: String, record: String) async throws -> [JSONValue] {
        let target = FileTarget(collection: collection, record: record)
        guard let reply = try await call({ try await transport.revisions(target) }),
            case .object(let o) = reply, case .array(let revisions)? = o["revisions"]
        else { return [] }
        return revisions.filter { if case .object = $0 { return true } else { return false } }
    }

    func stored(_ ref: ExportFileRef, _ piece: (Data) async throws -> Bool) async throws {
        let target = FileTarget(collection: ref.collection, record: ref.record)
        if ref.format == "chunks" {
            // The manifest: one unranged `GET`, read under the manifest cap.
            let query = FileQuery(version: ref.version)
            if let body = try await call({ try await transport.getFile(target, query: query) }), body.status == 200 {
                _ = try await piece(body.data)
            }
            return
        }
        var etag: String?
        var at = 0
        while at < ref.size {
            let end = min(ref.size, at + downloadRangeBytes)
            let query = FileQuery(version: ref.version, range: at..<end, ifMatch: etag)
            guard let body = try await call({ try await transport.getFile(target, query: query) }) else { return }
            // A Worker that answers inconsistently (another file, another range, a 200 for a range) ends the
            // stream here; the core flags what was read as partial.
            if let etag, let got = body.etag, got != etag { return }
            if etag == nil { etag = body.etag }
            if body.status == 206 {
                guard let cr = body.contentRange, cr.start == at, cr.total == ref.size, cr.end > cr.start,
                    cr.end <= end,
                    body.data.count == cr.end - cr.start
                else { return }
            } else if body.status != 200 || at != 0 || body.data.count != ref.size {
                return
            }
            at += body.data.count
            guard try await piece(body.data) else { return }
        }
    }

    func chunk(collection: String, id: String) async throws -> Data? {
        try await call({ try await transport.getChunk(collection: collection, chunkId: id) })
    }
}

// MARK: the destination

#if canImport(Darwin)
    let exportWriteBytes: @Sendable (Int32, UnsafeRawPointer, Int) -> Int = { Darwin.write($0, $1, $2) }
#else
    let exportWriteBytes: @Sendable (Int32, UnsafeRawPointer, Int) -> Int = { Glibc.write($0, $1, $2) }
#endif

private func lstatMode(_ path: String) throws -> mode_t? {
    var st = stat()
    if lstat(path, &st) == 0 { return st.st_mode }
    if errno == ENOENT { return nil }
    throw syncExportFailed("destination")
}

private func isRegular(_ mode: mode_t) -> Bool { mode & S_IFMT == S_IFREG }

/// The path destination as an `ExportSink`. Nothing is created until the first write (a refused export
/// leaves nothing); `commit` renames, `discard` removes the partial this object created, and only that.
final class ExportPartialFile: ExportSink, @unchecked Sendable {
    let destination: String
    let partial: String
    private let lock = NSLock()
    private var fd: Int32 = -1
    private var created = false
    private let protect: @Sendable (String) throws -> Void
    private let writer: @Sendable (Int32, UnsafeRawPointer, Int) -> Int

    init(
        destination: URL, protect: @escaping @Sendable (String) throws -> Void = exportProtectPartial,
        writer: @escaping @Sendable (Int32, UnsafeRawPointer, Int) -> Int = exportWriteBytes
    ) throws {
        guard destination.isFileURL, !destination.path.isEmpty, !destination.path.utf8.contains(0) else {
            throw syncExportFailed("destination")
        }
        self.destination = destination.path
        partial = destination.path + ".partial"
        self.protect = protect
        self.writer = writer
    }

    /// Refuse a destination or partial that is not a regular file; remove a stale partial.
    func prepare() throws {
        if let mode = try lstatMode(destination), !isRegular(mode) { throw syncExportFailed("destination") }
        if let mode = try lstatMode(partial) {
            guard isRegular(mode) else { throw syncExportFailed("destination") }
            if unlink(partial) != 0 && errno != ENOENT { throw syncExportFailed("destination") }
        }
    }

    private func openIfNeeded() throws {
        if fd >= 0 { return }
        let flags = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC
        let handle = open(partial, flags, 0o600)
        guard handle >= 0 else { throw syncExportFailed("destination") }
        fd = handle
        created = true
        var st = stat()
        guard fstat(handle, &st) == 0, isRegular(st.st_mode) else { throw syncExportFailed("destination") }
        do { try protect(partial) } catch { throw syncExportFailed("destination") }
    }

    func write(_ data: Data) async throws {
        try lock.withLock {
            try openIfNeeded()
            try data.withUnsafeBytes { raw in
                var done = 0
                while done < raw.count {
                    let n = writer(fd, raw.baseAddress! + done, raw.count - done)
                    if n < 0 {
                        if errno == EINTR { continue }
                        throw syncExportFailed("destination")
                    }
                    if n == 0 { throw syncExportFailed("destination") }
                    done += n
                }
            }
        }
    }

    /// Flush to disk and rename over the destination (replacing it atomically).
    func commit() throws {
        try lock.withLock {
            try openIfNeeded()
            #if canImport(Darwin)
                // The drive's own cache too, where the file system supports it.
                if fcntl(fd, F_FULLFSYNC) != 0 && fsync(fd) != 0 { throw syncExportFailed("destination") }
            #else
                if fsync(fd) != 0 { throw syncExportFailed("destination") }
            #endif
            let closing = fd
            fd = -1
            guard close(closing) == 0 else { throw syncExportFailed("destination") }
            if let mode = try lstatMode(destination), !isRegular(mode) { throw syncExportFailed("destination") }
            guard rename(partial, destination) == 0 else { throw syncExportFailed("destination") }
            created = false
        }
        syncParent()
    }

    private func syncParent() {
        let parent = (destination as NSString).deletingLastPathComponent
        let dir = open(parent.isEmpty ? "." : parent, O_RDONLY | O_CLOEXEC)
        guard dir >= 0 else { return }
        _ = fsync(dir)
        _ = close(dir)
    }

    /// Close and remove the partial; the destination is left as it was.
    func discard() {
        lock.withLock {
            if fd >= 0 {
                _ = close(fd)
                fd = -1
            }
            if created {
                created = false
                _ = unlink(partial)
            }
        }
    }
}

// MARK: the exporter

final class CloudSyncExporter: Sendable {
    private let deps: ExportDeps
    private let busy = LockedValue<Bool>(false)

    init(_ deps: ExportDeps) { self.deps = deps }

    func run(to destination: URL, options: CloudSyncExportOptions) async throws -> CloudSyncExport {
        if Task.isCancelled { throw exportCancelled() }
        guard
            busy.with({ held -> Bool in
                if held { return false }
                held = true
                return true
            })
        else { throw syncExportFailed("busy") }
        defer { busy.set(false) }
        do { return try await runLocked(destination, options) } catch is CancellationError {
            throw exportCancelled()
        } catch let e as PolarisError {
            throw e
        } catch {
            // A cancel can surface as a transport's own error; anything else is the plan's, not the person's.
            throw Task.isCancelled ? exportCancelled() : syncExportFailed("destination")
        }
    }

    private func runLocked(_ destination: URL, _ options: CloudSyncExportOptions) async throws -> CloudSyncExport {
        let basis = try await deps.basis()
        let sink = try ExportPartialFile(destination: destination, protect: deps.protect, writer: deps.writer)
        try sink.prepare()

        let progress = LockedValue<CloudSyncExportProgress>(CloudSyncExportProgress(done: 0, total: 0, waiting: false))
        let onProgress = options.onProgress
        let report: @Sendable (CloudSyncExportProgress) -> Void = { p in
            progress.set(p)
            onProgress?(p)
        }
        let budget = ExportBudget(
            sleep: deps.sleep,
            onWait: { waiting in
                let p = progress.current
                report(CloudSyncExportProgress(done: p.done, total: p.total, waiting: waiting))
            })
        let files = CloudSyncFileTransport(
            product: deps.product, baseUrl: deps.baseUrl, transport: deps.transport, headers: deps.headers,
            token: deps.token)
        let engine = FileTransferEngine(
            transport: files, journal: NoJournal(), sleep: { try await budget.sleep($0) },
            maxAttempts: 8, maxRetryAfterSeconds: Double(SYNC_EXPORT_RETRY_AFTER_MAX_MS) / 1000, parallelism: 1)

        do {
            // Send what is waiting, then read what the Worker holds.
            let unsynced = await deps.flush()
            try budget.check()
            let changes = try await pullAll(basis.clientId, budget)
            let summary = try await exportToSink(
                ExportInput(
                    product: deps.product, exportedAt: deps.now(), unsynced: unsynced,
                    includeRevisions: options.includeRevisions, changes: changes,
                    files: ExportHttpSource(transport: files, engine: engine, budget: budget), codec: basis.codec,
                    fileCodec: basis.fileCodec,
                    onProgress: { done, total in
                        report(CloudSyncExportProgress(done: done, total: total, waiting: false))
                    }
                ), sink)
            try budget.check()
            try sink.commit()
            return CloudSyncExport(
                url: destination, bytes: summary.bytes, entries: summary.entries, settings: summary.settings,
                records: summary.records, files: summary.files, skipped: summary.skipped, unsynced: unsynced)
        } catch {
            sink.discard()
            if error is ExportPlanError { throw syncExportFailed("destination") }
            throw error
        }
    }

    // MARK: pulling

    /// One `GET` of a sync route with the bounded retries: the answer's JSON object.
    private func getJSON(_ path: String, _ budget: ExportBudget) async throws -> [String: JSONValue] {
        guard CloudSyncTransport.isSyncPath(product: deps.product, path), let url = URL(string: deps.baseUrl + path)
        else { throw syncExportFailed("network") }
        #if canImport(FoundationNetworking)
            // The stock session follows redirects before any final-URL check: Cloud Sync does not run over it.
            if deps.transport is URLSessionTransport { throw syncExportFailed("network") }
        #endif
        var attempt = 0
        while true {
            try budget.check()
            guard let token = await deps.token(), !token.isEmpty else { throw accountRequired() }
            var headers = await deps.headers()
            headers["authorization"] = "Bearer \(token)"
            headers["accept"] = "application/json"
            var status = 0
            var body = Data()
            var told: Double?
            do {
                let res = try await deps.transport.send(
                    PolarisRequest(
                        url: url, method: "GET", headers: headers, timeoutSeconds: CloudSyncTransport.timeoutSeconds,
                        maxBodyBytes: CloudSyncTransport.maxResponseBytes + 1, followRedirects: false))
                // A longer body is no answer.
                if res.body.count <= CloudSyncTransport.maxResponseBytes {
                    status = res.status
                    body = res.body
                    told = CloudSyncFileTransport.retryAfter(res.header("retry-after"))
                }
            } catch let e as PolarisError where e.code == PolarisError.localOnly {
                throw e
            } catch {
                // No answer: the network, a timeout. A cancelled task is not one.
                if Task.isCancelled { throw exportCancelled() }
                status = 0
            }
            if status == 200 {
                if case .object(let o)? = try? CanonicalJSON.parseLeniently(utf8: body) { return o }
                throw syncExportFailed("network")
            }
            if status == 403,
                String(decoding: body.prefix(CloudSyncFileBounds.errorMaxBytes), as: UTF8.self)
                    .contains(ErrorCode.accountRequired)
            {
                throw accountRequired()
            }
            if status != 0 && status != 408 && status != 429 && status < 500 { throw syncExportFailed("network") }
            attempt += 1
            if attempt >= 8 { throw syncExportFailed("network") }
            try await budget.sleep(told ?? min(30, 0.5 * pow(2, Double(attempt - 1))))
        }
    }

    /// The rows the Worker holds, as served: a pull from cursor 0 and every page that follows (`more`), a
    /// later row replacing an earlier one and a tombstone removing it. Names are keyed by their UTF-8 bytes.
    private func pullAll(_ clientId: String, _ budget: ExportBudget) async throws -> [JSONValue] {
        var settings: [[UInt8]: JSONValue] = [:]
        var records: [[UInt8]: JSONValue] = [:]
        func key(_ collection: String, _ id: String) -> [UInt8] { Array(collection.utf8) + [0] + Array(id.utf8) }
        func ref(_ v: JSONValue?) -> (String, String)? {
            guard case .array(let r)? = v, r.count >= 2, case .string(let a) = r[0], case .string(let b) = r[1] else {
                return nil
            }
            return (a, b)
        }
        // Rows whose name held a lone surrogate (NaN after the lenient parse): the export lists them.
        var unspellable: [JSONValue] = []
        var cursor = 0
        for _ in 0..<SYNC_EXPORT_MAX_PULLS {
            let body = try await getJSON("/\(deps.product)/sync?cursor=\(cursor)&clientId=\(clientId)", budget)
            for c in body["changes"]?.arrayValue ?? [] {
                guard case .object(let o) = c else { continue }
                if case .string(let name)? = o["setting"] {
                    settings[Array(name.utf8)] = c
                } else if let (collection, id) = ref(o["record"]) {
                    records[key(collection, id)] = c
                } else if o["setting"].map(isUnspellable) == true || isUnspellableRef(o["record"]) {
                    unspellable.append(c)
                }
            }
            for t in body["tombstones"]?.arrayValue ?? [] {
                guard case .object(let o) = t else { continue }
                if case .string(let name)? = o["setting"] { settings[Array(name.utf8)] = nil }
                if let (collection, id) = ref(o["record"]) { records[key(collection, id)] = nil }
            }
            if case .bool(true)? = body["more"] {
                guard isNumber(body["cursor"]), let next = body["cursor"]?.intValue, next > cursor else {
                    throw syncExportFailed("network")
                }
                cursor = next
                continue
            }
            return Array(settings.values) + Array(records.values) + unspellable
        }
        // More pages than the bound allows: the export does not wait for ever on a Worker that never ends.
        throw syncExportFailed("network")
    }

    private func isUnspellableRef(_ v: JSONValue?) -> Bool {
        guard case .array(let r)? = v, r.count >= 2 else { return false }
        return isUnspellable(r[0]) || isUnspellable(r[1])
    }

    private func isNumber(_ v: JSONValue?) -> Bool {
        switch v {
        case .int?, .double?: return true
        default: return false
        }
    }
}

// MARK: the client's wiring

extension ExportDeps {
    /// The preconditions of an export over the started host and the key ring.
    private static func preconditions(
        api: CloudSyncApi, keyring: @Sendable () -> SyncKeyring, account: @Sendable () -> String?
    ) async throws -> ExportBasis {
        guard let host = await api.startedHost(), let facts = await host.exportFacts() else {
            throw syncExportFailed("network")
        }
        let status = facts.status
        if status.code == ErrorCode.syncEncryptionPinned {
            throw PolarisError(
                code: ErrorCode.syncEncryptionPinned, message: "Cloud Sync is pinned to end-to-end encryption")
        }
        let refused = status.state == .blocked && status.reason == .accountRequired
        guard let machineSubject = facts.subject, status.state != .local, !refused else { throw accountRequired() }
        // An unknown subject is not proof of another person.
        if let current = account(), current != machineSubject { throw accountRequired() }
        let ring = keyring()
        if facts.e2e && !ring.unlocked {
            throw PolarisError(code: ErrorCode.syncLocked, message: "Cloud Sync is locked: there is no root")
        }
        if status.state == .blocked { throw syncExportFailed("network") }
        guard let clientId = facts.clientId else { throw syncExportFailed("network") }
        guard facts.e2e else { return ExportBasis(e2e: false, clientId: clientId, codec: nil, fileCodec: nil) }
        let codec: any SyncCodecPort = ring.codec
        let fileCodec: @Sendable (String) throws -> any FileCodec = { try ring.fileCodec(collection: $0) }
        return ExportBasis(e2e: true, clientId: clientId, codec: codec, fileCodec: fileCodec)
    }

    /// The client's own transport, host and key ring.
    static func live(
        core: CoreContext, api: CloudSyncApi, keyring: @escaping @Sendable () -> SyncKeyring,
        account: @escaping @Sendable () -> String?
    ) -> ExportDeps {
        let basis: @Sendable () async throws -> ExportBasis = {
            try await preconditions(api: api, keyring: keyring, account: account)
        }
        let flush: @Sendable () async -> Int = { (try? await api.flush())?.pending ?? 0 }
        let headers: @Sendable () async -> [String: String] = { await core.headers() }
        let token: @Sendable () async -> String? = { await core.token }
        return ExportDeps(
            product: core.product, baseUrl: core.endpoints.baseUrl, transport: core.transport, headers: headers,
            token: token, basis: basis, flush: flush)
    }
}
