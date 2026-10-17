// @pkey-feature core.backend
// `client.backend` (WIRE-CONTRACT-V4 §14.5, framework drop-ins §6): the `client` rows of
// `backend-matrix.json`, the origin allow-list on the request and on every redirect hop (checked
// before the hop is sent), the shared pre-sync, one forced retry with a 10 s floor, and the typed
// 403 errors. A URLProtocol stub stands in for the network and records every request it sees.

import Foundation
import XCTest

@testable import PolarisKey
@testable import PolarisKeyCore

/// A stub network: `handler` answers each request; every request is recorded.
final class BackendStub: URLProtocol, @unchecked Sendable {
    enum Reply {
        case ok(status: Int, body: String)
        case redirect(String)
    }
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) -> Reply)?
    nonisolated(unsafe) static var seen: [URLRequest] = []
    static let lock = NSLock()

    static func reset(_ handler: @escaping @Sendable (URLRequest) -> Reply) {
        lock.lock()
        defer { lock.unlock() }
        Self.handler = handler
        seen = []
    }

    static var urls: [String] {
        lock.lock()
        defer { lock.unlock() }
        return seen.compactMap { $0.url?.absoluteString }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        BackendStub.lock.lock()
        BackendStub.seen.append(request)
        let h = BackendStub.handler
        BackendStub.lock.unlock()
        let url = request.url!
        switch h?(request) ?? .ok(status: 200, body: "") {
        case .ok(let status, let body):
            let r = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!
            client?.urlProtocol(self, didReceive: r, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        case .redirect(let to):
            let r = HTTPURLResponse(
                url: url, statusCode: 302, httpVersion: nil, headerFields: ["Location": to])!
            var next = request
            next.url = URL(string: to)
            client?.urlProtocol(self, wasRedirectedTo: next, redirectResponse: r)
            // A refused redirect makes the 3xx the final response: it needs a body to finish.
            client?.urlProtocol(self, didReceive: r, cacheStoragePolicy: .notAllowed)
            client?.urlProtocolDidFinishLoading(self)
        }
    }
}

final class BackendTests: XCTestCase {
    private struct Row: Decodable {
        struct Doc: Decodable { let issuedAt: Int; let expiresAt: Int }
        struct Resp: Decodable { let status: Int; let code: String? }
        struct Input: Decodable {
            let document: Doc?; let now: Int; let response: Resp?; let retried: Bool
        }
        struct Expect: Decodable { let action: String }
        let id: String; let input: Input; let expect: Expect
    }
    private struct Matrix: Decodable {
        let backendMatrixVersion: Int
        let client: [Row]
    }

    // A licence held from t0, valid an hour.
    private let jws = "aaa.bbb.ccc"
    private let t0 = 1_700_000_000

    private final class State: @unchecked Sendable {
        let lock = NSLock()
        var syncs: [Bool] = []
        var clock = 0.0
        var now = 1_700_000_100
        var syncOK = true
        var syncGate: (@Sendable () async -> Void)?
        func record(_ force: Bool) -> Bool {
            lock.lock()
            defer { lock.unlock() }
            syncs.append(force)
            return syncOK
        }
        func setClock(_ v: Double) {
            lock.lock()
            defer { lock.unlock() }
            clock = v
        }
    }

    private func make(
        origins: [String] = ["https://api.example.com"], held: Bool = true, state: State = State()
    ) throws -> (BackendClient, State) {
        let jws = self.jws
        let t0 = self.t0
        let seams = BackendClient.Seams(
            held: { held ? BackendClient.Held(jws: jws, issuedAt: t0, expiresAt: t0 + 3600) : nil },
            deviceId: { "dev-1" },
            now: { state.now },
            sync: { force in
                let ok = state.record(force)
                await state.syncGate?()
                return ok
            },
            monotonic: { state.lock.lock(); defer { state.lock.unlock() }; return state.clock },
            configuration: {
                let c = URLSessionConfiguration.ephemeral
                c.protocolClasses = [BackendStub.self]
                return c
            })
        return (try BackendClient(origins: origins, seams: seams), state)
    }

    private func get(_ url: String, headers: [String: String] = [:]) -> URLRequest {
        var r = URLRequest(url: URL(string: url)!)
        for (k, v) in headers { r.setValue(v, forHTTPHeaderField: k) }
        return r
    }

    // ── Corpus ───────────────────────────────────────────────────────────────────────

    func testClientRowsReplay() throws {
        let matrix = try CorpusLocator.load(Matrix.self, "backend-matrix")
        XCTAssertEqual(matrix.backendMatrixVersion, 1)
        XCTAssertGreaterThanOrEqual(matrix.client.count, 17)
        for row in matrix.client {
            let action = clientBackendAction(
                document: row.input.document.map { ($0.issuedAt, $0.expiresAt) }, now: row.input.now,
                response: row.input.response.map { ($0.status, $0.code) }, retried: row.input.retried)
            XCTAssertEqual(action.rawValue, row.expect.action, row.id)
        }
    }

    // ── Origins ──────────────────────────────────────────────────────────────────────

    func testOriginNormalisation() throws {
        XCTAssertEqual(try BackendClient.normalizeOrigin("HTTPS://API.Example.com:443"), "https://api.example.com")
        XCTAssertEqual(try BackendClient.normalizeOrigin("https://a.example:8443/"), "https://a.example:8443")
        XCTAssertEqual(try BackendClient.normalizeOrigin("http://localhost:3000"), "http://localhost:3000")
        XCTAssertEqual(try BackendClient.normalizeOrigin("http://127.0.0.1"), "http://127.0.0.1")
        XCTAssertEqual(try BackendClient.normalizeOrigin("http://[::1]:8080"), "http://[::1]:8080")
        for bad in [
            "http://api.example.com", "https://*.example.com", "https://a.example/path",
            "https://a.example?x=1", "https://a.example#f", "https://u:p@a.example", "api.example.com",
            "ftp://a.example", "https://a.example?", "",
        ] {
            XCTAssertThrowsError(try BackendClient.normalizeOrigin(bad), bad) {
                XCTAssertEqual(($0 as? PolarisError)?.code, "invalid-options", bad)
            }
        }
    }

    func testNonAllowedOriginIsRefusedBeforeAnythingIsSent() async throws {
        BackendStub.reset { _ in .ok(status: 200, body: "") }
        let (backend, state) = try make()
        for url in [
            "https://evil.example/export?token=SECRET", "http://api.example.com/x",
            "https://api.example.com:8443/x", "https://api.example.com.evil.example/x",
        ] {
            do {
                _ = try await backend.data(for: get(url))
                XCTFail("sent \(url)")
            } catch let e as PolarisError {
                XCTAssertEqual(e.code, "backend-origin-not-allowed")
                XCTAssertFalse(e.message.contains("SECRET"), "the origin only")
                XCTAssertFalse(e.message.contains("/export"), "the origin only")
            }
        }
        XCTAssertEqual(BackendStub.urls, [])
        XCTAssertEqual(state.syncs, [])
    }

    func testEmptyOriginsRefusesEverything() async throws {
        BackendStub.reset { _ in .ok(status: 200, body: "") }
        let (backend, _) = try make(origins: [])
        do {
            _ = try await backend.data(for: get("https://api.example.com/x"))
            XCTFail("sent")
        } catch let e as PolarisError { XCTAssertEqual(e.code, "backend-origin-not-allowed") }
        XCTAssertEqual(BackendStub.urls, [])
    }

    func testRedirectToAnotherOriginIsNotSent() async throws {
        BackendStub.reset { req in
            req.url?.host == "api.example.com" ? .redirect("https://evil.example/steal") : .ok(status: 200, body: "")
        }
        let (backend, _) = try make()
        do {
            _ = try await backend.data(for: get("https://api.example.com/export"))
            XCTFail("followed")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, "backend-origin-not-allowed")
            XCTAssertTrue(e.message.contains("https://evil.example"))
            XCTAssertFalse(e.message.contains("steal"))
        }
        XCTAssertEqual(BackendStub.urls, ["https://api.example.com/export"], "the hop was never sent")
    }

    func testRedirectToAnAllowedOriginIsFollowedWithTheHeaders() async throws {
        BackendStub.reset { req in
            req.url?.path == "/a" ? .redirect("https://api.example.com/b") : .ok(status: 200, body: "ok")
        }
        let (backend, _) = try make()
        let (data, _) = try await backend.data(for: get("https://api.example.com/a"))
        XCTAssertEqual(String(decoding: data, as: UTF8.self), "ok")
        XCTAssertEqual(BackendStub.urls, ["https://api.example.com/a", "https://api.example.com/b"])
        let last = BackendStub.seen.last!
        XCTAssertEqual(last.value(forHTTPHeaderField: "X-PKey-License"), jws)
    }

    func testAuthorizationDoesNotCrossBetweenAllowedOrigins() async throws {
        BackendStub.reset { req in
            req.url?.host == "api.example.com" ? .redirect("https://other.example.com/b") : .ok(status: 200, body: "ok")
        }
        let (backend, _) = try make(origins: ["https://api.example.com", "https://other.example.com"])
        _ = try await backend.data(for: get("https://api.example.com/a", headers: ["Authorization": "Bearer app"]))
        XCTAssertEqual(BackendStub.urls.count, 2)
        let last = BackendStub.seen.last!
        XCTAssertNil(last.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(last.value(forHTTPHeaderField: "X-PKey-License"), jws)
    }

    func testRedirectToHttpDowngradeIsRefused() async throws {
        BackendStub.reset { _ in .redirect("http://api.example.com/b") }
        let (backend, _) = try make()
        do {
            _ = try await backend.data(for: get("https://api.example.com/a"))
            XCTFail("followed")
        } catch let e as PolarisError { XCTAssertEqual(e.code, "backend-origin-not-allowed") }
        XCTAssertEqual(BackendStub.urls, ["https://api.example.com/a"])
    }

    // ── Headers ──────────────────────────────────────────────────────────────────────

    func testSendsLicenceAndDeviceAndKeepsAuthorization() async throws {
        BackendStub.reset { _ in .ok(status: 200, body: "") }
        let (backend, state) = try make()
        _ = try await backend.data(for: get("https://api.example.com/x", headers: ["Authorization": "Bearer app"]))
        let r = BackendStub.seen[0]
        XCTAssertEqual(r.value(forHTTPHeaderField: "X-PKey-License"), jws)
        XCTAssertEqual(r.value(forHTTPHeaderField: "X-PKey-Device"), "dev-1")
        XCTAssertEqual(r.value(forHTTPHeaderField: "Authorization"), "Bearer app")
        XCTAssertNil(r.value(forHTTPHeaderField: "X-PKey-Token"))
        XCTAssertEqual(state.syncs, [], "a fresh document is not synced")
    }

    func testHeadersWithoutALicenceIsDeviceOnly() async throws {
        let (backend, _) = try make(held: false)
        let h = try await backend.headers()
        XCTAssertEqual(h, ["X-PKey-Device": "dev-1"])
    }

    func testHeadersPastTheMarginSyncFirstOnceForConcurrentCallers() async throws {
        let state = State()
        state.now = t0 + 3600 - 1799
        state.syncGate = { try? await Task.sleep(nanoseconds: 100_000_000) }
        let (backend, _) = try make(state: state)
        await withTaskGroup(of: Void.self) { g in
            for _ in 0..<5 { g.addTask { _ = try? await backend.headers() } }
        }
        XCTAssertEqual(state.syncs, [false], "one shared, unforced sync")
    }

    // ── Retry and errors ─────────────────────────────────────────────────────────────

    func testStaleForcesOneSyncAndOneRetry() async throws {
        BackendStub.reset { _ in .ok(status: 401, body: #"{"code":"license_stale"}"#) }
        let (backend, state) = try make()
        let (_, response) = try await backend.data(for: get("https://api.example.com/x"))
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 401, "the backend's own answer")
        XCTAssertEqual(state.syncs, [true])
        XCTAssertEqual(BackendStub.urls.count, 2, "one retry, never two")
    }

    func testInvalidRetriesAndSucceeds() async throws {
        let calls = LockedValue(0)
        BackendStub.reset { _ in
            calls.with { $0 += 1 }
            return calls.current == 1 ? .ok(status: 401, body: #"{"code":"license_invalid"}"#) : .ok(status: 200, body: "yes")
        }
        let (backend, _) = try make()
        let (data, _) = try await backend.data(for: get("https://api.example.com/x"))
        XCTAssertEqual(String(decoding: data, as: UTF8.self), "yes")
    }

    func testAFailedSyncReturnsTheBackendsResponse() async throws {
        BackendStub.reset { _ in .ok(status: 401, body: #"{"code":"license_stale"}"#) }
        let state = State()
        state.syncOK = false
        let (backend, _) = try make(state: state)
        let (_, response) = try await backend.data(for: get("https://api.example.com/x"))
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 401)
        XCTAssertEqual(BackendStub.urls.count, 1, "no retry without a fresh document")
    }

    func testForcedSyncsAreTenSecondsApart() async throws {
        BackendStub.reset { _ in .ok(status: 401, body: #"{"code":"license_stale"}"#) }
        let (backend, state) = try make()
        for _ in 0..<3 { _ = try await backend.data(for: get("https://api.example.com/x")) }
        XCTAssertEqual(state.syncs, [true], "later calls within 10 s do not sync")
        state.setClock(10)
        _ = try await backend.data(for: get("https://api.example.com/x"))
        XCTAssertEqual(state.syncs, [true, true])
    }

    func testNotEntitledAndSignInRequiredThrowTypedAndAreNeverRetried() async throws {
        for code in ["not_entitled", "sign_in_required"] {
            BackendStub.reset { _ in .ok(status: 403, body: #"{"code":"\#(code)"}"#) }
            let (backend, state) = try make()
            do {
                _ = try await backend.data(for: get("https://api.example.com/x"))
                XCTFail(code)
            } catch let e as PolarisError {
                XCTAssertEqual(e.code, code)
                XCTAssertEqual(e.message, ErrorCopy.message(code))
            }
            XCTAssertEqual(BackendStub.urls.count, 1, code)
            XCTAssertEqual(state.syncs, [], code)
        }
    }

    func testLicenseRequiredIsSurfacedNotRetried() async throws {
        BackendStub.reset { _ in .ok(status: 401, body: #"{"code":"license_required"}"#) }
        let (backend, state) = try make()
        let (_, response) = try await backend.data(for: get("https://api.example.com/x"))
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 401)
        XCTAssertEqual(state.syncs, [])
    }

    // ── Through the client ───────────────────────────────────────────────────────────

    func testClientBackendHoldsTheCachedLicenceAndRefusesOtherOrigins() async throws {
        let signer = TestSigner(kid: "backend-key")
        let t = Int(Date().timeIntervalSince1970)
        let store = InMemoryStore(deviceId: "dev")
        let jws = signer.sign(Fixtures.license(licenseId: "lic_b", issuedAt: t))
        await store.writeCache(CacheRecord(docs: [.license: jws]))
        let c = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: signer.trust, trustRefresh: false, store: store,
                transport: NoNetworkTransport(), expectedServices: [.license], fingerprint: false,
                backendOrigins: ["https://api.example.com"]))
        let h = try await c.backend.headers()
        XCTAssertEqual(h["X-PKey-License"], jws)
        XCTAssertEqual(h["X-PKey-Device"], "dev")
        XCTAssertNil(h["X-PKey-Token"])
        XCTAssertEqual(c.backend.origins, ["https://api.example.com"])
        do {
            _ = try await c.backend.data(for: URLRequest(url: URL(string: "https://other.example/x")!))
            XCTFail("sent")
        } catch let e as PolarisError { XCTAssertEqual(e.code, "backend-origin-not-allowed") }
    }

    func testBadOriginsFailTheConstructor() async throws {
        do {
            _ = try await PolarisKeyClient.create(
                options: PolarisKeyClientOptions(
                    productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                    pinnedKeys: [:], trustRefresh: false, store: InMemoryStore(deviceId: "dev"),
                    transport: NoNetworkTransport(), backendOrigins: ["http://api.example.com"]))
            XCTFail("accepted")
        } catch let e as PolarisError { XCTAssertEqual(e.code, "invalid-options") }
    }
}
