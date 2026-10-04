import Foundation
import XCTest

@testable import PolarisKeyPlatform

/// App Attest (P6-02) through the router over FakeAppAttest: key generation, the client-data hash,
/// the typed invalid-key failure a reinstall produces, the unsupported answers and assertions.
final class AppAttestTests: XCTestCase {
    /// The Worker's challenge response carries a 43-character base64url `requestHash`.
    private let requestHash = "q8Jm3rJ0b1x2Vd4n6Q9sT0uW1yZ2aB3cD4eF5gH6iJ7"

    private func host(_ attest: any AppAttestClient) -> (PlatformHost, EventLog) {
        let h = PlatformHost(services: fakeServices(appAttest: attest))
        return (h, EventLog(h.sink))
    }

    private func call(_ h: PlatformHost, _ q: PlatformObject) -> PlatformObject {
        decodePlatformJSON(h.call(encodePlatformJSON(q))) ?? [:]
    }

    func testClientDataHashIsSHA256OfTheUTF8RequestHash() throws {
        #if canImport(CryptoKit)
        // SHA-256("abc"), the FIPS 180-2 example.
        let abc = try XCTUnwrap(appAttestClientDataHash("abc"))
        XCTAssertEqual(
            abc.map { String(format: "%02x", $0) }.joined(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        XCTAssertEqual(appAttestClientDataHash(requestHash)?.count, 32)
        #endif
    }

    func testSupportedAndCapabilities() {
        let (h, _) = host(FakeAppAttest())
        XCTAssertEqual(call(h, ["op": "app_attest_supported"]), ["ok": true, "supported": true])
        XCTAssertEqual(call(h, ["op": "capabilities"])["appAttest"], true)

        let (none, _) = host(FakeAppAttest(supported: false))
        let r = call(none, ["op": "app_attest_supported"])
        XCTAssertEqual(r["unsupported"], true)
        XCTAssertEqual(r["reason"], "runtime")
        XCTAssertEqual(call(none, ["op": "capabilities"])["appAttest"], false)
    }

    func testUnsupportedHereIsRuntimeAndSynchronous() {
        // macOS, Linux and the simulator: no req, no event, reason runtime.
        for client in [UnavailableAppAttestClient(), FakeAppAttest(supported: false)] as [any AppAttestClient] {
            let (h, _) = host(client)
            for q: PlatformObject in [
                ["op": "app_attest_attest", "requestHash": .string(requestHash)],
                ["op": "app_attest_assert", "keyId": "k", "clientData": "x"],
            ] {
                let r = call(h, q)
                XCTAssertEqual(r["unsupported"], true, "\(q)")
                XCTAssertEqual(r["reason"], "runtime", "\(q)")
                XCTAssertNil(r["req"], "\(q)")
            }
        }
    }

    func testMalformedRequests() {
        let (h, _) = host(FakeAppAttest())
        XCTAssertEqual(call(h, ["op": "app_attest_attest"])["error"], "missing_request_hash")
        XCTAssertEqual(call(h, ["op": "app_attest_attest", "requestHash": ""])["error"], "missing_request_hash")
        XCTAssertEqual(call(h, ["op": "app_attest_attest", "requestHash": "x", "keyId": ""])["error"], "bad_key_id")
        XCTAssertEqual(call(h, ["op": "app_attest_attest", "requestHash": "x", "keyId": 3])["error"], "bad_key_id")
        XCTAssertEqual(call(h, ["op": "app_attest_assert", "clientData": "x"])["error"], "missing_key_id")
        XCTAssertEqual(call(h, ["op": "app_attest_assert", "keyId": "k"])["error"], "missing_client_data")
    }

    func testAttestGeneratesAKeyAndHashesTheRequestHash() async throws {
        let fake = FakeAppAttest()
        let (h, log) = host(fake)
        let ack = call(h, ["op": "app_attest_attest", "requestHash": .string(requestHash), "keyId": .null])
        XCTAssertEqual(ack["ok"], true)
        let ev = await log.result(ack["req"])
        XCTAssertEqual(ev["ev"], "app_attest_attest")
        XCTAssertEqual(ev["ok"], true)
        XCTAssertEqual(ev["generated"], true)
        let keyId = try XCTUnwrap(ev["keyId"]?.stringValue)
        let attestation = try XCTUnwrap(ev["attestation"]?.stringValue)
        // Standard base64 of the attestation object, as the Worker's attest route takes it.
        XCTAssertEqual(Data(base64Encoded: attestation), Data("attestation:\(keyId)".utf8))
        XCTAssertEqual(fake.attested.count, 1)
        XCTAssertEqual(fake.attested.first?.keyId, keyId)
        if let expected = appAttestClientDataHash(requestHash) {
            XCTAssertEqual(fake.attested.first?.hash, expected, "clientDataHash = SHA-256(UTF-8(requestHash))")
        }

        // A stored key is attested as is (a retry after server_unavailable keeps the same key).
        let again = await log.result(
            call(h, ["op": "app_attest_attest", "requestHash": "other", "keyId": .string(keyId)])["req"])
        XCTAssertEqual(again["ok"], true)
        XCTAssertEqual(again["generated"], false)
        XCTAssertEqual(again["keyId"], .string(keyId))
    }

    func testAKeyLostToAReinstallIsTypedInvalidKey() async throws {
        let fake = FakeAppAttest()
        let (h, log) = host(fake)
        let first = await log.result(call(h, ["op": "app_attest_attest", "requestHash": .string(requestHash)])["req"])
        let keyId = try XCTUnwrap(first["keyId"]?.stringValue)
        fake.forget()
        let lost = await log.result(
            call(h, ["op": "app_attest_attest", "requestHash": .string(requestHash), "keyId": .string(keyId)])["req"])
        XCTAssertEqual(lost["ok"], false)
        XCTAssertEqual(lost["error"], "invalid_key")
        XCTAssertEqual(lost["keyId"], .string(keyId), "the failing key id comes back so the caller drops it")
        // The caller's recovery: attest again without a key id.
        let fresh = await log.result(call(h, ["op": "app_attest_attest", "requestHash": .string(requestHash)])["req"])
        XCTAssertEqual(fresh["ok"], true)
        XCTAssertEqual(fresh["generated"], true)
        XCTAssertNotEqual(fresh["keyId"], .string(keyId))
    }

    func testServerUnavailableKeepsTheGeneratedKey() async {
        let fake = FakeAppAttest()
        fake.failNext(AppAttestFailure.serverUnavailable)
        let (h, log) = host(fake)
        let ev = await log.result(call(h, ["op": "app_attest_attest", "requestHash": .string(requestHash)])["req"])
        XCTAssertEqual(ev["ok"], false)
        XCTAssertEqual(ev["error"], "server_unavailable")
        XCTAssertEqual(ev["generated"], true)
        XCTAssertNotNil(ev["keyId"]?.stringValue, "the generated key is returned for the retry")
    }

    func testFeatureUnsupportedAtRunTimeIsUnsupported() async {
        let fake = FakeAppAttest()
        fake.failNext(AppAttestFailure.featureUnsupported)
        let (h, log) = host(fake)
        let ev = await log.result(call(h, ["op": "app_attest_attest", "requestHash": .string(requestHash)])["req"])
        XCTAssertEqual(ev["unsupported"], true)
        XCTAssertEqual(ev["reason"], "runtime")
    }

    func testAttestationIsBoundedByADeadline() async {
        let fake = FakeAppAttest()
        fake.hang = true
        let service = AppAttestService(client: fake, deadline: 0.1)
        let r = await service.attest(requestHash: requestHash, keyId: nil)
        XCTAssertEqual(r["ok"], false)
        XCTAssertEqual(r["error"], "timeout")
    }

    func testAssertion() async throws {
        let fake = FakeAppAttest()
        let (h, log) = host(fake)
        let attested = await log.result(call(h, ["op": "app_attest_attest", "requestHash": .string(requestHash)])["req"])
        let keyId = try XCTUnwrap(attested["keyId"]?.stringValue)
        let ev = await log.result(
            call(h, ["op": "app_attest_assert", "keyId": .string(keyId), "clientData": "{\"path\":\"/x\"}"])["req"])
        XCTAssertEqual(ev["ev"], "app_attest_assert")
        XCTAssertEqual(ev["ok"], true)
        XCTAssertEqual(Data(base64Encoded: ev["assertion"]?.stringValue ?? ""), Data("assertion:\(keyId)".utf8))
        if let expected = appAttestClientDataHash("{\"path\":\"/x\"}") {
            XCTAssertEqual(fake.asserted.first?.hash, expected)
        }
        let unknown = await log.result(
            call(h, ["op": "app_attest_assert", "keyId": "bm9wZQ==", "clientData": "x"])["req"])
        XCTAssertEqual(unknown["error"], "invalid_key")
    }

    #if os(macOS)
    func testTheSystemServicesAnswerRuntimeOnMacOS() {
        // App Attest is iOS-only for this SDK, though DCAppAttestService exists on macOS.
        let h = PlatformHost(services: .system())
        let r = decodePlatformJSON(h.call(#"{"op":"app_attest_supported"}"#)) ?? [:]
        XCTAssertEqual(r["reason"], "runtime")
        XCTAssertEqual(decodePlatformJSON(h.call(#"{"op":"capabilities"}"#))?["appAttest"], false)
    }
    #endif
}
