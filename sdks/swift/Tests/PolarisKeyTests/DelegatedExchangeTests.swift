// The delegate-carried redirect policy (`DelegatedExchange`), the path the Linux transport takes.
// On macOS it runs against a URLProtocol stub, which proves the policy and the delegate wiring;
// that swift-corelibs-foundation calls the session delegate for this task shape is not testable here.

import Foundation
import XCTest

@testable import PolarisKeyCore

final class RedirectStubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var seen: [URLRequest] = []
    nonisolated(unsafe) static var routes: [String: (status: Int, location: String?)] = [:]
    private static let lock = NSLock()

    static func reset(_ routes: [String: (status: Int, location: String?)]) {
        lock.lock()
        seen = []
        self.routes = routes
        lock.unlock()
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        Self.lock.lock()
        Self.seen.append(request)
        let route = Self.routes[request.url!.absoluteString]
        Self.lock.unlock()
        let url = request.url!
        guard let route else {
            let r = HTTPURLResponse(url: url, statusCode: 404, httpVersion: nil, headerFields: nil)!
            client?.urlProtocol(self, didReceive: r, cacheStoragePolicy: .notAllowed)
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        if let loc = route.location {
            let r = HTTPURLResponse(
                url: url, statusCode: route.status, httpVersion: nil, headerFields: ["Location": loc])!
            var next = URLRequest(url: URL(string: loc)!)
            next.httpMethod = request.httpMethod
            next.allHTTPHeaderFields = request.allHTTPHeaderFields
            client?.urlProtocol(self, wasRedirectedTo: next, redirectResponse: r)
            // A server sends the 3xx as a plain answer too; it is what a refused redirect leaves.
            client?.urlProtocol(self, didReceive: r, cacheStoragePolicy: .notAllowed)
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        let r = HTTPURLResponse(url: url, statusCode: route.status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: r, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("ok".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

final class DelegatedExchangeTests: XCTestCase {
    private let a = "https://key.example/start"
    private let b = "https://other.example/landing"

    private func configuration() -> URLSessionConfiguration {
        let c = URLSessionConfiguration.ephemeral
        c.protocolClasses = [RedirectStubProtocol.self]
        return c
    }

    private func request(_ method: String = "GET") -> URLRequest {
        var r = URLRequest(url: URL(string: a)!)
        r.httpMethod = method
        r.setValue("Bearer secret-token", forHTTPHeaderField: "Authorization")
        return r
    }

    private func hit(_ url: String) -> Bool {
        RedirectStubProtocol.seen.contains { $0.url?.absoluteString == url }
    }

    func testRefusedRedirectIsNeverSentToTheTarget() async throws {
        RedirectStubProtocol.reset([a: (307, b), b: (200, nil)])
        let policy = RedirectPolicy.Delegate(follow: true)
        _ = try? await DelegatedExchange.run(
            request("POST"), configuration: configuration(), policy: policy, limit: nil)
        XCTAssertEqual(policy.refusal?.code, PolarisError.insecureRedirect)
        XCTAssertFalse(hit(b))
    }

    func testNoFollowLeavesTheRedirectAsTheAnswer() async throws {
        RedirectStubProtocol.reset([a: (302, b), b: (200, nil)])
        let policy = RedirectPolicy.Delegate(follow: false)
        let (_, response) = try await DelegatedExchange.run(
            request(), configuration: configuration(), policy: policy, limit: nil)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 302)
        XCTAssertFalse(hit(b))
    }

    func testAFollowedCrossOriginHopCarriesNoCredential() async throws {
        RedirectStubProtocol.reset([a: (302, b), b: (200, nil)])
        let policy = RedirectPolicy.Delegate(follow: true)
        let (data, _) = try await DelegatedExchange.run(
            request(), configuration: configuration(), policy: policy, limit: nil)
        XCTAssertEqual(String(decoding: data, as: UTF8.self), "ok")
        let target = RedirectStubProtocol.seen.first { $0.url?.absoluteString == b }
        XCTAssertNotNil(target)
        XCTAssertNil(target?.value(forHTTPHeaderField: "Authorization"))
    }

    func testTheBodyIsCappedAtTheLimit() async throws {
        RedirectStubProtocol.reset([a: (200, nil)])
        let policy = RedirectPolicy.Delegate(follow: true)
        let (data, _) = try await DelegatedExchange.run(
            request(), configuration: configuration(), policy: policy, limit: 1)
        XCTAssertEqual(data.count, 1)
    }

    // The Linux path is the one that must use `DelegatedExchange`; on macOS the seam forces the
    // same call sites onto it, so a site that stops using it fails here.
    private func transport() -> URLSessionTransport {
        URLSessionTransport(session: URLSession(configuration: configuration()))
    }

    func testTransportSendUsesTheExchange() async throws {
        RedirectStubProtocol.reset([a: (200, nil)])
        DelegatedExchange.forced = true
        defer { DelegatedExchange.forced = false }
        let res = try await transport().send(PolarisRequest(url: URL(string: a)!, method: "GET"))
        XCTAssertEqual(res.status, 200)
        XCTAssertEqual(DelegatedExchange.runs, 1)
    }

    func testTransportCappedSendUsesTheExchange() async throws {
        RedirectStubProtocol.reset([a: (200, nil)])
        DelegatedExchange.forced = true
        defer { DelegatedExchange.forced = false }
        let res = try await transport().send(
            PolarisRequest(url: URL(string: a)!, method: "GET", maxBodyBytes: 1))
        XCTAssertEqual(res.body.count, 1)
        XCTAssertEqual(DelegatedExchange.runs, 1)
    }
}
