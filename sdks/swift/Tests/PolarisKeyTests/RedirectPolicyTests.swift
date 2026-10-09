// @pkey-feature core.sync
// The redirect rule for product-scoped calls (WIRE-CONTRACT-V4 §5) and the ephemeral session.

import Foundation
import XCTest

@testable import PolarisKeyCore

final class RedirectPolicyTests: XCTestCase {
    private func request(
        _ url: String, method: String = "GET",
        headers: [String: String] = ["Authorization": "Bearer pkeyt_x", "X-PKey-Device": "d", "Accept": "a"]
    ) -> URLRequest {
        var r = URLRequest(url: URL(string: url)!)
        r.httpMethod = method
        for (k, v) in headers { r.setValue(v, forHTTPHeaderField: k) }
        return r
    }

    func testSameOriginKeepsTheHeaders() {
        let from = request("https://key.example/a")
        guard case .follow(let next) = RedirectPolicy.decide(
            from: from, status: 302, next: request("https://key.example/b"), hops: 0)
        else { return XCTFail("expected follow") }
        XCTAssertEqual(next.value(forHTTPHeaderField: "Authorization"), "Bearer pkeyt_x")
        XCTAssertEqual(next.value(forHTTPHeaderField: "X-PKey-Device"), "d")
    }

    func testCrossOriginDropsAuthorizationAndEveryPKeyHeader() {
        let from = request("https://key.example/a")
        guard case .follow(let next) = RedirectPolicy.decide(
            from: from, status: 302, next: request("https://cdn.example/b"), hops: 0)
        else { return XCTFail("expected follow") }
        XCTAssertNil(next.value(forHTTPHeaderField: "Authorization"))
        XCTAssertNil(next.value(forHTTPHeaderField: "X-PKey-Device"))
        XCTAssertEqual(next.value(forHTTPHeaderField: "Accept"), "a", "other headers stay")
    }

    func testHttpsToHttpIsRefused() {
        let from = request("https://key.example/a")
        XCTAssertEqual(
            RedirectPolicy.decide(from: from, status: 302, next: request("http://key.example/b"), hops: 0),
            .refuse(code: "insecure-redirect"))
    }

    func testCrossOrigin307OnAPostIsRefusedAndOn303ItIsFollowedAsGet() {
        let post = request("https://key.example/a", method: "POST")
        XCTAssertEqual(
            RedirectPolicy.decide(
                from: post, status: 307, next: request("https://evil.example/b", method: "POST"), hops: 0),
            .refuse(code: "insecure-redirect"))
        XCTAssertEqual(
            RedirectPolicy.decide(
                from: post, status: 308, next: request("https://evil.example/b", method: "POST"), hops: 0),
            .refuse(code: "insecure-redirect"))
        guard case .follow(let next) = RedirectPolicy.decide(
            from: post, status: 303, next: request("https://cdn.example/b"), hops: 0)
        else { return XCTFail("a 303 becomes a GET and is followed") }
        XCTAssertNil(next.value(forHTTPHeaderField: "Authorization"))
    }

    func testMoreThanFiveHopsIsRefused() {
        let from = request("https://key.example/a")
        let next = request("https://key.example/b")
        XCTAssertNotEqual(
            RedirectPolicy.decide(from: from, status: 302, next: next, hops: 4),
            .refuse(code: "too-many-redirects"))
        XCTAssertEqual(
            RedirectPolicy.decide(from: from, status: 302, next: next, hops: 5),
            .refuse(code: "too-many-redirects"))
    }

    func testTheDefaultSessionIsEphemeral() {
        let configuration = URLSessionTransport.makeSession().configuration
        XCTAssertNil(configuration.urlCache)
        XCTAssertFalse(configuration.httpShouldSetCookies)
    }
}

/// End to end through a real `URLSession`: a protocol that redirects every request, so the
/// delegate's verdict is what the caller sees.
final class RedirectEndToEndTests: XCTestCase {
    final class Redirecting: URLProtocol, @unchecked Sendable {
        nonisolated(unsafe) static var seen: [URLRequest] = []
        nonisolated(unsafe) static var location: (URL) -> URL? = { _ in nil }
        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func startLoading() {
            Self.seen.append(request)
            let url = request.url!
            if let to = Self.location(url) {
                let response = HTTPURLResponse(
                    url: url, statusCode: 302, httpVersion: nil, headerFields: ["Location": to.absoluteString])!
                var next = URLRequest(url: to)
                next.httpMethod = request.httpMethod
                next.allHTTPHeaderFields = request.allHTTPHeaderFields
                client?.urlProtocol(self, wasRedirectedTo: next, redirectResponse: response)
                // Like the HTTP protocol: when the delegate declines the redirect, the 3xx
                // response itself is what the task completes with.
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocolDidFinishLoading(self)
            } else {
                let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: [:])!
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(self, didLoad: Data("ok".utf8))
                client?.urlProtocolDidFinishLoading(self)
            }
        }
        override func stopLoading() {}
    }

    private func transport() -> URLSessionTransport {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [Redirecting.self]
        return URLSessionTransport(session: URLSession(configuration: configuration))
    }

    func testACrossOriginRedirectIsFollowedWithoutTheCredential() async throws {
        Redirecting.seen = []
        Redirecting.location = { $0.host == "key.example" ? URL(string: "https://cdn.example/x") : nil }
        let response = try await transport().send(
            PolarisRequest(
                url: URL(string: "https://key.example/a")!,
                headers: ["authorization": "Bearer pkeyt_x", "x-pkey-device": "d"]))
        XCTAssertEqual(response.status, 200)
        let last = try XCTUnwrap(Redirecting.seen.last)
        XCTAssertEqual(last.url?.host, "cdn.example")
        XCTAssertNil(last.value(forHTTPHeaderField: "Authorization"))
        XCTAssertNil(last.value(forHTTPHeaderField: "x-pkey-device"))
    }

    func testADowngradeAndALoopAreThrownAsTypedErrors() async throws {
        Redirecting.seen = []
        Redirecting.location = { _ in URL(string: "http://key.example/x") }
        do {
            _ = try await transport().send(PolarisRequest(url: URL(string: "https://key.example/a")!))
            XCTFail("a downgrade must throw")
        } catch let error as PolarisError {
            XCTAssertEqual(error.code, "insecure-redirect")
        }
        Redirecting.location = { _ in URL(string: "https://key.example/loop") }
        do {
            _ = try await transport().send(PolarisRequest(url: URL(string: "https://key.example/a")!))
            XCTFail("a loop must throw")
        } catch let error as PolarisError {
            XCTAssertEqual(error.code, "too-many-redirects")
        }
    }
}
