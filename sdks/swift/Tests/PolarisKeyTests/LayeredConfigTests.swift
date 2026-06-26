// Wire-v2 layered config: management-state honoring + localOverrides/env precedence, plus
// the listUserConfig()/configSource() surface. The client is seeded through an InMemoryStore
// holding a hand-built doc so no network/signing is needed.
//
// Note: awaited actor reads are hoisted into `let`s before asserting — `await` is not
// permitted inside XCTAssert*'s non-async autoclosure arguments.

import Foundation
import XCTest

@testable import PolarisKey

final class LayeredConfigTests: XCTestCase {
    private let trust = PolarisTrust(pinnedKeys: ["k": "x"])

    /// Build a doc whose config carries one entry per relevant state.
    private func makeDoc() -> ManagedConfigDoc {
        ManagedConfigDoc(
            schemaVersion: 1, aud: "djdl", iss: POLARIS_ISSUER,
            licenseId: "lic", deviceId: "dev", issuedAt: 1, expiresAt: 2, graceUntil: 3,
            profile: DocProfile(name: "n", firstName: "f", email: "e", activatedAt: 0),
            payload: ManagedPayload(
                config: [
                    "run.concurrency": ManagedEntry(
                        state: .enforced, value: .int(4), updatedAt: 100),
                    "ui.theme": ManagedEntry(
                        state: .default, value: .string("dark"), updatedAt: 200),
                    "proxy.secret": ManagedEntry(
                        state: .hidden, value: .string("s"), updatedAt: 300),
                ]))
    }

    /// Seed an InMemoryStore with a cache record holding the doc, then create a client.
    private func client(
        localOverrides: [String: JSONValue]? = nil
    ) async -> PolarisKeyClient {
        let store = InMemoryStore(deviceId: "dev")
        await store.setToken("tok")
        await store.writeCache(CacheRecord(doc: makeDoc(), lastAcceptedIssuedAt: 1))
        return await PolarisKeyClient.create(
            options: PolarisKeyOptions(
                productSlug: "djdl", version: "1.0.0", trust: trust, store: store,
                localOverrides: localOverrides))
    }

    func testEnforcedAndHiddenAlwaysWinOverOverrides() async {
        let c = await client(localOverrides: [
            "run.concurrency": .int(99), "proxy.secret": .string("nope"),
        ])
        // Remote enforced/hidden values win even with a local override present.
        let conc = await c.config("run.concurrency", default: .int(0))
        let secret = await c.config("proxy.secret", default: .string("d"))
        let concSrc = await c.configSource("run.concurrency")
        let secretSrc = await c.configSource("proxy.secret")
        XCTAssertEqual(conc, .int(4))
        XCTAssertEqual(secret, .string("s"))
        XCTAssertEqual(concSrc, .enforced)
        XCTAssertEqual(secretSrc, .hidden)
    }

    func testDefaultStateLocalOverrideBeatsRemote() async {
        let c = await client(localOverrides: ["ui.theme": .string("light")])
        let theme = await c.config("ui.theme", default: .string("d"))
        let src = await c.configSource("ui.theme")
        XCTAssertEqual(theme, .string("light"))
        XCTAssertEqual(src, .local)
    }

    func testDefaultStateFallsBackToRemoteThenFallback() async {
        let c = await client()
        // No override → remote default value.
        let theme = await c.config("ui.theme", default: .string("d"))
        let themeSrc = await c.configSource("ui.theme")
        XCTAssertEqual(theme, .string("dark"))
        XCTAssertEqual(themeSrc, .remoteDefault)
        // Unknown key → caller fallback.
        let missing = await c.config("missing.key", default: .int(7))
        let missingSrc = await c.configSource("missing.key")
        XCTAssertEqual(missing, .int(7))
        XCTAssertEqual(missingSrc, .fallback)
    }

    func testEnvOverrideBeatsRemoteDefaultAndParsesJson() async {
        setenv("PKEY_CONFIG_ui__theme", "\"midnight\"", 1)
        setenv("PKEY_CONFIG_feature__count", "42", 1)
        defer {
            unsetenv("PKEY_CONFIG_ui__theme")
            unsetenv("PKEY_CONFIG_feature__count")
        }
        let c = await client()
        // Env (dots→"__") replaces a default-state remote value, parsed as JSON.
        let theme = await c.config("ui.theme", default: .string("d"))
        let themeSrc = await c.configSource("ui.theme")
        XCTAssertEqual(theme, .string("midnight"))
        XCTAssertEqual(themeSrc, .env)
        // Numeric env parses to int; with no remote entry it still applies.
        let count = await c.config("feature.count", default: .int(0))
        let countSrc = await c.configSource("feature.count")
        XCTAssertEqual(count, .int(42))
        XCTAssertEqual(countSrc, .env)
    }

    func testLocalOverrideBeatsEnvForDefaultState() async {
        setenv("PKEY_CONFIG_ui__theme", "\"midnight\"", 1)
        defer { unsetenv("PKEY_CONFIG_ui__theme") }
        let c = await client(localOverrides: ["ui.theme": .string("local-wins")])
        let theme = await c.config("ui.theme", default: .string("d"))
        let src = await c.configSource("ui.theme")
        XCTAssertEqual(theme, .string("local-wins"))
        XCTAssertEqual(src, .local)
    }

    func testEnvNonJsonFallsBackToRawString() async {
        setenv("PKEY_CONFIG_ui__theme", "not json: bare", 1)
        defer { unsetenv("PKEY_CONFIG_ui__theme") }
        let c = await client()
        let v = await c.config("ui.theme", default: .string("d"))
        XCTAssertEqual(v, .string("not json: bare"))
    }

    func testListUserConfigExcludesHiddenAndFlagsEnforced() async {
        let c = await client(localOverrides: ["ui.theme": .string("light")])
        let rows = await c.listUserConfig()
        let byKey = Dictionary(uniqueKeysWithValues: rows.map { ($0.key, $0) })
        XCTAssertNil(byKey["proxy.secret"], "hidden entries must be excluded")
        XCTAssertEqual(byKey.count, 2)
        XCTAssertEqual(byKey["run.concurrency"]?.enforced, true)
        XCTAssertEqual(byKey["run.concurrency"]?.value, .int(4))
        XCTAssertEqual(byKey["ui.theme"]?.enforced, false)
        XCTAssertEqual(byKey["ui.theme"]?.value, .string("light"))
    }

    func testDeviceManagementSurfaceCurrentOnly() async {
        let c = await client()
        let current = await c.currentDevice()
        XCTAssertEqual(current.id, "dev")
        XCTAssertEqual(current.current, true)
        XCTAssertEqual(current.status, .expired)

        do {
            _ = try await c.listDevices()
            XCTFail("expected unsupported device listing")
        } catch DeviceManagementError.unsupported {
        } catch {
            XCTFail("unexpected error: \(error)")
        }

        do {
            try await c.deauthorizeDevice("other")
            XCTFail("expected unsupported remote deauthorization")
        } catch DeviceManagementError.unsupported {
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }
}
