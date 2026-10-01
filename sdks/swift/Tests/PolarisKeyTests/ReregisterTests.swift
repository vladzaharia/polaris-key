// @pkey-feature license.reregister
//
// Re-register on 401 for licence-less devices (wire contract v3 §5, P1b-06).
//
// §5: "exactly one POST /<p>/license/token re-acquire attempt, then one retry of the failed
// fetch. (Registered-without-license devices re-register instead; same single-attempt rule.)"
// These pins cover the route CHOICE (`chooseReacquireRoute`) and the client behaviour around it,
// mirroring packages/sdk-node/test/reregister.test.ts and sdks/python/tests/test_reregister.py.

import Foundation
import PolarisKey
import PolarisKeyCore
import PolarisKeyLicense
import XCTest

/// Hands out a fixed sequence of register answers; the last one repeats.
private final class RegisterScript: @unchecked Sendable {
    private let lock = NSLock()
    private var answers: [String?]
    init(_ answers: [String?]) { self.answers = answers }
    /// A token for a 200, or nil for a 403 `registration_closed`.
    func next() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return answers.count > 1 ? answers.removeFirst() : answers.first ?? nil
    }
}

final class ReregisterTests: XCTestCase {
    private let kid = "pkey-pinned-2026"
    private var vendor = TestSigner(kid: "pkey-pinned-2026")
    private var server = StubServer()

    private let licensePath = "/djdl/license/document"
    private let configPath = "/djdl/config/document"
    private let registerPath = "/djdl/devices/register"
    private let tokenPath = "/djdl/license/token"

    override func setUp() {
        super.setUp()
        vendor = TestSigner(kid: kid)
        server = StubServer()
    }

    private func nowSec() -> Int { Int(Date().timeIntervalSince1970) }

    private func client(token: String? = nil, services: [ServiceSlug]) async throws
        -> (PolarisKeyClient, InMemoryStore)
    {
        let store = InMemoryStore(deviceId: "dev")
        if let token { await store.setToken(token) }
        let c = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [kid: vendor.publicKeyB64], trustRefresh: false, store: store,
                transport: server.transport, expectedServices: services, fingerprint: false))
        return (c, store)
    }

    /// Both documents answer 200 to a bearer in `good` and 401 to anything else.
    private func routeDocs(accepting good: Set<String>) async {
        let t = nowSec()
        let license = vendor.sign(Fixtures.license(issuedAt: t))
        let config = vendor.sign(Fixtures.config(issuedAt: t))
        let ok = Set(good.map { "Bearer \($0)" })
        await server.route(licensePath) { req in
            ok.contains(req.headers["authorization"] ?? "")
                ? StubServer.Reply(status: 200, body: license, headers: ["ETag": "l1"])
                : StubServer.Reply(status: 401, body: #"{"error":{"code":"unauthorized"}}"#)
        }
        await server.route(configPath) { req in
            ok.contains(req.headers["authorization"] ?? "")
                ? StubServer.Reply(status: 200, body: config, headers: ["ETag": "c1"])
                : StubServer.Reply(status: 401, body: #"{"error":{"code":"unauthorized"}}"#)
        }
    }

    private func routeRegister(_ answers: [String?]) async {
        let script = RegisterScript(answers)
        await server.route(registerPath) { _ in
            guard let token = script.next() else {
                return StubServer.Reply(
                    status: 403, body: #"{"error":{"code":"registration_closed"}}"#)
            }
            return StubServer.Reply(body: #"{"token":"\#(token)","deviceId":"dev"}"#)
        }
    }

    private func count(_ path: String) async -> Int {
        await server.requests(forPath: path).count
    }

    // ── The path-selection rule ──────────────────────────────────────────────────────────

    func testALicensedDeviceUsesLicenseToken() {
        for source: TokenSource? in [.activate, .enroll, .signin, .reacquire, nil] {
            XCTAssertEqual(
                chooseReacquireRoute(licenseEnabled: true, source: source), .licenseToken)
        }
    }

    func testLicenseDisabledAlwaysReregisters() {
        for source: TokenSource? in [.activate, .register, nil] {
            XCTAssertEqual(
                chooseReacquireRoute(licenseEnabled: false, source: source), .devicesRegister)
        }
    }

    func testATokenMintedByRegisterReregisters() {
        XCTAssertEqual(
            chooseReacquireRoute(licenseEnabled: true, source: .register), .devicesRegister)
    }

    // ── The client ───────────────────────────────────────────────────────────────────────

    func testALicensedDeviceStillUsesLicenseToken() async throws {
        await routeDocs(accepting: ["pkeyt_rotated"])
        await server.reply(
            "/djdl/license/activate", body: #"{"token":"pkeyt_activated","schemaVersion":1}"#)
        await server.reply(tokenPath, body: #"{"token":"pkeyt_rotated","schemaVersion":1}"#)
        let (c, _) = try await client(services: [.license, .config])

        // Activation's own sync 401s on the fresh token: one /license/token, then the retry.
        guard case .ok = await c.activate(key: "pkey_k") else { return XCTFail("activate") }
        let tokens = await count(tokenPath)
        let registers = await count(registerPath)
        XCTAssertEqual(tokens, 1)
        XCTAssertEqual(registers, 0)
        let state = await c.syncState()
        XCTAssertFalse(state.lastSyncUnauthorized)
    }

    func testALicenceLessDeviceReregistersWithNoAuthorizationAndRetriesOnce() async throws {
        await routeDocs(accepting: ["pkeyt_reg2"])
        await routeRegister(["pkeyt_reg1", "pkeyt_reg2"])
        let (c, store) = try await client(services: [.license, .config])
        guard case .ok = await c.register() else { return XCTFail("register") }

        let r = await c.sync()
        // Both documents 401 IN PARALLEL on the first token and share ONE re-register.
        let registers = await server.requests(forPath: registerPath)
        XCTAssertEqual(registers.count, 2, "register() plus exactly one re-register")
        XCTAssertNil(registers.last?.headers["authorization"], "re-register sends no bearer")
        XCTAssertEqual(registers.last?.method, "POST")
        let tokens = await count(tokenPath)
        XCTAssertEqual(tokens, 0)
        let stored = await store.getToken()
        XCTAssertEqual(stored, "pkeyt_reg2")
        XCTAssertFalse(r.unauthorized)
        XCTAssertEqual(r.documents[.license], .applied)
        XCTAssertEqual(r.documents[.config], .applied)
    }

    func testTwoParallel401sCauseExactlyOneRegisterCall() async throws {
        await routeDocs(accepting: [])
        await routeRegister(["pkeyt_reg1"])
        let (c, _) = try await client(services: [.license, .config])
        guard case .ok = await c.register() else { return XCTFail("register") }

        let r = await c.sync()
        let registers = await count(registerPath)
        XCTAssertEqual(registers, 2, "register() plus exactly one re-register for both 401s")
        XCTAssertTrue(r.unauthorized)
    }

    func testAProductWithLicenseDisabledReregistersWithNoAuthorization() async throws {
        await routeDocs(accepting: ["pkeyt_new"])
        await routeRegister(["pkeyt_new"])
        let (c, _) = try await client(token: "pkeyt_old", services: [.config])

        let r = await c.sync()
        let licenseFetches = await count(licensePath)
        let tokens = await count(tokenPath)
        let registers = await server.requests(forPath: registerPath)
        XCTAssertEqual(licenseFetches, 0)
        XCTAssertEqual(tokens, 0)
        XCTAssertEqual(registers.count, 1)
        XCTAssertNil(registers.first?.headers["authorization"])
        XCTAssertEqual(r.documents[.config], .applied)
    }

    /// A licensed device with an empty cache and a licence-less one look the same after a
    /// restart; the recorded `sync-errors` transcript pins this state to /license/token.
    func testAfterARestartWithLicenseEnabledAnUnknownSourceKeepsLicenseToken() async throws {
        await routeDocs(accepting: ["pkeyt_rotated"])
        await server.reply(tokenPath, body: #"{"token":"pkeyt_rotated","schemaVersion":1}"#)
        let (c, _) = try await client(token: "pkeyt_old", services: [.license, .config])

        _ = await c.sync()
        let tokens = await count(tokenPath)
        let registers = await count(registerPath)
        XCTAssertEqual(tokens, 1)
        XCTAssertEqual(registers, 0)
    }

    func testRegistrationClosedRecordsTheHard401WithNoSecondAttempt() async throws {
        await routeDocs(accepting: [])
        await routeRegister(["pkeyt_reg1", nil])
        let (c, store) = try await client(services: [.license, .config])
        guard case .ok = await c.register() else { return XCTFail("register") }

        let r = await c.sync()
        let registers = await count(registerPath)
        let tokens = await count(tokenPath)
        let licenseFetches = await count(licensePath)
        let configFetches = await count(configPath)
        XCTAssertEqual(registers, 2, "register() plus the one refused attempt")
        XCTAssertEqual(tokens, 0)
        XCTAssertEqual(licenseFetches, 1, "no retry after a failed attempt")
        XCTAssertEqual(configFetches, 1)
        XCTAssertTrue(r.unauthorized)
        let state = await c.syncState()
        XCTAssertTrue(state.lastSyncUnauthorized)
        let stored = await store.getToken()
        XCTAssertEqual(stored, "pkeyt_reg1")
    }

    // ── Edge-mint ────────────────────────────────────────────────────────────────────────

    private let mintPath = "/djdl/config/mint/recipe-a/token"

    /// The mint answers 200 to a bearer in `good` and 401 to anything else.
    private func routeMint(accepting good: Set<String>) async {
        let ok = Set(good.map { "Bearer \($0)" })
        let expiresAt = nowSec() + 3600
        await server.route(mintPath) { req in
            ok.contains(req.headers["authorization"] ?? "")
                ? StubServer.Reply(body: #"{"token":"edge_minted","expiresAt":\#(expiresAt)}"#)
                : StubServer.Reply(status: 401, body: #"{"error":{"code":"unauthorized"}}"#)
        }
    }

    /// The edge-mint's own single re-acquire goes through the facade's one §5 closure, so it
    /// takes the same route a document fetch's would: a licence-less device has no
    /// license/token to take.
    func testAnEdgeMint401OnARegisteredDeviceReregistersOnceThenRetries() async throws {
        await routeMint(accepting: ["pkeyt_reg2"])
        await routeRegister(["pkeyt_reg1", "pkeyt_reg2"])
        let (c, store) = try await client(services: [.license, .config])
        guard case .ok = await c.register() else { return XCTFail("register") }

        let minted = try await c.config.mintToken("recipe-a")
        XCTAssertEqual(minted.token, "edge_minted")
        let registers = await server.requests(forPath: registerPath)
        XCTAssertEqual(registers.count, 2, "register() plus exactly one re-register")
        XCTAssertNil(registers.last?.headers["authorization"], "re-register sends no bearer")
        let tokens = await count(tokenPath)
        XCTAssertEqual(tokens, 0)
        let mints = await server.requests(forPath: mintPath)
        XCTAssertEqual(
            mints.map { $0.headers["authorization"] }, ["Bearer pkeyt_reg1", "Bearer pkeyt_reg2"])
        let stored = await store.getToken()
        XCTAssertEqual(stored, "pkeyt_reg2")
    }

    func testAnEdgeMint401WhoseReregisterIsRefusedFailsAfterOneAttempt() async throws {
        await routeMint(accepting: [])
        await routeRegister(["pkeyt_reg1", nil])
        let (c, _) = try await client(services: [.license, .config])
        guard case .ok = await c.register() else { return XCTFail("register") }

        do {
            _ = try await c.config.mintToken("recipe-a")
            XCTFail("expected unauthorized")
        } catch let error as PolarisError {
            XCTAssertEqual(error.code, "unauthorized")
        }
        let registers = await count(registerPath)
        let tokens = await count(tokenPath)
        let mints = await count(mintPath)
        XCTAssertEqual(registers, 2, "register() plus the one refused attempt")
        XCTAssertEqual(tokens, 0)
        XCTAssertEqual(mints, 1, "no retry after a failed attempt")
    }
}
