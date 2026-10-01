// Layered config: management-state honoring + localOverrides/env precedence, plus the
// `listUserConfig()`/`configSource()` surface.
//
//   enforced | hidden (remote)  >  local override  >  environment  >  remote default  >  fallback
//
// The client is seeded through an `InMemoryStore` holding a SIGNED config document (§4.1 — the
// cache persists nothing else), so no network is needed. The environment is INJECTED rather than
// read from the process, which is the v3 change worth having: the precedence rules are now
// testable without `setenv`, and two tests that disagreed about a variable can no longer race.
//
// Note: awaited actor reads are hoisted into `let`s before asserting — `await` is not permitted
// inside XCTAssert*'s non-async autoclosure arguments.

import Foundation
import PolarisKey
import PolarisKeyConfig
import PolarisKeyCore
import XCTest

final class LayeredConfigTests: XCTestCase {
    private let signer = TestSigner(kid: "layered-config-key")
    private lazy var issuedAt = Int(Date().timeIntervalSince1970)

    /// A document whose config carries one entry per relevant state.
    private func makeDoc() -> ConfigDoc {
        Fixtures.config(
            deviceId: "dev", issuedAt: issuedAt,
            config: [
                "run.concurrency": ManagedEntry(
                    state: .enforced, value: .int(4), updatedAt: 100),
                "ui.theme": ManagedEntry(
                    state: .default, value: .string("dark"), updatedAt: 200),
                "proxy.secret": ManagedEntry(
                    state: .hidden, value: .string("s"), updatedAt: 300),
            ],
            secrets: [
                "api.key": ManagedEntry(
                    state: .enforced, value: .string("sk-live"), updatedAt: 400)
            ])
    }

    private func client(
        localOverrides: [String: JSONValue] = [:],
        environment: [String: String] = [:],
        services: [ServiceSlug] = [.license, .config]
    ) async throws -> PolarisKeyClient {
        let store = InMemoryStore(deviceId: "dev")
        await store.setToken("pkeyt_test")
        await store.writeCache(CacheRecord(docs: [.config: signer.sign(makeDoc())]))
        return try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                core: CoreOptions(
                    productSlug: "djdl", version: "1.0.0", pinnedKeys: signer.trust,
                    trustRefresh: false, store: store, transport: ExplodingTransport(),
                    expectedServices: services),
                config: ConfigClientOptions(
                    localOverrides: localOverrides, environment: environment)))
    }

    // @pkey-feature config.resolve
    func testEnforcedAndHiddenAlwaysWinOverOverrides() async throws {
        let c = try await client(
            localOverrides: ["run.concurrency": .int(99), "proxy.secret": .string("nope")],
            environment: ["PKEY_CONFIG_run__concurrency": "1234"])
        let conc = await c.config.config("run.concurrency", default: .int(0))
        let secret = await c.config.config("proxy.secret", default: .string("d"))
        let concSrc = await c.config.configSource("run.concurrency")
        let secretSrc = await c.config.configSource("proxy.secret")
        XCTAssertEqual(conc, .int(4))
        XCTAssertEqual(secret, .string("s"))
        XCTAssertEqual(concSrc, .enforced)
        XCTAssertEqual(secretSrc, .hidden)
    }

    // @pkey-feature config.resolve
    func testDefaultStateLocalOverrideBeatsRemote() async throws {
        let c = try await client(localOverrides: ["ui.theme": .string("light")])
        let theme = await c.config.config("ui.theme", default: .string("d"))
        let src = await c.config.configSource("ui.theme")
        XCTAssertEqual(theme, .string("light"))
        XCTAssertEqual(src, .local)
    }

    // @pkey-feature config.resolve
    func testDefaultStateFallsBackToRemoteThenFallback() async throws {
        let c = try await client()
        let theme = await c.config.config("ui.theme", default: .string("d"))
        let themeSrc = await c.config.configSource("ui.theme")
        XCTAssertEqual(theme, .string("dark"))
        XCTAssertEqual(themeSrc, .remoteDefault)
        let missing = await c.config.config("missing.key", default: .int(7))
        let missingSrc = await c.config.configSource("missing.key")
        XCTAssertEqual(missing, .int(7))
        XCTAssertEqual(missingSrc, .fallback)
    }

    // @pkey-feature config.resolve
    /// The v3 env prefix is `PKEY_CONFIG_`, and the dot→`__` mapping is the part every SDK must
    /// agree on.
    func testEnvOverrideBeatsRemoteDefaultAndParsesJson() async throws {
        let c = try await client(environment: [
            "PKEY_CONFIG_ui__theme": "\"midnight\"",
            "PKEY_CONFIG_feature__count": "42",
            "PKEY_CONFIG_feature__on": "true",
            "PKEY_CONFIG_feature__list": "[1,2]",
        ])
        let theme = await c.config.config("ui.theme", default: .string("d"))
        let themeSrc = await c.config.configSource("ui.theme")
        XCTAssertEqual(theme, .string("midnight"))
        XCTAssertEqual(themeSrc, .env)
        let count = await c.config.config("feature.count", default: .int(0))
        XCTAssertEqual(count, .int(42))
        let on = await c.config.config("feature.on", default: .bool(false))
        XCTAssertEqual(on, .bool(true))
        let list = await c.config.config("feature.list", default: .null)
        XCTAssertEqual(list, .array([.int(1), .int(2)]))
    }

    /// The withdrawn `PLRS_CONFIG_` prefix is NOT read — no dual-read (§8).
    func testWithdrawnEnvPrefixIsIgnored() async throws {
        let c = try await client(environment: ["PLRS_CONFIG_ui__theme": "\"legacy\""])
        let theme = await c.config.config("ui.theme", default: .string("d"))
        XCTAssertEqual(theme, .string("dark"), "PLRS_CONFIG_ was withdrawn by Amendment A1")
    }

    // @pkey-feature config.resolve
    func testLocalOverrideBeatsEnvForDefaultState() async throws {
        let c = try await client(
            localOverrides: ["ui.theme": .string("local-wins")],
            environment: ["PKEY_CONFIG_ui__theme": "\"midnight\""])
        let theme = await c.config.config("ui.theme", default: .string("d"))
        let src = await c.config.configSource("ui.theme")
        XCTAssertEqual(theme, .string("local-wins"))
        XCTAssertEqual(src, .local)
    }

    func testEnvNonJsonFallsBackToRawString() async throws {
        let c = try await client(environment: ["PKEY_CONFIG_ui__theme": "not json: bare"])
        let v = await c.config.config("ui.theme", default: .string("d"))
        XCTAssertEqual(v, .string("not json: bare"))
    }

    // @pkey-feature config.list
    func testListUserConfigExcludesHiddenAndFlagsEnforced() async throws {
        let c = try await client(localOverrides: ["ui.theme": .string("light")])
        let rows = await c.config.listUserConfig()
        let byKey = Dictionary(uniqueKeysWithValues: rows.map { ($0.key, $0) })
        XCTAssertNil(byKey["proxy.secret"], "hidden entries must be excluded")
        XCTAssertEqual(byKey.count, 2)
        XCTAssertEqual(byKey["run.concurrency"]?.enforced, true)
        XCTAssertEqual(byKey["run.concurrency"]?.value, .int(4))
        XCTAssertEqual(byKey["ui.theme"]?.enforced, false)
        XCTAssertEqual(byKey["ui.theme"]?.value, .string("light"))
    }

    // @pkey-feature config.secret
    /// Secrets are readable but never ENUMERATED — `listUserConfig` is a settings-UI surface and
    /// a secret has no business on one.
    func testSecretsAreReadableButNotEnumerated() async throws {
        let c = try await client()
        let secret = await c.config.secret("api.key")
        let missing = await c.config.secret("nope")
        let rows = await c.config.listUserConfig()
        XCTAssertEqual(secret, "sk-live")
        XCTAssertNil(missing)
        XCTAssertFalse(rows.contains { $0.key == "api.key" })
    }

    /// D-08's client-side consequence: a product that runs Config and NOT License boots usable,
    /// resolves its settings, and reports `not-applicable` rather than `needs-activation`.
    func testConfigOnlyProductIsUsableWithNoLicence() async throws {
        let c = try await client(services: [.config])
        let status = await c.status()
        let usable = await c.isLicensed()
        let theme = await c.config.config("ui.theme", default: .string("d"))
        let configEnabled = await c.config.isEnabled()
        let schemaVersion = await c.config.schemaVersion()
        XCTAssertEqual(status.status, .notApplicable)
        XCTAssertTrue(usable)
        XCTAssertEqual(theme, .string("dark"))
        XCTAssertTrue(configEnabled)
        XCTAssertEqual(schemaVersion, 1)
    }

    /// The current-device view is assembled from the re-verified documents, and works offline.
    func testCurrentDeviceSurface() async throws {
        let c = try await client()
        let current = await c.currentDevice()
        XCTAssertEqual(current.id, "dev")
        XCTAssertTrue(current.current)
        // Config-only cache: there is no licence document, so the gate says so honestly.
        XCTAssertEqual(current.status, .needsActivation)
        XCTAssertNil(current.licenseId)
    }
}
