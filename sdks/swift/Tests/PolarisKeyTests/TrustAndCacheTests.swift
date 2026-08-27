// Wire contract v3 §1/§4/§5 regression tests, driven through a whole `PolarisKeyClient` against a
// routing transport stub.
//
// These cover the CRITICAL trio (R2-01/R4-02 pinned-kid substitution, R2-02/R4-03 no revocation,
// R2-03/R4-01 the cache is never re-verified) plus the cache format, the clock floor and the 304
// freshness rule. Every one of them asserts the ATTACK FAILS; before the v2 hardening the
// equivalent assertions would have gone the other way.
//
// The floor invariants here are load-bearing beyond this file: §4.2's whole argument is that a
// floor derived from documents alone is INERT, and `testTrustManifestAnchorsTheClockFloor`
// pins both halves — the defect and the fix — so neither can quietly return.

import Foundation
import PolarisKey
import PolarisKeyConfig
import PolarisKeyCore
import PolarisKeyLicense
import XCTest

final class TrustAndCacheTests: XCTestCase {
    private let pinnedKid = "pkey-pinned-2026"
    private var vendor = TestSigner(kid: "pkey-pinned-2026")
    private var attacker = TestSigner(kid: "pkey-pinned-2026")
    private var rotated = TestSigner(kid: "pkey-rotated-2027")
    private var server = StubServer()

    private let licensePath = "/djdl/license/document"
    private let configPath = "/djdl/config/document"
    private let trustPath = "/djdl/.well-known/polaris-trust.jws"
    private let reportPath = "/djdl/devices/report"

    override func setUp() {
        super.setUp()
        vendor = TestSigner(kid: pinnedKid)
        attacker = TestSigner(kid: pinnedKid)
        rotated = TestSigner(kid: "pkey-rotated-2027")
        server = StubServer()
    }

    private func nowSec() -> Int { Int(Date().timeIntervalSince1970) }

    /// Most tests here are about the LICENSE document and the trust manifest, so config is left
    /// out of the capability map: an enabled-but-unstubbed service would add a second fetch to
    /// every assertion about request counts.
    private func options(
        store: any Store, trustRefresh: Bool = true,
        services: [ServiceSlug] = [.license]
    ) -> PolarisKeyClientOptions {
        PolarisKeyClientOptions(
            productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
            pinnedKeys: [pinnedKid: vendor.publicKeyB64], trustRefresh: trustRefresh,
            store: store, transport: server.transport, expectedServices: services,
            fingerprint: false)
    }

    private func seededStore(_ record: CacheRecord?) async -> InMemoryStore {
        let store = InMemoryStore(deviceId: "dev")
        await store.setToken("pkeyt_test")
        if let record { await store.writeCache(record) }
        return store
    }

    private func client(
        _ record: CacheRecord? = CacheRecord(), trustRefresh: Bool = true,
        services: [ServiceSlug] = [.license]
    ) async throws -> PolarisKeyClient {
        try await PolarisKeyClient.create(
            options: options(
                store: await seededStore(record), trustRefresh: trustRefresh,
                services: services))
    }

    private func routeLicense(_ jws: String, etag: String = "v1") async {
        await server.route(licensePath) { _ in
            StubServer.Reply(status: 200, body: jws, headers: ["ETag": etag])
        }
    }

    private func routeConfig(_ jws: String, etag: String = "c1") async {
        await server.route(configPath) { _ in
            StubServer.Reply(status: 200, body: jws, headers: ["ETag": etag])
        }
    }

    private func routeTrust(_ jws: String) async {
        await server.route(trustPath) { _ in StubServer.Reply(status: 200, body: jws) }
    }

    // ── §1 the cache is no longer a key source (R2-01 / R4-02, CRITICAL) ───────────
    /// The attack that used to work: plant a trust manifest in the cache that maps the PINNED kid
    /// to attacker-held bytes, plus a document signed by that key. The cached manifest is
    /// re-verified against the PINNED keys only, so it never installs, and the document it was
    /// meant to authorise is refused.
    func testCachedTrustCannotSubstituteAPinnedKid() async throws {
        let t = nowSec()
        let forged = attacker.sign(
            Fixtures.license(issuedAt: t, entitlements: ["pro": Fixtures.entry(.bool(true))]))
        let forgedManifest = attacker.sign(
            Fixtures.manifest(
                issuedAt: t,
                keys: [Fixtures.manifestKey(kid: pinnedKid, publicKey: attacker.publicKeyB64)]))
        let c = try await client(
            CacheRecord(trustJws: forgedManifest, docs: [.license: forged]),
            trustRefresh: false)

        let status = await c.status().status
        let entitled = await c.license.isEntitled("pro")
        XCTAssertEqual(status, .needsActivation, "a forged cache must not licence the app")
        XCTAssertFalse(entitled)

        // Control: the SAME document signed by the real pinned key is accepted, so the rejection
        // above is the trust rule and not some unrelated parse failure.
        let good = try await client(
            CacheRecord(
                docs: [
                    .license: vendor.sign(
                        Fixtures.license(
                            issuedAt: t, entitlements: ["pro": Fixtures.entry(.bool(true))]))
                ]), trustRefresh: false)
        let goodStatus = await good.status().status
        let goodEntitled = await good.license.isEntitled("pro")
        XCTAssertEqual(goodStatus, .ok)
        XCTAssertTrue(goodEntitled)
    }

    /// §1 — a manifest that presents a pinned kid with DIFFERENT bytes is a substitution attempt:
    /// the WHOLE manifest is rejected, including the otherwise-legitimate key it smuggles
    /// alongside.
    func testManifestSubstitutingAPinnedKidIsRejectedWholesale() async throws {
        let t = nowSec()
        // Signed by the REAL pinned key — the server (or a leaked signing key) is hostile.
        await routeTrust(
            vendor.sign(
                Fixtures.manifest(
                    issuedAt: t,
                    keys: [
                        Fixtures.manifestKey(kid: pinnedKid, publicKey: attacker.publicKeyB64),
                        Fixtures.manifestKey(
                            kid: rotated.kid, publicKey: rotated.publicKeyB64),
                    ])))
        await routeLicense(rotated.sign(Fixtures.license(issuedAt: t)))

        let c = try await client()
        let result = await c.sync()
        let status = await c.status().status
        XCTAssertFalse(result.applied, "the smuggled key must not have been installed")
        XCTAssertEqual(status, .needsActivation)

        // Control: the same manifest with the pinned kid's REAL bytes installs the rotation key,
        // and the identical document is then accepted.
        server = StubServer()
        await routeTrust(
            vendor.sign(
                Fixtures.manifest(
                    issuedAt: t,
                    keys: [
                        Fixtures.manifestKey(kid: pinnedKid, publicKey: vendor.publicKeyB64),
                        Fixtures.manifestKey(
                            kid: rotated.kid, publicKey: rotated.publicKeyB64),
                    ])))
        await routeLicense(rotated.sign(Fixtures.license(issuedAt: t)))
        let ok = try await client()
        let okResult = await ok.sync()
        XCTAssertTrue(okResult.applied)
    }

    /// §1 — `status` is normative, and pruning is mandatory. A key the manifest marks `revoked`,
    /// and a key it simply stops publishing, both stop verifying documents.
    func testRevokedAndOmittedKeysArePruned() async throws {
        let t = nowSec()
        let manifestV1 = vendor.sign(
            Fixtures.manifest(
                issuedAt: t - 10,
                keys: [
                    Fixtures.manifestKey(kid: pinnedKid, publicKey: vendor.publicKeyB64),
                    Fixtures.manifestKey(kid: rotated.kid, publicKey: rotated.publicKeyB64),
                ]))

        for (label, second) in [
            (
                "explicitly revoked",
                Fixtures.manifest(
                    issuedAt: t,
                    keys: [
                        Fixtures.manifestKey(kid: pinnedKid, publicKey: vendor.publicKeyB64),
                        Fixtures.manifestKey(
                            kid: rotated.kid, publicKey: rotated.publicKeyB64,
                            status: "revoked"),
                    ])
            ),
            (
                "dropped by omission",
                Fixtures.manifest(
                    issuedAt: t,
                    keys: [
                        Fixtures.manifestKey(kid: pinnedKid, publicKey: vendor.publicKeyB64)
                    ])
            ),
        ] {
            server = StubServer()
            await routeTrust(manifestV1)
            await routeLicense(rotated.sign(Fixtures.license(issuedAt: t - 5)))
            let c = try await client()
            let first = await c.sync()
            XCTAssertTrue(first.applied, "\(label): the rotation key should start out trusted")

            // The operator revokes it; the next manifest carries a higher issuedAt.
            server = StubServer()
            await routeTrust(vendor.sign(second))
            await routeLicense(rotated.sign(Fixtures.license(issuedAt: t + 1)))
            let after = await c.sync()
            XCTAssertFalse(
                after.applied,
                "\(label): a document signed by the pruned key must no longer verify")
        }
    }

    /// §1 — a pinned key is never pruned, whatever the manifest says. Pinning is the escape hatch
    /// for a total control-plane compromise.
    func testPinnedKeySurvivesAManifestThatOmitsIt() async throws {
        let t = nowSec()
        await routeTrust(
            vendor.sign(
                Fixtures.manifest(
                    issuedAt: t,
                    keys: [
                        Fixtures.manifestKey(
                            kid: rotated.kid, publicKey: rotated.publicKeyB64)
                    ])))
        await routeLicense(vendor.sign(Fixtures.license(issuedAt: t)))
        let c = try await client()
        let synced = await c.sync()
        XCTAssertTrue(synced.applied)
    }

    /// A license document replayed where the trust manifest is expected is refused on `typ` — not
    /// by accident, on a swallowed decode error (R2-10).
    func testLicenseDocIsNotAcceptedAsATrustManifest() async throws {
        let t = nowSec()
        await routeTrust(vendor.sign(Fixtures.license(issuedAt: t)))
        await routeLicense(rotated.sign(Fixtures.license(issuedAt: t)))
        let c = try await client()
        let synced = await c.sync()
        XCTAssertFalse(synced.applied)
    }

    /// A cached manifest expires in `cacheSeconds` — minutes — so its freshness must NOT be
    /// re-checked on load, or every restart would silently drop the discovered keys and stop
    /// verifying documents signed by a rotated key while offline. It is still verified against
    /// the pins, and still refused on the NETWORK path once expired.
    func testStaleCachedManifestStillYieldsItsKeysOnLoad() async throws {
        let t = nowSec()
        let expired = vendor.sign(
            Fixtures.manifest(
                issuedAt: t - 3600, expiresAt: t - 3300,
                keys: [Fixtures.manifestKey(kid: rotated.kid, publicKey: rotated.publicKeyB64)]))
        let c = try await client(
            CacheRecord(
                trustJws: expired, docs: [.license: rotated.sign(Fixtures.license(issuedAt: t))]),
            trustRefresh: false)
        let status = await c.status().status
        XCTAssertEqual(status, .ok, "a stale cached manifest must still supply its keys")

        // On the network path the same manifest is refused as expired.
        let fresh = verifyTrustManifest(
            expired,
            options: VerifyTrustManifestOptions(
                pinned: [pinnedKid: vendor.publicKeyB64], expectedAud: "djdl", now: t))
        XCTAssertNil(fresh.doc)
    }

    // ── §4.1 cache integrity ──────────────────────────────────────────────────────
    /// Only signed artifacts are persisted. The fields every previous attack rewrote — the
    /// decoded doc, `trustedKeys`, `lastAcceptedIssuedAt`, `lastTrustIssuedAt`, `lastVerifiedAt` —
    /// no longer exist on disk, and the v3 record's per-service slices are JSON OBJECTS rather
    /// than the flat arrays a Swift enum-keyed dictionary would otherwise encode to.
    func testCachePersistsSignedArtifactsOnly() async throws {
        let t = nowSec()
        await routeTrust(
            vendor.sign(
                Fixtures.manifest(
                    issuedAt: t,
                    keys: [
                        Fixtures.manifestKey(kid: pinnedKid, publicKey: vendor.publicKeyB64)
                    ])))
        await routeLicense(vendor.sign(Fixtures.license(issuedAt: t)))
        await routeConfig(vendor.sign(Fixtures.config(issuedAt: t)))
        let store = await seededStore(CacheRecord())
        let c = try await PolarisKeyClient.create(
            options: options(store: store, services: [.license, .config]))
        _ = await c.sync()

        guard let record = await store.readCache() else { return XCTFail("no cache written") }
        XCTAssertEqual(record.v, CACHE_RECORD_VERSION)
        XCTAssertNotNil(record.docs[.license])
        XCTAssertNotNil(record.docs[.config])
        XCTAssertNotNil(record.trustJws)

        let json = String(decoding: try JSONEncoder().encode(record), as: UTF8.self)
        for banned in [
            "\"doc\"", "trustedKeys", "lastAcceptedIssuedAt", "lastTrustIssuedAt",
            "lastVerifiedAt", "entitlements",
        ] {
            XCTAssertFalse(json.contains(banned), "\(banned) must not be persisted")
        }
        // §4.1's slice shape, byte-for-byte with the other SDKs.
        XCTAssertTrue(json.contains("\"docs\":{"), "docs must serialise as an object")
        XCTAssertTrue(json.contains("\"license\":"), "…keyed by the service slug")
        XCTAssertTrue(json.contains("\"etags\":{"))

        // …and it round-trips: a record written by this build must load in this build.
        let decoded = try JSONDecoder().decode(
            CacheRecord.self, from: try JSONEncoder().encode(record))
        XCTAssertEqual(decoded, record)
    }

    /// A cached document is re-verified on load, so a hand-written one is worthless — including
    /// one lifted from ANOTHER DEVICE, which the old reload path never re-checked.
    func testCachedDocIsReVerifiedOnLoad() async throws {
        let t = nowSec()
        for (label, jws) in [
            ("untrusted signer", TestSigner(kid: pinnedKid).sign(Fixtures.license(issuedAt: t))),
            (
                "another device",
                vendor.sign(Fixtures.license(deviceId: "somebody-else", issuedAt: t))
            ),
            ("another product", vendor.sign(Fixtures.license(aud: "other", issuedAt: t))),
            ("a foreign issuer", vendor.sign(Fixtures.license(iss: "plrs.im", issuedAt: t))),
            (
                "a trust manifest replayed as a license doc",
                vendor.sign(Fixtures.manifest(issuedAt: t, keys: []))
            ),
            ("a config doc replayed as a license doc", vendor.sign(Fixtures.config(issuedAt: t))),
            ("not a JWS at all", "not-a-jws"),
        ] {
            let c = try await client(CacheRecord(docs: [.license: jws]), trustRefresh: false)
            let status = await c.status().status
            XCTAssertEqual(status, .needsActivation, "\(label) must not load")
        }

        // A doc dated absurdly far in the FUTURE cannot load and drag the monotonic floor with
        // it — that would pin the gate at `ok` indefinitely.
        let future = try await client(
            CacheRecord(
                docs: [
                    .license: vendor.sign(
                        Fixtures.license(
                            issuedAt: Int.max - MAX_GRACE_SECONDS, expiresAt: Int.max - 1,
                            graceUntil: Int.max))
                ]), trustRefresh: false)
        let futureStatus = await future.status().status
        let futureFloor = await future.core.highWaterMark
        XCTAssertEqual(futureStatus, .needsActivation)
        XCTAssertEqual(futureFloor, 0)

        // A doc past its whole signed grace window DOES load — every claim but freshness still
        // holds — and the gate is what refuses it. Either way it is not usable.
        let stale = try await client(
            CacheRecord(
                docs: [
                    .license: vendor.sign(
                        Fixtures.license(issuedAt: t - 400 * SECONDS_PER_DAY))
                ]), trustRefresh: false)
        let staleStatus = await stale.status().status
        let licensed = await stale.isLicensed()
        XCTAssertEqual(staleStatus, .expired)
        XCTAssertFalse(licensed)
    }

    /// §4.1 — a record from ANOTHER cache version is discarded rather than migrated, and `v` is
    /// checked before any field is read. The v2 record below is well-formed for its own version
    /// and carries a perfectly good signed document; it is dropped anyway.
    func testForeignCacheVersionIsDiscarded() async throws {
        let t = nowSec()
        let store = InMemoryStore(deviceId: "dev")
        await store.setToken("pkeyt_test")
        var v2 = CacheRecord(docs: [.license: vendor.sign(Fixtures.license(issuedAt: t))])
        v2.v = 2
        await store.writeCache(v2)

        let c = try await PolarisKeyClient.create(
            options: options(store: store, trustRefresh: false))
        let status = await c.status().status
        XCTAssertEqual(status, .needsActivation, "a v2 record must not be migrated")
        let floor = await c.core.highWaterMark
        XCTAssertEqual(floor, 0, "…nor may it seed the clock floor")
    }

    /// The anti-replay floor is DERIVED from the re-verified document, so the replay window
    /// cannot be re-opened by editing a file: an older document is still refused.
    func testAntiReplayFloorIsDerivedFromTheCachedDoc() async throws {
        let t = nowSec()
        let c = try await client(
            CacheRecord(docs: [.license: vendor.sign(Fixtures.license(issuedAt: t))]),
            trustRefresh: false)
        await routeLicense(vendor.sign(Fixtures.license(issuedAt: t - 1)))
        let replayed = await c.sync()
        XCTAssertFalse(replayed.applied, "an older document must not be applied")

        await routeLicense(vendor.sign(Fixtures.license(issuedAt: t + 1)), etag: "v2")
        let synced = await c.sync()
        XCTAssertTrue(synced.applied)
    }

    /// §3 — the floors are PER TYPE. A config document older than the licence's floor is still
    /// accepted, because they are independent services with independent issuance cadences.
    func testAntiReplayFloorsAreIndependentPerDocumentType() async throws {
        let t = nowSec()
        let c = try await client(
            CacheRecord(docs: [.license: vendor.sign(Fixtures.license(issuedAt: t))]),
            trustRefresh: false, services: [.license, .config])
        await routeLicense(vendor.sign(Fixtures.license(issuedAt: t + 1)), etag: "v2")
        // The config document is dated BELOW the licence's floor — and lands anyway.
        await routeConfig(vendor.sign(Fixtures.config(issuedAt: t - 500)))
        let result = await c.sync()
        XCTAssertEqual(result.documents[.config], .applied, "config floor is its own")
        XCTAssertEqual(result.documents[.license], .applied)
    }

    // ── §4.2 the monotonic clock floor ────────────────────────────────────────────
    /// The floor is recomputed at load from the signed document, never read from disk, so a clock
    /// rollback cannot widen any window.
    func testMonotonicFloorIsDerivedFromTheSignedDocument() async throws {
        let t = nowSec()
        let c = try await client(
            CacheRecord(docs: [.license: vendor.sign(Fixtures.license(issuedAt: t))]),
            trustRefresh: false)
        let floor = await c.core.highWaterMark
        XCTAssertEqual(floor, t)
        // A rolled-back clock is floored at the greatest verified `issuedAt`.
        let rolledBack = await c.status(now: t - 365 * SECONDS_PER_DAY)
        XCTAssertEqual(rolledBack.status, .ok)
    }

    /// §4.2 AS CORRECTED — the floor needs a SECOND source or it is inert. SACRED.
    ///
    /// Derived from documents alone, `highWaterMark == doc.issuedAt`, which is below that same
    /// document's `graceUntil` by construction — so the floor can never reach the end of grace and
    /// winding the clock back still extends offline operation indefinitely (the residual half of
    /// R4-04). v3 gives the client a SECOND document and changes nothing, because both are stamped
    /// by the same fetch. The trust manifest is signed, cached separately, and refreshed on Core's
    /// own cadence, so it advances even while the documents do not.
    func testTrustManifestAnchorsTheClockFloorIndependently() async throws {
        let t = nowSec()
        let issued = t - 400 * SECONDS_PER_DAY  // grace ended 370 days ago
        let rolledBack = issued + 60  // back inside the document's own window
        let doc = vendor.sign(Fixtures.license(issuedAt: issued))
        // A manifest verified YESTERDAY, long past its own `expiresAt` — exactly what a cached
        // manifest looks like. It must still load (freshness is a network-path rule) AND still
        // anchor time.
        let cachedManifest = vendor.sign(
            Fixtures.manifest(
                issuedAt: t - SECONDS_PER_DAY, expiresAt: t - SECONDS_PER_DAY + 300,
                keys: [Fixtures.manifestKey(kid: pinnedKid, publicKey: vendor.publicKeyB64)]))

        // (a) Documents only: the rollback still works. This is the defect, pinned.
        let docOnly = try await client(CacheRecord(docs: [.license: doc]), trustRefresh: false)
        let docOnlyFloor = await docOnly.core.highWaterMark
        XCTAssertEqual(docOnlyFloor, issued)
        let docOnlyStatus = await docOnly.status(now: rolledBack).status
        XCTAssertEqual(docOnlyStatus, .ok)

        // (a′) …and a SECOND document stamped by the same fetch changes nothing. This is the
        // v3-specific restatement: adding config to the fold does not rescue an inert floor.
        let bothDocs = try await client(
            CacheRecord(
                docs: [
                    .license: doc, .config: vendor.sign(Fixtures.config(issuedAt: issued + 1)),
                ]), trustRefresh: false, services: [.license, .config])
        let bothDocsFloor = await bothDocs.core.highWaterMark
        XCTAssertEqual(bothDocsFloor, issued + 1)
        let bothDocsStatus = await bothDocs.status(now: rolledBack).status
        XCTAssertEqual(bothDocsStatus, .ok)

        // (b) With the cached manifest the floor clears `graceUntil`, so the gate refuses.
        let anchored = try await client(
            CacheRecord(trustJws: cachedManifest, docs: [.license: doc]), trustRefresh: false)
        let anchoredFloor = await anchored.core.highWaterMark
        XCTAssertEqual(anchoredFloor, t - SECONDS_PER_DAY)
        let anchoredStatus = await anchored.status(now: rolledBack).status
        XCTAssertEqual(anchoredStatus, .expired, "a rolled-back clock must not re-open grace")
        let anchoredLicensed = await anchored.isLicensed(now: rolledBack)
        XCTAssertFalse(anchoredLicensed)

        // (c) The network path raises it too, even with the document route unreachable — which is
        // the point of refreshing trust on CORE's cadence rather than a service's.
        server = StubServer()
        await routeTrust(
            vendor.sign(
                Fixtures.manifest(
                    issuedAt: t,
                    keys: [
                        Fixtures.manifestKey(kid: pinnedKid, publicKey: vendor.publicKeyB64)
                    ])))
        await server.reply(licensePath, status: 503, body: "")
        let online = try await client(CacheRecord(docs: [.license: doc]))
        let beforeRefresh = await online.status(now: rolledBack).status
        XCTAssertEqual(beforeRefresh, .ok)
        _ = await online.sync()
        let onlineFloor = await online.core.highWaterMark
        XCTAssertEqual(onlineFloor, t)
        let afterRefresh = await online.status(now: rolledBack).status
        XCTAssertEqual(afterRefresh, .expired)
    }

    /// §4.2 — the mark is the MAX over ALL THREE artifact kinds. An implementation that folded
    /// licence-plus-manifest but forgot v3 has TWO documents would read the manifest's date here
    /// and land inside the licence's grace.
    func testFloorIsTheMaxOverThreeArtifactKinds() async throws {
        let t = nowSec()
        let licenseJws = vendor.sign(Fixtures.license(issuedAt: t - 400 * SECONDS_PER_DAY))
        let manifestJws = vendor.sign(
            Fixtures.manifest(
                issuedAt: t - 390 * SECONDS_PER_DAY, expiresAt: t - 390 * SECONDS_PER_DAY + 300,
                keys: [Fixtures.manifestKey(kid: pinnedKid, publicKey: vendor.publicKeyB64)]))
        // The CONFIG document is the newest artifact, and the only one past the licence's grace.
        let configJws = vendor.sign(Fixtures.config(issuedAt: t))

        let c = try await client(
            CacheRecord(
                trustJws: manifestJws, docs: [.license: licenseJws, .config: configJws]),
            trustRefresh: false, services: [.license, .config])
        let threeArtifactFloor = await c.core.highWaterMark
        XCTAssertEqual(threeArtifactFloor, t, "the max must include the config document")
        let insideLicenceWindow = await c.status(now: t - 400 * SECONDS_PER_DAY + 60).status
        XCTAssertEqual(
            insideLicenceWindow, .expired,
            "a floor that ignored the config document would read `grace` here")
    }

    // ── §5 a 304 renews freshness (R2-11) ─────────────────────────────────────────
    /// A continuously ONLINE client must never drift into `grace` because its content ETag is
    /// stable. Once the cached document is inside the refresh margin, a 304 is escalated to an
    /// unconditional fetch that returns a freshly signed document.
    func test304NearExpiryEscalatesToAnUnconditionalFetch() async throws {
        let t = nowSec()
        // Cached doc is 1900s old ⇒ inside the 1800s refresh margin.
        let c = try await client(
            CacheRecord(
                docs: [.license: vendor.sign(Fixtures.license(issuedAt: t - 1900))],
                etags: [.license: "v1"]), trustRefresh: false)

        let fresh = vendor.sign(Fixtures.license(issuedAt: t))
        await server.route(licensePath) { req in
            req.headers["if-none-match"] != nil
                ? StubServer.Reply(status: 304, body: "", headers: ["ETag": "v1"])
                : StubServer.Reply(status: 200, body: fresh, headers: ["ETag": "v1"])
        }

        let result = await c.sync()
        XCTAssertTrue(result.applied, "a 304 near expiry must be escalated, not accepted")
        let escalatedStatus = await c.status().status
        XCTAssertEqual(escalatedStatus, .ok)
        let unconditional = await server.requests(forPath: licensePath)
            .filter { $0.headers["if-none-match"] == nil }
        XCTAssertEqual(unconditional.count, 1)
    }

    /// …and while the document is comfortably fresh, a 304 stays a 304: no extra round trip.
    func test304OnAFreshDocumentDoesNotRefetch() async throws {
        let t = nowSec()
        let c = try await client(
            CacheRecord(
                docs: [.license: vendor.sign(Fixtures.license(issuedAt: t))],
                etags: [.license: "v1"]), trustRefresh: false)
        await server.route(licensePath) { _ in
            StubServer.Reply(status: 304, body: "", headers: ["ETag": "v1"])
        }
        let result = await c.sync()
        XCTAssertFalse(result.applied)
        XCTAssertEqual(result.documents[.license], .unchanged)
        let freshFetches = await server.requests(forPath: licensePath).count
        XCTAssertEqual(freshFetches, 1)
    }

    /// `sync(force:)` drops the conditional request outright — without it, activation could 304
    /// against a stale ETag and never install the very first document.
    func testForcedSyncSendsNoConditionalHeader() async throws {
        let t = nowSec()
        let c = try await client(
            CacheRecord(
                docs: [.license: vendor.sign(Fixtures.license(issuedAt: t))],
                etags: [.license: "v1"]), trustRefresh: false)
        await routeLicense(vendor.sign(Fixtures.license(issuedAt: t + 1)), etag: "v2")

        _ = await c.sync()
        var last = await server.requests(forPath: licensePath).last
        XCTAssertEqual(last?.headers["if-none-match"], "v1")

        _ = await c.sync(force: true)
        last = await server.requests(forPath: licensePath).last
        XCTAssertNil(last?.headers["if-none-match"])
    }

    /// §5 — exactly ONE re-acquire per pass, then one retry, then the hard 401 is recorded. A
    /// retry loop would keep postponing the offline revocation signal (§4.3) forever.
    func testSingle401ReacquireThenRecordedRevocation() async throws {
        let c = try await client(trustRefresh: false)
        await server.reply(licensePath, status: 401, body: "")
        await server.reply("/djdl/license/token", status: 200, body: #"{"token":"pkeyt_new","schemaVersion":1}"#)

        let result = await c.sync()
        XCTAssertTrue(result.unauthorized)
        let revokedStatus = await c.status().status
        XCTAssertEqual(revokedStatus, .revoked)
        let reacquires = await server.requests(forPath: "/djdl/license/token").count
        let fetches = await server.requests(forPath: licensePath).count
        XCTAssertEqual(reacquires, 1, "exactly one re-acquire attempt per pass")
        XCTAssertEqual(fetches, 2, "the original fetch plus exactly one retry")
    }

    /// §5 under v3's PARALLEL fetches: both documents 401 at the same instant, ONE re-acquire is
    /// made, and BOTH retry with the new credential.
    ///
    /// The failure mode this pins is subtle. A bare "already attempted" flag would let the second
    /// document report a hard 401 after a re-acquire that had just succeeded — recording
    /// `lastSyncUnauthorized` and gating `revoked` on a routine token rotation, with the licence
    /// sitting perfectly valid in the cache.
    func testConcurrent401sShareOneReacquireAndBothRetry() async throws {
        let t = nowSec()
        let license = vendor.sign(Fixtures.license(issuedAt: t))
        let config = vendor.sign(Fixtures.config(issuedAt: t))
        // Both documents refuse the OLD credential and accept the rotated one.
        await server.route(licensePath) { req in
            req.headers["authorization"] == "Bearer pkeyt_rotated"
                ? StubServer.Reply(status: 200, body: license, headers: ["ETag": "v1"])
                : StubServer.Reply(status: 401, body: "")
        }
        await server.route(configPath) { req in
            req.headers["authorization"] == "Bearer pkeyt_rotated"
                ? StubServer.Reply(status: 200, body: config, headers: ["ETag": "c1"])
                : StubServer.Reply(status: 401, body: "")
        }
        await server.reply(
            "/djdl/license/token", body: #"{"token":"pkeyt_rotated","schemaVersion":1}"#)

        let c = try await client(trustRefresh: false, services: [.license, .config])
        let result = await c.sync()

        let reacquires = await server.requests(forPath: "/djdl/license/token").count
        XCTAssertEqual(reacquires, 1, "one shared re-acquire, not one per document")
        XCTAssertEqual(result.documents[.license], .applied)
        XCTAssertEqual(result.documents[.config], .applied)
        XCTAssertFalse(result.unauthorized, "a successful rotation is not a revocation")
        let status = await c.status().status
        XCTAssertEqual(status, .ok)
    }

    /// §6 — telemetry rides on `POST /devices/report` (v2's `/config/report` is gone) and carries
    /// the software facts alongside the snapshot, on the SAME call.
    func testTelemetryPostsToDevicesReportWithFacts() async throws {
        let t = nowSec()
        await routeLicense(vendor.sign(Fixtures.license(issuedAt: t)))
        await routeConfig(vendor.sign(Fixtures.config(issuedAt: t)))
        let c = try await PolarisKeyClient.create(
            options: options(
                store: await seededStore(CacheRecord()), trustRefresh: false,
                services: [.license, .config]))
        _ = await c.sync()

        guard let request = await server.requests(forPath: reportPath).last,
            let body = request.body
        else { return XCTFail("no report body captured") }
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.headers["authorization"], "Bearer pkeyt_test")
        let json = try JSONSerialization.jsonObject(with: body) as? [String: Any]
        XCTAssertNotNil(json?["os"], "software facts must ride on the report call")
        XCTAssertNotNil(json?["hardware"])
        XCTAssertNotNil(json?["runtime"])
        XCTAssertNotNil(json?["config"])
        XCTAssertNotNil(json?["entitlements"])
        let legacyReports = await server.requests(forPath: "/djdl/config/report")
        XCTAssertTrue(legacyReports.isEmpty, "the v2 report path must never be called")
    }

    /// Every product-scoped request carries the seven `X-PKey-*` metadata headers (§5), from
    /// one place, so a new endpoint cannot ship without them (R4-08).
    func testEveryRequestCarriesTheClientMetadataHeaders() async throws {
        let t = nowSec()
        await routeTrust(
            vendor.sign(
                Fixtures.manifest(
                    issuedAt: t,
                    keys: [
                        Fixtures.manifestKey(kid: pinnedKid, publicKey: vendor.publicKeyB64)
                    ])))
        await routeLicense(vendor.sign(Fixtures.license(issuedAt: t)))
        let c = try await client()
        _ = await c.sync()

        let requests = await server.requests
        XCTAssertFalse(requests.isEmpty)
        for request in requests {
            for header in [
                HEADER_DEVICE, HEADER_VERSION, HEADER_CHANNEL, HEADER_PLATFORM, HEADER_ARCH,
                HEADER_SDK_NAME, HEADER_SDK_VERSION,
            ] {
                XCTAssertNotNil(
                    request.headers[header], "\(request.url.path) is missing \(header)")
            }
            XCTAssertEqual(request.headers[HEADER_DEVICE], "dev")
            XCTAssertEqual(request.headers[HEADER_VERSION], "1.0.0")
            XCTAssertGreaterThan(request.timeoutSeconds, 0, "every request carries a deadline")
        }
    }

    /// Deactivation wipes the credential and every artifact, and resets the floor with them — a
    /// floor without its sources is a bare counter.
    func testDeactivateWipesEverythingIncludingTheFloor() async throws {
        let t = nowSec()
        let store = await seededStore(
            CacheRecord(docs: [.license: vendor.sign(Fixtures.license(issuedAt: t))]))
        let c = try await PolarisKeyClient.create(
            options: options(store: store, trustRefresh: false))
        let floorBefore = await c.core.highWaterMark
        XCTAssertEqual(floorBefore, t)

        try await c.deactivate()
        let statusAfter = await c.status().status
        XCTAssertEqual(statusAfter, .needsActivation)
        let floorAfter = await c.core.highWaterMark
        XCTAssertEqual(floorAfter, 0)
        let token = await store.getToken()
        XCTAssertNil(token)
        let cache = await store.readCache()
        XCTAssertNil(cache)
    }
}
