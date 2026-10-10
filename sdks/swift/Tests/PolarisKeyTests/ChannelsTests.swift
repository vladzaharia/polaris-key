// @pkey-feature license.channels
//
// `license.entitledChannels()` — the Worker's answer for the same document (P1b-07, PARITY §5.2).
//
// The fixture table below is the SAME table every SDK's channel test runs (Node
// test/channels.test.ts, Python tests/test_channels.py, React test/channels.test.ts), so for one
// `channels` entitlement every SDK returns one list. The expectations are the Worker's own
// `entitledChannels` (packages/worker/src/core/licensing/entitlements.ts): the string values in order, as
// granted (no alias rewriting, no deduplication), and `["stable"]` when the entitlement is absent
// or not an array — which is the change P1b-07 made here: this SDK used to answer `[]`.

import Foundation
import PolarisKey
import PolarisKeyCore
import PolarisKeyLicense
import XCTest

final class ChannelsTests: XCTestCase {
    /// (name, the `channels` entitlement's value (nil ⇒ absent), the expected list).
    private let fixtures: [(String, JSONValue?, [String])] = [
        ("absent", nil, ["stable"]),
        ("stable only", .array([.string("stable")]), ["stable"]),
        ("beta", .array([.string("beta")]), ["beta"]),
        (
            "order kept", .array([.string("pr-42"), .string("stable"), .string("beta")]),
            ["pr-42", "stable", "beta"]
        ),
        ("aliases are raw grants", .array([.string("staging"), .string("latest")]), ["staging", "latest"]),
        ("duplicates kept", .array([.string("beta"), .string("beta")]), ["beta", "beta"]),
        (
            "non-strings dropped",
            .array([.string("beta"), .int(7), .null, .bool(true), .object(["a": .int(1)]), .string("pr")]),
            ["beta", "pr"]
        ),
        ("empty array", .array([]), []),
        ("a string, not an array", .string("beta"), ["stable"]),
        ("null", .null, ["stable"]),
        ("an object", .object(["beta": .bool(true)]), ["stable"]),
    ]

    private func client(channels: JSONValue?) async throws -> PolarisKeyClient {
        let signer = TestSigner(kid: "channels-key")
        let t = Int(Date().timeIntervalSince1970)
        var entitlements: [String: ManagedEntry] = ["polarisVpn": Fixtures.entry(.bool(true), .enforced)]
        if let channels { entitlements["channels"] = Fixtures.entry(channels, .enforced) }
        let store = InMemoryStore(deviceId: "dev")
        await store.setToken("pkeyt_test")
        await store.writeCache(
            CacheRecord(docs: [
                .license: signer.sign(Fixtures.license(issuedAt: t, entitlements: entitlements))
            ]))
        return try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: signer.trust, trustRefresh: false, store: store,
                transport: ExplodingTransport(), expectedServices: [.license]))
    }

    func testEntitledChannelsMatchesTheWorkerOverTheSharedFixtures() async throws {
        for (name, value, want) in fixtures {
            let c = try await client(channels: value)
            let got = await c.license.entitledChannels()
            XCTAssertEqual(got, want, name)
        }
    }

    func testNoLicenceDocumentIsTheStableFloor() async throws {
        let c = try await PolarisKeyClient.createLocal(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], store: InMemoryStore(deviceId: "dev")))
        let got = await c.license.entitledChannels()
        XCTAssertEqual(got, ["stable"])
    }
}
