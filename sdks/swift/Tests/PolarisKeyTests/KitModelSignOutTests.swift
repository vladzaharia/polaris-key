// @pkey-feature ui.kit ui.settings identity.account
//
// The settings model's sign-out (DB-2): a network error is the alert, any other failure is its own
// line, and Sign out anyway is a deliberate sign-out that never tells the host before it is done.

#if canImport(SwiftUI)
    import Foundation
    import PolarisKey
    import PolarisKeyCore
    import PolarisKeyIdentity
    @testable import PolarisKeyUI
    import PolarisKeyUICore
    import XCTest

    @MainActor
    final class SignedOutFlag { var fired = false }

    /// An in-memory store whose credential removal can be made to fail, as a locked Keychain does.
    actor FlakyStore: Store {
        private let inner = InMemoryStore(deviceId: "dev")
        private var failing = false
        struct Locked: Error {}

        func setFailing(_ on: Bool) { failing = on }
        func getToken() async throws -> String? { await inner.getToken() }
        func setToken(_ token: String) async throws { await inner.setToken(token) }
        func clearToken() async throws {
            if failing { throw Locked() }
            await inner.clearToken()
        }
        func getDeviceId() async throws -> String { await inner.getDeviceId() }
        func readCache() async -> CacheRecord? { await inner.readCache() }
        func writeCache(_ record: CacheRecord) async throws { await inner.writeCache(record) }
        func clearCache() async throws { await inner.clearCache() }
        func readRecord(_ name: String) async -> Data? { await inner.readRecord(name) }
        func writeRecord(_ name: String, _ data: Data?) async { await inner.writeRecord(name, data) }
    }

    @MainActor
    final class KitModelSignOutTests: XCTestCase {
        private var server = StubServer()

        override func setUp() async throws {
            server = StubServer()
        }

        private static let subject = "ps_" + String(repeating: "a", count: 22)

        /// A client holding a verified licence and a token whose origin is `provenance`.
        private func licensedClient(
            provenance: TokenProvenance, user: String? = nil, store: (any Store)? = nil
        ) async throws -> PolarisKeyClient {
            let signer = TestSigner(kid: "kit-key")
            let t = Int(Date().timeIntervalSince1970)
            let store: any Store = store ?? InMemoryStore(deviceId: "dev")
            try await store.setToken("pkeyt_held")
            await store.writeRecord("token-origin", Data(provenance.rawValue.utf8))
            let doc = Fixtures.license(
                deviceId: "dev", licenseId: "lic_kit", issuedAt: t,
                profile: DocProfile(
                    name: "Ada", firstName: "Ada", email: "a@e.com", activatedAt: 1,
                    user: user.map { SignedInUser(subject: $0) }))
            try await store.writeCache(CacheRecord(docs: [.license: signer.sign(doc)]))
            return try await PolarisKeyClient.create(
                options: PolarisKeyClientOptions(
                    productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                    pinnedKeys: signer.trust, trustRefresh: false, store: store,
                    transport: server.transport, expectedServices: [.license, .identity],
                    fingerprint: false))
        }

        func testSettingsDecidesSignedInFromTheAccountNotTheHolder() async throws {
            let key = PolarisKeySettingsModel(client: try await licensedClient(provenance: .key))
            await key.load()
            XCTAssertEqual(key.account.state, .keyOnly, "a key activation is not an account")
            XCTAssertNil(key.holder)
            let account = PolarisKeySettingsModel(
                client: try await licensedClient(provenance: .signin, user: Self.subject))
            await account.load()
            XCTAssertEqual(account.account.state, .signedIn, "a sign-in token is an account")
        }

        func testSignOutOfAnAccountThatCannotReachTheServiceOffersSignOutAnyway() async throws {
            let c = try await licensedClient(provenance: .signin, user: Self.subject)
            let signedOut = SignedOutFlag()
            let model = PolarisKeySettingsModel(
                client: c, handlers: KitSettingsHandlers(signedOut: { signedOut.fired = true }))
            await model.load()
            await model.signOut()
            XCTAssertTrue(model.signOutFailed, "a network error is the alert")
            XCTAssertNil(model.signOutError)
            XCTAssertFalse(signedOut.fired, "a failed sign-out leaves the device signed in")
            let held = await c.core.token
            XCTAssertNotNil(held)
            let before = await c.core.explicitSignOut()
            XCTAssertFalse(before)
            await model.signOutAnyway()
            XCTAssertFalse(model.signOutFailed)
            XCTAssertTrue(signedOut.fired)
            let after = await c.core.token
            XCTAssertNil(after)
            let deliberate = await c.core.explicitSignOut()
            XCTAssertTrue(deliberate, "Sign out anyway is a deliberate sign-out: nothing signs back in")
        }

        func testTryAgainAfterAnOfflineSignOutRunsSignOutAgain() async throws {
            let c = try await licensedClient(provenance: .signin, user: Self.subject)
            let model = PolarisKeySettingsModel(client: c)
            await model.load()
            await model.signOut()
            XCTAssertTrue(model.signOutFailed)
            model.dismissSignOutFailure()
            XCTAssertFalse(model.signOutFailed, "the alert closed")
            await model.signOut()
            XCTAssertTrue(model.signOutFailed, "still offline: the alert comes back")
        }

        func testOnlyANetworkErrorLeadsToTheAlert() async throws {
            await server.reply(
                "/djdl/.well-known/polaris.json",
                body:
                    #"{"product":"djdl","services":{"identity":{"enabled":true,"configured":true,"issuer":"https://key.example/djdl/identity","endpoints":{"signout":"https://key.example/djdl/identity/signout"}}}}"#
            )
            await server.reply("/djdl/identity/signout", status: 403, body: #"{"error":"forbidden"}"#)
            let c = try await licensedClient(provenance: .signin, user: Self.subject)
            let signedOut = SignedOutFlag()
            let model = PolarisKeySettingsModel(
                client: c, handlers: KitSettingsHandlers(signedOut: { signedOut.fired = true }))
            await model.load()
            await model.signOut()
            XCTAssertFalse(model.signOutFailed, "a refusal is not an outage")
            XCTAssertEqual(model.signOutError, CopyLine("core.codes.forbidden.message"))
            XCTAssertFalse(signedOut.fired)
            let held = await c.core.token
            XCTAssertNotNil(held)
            await model.load()
            XCTAssertNil(model.signOutError, "a fresh read clears the line")
        }

        func testAHookThatStopsSignOutShowsItsOwnLineAndNeverTheAlert() async throws {
            await server.reply(
                "/djdl/.well-known/polaris.json",
                body:
                    #"{"product":"djdl","services":{"identity":{"enabled":true,"configured":true,"issuer":"https://key.example/djdl/identity","endpoints":{"signout":"https://key.example/djdl/identity/signout"}}}}"#
            )
            let c = try await licensedClient(provenance: .signin, user: Self.subject)
            struct Locked: Error {}
            _ = c.identity.onBeforeSignOut { throw Locked() }
            let signedOut = SignedOutFlag()
            let model = PolarisKeySettingsModel(
                client: c, handlers: KitSettingsHandlers(signedOut: { signedOut.fired = true }))
            await model.load()
            await model.signOut()
            XCTAssertFalse(model.signOutFailed)
            XCTAssertNotNil(model.signOutError)
            XCTAssertFalse(signedOut.fired)
        }

        func testSignOutAnywayThatCannotReleaseDoesNotTellTheHost() async throws {
            let store = FlakyStore()
            let c = try await licensedClient(provenance: .signin, user: Self.subject, store: store)
            let signedOut = SignedOutFlag()
            let model = PolarisKeySettingsModel(
                client: c, handlers: KitSettingsHandlers(signedOut: { signedOut.fired = true }))
            await model.load()
            await store.setFailing(true)  // a locked Keychain: the credential cannot be removed
            await model.signOutAnyway()
            XCTAssertNotNil(model.signOutError, "the person is told it did not finish")
            XCTAssertFalse(signedOut.fired, "the host is told only when the release succeeded")
        }

        func testSignOutOfAKeyActivationIsDeactivate() async throws {
            let c = try await licensedClient(provenance: .key)
            let model = PolarisKeySettingsModel(client: c)
            await model.load()
            await model.signOut()
            XCTAssertFalse(model.signOutFailed)
            XCTAssertNil(model.signOutError)
            let after = await c.core.token
            XCTAssertNil(after)
        }
    }
#endif
