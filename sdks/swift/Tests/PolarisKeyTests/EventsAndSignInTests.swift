// @pkey-feature core.sync identity.devicecode
//
// SP-S04 and SP-S11 (notes/SDK-PARITY-PASS.md §3.11, §3.12): `client.changes` fans out to every
// subscriber and reports activation, deactivation and document changes; the device-code poll
// carries P1-07's opt-in (`confirmIdentity`, then `attachLicense` with the device bearer) and a
// ready poll carries the identity and what was attached; `signInWithBrowser()` opens the
// pre-filled page and waits; `signOut()` wipes the credential.

import Foundation
import PolarisKey
import PolarisKeyCore
import PolarisKeyIdentity
import XCTest

@MainActor
final class FakeBrowser: SignInBrowser {
    var opened: [URL] = []
    var closed = 0
    func open(_ url: URL) async throws { opened.append(url) }
    func close() { closed += 1 }
}

final class EventsAndSignInTests: XCTestCase {
    private var server = StubServer()

    override func setUp() {
        super.setUp()
        server = StubServer()
    }

    private func client(token: String? = nil, services: [ServiceSlug] = [.license, .identity])
        async throws -> PolarisKeyClient
    {
        let store = InMemoryStore(deviceId: "dev")
        if let token { await store.setToken(token) }
        return try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], trustRefresh: false, store: store, transport: server.transport,
                expectedServices: services, fingerprint: false))
    }

    private func next(_ it: inout AsyncStream<PolarisKeyEvent>.Iterator) async -> PolarisKeyEvent? {
        await it.next()
    }

    func testChangesFanOutToEverySubscriber() async throws {
        await server.reply(
            "/djdl/license/activate", body: #"{"token":"pkeyt_new","schemaVersion":1}"#)
        let c = try await client()
        var a = c.changes.makeAsyncIterator()
        var b = c.changes.makeAsyncIterator()
        XCTAssertEqual(c.events.subscriberCount, 2)
        _ = await c.activate(key: "PKEY-1")
        let first = await next(&a)
        let second = await next(&b)
        XCTAssertEqual(first?.kind, "license")
        XCTAssertEqual(second?.kind, "license")

        try await c.deactivate()
        var sawNeedsActivation = false
        while let e = await next(&a) {
            if case .license(let state) = e, state.status == .needsActivation {
                sawNeedsActivation = true
                break
            }
        }
        XCTAssertTrue(sawNeedsActivation)
    }

    func testADroppedSubscriberIsRemoved() async throws {
        let c = try await client()
        let task = Task {
            for await _ in c.changes {}
        }
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(c.events.subscriberCount, 1)
        task.cancel()
        try await Task.sleep(nanoseconds: 50_000_000)
        c.emit(.config(key: "x"))
        XCTAssertEqual(c.events.subscriberCount, 0)
    }

    private func startFlow() async {
        await server.reply(
            "/djdl/identity/auth/device/start",
            body: #"{"deviceCode":"dc","userCode":"ABCD-EFGH","verificationUri":"https://key.example/d","verificationUriComplete":"https://key.example/d?user_code=ABCD-EFGH","expiresIn":600,"interval":1}"#)
    }

    func testTheAttachOptInRidesThePoll() async throws {
        await startFlow()
        await server.route("/djdl/identity/auth/device/poll") { req in
            let body = (try? JSONDecoder().decode(JSONValue.self, from: req.body ?? Data()))?
                .objectValue ?? [:]
            if body["attachLicense"] == .bool(true) {
                return StubServer.Reply(
                    body: #"{"status":"ready","token":"pkeyt_signed","schemaVersion":1,"identity":{"name":"Ada","email":"a@e.com"},"attached":"claimed"}"#)
            }
            return StubServer.Reply(
                body: #"{"status":"confirm","identity":{"name":"Ada","email":"a@e.com"},"attachable":true}"#)
        }
        let c = try await client(token: "pkeyt_enrolled")
        let prompt = try await c.identity.beginSignIn()
        let held = try await c.identity.pollSignIn(prompt, confirmIdentity: true)
        XCTAssertEqual(
            held, .confirm(identity: SignInIdentity(name: "Ada", email: "a@e.com"), attachable: true))
        let first = await server.requests(forPath: "/djdl/identity/auth/device/poll").last
        XCTAssertNil(first?.headers["authorization"], "no bearer until the player opts in")

        let done = try await c.identity.pollSignIn(prompt, attachLicense: true)
        XCTAssertEqual(
            done,
            .ready(
                SignInReady(identity: SignInIdentity(name: "Ada", email: "a@e.com"), attached: "claimed")))
        let second = await server.requests(forPath: "/djdl/identity/auth/device/poll").last
        XCTAssertEqual(second?.headers["authorization"], "Bearer pkeyt_enrolled")
        let body = try JSONDecoder().decode(JSONValue.self, from: second?.body ?? Data()).objectValue
        XCTAssertEqual(body?["confirmIdentity"], .bool(true))
        XCTAssertEqual(body?["attachLicense"], .bool(true))
    }

    func testAPlainPollSendsNoOptIn() async throws {
        await startFlow()
        await server.reply(
            "/djdl/identity/auth/device/poll",
            body: #"{"status":"ready","token":"pkeyt_signed","schemaVersion":1,"identity":{"email":"a@e.com"}}"#)
        let c = try await client()
        let prompt = try await c.identity.beginSignIn()
        let r = try await c.identity.pollSignIn(prompt)
        XCTAssertEqual(r, .ready(SignInReady(identity: SignInIdentity(email: "a@e.com"))))
        let sent = await server.requests(forPath: "/djdl/identity/auth/device/poll").last
        let body = try JSONDecoder().decode(JSONValue.self, from: sent?.body ?? Data()).objectValue
        XCTAssertNil(body?["confirmIdentity"])
        XCTAssertNil(body?["attachLicense"])
    }

    func testSignInWithBrowserOpensThePageAndWaits() async throws {
        await startFlow()
        await server.reply(
            "/djdl/identity/auth/device/poll",
            body: #"{"status":"ready","token":"pkeyt_signed","schemaVersion":1}"#)
        let c = try await client()
        let browser = await FakeBrowser()
        let r = try await c.signInWithBrowser(browser: browser)
        XCTAssertTrue(r.isReady)
        let opened = await browser.opened
        XCTAssertEqual(opened, [URL(string: "https://key.example/d?user_code=ABCD-EFGH")!])
        let token = await c.core.token
        XCTAssertEqual(token, "pkeyt_signed")

        try await c.signOut()
        let after = await c.core.token
        XCTAssertNil(after)
    }

    func testSignInRefusesWithoutIdentity() async throws {
        let c = try await client(services: [.license])
        do {
            _ = try await c.signInWithBrowser(browser: await FakeBrowser())
            XCTFail("expected service-unavailable")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, PolarisError.serviceUnavailable)
        }
    }
}
