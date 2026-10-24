// @pkey-feature ui.kit
//
// `PolarisKeyModel` and the `.polarisKey(client)` modifier (notes/SDK-PARITY-PASS.md §3.18). The
// model is driven against a stub Worker; the modifier is rendered off-screen with `ImageRenderer`
// (a render that traps or lays out to nothing fails). The gate's screens are covered by the
// PolarisKeyUICore and snapshot suites.

#if canImport(SwiftUI)
import Foundation
import PolarisKey
import PolarisKeyCore
import PolarisKeyIdentity
@testable import PolarisKeyUI
import PolarisKeyUICore
import SwiftUI
import XCTest

@MainActor
func renders<V: View>(_ view: V, width: CGFloat = 393, height: CGFloat = 852) -> Bool {
    let renderer = ImageRenderer(content: view.frame(width: width, height: height))
    renderer.scale = 1
    guard let image = renderer.cgImage else { return false }
    return image.width == Int(width) && image.height == Int(height)
}

@MainActor
final class KitModelTests: XCTestCase {
    private var server = StubServer()

    override func setUp() async throws {
        server = StubServer()
    }

    private func client(services: [ServiceSlug] = [.license, .identity]) async throws
        -> PolarisKeyClient
    {
        try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: [:], trustRefresh: false, store: InMemoryStore(deviceId: "dev"),
                transport: server.transport, expectedServices: services, fingerprint: false))
    }

    func testTheModelRendersActivationOutcomesByCode() async throws {
        await server.reply(
            "/djdl/license/activate", status: 403, body: #"{"error":"license_owned"}"#)
        let model = PolarisKeyModel(client: try await client())
        await model.reload()
        XCTAssertTrue(model.identityEnabled)
        XCTAssertEqual(model.state.status, .needsActivation)
        await model.activate(key: "PKEY-1")
        XCTAssertEqual(model.lastActivation?.code, "license_owned")
        XCTAssertEqual(model.lastError, ErrorCopy.message("license_owned"))
    }

    func testContinueFreeIsHiddenOnceEnrolmentIsDisabled() async throws {
        await server.reply(
            "/djdl/license/enroll", status: 404, body: #"{"error":"enroll_disabled"}"#)
        let model = PolarisKeyModel(client: try await client(), offersFreeTier: true)
        await model.enroll()
        XCTAssertFalse(model.offersFreeTier)
        XCTAssertEqual(model.lastActivation, .enrollDisabled)
    }

    /// A client holding a cached, signed licence and no token: activating it moves the gate to
    /// `ok`, so the client emits a `license` event the model has to follow. (A token alone, with
    /// no verifiable document, leaves the status at `needsActivation`; the client then emits
    /// nothing, and a model that showed the token would only be winning a race with its own
    /// first snapshot.)
    private func unactivatedLicensedClient() async throws -> PolarisKeyClient {
        let signer = TestSigner(kid: "kit-key")
        let t = Int(Date().timeIntervalSince1970)
        let store = InMemoryStore(deviceId: "dev")
        await store.writeCache(
            CacheRecord(docs: [
                .license: signer.sign(
                    Fixtures.license(
                        licenseId: "lic_kit", issuedAt: t,
                        entitlements: ["pro": Fixtures.entry(.bool(true), .enforced)]))
            ]))
        return try await PolarisKeyClient.create(
            options: PolarisKeyClientOptions(
                productSlug: "djdl", baseUrl: "https://key.example", version: "1.0.0",
                pinnedKeys: signer.trust, trustRefresh: false, store: store,
                transport: server.transport, expectedServices: [.license], fingerprint: false))
    }

    /// Yield to the model's observation task until `done` holds (or a second passes).
    private func settle(_ done: () -> Bool) async throws {
        for _ in 0..<50 where !done() {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    func testTheModelFollowsClientChanges() async throws {
        await server.reply(
            "/djdl/license/activate", body: #"{"token":"pkeyt_new","schemaVersion":1}"#)
        let c = try await unactivatedLicensedClient()
        let model = PolarisKeyModel(client: c)
        model.start()
        XCTAssertFalse(model.identityEnabled)
        _ = await c.license.activateWithKey("PKEY-1")
        try await settle { model.activation == .token && model.state.status == .ok }
        XCTAssertEqual(model.activation, .token)
        XCTAssertEqual(model.state.status, .ok)
        // Only the `license` event can carry this one back: the first snapshot is long done.
        try await c.deactivate()
        try await settle { model.activation == nil && model.state.status == .needsActivation }
        XCTAssertNil(model.activation)
        XCTAssertEqual(model.state.status, .needsActivation)
        model.stop()
    }

    func testQRCodeEncodes() {
        let image = PolarisQRCode.cgImage(for: "https://key.example/d?user_code=ABCD-EFGH")
        XCTAssertNotNil(image)
        XCTAssertGreaterThan(image?.width ?? 0, 20)
    }

    func testTheRequestCodeBreaksWithoutFalseHyphens() {
        let ids = [
            "dev-7Q2M-x9cL-r4Tb-V0aZ-3WPL-DA8k-N5eY", "dev_7Q2Mx9cLr4TbV0aZ3WPLDA8kN5eYZ", "ab",
        ]
        for id in ids {
            let shown = PolarisOfflineSurface.displayCode(id)
            let stripped = shown.replacingOccurrences(of: "\u{200B}", with: "")
                .replacingOccurrences(of: "\u{2060}", with: "")
            XCTAssertEqual(stripped, id, "the drawn code rejoins to the raw id")
            XCTAssertEqual(
                shown.filter { $0 == "-" }.count, id.filter { $0 == "-" }.count, "no hyphen is added")
            XCTAssertFalse(shown.contains("-\u{200B}"))
            for part in shown.components(separatedBy: "\u{200B}") where id.count > 4 {
                XCTAssertGreaterThan(
                    part.replacingOccurrences(of: "\u{2060}", with: "").count, 2,
                    "an orphan tail in \(id)")
            }
        }
        XCTAssertEqual(PolarisOfflineSurface.requestCode(deviceId: ids[0]), ids[0])
    }

    /// `.polarisKey(client)` draws the kit gate (UK-07): it renders, with and without a legacy
    /// theme, and the legacy theme maps only what the kit theme has a counterpart for.
    func testThePolarisKeyModifierDrawsTheKitGate() async throws {
        let c = try await client()
        XCTAssertTrue(renders(Text("App").polarisKey(c)))
        XCTAssertTrue(
            renders(
                Text("App").polarisKey(
                    c, theme: PolarisTheme(branding: .native, accent: .orange), offersFreeTier: true,
                    options: KitGateOptions(keyEntry: false))))
        XCTAssertNil(PolarisTheme().kitTheme, "an empty legacy theme leaves the kit theme alone")
        let mapped = try XCTUnwrap(PolarisTheme(branding: .native, accent: .orange).kitTheme)
        XCTAssertEqual(mapped.preset, .native)
        guard case .color(let light, let dark) = mapped.accent else {
            return XCTFail("the accent maps to a colour pair")
        }
        XCTAssertTrue(light.hasPrefix("#") && dark?.hasPrefix("#") == true)
        XCTAssertEqual(PolarisTheme(branding: .polarisKey).kitTheme?.preset, .polarisKey)
    }
}
#endif
