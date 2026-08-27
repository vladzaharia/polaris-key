// Fetch layer tests — exercise `fetchManagedConfig`'s status taxonomy against a mocked
// URLProtocol so no network is touched. The mock lets each test stub the HTTP status,
// body, and headers the Worker would return, asserting the FetchResult mapping:
// 200→.ok(jws,etag) / 304→.notModified / 401→.unauthorized / 429→.deviceCap /
// 403→.blocked / other→.error.

import Foundation
import XCTest

@testable import PolarisKey

/// A process-wide URLProtocol that returns a queued stub for the next request. Tests set
/// `MockURLProtocol.handler` to shape the response; it also captures the outgoing request
/// so header assertions are possible.
final class MockURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) -> (HTTPURLResponse, Data))?
    nonisolated(unsafe) static var lastRequest: URLRequest?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        MockURLProtocol.lastRequest = request
        guard let handler = MockURLProtocol.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        let (response, data) = handler(request)
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class FetchTests: XCTestCase {
    private func mockSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return URLSession(configuration: config)
    }

    private func opts(etag: String? = nil) -> FetchOptions {
        FetchOptions(
            baseUrl: "https://key.example", product: "djdl", token: "tok",
            deviceId: "dev_1", version: "1.0.0", channel: "stable", etag: etag)
    }

    private func respond(
        _ status: Int, body: String = "", headers: [String: String] = [:]
    ) {
        MockURLProtocol.handler = { req in
            let resp = HTTPURLResponse(
                url: req.url!, statusCode: status, httpVersion: "HTTP/1.1",
                headerFields: headers)!
            return (resp, Data(body.utf8))
        }
    }

    override func tearDown() {
        MockURLProtocol.handler = nil
        MockURLProtocol.lastRequest = nil
        super.tearDown()
    }

    func test200ReturnsOkWithJwsAndEtag() async {
        respond(200, body: "a.b.c", headers: ["ETag": "v7"])
        let r = await fetchManagedConfig(opts(), session: mockSession())
        guard case let .ok(jws, etag) = r else { return XCTFail("expected .ok, got \(r)") }
        XCTAssertEqual(jws, "a.b.c")
        XCTAssertEqual(etag, "v7")
    }

    func test200SetsAuthAndPKeyHeaders() async {
        respond(200, body: "x.y.z")
        _ = await fetchManagedConfig(opts(etag: "v1"), session: mockSession())
        let req = MockURLProtocol.lastRequest
        XCTAssertEqual(req?.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertEqual(req?.value(forHTTPHeaderField: HEADER_DEVICE), "dev_1")
        XCTAssertEqual(req?.value(forHTTPHeaderField: HEADER_VERSION), "1.0.0")
        XCTAssertEqual(req?.value(forHTTPHeaderField: HEADER_CHANNEL), "stable")
        XCTAssertEqual(req?.value(forHTTPHeaderField: "If-None-Match"), "v1")
    }

    func test304NotModified() async {
        respond(304)
        let r = await fetchManagedConfig(opts(etag: "v1"), session: mockSession())
        guard case .notModified = r else { return XCTFail("expected .notModified, got \(r)") }
    }

    func test401Unauthorized() async {
        respond(401)
        let r = await fetchManagedConfig(opts(), session: mockSession())
        guard case .unauthorized = r else { return XCTFail("expected .unauthorized, got \(r)") }
    }

    func test429DeviceCapParsesBody() async {
        respond(429, body: #"{"limit":3,"deviceCount":5}"#)
        let r = await fetchManagedConfig(opts(), session: mockSession())
        guard case let .deviceCap(limit, deviceCount) = r else {
            return XCTFail("expected .deviceCap, got \(r)")
        }
        XCTAssertEqual(limit, 3)
        XCTAssertEqual(deviceCount, 5)
    }

    func test403BlockedParsesReasonAndRange() async {
        respond(403, body: #"{"reason":"version-too-new","allowedRange":{"max":"1.5.0"}}"#)
        let r = await fetchManagedConfig(opts(), session: mockSession())
        guard case let .blocked(reason, range) = r else {
            return XCTFail("expected .blocked, got \(r)")
        }
        XCTAssertEqual(reason, .versionTooNew)
        XCTAssertEqual(range?.max, "1.5.0")
    }

    func test403BlockedDefaultsReasonWhenBodyEmpty() async {
        respond(403, body: "{}")
        let r = await fetchManagedConfig(opts(), session: mockSession())
        guard case let .blocked(reason, range) = r else {
            return XCTFail("expected .blocked, got \(r)")
        }
        XCTAssertEqual(reason, .versionTooOld)
        XCTAssertNil(range)
    }

    func test500MapsToErrorWithStatusAndBody() async {
        respond(500, body: "boom")
        let r = await fetchManagedConfig(opts(), session: mockSession())
        guard case let .error(status, message) = r else {
            return XCTFail("expected .error, got \(r)")
        }
        XCTAssertEqual(status, 500)
        XCTAssertEqual(message, "boom")
    }

    func testInvalidBaseUrlIsError() async {
        let bad = FetchOptions(
            baseUrl: "ht tp://no", product: "djdl", token: "t", deviceId: "d",
            version: "1", channel: "stable")
        let r = await fetchManagedConfig(bad, session: mockSession())
        guard case let .error(status, _) = r else { return XCTFail("expected .error, got \(r)") }
        XCTAssertEqual(status, 0)
    }
}
