// Cloud Sync background transfers (U-41.1, U-41.2): the bulk bodies of a file transfer (a part, a chunk, a
// ranged read) travel on a background `URLSession` (`pkey.sync.<product>`), so the system finishes them
// while the app is suspended and relaunches the app when they are done. The engine is unchanged: it
// still calls the `FileTransport`, and `CloudSyncFileTransport` hands the bulk requests to a `BulkChannel`
// (this file's `CloudSyncBackground`) instead of its foreground transport. The JSON calls (begin, status,
// plan, finalize) stay in the foreground, where the engine can read the answer.
//
// Spool. A body is written to a file first (`<state>/cloud-sync-spool/<random hex>.bin`, 0600, the
// directory 0700, excluded from backup, `completeUntilFirstUserAuthentication`) and the task uploads from
// that file; a read downloads to a file the delegate reads and removes. The spool holds what the engine
// already sealed: ciphertext in E2E mode, never a key. A file is named by random hex, never by an id.
//
// The task tag (`taskDescription`) is `pkbg1|<sha256(transfer id)>|up|dn|<part>|<enqueued at>|<spool>`:
// the hash of the transfer id (the journal's own file name is that hash, so a record is found without
// putting a save name into the system's task table), the part number, when the task was made and the
// spool file. The engine's transfer id reaches the channel as a task-local (`TransferScope`).
//
// Tokens. A URLRequest's headers are fixed when the task is made, and a background task can run long
// after, so:
//  - the bearer is read from the store at the instant the task is made, never taken from the request the
//    engine built earlier, and never written anywhere but that task's headers (the system's
//    `nsurlsessiond` holds it for the task's life);
//  - a task older than `maxTaskAge` is cancelled at relaunch (its token may be stale) and its transfer is
//    handed back for resume, after one token refresh; resume makes new tasks with the refreshed token;
//  - a 401 on a task refreshes the token once and sends the task again; a second 401 is the answer;
//  - sign-out, forget and lock close the channel (`close()`): waiting calls end `.closed` (the transfer is
//    over, not paused), every task of the session is cancelled, the spool is deleted, and nothing new is
//    enqueued, and no late completion is read, until `open()` (a person signs in).
//
// A cancel is final: `cancelTasks(transferId:)` cancels that transfer's tasks and spool, and leaves the id
// tombstoned so a late completion never writes the journal after the engine deleted its record.
//
// Relaunch. `PolarisKeyClient.handleBackgroundEvents(identifier:completion:)` hands the system's completion
// to the session; the delegate's late completions (no one is waiting) feed the journal: a 2xx part is
// added to the record's `done`. The server's `received` list stays the truth at resume.
//
// The token and the body are never logged or put in an error.

#if canImport(CryptoKit)
    import CryptoKit
#else
    import Crypto
#endif
import Foundation
import PolarisKeyCore
import PolarisKeyPlatform

#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

public let cloudSyncSpoolDirName = "cloud-sync-spool"

/// The transfer a bulk call belongs to, set by the engine for the length of an upload or a download.
public enum TransferScope {
    @TaskLocal public static var id: String?
}

/// Where the file transport sends the bulk bodies of a transfer.
public protocol BulkChannel: Sendable {
    /// One request. A PUT body is sent from a file; a GET is written to a file and read back. A 401 is an
    /// answer (the channel has already refreshed the token once). A call that gets no answer throws.
    func perform(_ request: PolarisRequest) async throws -> PolarisResponse
    /// Cancel a transfer's tasks and delete its spool files.
    func cancelTasks(transferId: String) async
}

/// A transport that can cancel the tasks of a transfer (the engine's `cancel`).
public protocol TransferTaskCancelling: Sendable {
    func cancelTasks(transferId: String) async
}

/// How the channel gets the bearer. `current` is read per task; `refresh` re-acquires once and answers the
/// new token (nil when none could be had).
public struct BackgroundTokens: Sendable {
    public var current: @Sendable () async -> String?
    public var refresh: @Sendable () async -> String?
    public init(
        current: @escaping @Sendable () async -> String?, refresh: @escaping @Sendable () async -> String? = { nil }
    ) {
        self.current = current
        self.refresh = refresh
    }
}

// MARK: The channel

/// Reconcile's answer: the transfers (their journal ids) that have to be resumed, and what was cleared.
public struct BackgroundReconcileReport: Sendable, Equatable {
    public var resume: [String] = []
    public var cancelledTasks = 0
    public var sweptFiles = 0
}

public final class CloudSyncBackground: BulkChannel, TransferTaskCancelling, BackgroundSink, @unchecked Sendable {
    /// A task older than this is not trusted to carry a live token (seconds).
    public static let defaultMaxTaskAge = 1800.0
    /// The most of an upload's answer that is kept.
    static let answerCap = CloudSyncFileBounds.errorMaxBytes + 1

    private struct Waiter {
        var cont: CheckedContinuation<PolarisResponse, any Error>
        var idHash: String
        var spool: String?
    }

    private let product: String
    private let spoolDir: URL
    private let journal: any JournalStore
    private let port: any BackgroundSessionPort
    private let tokens: BackgroundTokens
    private let now: @Sendable () -> Double
    private let maxTaskAge: Double
    private let onResume: @Sendable ([String]) -> Void

    private let lock = NSLock()
    private var waiters: [Int: Waiter] = [:]
    private var claimed: Set<String> = []
    private var tombstones: Set<String> = []
    private var closed = false
    private var eventsDone = false
    private var completion: (@Sendable () -> Void)?

    /// The session identifier for a product.
    public static func identifier(product: String) -> String { "pkey.sync.\(product)" }

    init(
        product: String, stateDir: URL, journal: any JournalStore, port: any BackgroundSessionPort,
        tokens: BackgroundTokens, maxTaskAge: Double = CloudSyncBackground.defaultMaxTaskAge,
        now: @escaping @Sendable () -> Double = { Date().timeIntervalSince1970 },
        onResume: @escaping @Sendable ([String]) -> Void = { _ in }
    ) {
        self.product = product
        self.spoolDir = stateDir.appendingPathComponent(cloudSyncSpoolDirName, isDirectory: true)
        self.journal = journal
        self.port = port
        self.tokens = tokens
        self.maxTaskAge = maxTaskAge
        self.now = now
        self.onResume = onResume
        port.start(sink: self)
    }

    #if canImport(Darwin)
        /// The live channel: a background session named for the product, registered for
        /// `PolarisKeyClient.handleBackgroundEvents`.
        public convenience init(
            product: String, stateDir: URL, journal: any JournalStore, tokens: BackgroundTokens,
            maxTaskAge: Double = CloudSyncBackground.defaultMaxTaskAge,
            onResume: @escaping @Sendable ([String]) -> Void = { _ in }
        ) {
            self.init(
                product: product, stateDir: stateDir, journal: journal,
                port: URLSessionBackgroundPort(
                    identifier: Self.identifier(product: product), defaultLimit: Self.answerCap), tokens: tokens,
                maxTaskAge: maxTaskAge, onResume: onResume)
            CloudSyncBackgroundRegistry.shared.register(self)
        }
    #endif

    var identifier: String { Self.identifier(product: product) }

    // MARK: Open and close

    /// Sign-out, forget and lock: the waiting calls end `.closed`, every task is cancelled, the spool is
    /// deleted, and nothing is enqueued until `open()`. The close is sticky: only `open()` undoes it.
    public func close() async {
        let doomed = lock.withLock { () -> [Waiter] in
            closed = true
            let w = Array(waiters.values)
            waiters.removeAll()
            return w
        }
        for w in doomed { w.cont.resume(throwing: TransferError(.closed)) }
        for t in await port.liveTasks() { t.cancel() }
        lock.withLock { claimed.removeAll() }
        try? FileManager.default.removeItem(at: spoolDir)
    }

    /// A person is signed in again: new transfers may enqueue.
    public func open() { lock.withLock { closed = false } }

    // MARK: perform

    public func perform(_ request: PolarisRequest) async throws -> PolarisResponse {
        let id = TransferScope.id ?? "download"
        let hash = backgroundIdHash(id)
        lock.withLock { _ = tombstones.remove(hash) }
        var refreshed = false
        var used: String?
        while true {
            guard let token = await tokens.current(), !token.isEmpty else {
                return PolarisResponse(status: 401, body: Data())
            }
            used = token
            let res = try await runOnce(request, bearer: token, idHash: hash)
            if res.status == 401, !refreshed {
                refreshed = true
                if let next = await tokens.refresh(), !next.isEmpty, next != used { continue }
            }
            return res
        }
    }

    private func gate() throws {
        if lock.withLock({ closed }) { throw TransferError(.closed) }
        if Task.isCancelled { throw TransferError(.aborted) }
    }

    private func runOnce(_ request: PolarisRequest, bearer: String, idHash: String) async throws -> PolarisResponse {
        try gate()
        var urlRequest = URLRequest(url: request.url)
        urlRequest.httpMethod = request.method
        for (k, v) in request.headers where k.lowercased() != "authorization" && k.lowercased() != "content-length" {
            urlRequest.setValue(v, forHTTPHeaderField: k)
        }
        urlRequest.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        if request.timeoutSeconds > 0 { urlRequest.timeoutInterval = request.timeoutSeconds }
        urlRequest.httpShouldHandleCookies = false
        urlRequest.cachePolicy = .reloadIgnoringLocalCacheData
        let uploading = request.body != nil
        var tag = BackgroundTag(
            idHash: idHash, kind: uploading ? .up : .dn, part: Self.part(of: request.url), enqueuedAt: Int(now()),
            spool: nil)
        var spoolURL: URL?
        if let body = request.body {
            let name = SyncCrypto.random(16).map { String(format: "%02x", $0) }.joined() + ".bin"
            let url = spoolDir.appendingPathComponent(name)
            lock.withLock { _ = claimed.insert(name) }
            do { try cloudSyncWriteAtomic(body, to: url) } catch {
                lock.withLock { _ = claimed.remove(name) }
                throw TransferError(.rejected, code: "spool_failed")
            }
            #if os(iOS) || os(tvOS) || os(watchOS) || os(visionOS)
                try? FileManager.default.setAttributes(
                    [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                    ofItemAtPath: spoolDir.path)
            #endif
            tag.spool = name
            spoolURL = url
        }
        let maxBody = max(request.maxBodyBytes ?? Self.answerCap, 1)
        let task: any BackgroundTaskRef =
            spoolURL.map { port.makeUpload(urlRequest, from: $0, tag: tag.text, maxBody: maxBody) }
            ?? port.makeDownload(urlRequest, tag: tag.text, maxBody: maxBody)
        defer { if let name = tag.spool { release(spool: name) } }
        let key = task.taskIdentifier
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<PolarisResponse, any Error>) in
                let refuse = lock.withLock { () -> TransferError? in
                    if closed { return TransferError(.closed) }
                    if Task.isCancelled { return TransferError(.aborted) }
                    waiters[key] = Waiter(cont: cont, idHash: idHash, spool: tag.spool)
                    return nil
                }
                if let refuse {
                    task.cancel()
                    cont.resume(throwing: refuse)
                } else {
                    task.resume()
                }
            }
        } onCancel: {
            let w = lock.withLock { waiters.removeValue(forKey: key) }
            task.cancel()
            w?.cont.resume(throwing: TransferError(.aborted))
        }
    }

    private func release(spool name: String) {
        lock.withLock { _ = claimed.remove(name) }
        try? FileManager.default.removeItem(at: spoolDir.appendingPathComponent(name))
    }

    /// The part a path names: `…/parts/<n>`, 1 for the single body, 0 for anything else.
    static func part(of url: URL) -> Int {
        let p = url.path.split(separator: "/").map(String.init)
        if let i = p.lastIndex(of: "parts"), i + 1 < p.count, let n = Int(p[i + 1]) { return n }
        if let i = p.lastIndex(of: "upload"), i + 2 == p.count, !p.contains("chunks") { return 1 }
        return 0
    }

    // MARK: Cancel

    public func cancelTasks(transferId: String) async {
        let hash = backgroundIdHash(transferId)
        let doomed = lock.withLock { () -> [Waiter] in
            tombstones.insert(hash)
            let keys = waiters.filter { $0.value.idHash == hash }.map(\.key)
            return keys.compactMap { waiters.removeValue(forKey: $0) }
        }
        for w in doomed { w.cont.resume(throwing: TransferError(.aborted)) }
        for t in await port.liveTasks() {
            guard let tag = BackgroundTag.parse(t.tag), tag.idHash == hash else { continue }
            t.cancel()
            if let name = tag.spool { release(spool: name) }
        }
    }

    // MARK: Delegate side

    package func taskFinished(_ r: BackgroundResult) {
        if let w = lock.withLock({ waiters.removeValue(forKey: r.taskIdentifier) }) {
            if let e = r.error {
                w.cont.resume(throwing: e)
            } else {
                w.cont.resume(returning: PolarisResponse(status: r.status, body: r.body, headers: r.headers))
            }
            return
        }
        // No one is waiting: the app was relaunched (or the call was cancelled).
        guard let tag = BackgroundTag.parse(r.tag) else { return }
        if let name = tag.spool { release(spool: name) }
        // A closed channel reads nothing: the person it belonged to is gone.
        guard r.error == nil, !lock.withLock({ closed }) else { return }
        if (200..<300).contains(r.status), tag.kind == .up, tag.part >= 1, let url = r.url {
            feedJournal(tag, url)
        } else if r.status == 401 {
            if let id = journalId(forHash: tag.idHash) { onResume([id]) }
        }
    }

    package func sessionFinishedEvents() {
        let run = lock.withLock { () -> (@Sendable () -> Void)? in
            if let c = completion {
                completion = nil
                return c
            }
            eventsDone = true
            return nil
        }
        if let run { DispatchQueue.main.async(execute: run) }
    }

    /// The system woke the app for this session: `completion` runs on the main queue once the delegate has
    /// delivered every event (at once when it already has).
    func handleEvents(completion done: @escaping @Sendable () -> Void) {
        let now = lock.withLock { () -> Bool in
            if eventsDone {
                eventsDone = false
                return true
            }
            completion = done
            return false
        }
        if now { DispatchQueue.main.async(execute: done) }
        Task { _ = await self.reconcile() }
    }

    private func journalId(forHash hash: String) -> String? {
        journal.list().first { backgroundIdHash($0) == hash }
    }

    private func feedJournal(_ tag: BackgroundTag, _ url: URL) {
        guard !lock.withLock({ tombstones.contains(tag.idHash) || closed }), let id = journalId(forHash: tag.idHash)
        else { return }
        // <product>/sync/files/<collection>/<record>/upload/<uploadId>[/parts/<n>]
        let p = url.path.split(separator: "/").map(String.init)
        // The read, the check and the write are one step under the journal's lock: a delete or a purge
        // either comes before it (nothing to read) or after it.
        journal.update(id) { raw in
            guard !self.lock.withLock({ self.tombstones.contains(tag.idHash) || self.closed }),
                var rec = try? parseJournalRecord(raw), rec.mode != "chunks"
            else { return nil }
            guard p.count >= 7, p[0] == self.product, p[1] == "sync", p[2] == "files", p[3] == rec.collection,
                p[4] == rec.record, p[5] == "upload", p[6] == rec.uploadId
            else { return nil }
            if rec.mode == "single" {
                guard p.count == 7 else { return nil }
            } else {
                guard p.count == 9, p[7] == "parts", Int(p[8]) == tag.part else { return nil }
            }
            rec.done = Array(Set(rec.done).union([tag.part])).sorted()
            return rec
        }
    }

    // MARK: Relaunch

    private func spoolNames() -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: spoolDir.path)) ?? []).filter(BackgroundTag.isSpoolName)
    }

    /// After a launch (or a background wake): cancel the tasks that cannot be trusted, sweep what no task
    /// owns, refresh the token once when a transfer has to be sent again, and hand those transfers back.
    @discardableResult
    public func reconcile() async -> BackgroundReconcileReport {
        var report = BackgroundReconcileReport()
        if lock.withLock({ closed }) { return report }
        let ids = journal.list()
        var known: [String: String] = [:]
        for id in ids { known[backgroundIdHash(id)] = id }
        var kept = Set<String>()
        var again = Set<String>()
        for t in await port.liveTasks() {
            if lock.withLock({ waiters[t.taskIdentifier] != nil }) {
                if let n = BackgroundTag.parse(t.tag)?.spool { kept.insert(n) }
                continue
            }
            guard let tag = BackgroundTag.parse(t.tag) else {
                t.cancel()
                report.cancelledTasks += 1
                continue
            }
            let owner = known[tag.idHash]
            let stale = now() - Double(tag.enqueuedAt) > maxTaskAge
            if owner == nil || stale || lock.withLock({ tombstones.contains(tag.idHash) }) {
                t.cancel()
                report.cancelledTasks += 1
                if stale, let owner { again.insert(owner) }
            } else if let n = tag.spool {
                kept.insert(n)
            }
        }
        for name in spoolNames() where !kept.contains(name) && !lock.withLock({ claimed.contains(name) }) {
            try? FileManager.default.removeItem(at: spoolDir.appendingPathComponent(name))
            report.sweptFiles += 1
        }
        if !again.isEmpty { _ = await tokens.refresh() }
        report.resume = again.sorted()
        if !report.resume.isEmpty { onResume(report.resume) }
        return report
    }
}

// MARK: Process-wide registry

/// Holds the channel of each session identifier, and the system's completion handler when the app delegate
/// is called before the client exists.
public final class CloudSyncBackgroundRegistry: @unchecked Sendable {
    public static let shared = CloudSyncBackgroundRegistry()
    private let lock = NSLock()
    private var channels: [String: CloudSyncBackground] = [:]
    private var waiting: [String: @Sendable () -> Void] = [:]

    func register(_ channel: CloudSyncBackground) {
        let pending = lock.withLock { () -> (@Sendable () -> Void)? in
            channels[channel.identifier] = channel
            return waiting.removeValue(forKey: channel.identifier)
        }
        if let pending { channel.handleEvents(completion: pending) }
    }

    func unregister(_ channel: CloudSyncBackground) {
        lock.withLock {
            if channels[channel.identifier] === channel { channels.removeValue(forKey: channel.identifier) }
        }
    }

    /// Returns false for an identifier that is not a Cloud Sync session (the caller handles it).
    func handle(identifier: String, completion: @escaping @Sendable () -> Void) -> Bool {
        guard identifier.hasPrefix("pkey.sync.") else { return false }
        let channel = lock.withLock { () -> CloudSyncBackground? in
            if let c = channels[identifier] { return c }
            waiting[identifier] = completion
            return nil
        }
        channel?.handleEvents(completion: completion)
        return true
    }
}

extension PolarisKeyClient {
    /// The app delegate's entry point: call from `application(_:handleEventsForBackgroundURLSession:completionHandler:)`.
    /// Creates no client: when the client is built, its Cloud Sync session picks the completion up. Returns
    /// false when `identifier` is not a Polaris Key session. The completion runs on the main queue once the
    /// session has delivered its events.
    @discardableResult
    public static func handleBackgroundEvents(identifier: String, completion: @escaping @Sendable () -> Void) -> Bool {
        CloudSyncBackgroundRegistry.shared.handle(identifier: identifier, completion: completion)
    }
}
