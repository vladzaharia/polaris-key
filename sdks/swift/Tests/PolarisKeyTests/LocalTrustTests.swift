// @pkey-feature core.sync core.cache core.verify core.store
// The client-local trust rules: a hard 401 or a 403 build block REMOVES the
// slice it answered for, discovery can turn the licence gate on but never off, the network paths
// run on the effective clock, and a desktop file store re-derives its device id from the
// platform anchor at every start.

import Foundation
import PolarisKey
import PolarisKeyConfig
import PolarisKeyCore
import PolarisKeyLicense
import XCTest

@testable import PolarisKeyCore

/// An in-memory store that opts in to device binding, as a desktop file store does.
private actor RebindableStore: Store, DeviceIdRebindable {
    let inner: InMemoryStore
    private var id: String
    init(deviceId: String) {
        inner = InMemoryStore(deviceId: deviceId)
        id = deviceId
    }
    func getToken() async -> String? { await inner.getToken() }
    func setToken(_ token: String) async { await inner.setToken(token) }
    func clearToken() async { await inner.clearToken() }
    func getDeviceId() async -> String { id }
    func setDeviceId(_ id: String) async throws { self.id = id }
    func readCache() async -> CacheRecord? { await inner.readCache() }
    func writeCache(_ record: CacheRecord) async { await inner.writeCache(record) }
    func clearCache() async { await inner.clearCache() }
}

final class LocalTrustTests: XCTestCase {
    private let pinnedKid = "pkey-pinned-2026"
    private var vendor = TestSigner(kid: "pkey-pinned-2026")
    private var server = StubServer()
    private let licensePath = "/djdl/license/document"

    override func setUp() {
        super.setUp()
        vendor = TestSigner(kid: pinnedKid)
        server = StubServer()
    }

    private func nowSec() -> Int { Int(Date().timeIntervalSince1970) }

    private func client(
        store: InMemoryStore, services: [ServiceSlug] = [.license]
    ) async throws -> PolarisKeyClient {
        try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [pinnedKid: vendor.publicKeyB64], trustRefresh: false,
                store: store, transport: server.transport, expectedServices: services,
                fingerprint: false))
    }

    private func seeded() async -> (InMemoryStore, String) {
        let jws = vendor.sign(Fixtures.license(issuedAt: nowSec() - 60))
        let store = InMemoryStore(deviceId: "dev")
        await store.setToken("pkeyt_test")
        await store.writeCache(CacheRecord(docs: [.license: jws], etags: [.license: "v1"]))
        return (store, jws)
    }

    // ── a hard refusal deletes the document ─────────────────────────────────────────
    func testHardUnauthorizedRemovesTheLicenceSliceAndItsEtagInTheSameWrite() async throws {
        let (store, _) = await seeded()
        let c = try await client(store: store)
        let before = await c.status().status
        XCTAssertEqual(before, .ok)
        await server.reply(licensePath, status: 401, body: "")
        await server.reply("/djdl/license/token", status: 401, body: "")
        let result = await c.sync()
        XCTAssertTrue(result.unauthorized)

        let record = await store.readCache()
        XCTAssertNil(record?.docs[.license], "the revoked document is gone from disk")
        XCTAssertNil(record?.etags[.license], "and so is its ETag")
        XCTAssertEqual(record?.lastSyncUnauthorized, true)
        let token = await store.getToken()
        XCTAssertEqual(token, "pkeyt_test", "the token is kept")
        let revoked = await c.status().status
        XCTAssertEqual(revoked, .revoked)

        // The hint is display-only: with it cleared, nothing usable is left.
        var cleared = try XCTUnwrap(record)
        cleared.lastSyncUnauthorized = nil
        await store.writeCache(cleared)
        let restarted = try await client(store: store)
        let after = await restarted.status().status
        XCTAssertEqual(after, .needsActivation)
    }

    func testBuildBlockRemovesTheLicenceSliceAndItsEtag() async throws {
        let (store, _) = await seeded()
        let c = try await client(store: store)
        await server.reply(
            licensePath, status: 403,
            body: #"{"error":{"code":"version_blocked","reason":"version-too-old"}}"#)
        _ = await c.sync()
        let record = await store.readCache()
        XCTAssertNil(record?.docs[.license])
        XCTAssertNil(record?.etags[.license])
        XCTAssertEqual(record?.blocked?.reason, .versionTooOld)
        let blocked = await c.status().status
        XCTAssertEqual(blocked, .versionTooOld)

        var cleared = try XCTUnwrap(record)
        cleared.blocked = nil
        await store.writeCache(cleared)
        let restarted = try await client(store: store)
        let after = await restarted.status().status
        XCTAssertEqual(after, .needsActivation, "clearing the hint does not restore a document")
    }

    func testHardUnauthorizedOnConfigRemovesOnlyTheConfigSlice() async throws {
        let (store, _) = await seeded()
        let t = nowSec()
        let existing = await store.readCache()
        var record = try XCTUnwrap(existing)
        record.docs[.config] = vendor.sign(Fixtures.config(issuedAt: t - 60))
        record.etags[.config] = "c1"
        await store.writeCache(record)
        let c = try await client(store: store, services: [.license, .config])
        await server.reply(licensePath, status: 304, body: "")
        await server.reply("/djdl/config/document", status: 401, body: "")
        await server.reply("/djdl/devices/register", status: 403, body: "")
        _ = await c.sync()
        let after = await store.readCache()
        XCTAssertNil(after?.docs[.config])
        XCTAssertNil(after?.etags[.config])
        XCTAssertNotNil(after?.docs[.license], "the other slice is untouched")
        XCTAssertEqual(after?.etags[.license], "v1")
    }

    // ── the licence gate input ──────────────────────────────────────────────────────
    private let discoveryOff = #"""
        {"version":2,"protocolVersion":4,"product":"djdl","slug":"djdl","name":"DJDL",
         "baseUrl":"https://key.example",
         "core":{"registration":"open","endpoints":{"register":"https://key.example/djdl/devices/register"}},
         "trust":{"jwksUrl":"https://key.example/djdl/.well-known/jwks.json",
                  "trustManifestUrl":"https://key.example/djdl/.well-known/polaris-trust.jws",
                  "pinnedKeys":{}},
         "services":{"license":{"enabled":false},"config":{"enabled":true,"schemaVersion":1,"endpoints":{}}}}
        """#

    func testDiscoveryCannotSwitchTheLicenceGateOff() async throws {
        await server.reply("/djdl/.well-known/polaris.json", body: discoveryOff)
        let core = try CoreContext(
            options: CoreOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], store: InMemoryStore(deviceId: "dev"),
                transport: server.transport))
        try await core.start()
        guard case .ok = await core.discover() else { return XCTFail("discovery should load") }
        let subClient = await core.enabled(.license)
        XCTAssertFalse(subClient, "discovery still governs sub-client availability")
        let gate = await core.licenseGateEnabled()
        XCTAssertTrue(gate, "the build's default licence expectation keeps the gate on")
    }

    func testConfigOnlyBuildIsNotApplicableAndDiscoveryCanTurnTheGateOn() async throws {
        let discoveryOn = discoveryOff.replacingOccurrences(
            of: #""license":{"enabled":false}"#, with: #""license":{"enabled":true}"#)
        await server.reply("/djdl/.well-known/polaris.json", body: discoveryOn)
        let core = try CoreContext(
            options: CoreOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], store: InMemoryStore(deviceId: "dev"),
                transport: server.transport, expectedServices: [.config]))
        try await core.start()
        let before = await core.licenseGateEnabled()
        XCTAssertFalse(before, "a build that declares no licence service has no gate")
        _ = await core.discover()
        let after = await core.licenseGateEnabled()
        XCTAssertTrue(after, "discovery may switch the gate on")
    }

    func testClientGateStaysOnWhenDiscoveryDisablesLicence() async throws {
        await server.reply("/djdl/.well-known/polaris.json", body: discoveryOff)
        let store = InMemoryStore(deviceId: "dev")
        let c = try await client(store: store, services: [.license, .config])
        _ = await c.core.discover()
        let state = await c.status().status
        XCTAssertEqual(state, .needsActivation, "not .notApplicable")
    }

    // ── the effective clock ─────────────────────────────────────────────────────────
    func testTrustManifestRefreshRunsOnTheEffectiveClock() async throws {
        let t = nowSec()
        let store = InMemoryStore(deviceId: "dev")
        await store.setToken("pkeyt_test")
        // A cached licence raises the signed floor to ~now; the system clock is a day behind.
        await store.writeCache(
            CacheRecord(docs: [.license: vendor.sign(Fixtures.license(issuedAt: t))]))
        let manifest = vendor.sign(
            Fixtures.manifest(
                issuedAt: t + 100,
                keys: [Fixtures.manifestKey(kid: pinnedKid, publicKey: vendor.publicKeyB64)]))
        await server.reply("/djdl/.well-known/polaris-trust.jws", body: manifest)
        let core = try CoreContext(
            options: CoreOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [pinnedKid: vendor.publicKeyB64], store: store,
                transport: server.transport, clock: { t - SECONDS_PER_DAY }))
        try await core.start()
        let ok = await core.refreshTrust()
        XCTAssertTrue(ok, "the manifest is judged at the effective clock, not the rolled-back wall")
    }

    // ── device binding ──────────────────────────────────────────────────────────────
    private func derived(_ raw: String) -> String { DeviceID.fromRaw(productSlug: "djdl", raw: raw) }

    private func seededRebindable(id: String) async -> RebindableStore {
        let store = RebindableStore(deviceId: id)
        await store.setToken("pkeyt_copied")
        await store.writeCache(
            CacheRecord(
                trustJws: "t.t.t", docs: [.license: "a.b.c"], etags: [.license: "v1"],
                bundle: "b.b.b",
                lastSyncUnauthorized: true, blocked: BlockInfoRecord(reason: .versionTooOld),
                feeds: ["stable": "f.f.f"], releaseRecords: ["ab": "r.r.r"],
                pinRevocations: ["k": "p.p.p"]))
        return store
    }

    func testStoredIdThatDisagreesWithTheAnchorIsDiscardedWithTheGrantCache() async throws {
        let store = await seededRebindable(id: "copied-from-another-machine")
        let id = try await bindDeviceId(productSlug: "djdl", store: store, readAnchor: { "ANCHOR-1" })
        XCTAssertEqual(id, derived("ANCHOR-1"))
        let stored = await store.getDeviceId()
        XCTAssertEqual(stored, derived("ANCHOR-1"))
        let token = await store.getToken()
        XCTAssertNil(token)
        let storedCache = await store.readCache()
        let cache = try XCTUnwrap(storedCache)
        XCTAssertNil(cache.trustJws)
        XCTAssertTrue(cache.docs.isEmpty)
        XCTAssertTrue(cache.etags.isEmpty)
        XCTAssertNil(cache.bundle)
        XCTAssertNil(cache.lastSyncUnauthorized)
        XCTAssertNil(cache.blocked)
        XCTAssertEqual(cache.feeds, ["stable": "f.f.f"], "feeds carry the seq floors")
        XCTAssertEqual(cache.releaseRecords, ["ab": "r.r.r"])
        XCTAssertEqual(cache.pinRevocations, ["k": "p.p.p"], "a tombstone is not a grant")
    }

    func testMatchingOrAnchorlessOrNonRebindableStoresKeepTheirState() async throws {
        let matching = await seededRebindable(id: derived("ANCHOR-1"))
        _ = try await bindDeviceId(productSlug: "djdl", store: matching, readAnchor: { "ANCHOR-1" })
        let kept = await matching.getToken()
        XCTAssertEqual(kept, "pkeyt_copied")

        let noAnchor = await seededRebindable(id: "stored-id")
        let id = try await bindDeviceId(productSlug: "djdl", store: noAnchor, readAnchor: { nil })
        XCTAssertEqual(id, "stored-id", "no anchor: the stored id is kept")
        let keptToo = await noAnchor.getToken()
        XCTAssertEqual(keptToo, "pkeyt_copied")

        // A store that does not opt in (in-memory, host store, iOS keychain host) is untouched.
        let plain = InMemoryStore(deviceId: "plain")
        await plain.setToken("pkeyt_plain")
        let plainId = try await bindDeviceId(productSlug: "djdl", store: plain, readAnchor: { "ANCHOR-1" })
        XCTAssertEqual(plainId, "plain")
        let plainToken = await plain.getToken()
        XCTAssertEqual(plainToken, "pkeyt_plain")
    }

    func testCoreStartBindsTheDeviceIdOnMacOS() async throws {
        #if os(macOS)
        guard DeviceID.anchorRaw() != nil else { throw XCTSkip("no platform anchor") }
        let store = await seededRebindable(id: "copied-from-another-machine")
        let core = try CoreContext(
            options: CoreOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], store: store, transport: server.transport))
        try await core.start()
        let id = await core.deviceId
        XCTAssertEqual(id, derived(try XCTUnwrap(DeviceID.anchorRaw())))
        let token = await core.token
        XCTAssertNil(token)
        #else
        throw XCTSkip("macOS only: other platforms keep their stored id")
        #endif
    }

    func testKeychainStoreIsRebindableAndWritesTheDeviceFile() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(
            "pkey-bind-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = KeychainStore(productSlug: "djdl", configDir: dir)
        try await store.setDeviceId("bound-id")
        let id = try await store.getDeviceId()
        XCTAssertEqual(id, "bound-id")
    }
}
