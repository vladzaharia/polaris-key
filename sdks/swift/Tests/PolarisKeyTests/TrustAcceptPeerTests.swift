// @pkey-feature connect.protocol
// CC-11.5: `CoreContext.acceptPeer` (WIRE-CONTRACT-V5 §15.8). A trust manifest a peer pushed is
// verified against the usable pins and tombstones only, bound to the product, newer than the held
// one, raises the clock floor and answers the refusal reason. Mirrors Node's `acceptPeer`.

import Foundation
import PolarisKey
import PolarisKeyCore
import XCTest

final class TrustAcceptPeerTests: XCTestCase {
    private let a = TestSigner(kid: "pkey-a-2026")
    private let b = TestSigner(kid: "pkey-b-2027")
    private let stranger = TestSigner(kid: "pkey-stranger")
    private let now = Int(Date().timeIntervalSince1970)

    private func core() async throws -> CoreContext {
        let c = try CoreContext(
            options: CoreOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [a.kid: a.publicKeyB64, b.kid: b.publicKeyB64],
                store: InMemoryStore(deviceId: "dev"), transport: StubServer().transport))
        try await c.start()
        return c
    }

    private func manifest(
        _ signer: TestSigner, issuedAt: Int, aud: String = "djdl", keys: [(TestSigner, String)]? = nil
    ) -> String {
        signer.sign(
            Fixtures.manifest(
                aud: aud, issuedAt: issuedAt,
                keys: (keys ?? [(a, "active")]).map {
                    Fixtures.manifestKey(kid: $0.0.kid, publicKey: $0.0.publicKeyB64, status: $0.1)
                }))
    }

    func testANewerManifestSignedByAUsablePinIsAppliedAndRaisesTheFloor() async throws {
        let c = try await core()
        let r = await c.acceptPeer(manifest(a, issuedAt: now))
        XCTAssertEqual(r, PeerTrustResult(applied: true, reason: nil))
        let held = await c.trustManifest?.issuedAt
        XCTAssertEqual(held, now)
        let floor = await c.highWaterMark
        XCTAssertEqual(floor, now)
    }

    func testItMustBeNewerThanTheHeldOne() async throws {
        let c = try await core()
        let first = await c.acceptPeer(manifest(a, issuedAt: now - 10))
        XCTAssertTrue(first.applied)
        for issued in [now - 10, now - 15] {
            let r = await c.acceptPeer(manifest(a, issuedAt: issued))
            XCTAssertEqual(r, PeerTrustResult(applied: false, reason: "not_newer"))
        }
        let held = await c.trustManifest?.issuedAt
        XCTAssertEqual(held, now - 10)
        let next = await c.acceptPeer(manifest(a, issuedAt: now - 9))
        XCTAssertTrue(next.applied)
    }

    func testAManifestThatDoesNotVerifyIsInvalidAndChangesNothing() async throws {
        let c = try await core()
        let ok = await c.acceptPeer(manifest(a, issuedAt: now - 10))
        XCTAssertTrue(ok.applied)
        let before = await c.trust
        let bad = [
            "not.a.jws", "",
            manifest(stranger, issuedAt: now),  // signed by a key that is not pinned
            manifest(a, issuedAt: now, aud: "other-product"),  // bound to another product
            manifest(a, issuedAt: now + 4 * 86_400),  // not yet valid
        ]
        for jws in bad {
            let r = await c.acceptPeer(jws)
            XCTAssertEqual(r, PeerTrustResult(applied: false, reason: "invalid"))
        }
        let after = await c.trust
        let held = await c.trustManifest?.issuedAt
        XCTAssertEqual(held, now - 10)
        XCTAssertEqual(after, before)
    }

    func testARevokedPinNoLongerSignsAPushedManifest() async throws {
        let c = try await core()
        let revoke = manifest(b, issuedAt: now - 10, keys: [(a, "revoked"), (b, "active")])
        let r = await c.acceptPeer(revoke)
        XCTAssertTrue(r.applied)
        let revoked = await c.revokedPins
        XCTAssertEqual(revoked, [a.kid])
        let trust = await c.trust
        XCTAssertNil(trust[a.kid])
        // The tombstoned pin's signature is no longer enough.
        let again = await c.acceptPeer(manifest(a, issuedAt: now))
        XCTAssertEqual(again, PeerTrustResult(applied: false, reason: "invalid"))
    }

    func testTheDiscoveredTierIsReplacedNotMerged() async throws {
        let c = try await core()
        let extra = TestSigner(kid: "extra-2026")
        let withExtra = await c.acceptPeer(manifest(a, issuedAt: now - 10, keys: [(a, "active"), (extra, "active")]))
        XCTAssertTrue(withExtra.applied)
        var trust = await c.trust
        XCTAssertNotNil(trust[extra.kid])
        let without = await c.acceptPeer(manifest(a, issuedAt: now - 9))
        XCTAssertTrue(without.applied)
        trust = await c.trust
        XCTAssertNil(trust[extra.kid])
    }

    func testConcurrentPushesApplyAtMostOncePerIssuedAt() async throws {
        let c = try await core()
        let jws = manifest(a, issuedAt: now - 1)
        let applied = await withTaskGroup(of: Bool.self) { group -> Int in
            for _ in 0..<8 { group.addTask { await c.acceptPeer(jws).applied } }
            var n = 0
            for await ok in group where ok { n += 1 }
            return n
        }
        XCTAssertEqual(applied, 1)
    }

    func testAPushDuringARefreshDoesNotInterleaveWithIt() async throws {
        // The refresh suspends on its fetch; the push runs in between and the refresh's older
        // manifest is then refused as a replay, not installed over the newer one.
        let server = StubServer()
        let c = try CoreContext(
            options: CoreOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [a.kid: a.publicKeyB64], store: InMemoryStore(deviceId: "dev"),
                transport: server.transport))
        try await c.start()
        await server.reply("/djdl/.well-known/polaris-trust.jws", body: manifest(a, issuedAt: now - 20))
        async let refreshed = c.refreshTrust()
        let pushed = await c.acceptPeer(manifest(a, issuedAt: now - 5))
        _ = await refreshed
        let held = await c.trustManifest?.issuedAt
        XCTAssertTrue(pushed.applied)
        XCTAssertEqual(held, now - 5, "the newer manifest stays")
    }

    func testTheResultNamesNoKeyMaterial() async throws {
        let c = try await core()
        let r = await c.acceptPeer(manifest(a, issuedAt: now))
        let text = "\(r)"
        XCTAssertFalse(text.contains(a.publicKeyB64))
        XCTAssertFalse(text.contains("djdl"))
    }
}
