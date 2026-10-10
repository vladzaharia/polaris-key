// @pkey-feature core.presentation ui.theme
//
// The kits' default from the SDK's presentation (plans/HA-13.md): with nothing from the integrator,
// a live kit shows the product's name, accent and verified icon from discovery, and without a
// member it shows exactly what it showed before.
//
//   * PolarisKeyGateModel (UK-07) reads `client.presentationSource` through the thin
//     `SDKPresentationSource` adapter when the host passes no source;
//   * PolarisKeyModel maps `Presentation` to `PolarisProductPresentation` once, with the verified
//     icon's bytes, and the gate puts it in the environment unless the host set one;
//   * the simulator baselines of the welcome with and without presentation are committed
//     (welcome-default-drift-kart, welcome-default-no-presentation; examples/ui/swiftui/run.sh).

#if canImport(SwiftUI)
    import Foundation
    import PolarisKey
    import PolarisKeyCore
    @testable import PolarisKeyUI
    import PolarisKeyUICore
    import SwiftUI
    import XCTest

    @MainActor
    final class PresentationKitTests: XCTestCase {
        private let path = "/djdl/.well-known/polaris.json"
        /// A 1×1 PNG, so the kit's decoder accepts the icon.
        private let png = Data(
            base64Encoded:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
        )!
        private var dirs: [URL] = []

        override func tearDown() async throws {
            for d in dirs { try? FileManager.default.removeItem(at: d) }
            dirs = []
        }

        private var member: Presentation {
            let base = "https://img.plrs.im/djdl/a/\(sha256Hex(png))"
            return Presentation(
                name: "Drift Kart", developerName: "Lanternworks", accent: "#ff6a3d",
                accentDark: "#ff8a5c",
                icon: PresentationIcon(
                    sha256: sha256Hex(png), contentType: "image/png", width: 1, height: 1,
                    original: base))
        }

        private func client(_ member: Presentation?, fetcher: FakeIconFetcher) async throws
            -> PolarisKeyClient
        {
            let server = StubServer()
            var core: [String: JSONValue] = ["registration": .string("requires-license")]
            if let member { core["presentation"] = member.jsonValue }
            let doc: JSONValue = .object([
                "product": .string("djdl"), "name": .string("djdl"), "core": .object(core),
                "services": .object([
                    "license": .object(["enabled": .bool(true)]),
                    "identity": .object(["enabled": .bool(true)]),
                ]),
            ])
            await server.reply(
                path, body: String(decoding: try JSONEncoder().encode(doc), as: UTF8.self))
            let dataDir = temporaryDirectory("kit")
            dirs.append(dataDir)
            let c = try await PolarisKeyClient.create(
                options: PolarisKeyClientOptions(
                    core: CoreOptions(
                        productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                        pinnedKeys: [:], trustRefresh: false,
                        store: InMemoryStore(deviceId: "dev"), transport: server.transport,
                        expectedServices: [.license, .identity], dataDir: dataDir,
                        presentationIconFetcher: fetcher)))
            await c.discover()
            return c
        }

        private func fetcher() -> FakeIconFetcher {
            FakeIconFetcher([member.icon!.original: PresentationIconResponse(status: 200, body: png)])
        }

        private func settle(_ done: () -> Bool) async throws {
            for _ in 0..<100 where !done() {
                try await Task.sleep(nanoseconds: 20_000_000)
            }
        }

        func testTheGateModelDefaultsToTheSDKsPresentation() async throws {
            let model = PolarisKeyGateModel(client: try await client(member, fetcher: fetcher()))
            model.start()
            defer { model.stop() }
            try await settle { model.presentationIcon != nil && model.hasLoaded }
            XCTAssertEqual(model.identity.name, "Drift Kart")
            XCTAssertEqual(model.identity.developer, "Lanternworks")
            XCTAssertEqual(model.identity.accentSource, .product)
            XCTAssertEqual(model.identity.accentLight, "#ff6a3d")
            XCTAssertEqual(model.identity.accentDark, "#ff8a5c")
            XCTAssertEqual(model.identity.icon, .image)
            XCTAssertEqual(model.presentationIcon, png)
        }

        func testWithoutAMemberTheGateModelShowsTodaysIdentity() async throws {
            let live = PolarisKeyGateModel(client: try await client(nil, fetcher: fetcher()))
            live.start()
            defer { live.stop() }
            try await settle { live.hasLoaded }
            let before = PolarisKeyGateModel(
                client: try await client(nil, fetcher: fetcher()),
                presentationSource: StaticPresentationSource(nil))
            before.start()
            defer { before.stop() }
            try await settle { before.hasLoaded }
            XCTAssertEqual(live.identity, before.identity)
            XCTAssertNil(live.presentationIcon)
            XCTAssertNotEqual(live.identity.accentSource, .product)
        }

        func testTheIntegratorStillWinsOverThePresentation() async throws {
            var options = KitGateOptions()
            options.integrator = KitIntegrator(name: "Tidewater", accent: "#2f6fde")
            let model = PolarisKeyGateModel(
                client: try await client(member, fetcher: fetcher()), options: options)
            model.start()
            defer { model.stop() }
            try await settle { model.hasLoaded }
            XCTAssertEqual(model.identity.name, "Tidewater")
            XCTAssertEqual(model.identity.accentSource, .integrator)
            XCTAssertEqual(model.identity.accentLight, "#2f6fde")
        }

        func testPolarisKeyModelMapsThePresentationOnceWithItsIcon() async throws {
            let model = PolarisKeyModel(client: try await client(member, fetcher: fetcher()))
            await model.reload()
            XCTAssertEqual(model.presentation?.name, "Drift Kart")
            XCTAssertEqual(model.presentation?.accent(for: .dark), "#ff8a5c")
            try await settle { model.presentation?.iconData != nil }
            XCTAssertEqual(
                model.presentation,
                PolarisKeyModel.productPresentation(member, iconData: png))

            // The SwiftUI kit's identity: the product's name and its verified icon, masked.
            let identity = PolarisProductIdentity.resolve(
                theme: PolarisTheme(), presentation: model.presentation, bundle: .none)
            XCTAssertEqual(identity.name, "Drift Kart")
            XCTAssertEqual(identity.developer, "Lanternworks")
            guard case .image(_, let masked) = identity.icon else {
                return XCTFail("the verified icon is drawn")
            }
            XCTAssertTrue(masked)

            // Without a member: today's output, the monogram of the integrator's default name.
            let none = PolarisKeyModel(client: try await client(nil, fetcher: fetcher()))
            await none.reload()
            XCTAssertNil(none.presentation)
            let plain = PolarisProductIdentity.resolve(
                theme: PolarisTheme(), presentation: none.presentation, bundle: .none)
            guard case .monogram = plain.icon else { return XCTFail("no icon: the monogram") }
            XCTAssertEqual(
                plain.name, PolarisProductIdentity.resolve(
                    theme: PolarisTheme(), presentation: nil, bundle: .none
                ).name)
        }

        func testTheWelcomeBaselinesWithAndWithoutPresentationAreCommitted() {
            let dir = CorpusLocator.file("sdks/swift/Tests/PolarisKeyUISnapshotTests/__Snapshots__")
            for state in ["welcome-default-drift-kart", "welcome-default-no-presentation"] {
                for scheme in ["light", "dark"] {
                    let file = dir.appendingPathComponent("\(state)-\(scheme).png")
                    XCTAssertTrue(FileManager.default.fileExists(atPath: file.path), file.path)
                }
            }
        }
    }
#endif
