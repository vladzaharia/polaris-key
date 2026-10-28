// The Cloud Sync host's transport (U-07.6): one bearer HTTP exchange per request the machine queued.
// A port of Python's `cloud_sync/transport.py`. It sends only what the machine produced, only to the
// product's own `/sync` routes on the product origin, with the SDK's `X-PKey-*` headers.
//
//  - H-3: no redirect is followed (the bearer cannot be handed to another URL; a 3xx is an answer the
//    machine does not act on) and the body is read under an 8 MiB cap: a longer one is no answer.
//  - H-4: every request has a 15 s timeout, so a purge or a flush is bounded.
//  - Any failure to get an answer is `.transport`, which the machine reads as "nothing was
//    processed" and retries on its next trigger. A 2xx body that is not JSON is the same.
//
// The token and the body are never logged or put in an error.

import Foundation
import PolarisKeyCore

public struct CloudSyncTransport: Sendable {
    /// H-3: the most decoded bytes of a response.
    public static let maxResponseBytes = 8 * 1024 * 1024
    /// H-4: one exchange's deadline, in seconds.
    public static let timeoutSeconds = 15.0

    private let product: String
    private let baseUrl: String
    private let transport: any PolarisTransport
    private let headers: @Sendable () async -> [String: String]
    private let token: @Sendable () async -> String?

    public init(
        product: String, baseUrl: String, transport: any PolarisTransport,
        headers: @escaping @Sendable () async -> [String: String],
        token: @escaping @Sendable () async -> String?
    ) {
        self.product = product
        self.baseUrl = baseUrl
        self.transport = transport
        self.headers = headers
        self.token = token
    }

    /// The client's own transport, headers and device token.
    public init(core: CoreContext) {
        self.init(
            product: core.product, baseUrl: core.endpoints.baseUrl, transport: core.transport,
            headers: { await core.headers() }, token: { await core.token })
    }

    /// Whether `path` is one of the machine's two routes for the product (a pull or a push).
    public static func isSyncPath(product: String, _ path: String) -> Bool {
        let base = "/\(product)/sync"
        if path == "\(base)/ops" { return true }
        guard path.hasPrefix("\(base)?") else { return false }
        return path.dropFirst(base.count + 1).utf8.allSatisfy {
            ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A)
                || $0 == 0x5F || $0 == 0x3D || $0 == 0x26 || $0 == 0x2E || $0 == 0x25 || $0 == 0x2D
        }
    }

    /// Send one machine request; the answer is a status and body, or `.transport`.
    public func send(_ req: SyncRequest) async -> SyncResponse {
        #if canImport(FoundationNetworking)
        // S-4: the stock session follows redirects before any final-URL check and buffers the whole body
        // before the cap, so Cloud Sync does not run over it. An injected transport is still checked below.
        if transport is URLSessionTransport { return .transport }
        #endif
        guard let token = await token(), !token.isEmpty, Self.isSyncPath(product: product, req.path),
            let url = URL(string: baseUrl + req.path)
        else { return .transport }
        var h = await headers()
        h["authorization"] = "Bearer \(token)"
        h["accept"] = "application/json"
        var body: Data?
        if req.method == .post {
            h["content-type"] = "application/json"
            guard let b = req.body, let data = try? JSONEncoder().encode(b) else { return .transport }
            body = data
        }
        let res: PolarisResponse
        do {
            res = try await transport.send(
                PolarisRequest(
                    url: url, method: req.method.rawValue, headers: h, body: body,
                    timeoutSeconds: Self.timeoutSeconds, maxBodyBytes: Self.maxResponseBytes + 1,
                    followRedirects: false))
        } catch {
            return .transport
        }
        // The transport stops reading one byte past the cap: a longer body is no answer.
        if res.body.count > Self.maxResponseBytes { return .transport }
        if res.body.isEmpty { return .answer(status: res.status, body: nil) }
        do {
            return .answer(status: res.status, body: try CanonicalJSON.parse(utf8: res.body))
        } catch {
            // A 2xx the machine cannot read is not an answer; an error page keeps its status.
            return (200..<300).contains(res.status) ? .transport : .answer(status: res.status, body: nil)
        }
    }
}
