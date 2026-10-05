// @pkey-feature core.sync license.entitlements
// LX-17 (S-19 §7.5, §10.1 risk 1, decision 10): does the Swift SDK tolerate a `licenseId` that
// changes on a PLAIN REFRESH — no activation call, the same device token — the way
// `licensing.reanchor: onRefresh` would deliver it?
//
// "Tolerate" is pinned on the three surfaces the audit names:
//   cache       the new document is applied, the accessors read it, and it is what a fresh
//               client restores from the same store while offline;
//   telemetry   the `/devices/report` after the refresh carries the NEW licence's grants, and
//               the current device reports the new `licenseId`;
//   activation  the device stays activated on the SAME token, with no re-activation and no wipe.
//
// Audit result for Swift: PASS.

import Foundation
import PolarisKey
import PolarisKeyConfig
import PolarisKeyCore
import PolarisKeyLicense
import XCTest

final class LicenseIdRefreshTests: XCTestCase {
    private let kid = "pkey-lx17-2026"
    private let licensePath = "/djdl/license/document"
    private let activatePath = "/djdl/license/activate"
    private let reportPath = "/djdl/devices/report"

    private func entitlements(_ tier: String) -> [String: ManagedEntry] {
        var out: [String: ManagedEntry] = ["license.tier": Fixtures.entry(.string(tier), .enforced)]
        if tier == "pro" { out["pro"] = Fixtures.entry(.bool(true), .enforced) }
        return out
    }

    private func routeLicense(
        _ server: StubServer, _ signer: TestSigner, licenseId: String, tier: String,
        issuedAt: Int, etag: String
    ) async {
        let jws = signer.sign(
            Fixtures.license(
                licenseId: licenseId, issuedAt: issuedAt, entitlements: entitlements(tier)))
        await server.route(licensePath) { req in
            if req.headers["if-none-match"] == etag {
                return StubServer.Reply(status: 304, body: "", headers: ["ETag": etag])
            }
            return StubServer.Reply(status: 200, body: jws, headers: ["ETag": etag])
        }
    }

    func testALicenseIdChangeOnAPlainRefreshIsTolerated() async throws {
        let signer = TestSigner(kid: kid)
        let server = StubServer()
        let store = InMemoryStore(deviceId: "dev")
        let t = Int(Date().timeIntervalSince1970)
        let options = PolarisKeyClientOptions(
            productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
            pinnedKeys: [kid: signer.publicKeyB64], trustRefresh: false, store: store,
            transport: server.transport, expectedServices: [.license], fingerprint: false)

        await server.reply(activatePath, body: #"{"token":"pkeyt_lx17","schemaVersion":4}"#)
        await server.reply(reportPath, body: "{}")
        await routeLicense(
            server, signer, licenseId: "lic_trial", tier: "free", issuedAt: t, etag: "lic-1")

        let c = try await PolarisKeyClient.create(options: options)
        let activated = await c.activate(key: "pkey_djdl_test")
        XCTAssertEqual(activated, .ok(token: "pkeyt_lx17", schemaVersion: 4))
        let before = await c.license.licenseId()
        XCTAssertEqual(before, "lic_trial")
        let proBefore = await c.license.isEntitled("pro")
        XCTAssertFalse(proBefore)
        let activationsBefore = await server.requests(forPath: activatePath).count
        let reportsBefore = await server.requests(forPath: reportPath).count

        // The server re-anchors this device on another licence; the next plain sync receives it.
        await routeLicense(
            server, signer, licenseId: "lic_pro", tier: "pro", issuedAt: t + 60, etag: "lic-2")
        let result = await c.sync()

        // cache
        XCTAssertEqual(result.documents[.license], .applied)
        let after = await c.license.licenseId()
        XCTAssertEqual(after, "lic_pro")
        let proAfter = await c.license.isEntitled("pro")
        XCTAssertTrue(proAfter)
        let tier = await c.license.entitlements()["license.tier"]
        XCTAssertEqual(tier, .string("pro"))
        // activation state
        let activationsAfter = await server.requests(forPath: activatePath).count
        XCTAssertEqual(activationsAfter, activationsBefore, "no re-activation")
        let bearers = Set(
            await server.requests(forPath: licensePath).compactMap { $0.headers["authorization"] })
        XCTAssertEqual(bearers, ["Bearer pkeyt_lx17"])
        let activation = await c.license.activation()
        XCTAssertEqual(activation, .token)
        let status = await c.status().status
        XCTAssertEqual(status, .ok)
        // telemetry
        let reports = await server.requests(forPath: reportPath)
        XCTAssertEqual(reports.count, reportsBefore + 1)
        guard let body = reports.last?.body,
            let json = try JSONSerialization.jsonObject(with: body) as? [String: Any],
            let reported = json["entitlements"] as? [String: Any]
        else { return XCTFail("no report body captured") }
        XCTAssertEqual(reported["license.tier"] as? String, "pro")
        let device = await c.currentDevice()
        XCTAssertEqual(device.licenseId, "lic_pro")

        // The following refresh revalidates the new licence's document normally.
        let again = await c.sync()
        XCTAssertEqual(again.documents[.license], .unchanged)
        let still = await c.license.licenseId()
        XCTAssertEqual(still, "lic_pro")
        await c.close()

        // A fresh client on the same store, fully offline, restores the re-anchored document.
        let offline = try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [kid: signer.publicKeyB64], trustRefresh: false, store: store,
                transport: ExplodingTransport(), expectedServices: [.license],
                fingerprint: false))
        let restored = await offline.license.licenseId()
        XCTAssertEqual(restored, "lic_pro")
        let restoredPro = await offline.license.isEntitled("pro")
        XCTAssertTrue(restoredPro)
        let restoredStatus = await offline.status().status
        XCTAssertEqual(restoredStatus, .ok)
        await offline.close()
    }
}
