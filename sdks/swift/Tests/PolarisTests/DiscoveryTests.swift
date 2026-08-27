// Discovery + capability resolution — D-21's fail-closed rules.
//
// Almost everything here is a PARSE test rather than a fetch test, and that is the point: the
// interesting cases are all malformed documents, and none of them need a socket. The one thing
// the fetch adds is that discovery is a NETWORK read, which is why an unreachable control plane
// must fall back to the host's stated expectation rather than to "no services".

import Foundation
import Polaris
import PolarisCore
import XCTest

final class DiscoveryTests: XCTestCase {
    private var server = StubServer()
    private let path = "/djdl/.well-known/polaris.json"

    override func setUp() {
        super.setUp()
        server = StubServer()
    }

    private func parse(_ json: String, product: String = "djdl") -> DiscoveryResult {
        Discovery.parse(Data(json.utf8), expectedProduct: product)
    }

    private func document(_ result: DiscoveryResult) -> ProductDiscoveryDocument? {
        guard case .ok(let doc) = result else { return nil }
        return doc
    }

    /// The shape the Worker actually emits, reduced to what the SDK consumes.
    private let full = #"""
        {
          "version": 2, "protocolVersion": 3, "product": "djdl", "slug": "djdl",
          "name": "DJDL", "baseUrl": "https://key.example",
          "core": {
            "registration": "open",
            "compat": { "min": "1.0.0", "max": "3.0.0" },
            "endpoints": { "register": "https://key.example/djdl/devices/register" }
          },
          "trust": {
            "jwksUrl": "https://key.example/djdl/.well-known/jwks.json",
            "trustManifestUrl": "https://key.example/djdl/.well-known/polaris-trust.jws",
            "pinnedKeys": { "kid-1": "AAA" }
          },
          "services": {
            "license": { "enabled": true, "endpoints": { "document": "https://key.example/djdl/license/document" } },
            "config": { "enabled": true, "schemaVersion": 4, "endpoints": {} },
            "release": { "enabled": false },
            "update": {
              "enabled": true,
              "channels": ["stable", "beta"],
              "sparkleEd25519PublicKey": "abc",
              "endpoints": {
                "version": "https://key.example/djdl/update/version",
                "appcast": "https://key.example/djdl/update/appcast.xml",
                "channelAppcast": "https://key.example/djdl/update/{channel}/appcast.xml"
              },
              "archParameter": ["arm64", "x86_64"]
            },
            "identity": { "enabled": false }
          }
        }
        """#

    func testParsesTheFullDocument() throws {
        guard let doc = document(parse(full)) else { return XCTFail("should parse") }
        XCTAssertEqual(doc.product, "djdl")
        XCTAssertEqual(doc.name, "DJDL")
        XCTAssertEqual(doc.protocolVersion, 3)
        XCTAssertEqual(doc.core?.registration, .open)
        XCTAssertEqual(doc.core?.compatMin, "1.0.0")
        XCTAssertEqual(doc.core?.compatMax, "3.0.0")
        XCTAssertEqual(doc.trust?.pinnedKeys, ["kid-1": "AAA"])
        XCTAssertEqual(
            doc.servicesMap,
            [.license: true, .config: true, .release: false, .update: true, .identity: false])
        XCTAssertEqual(
            doc.services[.license]?.endpoints["document"],
            "https://key.example/djdl/license/document")
        // Everything the SDK does not model is PRESERVED, so a product publishing richer
        // metadata is not rejected by an SDK that predates it.
        XCTAssertEqual(doc.services[.config]?.extras["schemaVersion"], .int(4))
        XCTAssertEqual(
            doc.services[.update]?.extras["channels"],
            .array([.string("stable"), .string("beta")]))
    }

    /// A disabled service publishes `{"enabled": false}` and NOTHING ELSE — there is no endpoint
    /// list to read a disabled service's shape out of.
    func testDisabledServiceCarriesNoEndpoints() throws {
        guard let doc = document(parse(full)) else { return XCTFail("should parse") }
        XCTAssertEqual(doc.services[.release], ServiceFragment.disabled)
        XCTAssertTrue(doc.services[.release]!.endpoints.isEmpty)
    }

    /// D-21 — an OMITTED slug reads as disabled, never as "unknown, assume on".
    func testOmittedServiceReadsAsDisabled() throws {
        let json = #"{"product":"djdl","services":{"license":{"enabled":true}}}"#
        guard let doc = document(parse(json)) else { return XCTFail("should parse") }
        XCTAssertEqual(
            doc.servicesMap,
            [.license: true, .config: false, .release: false, .update: false, .identity: false])
    }

    /// `enabled` must be a real BOOLEAN. A truthy string ("false"!) reading as on is the classic
    /// version of this bug.
    func testTruthyStringDoesNotEnableAService() throws {
        let json = #"{"product":"djdl","services":{"license":{"enabled":"false"},"config":{"enabled":1}}}"#
        guard let doc = document(parse(json)) else { return XCTFail("should parse") }
        XCTAssertEqual(doc.servicesMap[.license], false)
        XCTAssertEqual(doc.servicesMap[.config], false)
    }

    /// A MALFORMED `services` value is a REJECTED document, not "assume defaults": silently
    /// substituting the permissive default is exactly how a fail-closed gate becomes fail-open.
    func testMalformedDocumentsAreRejectedRatherThanDefaulted() {
        for (label, json) in [
            ("not an object", "[]"),
            ("no product", #"{"services":{}}"#),
            ("services missing", #"{"product":"djdl"}"#),
            ("services not an object", #"{"product":"djdl","services":[]}"#),
            ("fragment not an object", #"{"product":"djdl","services":{"license":true}}"#),
        ] {
            guard case .invalid = parse(json) else {
                return XCTFail("\(label) must be rejected")
            }
        }
    }

    /// A document for ANOTHER product is not a document this client may act on.
    func testProductMismatchIsRejected() {
        guard case .invalid(let message) = parse(full, product: "other") else {
            return XCTFail("a mismatched product must be rejected")
        }
        XCTAssertTrue(message.contains("djdl"))
    }

    // ── Capability resolution (D-21) ─────────────────────────────────────────────────
    private func core(
        expected: [ServiceSlug]? = nil, transport: any PolarisTransport
    ) throws -> CoreContext {
        try CoreContext(
            options: CoreOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], store: InMemoryStore(deviceId: "dev"), transport: transport,
                expectedServices: expected))
    }

    /// The precedence: a discovery document loaded this session > `expectedServices` > the suite
    /// default (license + config; release/update/identity OFF).
    func testCapabilityPrecedence() async throws {
        let suiteDefault = try core(transport: ExplodingTransport())
        let defaultMap = await suiteDefault.services()
        XCTAssertEqual(defaultMap, DEFAULT_SERVICES)
        let licenseByDefault = await suiteDefault.enabled(.license)
        XCTAssertTrue(licenseByDefault)
        let updateOff = await suiteDefault.enabled(.update)
        XCTAssertFalse(
            updateOff, "the genuinely new surfaces are off until something says otherwise")

        let expected = try core(expected: [.config, .update], transport: ExplodingTransport())
        let expectedMap = await expected.services()
        XCTAssertEqual(expectedMap, servicesFromList([.config, .update]))
        let licenseUnexpected = await expected.enabled(.license)
        XCTAssertFalse(licenseUnexpected)

        await server.reply(path, body: full)
        let discovered = try core(expected: [.config], transport: server.transport)
        try await discovered.start()
        _ = await discovered.discover()
        let licenseOn = await discovered.enabled(.license)
        XCTAssertTrue(licenseOn, "a loaded document wins over the stated expectation")
        let releaseOff = await discovered.enabled(.release)
        XCTAssertFalse(releaseOff)
    }

    /// Discovery is a NETWORK read, so an unreachable control plane must leave the client on its
    /// stated expectation — never on "this product has no services".
    func testFailedDiscoveryKeepsTheConfiguredExpectation() async throws {
        let c = try core(expected: [.license], transport: ExplodingTransport())
        try await c.start()
        let result = await c.discover()
        guard case .error = result else { return XCTFail("expected .error, got \(result)") }
        let afterFailure = await c.services()
        XCTAssertEqual(afterFailure, servicesFromList([.license]))
    }

    func test404IsNotFound() async throws {
        await server.reply(path, status: 404, body: "")
        let c = try core(transport: server.transport)
        try await c.start()
        guard case .notFound = await c.discover() else { return XCTFail("expected .notFound") }
    }

    /// A sub-client whose service the product does not run REFUSES (D-21), and says which.
    func testRequireServiceRefusesADisabledService() async throws {
        let c = try core(expected: [.config], transport: ExplodingTransport())
        do {
            try await c.requireService(.update)
            XCTFail("a disabled service must refuse")
        } catch let error as PolarisError {
            XCTAssertEqual(error.code, PolarisError.serviceUnavailable)
            XCTAssertTrue(error.message.contains("update"))
        }
        try await c.requireService(.config)
    }
}
