// `client.backend` — the client half of a product backend (WIRE-CONTRACT-V4 §14, framework
// drop-ins §6). It sends the app's signed licence document to the app's own backend:
//
//     let (data, response) = try await client.backend.data(for: URLRequest(url: exportURL))
//     let headers = try await client.backend.headers()   // raw: you decide where they go
//
// The headers are `X-PKey-License` (the compact licence JWS, when one is held) and
// `X-PKey-Device`. Never the device token, never the config document.
//
// SECURITY. `data(for:)` sends only to an origin in `backend.origins` (exact scheme, host and
// port; https, or http on loopback). The check runs before the first byte and again on EVERY
// redirect hop, before that hop is sent: a hop to another origin is not followed, and the call
// throws `backend-origin-not-allowed`. The message names the origin only (a path or query can
// hold a secret). `headers()` is raw and does no such check.
//
// The rule is `clientBackendAction` (`backend-matrix.json`'s `client` section): a document within
// `REFRESH_MARGIN_SECONDS` of its expiry is synced before sending; `license_stale` and
// `license_invalid` (401) force one sync and one retry; `not_entitled` and `sign_in_required`
// (403) are never retried and throw a typed `PolarisError`. Concurrent callers share one sync,
// and two forced syncs are at least 10 s apart, so a backend that answers `license_stale` to
// every request cannot make the client ask the Worker for a document per request.

import Foundation
import PolarisKeyCore

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// §14.5: what the client does next.
public enum BackendAction: String, Sendable, Equatable {
    case send
    case refreshThenSend = "refresh-then-send"
    case refreshAndRetry = "refresh-and-retry"
    case surface
}

/// §14.5. `document` is `(issuedAt, expiresAt)` or nil; `response` is `(status, code)` (the
/// problem body's `code`) or nil before sending.
public func clientBackendAction(
    document: (issuedAt: Int, expiresAt: Int)?, now: Int,
    response: (status: Int, code: String?)?, retried: Bool = false
) -> BackendAction {
    guard let response else {
        guard let document else { return .send }
        return now > document.expiresAt - REFRESH_MARGIN_SECONDS ? .refreshThenSend : .send
    }
    if response.status == 401,
        response.code == "license_stale" || response.code == "license_invalid", !retried
    {
        return .refreshAndRetry
    }
    return .surface
}

public final class BackendClient: Sendable {
    public static let headerLicense = "X-PKey-License"
    public static let headerDevice = "X-PKey-Device"
    /// The least time between two forced syncs.
    public static let forcedSyncMinInterval: Double = 10
    static let maxHops = 5
    private static let loopback: Set<String> = ["localhost", "127.0.0.1", "[::1]"]

    /// The held licence: the compact JWS and its `(issuedAt, expiresAt)`.
    struct Held: Sendable {
        let jws: String
        let issuedAt: Int
        let expiresAt: Int
    }

    struct Seams: Sendable {
        var held: @Sendable () async -> Held?
        var deviceId: @Sendable () async -> String
        var now: @Sendable () async -> Int
        /// True when the licence document is now current (applied or unchanged).
        var sync: @Sendable (Bool) async -> Bool
        var monotonic: @Sendable () -> Double = { ProcessInfo.processInfo.systemUptime }
        var configuration: @Sendable () -> URLSessionConfiguration = { .ephemeral }
    }

    /// The configured origins, normalised and sorted.
    public let origins: [String]
    private let allowed: Set<String>
    private let seams: Seams
    private let flights = Flights()

    init(origins: [String], seams: Seams) throws {
        var set = Set<String>()
        for origin in origins { set.insert(try BackendClient.normalizeOrigin(origin)) }
        self.allowed = set
        self.origins = set.sorted()
        self.seams = seams
    }

    // ── Origins ──────────────────────────────────────────────────────────────────────

    /// One exact origin (`scheme://host[:port]`, lower-cased, default port dropped), or an
    /// `invalid-options` error.
    public static func normalizeOrigin(_ origin: String) throws -> String {
        func bad() -> PolarisError {
            PolarisError(
                code: ErrorCode.invalidOptions,
                message:
                    "backend.origins: \"\(origin)\" is not an exact origin (https://host[:port]; http only on loopback)."
            )
        }
        guard !origin.contains("*"), !origin.hasSuffix("?"), !origin.hasSuffix("#"),
            let c = URLComponents(string: origin), let scheme = c.scheme?.lowercased(),
            let host = c.host, !host.isEmpty,
            c.path.isEmpty || c.path == "/", c.query == nil, c.fragment == nil,
            c.user == nil, c.password == nil
        else { throw bad() }
        let shown = shownHost(host)
        guard scheme == "https" || (scheme == "http" && loopback.contains(shown)) else {
            throw bad()
        }
        return originString(scheme, shown, c.port)
    }

    private static func shownHost(_ host: String) -> String {
        let h = host.lowercased()
        if h.hasPrefix("[") { return h }
        return h.contains(":") ? "[\(h)]" : h
    }

    private static func originString(_ scheme: String, _ host: String, _ port: Int?) -> String {
        let def = scheme == "https" ? 443 : 80
        guard let port, port != def else { return "\(scheme)://\(host)" }
        return "\(scheme)://\(host):\(port)"
    }

    static func origin(of url: URL?) -> String? {
        guard let url, let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
            let scheme = c.scheme?.lowercased(), scheme == "http" || scheme == "https",
            let host = c.host, !host.isEmpty
        else { return nil }
        return originString(scheme, shownHost(host), c.port)
    }

    private func assertAllowed(_ url: URL?) throws {
        let origin = BackendClient.origin(of: url)
        guard let origin, allowed.contains(origin) else {
            throw BackendClient.refusal(origin)
        }
    }

    static func refusal(_ origin: String?) -> PolarisError {
        PolarisError(
            code: ErrorCode.backendOriginNotAllowed,
            // The origin only: a URL's path and query can hold a secret.
            message: ErrorCopy.message(
                ErrorCode.backendOriginNotAllowed, detail: origin ?? "an unreadable URL"))
    }

    // ── The headers ──────────────────────────────────────────────────────────────────

    /// `X-PKey-License` and `X-PKey-Device`, raw. A document within the refresh margin of its
    /// expiry is synced first. Without a licence only `X-PKey-Device` is returned.
    public func headers() async throws -> [String: String] {
        await freshen()
        return await build()
    }

    private func build() async -> [String: String] {
        var out: [String: String] = [:]
        if let held = await seams.held() { out[BackendClient.headerLicense] = held.jws }
        out[BackendClient.headerDevice] = await seams.deviceId()
        return out
    }

    private func action(
        _ response: (status: Int, code: String?)?, retried: Bool = false
    ) async -> BackendAction {
        let held = await seams.held()
        return clientBackendAction(
            document: held.map { ($0.issuedAt, $0.expiresAt) }, now: await seams.now(),
            response: response, retried: retried)
    }

    private func freshen() async {
        if await action(nil) == .refreshThenSend { _ = await shared(force: false) }
    }

    private func shared(force: Bool) async -> Bool {
        await flights.run(
            force: force, minInterval: BackendClient.forcedSyncMinInterval,
            clock: seams.monotonic, work: seams.sync)
    }

    // ── data(for:) ───────────────────────────────────────────────────────────────────

    /// Send `request` to an allowed origin with the licence headers attached, like
    /// `URLSession.data(for:)`. Redirects are followed by hand-checked hops only: each hop's
    /// origin is checked before it is sent. Your own `Authorization` header passes through.
    public func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        try assertAllowed(request.url)
        await freshen()
        var (data, response) = try await send(request)
        var code = BackendClient.problemCode(response, data)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if await action((status, code)) == .refreshAndRetry, await shared(force: true) {
            (data, response) = try await send(request)
            code = BackendClient.problemCode(response, data)
        }
        if let http = response as? HTTPURLResponse, http.statusCode == 403,
            code == "not_entitled" || code == "sign_in_required", let code
        {
            throw PolarisError(code: code, message: ErrorCopy.message(code))
        }
        return (data, response)
    }

    private func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        var req = request
        for (k, v) in await build() { req.setValue(v, forHTTPHeaderField: k) }
        let guardDelegate = HopGuard(allowed: allowed)
        let session = URLSession(
            configuration: seams.configuration(), delegate: guardDelegate, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let result: (Data, URLResponse)
        do {
            result = try await session.data(for: req)
        } catch {
            if let refused = guardDelegate.refusal { throw refused }
            throw error
        }
        if let refused = guardDelegate.refusal { throw refused }
        return result
    }

    private static func problemCode(_ response: URLResponse, _ body: Data) -> String? {
        guard let http = response as? HTTPURLResponse, http.statusCode == 401 || http.statusCode == 403,
            let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
        else { return nil }
        return object["code"] as? String
    }

    // ── One shared sync ──────────────────────────────────────────────────────────────

    /// One sync for every concurrent caller; a forced caller joins only a forced one.
    actor Flights {
        private struct Flight {
            let id: Int
            let force: Bool
            let task: Task<Bool, Never>
        }
        private var flight: Flight?
        private var nextId = 0
        private var lastForced: Double?

        func run(
            force: Bool, minInterval: Double, clock: @Sendable () -> Double,
            work: @escaping @Sendable (Bool) async -> Bool
        ) async -> Bool {
            if let live = flight, live.force || !force { return await live.task.value }
            if force {
                let at = clock()
                if let last = lastForced, at - last < minInterval { return false }
                lastForced = at
            }
            nextId += 1
            let mine = Flight(id: nextId, force: force, task: Task { await work(force) })
            flight = mine
            let ok = await mine.task.value
            if flight?.id == mine.id { flight = nil }
            return ok
        }
    }

    /// Refuses, before it is sent, a redirect hop to an origin outside `backend.origins`.
    final class HopGuard: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        private let allowed: Set<String>
        private let lock = NSLock()
        private var hops = 0
        private var refusalValue: PolarisError?

        init(allowed: Set<String>) { self.allowed = allowed }

        var refusal: PolarisError? {
            lock.lock()
            defer { lock.unlock() }
            return refusalValue
        }

        func urlSession(
            _ session: URLSession, task: URLSessionTask,
            willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
            completionHandler: @escaping (URLRequest?) -> Void
        ) {
            lock.lock()
            hops += 1
            let count = hops
            lock.unlock()
            let origin = BackendClient.origin(of: request.url)
            if let origin, allowed.contains(origin), count <= BackendClient.maxHops {
                completionHandler(request)
                return
            }
            lock.lock()
            refusalValue =
                count > BackendClient.maxHops && origin.map(allowed.contains) == true
                ? PolarisError(
                    code: PolarisError.tooManyRedirects,
                    message: "The backend redirected too many times.")
                : BackendClient.refusal(origin)
            lock.unlock()
            completionHandler(nil)
        }
    }
}
