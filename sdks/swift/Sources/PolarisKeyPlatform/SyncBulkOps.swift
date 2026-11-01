// The Cloud Sync bulk-body ops on the binary entry (U-41.5b, GODOT-MOBILE-SYNC D-5, D-7, D-9). A Godot
// game keeps the sync engine, the journal and the codec in GDScript; this file carries only the sealed PUT
// bodies and the GET answers, on the background `URLSession` `pkey.sync.<product>` (BackgroundSession.swift),
// so the system finishes them while the app is suspended.
//
// Every reply is a status byte then the result: 1 ok, 0 refused, 3 bad input. An empty reply is an unknown
// op. The header of `sb_put` and `sb_get` is `u32be length ‖ JSON` (at most 16 KiB).
//
//   sb_open    JSON {product, origin, state_dir, keep:[transfer id…]}           → 1
//   sb_stage   u8 nameLen (0 or 36) ‖ name ‖ piece (≤ 8 MiB)                      → 1 ‖ name (36 ASCII)
//              A zero nameLen starts a new native-named `<32 hex>.bin` file; a name appends. A file holds ≤ 16 MiB.
//   sb_put     header {req, transfer, url, headers{}, bearer, spool, max_body, part?}      → 1
//   sb_get     header {req, transfer, url, headers{}, bearer, max_body, part?}             → 1
//   sb_cancel  JSON {req} | {transfer} | {spool}                                  → 1
//   sb_close   (empty)                                                            → 1
//
// Binary events: `sb_done` = `u32be length ‖ JSON {req, status, headers} ‖ body` (the body is at most
// `max_body`); `sb_fail` = JSON {req, code} with code `network` or `oversize`; `sb_reconciled` = JSON
// {resume:[transfer id…], cancelled, swept}, sent once after `sb_open`.
//
// Bearer (D-9). It is read from the header of the one request, put in that task's headers and nowhere
// else: not in the task tag, the spool, an event, a log or an error. The system's `nsurlsessiond` holds it
// for the task's life, as it does for the Swift channel.
//
// Native re-checks on every request: https and the origin pinned at `sb_open` (loopback http only when the
// process runs with PKEY_APPLE_SELFTEST=1), the anchored `/<product>/sync/files/…` shapes, `version=<digits>`
// the only query, the method for the op, the header allow-list (no Authorization, Cookie or Host in
// `headers`), `max_body` ≤ 16 MiB, and no redirect (the port refuses them). No ledger (D-7): a completion
// for a task nobody holds releases its spool file and nothing more; the server's `received` list is the truth.

import Foundation

#if canImport(Darwin)
    import Darwin
#elseif canImport(Glibc)
    import Glibc
#endif

// MARK: Limits and checks

enum SyncBulkPolicy {
    static let headerMax = 16 * 1024
    static let pieceMax = 8 * 1024 * 1024
    static let stagedMax = 16 * 1024 * 1024
    static let bodyMax = 16 * 1024 * 1024
    static let openMax = 128 * 1024
    static let maxTasks = 300
    static let maxStaged = 512
    static let maxKeep = 1024
    static let maxTaskAge = 1800.0
    static let sessionPrefix = "pkey.sync."

    static let ok: UInt8 = 1
    static let refused: UInt8 = 0
    static let badInput: UInt8 = 3

    static func isKey(_ s: Substring) -> Bool {
        !s.isEmpty && s.utf8.count <= 128 && s != "." && s != ".."
            && s.utf8.allSatisfy {
                ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A)
                    || $0 == 0x2E || $0 == 0x5F || $0 == 0x3A || $0 == 0x2D
            }
    }

    static func isHex64(_ s: Substring) -> Bool {
        s.utf8.count == 64 && s.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
    }

    static func isDigits(_ s: Substring, max: Int) -> Bool {
        !s.isEmpty && s.utf8.count <= max && s.utf8.allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
    }

    /// Whether `path` (and `query`) is a file route this op may carry. `upload` routes are PUT; the file
    /// and its chunk are GET. Anything else, including `begin`, `finalize` and `revisions`, is refused.
    static func routeOk(product: String, path: String, query: String?, put: Bool) -> Bool {
        let segs = path.split(separator: "/", omittingEmptySubsequences: false)
        guard segs.count >= 6, segs[0].isEmpty, segs[1] == Substring(product), segs[2] == "sync",
            segs[3] == "files"
        else { return false }
        let r = Array(segs[4...])
        guard r.allSatisfy({ isKey($0) }) else { return false }
        if put {
            guard query == nil else { return false }
            switch r.count {
            case 4: return r[2] == "upload"
            case 6:
                return r[2] == "upload"
                    && ((r[4] == "parts" && isDigits(r[5], max: 4)) || (r[4] == "chunks" && isHex64(r[5])))
            default: return false
            }
        }
        switch r.count {
        case 2:
            guard let q = query else { return true }
            return q.hasPrefix("version=") && isDigits(Substring(q.dropFirst("version=".count)), max: 9)
        case 3: return query == nil && r[1] == "chunks" && isHex64(r[2])
        default: return false
        }
    }

    static let allowedRequestHeaders: Set<String> = [
        "accept", "content-type", "content-digest", "range", "if-match",
    ]
    static let allowedAnswerHeaders: Set<String> = [
        "content-type", "content-length", "content-range", "content-digest", "etag", "retry-after",
    ]

    static func requestHeaderOk(_ name: String, _ value: String) -> Bool {
        let n = name.lowercased()
        let named =
            allowedRequestHeaders.contains(n)
            || (n.hasPrefix("x-pkey-") && n.utf8.count <= 64
                && n.utf8.allSatisfy { ($0 >= 0x61 && $0 <= 0x7A) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2D })
        return named && value.utf8.count <= 1024 && value.utf8.allSatisfy { $0 >= 0x20 && $0 < 0x7F }
    }

    /// A bearer token: visible ASCII only, so it can carry no line break or space into a header.
    static func bearerOk(_ s: String) -> Bool {
        !s.isEmpty && s.utf8.count <= 4096 && s.utf8.allSatisfy { $0 > 0x20 && $0 < 0x7F }
    }

    static func isLoopback(_ host: String) -> Bool { ["127.0.0.1", "localhost", "::1", "[::1]"].contains(host) }
}

/// The origin pinned at `sb_open`: scheme, host and port, nothing else.
struct SyncBulkOrigin: Equatable {
    var scheme: String
    var host: String
    var port: Int?

    init?(_ text: String, allowLoopbackHttp: Bool) {
        guard let c = URLComponents(string: text), let scheme = c.scheme?.lowercased(),
            let host = c.host?.lowercased(), !host.isEmpty, c.user == nil, c.password == nil,
            c.path.isEmpty || c.path == "/", c.query == nil, c.fragment == nil
        else { return nil }
        guard scheme == "https" || (scheme == "http" && allowLoopbackHttp && SyncBulkPolicy.isLoopback(host))
        else { return nil }
        self.scheme = scheme
        self.host = host
        port = c.port
    }

    func matches(_ url: URL) -> Bool {
        guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false), c.user == nil, c.password == nil,
            c.fragment == nil, c.scheme?.lowercased() == scheme, c.host?.lowercased() == host, c.port == port
        else { return false }
        return true
    }
}

// MARK: The registry

/// The channel of each product, shared by the ops and the app delegate's hook. A background launch can call
/// the hook before any op ran: the session is then created here and waits for `sb_open`.
package final class SyncBulkRegistry: @unchecked Sendable {
    package typealias PortFactory = @Sendable (_ identifier: String, _ defaultLimit: Int) -> any BackgroundSessionPort

    private let lock = NSLock()
    private var channels: [String: SyncBulkChannel] = [:]
    let portFactory: PortFactory?

    package init(portFactory: PortFactory?) { self.portFactory = portFactory }

    #if canImport(Darwin)
        package static let shared = SyncBulkRegistry(portFactory: {
            URLSessionBackgroundPort(identifier: $0, defaultLimit: $1)
        })
    #else
        package static let shared = SyncBulkRegistry(portFactory: nil)
    #endif

    func channel(product: String) -> SyncBulkChannel? {
        guard SyncBulkPolicy.isKey(Substring(product)), let portFactory else { return nil }
        return lock.withLock { () -> SyncBulkChannel in
            if let c = channels[product] { return c }
            let c = SyncBulkChannel(product: product, port: portFactory(Self.identifier(product), 64 * 1024 + 1))
            channels[product] = c
            return c
        }
    }

    static func identifier(_ product: String) -> String { SyncBulkPolicy.sessionPrefix + product }

    func all() -> [SyncBulkChannel] { lock.withLock { Array(channels.values) } }

    /// The app delegate's entry: false for an identifier that is not a Cloud Sync session. The session is
    /// recreated natively, and `completion` runs on the main queue once it has delivered its events.
    package func handleBackgroundEvents(identifier: String, completion: @escaping @Sendable () -> Void) -> Bool {
        guard identifier.hasPrefix(SyncBulkPolicy.sessionPrefix) else { return false }
        let product = String(identifier.dropFirst(SyncBulkPolicy.sessionPrefix.count))
        guard let channel = channel(product: product) else { return false }
        channel.handleEvents(completion: completion)
        return true
    }
}

// MARK: One product's channel

final class SyncBulkChannel: BackgroundSink, @unchecked Sendable {
    private struct Pending {
        var req: Int
        var ref: any BackgroundTaskRef
        var taskId: Int
        var idHash: String
        var spool: String?
        var maxBody: Int
    }

    let product: String
    private let port: any BackgroundSessionPort
    private let lock = NSLock()
    private var sink: PlatformEventSink?
    private var origin: SyncBulkOrigin?
    private var spoolDir: URL?
    private var closed = true
    private var byReq: [Int: Pending] = [:]
    private var byTask: [Int: Int] = [:]
    private var staged: [String: Int] = [:]
    private var tombstones: Set<String> = []
    private var eventsDone = false
    private var completion: (@Sendable () -> Void)?

    init(product: String, port: any BackgroundSessionPort) {
        self.product = product
        self.port = port
        port.start(sink: self)
    }

    var isOpen: Bool { lock.withLock { !closed } }

    // MARK: open and close

    func open(
        origin: SyncBulkOrigin, stateDir: URL, keep: [String], sink: PlatformEventSink
    ) -> Bool {
        let dir = stateDir.appendingPathComponent("cloud-sync-spool", isDirectory: true)
        do {
            try FileManager.default.createDirectory(
                at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        } catch { return false }
        var excluded = dir
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? excluded.setResourceValues(values)
        #if os(iOS) || os(tvOS) || os(watchOS) || os(visionOS)
            try? FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: dir.path)
        #endif
        lock.withLock {
            self.origin = origin
            self.spoolDir = dir
            self.sink = sink
            closed = false
            tombstones.removeAll()
        }
        Task { [self] in
            let report = await reconcile(keep: keep)
            emit("sb_reconciled", report)
        }
        return true
    }

    /// Sign-out, forget and lock: every task is cancelled and unheard, the spool is deleted, and nothing is
    /// accepted until `open`.
    func close() {
        let (refs, dir) = lock.withLock { () -> ([any BackgroundTaskRef], URL?) in
            closed = true
            let refs = byReq.values.map(\.ref)
            byReq.removeAll()
            byTask.removeAll()
            staged.removeAll()
            return (refs, spoolDir)
        }
        for r in refs { r.cancel() }
        if let dir { try? FileManager.default.removeItem(at: dir) }
        Task { [port] in for t in await port.liveTasks() { t.cancel() } }
    }

    // MARK: stage

    func stage(name: String?, piece: UnsafeBufferPointer<UInt8>) -> [UInt8] {
        let target: (URL, String)? = lock.withLock {
            guard !closed, let dir = spoolDir else { return nil }
            if let name {
                guard let size = staged[name], size + piece.count <= SyncBulkPolicy.stagedMax else { return nil }
                staged[name] = size + piece.count
                return (dir.appendingPathComponent(name), name)
            }
            guard staged.count < SyncBulkPolicy.maxStaged, piece.count <= SyncBulkPolicy.stagedMax else { return nil }
            let n = (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined() + ".bin"
            staged[n] = piece.count
            return (dir.appendingPathComponent(n), n)
        }
        guard let (url, n) = target else { return [SyncBulkPolicy.refused] }
        if !append(piece, to: url, create: name == nil) {
            lock.withLock { _ = staged.removeValue(forKey: n) }
            try? FileManager.default.removeItem(at: url)
            return [SyncBulkPolicy.refused]
        }
        return [SyncBulkPolicy.ok] + Array(n.utf8)
    }

    private static func sysOpen(_ path: String, _ flags: Int32) -> Int32 {
        #if canImport(Darwin)
            return Darwin.open(path, flags, 0o600)
        #else
            return Glibc.open(path, flags, 0o600)
        #endif
    }

    private static func sysClose(_ fd: Int32) -> Int32 {
        #if canImport(Darwin)
            return Darwin.close(fd)
        #else
            return Glibc.close(fd)
        #endif
    }

    private func append(_ piece: UnsafeBufferPointer<UInt8>, to url: URL, create: Bool) -> Bool {
        let flags = O_WRONLY | O_NOFOLLOW | (create ? (O_CREAT | O_EXCL) : O_APPEND)
        let fd = Self.sysOpen(url.path, flags)
        guard fd >= 0 else { return false }
        defer { _ = Self.sysClose(fd) }
        var offset = 0
        while offset < piece.count {
            let n = write(fd, piece.baseAddress! + offset, piece.count - offset)
            if n < 0 {
                if errno == EINTR { continue }
                return false
            }
            offset += n
        }
        #if os(iOS) || os(tvOS) || os(watchOS) || os(visionOS)
            if create {
                try? FileManager.default.setAttributes(
                    [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                    ofItemAtPath: url.path)
            }
        #endif
        return true
    }

    // MARK: put and get

    func request(_ h: [String: Any], put: Bool) -> UInt8 {
        guard let req = h["req"] as? Int, req > 0, req <= Int(Int32.max),
            let transfer = h["transfer"] as? String, !transfer.isEmpty, transfer.utf8.count <= 256,
            let urlText = h["url"] as? String, urlText.utf8.count <= 2048, let url = URL(string: urlText),
            let bearer = h["bearer"] as? String, SyncBulkPolicy.bearerOk(bearer),
            let maxBody = h["max_body"] as? Int, maxBody > 0, maxBody <= SyncBulkPolicy.bodyMax
        else { return SyncBulkPolicy.badInput }
        let part = (h["part"] as? Int) ?? 0
        guard part >= 0, part <= 100_000 else { return SyncBulkPolicy.badInput }
        var fields: [String: String] = [:]
        if let raw = h["headers"] {
            guard let d = raw as? [String: Any], d.count <= 16 else { return SyncBulkPolicy.badInput }
            for (k, v) in d {
                guard let s = v as? String, SyncBulkPolicy.requestHeaderOk(k, s) else {
                    return SyncBulkPolicy.badInput
                }
                fields[k.lowercased()] = s
            }
        }
        let (pinned, dir, isClosed) = lock.withLock { (origin, spoolDir, closed) }
        guard !isClosed, let pinned, let dir, pinned.matches(url),
            SyncBulkPolicy.routeOk(
                product: product, path: url.path, query: url.query, put: put), url.fragment == nil
        else { return SyncBulkPolicy.refused }
        var spool: String?
        if put {
            guard let name = h["spool"] as? String, BackgroundTag.isSpoolName(name) else {
                return SyncBulkPolicy.badInput
            }
            spool = name
        } else if h["spool"] != nil {
            return SyncBulkPolicy.badInput
        }
        var r = URLRequest(url: url)
        r.httpMethod = put ? "PUT" : "GET"
        for (k, v) in fields { r.setValue(v, forHTTPHeaderField: k) }
        r.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        r.timeoutInterval = 120
        r.httpShouldHandleCookies = false
        r.cachePolicy = .reloadIgnoringLocalCacheData
        let idHash = backgroundIdHash(transfer)
        let tag = BackgroundTag(
            idHash: idHash, kind: put ? .up : .dn, part: part, enqueuedAt: Int(Date().timeIntervalSince1970),
            spool: spool)
        // One more byte than the bound, so an oversize answer is told from one that just fits.
        let task: any BackgroundTaskRef
        if let spool {
            let claimed = lock.withLock { staged[spool] != nil }
            guard claimed else { return SyncBulkPolicy.refused }
            task = port.makeUpload(r, from: dir.appendingPathComponent(spool), tag: tag.text, maxBody: maxBody + 1)
        } else {
            task = port.makeDownload(r, tag: tag.text, maxBody: maxBody + 1)
        }
        let accepted = lock.withLock { () -> Bool in
            guard !closed, byReq[req] == nil, byReq.count < SyncBulkPolicy.maxTasks else { return false }
            tombstones.remove(idHash)
            byReq[req] = Pending(
                req: req, ref: task, taskId: task.taskIdentifier, idHash: idHash, spool: spool, maxBody: maxBody)
            byTask[task.taskIdentifier] = req
            if let spool { _ = staged.removeValue(forKey: spool) }
            return true
        }
        guard accepted else {
            task.cancel()
            return SyncBulkPolicy.refused
        }
        task.resume()
        return SyncBulkPolicy.ok
    }

    // MARK: cancel

    /// A cancel is final: the task's completion, when it comes, is not told to anyone.
    func cancel(req: Int?, transfer: String?, spool: String?) {
        var doomed: [Pending] = []
        var drop: [String] = []
        lock.withLock {
            if let req, let p = byReq.removeValue(forKey: req) {
                byTask.removeValue(forKey: p.taskId)
                doomed.append(p)
            }
            if let transfer {
                let hash = backgroundIdHash(transfer)
                tombstones.insert(hash)
                for (k, p) in byReq where p.idHash == hash {
                    byReq.removeValue(forKey: k)
                    byTask.removeValue(forKey: p.taskId)
                    doomed.append(p)
                }
            }
            if let spool, staged.removeValue(forKey: spool) != nil { drop.append(spool) }
        }
        for p in doomed {
            p.ref.cancel()
            if let n = p.spool { remove(spool: n) }
        }
        for n in drop { remove(spool: n) }
        if let transfer {
            let hash = backgroundIdHash(transfer)
            Task { [port, self] in
                for t in await port.liveTasks() {
                    guard let tag = BackgroundTag.parse(t.tag), tag.idHash == hash else { continue }
                    t.cancel()
                    if let n = tag.spool { remove(spool: n) }
                }
            }
        }
    }

    private func remove(spool name: String) {
        guard BackgroundTag.isSpoolName(name) else { return }
        lock.withLock { _ = staged.removeValue(forKey: name) }
        if let dir = lock.withLock({ spoolDir }) { try? FileManager.default.removeItem(at: dir.appendingPathComponent(name)) }
    }

    // MARK: events

    private func emit(_ kind: String, _ payload: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
            let sink = lock.withLock({ sink })
        else { return }
        sink.emitBinary(kind, [UInt8](d))
    }

    package func taskFinished(_ r: BackgroundResult) {
        let pending = lock.withLock { () -> Pending? in
            guard let req = byTask.removeValue(forKey: r.taskIdentifier) else { return nil }
            return byReq.removeValue(forKey: req)
        }
        guard let p = pending else {
            // Nobody holds this task (relaunch, or cancelled): release its spool file and say nothing (D-7).
            if let n = BackgroundTag.parse(r.tag)?.spool { remove(spool: n) }
            return
        }
        if let n = p.spool { remove(spool: n) }
        let reqId = p.req
        if r.error != nil {
            if (r.error as NSError?)?.code != NSURLErrorCancelled { emit("sb_fail", ["req": reqId, "code": "network"]) }
            return
        }
        guard r.body.count <= p.maxBody else {
            emit("sb_fail", ["req": reqId, "code": "oversize"])
            return
        }
        var headers: [String: String] = [:]
        for (k, v) in r.headers where SyncBulkPolicy.allowedAnswerHeaders.contains(k.lowercased()) {
            headers[k.lowercased()] = String(v.prefix(1024))
        }
        guard
            let head = try? JSONSerialization.data(
                withJSONObject: ["req": reqId, "status": r.status, "headers": headers] as [String: Any],
                options: [.sortedKeys]),
            let sink = lock.withLock({ sink })
        else { return }
        var frame = [UInt8](repeating: 0, count: 4)
        let n = head.count
        frame[0] = UInt8((n >> 24) & 0xFF)
        frame[1] = UInt8((n >> 16) & 0xFF)
        frame[2] = UInt8((n >> 8) & 0xFF)
        frame[3] = UInt8(n & 0xFF)
        frame.append(contentsOf: head)
        frame.append(contentsOf: r.body)
        sink.emitBinary("sb_done", frame)
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
    }

    // MARK: reconcile

    /// After `sb_open`: cancel the session's tasks that cannot be trusted (not tagged by us, owned by no kept
    /// transfer, older than `maxTaskAge`, or tombstoned), sweep spool files no task owns, and name the
    /// transfers whose stale tasks were cancelled so GDScript sends them again.
    func reconcile(keep: [String]) async -> [String: Any] {
        var known: [String: String] = [:]
        for id in keep { known[backgroundIdHash(id)] = id }
        var kept = Set<String>()
        var again = Set<String>()
        var cancelled = 0
        var swept = 0
        let now = Date().timeIntervalSince1970
        for t in await port.liveTasks() {
            if lock.withLock({ byTask[t.taskIdentifier] != nil }) {
                if let n = BackgroundTag.parse(t.tag)?.spool { kept.insert(n) }
                continue
            }
            guard let tag = BackgroundTag.parse(t.tag) else {
                t.cancel()
                cancelled += 1
                continue
            }
            let owner = known[tag.idHash]
            let stale = now - Double(tag.enqueuedAt) > SyncBulkPolicy.maxTaskAge
            if owner == nil || stale || lock.withLock({ tombstones.contains(tag.idHash) }) {
                t.cancel()
                cancelled += 1
                if stale, let owner { again.insert(owner) }
            } else if let n = tag.spool {
                kept.insert(n)
            }
        }
        if let dir = lock.withLock({ spoolDir }) {
            let names = ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [])
                .filter(BackgroundTag.isSpoolName)
            for name in names where !kept.contains(name) && !lock.withLock({ staged[name] != nil }) {
                try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))
                swept += 1
            }
        }
        return ["resume": again.sorted(), "cancelled": cancelled, "swept": swept]
    }
}

// MARK: The ops

struct SyncBulkOps: Sendable {
    let sink: PlatformEventSink
    let registry: SyncBulkRegistry
    let allowLoopbackHttp: Bool

    func register(into ops: inout [String: PlatformBinaryOp]) {
        ops["sb_open"] = { open($0) }
        ops["sb_stage"] = { stage($0) }
        ops["sb_put"] = { header($0, put: true) }
        ops["sb_get"] = { header($0, put: false) }
        ops["sb_cancel"] = { cancel($0) }
        ops["sb_close"] = { _ in
            for c in registry.all() { c.close() }
            return [SyncBulkPolicy.ok]
        }
    }

    private static func object(_ input: UnsafeBufferPointer<UInt8>, max: Int) -> [String: Any]? {
        guard input.count > 0, input.count <= max else { return nil }
        return (try? JSONSerialization.jsonObject(with: Data(input))) as? [String: Any]
    }

    private func open(_ input: UnsafeBufferPointer<UInt8>) -> [UInt8] {
        guard let o = Self.object(input, max: SyncBulkPolicy.openMax), let product = o["product"] as? String,
            let originText = o["origin"] as? String,
            let origin = SyncBulkOrigin(originText, allowLoopbackHttp: allowLoopbackHttp),
            let dir = o["state_dir"] as? String, dir.hasPrefix("/"), !dir.contains("\0"),
            !dir.split(separator: "/").contains(".."),
            let keep = o["keep"] as? [String], keep.count <= SyncBulkPolicy.maxKeep,
            keep.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 256 })
        else { return [SyncBulkPolicy.badInput] }
        guard let channel = registry.channel(product: product),
            channel.open(origin: origin, stateDir: URL(fileURLWithPath: dir, isDirectory: true), keep: keep, sink: sink)
        else { return [SyncBulkPolicy.refused] }
        return [SyncBulkPolicy.ok]
    }

    private func stage(_ input: UnsafeBufferPointer<UInt8>) -> [UInt8] {
        guard input.count >= 1 else { return [SyncBulkPolicy.badInput] }
        let nameLen = Int(input[0])
        guard nameLen == 0 || nameLen == 36, input.count >= 1 + nameLen,
            input.count - 1 - nameLen <= SyncBulkPolicy.pieceMax
        else { return [SyncBulkPolicy.badInput] }
        var name: String?
        if nameLen == 36 {
            name = String(decoding: UnsafeBufferPointer(rebasing: input[1..<37]), as: UTF8.self)
            guard let n = name, BackgroundTag.isSpoolName(n) else { return [SyncBulkPolicy.badInput] }
        }
        let piece = UnsafeBufferPointer(rebasing: input[(1 + nameLen)...])
        // The staging file belongs to the one open channel (a process syncs one product).
        guard let c = registry.all().first(where: { $0.isOpen }) else { return [SyncBulkPolicy.refused] }
        return c.stage(name: name, piece: piece)
    }

    private func header(_ input: UnsafeBufferPointer<UInt8>, put: Bool) -> [UInt8] {
        guard input.count >= 4 else { return [SyncBulkPolicy.badInput] }
        let n = (Int(input[0]) << 24) | (Int(input[1]) << 16) | (Int(input[2]) << 8) | Int(input[3])
        guard n > 0, n <= SyncBulkPolicy.headerMax, input.count == 4 + n,
            let h = (try? JSONSerialization.jsonObject(with: Data(input[4...]))) as? [String: Any]
        else { return [SyncBulkPolicy.badInput] }
        guard let c = registry.all().first(where: { $0.isOpen }) else { return [SyncBulkPolicy.refused] }
        return [c.request(h, put: put)]
    }

    private func cancel(_ input: UnsafeBufferPointer<UInt8>) -> [UInt8] {
        guard let o = Self.object(input, max: 4096) else { return [SyncBulkPolicy.badInput] }
        let req = o["req"] as? Int
        let transfer = o["transfer"] as? String
        let spool = o["spool"] as? String
        guard req != nil || transfer != nil || spool != nil else { return [SyncBulkPolicy.badInput] }
        for c in registry.all() { c.cancel(req: req, transfer: transfer, spool: spool) }
        return [SyncBulkPolicy.ok]
    }
}

