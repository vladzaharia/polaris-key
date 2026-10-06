// @pkey-feature devices.attest
//
// `client.devices.attest()` (P6-02, notes/SDK-PARITY-PASS.md §3.10) against a fake
// DCAppAttestService and a stub Worker: challenge → attestKey over SHA-256(requestHash) → POST,
// the key id kept and reused, a dead key replaced in the same call, the typed N/As, and the
// attest-and-retry on a 403 `attestation_required` edge-mint.

import CryptoKit
import Foundation
import PolarisKey
import PolarisKeyCore
import PolarisKeyPlatform
import XCTest

final class FakeAttest: AppAttestClient, @unchecked Sendable {
    private let lock = NSLock()
    var available = true
    var knownKeys: Set<String> = []
    var generated: [String] = []
    var hashes: [Data] = []
    var failNext: String?

    func unavailable() -> PlatformUnavailable? {
        available ? nil : PlatformUnavailable(reason: "runtime", detail: "no App Attest")
    }
    func generateKey() async throws -> String {
        lock.withLock {
            let id = "key\(generated.count + 1)"
            generated.append(id)
            knownKeys.insert(id)
            return id
        }
    }
    func attestKey(_ keyId: String, clientDataHash: Data) async throws -> Data {
        try lock.withLock {
            hashes.append(clientDataHash)
            if let code = failNext {
                failNext = nil
                throw AppAttestFailure(code: code, message: code)
            }
            guard knownKeys.contains(keyId) else {
                throw AppAttestFailure(code: AppAttestFailure.invalidKey, message: "unknown key")
            }
            return Data("attestation-\(keyId)".utf8)
        }
    }
    func generateAssertion(_ keyId: String, clientDataHash: Data) async throws -> Data { Data() }
}

final class MemoryKeyStore: AttestKeyStore, @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?
    init(_ value: String? = nil) { self.value = value }
    func get() -> String? { lock.withLock { value } }
    func set(_ keyId: String) { lock.withLock { value = keyId } }
    func delete() { lock.withLock { value = nil } }
}

final class AttestTests: XCTestCase {
    private var server = StubServer()

    override func setUp() {
        super.setUp()
        server = StubServer()
    }

    private func client(
        attest: FakeAttest, keys: MemoryKeyStore, outlet: String? = nil, token: Bool = true
    ) async throws -> PolarisKeyClient {
        await server.reply(
            "/djdl/devices/attest/challenge",
            body: #"{"challenge":"ch1","requestHash":"rh1","expiresAt":1}"#)
        await server.reply(
            "/djdl/devices/attest",
            body: #"{"trustLevel":"attested","kind":"app-attest","attestedAt":1700000000}"#)
        let store = InMemoryStore(deviceId: "dev")
        if token { await store.setToken("pkeyt_dev") }
        return try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], trustRefresh: false, store: store, transport: server.transport,
                expectedServices: [.license, .config], fingerprint: false,
                attest: AttestOptions(client: attest, keyStore: keys, outletCheck: { outlet })))
    }

    func testAttestPostsTheAttestationAndKeepsTheKey() async throws {
        let fake = FakeAttest()
        let keys = MemoryKeyStore()
        let c = try await client(attest: fake, keys: keys)
        let r = await c.devices.attest()
        XCTAssertEqual(
            r,
            .attested(
                AttestOutcome(trustLevel: "attested", kind: "app-attest", attestedAt: 1_700_000_000)))
        XCTAssertEqual(keys.get(), "key1")
        XCTAssertEqual(fake.hashes.first, Data(SHA256.hash(data: Data("rh1".utf8))))
        let posted = await server.requests(forPath: "/djdl/devices/attest").first
        let body = try JSONDecoder().decode([String: String].self, from: posted?.body ?? Data())
        XCTAssertEqual(body["kind"], "app-attest")
        XCTAssertEqual(body["keyId"], "key1")
        XCTAssertEqual(body["challenge"], "ch1")
        XCTAssertEqual(body["attestation"], Data("attestation-key1".utf8).base64EncodedString())
        XCTAssertEqual(posted?.headers["authorization"], "Bearer pkeyt_dev")

        // The stored key is reused: no second key is generated.
        _ = await c.devices.attest()
        XCTAssertEqual(fake.generated, ["key1"])
    }

    func testADeadKeyIsReplacedInTheSameCall() async throws {
        let fake = FakeAttest()
        let keys = MemoryKeyStore("restored-from-backup")
        let c = try await client(attest: fake, keys: keys)
        let r = await c.devices.attest()
        XCTAssertTrue(r.isAttested)
        XCTAssertEqual(keys.get(), "key1")
    }

    func testTypedUnsupportedAndRefusals() async throws {
        let off = FakeAttest()
        off.available = false
        let c1 = try await client(attest: off, keys: MemoryKeyStore())
        guard case .unsupported(let u) = await c1.devices.attest() else {
            return XCTFail("expected unsupported")
        }
        XCTAssertEqual(u.reason, UnsupportedReason.runtime)
        XCTAssertEqual(u.feature, Feature.devicesAttest)

        let c2 = try await client(attest: FakeAttest(), keys: MemoryKeyStore(), outlet: "sideloaded")
        guard case .unsupported(let o) = await c2.devices.attest() else {
            return XCTFail("expected unsupported")
        }
        XCTAssertEqual(o.reason, UnsupportedReason.outlet)

        let c3 = try await client(attest: FakeAttest(), keys: MemoryKeyStore(), token: false)
        let noToken = await c3.devices.attest()
        XCTAssertEqual(noToken.code, ErrorCode.noToken)

        let c4 = try await client(attest: FakeAttest(), keys: MemoryKeyStore())
        await server.reply(
            "/djdl/devices/attest", status: 422, body: #"{"error":"attestation_rejected"}"#)
        let rejected = await c4.devices.attest()
        XCTAssertEqual(rejected, .refused(code: "attestation_rejected", status: 422, message: nil))
    }

    /// §3.10: a 403 `attestation_required` edge-mint attests once and retries once.
    func testMintAttestsAndRetriesOnce() async throws {
        let fake = FakeAttest()
        let c = try await client(attest: fake, keys: MemoryKeyStore())
        let calls = LockedValue(0)
        await server.route("/djdl/config/mint/maps/token") { _ in
            let n = calls.with { $0 += 1; return $0 }
            return n == 1
                ? StubServer.Reply(status: 403, body: #"{"error":"attestation_required"}"#)
                : StubServer.Reply(body: #"{"token":"minted","expiresAt":4102444800}"#)
        }
        let minted = try await c.config.mintToken("maps")
        XCTAssertEqual(minted.token, "minted")
        XCTAssertEqual(calls.current, 2)
        let attests = await server.requests(forPath: "/djdl/devices/attest")
        XCTAssertEqual(attests.count, 1)
    }

    /// Without attestation the refusal stands, typed.
    func testMintRefusalStandsWhereAttestationCannotRun() async throws {
        let off = FakeAttest()
        off.available = false
        let c = try await client(attest: off, keys: MemoryKeyStore())
        await server.reply(
            "/djdl/config/mint/maps/token", status: 403, body: #"{"error":"attestation_required"}"#)
        do {
            _ = try await c.config.mintToken("maps")
            XCTFail("expected a refusal")
        } catch let e as PolarisError {
            XCTAssertEqual(e.code, ErrorCode.attestationRequired)
        }
    }
}
