// @pkey-feature core.errors
//
// UK-49: the device token never reaches a log through `ActivationResult`; `JSONValue` reads as
// JSON; `StoreError` explains itself; `client.update` names refused pins instead of calling them
// missing; `client.license.deactivate()` raises the licence event.

import Foundation
import PolarisKey
import PolarisKeyCore
import PolarisKeyLicense
import PolarisKeyUpdate
import XCTest

final class RedactionAndErrorsTests: XCTestCase {
    private let token = "pkeyt_SECRETSECRETSECRETSECRET"

    func testActivationResultNeverPrintsItsToken() {
        let result = ActivationResult.ok(token: token, schemaVersion: 3)
        var dumped = ""
        dump(result, to: &dumped)
        for text in [
            String(describing: result), String(reflecting: result), "\(result)", dumped,
            "\(Optional(result) as Any)", String(describing: [result]),
        ] {
            XCTAssertFalse(text.contains("pkeyt_"), text)
            XCTAssertFalse(text.contains("SECRET"), text)
        }
        XCTAssertTrue(String(describing: result).contains("<redacted>"))
        XCTAssertTrue(dumped.contains("<redacted>"))
        // The value itself is intact: a pattern match still reads the token.
        guard case .ok(let t, _) = result else { return XCTFail() }
        XCTAssertEqual(t, token)
    }

    func testOtherActivationResultsStillDescribeThemselves() {
        XCTAssertTrue(
            String(describing: ActivationResult.deviceLimit(limit: 2, deviceCount: 2, manageURL: nil))
                .contains("deviceLimit"))
        XCTAssertTrue(String(describing: ActivationResult.unauthorized).contains("unauthorized"))
        XCTAssertTrue(
            String(describing: ActivationResult.refused(code: "x", status: 400, message: "no"))
                .contains("refused"))
    }

    func testJSONValueReadsAsJSON() {
        let value = JSONValue.object([
            "limit": .int(3), "name": .string("a \"b\""), "on": .bool(true), "none": .null,
            "tags": .array([.string("x"), .double(1.5)]),
        ])
        XCTAssertEqual(
            String(describing: value),
            #"{"limit": 3, "name": "a \"b\"", "none": null, "on": true, "tags": ["x", 1.5]}"#)
        XCTAssertEqual(String(reflecting: value), String(describing: value))
        XCTAssertEqual(String(describing: JSONValue.int(4)), "4")
    }

    func testStoreErrorExplainsItself() {
        let missing = StoreError.keychain(-34018).localizedDescription
        XCTAssertTrue(missing.contains("-34018"), missing)
        XCTAssertTrue(missing.contains("entitlement"), missing)
        XCTAssertTrue(StoreError.keychain(-25308).localizedDescription.contains("-25308"))
        XCTAssertFalse(StoreError.encoding.localizedDescription.contains("error 1"))
        XCTAssertTrue(StoreError.io(path: "/x", code: 13).localizedDescription.contains("/x"))
    }

    func testLicenseDeactivateRaisesTheLicenceEvent() async throws {
        let signer = TestSigner(kid: "uk49-key")
        let t = Int(Date().timeIntervalSince1970)
        let store = InMemoryStore(deviceId: "dev")
        await store.setToken("pkeyt_test")
        await store.writeCache(
            CacheRecord(docs: [
                .license: signer.sign(Fixtures.license(licenseId: "lic_uk49", issuedAt: t, entitlements: [:]))
            ]))
        let server = StubServer()
        let client = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: signer.trust, trustRefresh: false, store: store,
                transport: server.transport, expectedServices: [.license], fingerprint: false))
        var events = client.events.makeAsyncIterator()
        // The ROOT entry point is not the one under test: the sub-client is.
        try await client.license.deactivate()
        let first = await events.next()
        XCTAssertEqual(first, .license(status: .needsActivation, previous: .ok))
    }

    func testRefusedUpdatePinsAreNamedNotReportedMissing() async throws {
        let signer = TestSigner(kid: "uk49-pin")
        let server = StubServer()
        // A release key that is also a trust pin is refused at construction.
        let client = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: signer.trust, trustRefresh: false,
                store: InMemoryStore(deviceId: "dev"), transport: server.transport,
                expectedServices: [.license], fingerprint: false,
                pinnedReleaseKeys: signer.trust))
        do {
            _ = try await client.update.decide()
            XCTFail("decide() should throw")
        } catch let error as PolarisError {
            XCTAssertEqual(error.code, ErrorCode.invalidOptions)
        }
    }

    func testUpdateNotConfiguredIsNotLicensingCopy() async throws {
        let server = StubServer()
        let client = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], trustRefresh: false, store: InMemoryStore(deviceId: "dev"),
                transport: server.transport, expectedServices: [.license], fingerprint: false))
        do {
            _ = try await client.update.decide()
            XCTFail("decide() should throw")
        } catch let error as PolarisError {
            XCTAssertEqual(error.code, ErrorCode.notConfigured)
            XCTAssertFalse(error.localizedDescription.lowercased().contains("licens"))
            XCTAssertTrue(error.localizedDescription.contains("Updates"))
        }
    }
}
