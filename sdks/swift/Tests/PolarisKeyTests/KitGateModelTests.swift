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
    import PolarisKeyPlatform
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
            // license_owned is its own focused step (ui-matrix v7 `license-owned`), not a
            // refusal stacked under the field.
            XCTAssertEqual(model.activate.state, .licenseOwned)
            XCTAssertTrue(model.activate.shows("core.codes.license_owned.message"))
            // Editing clears the refusal (DL7): a new whole key is parsed again.
            model.keyText = "pkey_djdl_" + String(repeating: "B", count: 22)
            XCTAssertEqual(model.activate.state, .parsed)
            XCTAssertFalse(model.activate.shows("core.codes.license_owned.message"))
        }

        func testUseACodeInsteadShowsTheSameRequestsCode() async throws {
            await server.reply(
                "/djdl/identity/auth/device/start", status: 200,
                body:
                    #"{"deviceCode":"dc_1","userCode":"WDJB-MJHT","verificationUri":"https://polaris.locker/device","verificationUriComplete":"https://polaris.locker/device?user_code=WDJB-MJHT","expiresIn":600,"interval":5}"#
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

        // ── Automatic sign-in (I-44.6) ───────────────────────────────────────────────────

        private let api = "https://key.example/djdl"
        private let nonce = "sQXGUn9Dig9pVY62opwL2ZY-2R6qs3Rmyj7WRgxJxG4"
        private let grant = "sg_" + String(repeating: "b", count: 43)

        private final class SheetProvider: PlatformIdentityProvider, @unchecked Sendable {
            let kind: ExchangeKind = .apple
            let silentWorks: Bool
            let sheetFails: Bool
            let calls = LockedValue<[String]>([])
            var hasSilentRung: Bool { true }
            struct Nothing: Error {}
            init(silent: Bool = true, sheetFails: Bool = false) {
                silentWorks = silent
                self.sheetFails = sheetFails
            }
            func silent(nonce: String) async throws -> PlatformSubjectToken {
                calls.with { $0.append("silent") }
                guard silentWorks else { throw Nothing() }
                return PlatformSubjectToken(token: "apple.id.token", nonce: nonce)
            }
            func sheet(nonce: String) async throws -> PlatformSubjectToken {
                calls.with { $0.append("sheet") }
                if sheetFails { throw AppleSignInFailure.cancelled }
                return PlatformSubjectToken(token: "apple.id.token", nonce: nonce)
            }
            func signOutCleanup() async {}
            func credentialRevoked() async -> Bool { false }
        }

        private func autoClient(provider: SheetProvider) async throws -> PolarisKeyClient {
            await server.reply(
                "/djdl/.well-known/polaris.json",
                body:
                    #"{"product":"djdl","services":{"identity":{"enabled":true,"configured":true,"exchange":{"kinds":["apple"]},"nonce":"\#(api)/identity/nonce","issuer":"\#(api)/identity","endpoints":{"authorize":"\#(api)/identity/authorize","token":"\#(api)/identity/token","choiceLicenses":"\#(api)/identity/choice/licenses","choiceDevices":"\#(api)/identity/choice/devices","choiceComplete":"\#(api)/identity/choice/complete","choiceCancel":"\#(api)/identity/choice/cancel","nonce":"\#(api)/identity/nonce"}},"license":{"enabled":true,"configured":true}}}"#
            )
            await server.reply("/djdl/identity/nonce", body: #"{"nonce":"\#(nonce)","expiresIn":300}"#)
            let c = try await PolarisKeyClient.create(
                options: PolarisKeyClientOptions(
                    productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                    pinnedKeys: [:], trustRefresh: false,
                    store: InMemoryStore(deviceId: "DEVICE00000000000000000000000001"),
                    transport: server.transport, expectedServices: [.license, .identity],
                    fingerprint: false,
                    connect: ConnectOptions(keys: try LabelKeyPort(label: "kit-device-key-1"))))
            c.identity.installPlatformIdentity(provider)
            return c
        }

        private func consentBody(license: String, email: String? = "a@example.com") -> String {
            let mail = email.map { #""\#($0)""# } ?? "null"
            return
                #"{"status":"confirm","grant":"\#(grant)","expiresIn":300,"consent":{"client":{"appName":"djdl","developerName":null,"iconUrl":null,"nameVerified":true},"as":{"provider":"apple","email":\#(mail)},"items":[\#(license),{"kind":"profile","claims":["name","email"]}],"scopeHash":"327f","firstTime":true,"changed":false}}"#
        }

        private let existingLicense =
            #"{"kind":"license","anchor":{"name":"Pro","tierName":"Pro","term":"perpetual","seat":{"position":2,"limit":3}},"more":0}"#

        private func paths(_ suffix: String) async -> [PolarisRequest] {
            await server.requests.filter { $0.url.path.hasSuffix(suffix) }
        }

        func testBootRunsTheLadderOnceAndAConsentIsTheConfirmStep() async throws {
            await server.reply("/djdl/identity/token", body: consentBody(license: existingLicense))
            let provider = SheetProvider()
            let model = PolarisKeyGateModel(client: try await autoClient(provider: provider))
            model.start()
            try await settle { model.signInScreen.state == .confirm }
            defer { model.stop() }

            XCTAssertEqual(model.route, .signIn)
            XCTAssertEqual(model.signInScreen.state, .confirm)
            XCTAssertEqual(provider.calls.current, ["silent"])
            let auto = try XCTUnwrap(model.inputs.autoSignIn)
            XCTAssertEqual(auto.email, "a@example.com")
            XCTAssertEqual(auto.license, "existing")
            XCTAssertEqual(auto.alsoGets, true)
            XCTAssertEqual(
                [auto.licenseName, auto.device == nil ? nil : "device"], ["Pro", "device"])
            XCTAssertEqual([auto.position, auto.limit], [2, 3])
            XCTAssertNil(auto.term, "perpetual is no end date")
            // The license line is complete: the consent view's license, term and seat fill it.
            let line = try XCTUnwrap(model.signInScreen.line("signin.consent.licenseLine"))
            let text = KitCopy.bundled.format(line, locale: "en")
            XCTAssertTrue(text.hasPrefix("Pro · Lifetime · "), text)
            XCTAssertTrue(text.hasSuffix("device 2 of 3"), text)
            XCTAssertFalse(text.contains("{"), text)
        }

        func testBootStaysQuietWithNoCredentialOrWhenTurnedOff() async throws {
            let quiet = SheetProvider(silent: false)
            let model = PolarisKeyGateModel(client: try await autoClient(provider: quiet))
            model.start()
            try await settle { model.hasLoaded }
            try await Task.sleep(nanoseconds: 200_000_000)
            XCTAssertEqual(model.route, .welcome)
            XCTAssertEqual(quiet.calls.current, ["silent"])
            model.stop()

            let off = SheetProvider()
            let offModel = PolarisKeyGateModel(
                client: try await autoClient(provider: off), options: KitGateOptions(autoSignIn: false))
            offModel.start()
            try await settle { offModel.hasLoaded }
            try await Task.sleep(nanoseconds: 200_000_000)
            offModel.stop()
            XCTAssertEqual(off.calls.current, [], "autoSignIn: false never runs the ladder")
            let nonces = await paths("/identity/nonce")
            XCTAssertEqual(nonces.count, 1, "only the quiet model asked for a nonce")
        }

        func testContinueCompletesTheGrantWithTheConsentedClaims() async throws {
            await server.reply(
                "/djdl/identity/token",
                body: consentBody(license: #"{"kind":"license","anchor":null,"more":0}"#))
            await server.reply(
                "/djdl/identity/choice/complete",
                body:
                    #"{"access_token":"pkeyt_exchanged","token_type":"Bearer","scope":"profile","schemaVersion":1,"device":{"id":"D"},"license":null,"subject":"ps_abc"}"#
            )
            let model = PolarisKeyGateModel(client: try await autoClient(provider: SheetProvider()))
            model.start()
            try await settle { model.signInScreen.state == .confirm }
            defer { model.stop() }
            XCTAssertEqual(model.inputs.autoSignIn?.license, "new")

            await model.continueAutoSignIn()
            let completes = await paths("/identity/choice/complete")
            XCTAssertEqual(completes.count, 1)
            let body = String(decoding: completes[0].body ?? Data(), as: UTF8.self)
            XCTAssertTrue(body.contains("\"claims\""), "the consent travels with the grant")
            XCTAssertNil(model.inputs.autoSignIn)
            XCTAssertEqual(model.inputs.signIn?.outcome, .signedIn)
        }

        func testUseAnotherAccountDropsTheGrantAndShowsTheMethods() async throws {
            await server.reply("/djdl/identity/token", body: consentBody(license: existingLicense))
            await server.reply("/djdl/identity/choice/cancel", body: "{}")
            let model = PolarisKeyGateModel(client: try await autoClient(provider: SheetProvider()))
            model.start()
            try await settle { model.signInScreen.state == .confirm }
            defer { model.stop() }

            model.useAnotherAccount()
            XCTAssertEqual(model.signInScreen.state, .methods)
            XCTAssertNil(model.inputs.autoSignIn)
            for _ in 0..<100 {
                if await !paths("/identity/choice/cancel").isEmpty { break }
                try await Task.sleep(nanoseconds: 20_000_000)
            }
            let cancels = await paths("/identity/choice/cancel")
            XCTAssertEqual(cancels.count, 1, "the held grant is cancelled, not left open")
        }

        func testNoLinkLandsOnTheFormAndADeviceLimitOnItsScreen() async throws {
            await server.reply(
                "/djdl/identity/token", status: 403,
                body: #"{"error":"interstitial_required","reason":"no_link","url":"\#(api)/identity/authorize"}"#
            )
            let linkless = PolarisKeyGateModel(client: try await autoClient(provider: SheetProvider()))
            linkless.start()
            try await settle { linkless.route == .signIn }
            XCTAssertEqual(linkless.signInScreen.state, .methods)
            linkless.stop()

            server = StubServer()
            await server.reply("/djdl/identity/token", status: 403, body: #"{"error":"device_limit"}"#)
            let full = PolarisKeyGateModel(client: try await autoClient(provider: SheetProvider()))
            full.start()
            try await settle { full.route == .activate }
            defer { full.stop() }
            XCTAssertEqual(full.activate.state, .deviceLimit)
        }

        func testTheAppleRowOpensTheSheetThenRunsTheExchange() async throws {
            await server.reply("/djdl/identity/token", body: consentBody(license: existingLicense))
            let row = SheetProvider(silent: false)
            let model = PolarisKeyGateModel(
                client: try await autoClient(provider: SheetProvider(silent: false)),
                options: KitGateOptions(autoSignIn: false), platformProvider: row)
            await model.reload()

            model.signInWithProvider()
            try await settle { model.signInScreen.state == .confirm }
            XCTAssertEqual(row.calls.current, ["sheet"])
            let tokens = await paths("/identity/token")
            XCTAssertEqual(tokens.count, 1)
            XCTAssertEqual(model.inputs.autoSignIn?.step, .confirm)
            model.stop()
        }

        func testADismissedAppleSheetLeavesTheMethodsAlone() async throws {
            let row = SheetProvider(silent: false, sheetFails: true)
            let model = PolarisKeyGateModel(
                client: try await autoClient(provider: SheetProvider(silent: false)),
                options: KitGateOptions(autoSignIn: false), platformProvider: row)
            await model.reload()
            model.signInWithProvider()
            try await settle { row.calls.current == ["sheet"] && model.inputs.pending == nil }
            XCTAssertEqual(model.signInScreen.state, .methods)
            XCTAssertNil(model.inputs.error)
            let tokens = await paths("/identity/token")
            XCTAssertEqual(tokens.count, 0, "no exchange without a credential")
        }
    }

    /// A browser that opens nothing, for tests.
    struct NoBrowser: SignInBrowser {
        @MainActor func open(_ url: URL) async throws {}
        @MainActor func close() {}
    }
#endif
