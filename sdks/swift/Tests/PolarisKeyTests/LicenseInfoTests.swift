// SP-S02 (notes/SDK-PARITY-PASS.md §3.3): `isEntitled` follows the gate (S-19 G11),
// `licenseInfo()` and `entitlementValue()` read the verified licence, `isEnabled(flag:)` reads a
// catalog flag, and the typed config getters read the effective config value.

import Foundation
import PolarisKey
import PolarisKeyConfig
import PolarisKeyCore
import PolarisKeyLicense
import XCTest

final class LicenseInfoTests: XCTestCase {
    private func client(revoked: Bool = false, token: Bool = true) async throws -> PolarisKeyClient {
        let signer = TestSigner(kid: "info-key")
        let t = Int(Date().timeIntervalSince1970)
        let store = InMemoryStore(deviceId: "dev")
        if token { await store.setToken("pkeyt_test") }
        await store.writeCache(
            CacheRecord(
                docs: [
                    .license: signer.sign(
                        Fixtures.license(
                            licenseId: "lic_info", issuedAt: t,
                            entitlements: [
                                "pro": Fixtures.entry(.bool(true), .enforced),
                                "license.tier": Fixtures.entry(.string("pro"), .enforced),
                                "license.tierLabel": Fixtures.entry(.string("Pro"), .enforced),
                                "deviceLimit": Fixtures.entry(.int(3), .enforced),
                                "channels": Fixtures.entry(
                                    .array([.string("stable"), .string("beta")]), .enforced),
                            ])),
                    .config: signer.sign(
                        Fixtures.config(
                            issuedAt: t,
                            config: [
                                "ui.dark": Fixtures.entry(.bool(true)),
                                "net.retries": Fixtures.entry(.int(4)),
                                "net.ratio": Fixtures.entry(.double(0.5)),
                                "ui.theme": Fixtures.entry(.string("violet")),
                                "ui.window": Fixtures.entry(
                                    .object(["width": .int(800), "height": .int(600)])),
                            ])),
                ],
                lastSyncUnauthorized: revoked))
        return try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: signer.trust, trustRefresh: false, store: store,
                transport: ExplodingTransport(), expectedServices: [.license, .config]))
    }

    // @pkey-feature license.entitlements
    func testIsEntitledIsFalseOnceTheGateIsNotUsable() async throws {
        let ok = try await client()
        let pro = await ok.license.isEntitled("pro")
        XCTAssertTrue(pro)
        let flag = await ok.isEnabled(flag: "pro")
        XCTAssertTrue(flag)

        // G11: the cached document still lists `pro`, but the last sync was a hard 401.
        let revoked = try await client(revoked: true)
        let status = await revoked.status().status
        XCTAssertEqual(status, .revoked)
        let after = await revoked.license.isEntitled("pro")
        XCTAssertFalse(after)
        let flagAfter = await revoked.isEnabled(flag: "pro")
        XCTAssertFalse(flagAfter)
        let value = await revoked.license.entitlementValue("deviceLimit")
        XCTAssertNil(value)

        // Never activated: no token, so the gate is needs-activation.
        let fresh = try await client(token: false)
        let freshPro = await fresh.license.isEntitled("pro")
        XCTAssertFalse(freshPro)
    }

    // @pkey-feature license.entitlements
    func testLicenseInfoAndEntitlementValue() async throws {
        let c = try await client()
        let maybeInfo = await c.licenseInfo()
        let info = try XCTUnwrap(maybeInfo)
        XCTAssertEqual(info.licenseId, "lic_info")
        XCTAssertEqual(info.tier, "pro")
        XCTAssertEqual(info.tierLabel, "Pro")
        XCTAssertEqual(info.deviceLimit, 3)
        XCTAssertEqual(info.entitledChannels, ["stable", "beta"])
        XCTAssertEqual(info.profile?.email, "a@e.com")
        let seats = await c.license.entitlementValue("deviceLimit")
        XCTAssertEqual(seats, .int(3))
        let missing = await c.license.entitlementValue("nope")
        XCTAssertNil(missing)
    }

    // @pkey-feature config.resolve
    func testTypedConfigGetters() async throws {
        struct Window: Decodable, Equatable { let width: Int; let height: Int }
        let c = try await client()
        let dark = await c.config.bool("ui.dark", default: false)
        XCTAssertTrue(dark)
        let retries = await c.config.int("net.retries", default: 0)
        XCTAssertEqual(retries, 4)
        let ratio = await c.config.double("net.ratio", default: 0)
        XCTAssertEqual(ratio, 0.5)
        let theme = await c.config.string("ui.theme", default: "x")
        XCTAssertEqual(theme, "violet")
        let window = await c.config.decode("ui.window", as: Window.self)
        XCTAssertEqual(window, Window(width: 800, height: 600))
        // Absent or the wrong type: the default.
        let wrong = await c.config.int("ui.theme", default: 7)
        XCTAssertEqual(wrong, 7)
        let absent = await c.config.string("nope", default: "d")
        XCTAssertEqual(absent, "d")
        let notDecodable = await c.config.decode("ui.theme", as: Window.self)
        XCTAssertNil(notDecodable)
    }
}
