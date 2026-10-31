// The Cloud Sync file transport (U-23.S5; WIRE-CONTRACT-V5 §13.2, §13.8): the routes under
// `/<p>/sync/files/{collection}/{id}` as the engine's `FileTransport`. A port of Node's `cloudSync/files.ts`.
//
//  - An allow-list. A request is built only for one of the closed list of paths below (segments in the key
//    charset, no dot segments, the chunk id 64 lowercase hex, the only query `version=<digits>` on the file
//    `GET`); anything else is a rejection before any socket is opened. A server-chosen string never makes
//    a path: the upload id is checked as a key too.
//  - No redirect is followed. A 3xx is a refusal (`redirect_refused`): the bearer is never handed to
//    another URL.
//  - Bounds. A JSON answer is read to 1 MiB, an error body to 64 KiB, an unranged file `GET` (a `chunks`
//    file's manifest) to 2 MiB, a ranged one to the range asked (a server that ignores `Range` and sends
//    more is refused, never buffered), a chunk to `SYNC_CHUNK_MAX_STORED_BYTES`. A request's deadline is
//    the base timeout plus its size at 64 KiB/s.
//  - A refusal is a value (`FileReply.refused`); a call that gets no answer throws and the engine retries.
//    `Retry-After` is read as seconds or an HTTP date and capped at 3,600 before any integer conversion.
//    The write routes answer 503 `unavailable` with it while the limiter is down; 403 `quota_exceeded`
//    (scope `user`) at finalize is a refusal like any other.
//
// The device bearer is read per request and never logged or put in an error. A transport with no bearer
// answers `401 unauthorized` and sends nothing.

import Foundation
import PolarisKeyCore

/// The kept revisions of one file (`GET …/{id}/revisions`), which the engine does not need.
public protocol FileRevisions: Sendable {
    func revisions(_ target: FileTarget) async throws -> FileReply<JSONValue>
}

/// The bounds of the file routes.
public enum CloudSyncFileBounds {
    /// The most a JSON answer may be.
    public static let jsonMaxBytes = 1_048_576
    /// The most an error body is read to.
    public static let errorMaxBytes = 65_536
    /// The most an unranged file `GET` returns: a `chunks` file's manifest (786,496 bytes plain, sealed).
    public static let manifestMaxBytes = 2 * 1_048_576
    /// A body slower than this is cut off: the deadline grows by its size over this rate.
    public static let minBytesPerSecond = 65_536
    /// The longest `Retry-After` honoured, in seconds.
    public static let maxRetryAfterSeconds = 3600.0
}

public struct CloudSyncFileTransport: FileTransport, FileRevisions {
    private let product: String
    private let baseUrl: String
    private let transport: any PolarisTransport
    private let headers: @Sendable () async -> [String: String]
    private let token: @Sendable () async -> String?
    private let timeoutSeconds: Double

    public init(
        product: String, baseUrl: String, transport: any PolarisTransport,
        headers: @escaping @Sendable () async -> [String: String],
        token: @escaping @Sendable () async -> String?, timeoutSeconds: Double = 15
    ) {
        self.product = product
        self.baseUrl = baseUrl
        self.transport = transport
        self.headers = headers
        self.token = token
        self.timeoutSeconds = timeoutSeconds
    }

    /// The client's own transport, headers and device token.
    public init(core: CoreContext) {
        self.init(
            product: core.product, baseUrl: core.endpoints.baseUrl, transport: core.transport,
            headers: { await core.headers() }, token: { await core.token })
    }

    // MARK: Paths

    private static func isKey(_ s: Substring) -> Bool {
        !s.isEmpty && s.utf8.count <= 128 && s != "." && s != ".."
            && s.utf8.allSatisfy {
                ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A)
                    || $0 == 0x2E || $0 == 0x5F || $0 == 0x3A || $0 == 0x2D
            }
    }

    private static func isHex64(_ s: Substring) -> Bool {
        s.utf8.count == 64 && s.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
    }

    private static func isDigits(_ s: Substring, max: Int) -> Bool {
        !s.isEmpty && s.utf8.count <= max && s.utf8.allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
    }

    /// Whether `pathAndQuery` is one of the file routes of §13.2 for `product`.
    public static func isFilesPath(product: String, _ pathAndQuery: String) -> Bool {
        guard isKey(Substring(product)) else { return false }
        let halves = pathAndQuery.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        guard let path = halves.first else { return false }
        let query: Substring? = halves.count > 1 ? halves[1] : nil
        let segs = path.split(separator: "/", omittingEmptySubsequences: false)
        guard segs.count >= 6, segs[0].isEmpty, segs[1] == Substring(product), segs[2] == "sync", segs[3] == "files"
        else { return false }
        let r = Array(segs[4...])
        guard r.allSatisfy({ isKey($0) }) else { return false }
        let ok: Bool
        switch r.count {
        case 2: ok = true  // the file: GET …/{id}
        case 3:
            ok = (r[1] == "chunks" && isHex64(r[2])) || ["begin", "finalize", "revisions"].contains(String(r[2]))
        case 4: ok = r[2] == "upload"
        case 5: ok = r[2] == "upload" && r[4] == "chunks"
        case 6:
            ok =
                r[2] == "upload" && ((r[4] == "parts" && isDigits(r[5], max: 4)) || (r[4] == "chunks" && isHex64(r[5])))
        default: ok = false
        }
        guard ok else { return false }
        guard let query else { return true }
        // Only the file GET takes a query, and only a version.
        guard r.count == 2, query.hasPrefix("version=") else { return false }
        return isDigits(query.dropFirst("version=".count), max: 9)
    }

    private func seg(_ value: String, _ what: String) throws -> String {
        guard Self.isKey(Substring(value)) else { throw bad(what) }
        return value
    }

    private func base(_ collection: String) throws -> String {
        "/\(product)/sync/files/\(try seg(collection, "collection"))"
    }

    private func record(_ t: FileTarget) throws -> String {
        "\(try base(t.collection))/\(try seg(t.record, "record"))"
    }

    private func upload(_ t: FileTarget, _ uploadId: String) throws -> String {
        "\(try record(t))/upload/\(try seg(uploadId, "uploadId"))"
    }

    private func chunkId(_ id: String) throws -> String {
        guard Self.isHex64(Substring(id)) else { throw bad("chunkId") }
        return id
    }

    private func bad(_ detail: String) -> TransferError { TransferError(.rejected, code: "bad_path", detail: detail) }

    // MARK: The exchange

    private struct Sent {
        var json: JSONValue?
        var body: Data?
        var sha256: String?
        var range: Range<Int>?
        var ifMatch: String?
    }

    private enum Exchanged {
        case response(PolarisResponse)
        case refusal(FileRefusal)
    }

    /// One request. A refusal comes back as a value; a request that gets no answer throws.
    private func exchange(
        _ method: String, _ path: String, _ sent: Sent = Sent(), expectBytes: Int = 0, cap: Int
    ) async throws -> Exchanged {
        // The builders already checked; this is the closed list.
        guard Self.isFilesPath(product: product, path) else { throw bad("route") }
        guard let token = await token(), !token.isEmpty else {
            return .refusal(FileRefusal(status: 401, code: ErrorCode.unauthorized))
        }
        guard let url = URL(string: baseUrl + path) else { throw bad("route") }
        var h = await headers()
        h["authorization"] = "Bearer \(token)"
        h["accept"] = "application/octet-stream, application/json"
        var body: Data?
        if let json = sent.json {
            h["content-type"] = "application/json"
            guard let data = try? JSONEncoder().encode(json) else { throw bad("body") }
            body = data
        } else if let bytes = sent.body {
            h["content-type"] = "application/octet-stream"
            guard let sha = sent.sha256, let digest = Self.digestHeader(hex: sha) else { throw bad("digest") }
            h["content-digest"] = digest
            body = bytes
        }
        if let r = sent.range { h["range"] = "bytes=\(r.lowerBound)-\(r.upperBound - 1)" }
        if let tag = sent.ifMatch { h["if-match"] = tag }
        let sized = max(expectBytes, body?.count ?? 0)
        let deadline =
            timeoutSeconds > 0
            ? timeoutSeconds
                + Double((sized + CloudSyncFileBounds.minBytesPerSecond - 1) / CloudSyncFileBounds.minBytesPerSecond)
            : 0
        let res: PolarisResponse
        do {
            res = try await transport.send(
                PolarisRequest(
                    url: url, method: method, headers: h, body: body, timeoutSeconds: deadline,
                    maxBodyBytes: cap + 1, followRedirects: false))
        } catch let e as PolarisError where e.code == ErrorCode.localOnly {
            // Local-only is a refusal to dial, not a network failure: nothing is retried.
            throw TransferError(.rejected, code: e.code)
        }
        if (300..<400).contains(res.status) {
            return .refusal(FileRefusal(status: res.status, code: "redirect_refused"))
        }
        return .response(res)
    }

    /// RFC 9530: `sha-256=:<base64>:` from the lowercase hex digest.
    static func digestHeader(hex: String) -> String? {
        guard hex.utf8.count == 64, hex.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) })
        else { return nil }
        var bytes = Data()
        var i = hex.startIndex
        while i < hex.endIndex {
            let j = hex.index(i, offsetBy: 2)
            guard let b = UInt8(hex[i..<j], radix: 16) else { return nil }
            bytes.append(b)
            i = j
        }
        return "sha-256=:\(bytes.base64EncodedString()):"
    }

    /// `Retry-After` as seconds: delay-seconds or an HTTP date, never negative and never above the cap. The
    /// clamp comes first, so no later conversion sees a value out of range. NaN reads as absent.
    static func retryAfter(_ header: String?, now: Date = Date()) -> Double? {
        let text = (header ?? "").trimmingCharacters(in: .whitespaces)
        if text.isEmpty { return nil }
        var seconds: Double
        if text.range(of: #"^[0-9]+(\.[0-9]+)?$"#, options: .regularExpression) != nil {
            guard let d = Double(text) else { return nil }
            seconds = d
        } else {
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.timeZone = TimeZone(identifier: "GMT")
            f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
            guard let at = f.date(from: text) else { return nil }
            seconds = at.timeIntervalSince(now)
        }
        guard !seconds.isNaN else { return nil }
        return min(max(seconds, 0), CloudSyncFileBounds.maxRetryAfterSeconds)
    }

    private static func fallbackCode(_ status: Int) -> String {
        if status == 429 { return ErrorCode.rateLimited }
        if status >= 500 { return ErrorCode.serverError }
        switch status {
        case 400: return ErrorCode.badRequest
        case 401: return ErrorCode.unauthorized
        case 403: return ErrorCode.forbidden
        case 404: return ErrorCode.notFound
        case 405: return ErrorCode.methodNotAllowed
        case 413: return ErrorCode.bodyTooLarge
        default: return ErrorCode.httpError
        }
    }

    /// The refusal an error answer is: the server's code, `Retry-After`, and the body's extra members
    /// (`missing`, `server`), which sit beside `error` or inside it.
    private func refusal(_ res: PolarisResponse) -> FileRefusal {
        let raw = res.body.prefix(CloudSyncFileBounds.errorMaxBytes)
        var top: [String: JSONValue] = [:]
        var code: String?
        if case .object(let o)? = try? CanonicalJSON.parse(utf8: Data(raw)) {
            top = o
            switch o["error"] {
            case .string(let s)?:
                code = s
                top["error"] = nil
            case .object(let inner)?:
                code = inner["code"]?.stringValue
                top["error"] = nil
                for (k, v) in inner where k != "code" && k != "message" { top[k] = v }
            default: code = o["code"]?.stringValue
            }
        }
        return FileRefusal(
            status: res.status, code: code ?? Self.fallbackCode(res.status),
            retryAfterSeconds: Self.retryAfter(res.header("retry-after")), body: .object(top))
    }

    private func empty(_ r: Exchanged) -> FileReply<Void> {
        switch r {
        case .refusal(let f): return .refused(f)
        case .response(let res): return res.isOK ? .ok(()) : .refused(refusal(res))
        }
    }

    /// A success that is a JSON object under the cap which `accept` approves.
    private func json(_ r: Exchanged, _ accept: ([String: JSONValue]) -> Bool = { _ in true }) -> FileReply<JSONValue> {
        switch r {
        case .refusal(let f): return .refused(f)
        case .response(let res):
            guard res.isOK else { return .refused(refusal(res)) }
            guard res.body.count <= CloudSyncFileBounds.jsonMaxBytes,
                case .object(let o)? = try? CanonicalJSON.parse(utf8: res.body), accept(o)
            else { return .refused(FileRefusal(status: res.status, code: ErrorCode.badResponse)) }
            return .ok(.object(o))
        }
    }

    private static func isWholeNumber(_ v: JSONValue?) -> Bool {
        if case .int? = v { return true }
        return false
    }

    // MARK: FileTransport

    public func begin(_ target: FileTarget, request: JSONValue) async throws -> FileReply<JSONValue> {
        let path = "\(try record(target))/begin"
        let r = try await exchange("POST", path, Sent(json: request), cap: CloudSyncFileBounds.jsonMaxBytes)
        return json(r) { v in
            guard let id = v["uploadId"]?.stringValue, Self.isKey(Substring(id)),
                let mode = v["mode"]?.stringValue, ["single", "multipart", "chunks"].contains(mode),
                let exp = v["expiresAt"]?.doubleValue, exp.isFinite
            else { return false }
            return v["partBytes"] == nil || v["partBytes"]?.doubleValue != nil
        }
    }

    public func status(_ target: FileTarget, uploadId: String) async throws -> FileReply<JSONValue> {
        let path = try upload(target, uploadId)
        let r = try await exchange("GET", path, cap: CloudSyncFileBounds.jsonMaxBytes)
        return json(r) { $0["mode"]?.stringValue != nil }
    }

    public func putSingle(_ target: FileTarget, uploadId: String, body: Data, sha256: String) async throws
        -> FileReply<Void>
    {
        let path = try upload(target, uploadId)
        return empty(
            try await exchange(
                "PUT", path, Sent(body: body, sha256: sha256), cap: CloudSyncFileBounds.errorMaxBytes))
    }

    public func putPart(_ target: FileTarget, uploadId: String, n: Int, body: Data, sha256: String) async throws
        -> FileReply<Void>
    {
        guard n >= 1, n <= SYNC_MAX_PARTS else { throw bad("part") }
        let path = "\(try upload(target, uploadId))/parts/\(n)"
        return empty(
            try await exchange(
                "PUT", path, Sent(body: body, sha256: sha256), cap: CloudSyncFileBounds.errorMaxBytes))
    }

    public func abort(_ target: FileTarget, uploadId: String) async throws -> FileReply<Void> {
        let path = try upload(target, uploadId)
        return empty(try await exchange("DELETE", path, cap: CloudSyncFileBounds.errorMaxBytes))
    }

    public func finalize(_ target: FileTarget, request: JSONValue) async throws -> FileReply<JSONValue> {
        let path = "\(try record(target))/finalize"
        let r = try await exchange("POST", path, Sent(json: request), cap: CloudSyncFileBounds.jsonMaxBytes)
        return json(r) { v in
            Self.isWholeNumber(v["version"]) && Self.isWholeNumber(v["size"]) && v["sha256"]?.stringValue != nil
                && ["whole", "chunks"].contains(v["format"]?.stringValue ?? "")
        }
    }

    public func planChunks(_ target: FileTarget, uploadId: String, request: JSONValue) async throws
        -> FileReply<JSONValue>
    {
        let path = "\(try upload(target, uploadId))/chunks"
        return json(try await exchange("POST", path, Sent(json: request), cap: CloudSyncFileBounds.jsonMaxBytes))
    }

    public func putChunk(_ target: FileTarget, uploadId: String, chunkId id: String, body: Data, sha256: String)
        async throws -> FileReply<Void>
    {
        guard body.count <= SYNC_CHUNK_MAX_STORED_BYTES else { throw bad("chunk") }
        let path = "\(try upload(target, uploadId))/chunks/\(try chunkId(id))"
        return empty(
            try await exchange(
                "PUT", path, Sent(body: body, sha256: sha256), cap: CloudSyncFileBounds.errorMaxBytes))
    }

    public func getFile(_ target: FileTarget, query: FileQuery) async throws -> FileReply<FileBody> {
        if let r = query.range, !(r.lowerBound >= 0 && r.upperBound > r.lowerBound) { throw bad("range") }
        if let v = query.version, !(v >= 0 && v < 1_000_000_000) { throw bad("version") }
        let path = "\(try record(target))\(query.version.map { "?version=\($0)" } ?? "")"
        // The body is bounded by the range asked, even for a 200 (a server that ignores `Range` and sends
        // more is refused, never buffered).
        let cap = query.range.map { $0.upperBound - $0.lowerBound } ?? CloudSyncFileBounds.manifestMaxBytes
        let r = try await exchange(
            "GET", path, Sent(range: query.range, ifMatch: query.ifMatch), expectBytes: cap, cap: cap)
        switch r {
        case .refusal(let f): return .refused(f)
        case .response(let res):
            guard res.isOK else { return .refused(refusal(res)) }
            guard res.status == 200 || res.status == 206, res.body.count <= cap else {
                return .refused(FileRefusal(status: res.status, code: ErrorCode.badResponse))
            }
            return .ok(
                FileBody(
                    status: res.status, data: res.body, etag: res.header("etag"),
                    contentRange: Self.parseContentRange(res.header("content-range"))))
        }
    }

    public func getChunk(collection: String, chunkId id: String) async throws -> FileReply<Data> {
        let path = "\(try base(collection))/chunks/\(try chunkId(id))"
        let r = try await exchange(
            "GET", path, expectBytes: SYNC_CHUNK_MAX_STORED_BYTES, cap: SYNC_CHUNK_MAX_STORED_BYTES)
        switch r {
        case .refusal(let f): return .refused(f)
        case .response(let res):
            guard res.isOK else { return .refused(refusal(res)) }
            guard res.status == 200, res.body.count <= SYNC_CHUNK_MAX_STORED_BYTES else {
                return .refused(FileRefusal(status: res.status, code: ErrorCode.badResponse))
            }
            return .ok(res.body)
        }
    }

    // MARK: FileRevisions

    public func revisions(_ target: FileTarget) async throws -> FileReply<JSONValue> {
        let path = "\(try record(target))/revisions"
        let r = try await exchange("GET", path, cap: CloudSyncFileBounds.jsonMaxBytes)
        return json(r) { $0["revisions"]?.arrayValue != nil }
    }

    /// `bytes <start>-<last>/<total>` as the half-open range it names.
    static func parseContentRange(_ header: String?) -> (start: Int, end: Int, total: Int)? {
        guard let header,
            let m = header.range(
                of: #"^bytes ([0-9]{1,15})-([0-9]{1,15})/([0-9]{1,15})$"#, options: .regularExpression),
            m.lowerBound == header.startIndex, m.upperBound == header.endIndex
        else { return nil }
        let nums = header.dropFirst(6).split(whereSeparator: { $0 == "-" || $0 == "/" }).compactMap { Int($0) }
        guard nums.count == 3 else { return nil }
        return (nums[0], nums[1] + 1, nums[2])
    }
}
