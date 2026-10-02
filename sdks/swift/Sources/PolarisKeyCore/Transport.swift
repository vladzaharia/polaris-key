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

    public init(
        code: String, message: String, detail: String? = nil, unsupported: Unsupported? = nil
    ) {
        self.code = code
        self.message = message
        self.detail = detail
        self.unsupported = unsupported
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
}

/// The production transport.
public struct URLSessionTransport: PolarisTransport {
    private let session: URLSession

    public init(session: URLSession = .shared) {
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
        if let limit = request.maxBodyBytes {
            (data, response) = try await capped(req, limit: limit)
        } else {
            (data, response) = try await session.data(for: req)
        }
        guard let http = response as? HTTPURLResponse else {
            throw PolarisError(code: "transport", message: "non-http response")
        }
        var headers: [String: String] = [:]
        for (key, value) in http.allHeaderFields {
            if let key = key as? String, let value = value as? String { headers[key] = value }
        }
        return PolarisResponse(status: http.statusCode, body: data, headers: headers)
    }

    /// Stream the body and stop at `limit` bytes, so a body larger than the caller can use is
    /// never buffered whole.
    private func capped(_ req: URLRequest, limit: Int) async throws -> (Data, URLResponse) {
        #if canImport(FoundationNetworking)
        let (data, response) = try await session.data(for: req)
        return (data.prefix(limit), response)
        #else
        let (bytes, response) = try await session.bytes(for: req)
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
