// @pkey-feature core.sync core.cache core.verify core.bundle
// Trust custody and the signed bundle slice: the host-side halves the corpus cannot express as
// data. The verdicts (statuses, tombstone rules, floors, reload profile) are pinned by
// `ConformanceTests`; what lives here is what the HOST does with them — the signer retry, the
// evidence written in the same write as the manifest, the carry-through, the byte-identical
// re-import and the bundle that must re-verify to activate.

import Foundation
import PolarisKey
import PolarisKeyCore
import PolarisKeyLicense
import XCTest

final class TrustCustodyTests: XCTestCase {
    private let a = TestSigner(kid: "pkey-a-2026")
    private let b = TestSigner(kid: "pkey-b-2027")
    private var server = StubServer()
    private let manifestPath = "/djdl/.well-known/polaris-trust.jws"

    override func setUp() {
        super.setUp()
        server = StubServer()
    }

    private func nowSec() -> Int { Int(Date().timeIntervalSince1970) }

    private func core(
        store: InMemoryStore, pinned: TrustSet? = nil, device: String = "dev"
    ) async throws -> CoreContext {
        let core = try CoreContext(
            options: CoreOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: pinned ?? [a.kid: a.publicKeyB64, b.kid: b.publicKeyB64],
                store: store, transport: server.transport))
        try await core.start()
        return core
    }

    /// A manifest signed by `signer` that lists `keys`.
    private func manifest(
        _ signer: TestSigner, issuedAt: Int, keys: [(TestSigner, String)]
    ) -> String {
        signer.sign(
            Fixtures.manifest(
                issuedAt: issuedAt,
                keys: keys.map {
                    Fixtures.manifestKey(kid: $0.0.kid, publicKey: $0.0.publicKeyB64, status: $0.1)
                }))
    }

    // ── Signer retry (§2.3) ─────────────────────────────────────────────────────────────

    func testRefusedDefaultManifestIsRetriedWithTheSignerQuery() async throws {
        let t = nowSec()
        // The app pins only the retired key A; the default manifest is signed by B.
        let byB = manifest(b, issuedAt: t, keys: [(a, "retired"), (b, "active")])
        let byA = manifest(a, issuedAt: t, keys: [(a, "retired"), (b, "active")])
        let aKid = a.kid
        await server.route(manifestPath) { request in
            let signer = request.url.query?.contains("signer=\(aKid)") == true
            return StubServer.Reply(body: signer ? byA : byB)
        }
        let c = try await core(store: InMemoryStore(deviceId: "dev"), pinned: [a.kid: a.publicKeyB64])
        let ok = await c.refreshTrust()
        XCTAssertTrue(ok)
        let sent = await server.requests(forPath: manifestPath).compactMap(\.url.query)
        XCTAssertEqual(sent, ["signer=\(a.kid)"], "default request, then one signer retry")
        let trust = await c.trust
        XCTAssertEqual(trust[b.kid], b.publicKeyB64, "the rotated key is learned from the retry")
    }

    func testManifestSignedByAUsablePinIsNeverRetried() async throws {
        let t = nowSec()
        // Signed by pin A but stale: refused, and the signer is already a usable pin.
        let stale = manifest(a, issuedAt: t - 90 * SECONDS_PER_DAY, keys: [(a, "active")])
        await server.reply(manifestPath, body: stale)
        let c = try await core(store: InMemoryStore(deviceId: "dev"))
        let ok = await c.refreshTrust()
        XCTAssertFalse(ok)
        let count = await server.requests(forPath: manifestPath).count
        XCTAssertEqual(count, 1)
    }

    func testRetriesAreBoundedAndTakenInKidByteOrder() async throws {
        let signers = (0..<6).map { TestSigner(kid: "pkey-k\($0)-2026") }
        let stranger = TestSigner(kid: "pkey-stranger")
        let doc = manifest(stranger, issuedAt: nowSec(), keys: [(stranger, "active")])
        await server.reply(manifestPath, body: doc)
        let c = try await core(
            store: InMemoryStore(deviceId: "dev"),
            pinned: Dictionary(uniqueKeysWithValues: signers.map { ($0.kid, $0.publicKeyB64) }))
        _ = await c.refreshTrust()
        let sent = await server.requests(forPath: manifestPath).compactMap(\.url.query)
        XCTAssertEqual(sent.count, MAX_TRUST_SIGNER_ATTEMPTS)
        XCTAssertEqual(sent, signers.prefix(MAX_TRUST_SIGNER_ATTEMPTS).map { "signer=\($0.kid)" })
    }

    // ── Pin tombstones and their evidence (§1, §4.1) ──────────────────────────────────────

    func testARevokedPinIsTombstonedAndItsEvidenceSurvivesARestart() async throws {
        let t = nowSec()
        let store = InMemoryStore(deviceId: "dev")
        let revoking = manifest(b, issuedAt: t, keys: [(b, "active"), (a, "revoked")])
        await server.reply(manifestPath, body: revoking)
        let c = try await core(store: store)
        let ok = await c.refreshTrust()
        XCTAssertTrue(ok)
        var revoked = await c.revokedPins
        XCTAssertEqual(revoked, [a.kid])
        var trust = await c.trust
        XCTAssertNil(trust[a.kid], "a tombstoned pin is in no set")

        // The evidence is written in the SAME write as the manifest.
        let record = await store.readCache()
        XCTAssertEqual(record?.trustJws, revoking)
        XCTAssertEqual(record?.pinRevocations, [a.kid: revoking])

        // A restart re-derives the tombstone from the signed evidence alone.
        let restarted = try await core(store: store)
        revoked = await restarted.revokedPins
        XCTAssertEqual(revoked, [a.kid])
        trust = await restarted.trust
        XCTAssertNil(trust[a.kid])
        XCTAssertNotNil(trust[b.kid])
    }

    func testForgedEvidenceDoesNotTombstoneAndIsDropped() async throws {
        let store = InMemoryStore(deviceId: "dev")
        // Evidence filed under A that is signed by a stranger.
        let stranger = TestSigner(kid: b.kid)
        let forged = manifest(stranger, issuedAt: nowSec(), keys: [(b, "active"), (a, "revoked")])
        await store.writeCache(CacheRecord(pinRevocations: [a.kid: forged]))
        let c = try await core(store: store)
        let revoked = await c.revokedPins
        XCTAssertEqual(revoked, [])
        let trust = await c.trust
        XCTAssertNotNil(trust[a.kid])
    }

    func testDeactivationAndImportCarryTheEvidence() async throws {
        let t = nowSec()
        let store = InMemoryStore(deviceId: "dev")
        let revoking = manifest(b, issuedAt: t, keys: [(b, "active"), (a, "revoked")])
        await server.reply(manifestPath, body: revoking)
        let c = try await core(store: store)
        _ = await c.refreshTrust()
        try await c.clearAll()
        let record = await store.readCache()
        XCTAssertEqual(record?.pinRevocations, [a.kid: revoking], "a tombstone is not a grant")
        XCTAssertNil(record?.trustJws)
        let revoked = await c.revokedPins
        XCTAssertEqual(revoked, [a.kid])
    }

    // ── The signed bundle slice (§4.1, §7) ───────────────────────────────────────────────

    private func bundle(
        _ signer: TestSigner, id: String, t: Int, deviceId: String = "dev",
        trust: String? = nil
    ) -> String {
        signer.sign(
            Fixtures.bundle(
                bundleId: id, deviceId: deviceId, issuedAt: t,
                license: signer.sign(Fixtures.license(issuedAt: t)),
                trust: trust ?? manifest(signer, issuedAt: t, keys: [(signer, "active")])))
    }

    func testImportStoresTheBundleVerbatimAndAReimportWritesNothing() async throws {
        let t = nowSec()
        let store = InMemoryStore(deviceId: "dev")
        let c = try await core(store: store, pinned: [a.kid: a.publicKeyB64])
        let jws = bundle(a, id: "01JBUNDLE0000000000000AAAA", t: t)
        let first = try await c.importBundle(jws, now: t)
        XCTAssertEqual(first.imported, [.license])
        let written = await store.readCache()
        XCTAssertEqual(written?.bundle, jws)

        // Mutate the stored record so a second write would be visible.
        var marker = try XCTUnwrap(written)
        marker.lastSyncUnauthorized = true
        await store.writeCache(marker)
        let again = try await c.importBundle(jws, now: t)
        XCTAssertEqual(again, first)
        let after = await store.readCache()
        XCTAssertEqual(after?.lastSyncUnauthorized, true, "the re-import wrote nothing")
    }

    func testAnOlderOrEqualBundleCannotRollTheInstallBack() async throws {
        let t = nowSec()
        let store = InMemoryStore(deviceId: "dev")
        let c = try await core(store: store, pinned: [a.kid: a.publicKeyB64])
        _ = try await c.importBundle(bundle(a, id: "01JBUNDLE0000000000000AAAA", t: t), now: t)
        // A different bundle whose licence document is issued the same second: not strictly
        // newer than the cached one.
        let sameSecond = bundle(a, id: "01JBUNDLE0000000000000BBBB", t: t)
        do {
            _ = try await c.importBundle(sameSecond, now: t)
            XCTFail("an equal licence must be refused")
        } catch let error as PolarisError {
            XCTAssertEqual(error.code, "inner-doc-rejected")
        }
        // A strictly newer one imports.
        let newer = bundle(a, id: "01JBUNDLE0000000000000CCCC", t: t + 10)
        let ok = try await c.importBundle(newer, now: t + 10)
        XCTAssertEqual(ok.bundleId, "01JBUNDLE0000000000000CCCC")
    }

    func testABundleSurvivesItsImportWindowButOnlyActivatesWhileItVerifies() async throws {
        let t = nowSec()
        let store = InMemoryStore(deviceId: "dev")
        let jws = bundle(a, id: "01JBUNDLE0000000000000AAAA", t: t)
        do {
            let c = try await core(store: store, pinned: [a.kid: a.publicKeyB64])
            _ = try await c.importBundle(jws, now: t)
        }
        // A restart reloads it on the reload profile: still active, whatever the age.
        let restarted = try await core(store: store, pinned: [a.kid: a.publicKeyB64])
        var cache = await restarted.cache()
        XCTAssertEqual(cache.bundle?.activates, true)
        XCTAssertEqual(cache.bundle?.docs, [.license])

        // The same record under a build that no longer pins the signer: the bundle does not
        // re-verify, so nothing activates even though the licence slice is still on disk.
        let other = TestSigner(kid: "pkey-other-2028")
        let foreign = try await core(store: store, pinned: [other.kid: other.publicKeyB64])
        cache = await foreign.cache()
        XCTAssertNil(cache.bundle)
        XCTAssertNil(cache.license)
    }

    func testAnUnsignedLicenceSliceAloneNeverActivates() async throws {
        // The retired marker is not read: a licence document with no re-verifying bundle (and
        // no token) is not an activation.
        let t = nowSec()
        let store = InMemoryStore(deviceId: "dev")
        await store.writeCache(CacheRecord(docs: [.license: a.sign(Fixtures.license(issuedAt: t))]))
        let c = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [a.kid: a.publicKeyB64], trustRefresh: false, store: store,
                transport: server.transport, expectedServices: [.license], fingerprint: false))
        let activation = await c.license.activation()
        XCTAssertNil(activation)
    }

    func testAnOlderBundleManifestDoesNotReplaceTheHeldOne() async throws {
        let t = nowSec()
        let store = InMemoryStore(deviceId: "dev")
        let c = try await core(store: store, pinned: [a.kid: a.publicKeyB64])
        // A held manifest, newer than the one the bundle will carry.
        let held = manifest(a, issuedAt: t + 200, keys: [(a, "active")])
        await server.reply(manifestPath, body: held)
        // Freshness is judged at the effective clock, which `now()` supplies.
        let ok = await c.refreshTrust()
        XCTAssertTrue(ok)
        _ = try await c.importBundle(bundle(a, id: "01JBUNDLE0000000000000AAAA", t: t), now: t)
        let record = await store.readCache()
        XCTAssertEqual(record?.trustJws, held, "an older bundle cannot replace a newer manifest")
    }
}
