// Wire contract v2 §1/§4/§5 regression tests, driven through a whole `PolarisKeyClient`
// against a routing HTTP stub.
//
// These cover the CRITICAL trio (R2-01/R4-02 pinned-kid substitution, R2-02/R4-03 no
// revocation, R2-03/R4-01 the cache is never re-verified) plus the cache format and the 304
// freshness rule. Every one of them asserts the ATTACK FAILS; before the v2 changes the
// equivalent assertions would have gone the other way.

import Foundation
import XCTest

@testable import PolarisKey

final class TrustAndCacheTests: XCTestCase {
    private let pinnedKid = "pkey-pinned-2026"
    private var vendor = TestSigner(kid: "pkey-pinned-2026")
    private var attacker = TestSigner(kid: "pkey-pinned-2026")
    private var rotated = TestSigner(kid: "pkey-rotated-2027")

    override func setUp() {
        super.setUp()
        vendor = TestSigner(kid: pinnedKid)
        attacker = TestSigner(kid: pinnedKid)
        rotated = TestSigner(kid: "pkey-rotated-2027")
        StubServer.reset()
    }

    override func tearDown() {
        StubServer.reset()
        super.tearDown()
    }

    private func nowSec() -> Int { Int(Date().timeIntervalSince1970) }

    private func options(
        store: Store, trustRefresh: Bool = true, session: URLSession? = nil
    ) -> PolarisKeyOptions {
        PolarisKeyOptions(
            productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
            trust: PolarisTrust(pinnedKeys: [pinnedKid: vendor.publicKeyB64]),
            store: store, session: session ?? StubServer.session(), trustRefresh: trustRefresh,
            fingerprint: false)
    }

    private func seededStore(_ record: CacheRecord) async -> InMemoryStore {
        let store = InMemoryStore(deviceId: "dev")
        await store.setToken("tok")
        await store.writeCache(record)
        return store
    }

    private func routeConfig(_ jws: String, etag: String = "v1") {
        StubServer.route("/djdl/config") { _ in
            StubServer.Reply(status: 200, body: jws, headers: ["ETag": etag])
        }
    }

    private func routeTrust(_ jws: String) {
        StubServer.route("/djdl/.well-known/polaris-trust.jws") { _ in
            StubServer.Reply(status: 200, body: jws)
        }
    }

    // ── §1 the cache is no longer a key source (R2-01 / R4-02, CRITICAL) ───────────
    /// The attack that used to work: plant a trust manifest in the cache that maps the
    /// PINNED kid to attacker-held bytes, plus a doc signed by that key. The cached manifest
    /// is now re-verified against the PINNED keys only, so it never installs, and the doc it
    /// was meant to authorise is refused.
    func testCachedTrustCannotSubstituteAPinnedKid() async throws {
        let t = nowSec()
        let forged = attacker.sign(
            Fixtures.doc(
                issuedAt: t, entitlements: ["pro": Fixtures.entry(.bool(true))]))
        let forgedManifest = attacker.sign(
            Fixtures.manifest(
                issuedAt: t,
                keys: [Fixtures.manifestKey(kid: pinnedKid, publicKey: attacker.publicKeyB64)]),
            typ: JwsTyp.trust.rawValue)
        let store = await seededStore(
            CacheRecord(configJws: forged, trustJws: forgedManifest))

        let client = try await PolarisKeyClient.create(
            options: options(store: store, trustRefresh: false))

        let status = await client.status().status
        let entitled = await client.isEntitled("pro")
        XCTAssertEqual(status, .needsActivation, "a forged cache must not licence the app")
        XCTAssertFalse(entitled)
        // Control: the SAME doc signed by the real pinned key is accepted, so the rejection
        // above is the trust rule and not some unrelated parse failure.
        let honest = await seededStore(
            CacheRecord(
                configJws: vendor.sign(
                    Fixtures.doc(
                        issuedAt: t, entitlements: ["pro": Fixtures.entry(.bool(true))]))))
        let good = try await PolarisKeyClient.create(
            options: options(store: honest, trustRefresh: false))
        let goodStatus = await good.status().status
        let goodEntitled = await good.isEntitled("pro")
        XCTAssertEqual(goodStatus, .ok)
        XCTAssertTrue(goodEntitled)
    }

    /// §1.1.1 — a manifest that presents a pinned kid with DIFFERENT bytes is a substitution
    /// attempt: the WHOLE manifest is rejected, including the otherwise-legitimate key it
    /// smuggles alongside.
    func testManifestSubstitutingAPinnedKidIsRejectedWholesale() async throws {
        let t = nowSec()
        // Signed by the REAL pinned key — the server (or a leaked signing key) is hostile.
        routeTrust(
            vendor.sign(
                Fixtures.manifest(
                    issuedAt: t,
                    keys: [
                        Fixtures.manifestKey(
                            kid: pinnedKid, publicKey: attacker.publicKeyB64),
                        Fixtures.manifestKey(
                            kid: rotated.kid, publicKey: rotated.publicKeyB64),
                    ]),
                typ: JwsTyp.trust.rawValue))
        routeConfig(rotated.sign(Fixtures.doc(issuedAt: t)))

        let client = try await PolarisKeyClient.create(options: options(store: await seededStore(CacheRecord())))
        let result = await client.refresh()
        let status = await client.status().status
        XCTAssertFalse(result.applied, "the smuggled key must not have been installed")
        XCTAssertEqual(status, .needsActivation)

        // Control: the same manifest with the pinned kid's REAL bytes installs the rotation
        // key, and the identical document is then accepted.
        StubServer.reset()
        routeTrust(
            vendor.sign(
                Fixtures.manifest(
                    issuedAt: t,
                    keys: [
                        Fixtures.manifestKey(kid: pinnedKid, publicKey: vendor.publicKeyB64),
                        Fixtures.manifestKey(
                            kid: rotated.kid, publicKey: rotated.publicKeyB64),
                    ]),
                typ: JwsTyp.trust.rawValue))
        routeConfig(rotated.sign(Fixtures.doc(issuedAt: t)))
        let ok = try await PolarisKeyClient.create(options: options(store: await seededStore(CacheRecord())))
        let okResult = await ok.refresh()
        XCTAssertTrue(okResult.applied)
    }

    /// §1.2 — `status` is normative, and pruning is mandatory. A key the manifest marks
    /// `revoked`, and a key it simply stops publishing, both stop verifying documents.
    func testRevokedAndOmittedKeysArePruned() async throws {
        let t = nowSec()
        let manifestV1 = vendor.sign(
            Fixtures.manifest(
                issuedAt: t - 10,
                keys: [
                    Fixtures.manifestKey(kid: pinnedKid, publicKey: vendor.publicKeyB64),
                    Fixtures.manifestKey(kid: rotated.kid, publicKey: rotated.publicKeyB64),
                ]),
            typ: JwsTyp.trust.rawValue)

        for (label, second) in [
            ("explicitly revoked",
             Fixtures.manifest(
                issuedAt: t,
                keys: [
                    Fixtures.manifestKey(kid: pinnedKid, publicKey: vendor.publicKeyB64),
                    Fixtures.manifestKey(
                        kid: rotated.kid, publicKey: rotated.publicKeyB64,
                        status: "revoked"),
                ])),
            ("dropped by omission",
             Fixtures.manifest(
                issuedAt: t,
                keys: [Fixtures.manifestKey(kid: pinnedKid, publicKey: vendor.publicKeyB64)])),
        ] {
            StubServer.reset()
            routeTrust(manifestV1)
            routeConfig(rotated.sign(Fixtures.doc(issuedAt: t - 5)))
            let client = try await PolarisKeyClient.create(
                options: options(store: await seededStore(CacheRecord())))
            let first = await client.refresh()
            XCTAssertTrue(first.applied, "\(label): the rotation key should start out trusted")

            // The operator revokes it; the next manifest carries a higher issuedAt.
            StubServer.reset()
            routeTrust(vendor.sign(second, typ: JwsTyp.trust.rawValue))
            routeConfig(rotated.sign(Fixtures.doc(issuedAt: t + 1)))
            let after = await client.refresh()
            XCTAssertFalse(
                after.applied,
                "\(label): a document signed by the pruned key must no longer verify")
        }
    }

    /// §1.2.5 — a pinned key is never pruned, whatever the manifest says. Pinning is the
    /// escape hatch for a total control-plane compromise.
    func testPinnedKeySurvivesAManifestThatOmitsIt() async throws {
        let t = nowSec()
        routeTrust(
            vendor.sign(
                Fixtures.manifest(
                    issuedAt: t,
                    keys: [
                        Fixtures.manifestKey(
                            kid: rotated.kid, publicKey: rotated.publicKeyB64)
                    ]),
                typ: JwsTyp.trust.rawValue))
        routeConfig(vendor.sign(Fixtures.doc(issuedAt: t)))
        let client = try await PolarisKeyClient.create(
            options: options(store: await seededStore(CacheRecord())))
        let result = await client.refresh()
        XCTAssertTrue(result.applied)
    }

    /// A config doc replayed where the trust manifest is expected is refused on `typ` — not
    /// by accident, on a swallowed decode error (R2-10).
    func testConfigDocIsNotAcceptedAsATrustManifest() async throws {
        let t = nowSec()
        routeTrust(vendor.sign(Fixtures.doc(issuedAt: t)))
        routeConfig(rotated.sign(Fixtures.doc(issuedAt: t)))
        let client = try await PolarisKeyClient.create(
            options: options(store: await seededStore(CacheRecord())))
        let result = await client.refresh()
        XCTAssertFalse(result.applied)
    }

    /// The manifest's `schemaVersion` IS a genuine wire version, so an unknown one fails
    /// closed — unlike a config doc's, which is the per-product catalog version (§3.1).
    func testUnknownManifestSchemaVersionIsRefused() {
        let t = nowSec()
        let manifest = Fixtures.manifest(
            issuedAt: t,
            keys: [Fixtures.manifestKey(kid: rotated.kid, publicKey: rotated.publicKeyB64)])
        let good = verifyTrustManifest(
            vendor.sign(manifest, typ: JwsTyp.trust.rawValue),
            options: VerifyTrustManifestOptions(
                pinned: [pinnedKid: vendor.publicKeyB64], expectedAud: "djdl", now: t))
        XCTAssertNotNil(good.doc)

        let future = vendor.sign(
            payloadJSON: String(
                decoding: try! JSONEncoder().encode(manifest), as: UTF8.self)
                .replacingOccurrences(
                    of: #""schemaVersion":1"#, with: #""schemaVersion":99"#),
            typ: JwsTyp.trust.rawValue)
        let refused = verifyTrustManifest(
            future,
            options: VerifyTrustManifestOptions(
                pinned: [pinnedKid: vendor.publicKeyB64], expectedAud: "djdl", now: t))
        XCTAssertNil(refused.doc)
        XCTAssertTrue(refused.discovered.isEmpty)
    }

    /// A cached manifest expires in `cacheSeconds` — minutes — so its freshness must NOT be
    /// re-checked on load, or every restart would silently drop the discovered keys and stop
    /// verifying documents signed by a rotated key while offline. It is still verified
    /// against the pins, and still refused on the NETWORK path once expired.
    func testStaleCachedManifestStillYieldsItsKeysOnLoad() async throws {
        let t = nowSec()
        let expired = vendor.sign(
            Fixtures.manifest(
                issuedAt: t - 3600, expiresAt: t - 3300,
                keys: [Fixtures.manifestKey(kid: rotated.kid, publicKey: rotated.publicKeyB64)]),
            typ: JwsTyp.trust.rawValue)
        let store = await seededStore(
            CacheRecord(
                configJws: rotated.sign(Fixtures.doc(issuedAt: t)), trustJws: expired))
        let client = try await PolarisKeyClient.create(
            options: options(store: store, trustRefresh: false))
        let status = await client.status().status
        XCTAssertEqual(status, .ok, "a stale cached manifest must still supply its keys")

        // On the network path the same manifest is refused as expired.
        let fresh = verifyTrustManifest(
            expired,
            options: VerifyTrustManifestOptions(
                pinned: [pinnedKid: vendor.publicKeyB64], expectedAud: "djdl", now: t))
        XCTAssertNil(fresh.doc)
    }

    // ── §4 cache integrity ────────────────────────────────────────────────────────
    /// Only signed artifacts are persisted. The fields every previous attack rewrote —
    /// `doc`, `trustedKeys`, `lastAcceptedIssuedAt`, `lastTrustIssuedAt`, `lastVerifiedAt` —
    /// no longer exist on disk.
    func testCachePersistsSignedArtifactsOnly() async throws {
        let t = nowSec()
        routeTrust(
            vendor.sign(
                Fixtures.manifest(
                    issuedAt: t,
                    keys: [Fixtures.manifestKey(kid: pinnedKid, publicKey: vendor.publicKeyB64)]),
                typ: JwsTyp.trust.rawValue))
        routeConfig(vendor.sign(Fixtures.doc(issuedAt: t)))
        let store = await seededStore(CacheRecord())
        let client = try await PolarisKeyClient.create(options: options(store: store))
        _ = await client.refresh()

        guard let record = await store.readCache() else { return XCTFail("no cache written") }
        XCTAssertEqual(record.v, CACHE_RECORD_VERSION)
        XCTAssertNotNil(record.configJws)
        XCTAssertNotNil(record.trustJws)
        let json = String(
            decoding: try JSONEncoder().encode(record), as: UTF8.self)
        for banned in [
            "\"doc\"", "trustedKeys", "lastAcceptedIssuedAt", "lastTrustIssuedAt",
            "lastVerifiedAt",
        ] {
            XCTAssertFalse(json.contains(banned), "\(banned) must not be persisted")
        }
    }

    /// A cached doc is re-verified on load, so a hand-written one is worthless — including
    /// one lifted from ANOTHER DEVICE, which the old reload path never re-checked.
    func testCachedDocIsReVerifiedOnLoad() async throws {
        let t = nowSec()
        for (label, jws) in [
            ("untrusted signer", TestSigner(kid: pinnedKid).sign(Fixtures.doc(issuedAt: t))),
            ("another device", vendor.sign(Fixtures.doc(deviceId: "somebody-else", issuedAt: t))),
            ("another product", vendor.sign(Fixtures.doc(aud: "other", issuedAt: t))),
            ("wrong issuer", vendor.sign(Fixtures.doc(iss: "https://evil.example", issuedAt: t))),
            ("a trust manifest replayed as a config doc",
             vendor.sign(
                Fixtures.manifest(issuedAt: t, keys: []), typ: JwsTyp.trust.rawValue)),
            ("not a JWS at all", "not-a-jws"),
        ] {
            let store = await seededStore(CacheRecord(configJws: jws))
            let client = try await PolarisKeyClient.create(
                options: options(store: store, trustRefresh: false))
            let status = await client.status().status
            XCTAssertEqual(status, .needsActivation, "\(label) must not load")
        }

        // A doc dated absurdly far in the FUTURE cannot load and drag the monotonic floor
        // with it — that would pin the gate at `ok` indefinitely.
        let future = await seededStore(
            CacheRecord(
                configJws: vendor.sign(
                    Fixtures.doc(
                        issuedAt: Int.max - MAX_GRACE_SECONDS, expiresAt: Int.max - 1,
                        graceUntil: Int.max))))
        let futureClient = try await PolarisKeyClient.create(
            options: options(store: future, trustRefresh: false))
        let futureStatus = await futureClient.status().status
        let futureFloor = await futureClient.highWaterMark
        XCTAssertEqual(futureStatus, .needsActivation)
        XCTAssertEqual(futureFloor, 0)

        // A doc past its whole signed grace window DOES load — every claim but freshness
        // still holds — and the gate is what refuses it. Either way it is not usable.
        let stale = await seededStore(
            CacheRecord(configJws: vendor.sign(Fixtures.doc(issuedAt: t - 400 * SECONDS_PER_DAY))))
        let client = try await PolarisKeyClient.create(
            options: options(store: stale, trustRefresh: false))
        let staleStatus = await client.status().status
        let licensed = await client.isLicensed()
        XCTAssertEqual(staleStatus, .expired)
        XCTAssertFalse(licensed)
    }

    /// A `v1` record is discarded rather than migrated (§7.3): it decodes to nothing, so
    /// none of its unsigned state can be carried forward.
    func testV1CacheRecordIsDiscarded() async throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = KeychainStore(productSlug: "djdl", configDir: dir)
        let v1 = #"""
            {"doc":{"schemaVersion":1,"aud":"djdl","iss":"key.plrs.im","licenseId":"l",
            "deviceId":"dev","issuedAt":1,"expiresAt":2,"graceUntil":99999999999,
            "profile":{"name":"n","firstName":"f","email":"e","activatedAt":0},
            "payload":{"config":{},"secrets":{},"entitlements":{}}},
            "lastAcceptedIssuedAt":0,"trustedKeys":{"\#(pinnedKid)":"\#(attacker.publicKeyB64)"}}
            """#
        try Data(v1.utf8).write(
            to: dir.appendingPathComponent("djdl").appendingPathComponent("managed.json"))
        let loaded = await store.readCache()
        XCTAssertNil(loaded, "a v1 record must not decode")
    }

    /// `lastAcceptedIssuedAt` is DERIVED from the re-verified doc, so the replay window
    /// cannot be re-opened by editing a file: an older document is still refused.
    func testAntiReplayCounterIsDerivedFromTheCachedDoc() async throws {
        let t = nowSec()
        let store = await seededStore(
            CacheRecord(configJws: vendor.sign(Fixtures.doc(issuedAt: t))))
        let client = try await PolarisKeyClient.create(
            options: options(store: store, trustRefresh: false))
        routeConfig(vendor.sign(Fixtures.doc(issuedAt: t - 1)))
        let replayed = await client.refresh()
        XCTAssertFalse(replayed.applied, "an older document must not be applied")

        routeConfig(vendor.sign(Fixtures.doc(issuedAt: t + 1)))
        let fresh = await client.refresh()
        XCTAssertTrue(fresh.applied)
    }

    /// §4.3 — the monotonic floor is recomputed at load from the signed document, never read
    /// from disk, so a clock rollback cannot widen any window.
    func testMonotonicFloorIsDerivedFromTheSignedDocument() async throws {
        let t = nowSec()
        let store = await seededStore(
            CacheRecord(configJws: vendor.sign(Fixtures.doc(issuedAt: t))))
        let client = try await PolarisKeyClient.create(
            options: options(store: store, trustRefresh: false))
        let floor = await client.highWaterMark
        XCTAssertEqual(floor, t)
        // A rolled-back clock is floored at the greatest verified `issuedAt`.
        let rolledBack = await client.status(now: t - 365 * SECONDS_PER_DAY)
        XCTAssertEqual(rolledBack.status, .ok)
    }

    // ── §5 a 304 renews freshness (R2-11) ─────────────────────────────────────────
    /// A continuously ONLINE client must never drift into `grace` because its content ETag
    /// is stable. Once the cached document is inside the refresh margin, a 304 is escalated
    /// to an unconditional fetch that returns a freshly signed document.
    func test304NearExpiryEscalatesToAnUnconditionalFetch() async throws {
        let t = nowSec()
        // Cached doc is 1900s old ⇒ inside the 1800s refresh margin.
        let store = await seededStore(
            CacheRecord(configJws: vendor.sign(Fixtures.doc(issuedAt: t - 1900)), etag: "v1"))
        let client = try await PolarisKeyClient.create(
            options: options(store: store, trustRefresh: false))

        let fresh = vendor.sign(Fixtures.doc(issuedAt: t))
        StubServer.route("/djdl/config") { req in
            req.value(forHTTPHeaderField: "If-None-Match") != nil
                ? StubServer.Reply(status: 304, body: "", headers: ["ETag": "v1"])
                : StubServer.Reply(status: 200, body: fresh, headers: ["ETag": "v1"])
        }

        let result = await client.refresh()
        let status = await client.status().status
        XCTAssertTrue(result.applied, "a 304 near expiry must be escalated, not accepted")
        XCTAssertEqual(status, .ok)
        let unconditional = StubServer.requests(forPath: "/djdl/config")
            .filter { $0.value(forHTTPHeaderField: "If-None-Match") == nil }
        XCTAssertEqual(unconditional.count, 1)
    }

    /// …and while the document is comfortably fresh, a 304 stays a 304: no extra round trip.
    func test304OnAFreshDocumentDoesNotRefetch() async throws {
        let t = nowSec()
        let store = await seededStore(
            CacheRecord(configJws: vendor.sign(Fixtures.doc(issuedAt: t)), etag: "v1"))
        let client = try await PolarisKeyClient.create(
            options: options(store: store, trustRefresh: false))
        StubServer.route("/djdl/config") { _ in
            StubServer.Reply(status: 304, body: "", headers: ["ETag": "v1"])
        }
        let result = await client.refresh()
        XCTAssertFalse(result.applied)
        XCTAssertEqual(StubServer.requests(forPath: "/djdl/config").count, 1)
    }

    /// `refresh(force:)` drops the conditional request outright — without it, `activate()`
    /// could 304 against a stale ETag and never install the first document.
    func testForcedRefreshSendsNoConditionalHeader() async throws {
        let t = nowSec()
        let store = await seededStore(
            CacheRecord(configJws: vendor.sign(Fixtures.doc(issuedAt: t)), etag: "v1"))
        let client = try await PolarisKeyClient.create(
            options: options(store: store, trustRefresh: false))
        routeConfig(vendor.sign(Fixtures.doc(issuedAt: t + 1)), etag: "v2")

        _ = await client.refresh()
        XCTAssertEqual(
            StubServer.requests(forPath: "/djdl/config").last?
                .value(forHTTPHeaderField: "If-None-Match"), "v1")

        _ = await client.refresh(force: true)
        XCTAssertNil(
            StubServer.requests(forPath: "/djdl/config").last?
                .value(forHTTPHeaderField: "If-None-Match"))
    }

    /// The report snapshot carries the software facts, on the same call, exactly as the Node
    /// and Python SDKs send them — `Facts.collect()` used to have no callers at all.
    func testReportSnapshotCarriesDeviceFacts() async throws {
        let t = nowSec()
        routeConfig(vendor.sign(Fixtures.doc(issuedAt: t)))
        let client = try await PolarisKeyClient.create(
            options: options(store: await seededStore(CacheRecord()), trustRefresh: false))
        _ = await client.refresh()

        guard let body = StubServer.requests(forPath: "/djdl/config/report").last?
            .httpBodyStream.map({ stream -> Data in
                stream.open()
                defer { stream.close() }
                var out = Data()
                var buf = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable {
                    let n = stream.read(&buf, maxLength: buf.count)
                    if n <= 0 { break }
                    out.append(contentsOf: buf[0..<n])
                }
                return out
            })
        else { return XCTFail("no report body captured") }
        let json = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        XCTAssertNotNil(json?["os"], "software facts must ride on the report call")
        XCTAssertNotNil(json?["hardware"])
        XCTAssertNotNil(json?["runtime"])
        XCTAssertNotNil(json?["config"])
        XCTAssertNotNil(json?["entitlements"])
    }
}
