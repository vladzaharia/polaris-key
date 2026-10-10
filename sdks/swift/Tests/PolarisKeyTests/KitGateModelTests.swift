// @pkey-feature ui.gate ui.theme
//
// PolarisKeyGateModel, the live headless model of the SwiftUI kit (UK-07), against a stub Worker:
//
//   * it is `booting` until its first reload, never Welcome during a cached-session check;
//   * the product's presentation, read only through the presentation source (UI-KITS §1.2, HA-11
//     Q7), gives the screens the product accent and the verified icon with zero integrator code;
//   * activation outcomes become the core's inputs, so a short key is caught before any request
//     and a refusal lands under the field;
//   * "Use a code instead" reveals the same request's code, never a second request.

#if canImport(SwiftUI)
    import Foundation
    import PolarisKey
    import PolarisKeyCore
    import PolarisKeyIdentity
    @testable import PolarisKeyUI
    import PolarisKeyUICore
    import SwiftUI
    import XCTest

    @MainActor
    final class KitGateModelTests: XCTestCase {
        private var server = StubServer()

        override func setUp() async throws {
            server = StubServer()
        }

        private func client(services: [ServiceSlug] = [.license, .identity]) async throws
            -> PolarisKeyClient
        {
            try await PolarisKeyClient.create(
                options: PolarisKeyClientOptions(
                    productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                    pinnedKeys: [:], trustRefresh: false, store: InMemoryStore(deviceId: "dev"),
                    transport: server.transport, expectedServices: services, fingerprint: false))
        }

        private func settle(_ done: () -> Bool) async throws {
            for _ in 0..<100 where !done() {
                try await Task.sleep(nanoseconds: 20_000_000)
            }
        }

        func testTheGateBootsBeforeItKnowsTheLicense() async throws {
            let model = PolarisKeyGateModel(client: try await client())
            XCTAssertEqual(model.gate.state, .booting)
            XCTAssertNotEqual(model.welcome.state, nil, "Welcome resolves, but the gate shows Boot")
            await model.reload()
            XCTAssertEqual(model.gate.state, .needsActivation)
        }

        func testThePresentationSourceGivesTheAccentAndIconWithNoIntegratorCode() async throws {
            let icon = Data([0x89, 0x50, 0x4E, 0x47])
            let source = StaticPresentationSource(
                KitProductPresentation(
                    name: "Drift Kart", developerName: "Lanternworks", accent: "#ff6a3d",
                    accentDark: "#ff8a5c"),
                iconData: icon)
            let model = PolarisKeyGateModel(client: try await client(), presentationSource: source)
            model.start()
            try await settle { model.presentationIcon != nil && model.hasLoaded }
            defer { model.stop() }

            XCTAssertEqual(model.identity.name, "Drift Kart")
            XCTAssertEqual(model.identity.developer, "Lanternworks")
            XCTAssertEqual(model.identity.accentSource, .product)
            XCTAssertEqual(model.identity.accentLight, "#ff6a3d")
            XCTAssertEqual(model.identity.accentDark, "#ff8a5c")
            XCTAssertEqual(model.identity.icon, .image)
            XCTAssertEqual(model.presentationIcon, icon)
            XCTAssertNil(model.options.integrator)

            // The kit's palette resolves that accent through the contrast resolver, per scheme.
            for dark in [false, true] {
                let palette = KitPaletteResolver.palette(
                    identity: model.identity, preset: .polarisKey, dark: dark, derivedAccent: nil,
                    increaseContrast: false)
                let resolved = PolarisAccent.resolve(dark ? "#ff8a5c" : "#ff6a3d", dark: dark)!
                XCTAssertEqual(palette.accentSolid, BrandColor(hexString: resolved.solid)!.color)
            }
        }

        func testAShortKeyIsCaughtBeforeAnyRequest() async throws {
            let model = PolarisKeyGateModel(client: try await client())
            await model.reload()
            model.useLicenseKey()
            model.keyText = "pkey_djdl_short"
            await model.submitKey()
            XCTAssertEqual(model.activate.state, .cutShort)
            XCTAssertNotNil(model.announcement)
            let requests = await server.requests
            XCTAssertFalse(requests.contains { $0.url.path.hasSuffix("/license/activate") })
        }

        func testARefusalLandsUnderTheField() async throws {
            await server.reply(
                "/djdl/license/activate", status: 403, body: #"{"error":"license_owned"}"#)
            let model = PolarisKeyGateModel(client: try await client())
            await model.reload()
            model.keyText = "pkey_djdl_" + String(repeating: "A", count: 22)
            await model.submitKey()
            XCTAssertEqual(model.activate.state, .rejected)
            XCTAssertTrue(model.activate.shows("core.codes.license_owned.title"))
            // Editing clears the refusal (DL7): a new whole key is parsed again.
            model.keyText = "pkey_djdl_" + String(repeating: "B", count: 22)
            XCTAssertEqual(model.activate.state, .parsed)
            XCTAssertFalse(model.activate.shows("core.codes.license_owned.title"))
        }

        func testUseACodeInsteadShowsTheSameRequestsCode() async throws {
            await server.reply(
                "/djdl/identity/auth/device/start", status: 200,
                body: #"{"deviceCode":"dc_1","userCode":"WDJB-MJHT","verificationUri":"https://key.plrs.im/device","verificationUriComplete":"https://key.plrs.im/device?code=WDJB-MJHT","expiresIn":600,"interval":5}"#
            )
            let model = PolarisKeyGateModel(
                client: try await client(), browser: NoBrowser())
            await model.reload()
            model.beginSignIn()
            try await settle { model.request != nil }
            XCTAssertEqual(model.request?.userCode, "WDJB-MJHT")
            model.useCode()
            XCTAssertEqual(model.handoff.state, .code)
            XCTAssertEqual(model.signInScreen.state, .code)
            let starts = await server.requests.filter {
                $0.url.path.hasSuffix("/identity/auth/device/start")
            }
            XCTAssertEqual(starts.count, 1, "one request, its code revealed")
            model.cancelSignIn()
            XCTAssertEqual(model.signInScreen.state, .methods)
        }
    }

    /// A browser that opens nothing, for tests.
    struct NoBrowser: SignInBrowser {
        @MainActor func open(_ url: URL) async throws {}
        @MainActor func close() {}
    }
#endif
