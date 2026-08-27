// The signed-document fetch layer — `CoreContext.getDocument`'s status taxonomy (§5), exercised
// against the stub transport so no network is touched.
//
// The heir to `FetchTests`. One ladder now serves BOTH documents, which is the point: v2 had a
// `/config` reader and would have grown a second one for `/license`, and the two would eventually
// have disagreed about what a 403 or a dropped connection means. Every assertion below is
// therefore run against both slices.
//
//   200 → .ok(jws, etag) · 304 → .notModified · 401 → .unauthorized ·
//   429 → .deviceCap · 403 → .blocked(reason, allowedRange) · other → .error

import Foundation
import PolarisKeyConfig
import PolarisKeyCore
import XCTest

final class DocumentFetchTests: XCTestCase {
    private var server = StubServer()

    override func setUp() {
        super.setUp()
        server = StubServer()
    }

    private func core(timeout: Double = 15) throws -> CoreContext {
        try CoreContext(
            options: CoreOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], store: InMemoryStore(deviceId: "dev_1"),
                transport: server.transport, requestTimeoutSeconds: timeout))
    }

    private func path(_ slice: DocumentSlice) -> String {
        slice == .license ? "/djdl/license/document" : "/djdl/config/document"
    }

    private func fetch(
        _ slice: DocumentSlice, status: Int, body: String = "", headers: [String: String] = [:],
        etag: String? = nil
    ) async throws -> DocumentResult {
        await server.route(path(slice)) { _ in
            StubServer.Reply(status: status, body: body, headers: headers)
        }
        let core = try core()
        try await core.start()
        return await core.getDocument(slice, token: "pkeyt_tok", etag: etag)
    }

    func test200ReturnsOkWithJwsAndEtag() async throws {
        for slice in DocumentSlice.allCases {
            let r = try await fetch(slice, status: 200, body: "a.b.c", headers: ["ETag": "v7"])
            guard case let .ok(jws, etag) = r else {
                return XCTFail("\(slice): expected .ok, got \(r)")
            }
            XCTAssertEqual(jws, "a.b.c")
            XCTAssertEqual(etag, "v7")
        }
    }

    /// HTTP header names are case-insensitive, and a real server, a proxy and a stub all spell
    /// `ETag` differently. Reading it case-insensitively is what keeps a working client from
    /// re-downloading every document forever.
    func testEtagIsReadCaseInsensitively() async throws {
        let r = try await fetch(.license, status: 200, body: "a.b.c", headers: ["etag": "v9"])
        guard case let .ok(_, etag) = r else { return XCTFail("expected .ok, got \(r)") }
        XCTAssertEqual(etag, "v9")
    }

    func test200SendsAuthAndClientMetadataHeaders() async throws {
        _ = try await fetch(.license, status: 200, body: "x.y.z", etag: "v1")
        let req = await server.requests(forPath: path(.license)).last
        XCTAssertEqual(req?.headers["authorization"], "Bearer pkeyt_tok")
        XCTAssertEqual(req?.headers[HEADER_DEVICE], "dev_1")
        XCTAssertEqual(req?.headers[HEADER_VERSION], "1.0.0")
        XCTAssertEqual(req?.headers[HEADER_CHANNEL], "stable")
        XCTAssertEqual(req?.headers[HEADER_SDK_NAME], POLARIS_SDK_NAME)
        XCTAssertEqual(req?.headers["if-none-match"], "v1")
    }

    func test304NotModified() async throws {
        for slice in DocumentSlice.allCases {
            let r = try await fetch(slice, status: 304, etag: "v1")
            guard case .notModified = r else {
                return XCTFail("\(slice): expected .notModified, got \(r)")
            }
        }
    }

    func test401Unauthorized() async throws {
        for slice in DocumentSlice.allCases {
            let r = try await fetch(slice, status: 401)
            guard case .unauthorized = r else {
                return XCTFail("\(slice): expected .unauthorized, got \(r)")
            }
        }
    }

    func test429DeviceCapParsesBody() async throws {
        let r = try await fetch(
            .license, status: 429, body: #"{"limit":3,"deviceCount":5}"#)
        guard case let .deviceCap(limit, deviceCount) = r else {
            return XCTFail("expected .deviceCap, got \(r)")
        }
        XCTAssertEqual(limit, 3)
        XCTAssertEqual(deviceCount, 5)
    }

    /// §5's 403 body: the machine-readable code is NESTED and `allowedRange` rides at the TOP
    /// level. `reason` disambiguates too-old from too-new inside the error object.
    func test403BlockedParsesTheNestedV3Shape() async throws {
        let r = try await fetch(
            .license, status: 403,
            body: #"""
                {"error":{"code":"version_blocked","reason":"version-too-new"},
                 "allowedRange":{"min":"1.0.0","max":"1.5.0"}}
                """#)
        guard case let .blocked(reason, range) = r else {
            return XCTFail("expected .blocked, got \(r)")
        }
        XCTAssertEqual(reason, .versionTooNew)
        XCTAssertEqual(range?.min, "1.0.0")
        XCTAssertEqual(range?.max, "1.5.0")
    }

    /// A channel refusal carries a code and NO range — the server has no version window to offer.
    func test403ChannelRefusalIsDerivedFromTheCodeAlone() async throws {
        let r = try await fetch(
            .license, status: 403, body: #"{"error":{"code":"channel_not_allowed"}}"#)
        guard case let .blocked(reason, range) = r else {
            return XCTFail("expected .blocked, got \(r)")
        }
        XCTAssertEqual(reason, .channelNotEntitled)
        XCTAssertNil(range)
    }

    /// A body that says nothing at all falls back to the STRICTER reading. Guessing the
    /// permissive one would turn an unparseable refusal into a running application.
    func test403BlockedDefaultsToTheStricterReasonWhenBodyIsEmpty() async throws {
        let r = try await fetch(.license, status: 403, body: "{}")
        guard case let .blocked(reason, range) = r else {
            return XCTFail("expected .blocked, got \(r)")
        }
        XCTAssertEqual(reason, .versionTooOld)
        XCTAssertNil(range)
    }

    func test500MapsToErrorWithStatusAndBody() async throws {
        let r = try await fetch(.license, status: 500, body: "boom")
        guard case let .error(status, message) = r else {
            return XCTFail("expected .error, got \(r)")
        }
        XCTAssertEqual(status, 500)
        XCTAssertEqual(message, "boom")
    }

    /// A transport failure is `.error(status: 0)`, never a throw: `sync()` treats an unreachable
    /// control plane as "nothing applied", not as a crash.
    func testTransportFailureIsErrorStatusZero() async throws {
        let core = try CoreContext(
            options: CoreOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], store: InMemoryStore(deviceId: "d"),
                transport: ExplodingTransport()))
        try await core.start()
        let r = await core.getDocument(.license, token: "pkeyt_t")
        guard case let .error(status, _) = r else { return XCTFail("expected .error, got \(r)") }
        XCTAssertEqual(status, 0)
    }

    /// The §R1 canonical paths, asserted rather than assumed — this is the table that moved.
    func testCanonicalRoutes() throws {
        let e = try Endpoints(baseUrl: "https://key.example/", product: "djdl")
        XCTAssertEqual(e.baseUrl, "https://key.example", "trailing slashes are stripped")
        XCTAssertEqual(
            e.discovery.absoluteString, "https://key.example/djdl/.well-known/polaris.json")
        XCTAssertEqual(
            e.trustManifest.absoluteString,
            "https://key.example/djdl/.well-known/polaris-trust.jws")
        XCTAssertEqual(
            e.licenseDocument.absoluteString, "https://key.example/djdl/license/document")
        XCTAssertEqual(
            e.configDocument.absoluteString, "https://key.example/djdl/config/document")
        XCTAssertEqual(
            e.licenseActivate.absoluteString, "https://key.example/djdl/license/activate")
        XCTAssertEqual(e.licenseEnroll.absoluteString, "https://key.example/djdl/license/enroll")
        XCTAssertEqual(e.licenseToken.absoluteString, "https://key.example/djdl/license/token")
        XCTAssertEqual(
            e.licenseDeauthorize.absoluteString,
            "https://key.example/djdl/license/deauthorize")
        XCTAssertEqual(
            e.devicesRegister.absoluteString, "https://key.example/djdl/devices/register")
        XCTAssertEqual(e.devicesReport.absoluteString, "https://key.example/djdl/devices/report")
        XCTAssertEqual(e.devices.absoluteString, "https://key.example/djdl/devices")
        XCTAssertEqual(
            e.device("a/b").absoluteString, "https://key.example/djdl/devices/a%2Fb",
            "a device id is escaped into ONE path segment")
        XCTAssertEqual(
            e.updateAppcast.absoluteString, "https://key.example/djdl/update/appcast.xml")
        XCTAssertEqual(
            e.updateAppcast(channel: "beta").absoluteString,
            "https://key.example/djdl/update/beta/appcast.xml")
        XCTAssertEqual(e.updateVersion.absoluteString, "https://key.example/djdl/update/version")
        XCTAssertEqual(e.document(.license), e.licenseDocument)
        XCTAssertEqual(e.document(.config), e.configDocument)
    }
}
