// @pkey-feature core.sync identity.devicecode
//
// SP-S04 and SP-S11 (notes/SDK-PARITY-PASS.md §3.11, §3.12): `client.events` fans out to every
// subscriber and reports, as one event per difference, the gate status, each entitlement and
// each setting (the kinds and fields Python's `client.events` uses); the device-code poll
// carries P1-07's opt-in (`confirmIdentity`, then `attachLicense` with the device bearer) and a
// ready poll carries the identity and what was attached; `identity.signInWithBrowser()` opens
// the pre-filled page and waits; `identity.signOut()` wipes the credential; `identity.current()`
// reads the signed profile.

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

    /// A client holding a cached, signed licence (`pro`, `deviceLimit`) and config (`ui.theme`).
    private func licensedClient(token: Bool, services: [ServiceSlug] = [.license, .config, .identity])
        async throws -> PolarisKeyClient
    {
        let signer = TestSigner(kid: "events-key")
        let t = Int(Date().timeIntervalSince1970)
        let store = InMemoryStore(deviceId: "dev")
        if token { await store.setToken("pkeyt_test") }
        await store.writeCache(
            CacheRecord(docs: [
                .license: signer.sign(
                    Fixtures.license(
                        licenseId: "lic_ev", issuedAt: t,
                        entitlements: [
                            "pro": Fixtures.entry(.bool(true), .enforced),
                            "deviceLimit": Fixtures.entry(.int(3), .enforced),
                        ])),
                .config: signer.sign(
                    Fixtures.config(issuedAt: t, config: ["ui.theme": Fixtures.entry(.string("violet"))])),
            ]))
        return try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: signer.trust, trustRefresh: false, store: store, transport: server.transport,
                expectedServices: services, fingerprint: false))
    }

    /// Collect events until `stop` holds for one.
    private func collect(
        _ it: inout AsyncStream<PolarisKeyEvent>.Iterator, until stop: (PolarisKeyEvent) -> Bool
    ) async -> [PolarisKeyEvent] {
        var out: [PolarisKeyEvent] = []
        while let e = await next(&it) {
            out.append(e)
            if stop(e) { break }
        }
        return out
    }

    func testEventsFanOutToEverySubscriber() async throws {
        let c = try await licensedClient(token: true)
        var a = c.events.makeAsyncIterator()
        var b = c.events.makeAsyncIterator()
        XCTAssertEqual(c.eventHub.subscriberCount, 2)
        try await c.deactivate()
        let first = await next(&a)
        let second = await next(&b)
        XCTAssertEqual(first, .license(status: .needsActivation, previous: .ok))
        XCTAssertEqual(second, first)
    }

    // Deactivation and sign-out: the gate moves, and every entitlement now reads nil (S-19 G11),
    // exactly the events Python's `client.events` emits.
    func testDeactivationEmitsLicenseThenEveryEntitlement() async throws {
        let c = try await licensedClient(token: true)
        var it = c.events.makeAsyncIterator()
        try await c.identity.signOut()
        let seen = await collect(&it) { if case .entitlement(let n, _, _) = $0 { return n == "pro" }; return false }
        XCTAssertEqual(
            seen,
            [
                .license(status: .needsActivation, previous: .ok),
                .entitlement(name: "deviceLimit", value: nil, previous: .int(3)),
                .entitlement(name: "pro", value: nil, previous: .bool(true)),
            ])
        let token = await c.core.token
        XCTAssertNil(token)
    }

    func testActivationEmitsLicenseAndEntitlements() async throws {
        await server.reply(
            "/djdl/license/activate", body: #"{"token":"pkeyt_new","schemaVersion":1}"#)
        let c = try await licensedClient(token: false, services: [.license])
        var it = c.events.makeAsyncIterator()
        _ = await c.activate(key: "PKEY-1")
        let seen = await collect(&it) { if case .entitlement(let n, _, _) = $0 { return n == "pro" }; return false }
        XCTAssertEqual(seen.first, .license(status: .ok, previous: .needsActivation))
        XCTAssertTrue(seen.contains(.entitlement(name: "pro", value: .bool(true), previous: nil)))
    }

    func testNothingIsEmittedWhenNothingMoved() async throws {
        let c = try await licensedClient(token: true)
        var it = c.events.makeAsyncIterator()
        _ = await c.syncIfStale(minimumInterval: 0)
        c.emit(.store(reason: "sentinel", detail: nil))
        let e = await next(&it)
        XCTAssertEqual(e, .store(reason: "sentinel", detail: nil), "a no-op sync emits nothing")
    }

    func testEventKindsMatchTheSharedVocabulary() {
        XCTAssertEqual(
            PolarisKeyEvent.kinds,
            ["license", "entitlement", "config", "updateAvailable", "packs", "store"])
        let samples: [PolarisKeyEvent] = [
            .license(status: .ok, previous: .needsActivation),
            .entitlement(name: "pro", value: .bool(true), previous: nil),
            .config(key: "k", value: .int(1), previous: nil, source: .local),
            .updateAvailable(version: "2.0.0", action: "binary", mandatory: false, channel: "stable"),
            .packs(pack: "p", phase: "download", done: 1, total: 2),
            .store(reason: "store-failed", detail: nil),
        ]
        XCTAssertEqual(samples.map(\.kind), PolarisKeyEvent.kinds)
    }

    func testADroppedSubscriberIsRemoved() async throws {
        let c = try await client()
        let task = Task {
            for await _ in c.events {}
        }
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(c.eventHub.subscriberCount, 1)
        task.cancel()
        try await Task.sleep(nanoseconds: 50_000_000)
        c.emit(.store(reason: "x", detail: nil))
        XCTAssertEqual(c.eventHub.subscriberCount, 0)
    }

    func testCurrentReadsTheSignedProfile() async throws {
        let c = try await licensedClient(token: true)
        let me = await c.identity.current()
        XCTAssertEqual(me?.email, "a@e.com")
        let none = try await client()
        let nobody = await none.identity.current()
        XCTAssertNil(nobody)
    }

    func testAStandaloneIdentityClientRefusesSignOut() async throws {
        let core = try CoreContext(
            options: CoreOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], store: InMemoryStore(deviceId: "dev"), transport: server.transport))
        let identity = IdentityClient(core: core)
        do {
            try await identity.signOut()
            XCTFail("expected invalid-options")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.invalidOptions)
        }
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
        let r = try await c.identity.signInWithBrowser(browser: browser)
        XCTAssertTrue(r.isReady)
        let opened = await browser.opened
        XCTAssertEqual(opened, [URL(string: "https://key.example/d?user_code=ABCD-EFGH")!])
        let token = await c.core.token
        XCTAssertEqual(token, "pkeyt_signed")

        try await c.identity.signOut()
        let after = await c.core.token
        XCTAssertNil(after)
    }

    func testSignInRefusesWithoutIdentity() async throws {
        let c = try await client(services: [.license])
        do {
            _ = try await c.identity.signInWithBrowser(browser: await FakeBrowser())
            XCTFail("expected service-unavailable")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, PolarisError.serviceUnavailable)
        }
    }
}
