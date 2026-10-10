// The transport seam — wire contract v3 §5.
//
// v2 inlined `URLSession` calls into the client actor, which is how `refreshTrust` ended up
// hand-rolling its own request (its own timeout, its own size bound, its own `Accept` header)
// inside a 780-line god object. Everything that crosses the network now goes through
// `PolarisTransport`, which buys three things:
//
//   * `refreshTrust` moves OUT of the client and into Core, behind this protocol, where the
//     trust manifest is fetched on CORE's cadence rather than as a side effect of one service's
//     document fetch (§4.2);
//   * every request carries the same seven `X-PKey-*` headers and the same deadline, in one
//     place, so a new endpoint cannot ship without them (R4-08); and
//   * §7.3's local-only profile becomes a TYPE — `NoNetworkTransport` refuses at the dial,
//     before a URL is built or a header is assembled, so a transportless build cannot make a
//     request even by accident.

import Foundation

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The one error type the SDK throws. Everything on the VERIFICATION path fails closed by
/// returning `nil` instead (see Verify.swift / Trust.swift / Bundle.swift); this is for the
/// transport and orchestration layers, where the caller needs the server's machine-readable
/// code rather than a message to regex.
public struct PolarisError: Error, Sendable, Equatable {
    /// The wire error code (`PolarisErrorBody.error.code`), a §7 bundle refusal reason, or one
    /// of the client-side codes below. Deliberately a `String`: the server may introduce a code
    /// this build predates, and the caller should still get the raw value rather than "unknown".
    public let code: String
    public let message: String
    /// The refused step, where the code has one (wire v4's `feed-rejected` and `record-rejected`:
    /// `jws`, `claims`, `channel`, `selector`, `freshness`, `hash`); nil otherwise.
    public let detail: String?
    /// The typed N/A behind a `service-unavailable` refusal (PARITY §2.2, P1b-10): the feature,
    /// `reason` `product` and the detail, exactly as `supports(feature)` reports them. The error
    /// stays a `PolarisError` with its old code so existing `catch` sites keep matching. Nil for
    /// every other code.
    public let unsupported: Unsupported?
    /// A person-facing sentence for this occurrence, when the catalog's sentence for `code` is
    /// about another service (`not-configured` reads as licensing copy). `localizedDescription`
    /// prefers it; nil uses the catalog sentence for `code`.
    public let userMessage: String?

    public init(
        code: String, message: String, detail: String? = nil, unsupported: Unsupported? = nil,
        userMessage: String? = nil
    ) {
        self.code = code
        self.message = message
        self.detail = detail
        self.unsupported = unsupported
        self.userMessage = userMessage
    }

    // ── Client-side codes ────────────────────────────────────────────────────────────────
    /// A `baseUrl` that would carry the device bearer token in the clear.
    public static let insecureBaseUrl = "insecure-base-url"
    /// This client is local-only (§7.3); the call would have opened a socket.
    public static let localOnly = "local-only"
    /// The product does not run the service this sub-client speaks to (D-21).
    public static let serviceUnavailable = "service-unavailable"
    /// Remote device management needs a credential this client does not hold.
    public static let deviceManagementUnsupported = "device-management-unsupported"
    /// A redirect refused: it would downgrade to plaintext or replay a body to another origin.
    public static let insecureRedirect = ErrorCode.insecureRedirect
    /// More than five redirects.
    public static let tooManyRedirects = ErrorCode.tooManyRedirects
}

/// One HTTP response, reduced to what this SDK actually reads.
public struct PolarisResponse: Sendable {
    public let status: Int
    public let body: Data
    /// Response headers, looked up case-insensitively via `header(_:)`.
    public let headers: [String: String]

    public init(status: Int, body: Data, headers: [String: String] = [:]) {
        self.status = status
        self.body = body
        self.headers = headers
    }

    /// Case-insensitive header read — HTTP header names are not case-sensitive and `ETag` vs
    /// `etag` is exactly the kind of difference a stub server and a real one disagree on.
    public func header(_ name: String) -> String? {
        let wanted = name.lowercased()
        for (key, value) in headers where key.lowercased() == wanted { return value }
        return nil
    }

    public var isOK: Bool { (200..<300).contains(status) }
}

/// One outbound request.
public struct PolarisRequest: Sendable {
    public var url: URL
    public var method: String
    public var headers: [String: String]
    public var body: Data?
    /// Deadline in seconds. `0` disables it.
    public var timeoutSeconds: Double
    /// Stop reading the response body after this many bytes, where the transport can (the
    /// release-record fetch, plans/P3-01.md §2.5 step 11). Nil reads it whole.
    public var maxBodyBytes: Int?

    public init(
        url: URL, method: String = "GET", headers: [String: String] = [:], body: Data? = nil,
        timeoutSeconds: Double = 15, maxBodyBytes: Int? = nil
    ) {
        self.url = url
        self.method = method
        self.headers = headers
        self.body = body
        self.timeoutSeconds = timeoutSeconds
        self.maxBodyBytes = maxBodyBytes
    }
}

/// Everything the SDK needs from a network stack. `Sendable` because Core hands it across actor
/// boundaries; a conformance is expected to be safe to call concurrently.
public protocol PolarisTransport: Sendable {
    /// Perform one request. Throws on transport failure (including the local-only refusal); a
    /// non-2xx response is a normal return, because the status ladder is the caller's business.
    func send(_ request: PolarisRequest) async throws -> PolarisResponse
    /// Perform one request and hand the body over as it arrives (a verified download, §3.6),
    /// so a large payload is never buffered whole. Like `send`, a non-2xx response is a normal
    /// return. The default buffers through `send` and yields the body as one chunk, so every
    /// transport (a test double, the local-only refusal) streams correctly without writing it.
    func stream(_ request: PolarisRequest) async throws -> PolarisStreamResponse
}

/// A streamed response: the status and headers, and the body as chunks.
public struct PolarisStreamResponse: Sendable {
    public let status: Int
    public let headers: [String: String]
    public let body: AsyncThrowingStream<Data, Error>

    public init(status: Int, headers: [String: String] = [:], body: AsyncThrowingStream<Data, Error>) {
        self.status = status
        self.headers = headers
        self.body = body
    }

    /// Case-insensitive header read, as `PolarisResponse.header(_:)`.
    public func header(_ name: String) -> String? {
        let wanted = name.lowercased()
        for (key, value) in headers where key.lowercased() == wanted { return value }
        return nil
    }

    /// The whole body (for a refusal's JSON), bounded by `limit` bytes.
    public func collect(limit: Int = 1 << 16) async throws -> Data {
        var out = Data()
        for try await chunk in body {
            out.append(chunk.prefix(limit - out.count))
            if out.count >= limit { break }
        }
        return out
    }
}

extension PolarisTransport {
    public func stream(_ request: PolarisRequest) async throws -> PolarisStreamResponse {
        try await send(request).streamed
    }
}

extension PolarisResponse {
    /// This buffered response as a stream of one chunk.
    public var streamed: PolarisStreamResponse {
        let body = self.body
        return PolarisStreamResponse(
            status: status, headers: headers,
            body: AsyncThrowingStream { c in
                if !body.isEmpty { c.yield(body) }
                c.finish()
            })
    }
}

/// The production transport.
public struct URLSessionTransport: PolarisTransport {
    private let session: URLSession

    /// An ephemeral session: no on-disk cache, cookie jar or credential store, so a bearer-bearing
    /// response never lands in `~/Library/Caches` and no cookie rides between calls.
    public static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }

    public init(session: URLSession = URLSessionTransport.makeSession()) {
        self.session = session
    }

    public func send(_ request: PolarisRequest) async throws -> PolarisResponse {
        var req = URLRequest(url: request.url)
        req.httpMethod = request.method
        if request.timeoutSeconds > 0 { req.timeoutInterval = request.timeoutSeconds }
        for (key, value) in request.headers { req.setValue(value, forHTTPHeaderField: key) }
        req.httpBody = request.body

        let data: Data
        let response: URLResponse
        let policy = RedirectPolicy.Delegate()
        if let limit = request.maxBodyBytes {
            (data, response) = try await capped(req, limit: limit, delegate: policy)
        } else {
            #if canImport(FoundationNetworking)
            (data, response) = try await session.data(for: req)
            #else
            (data, response) = try await session.data(for: req, delegate: policy)
            #endif
        }
        try policy.throwIfRefused()
        guard let http = response as? HTTPURLResponse else {
            throw PolarisError(code: "transport", message: "non-http response")
        }
        var headers: [String: String] = [:]
        for (key, value) in http.allHeaderFields {
            if let key = key as? String, let value = value as? String { headers[key] = value }
        }
        return PolarisResponse(status: http.statusCode, body: data, headers: headers)
    }

    public func stream(_ request: PolarisRequest) async throws -> PolarisStreamResponse {
        #if canImport(FoundationNetworking)
        return try await send(request).streamed
        #else
        var req = URLRequest(url: request.url)
        req.httpMethod = request.method
        if request.timeoutSeconds > 0 { req.timeoutInterval = request.timeoutSeconds }
        for (key, value) in request.headers { req.setValue(value, forHTTPHeaderField: key) }
        req.httpBody = request.body
        let policy = RedirectPolicy.Delegate()
        let (bytes, response) = try await session.bytes(for: req, delegate: policy)
        if let refusal = policy.refusal {
            bytes.task.cancel()
            throw refusal
        }
        guard let http = response as? HTTPURLResponse else {
            bytes.task.cancel()
            throw PolarisError(code: "transport", message: "non-http response")
        }
        var headers: [String: String] = [:]
        for (key, value) in http.allHeaderFields {
            if let key = key as? String, let value = value as? String { headers[key] = value }
        }
        let body = AsyncThrowingStream<Data, Error> { c in
            let task = Task {
                var buffer = Data()
                buffer.reserveCapacity(1 << 16)
                do {
                    for try await byte in bytes {
                        buffer.append(byte)
                        if buffer.count >= 1 << 16 {
                            c.yield(buffer)
                            buffer.removeAll(keepingCapacity: true)
                        }
                    }
                    if !buffer.isEmpty { c.yield(buffer) }
                    c.finish()
                } catch {
                    c.finish(throwing: error)
                }
            }
            c.onTermination = { _ in
                task.cancel()
                bytes.task.cancel()
            }
        }
        return PolarisStreamResponse(status: http.statusCode, headers: headers, body: body)
        #endif
    }

    /// Stream the body and stop at `limit` bytes, so a body larger than the caller can use is
    /// never buffered whole.
    private func capped(
        _ req: URLRequest, limit: Int, delegate: RedirectPolicy.Delegate
    ) async throws -> (Data, URLResponse) {
        #if canImport(FoundationNetworking)
        let (data, response) = try await session.data(for: req)
        return (data.prefix(limit), response)
        #else
        let (bytes, response) = try await session.bytes(for: req, delegate: delegate)
        var data = Data()
        if response.expectedContentLength > 0 {
            data.reserveCapacity(Int(min(response.expectedContentLength, Int64(limit))))
        }
        for try await byte in bytes {
            data.append(byte)
            if data.count >= limit {
                bytes.task.cancel()
                break
            }
        }
        return (data, response)
        #endif
    }
}

/// The redirect rule for every product-scoped call (WIRE-CONTRACT-V4 §5):
///
///   * a same-origin hop keeps the headers;
///   * a cross-origin hop drops `Authorization` and every `X-PKey-*` header, and is followed only
///     for GET and HEAD;
///   * a 307 or 308 on a non-GET/HEAD to another origin, and any https to non-https hop, is refused
///     with `insecure-redirect`;
///   * more than 5 hops is `too-many-redirects`.
///
/// A refusal stops the follow and `send` throws it as a `PolarisError`, so a response that was
/// never meant for this device cannot be mistaken for the control plane's answer.
enum RedirectPolicy {
    static let maxHops = 5

    enum Verdict: Equatable {
        case follow(URLRequest)
        case refuse(code: String)
    }

    static func origin(_ url: URL?) -> String {
        "\(url?.scheme?.lowercased() ?? "")://\(url?.host?.lowercased() ?? ""):\(url?.port ?? -1)"
    }

    /// `from` is the request that was answered with `status`; `next` is the one URLSession
    /// proposes; `hops` counts redirects already followed.
    static func decide(
        from: URLRequest, status: Int, next: URLRequest, hops: Int
    ) -> Verdict {
        if hops >= maxHops { return .refuse(code: PolarisError.tooManyRedirects) }
        let fromScheme = from.url?.scheme?.lowercased()
        let toScheme = next.url?.scheme?.lowercased()
        guard toScheme == "https" || (toScheme == "http" && fromScheme == "http") else {
            return .refuse(code: PolarisError.insecureRedirect)
        }
        if origin(from.url) == origin(next.url) { return .follow(next) }
        let fromMethod = (from.httpMethod ?? "GET").uppercased()
        let nextMethod = (next.httpMethod ?? "GET").uppercased()
        let safe: Set<String> = ["GET", "HEAD"]
        if (status == 307 || status == 308) && !safe.contains(fromMethod) {
            return .refuse(code: PolarisError.insecureRedirect)
        }
        guard safe.contains(nextMethod) else { return .refuse(code: PolarisError.insecureRedirect) }
        var stripped = next
        for name in (next.allHTTPHeaderFields ?? [:]).keys {
            let lower = name.lowercased()
            if lower == "authorization" || lower.hasPrefix("x-pkey-") {
                stripped.setValue(nil, forHTTPHeaderField: name)
            }
        }
        // A body never follows a credential-stripped hop.
        stripped.httpBody = nil
        return .follow(stripped)
    }

    final class Delegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        private let lock = NSLock()
        private var hops = 0
        private var refusalValue: PolarisError?

        var refusal: PolarisError? {
            lock.lock()
            defer { lock.unlock() }
            return refusalValue
        }

        func throwIfRefused() throws {
            if let refusal { throw refusal }
        }

        func urlSession(
            _ session: URLSession, task: URLSessionTask,
            willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
            completionHandler: @escaping (URLRequest?) -> Void
        ) {
            lock.lock()
            let count = hops
            hops += 1
            lock.unlock()
            let from = task.currentRequest ?? task.originalRequest ?? request
            switch RedirectPolicy.decide(
                from: from, status: response.statusCode, next: request, hops: count)
            {
            case .follow(let next):
                completionHandler(next)
            case .refuse(let code):
                lock.lock()
                refusalValue = PolarisError(
                    code: code,
                    message: code == PolarisError.tooManyRedirects
                        ? "The control plane redirected too many times."
                        : "A redirect that would leak the device credential was refused.")
                lock.unlock()
                completionHandler(nil)
            }
        }
    }
}

/// The §7.3 local-only transport: it refuses, loudly, instead of dialling.
///
/// Refusing HERE rather than at each call site is deliberate. A transportless client must fail
/// on the attempt to dial — before a URL is built or a header is assembled — so there is no
/// path by which a local-only build performs a request its operator did not sanction. And it is
/// a refusal rather than a hang: a connect timeout would be indistinguishable from being
/// offline, so the host could never branch on the one thing it can actually fix.
public struct NoNetworkTransport: PolarisTransport {
    public init() {}

    public func send(_ request: PolarisRequest) async throws -> PolarisResponse {
        throw PolarisError(
            code: PolarisError.localOnly,
            message: "This client is in local-only mode; network calls are refused.")
    }
}
