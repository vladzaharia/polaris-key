// @pkey-feature config.local config.schema config.resolve
//
// SP-S14 / SP-18: persisted local overrides (`config.set` / `clear` / `clearAll`,
// notes/SDK-PARITY-PASS.md §3.11) and the decoded catalog (`fetchCatalog()`). A kept value sits in
// the resolution's local layer, beats a remote `default`, never an `enforced` or `hidden` entry,
// survives a new client over the same store and raises a `config` event (key, value, previous,
// source) on `client.events`. `config.setting(key)` reads the effective value with its source and
// lock, and `onConfigChange(key, listener)` (or `configChanges(key)`, an AsyncStream) delivers that
// key's changes, from a local write or a sync, until cancelled.

import Foundation
import PolarisKey
import PolarisKeyConfig
import PolarisKeyCore
import XCTest

private let catalogBody = #"""
    {"schemaVersion":3,"entries":[
      {"key":"ui.theme","kind":"config","category":"ui","label":"Theme","description":"",
       "schema":{"type":"string","enum":["dark","light"]},"default":"dark",
       "ui":{"widget":"select","optionLabels":{"dark":"Dark","light":"Light"}}},
      {"key":"run.concurrency","kind":"config","category":"run","label":"Concurrency","description":"",
       "schema":{"type":"integer","minimum":1},"managementDefault":"enforced"},
      {"key":"net.timeout","kind":"config","category":"net","label":"Timeout","description":"",
       "schema":{"type":"number"}},
      {"key":"api.key","kind":"secret","category":"net","label":"API key","description":"","schema":{"type":"string"}},
      {"key":"pro","kind":"flag","category":"tier","label":"Pro","description":"","schema":{"type":"boolean"},
       "userGrant":true,"grantLabel":"Pro features","futureMember":1}
    ]}
    """#

final class LocalConfigTests: XCTestCase {
    private let signer = TestSigner(kid: "local-config-key")
    private lazy var issuedAt = Int(Date().timeIntervalSince1970)

    private func client(
        store local: MemoryLocalConfigStore, schema: String? = catalogBody, server: StubServer = StubServer()
    ) async throws -> PolarisKeyClient {
        if let schema { await server.reply("/djdl/config/schema", body: schema) }
        let store = InMemoryStore(deviceId: "dev")
        await store.setToken("pkeyt_test")
        await store.writeCache(CacheRecord(docs: [.config: configJWS(theme: "dark")]))
        return try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                core: CoreOptions(
                    productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                    pinnedKeys: signer.trust, trustRefresh: false, store: store, transport: server.transport,
                    expectedServices: [.license, .config]),
                config: ConfigClientOptions(local: LocalConfigOptions(store: local))))
    }

    private func configJWS(theme: String, concurrency: Int = 4, later: Int = 0) -> String {
        signer.sign(
            Fixtures.config(
                deviceId: "dev", issuedAt: issuedAt + later,
                config: [
                    "run.concurrency": ManagedEntry(state: .enforced, value: .int(concurrency), updatedAt: 1),
                    "ui.theme": ManagedEntry(state: .default, value: .string(theme), updatedAt: 1),
                ],
                secrets: [:]))
    }

    private func refusal(_ body: () async throws -> Void) async -> String? {
        do {
            try await body()
            return nil
        } catch let e as PolarisError {
            return e.code
        } catch {
            return "other"
        }
    }

    func testASetValueBeatsTheRemoteDefaultPersistsAndRaisesAChange() async throws {
        let local = MemoryLocalConfigStore()
        let c = try await client(store: local)
        var events = c.events.makeAsyncIterator()
        try await c.config.set("ui.theme", .string("light"))
        let theme = await c.config.string("ui.theme", default: "x")
        let source = await c.config.configSource("ui.theme")
        XCTAssertEqual(theme, "light")
        XCTAssertEqual(source, .local)
        let event = await events.next()
        XCTAssertEqual(
            event, .config(key: "ui.theme", value: .string("light"), previous: .string("dark"), source: .local))
        XCTAssertEqual(local.load(), ["ui.theme": .string("light")])

        // A new client over the same store reads the kept value back.
        let again = try await client(store: local)
        let kept = await again.config.string("ui.theme", default: "x")
        XCTAssertEqual(kept, "light")
        await again.config.clear("ui.theme")
        let cleared = await again.config.string("ui.theme", default: "x")
        XCTAssertEqual(cleared, "dark")
        XCTAssertTrue(local.load().isEmpty)
    }

    func testRefusesALockedKeyAnUnknownKeyANonConfigKindAndAMismatchedValue() async throws {
        let c = try await client(store: MemoryLocalConfigStore())
        let locked = await refusal { try await c.config.set("run.concurrency", .int(8)) }
        XCTAssertEqual(locked, ErrorCode.invalidOptions)
        let unknown = await refusal { try await c.config.set("no.such", .int(1)) }
        XCTAssertEqual(unknown, ErrorCode.invalidOptions)
        let secret = await refusal { try await c.config.set("api.key", .string("x")) }
        XCTAssertEqual(secret, ErrorCode.invalidOptions)
        let notInEnum = await refusal { try await c.config.set("ui.theme", .string("pink")) }
        XCTAssertEqual(notInEnum, ErrorCode.invalidOptions)
        let wrongType = await refusal { try await c.config.set("net.timeout", .string("5")) }
        XCTAssertEqual(wrongType, ErrorCode.invalidOptions)
        let ok = await refusal { try await c.config.set("net.timeout", .int(5)) }
        XCTAssertNil(ok)
        let values = await c.config.localValues()
        XCTAssertEqual(values, ["net.timeout": .int(5)])
    }

    func testWithoutACatalogTheValueIsKeptUnvalidated() async throws {
        let c = try await client(store: MemoryLocalConfigStore(), schema: nil)
        try await c.config.set("anything", .bool(true))
        let v = await c.config.bool("anything", default: false)
        XCTAssertTrue(v)
    }

    func testDecodesTheCatalog() async throws {
        let c = try await client(store: MemoryLocalConfigStore())
        let fetched = await c.config.fetchCatalog()
        let catalog = try XCTUnwrap(fetched)
        XCTAssertEqual(catalog.schemaVersion, 3)
        XCTAssertEqual(catalog.entries.map(\.key), ["ui.theme", "run.concurrency", "net.timeout", "api.key", "pro"])
        let theme = try XCTUnwrap(catalog.entry("ui.theme"))
        XCTAssertEqual(theme.schemaType, "string")
        XCTAssertEqual(theme.allowedValues, [.string("dark"), .string("light")])
        XCTAssertEqual(theme.ui?.optionLabels?["light"], "Light")
        XCTAssertEqual(theme.default, .string("dark"))
        XCTAssertEqual(catalog.entry("run.concurrency")?.managementDefault, "enforced")
        XCTAssertEqual(catalog.entry("pro")?.grantLabel, "Pro features")
        XCTAssertTrue(catalog.entry("net.timeout")!.accepts(.double(1.5)))
        XCTAssertTrue(catalog.entry("run.concurrency")!.accepts(.double(2)))
        XCTAssertFalse(catalog.entry("run.concurrency")!.accepts(.double(2.5)))
        XCTAssertNil(ConfigCatalog.decode(Data("<html>".utf8)))
    }

    // ── config.setting(key) and onConfigChange(key, listener) (SP-18) ────────────────────────

    func testSettingReadsTheEffectiveValueWithItsSourceAndLock() async throws {
        let c = try await client(store: MemoryLocalConfigStore())
        let theme = c.config.setting("ui.theme")
        XCTAssertEqual(theme.key, "ui.theme")
        let remote = await theme.current()
        XCTAssertEqual(remote, ConfigSettingState(value: .string("dark"), source: .remoteDefault, locked: false))

        try await theme.set(.string("light"))
        let local = await theme.current()
        XCTAssertEqual(local, ConfigSettingState(value: .string("light"), source: .local, locked: false))
        let v = await theme.value(default: .null)
        XCTAssertEqual(v, .string("light"))
        let src = await theme.source()
        XCTAssertEqual(src, .local)

        let concurrency = await c.config.setting("run.concurrency").current()
        XCTAssertEqual(concurrency, ConfigSettingState(value: .int(4), source: .enforced, locked: true))
        let lockedRefusal = await refusal { try await c.config.setting("run.concurrency").set(.int(8)) }
        XCTAssertEqual(lockedRefusal, ErrorCode.invalidOptions)

        let none = await c.config.setting("net.timeout").current()
        XCTAssertEqual(none, ConfigSettingState(value: nil, source: .fallback, locked: false))
        let fallback = await c.config.setting("net.timeout").value(default: .int(30))
        XCTAssertEqual(fallback, .int(30))

        await theme.clear()
        let back = await theme.current()
        XCTAssertEqual(back.source, .remoteDefault)
    }

    func testOnConfigChangeDeliversPerKeyChangesUntilCancelled() async throws {
        let c = try await client(store: MemoryLocalConfigStore())
        let themeSeen = LockedValue<[ConfigChange]>([])
        let allSeen = LockedValue<[ConfigChange]>([])
        let theme = c.config.onConfigChange("ui.theme") { change in themeSeen.with { $0.append(change) } }
        let all = c.config.onConfigChange("*") { change in allSeen.with { $0.append(change) } }

        try await c.config.set("ui.theme", .string("light"))
        try await c.config.set("net.timeout", .int(5))
        // Delivered before `set` returns.
        XCTAssertEqual(
            themeSeen.current,
            [ConfigChange(key: "ui.theme", value: .string("light"), previous: .string("dark"), source: .local)])
        XCTAssertEqual(allSeen.current.map(\.key), ["ui.theme", "net.timeout"])
        XCTAssertEqual(allSeen.current.last, ConfigChange(key: "net.timeout", value: .int(5), previous: nil, source: .local))

        // Writing the same value again moves nothing.
        try await c.config.set("ui.theme", .string("light"))
        XCTAssertEqual(themeSeen.current.count, 1)

        theme.cancel()
        XCTAssertTrue(theme.isCancelled)
        await c.config.clear("ui.theme")
        XCTAssertEqual(themeSeen.current.count, 1, "a cancelled listener hears nothing")
        XCTAssertEqual(
            allSeen.current.last,
            ConfigChange(key: "ui.theme", value: .string("dark"), previous: .string("light"), source: .remoteDefault))

        await c.config.clearAll()
        XCTAssertEqual(
            allSeen.current.last, ConfigChange(key: "net.timeout", value: nil, previous: .int(5), source: .fallback))
        all.cancel()
    }

    func testTheSettingStreamAndListenersFollowASync() async throws {
        let server = StubServer()
        let c = try await client(store: MemoryLocalConfigStore(), server: server)
        var stream = c.config.setting("ui.theme").changes.makeAsyncIterator()
        let jws = configJWS(theme: "light", concurrency: 6, later: 1)
        await server.route("/djdl/config/document") { _ in
            StubServer.Reply(status: 200, body: jws, headers: ["ETag": "c2"])
        }
        let enforced = LockedValue<[ConfigChange]>([])
        c.config.setting("run.concurrency").onChange { change in enforced.with { $0.append(change) } }
        let result = await c.sync()
        // Guarded so a document that did not land fails here instead of waiting on the stream.
        guard result.documents[.config] == .applied else { return XCTFail("config not applied: \(result)") }
        let change = await stream.next()
        XCTAssertEqual(
            change, ConfigChange(key: "ui.theme", value: .string("light"), previous: .string("dark"), source: .remoteDefault))
        XCTAssertEqual(
            enforced.current, [ConfigChange(key: "run.concurrency", value: .int(6), previous: .int(4), source: .enforced)])
    }

    func testABareConfigClientDeliversItsOwnLocalChanges() async throws {
        let store = InMemoryStore(deviceId: "dev")
        await store.writeCache(CacheRecord(docs: [.config: configJWS(theme: "dark")]))
        let core = try CoreContext(
            options: CoreOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: signer.trust, trustRefresh: false, store: store, transport: StubServer().transport,
                expectedServices: [.config]))
        let config = ConfigClient(core: core, options: ConfigClientOptions(local: LocalConfigOptions(store: MemoryLocalConfigStore())))
        let seen = LockedValue<[ConfigChange]>([])
        config.onConfigChange("anything") { change in seen.with { $0.append(change) } }
        try await config.set("anything", .bool(true))
        await config.clear("anything")
        XCTAssertEqual(
            seen.current,
            [
                ConfigChange(key: "anything", value: .bool(true), previous: nil, source: .local),
                ConfigChange(key: "anything", value: nil, previous: .bool(true), source: .fallback),
            ])
    }
}
