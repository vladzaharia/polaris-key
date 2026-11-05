// @pkey-feature ui.kit.holders
//
// The holders' wiring against a stub Worker: the real `submitKey` over a signed
// license, then what the Done step is drawn from. A line never carries a brace (a license line whose
// term the license does not give drops that segment), the product page link follows discovery's
// `core.portal` (off is no link, and no key leaves for it; a self-hosted Worker uses its own customer
// site; the last member survives a cold start), and Verify opens only the account page Identity names.

#if canImport(SwiftUI)
    import Foundation
    import PolarisKey
    import PolarisKeyCore
    import PolarisKeyIdentity
    @testable import PolarisKeyUI
    import PolarisKeyUICore
    import XCTest

    @MainActor
    final class HoldersLiveGateTests: XCTestCase {
        private let signer = TestSigner(kid: "holders")
        private var dirs: [URL] = []

        override func tearDown() async throws {
            for d in dirs { try? FileManager.default.removeItem(at: d) }
            dirs = []
        }

        private func discovery(
            portal: JSONValue?, accountPortal: String? = nil, identity: Bool = true
        ) -> String {
            var core: [String: JSONValue] = ["registration": .string("requires-license")]
            if let portal { core["portal"] = portal }
            var identityFragment: [String: JSONValue] = ["enabled": .bool(identity)]
            if let accountPortal {
                identityFragment["endpoints"] = .object(["accountPortal": .string(accountPortal)])
            }
            let doc: JSONValue = .object([
                "product": .string("djdl"), "name": .string("djdl"), "core": .object(core),
                "services": .object([
                    "license": .object(["enabled": .bool(true)]), "identity": .object(identityFragment),
                ]),
            ])
            return String(decoding: (try? JSONEncoder().encode(doc)) ?? Data(), as: UTF8.self)
        }

        private func client(
            _ server: StubServer, dataDir: URL? = nil, activate: Bool = true
        ) async throws -> PolarisKeyClient {
            let t = Int(Date().timeIntervalSince1970)
            let doc = Fixtures.license(
                issuedAt: t,
                entitlements: ["license.tier": Fixtures.entry(.string("pro"), .enforced)],
                profile: DocProfile(name: "", firstName: "", email: "", activatedAt: t))
            let jws = signer.sign(doc)
            await server.reply("/djdl/license/activate", body: #"{"token":"pkeyt_h","schemaVersion":4}"#)
            await server.route("/djdl/license/document") { _ in StubServer.Reply(status: 200, body: jws, headers: [:]) }
            await server.reply("/djdl/devices/report", body: "{}")
            await server.reply(
                "/djdl/devices",
                body: #"{"devices":[{"id":"dev","current":true,"platform":"macos","label":"This Mac"}]}"#)
            return try await PolarisKeyClient.create(
                options: PolarisKeyClientOptions(
                    core: CoreOptions(
                        productSlug: "djdl", baseUrl: "https://key.plrs.im", version: "1.0.0",
                        pinnedKeys: signer.trust, trustRefresh: false,
                        store: InMemoryStore(deviceId: "dev"), transport: server.transport,
                        expectedServices: [.license, .identity], dataDir: dataDir)))
        }

        private func activated(_ c: PolarisKeyClient) async -> (PolarisKeyGateModel, HolderFlowModel?) {
            let model = PolarisKeyGateModel(client: c)
            await model.reload()
            model.useLicenseKey()
            model.keyText = "pkey_djdl_" + String(repeating: "A", count: 22)
            await model.submitKey()
            return (model, model.holders)
        }

        private func drawn(_ flow: HolderFlowModel) -> [String] {
            let screen = KitStates.activateDone(flow.doneInputs)
            return screen.copy.compactMap { line in
                let text = KitCopy.bundled.format(line, locale: "en")
                return line.key == "activate.done.device" ? KitFormat.deviceLine(text) : text
            }
        }

        func testNoDrawnLineOfTheLiveDoneStepCarriesABrace() async throws {
            let server = StubServer()
            await server.reply(
                "/djdl/.well-known/polaris.json",
                body: discovery(
                    portal: .object([
                        "enabled": .bool(true), "activate": .string("https://polaris.locker/activate?product=djdl"),
                    ])))
            let c = try await client(server)
            await c.discover()
            let (model, flow) = await activated(c)
            let f = try XCTUnwrap(flow, "the key goes to Done")
            XCTAssertEqual(model.gate.state, .licensed)
            XCTAssertNil(f.doneInputs.activateDone?.term, "the license carries no term")
            let lines = drawn(f)
            XCTAssertFalse(lines.isEmpty)
            for line in lines { XCTAssertFalse(line.contains("{"), line) }
        }

        func testAPortalThatIsOffLeavesNoLinkAndNoKeyLeaves() async throws {
            let server = StubServer()
            await server.reply(
                "/djdl/.well-known/polaris.json", body: discovery(portal: .object(["enabled": .bool(false)])))
            let c = try await client(server)
            await c.discover()
            let (_, flow) = await activated(c)
            let f = try XCTUnwrap(flow)
            XCTAssertNil(f.facts.portal)
            XCTAssertNil(f.doneLink)
            XCTAssertNil(f.qrLink)
        }

        func testASelfHostedWorkerUsesTheCustomerSiteItPublished() async throws {
            let server = StubServer()
            let own = "https://shop.example/activate?product=djdl"
            await server.reply(
                "/djdl/.well-known/polaris.json",
                body: discovery(portal: .object(["enabled": .bool(true), "activate": .string(own)])))
            let c = try await client(server)
            await c.discover()
            let (_, flow) = await activated(c)
            let f = try XCTUnwrap(flow)
            XCTAssertEqual(f.facts.portal, own)
            XCTAssertEqual(f.doneLink, own, "another origin never gets the key")
        }

        func testVerifyOpensOnlyTheAccountPageIdentityNames() async throws {
            let server = StubServer()
            let activate = "https://polaris.locker/activate?product=djdl"
            await server.reply(
                "/djdl/.well-known/polaris.json",
                body: discovery(portal: .object(["enabled": .bool(true), "activate": .string(activate)])))
            let c = try await client(server)
            await c.discover()
            let (_, flow) = await activated(c)
            XCTAssertNil(try XCTUnwrap(flow).verifyLink, "the product page is not where an email is verified")

            let named = StubServer()
            let account = "https://polaris.locker/account"
            await named.reply(
                "/djdl/.well-known/polaris.json",
                body: discovery(portal: nil, accountPortal: account))
            let c2 = try await client(named)
            await c2.discover()
            let (_, flow2) = await activated(c2)
            XCTAssertEqual(try XCTUnwrap(flow2).verifyLink, account)
        }

        func testThePortalMemberSurvivesAColdStart() async throws {
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("portal-\(UUID().uuidString)")
            dirs.append(dir)
            let server = StubServer()
            await server.reply(
                "/djdl/.well-known/polaris.json", body: discovery(portal: .object(["enabled": .bool(false)])))
            let first = try await client(server, dataDir: dir)
            await first.discover()
            XCTAssertEqual(first.portal, PortalMember(enabled: false))
            // A new client over the same directory, never discovered: the last member loads at start.
            let second = try await client(StubServer(), dataDir: dir)
            XCTAssertEqual(second.portal, PortalMember(enabled: false))
        }
    }
#endif
