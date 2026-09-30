// @pkey-feature core.bundle
// Offline activation bundles — §7 step 5, the half the conformance corpus cannot pin.
//
// `ConformanceTests.testAllBundleCases` drives steps 1–4 through the shared vectors and asserts
// WHICH step refused. What is left, and what lives here, is the host's obligation: the write is
// ATOMIC and ALL-OR-NOTHING, no token is created, the imported install reaches exactly the state
// a restart would reach, and a bundle without a licence document grants nothing.

import Foundation
import PolarisKey
import PolarisKeyConfig
import PolarisKeyCore
import PolarisKeyLicense
import XCTest

final class BundleImportTests: XCTestCase {
    private let pinnedKid = "pkey-pinned-2026"
    private var vendor = TestSigner(kid: "pkey-pinned-2026")
    private var rotated = TestSigner(kid: "pkey-rotated-2027")

    override func setUp() {
        super.setUp()
        vendor = TestSigner(kid: pinnedKid)
        rotated = TestSigner(kid: "pkey-rotated-2027")
    }

    private func nowSec() -> Int { Int(Date().timeIntervalSince1970) }

    private func manifestJws(_ issuedAt: Int) -> String {
        vendor.sign(
            Fixtures.manifest(
                issuedAt: issuedAt,
                keys: [
                    Fixtures.manifestKey(kid: pinnedKid, publicKey: vendor.publicKeyB64),
                    Fixtures.manifestKey(kid: rotated.kid, publicKey: rotated.publicKeyB64),
                ]))
    }

    private func client(
        store: InMemoryStore, services: [ServiceSlug] = [.license, .config]
    ) async throws -> PolarisKeyClient {
        try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [pinnedKid: vendor.publicKeyB64], trustRefresh: false, store: store,
                // A bundle import is the air-gapped path: if it dials, the test fails.
                transport: NoNetworkTransport(), expectedServices: services,
                fingerprint: false))
    }

    /// The control: a bundle carrying both documents plus the manifest lands, gates `ok`, and
    /// creates NO credential.
    func testValidBundleImportsAndActivatesWithoutAToken() async throws {
        let t = nowSec()
        let store = InMemoryStore(deviceId: "dev")
        let c = try await client(store: store)

        let bundle = vendor.sign(
            Fixtures.bundle(
                issuedAt: t,
                license: vendor.sign(Fixtures.license(issuedAt: t)),
                // Signed by the ROTATED key, which only the inner manifest publishes: proves
                // step 4 runs against the set step 3 built.
                config: rotated.sign(Fixtures.config(issuedAt: t)),
                trust: manifestJws(t)))

        let imported = try await c.importBundle(bundle, now: t)
        XCTAssertEqual(imported.imported, [.license, .config])
        XCTAssertFalse(imported.bundleId.isEmpty)

        let status = await c.status()
        let activation = await c.license.activation()
        let token = await store.getToken()
        XCTAssertEqual(status.status, .ok)
        XCTAssertEqual(activation, .bundle)
        XCTAssertNil(token, "a bundle-activated install holds no credential")
    }

    /// §4.1/§7 step 5 — the write is REPLACE, not merge: importing a bundle is a
    /// re-provisioning, and a stale license slice surviving one would be a device running on a
    /// licence its operator deliberately replaced.
    func testImportReplacesTheWholeRecord() async throws {
        let t = nowSec()
        let store = InMemoryStore(deviceId: "dev")
        // A previous life: an old licence, an ETag, and a recorded 401.
        await store.writeCache(
            CacheRecord(
                docs: [.license: vendor.sign(Fixtures.license(issuedAt: t - 100))],
                etags: [.license: "stale"], lastSyncUnauthorized: true))
        let c = try await client(store: store)

        let bundle = vendor.sign(
            Fixtures.bundle(
                issuedAt: t, config: rotated.sign(Fixtures.config(issuedAt: t)),
                trust: manifestJws(t)))
        _ = try await c.importBundle(bundle, now: t)

        guard let record = await store.readCache() else { return XCTFail("no record") }
        XCTAssertNil(record.docs[.license], "the stale licence must not survive")
        XCTAssertNotNil(record.docs[.config])
        XCTAssertTrue(record.etags.isEmpty, "no ETags: these did not come from a conditional GET")
        XCTAssertNil(record.lastSyncUnauthorized, "the previous session's hints go with it")
        XCTAssertEqual(record.importedBundle?.importedAt, t)
    }

    /// §7 — a bundle with no licence document has NO activation effect. It imports settings and
    /// grants nothing, so a license-enabled product stays `needs-activation`.
    func testConfigOnlyBundleImportsSettingsAndGrantsNothing() async throws {
        let t = nowSec()
        let store = InMemoryStore(deviceId: "dev")
        let c = try await client(store: store)

        let bundle = vendor.sign(
            Fixtures.bundle(
                issuedAt: t,
                config: rotated.sign(
                    Fixtures.config(
                        issuedAt: t,
                        config: ["ui.theme": Fixtures.entry(.string("air-gapped"))])),
                trust: manifestJws(t)))
        let imported = try await c.importBundle(bundle, now: t)
        XCTAssertEqual(imported.imported, [.config])

        let status = await c.status()
        let activation = await c.license.activation()
        let theme = await c.config.config("ui.theme", default: .string("d"))
        XCTAssertEqual(status.status, .needsActivation)
        XCTAssertNil(activation, "activation: .bundle arises only from a verified licence doc")
        XCTAssertEqual(theme, .string("air-gapped"))
    }

    /// …and for a product that does not run License at all, the same bundle boots `notApplicable`
    /// (D-08) — the air-gapped config-only install.
    func testConfigOnlyBundleOnAConfigOnlyProductIsNotApplicable() async throws {
        let t = nowSec()
        let store = InMemoryStore(deviceId: "dev")
        let c = try await client(store: store, services: [.config])
        let bundle = vendor.sign(
            Fixtures.bundle(
                issuedAt: t, config: rotated.sign(Fixtures.config(issuedAt: t)),
                trust: manifestJws(t)))
        _ = try await c.importBundle(bundle, now: t)
        let status = await c.status()
        let usable = await c.isLicensed()
        XCTAssertEqual(status.status, .notApplicable)
        XCTAssertTrue(usable)
    }

    /// A refusal writes NOTHING — not even the documents that verified before the failing one.
    /// The error carries the §7 STEP, because that is the operator's remedy.
    func testARefusedBundleLeavesTheInstallUntouched() async throws {
        let t = nowSec()
        let store = InMemoryStore(deviceId: "dev")
        let previous = CacheRecord(
            docs: [.license: vendor.sign(Fixtures.license(issuedAt: t))])
        await store.writeCache(previous)
        // An online-activated install: the credential is what makes the previous licence GATE,
        // so a refusal that silently wiped either one would show up below.
        await store.setToken("pkeyt_existing")
        let c = try await client(store: store)

        // Addressed to another machine — refused at step 2, before the manifest or any inner
        // document is even looked at.
        let foreign = vendor.sign(
            Fixtures.bundle(
                deviceId: "another-machine", issuedAt: t,
                license: vendor.sign(Fixtures.license(deviceId: "another-machine", issuedAt: t)),
                trust: manifestJws(t)))
        do {
            _ = try await c.importBundle(foreign, now: t)
            XCTFail("a bundle minted for another device must be refused")
        } catch let error as PolarisError {
            XCTAssertEqual(error.code, BundleRefusalReason.bundleClaimsRejected.rawValue)
            XCTAssertFalse(error.message.isEmpty, "the operator needs a remedy, not a code")
        }

        let record = await store.readCache()
        XCTAssertEqual(record, previous, "nothing may have been written")
        let status = await c.status()
        XCTAssertEqual(status.status, .ok, "…and the previous licence still gates")
    }

    /// A bundle whose inner licence fails takes the untouched config document down with it.
    /// All-or-nothing is structural: a refusal hands back no documents at all.
    func testOneBadInnerDocumentRefusesTheWholeImport() async throws {
        let t = nowSec()
        let store = InMemoryStore(deviceId: "dev")
        let c = try await client(store: store)
        let untrusted = TestSigner(kid: "not-in-any-manifest")

        let bundle = vendor.sign(
            Fixtures.bundle(
                issuedAt: t,
                license: untrusted.sign(Fixtures.license(issuedAt: t)),
                config: rotated.sign(Fixtures.config(issuedAt: t)),
                trust: manifestJws(t)))
        do {
            _ = try await c.importBundle(bundle, now: t)
            XCTFail("an unverifiable inner document must refuse the import")
        } catch let error as PolarisError {
            XCTAssertEqual(error.code, BundleRefusalReason.innerDocRejected.rawValue)
        }
        let record = await store.readCache()
        XCTAssertNil(record, "the good config document must not have landed either")
    }

    /// A bundle carrying NEITHER document is vacuous: importing it would write a marker with no
    /// content behind it — an install that looks provisioned and is not.
    func testVacuousBundleIsRefusedAtTheClaimsStep() {
        let t = nowSec()
        let bundle = vendor.sign(Fixtures.bundle(issuedAt: t, trust: manifestJws(t)))
        let inspection = inspectBundle(
            bundle,
            options: BundleOptions(
                pinned: [pinnedKid: vendor.publicKeyB64], product: "djdl", deviceId: "dev",
                now: t))
        XCTAssertEqual(inspection, .refused(.bundleClaimsRejected))
    }

    /// The imported install reaches exactly the state a RESTART would reach — because the import
    /// re-runs the normal load path over what it just wrote rather than trusting its in-memory
    /// objects.
    func testImportedStateSurvivesAReload() async throws {
        let t = nowSec()
        let store = InMemoryStore(deviceId: "dev")
        let c = try await client(store: store)
        let bundle = vendor.sign(
            Fixtures.bundle(
                issuedAt: t, license: vendor.sign(Fixtures.license(issuedAt: t)),
                trust: manifestJws(t)))
        _ = try await c.importBundle(bundle, now: t)
        let imported = await c.status().status
        let importedFloor = await c.core.highWaterMark

        // A fresh client over the SAME store: the restart.
        let reloaded = try await client(store: store)
        let reloadedStatus = await reloaded.status().status
        let reloadedActivation = await reloaded.license.activation()
        XCTAssertEqual(reloadedStatus, imported)
        XCTAssertEqual(reloadedActivation, .bundle)
        let reloadedFloor = await reloaded.core.highWaterMark
        XCTAssertEqual(reloadedFloor, importedFloor)
    }

    /// §7 — an online activation SUPERSEDES a bundle. Once the device holds a `pkeyt_` token the
    /// bundle is history, whatever the import marker still says.
    func testATokenSupersedesABundle() async throws {
        let t = nowSec()
        let store = InMemoryStore(deviceId: "dev")
        let c = try await client(store: store)
        let bundle = vendor.sign(
            Fixtures.bundle(
                issuedAt: t, license: vendor.sign(Fixtures.license(issuedAt: t)),
                trust: manifestJws(t)))
        _ = try await c.importBundle(bundle, now: t)
        let beforeToken = await c.license.activation()
        XCTAssertEqual(beforeToken, .bundle)

        try await c.core.setToken("pkeyt_online")
        let afterToken = await c.license.activation()
        XCTAssertEqual(afterToken, .token)
    }

    /// The one-step air-gapped construction: local-only client + verified import, with the
    /// refusal surfacing rather than leaving a half-provisioned install.
    func testCreateFromBundle() async throws {
        let t = nowSec()
        let options = PolarisKeyClientOptions(
            productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
            pinnedKeys: [pinnedKid: vendor.publicKeyB64],
            store: InMemoryStore(deviceId: "dev"), fingerprint: false)
        let bundle = vendor.sign(
            Fixtures.bundle(
                issuedAt: t, license: vendor.sign(Fixtures.license(issuedAt: t)),
                trust: manifestJws(t)))
        let (client, imported) = try await PolarisKeyClient.createFromBundle(
            options: options, bundle: bundle, now: t)
        XCTAssertEqual(imported.imported, [.license])
        let bundledStatus = await client.status().status
        XCTAssertEqual(bundledStatus, .ok)
        XCTAssertTrue(client.core.localOnly)
    }
}
