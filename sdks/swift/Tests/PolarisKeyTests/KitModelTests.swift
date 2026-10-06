// @pkey-feature ui.kit
//
// The SwiftUI kit's models and surfaces (notes/SDK-PARITY-PASS.md §3.18). The models are driven
// against a stub Worker; every surface is rendered off-screen with `ImageRenderer` in each of its
// states (a render that traps or lays out to nothing fails), which is the kit's snapshot check
// under `swift test`, where no host app draws.

#if canImport(SwiftUI)
import Foundation
import PolarisKey
import PolarisKeyCore
import PolarisKeyIdentity
@testable import PolarisKeyUI
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

    func testTheModelFollowsClientChanges() async throws {
        await server.reply(
            "/djdl/license/activate", body: #"{"token":"pkeyt_new","schemaVersion":1}"#)
        let c = try await client(services: [.license])
        let model = PolarisKeyModel(client: c)
        model.start()
        XCTAssertFalse(model.identityEnabled)
        _ = await c.activate(key: "PKEY-1")
        for _ in 0..<50 where model.activation == nil {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertEqual(model.activation, .token)
        model.stop()
    }

    func testTheGateModelConvenienceInitTracksIdentity() async throws {
        let gate = PolarisGateModel(client: try await client())
        await gate.reload()
        XCTAssertTrue(gate.identityEnabled)
        XCTAssertNotNil(gate.facade)
        let off = PolarisGateModel(client: try await client(services: [.license]))
        await off.reload()
        XCTAssertFalse(off.identityEnabled)
    }

    func testQRCodeEncodes() {
        let image = PolarisQRCode.cgImage(for: "https://key.example/d?user_code=ABCD-EFGH")
        XCTAssertNotNil(image)
        XCTAssertGreaterThan(image?.width ?? 0, 20)
    }

    func testGateSurfacesRender() {
        let theme = PolarisTheme(copy: PolarisCopy(productName: "Aurora"))
        for (signIn, free, keys) in [(true, true, true), (false, false, true), (true, false, false)] {
            let surface = PolarisGateSurface(
                status: .needsActivation, allowedRange: nil, isWorking: false,
                lastError: ErrorCopy.message(ErrorCode.deviceLimit), licenseKey: .constant(""),
                theme: theme, onSignIn: signIn ? {} : nil, onActivate: { _ in }, onRefresh: {},
                onContinueFree: free ? {} : nil, onActivateOffline: {}, showsKeyEntry: keys,
                content: { Text("App") })
            XCTAssertTrue(renders(surface))
        }
    }

    func testSignInSurfacesRender() {
        let prompt = SignInPrompt(
            deviceCode: "dc", userCode: "ABCD-EFGH", verificationUri: "https://key.example/d",
            verificationUriComplete: "https://key.example/d?user_code=ABCD-EFGH", expiresIn: 600,
            interval: 5, expiresAt: Int(Date().timeIntervalSince1970) + 600)
        let phases: [PolarisSignInModel.Phase] = [
            .starting, .waiting(prompt),
            .confirm(prompt, identity: SignInIdentity(name: "Ada", email: "a@e.com"), attachable: true),
            .ready(SignInReady(identity: SignInIdentity(email: "a@e.com"))), .expired,
            .failed(code: "sign-in-denied", message: ErrorCopy.message("sign-in-denied")),
        ]
        for phase in phases {
            let view = PolarisSignInSurface(
                phase: phase, theme: PolarisTheme(), attach: .constant(true), onOpen: { _ in },
                onAccept: {}, onRetry: {}, onCancel: {})
            XCTAssertTrue(renders(view), "\(phase)")
            XCTAssertTrue(renders(view.polarisKeyBranding(.polarisKey).environment(\.colorScheme, .dark)))
        }
    }

    func testOfflineSurfacesRender() {
        for (imported, message) in [(false, nil), (false, ErrorCopy.message("bundle-trust-rejected")), (true, nil)] {
            let view = PolarisOfflineSurface(
                product: "djdl", deviceId: "DEVICE0001", message: message, imported: imported,
                copied: false, theme: PolarisTheme(), onCopy: {}, onImportFile: {}, onPaste: {},
                onDone: {})
            XCTAssertTrue(renders(view))
        }
    }
}
#endif
