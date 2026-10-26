// @pkey-feature identity.account identity.attach
//
// I-10b.9: `identity.subject()`, `signOut()`, `openAccount()` and `attach(confirm:)` over a
// stubbed Worker. The recorded conversations (identity-subject-signout, identity-attach,
// identity-attach-errors) are replayed by `TranscriptTests`; these cover what a transcript
// cannot: the typed unsupported results, the hooks and the state a refusal keeps.

import Foundation
import PolarisKey
import PolarisKeyCore
import PolarisKeyIdentity
import XCTest

final class IdentityAccountTests: XCTestCase {
    private var server = StubServer()

    override func setUp() {
        super.setUp()
        server = StubServer()
    }

    private func discovery(_ endpoints: [String: String]) -> String {
        let pairs = endpoints.map { "\"\($0.key)\":\"\($0.value)\"" }.sorted().joined(separator: ",")
        return """
            {"product":"djdl","services":{"license":{"enabled":true},\
            "identity":{"enabled":true,"account":true,"issuer":"https://key.example/djdl/identity",\
            "endpoints":{\(pairs)}}}}
            """
    }

    private let all = [
        "subject": "https://key.example/djdl/identity/subject",
        "signout": "https://key.example/djdl/identity/signout",
        "attach": "https://key.example/djdl/identity/attach",
        "accountPortal": "https://key.example/#/p/djdl",
    ]

    private func client(_ endpoints: [String: String]?, token: String? = "pkeyt_a") async throws
        -> PolarisKeyClient
    {
        if let endpoints {
            await server.reply("/djdl/.well-known/polaris.json", body: discovery(endpoints))
        }
        let store = InMemoryStore(deviceId: "dev")
        if let token { await store.setToken(token) }
        return try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], trustRefresh: false, store: store, transport: server.transport,
                expectedServices: [.license, .identity], fingerprint: false))
    }

    private func unsupportedReason(_ body: () async throws -> Void) async -> String? {
        do { try await body() } catch let e as UnsupportedError { return e.reason } catch {}
        return nil
    }

    func testTheFragmentIsParsed() async throws {
        let c = try await client(all)
        _ = await c.discover()
        let document = await c.core.discoveryDocument
        let identity = try XCTUnwrap(document?.identity)
        XCTAssertTrue(identity.account)
        XCTAssertEqual(identity.issuer, "https://key.example/djdl/identity")
        XCTAssertEqual(identity.subject, all["subject"])
        XCTAssertEqual(identity.accountPortal, all["accountPortal"])
    }

    func testAnAbsentEndpointIsTheTypedUnsupportedResultAndMakesNoRequest() async throws {
        let c = try await client(["signout": all["signout"]!])
        let reason = await unsupportedReason { _ = try await c.identity.subject() }
        XCTAssertEqual(reason, UnsupportedReason.product)
        let attach = await unsupportedReason { _ = try await c.identity.attach(confirm: true) }
        XCTAssertEqual(attach, UnsupportedReason.product)
        let portal = await unsupportedReason { try await c.identity.openAccount { _ in true } }
        XCTAssertEqual(portal, UnsupportedReason.product)
        let log = await server.requests.map(\.url.absoluteString)
        XCTAssertFalse(log.contains { $0.contains("identity/subject") || $0.contains("identity/attach") })
    }

    func testAnEndpointOnAnotherOriginIsRefused() async throws {
        let c = try await client(["subject": "https://evil.example/djdl/identity/subject"])
        do {
            _ = try await c.identity.subject()
            XCTFail("followed an endpoint on another origin")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.badResponse)
        }
        let log = await server.requests.map(\.url.absoluteString)
        XCTAssertFalse(log.contains { $0.contains("evil.example") })
    }

    func testSubjectIsHeldAndNullForAKeyOnlyDevice() async throws {
        let c = try await client(all)
        await server.reply("/djdl/identity/subject", body: #"{"subject":"ps_abc"}"#)
        let subject = try await c.identity.subject()
        XCTAssertEqual(subject, "ps_abc")
        XCTAssertEqual(c.identity.account, "ps_abc")
        await server.reply("/djdl/identity/subject", body: #"{"subject":null}"#)
        let none = try await c.identity.subject()
        XCTAssertNil(none)
        XCTAssertNil(c.identity.account)
    }

    func testSignOutRunsTheHooksFirstAndAFailingHookStopsIt() async throws {
        let c = try await client(all)
        await server.reply("/djdl/identity/signout", body: #"{"released":false}"#)
        let order = LockedValue<[String]>([])
        let removeFirst = c.identity.onBeforeSignOut { order.with { $0.append("a") } }
        c.identity.onBeforeSignOut { order.with { $0.append("b") } }
        let out = try await c.identity.signOut()
        XCTAssertFalse(out.released)
        XCTAssertEqual(order.current, ["a", "b"])
        removeFirst()
        _ = try await c.identity.signOut()
        XCTAssertEqual(order.current, ["a", "b", "b"])

        struct Boom: Error {}
        c.identity.onBeforeSignOut { throw Boom() }
        await server.reset()
        await server.reply("/djdl/identity/signout", body: #"{"released":true}"#)
        do {
            _ = try await c.identity.signOut()
            XCTFail("a failing hook did not stop the sign-out")
        } catch is Boom {}
        let log = await server.requests.map(\.url.absoluteString)
        XCTAssertFalse(log.contains { $0.contains("identity/signout") })
    }

    func testReleasedFalseKeepsTheToken() async throws {
        let c = try await client(all)
        await server.reply("/djdl/identity/signout", body: #"{"released":false}"#)
        _ = try await c.identity.signOut()
        let token = await c.core.token
        XCTAssertEqual(token, "pkeyt_a")
    }

    func testReleasedTrueWipesTheToken() async throws {
        let c = try await client(all)
        await server.reply("/djdl/identity/signout", body: #"{"released":true}"#)
        let out = try await c.identity.signOut()
        XCTAssertTrue(out.released)
        let token = await c.core.token
        XCTAssertNil(token)
    }

    func testAnAttachRefusalIsATypedResultThatKeepsTheToken() async throws {
        let c = try await client(all)
        await server.reply(
            "/djdl/identity/attach", status: 403, body: #"{"error":{"code":"license_owned"}}"#)
        let r = try await c.identity.attach(confirm: true)
        XCTAssertEqual(r, .refused(code: "license_owned", status: 403))
        let token = await c.core.token
        XCTAssertEqual(token, "pkeyt_a")
    }

    func testAnAttachPreviewWritesNothing() async throws {
        let c = try await client(all)
        await server.reply(
            "/djdl/identity/attach",
            body: #"{"status":"confirm","license":{"id":"lic_1","tierId":null,"name":"Ada"}}"#)
        let r = try await c.identity.attach(confirm: false)
        XCTAssertEqual(r, .confirm(license: AttachLicense(id: "lic_1", tierId: nil, name: "Ada")))
        let token = await c.core.token
        XCTAssertEqual(token, "pkeyt_a")
    }

    func testOpenAccountOpensThePortal() async throws {
        let c = try await client(all)
        let opened = LockedValue<[URL]>([])
        try await c.identity.openAccount { url in
            opened.with { $0.append(url) }
            return true
        }
        XCTAssertEqual(opened.current.map(\.absoluteString), [all["accountPortal"]!])
        let refused = await unsupportedReason { try await c.identity.openAccount { _ in false } }
        XCTAssertEqual(refused, UnsupportedReason.runtime)
    }

    func testNoTokenIsTheNoTokenCode() async throws {
        let c = try await client(all, token: nil)
        do {
            _ = try await c.identity.subject()
            XCTFail("asked without a token")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.noToken)
        }
    }
}
