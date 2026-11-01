// The background `URLSession` adapter and the task tag (U-41.5a, D-8), shared by Cloud Sync's
// `CloudSyncBackground` (PolarisKey) and the Godot iOS binary, which links this target and not the umbrella.
// Moved out of PolarisKey/CloudSyncBackground.swift unchanged except that the answer cap is a parameter of
// the adapter. `package` access: callable by the packages' own targets, not public API.
//
// The task tag (`taskDescription`) is `pkbg1|<sha256(transfer id)>|up|dn|<part>|<enqueued at>|<spool>`.
// A spool file is named by 32 random hex characters and `.bin`, never by an id. The token and the body are
// never logged or put in an error.

import Foundation

#if canImport(CryptoKit)
    import CryptoKit
#else
    import Crypto
#endif

#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

package struct BackgroundTag: Equatable {
    package enum Kind: String { case up, dn }
    package var idHash: String
    package var kind: Kind
    package var part: Int
    package var enqueuedAt: Int
    package var spool: String?

    package init(idHash: String, kind: Kind, part: Int, enqueuedAt: Int, spool: String?) {
        self.idHash = idHash
        self.kind = kind
        self.part = part
        self.enqueuedAt = enqueuedAt
        self.spool = spool
    }

    package var text: String { "pkbg1|\(idHash)|\(kind.rawValue)|\(part)|\(enqueuedAt)|\(spool ?? "-")" }

    package static func parse(_ s: String?) -> BackgroundTag? {
        guard let s else { return nil }
        let f = s.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
        guard f.count == 6, f[0] == "pkbg1", Self.isHex64(f[1]), let kind = Kind(rawValue: f[2]),
            let part = Int(f[3]), part >= 0, part <= 100_000, let at = Int(f[4]), at >= 0
        else { return nil }
        var spool: String?
        if f[5] != "-" {
            guard Self.isSpoolName(f[5]) else { return nil }
            spool = f[5]
        }
        return BackgroundTag(idHash: f[1], kind: kind, part: part, enqueuedAt: at, spool: spool)
    }

    private static func isHex64(_ s: String) -> Bool {
        s.utf8.count == 64 && s.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
    }

    package static func isSpoolName(_ s: String) -> Bool {
        s.utf8.count == 36 && s.hasSuffix(".bin")
            && s.dropLast(4).utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
    }
}

package func backgroundIdHash(_ id: String) -> String {
    SHA256.hash(data: Data(id.utf8)).map { String(format: "%02x", $0) }.joined()
}

/// One task of the background session, as the channel needs it.
package protocol BackgroundTaskRef: AnyObject, Sendable {
    var taskIdentifier: Int { get }
    var tag: String? { get }
    var url: URL? { get }
    func resume()
    func cancel()
}

/// How a task ended.
package struct BackgroundResult: Sendable {
    package var taskIdentifier: Int
    package var tag: String?
    package var url: URL?
    package var status: Int
    package var headers: [String: String]
    package var body: Data
    package var error: (any Error)?

    package init(
        taskIdentifier: Int, tag: String?, url: URL?, status: Int, headers: [String: String], body: Data,
        error: (any Error)?
    ) {
        self.taskIdentifier = taskIdentifier
        self.tag = tag
        self.url = url
        self.status = status
        self.headers = headers
        self.body = body
        self.error = error
    }
}

package protocol BackgroundSink: AnyObject, Sendable {
    func taskFinished(_ result: BackgroundResult)
    func sessionFinishedEvents()
}

/// The background `URLSession`, behind a port so a test stubs it. `makeUpload` and `makeDownload` return a
/// task that has not started.
package protocol BackgroundSessionPort: Sendable {
    func start(sink: any BackgroundSink)
    func makeUpload(_ request: URLRequest, from file: URL, tag: String, maxBody: Int) -> any BackgroundTaskRef
    func makeDownload(_ request: URLRequest, tag: String, maxBody: Int) -> any BackgroundTaskRef
    func liveTasks() async -> [any BackgroundTaskRef]
}

// MARK: The URLSession adapter

#if canImport(Darwin)
    package final class URLSessionBackgroundPort: NSObject, BackgroundSessionPort, URLSessionDownloadDelegate,
        URLSessionDataDelegate, @unchecked Sendable
    {
        private struct Held {
            var data = Data()
            var file: Data?
            var limit: Int
        }

        private let identifier: String
        private let lock = NSLock()
        private var session: URLSession?
        private weak var sink: (any BackgroundSink)?
        private var held: [Int: Held] = [:]
        private var limits: [Int: Int] = [:]

        private let defaultLimit: Int

        /// `defaultLimit` is the most of an answer kept for a task made without its own bound.
        package init(identifier: String, defaultLimit: Int) {
            self.identifier = identifier
            self.defaultLimit = defaultLimit
        }

        package func start(sink: any BackgroundSink) {
            self.sink = sink
            let c = URLSessionConfiguration.background(withIdentifier: identifier)
            c.sessionSendsLaunchEvents = true
            c.isDiscretionary = false
            c.waitsForConnectivity = true
            c.httpCookieStorage = nil
            c.urlCache = nil
            c.httpShouldSetCookies = false
            c.requestCachePolicy = .reloadIgnoringLocalCacheData
            c.timeoutIntervalForResource = 7 * 86400
            session = URLSession(configuration: c, delegate: self, delegateQueue: nil)
        }

        private final class Ref: BackgroundTaskRef, @unchecked Sendable {
            let task: URLSessionTask
            init(_ t: URLSessionTask) { task = t }
            var taskIdentifier: Int { task.taskIdentifier }
            var tag: String? { task.taskDescription }
            var url: URL? { task.originalRequest?.url }
            func resume() { task.resume() }
            func cancel() { task.cancel() }
        }

        package func makeUpload(_ request: URLRequest, from file: URL, tag: String, maxBody: Int)
            -> any BackgroundTaskRef
        {
            let t = session!.uploadTask(with: request, fromFile: file)
            t.taskDescription = tag
            lock.withLock { limits[t.taskIdentifier] = maxBody }
            return Ref(t)
        }

        package func makeDownload(_ request: URLRequest, tag: String, maxBody: Int) -> any BackgroundTaskRef {
            let t = session!.downloadTask(with: request)
            t.taskDescription = tag
            lock.withLock { limits[t.taskIdentifier] = maxBody }
            return Ref(t)
        }

        package func liveTasks() async -> [any BackgroundTaskRef] {
            guard let session else { return [] }
            let (a, b, c) = await session.tasks
            return (a as [URLSessionTask] + b as [URLSessionTask] + c as [URLSessionTask]).map { Ref($0) }
        }

        private func limit(_ id: Int) -> Int {
            lock.withLock { limits[id] } ?? defaultLimit
        }

        // H-3: no redirect is followed; a 3xx is the answer.
        package func urlSession(
            _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
            newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
        ) { completionHandler(nil) }

        package func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            let id = dataTask.taskIdentifier
            let cap = limit(id)
            lock.withLock {
                var h = held[id] ?? Held(limit: cap)
                if h.data.count < cap { h.data.append(data.prefix(cap - h.data.count)) }
                held[id] = h
            }
        }

        package func urlSession(
            _ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL
        ) {
            // Read what the answer says (bounded) and remove the system's file before it returns.
            let id = downloadTask.taskIdentifier
            let cap = limit(id)
            var body = Data()
            if let fh = try? FileHandle(forReadingFrom: location) {
                body = (try? fh.read(upToCount: cap)) ?? Data()
                try? fh.close()
            }
            try? FileManager.default.removeItem(at: location)
            lock.withLock { held[id] = Held(data: body, limit: cap) }
        }

        package func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
            let id = task.taskIdentifier
            let h = lock.withLock { () -> Held? in
                limits.removeValue(forKey: id)
                return held.removeValue(forKey: id)
            }
            var headers: [String: String] = [:]
            var status = 0
            if let r = task.response as? HTTPURLResponse {
                status = r.statusCode
                for (k, v) in r.allHeaderFields { if let k = k as? String, let v = v as? String { headers[k] = v } }
            }
            sink?.taskFinished(
                BackgroundResult(
                    taskIdentifier: id, tag: task.taskDescription, url: task.originalRequest?.url, status: status,
                    headers: headers, body: h?.data ?? Data(), error: error))
        }

        package func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
            sink?.sessionFinishedEvents()
        }
    }
#endif
