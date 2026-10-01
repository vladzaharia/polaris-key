// Surfaces the parity registry lists as implemented in Swift that had no test naming them:
// keyless enrolment, the licence reads (entitlements, profile, licence id), and the catalog
// fetch. Each is small, but "implemented" now has to point at a test (PARITY §3.2), so each gets
// one here rather than being inferred from a neighbour.

import Foundation
import PolarisKey
import PolarisKeyConfig
import PolarisKeyCore
import PolarisKeyLicense
import XCTest

final class LicenseSurfaceTests: XCTestCase {
    private var server = StubServer()

    override func setUp() {
        super.setUp()
        server = StubServer()
    }

    // @pkey-feature license.enroll
    /// `POST /<p>/license/enroll` needs no key: the device's own identity is the request, and a
    /// success stores the per-device token exactly as a key activation does.
    func testEnrollMintsAndStoresATokenWithNoKey() async throws {
        await server.reply(
            "/djdl/license/enroll", body: #"{"token":"pkeyt_enrolled","schemaVersion":2}"#)
        let store = InMemoryStore(deviceId: "dev")
        let c = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], trustRefresh: false, store: store, transport: server.transport,
                expectedServices: [.license], fingerprint: false))

        let result = await c.enroll()
        XCTAssertEqual(result, .ok(token: "pkeyt_enrolled", schemaVersion: 2))
        let stored = await store.getToken()
        XCTAssertEqual(stored, "pkeyt_enrolled")

        let request = await server.requests(forPath: "/djdl/license/enroll").last
        XCTAssertEqual(request?.method, "POST")
        XCTAssertNil(request?.headers["authorization"], "enrolment carries no licence key")
    }

    // @pkey-feature license.enroll
    /// A product that offers no free tier answers 404, which is its own outcome rather than a
    /// generic failure, and nothing is stored.
    func testEnrollOnAProductWithoutAFreeTierIsEnrollDisabled() async throws {
        await server.reply("/djdl/license/enroll", status: 404, body: "{}")
        let store = InMemoryStore(deviceId: "dev")
        let c = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], trustRefresh: false, store: store, transport: server.transport,
                expectedServices: [.license], fingerprint: false))

        let result = await c.enroll()
        XCTAssertEqual(result, .enrollDisabled)
        let stored = await store.getToken()
        XCTAssertNil(stored)
    }

    // @pkey-feature license.entitlements
    /// Entitlements, the signed profile and the licence id are all read off the VERIFIED licence
    /// document, and an absent document reads as empty rather than as a failure.
    func testEntitlementsProfileAndLicenceIdComeFromTheVerifiedDocument() async throws {
        let signer = TestSigner(kid: "surface-key")
        let t = Int(Date().timeIntervalSince1970)
        let store = InMemoryStore(deviceId: "dev")
        await store.setToken("pkeyt_test")
        await store.writeCache(
            CacheRecord(docs: [
                .license: signer.sign(
                    Fixtures.license(
                        licenseId: "lic_surface", issuedAt: t,
                        entitlements: [
                            "pro": Fixtures.entry(.bool(true), .enforced),
                            "seats": Fixtures.entry(.int(3), .enforced),
                        ]))
            ]))
        let c = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: signer.trust, trustRefresh: false, store: store,
                transport: ExplodingTransport(), expectedServices: [.license]))

        let entitlements = await c.license.entitlements()
        XCTAssertEqual(entitlements["pro"], .bool(true))
        XCTAssertEqual(entitlements["seats"], .int(3))
        let pro = await c.license.isEntitled("pro")
        XCTAssertTrue(pro)
        let absent = await c.license.isEntitled("enterprise")
        XCTAssertFalse(absent)
        let profile = await c.license.profile()
        XCTAssertEqual(profile?.email, "a@e.com")
        let licenseId = await c.license.licenseId()
        XCTAssertEqual(licenseId, "lic_surface")

        let empty = try await PolarisKeyClient.createLocal(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], store: InMemoryStore(deviceId: "dev")))
        let none = await empty.license.entitlements()
        XCTAssertTrue(none.isEmpty)
        let noId = await empty.license.licenseId()
        XCTAssertNil(noId)
    }

    // @pkey-feature config.schema
    /// `GET /<p>/config/schema` is unsigned and diagnostic: the body comes back as-is on 200, and
    /// any failure is `nil`, never a throw.
    func testFetchSchemaReturnsTheCatalogOrNil() async throws {
        await server.reply(
            "/djdl/config/schema", body: #"{"schemaVersion":3,"entries":[]}"#)
        let core = try CoreContext(
            options: CoreOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], store: InMemoryStore(deviceId: "dev"),
                transport: server.transport))
        try await core.start()

        let body = await ConfigEndpoints.fetchSchema(core)
        let decoded = try JSONSerialization.jsonObject(with: XCTUnwrap(body)) as? [String: Any]
        XCTAssertEqual(decoded?["schemaVersion"] as? Int, 3)
        let request = await server.requests(forPath: "/djdl/config/schema").last
        XCTAssertEqual(request?.method, "GET")
        XCTAssertNil(request?.headers["authorization"], "the catalog is unauthenticated")

        server = StubServer()
        await server.reply("/djdl/config/schema", status: 500, body: "{}")
        let failing = try CoreContext(
            options: CoreOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], store: InMemoryStore(deviceId: "dev"),
                transport: server.transport))
        try await failing.start()
        let none = await ConfigEndpoints.fetchSchema(failing)
        XCTAssertNil(none)
    }

    // @pkey-feature config.schema
    /// The client-level `client.config.fetchSchema()` (P1b-07): a body that is not a catalog is
    /// `nil`, and a product without Config is `nil` without a request (D-21).
    func testFetchSchemaRefusesANonCatalogAndNeverProbesADisabledConfig() async throws {
        for body in ["<html>", #"{"entries":[]}"#, #"[{"schemaVersion":1,"entries":[]}]"#] {
            let server = StubServer()
            await server.reply("/djdl/config/schema", body: body)
            let c = try await PolarisKeyClient.create(
                options: PolarisKeyClientOptions(
                    productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                    pinnedKeys: [:], trustRefresh: false, store: InMemoryStore(deviceId: "dev"),
                    transport: server.transport))
            let none = await c.config.fetchSchema()
            XCTAssertNil(none, body)
        }

        let server = StubServer()
        await server.reply("/djdl/config/schema", body: #"{"schemaVersion":3,"entries":[]}"#)
        let licenseOnly = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], trustRefresh: false, store: InMemoryStore(deviceId: "dev"),
                transport: server.transport, expectedServices: [.license]))
        let disabled = await licenseOnly.config.fetchSchema()
        XCTAssertNil(disabled)
        let probes = await server.requests(forPath: "/djdl/config/schema")
        XCTAssertTrue(probes.isEmpty)
    }
}
