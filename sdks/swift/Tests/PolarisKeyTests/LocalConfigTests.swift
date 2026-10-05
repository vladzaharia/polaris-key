// @pkey-feature config.schema config.resolve
//
// SP-S14: persisted local overrides (`config.set` / `clear`, notes/SDK-PARITY-PASS.md §3.11) and
// the decoded catalog (`fetchCatalog()`). A kept value sits in the resolution's local layer, beats
// a remote `default`, never an `enforced` or `hidden` entry, survives a new client over the same
// store and raises `config(key:)` on `client.changes`.

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
        store local: MemoryLocalConfigStore, schema: String? = catalogBody
    ) async throws -> PolarisKeyClient {
        let server = StubServer()
        if let schema { await server.reply("/djdl/config/schema", body: schema) }
        let store = InMemoryStore(deviceId: "dev")
        await store.setToken("pkeyt_test")
        let doc = Fixtures.config(
            deviceId: "dev", issuedAt: issuedAt,
            config: [
                "run.concurrency": ManagedEntry(state: .enforced, value: .int(4), updatedAt: 1),
                "ui.theme": ManagedEntry(state: .default, value: .string("dark"), updatedAt: 1),
            ],
            secrets: [:])
        await store.writeCache(CacheRecord(docs: [.config: signer.sign(doc)]))
        return try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                core: CoreOptions(
                    productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                    pinnedKeys: signer.trust, trustRefresh: false, store: store, transport: server.transport,
                    expectedServices: [.license, .config]),
                config: ConfigClientOptions(local: LocalConfigOptions(store: local))))
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
        var events = c.changes.makeAsyncIterator()
        try await c.config.set("ui.theme", .string("light"))
        let theme = await c.config.string("ui.theme", default: "x")
        let source = await c.config.configSource("ui.theme")
        XCTAssertEqual(theme, "light")
        XCTAssertEqual(source, .local)
        let event = await events.next()
        XCTAssertEqual(event, .config(key: "ui.theme"))
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
}
