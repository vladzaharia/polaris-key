// @pkey-feature core.caps
//
// `supports()`, the typed `Unsupported` result and the `caps` report key (PARITY §2.2, P1b-10).

import Foundation
import XCTest

@testable import PolarisKey
@testable import PolarisKeyCore

final class CapabilitiesTests: XCTestCase {
    private func client(
        server: StubServer = StubServer(), expected: [ServiceSlug]? = nil,
        store: InMemoryStore = InMemoryStore(deviceId: "d")
    ) throws -> PolarisKeyClient {
        try PolarisKeyClient(
            options: PolarisKeyClientOptions(
                core: CoreOptions(
                    productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                    pinnedKeys: [:], store: store, transport: server.transport,
                    expectedServices: expected)))
    }

    private let allServices: [ServiceSlug] = ServiceSlug.allCases

    func testTheSdkTableAndDetectorsAgree() throws {
        for runtime in CAPABILITY_RUNTIMES {
            XCTAssertNoThrow(
                try Capabilities(runtime: runtime, detectors: Capabilities.sdkDetectors), runtime)
        }
        XCTAssertEqual(CAPABILITY_SDK, "swift")
        XCTAssertEqual(Set(CAPABILITIES.keys), Set(FEATURE_VALUES))
    }

    func testConfigSecretIsSupported() async throws {
        let c = try client(expected: allServices)
        let answer = await c.supports(Feature.configSecret)
        XCTAssertEqual(answer, .supported(feature: Feature.configSecret))
        XCTAssertTrue(answer.isSupported)
    }

    func testAPlannedFeatureIsVersion() async throws {
        let c = try client(expected: allServices)
        for feature in [Feature.identityOidc, Feature.packsRecord] {
            let answer = await c.supports(feature)
            XCTAssertEqual(answer.unsupported?.reason, UnsupportedReason.version, feature)
            XCTAssertEqual(answer.unsupported?.feature, feature)
        }
    }

    func testARuntimeNaIsRuntime() async throws {
        let c = try client(expected: allServices)
        let answer = await c.supports(Feature.packsTransportPlay)
        XCTAssertEqual(answer.unsupported?.reason, UnsupportedReason.runtime)
    }

    func testAnUnknownFeatureIsVersion() async throws {
        let c = try client(expected: allServices)
        let answer = await c.supports("future.feature")
        XCTAssertEqual(answer.unsupported?.reason, UnsupportedReason.version)
        XCTAssertTrue(answer.unsupported?.detail.contains("future.feature") ?? false)
    }

    func testADisabledServiceIsProduct() async throws {
        let off = try client(expected: [.license, .config])
        let answer = await off.supports(Feature.updateDecide)
        XCTAssertEqual(answer.unsupported?.reason, UnsupportedReason.product)
        // Core features never answer product.
        let verify = await off.supports(Feature.coreVerify)
        XCTAssertEqual(verify, .supported(feature: Feature.coreVerify))

        let on = try client(expected: allServices)
        let enabled = await on.supports(Feature.updateDecide)
        XCTAssertEqual(enabled, .supported(feature: Feature.updateDecide))
    }

    func testAServiceThatIsOffRefusesWithTheProductFields() async throws {
        let c = try client(expected: [.license, .config])
        do {
            _ = try await c.release.changelog()
            XCTFail("changelog() did not refuse")
        } catch let e as PolarisError {
            // Still a PolarisError with its old code, so existing catch sites keep matching.
            XCTAssertEqual(e.code, PolarisError.serviceUnavailable)
            XCTAssertEqual(
                e.unsupported,
                Unsupported(
                    feature: Feature.releaseChangelog, reason: UnsupportedReason.product,
                    detail: "the product does not run the release service"))
            let answer = await c.supports(Feature.releaseChangelog)
            XCTAssertEqual(answer.unsupported, e.unsupported)
        }
        do {
            _ = try await c.identity.beginSignIn()
            XCTFail("beginSignIn() did not refuse")
        } catch let e as PolarisError {
            XCTAssertEqual(e.unsupported?.feature, Feature.identityDevicecode)
            XCTAssertEqual(e.unsupported?.reason, UnsupportedReason.product)
        }
    }

    func testADisabledServiceInDiscoveryIsProduct() async throws {
        let server = StubServer()
        await server.reply(
            "/djdl/.well-known/polaris.json",
            body: #"{"product":"djdl","services":{"license":{"enabled":true},"config":{"enabled":true},"update":{"enabled":false}}}"#
        )
        let c = try client(server: server, expected: allServices)
        let before = await c.supports(Feature.updateDecide)
        XCTAssertTrue(before.isSupported)
        _ = await c.discover()
        let after = await c.supports(Feature.updateDecide)
        XCTAssertEqual(after.unsupported?.reason, UnsupportedReason.product)
    }

    func testUpdateDriverPerRuntime() async throws {
        let mac = try Capabilities(runtime: "macos", detectors: Capabilities.sdkDetectors)
        let services = servicesFromList(allServices)
        XCTAssertEqual(
            mac.supports(Feature.updateDriver, services: services),
            .supported(feature: Feature.updateDriver))
        let ios = try Capabilities(runtime: "ios", detectors: Capabilities.sdkDetectors)
        let answer = ios.supports(Feature.updateDriver, services: services)
        XCTAssertEqual(answer.unsupported?.reason, UnsupportedReason.outlet)
        // A runtime-N/A row answers runtime on iOS too (packs.transport.steam except ios).
        XCTAssertEqual(
            ios.supports(Feature.packsTransportSteam, services: services).unsupported?.reason,
            UnsupportedReason.runtime)
        #if os(macOS)
            let c = try client(expected: allServices)
            let here = await c.supports(Feature.updateDriver)
            XCTAssertEqual(here, .supported(feature: Feature.updateDriver))
        #endif
    }

    func testCapsIsTheSupportedSet() async throws {
        let c = try client(expected: allServices)
        let caps = await c.caps()
        var expected: [String] = []
        for feature in FEATURE_VALUES where await c.supports(feature).isSupported {
            expected.append(feature)
        }
        XCTAssertEqual(caps, expected)
        XCTAssertTrue(caps.contains(Feature.coreVerify))
        XCTAssertFalse(caps.contains(Feature.identityOidc))
    }

    func testTheReportBodyCarriesCaps() async throws {
        let server = StubServer()
        let store = InMemoryStore(deviceId: "d")
        await store.setToken("pkeyt_t")
        let c = try client(server: server, expected: [.license, .config], store: store)
        try await c.start()
        let ok = await c.report()
        XCTAssertTrue(ok)
        let posts = await server.requests(forPath: "/djdl/devices/report")
        XCTAssertEqual(posts.count, 1)
        let body = try XCTUnwrap(posts.first?.body)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        let sent = try XCTUnwrap(json["caps"] as? [String])
        let caps = await c.caps()
        XCTAssertEqual(sent, caps)
        XCTAssertFalse(sent.contains(Feature.updateDecide), "update is off")
    }

    func testDetectorValidationCatchesAMismatch() {
        let table: [String: CapabilityRow] = [
            "demo.a": CapabilityRow(
                status: "implemented", service: "core",
                na: [CapabilityNa(runtime: "ios", reason: UnsupportedReason.outlet)])
        ]
        // A conditional N/A without its detector.
        XCTAssertThrowsError(
            try Capabilities(table: table, runtime: "ios", runtimes: ["ios"], detectors: [:]))
        // A detector the table does not declare.
        XCTAssertThrowsError(
            try Capabilities(
                table: table, runtime: "macos", runtimes: ["ios", "macos"],
                detectors: [capabilityDetectorKey("demo.b", UnsupportedReason.dependency): { nil }]))
        // On a runtime without the N/A, no detector is needed; the declared one is accepted.
        XCTAssertNoThrow(
            try Capabilities(table: table, runtime: "macos", runtimes: ["ios", "macos"], detectors: [:]))
        XCTAssertNoThrow(
            try Capabilities(
                table: table, runtime: "ios", runtimes: ["ios"],
                detectors: [capabilityDetectorKey("demo.a", UnsupportedReason.outlet): { nil }]))
    }

    func testUnsupportedErrorCarriesTheRegistryCode() {
        let e = UnsupportedError(
            Unsupported(feature: Feature.configSecret, reason: UnsupportedReason.runtime, detail: "x"))
        XCTAssertEqual(e.code, ErrorCode.unsupported)
        XCTAssertEqual(e.code, "unsupported")
        XCTAssertEqual(e.feature, Feature.configSecret)
        XCTAssertEqual(e.reason, UnsupportedReason.runtime)
        XCTAssertEqual(e.detail, "x")
        XCTAssertTrue(ERROR_CODE_VALUES.contains(e.code))
    }
}
