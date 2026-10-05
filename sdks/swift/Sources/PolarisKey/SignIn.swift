// Sign-in conveniences on the facade (notes/SDK-PARITY-PASS.md §3.12, SP-S11).
//
//   signInWithBrowser()  device code with `verificationUriComplete` opened in a system browser
//                        sheet (ASWebAuthenticationSession), then the paced wait; the sheet is
//                        dismissed once the sign-in settles. No new route: this is the interim
//                        until the native redirect route (I-15) lands, and it never touches the
//                        deprecated `/identity/auth/poll`.
//   signOut()            `deactivate()` (release the seat, wipe the credential) — after a
//                        device-code sign-in the identity IS the credential — then `license`.
//   currentIdentity()    the signed profile's name, e-mail and activation time, or nil.

import Foundation
import PolarisKeyCore
import PolarisKeyIdentity
import PolarisKeyLicense

#if canImport(AuthenticationServices) && !os(watchOS) && !os(tvOS)
    import AuthenticationServices
#endif
#if os(macOS)
    import AppKit
#elseif canImport(UIKit)
    import UIKit
#endif

/// The signed-in identity as the licence document states it (signed, so not spoofable locally).
public struct CurrentIdentity: Sendable, Equatable {
    public let name: String
    public let email: String
    /// Epoch seconds the licence was first activated.
    public let activatedAt: Int
}

/// Opens the verification page while the SDK polls. `open` returns when the page is shown;
/// `close` dismisses it once the sign-in settled.
public protocol SignInBrowser: Sendable {
    @MainActor func open(_ url: URL) async throws
    @MainActor func close()
}

extension PolarisKeyClient {
    /// Begin a device-code sign-in, show its page in `browser` (an in-app browser sheet by
    /// default), and wait for it. Throws `PolarisError` (`service-unavailable` when the product
    /// runs no Identity, `sign-in-unavailable`, …) or `CancellationError`.
    public func signInWithBrowser(
        deviceName: String? = nil, browser: (any SignInBrowser)? = nil
    ) async throws -> SignInResult {
        let prompt = try await identity.beginSignIn(deviceName: deviceName)
        guard let url = URL(string: prompt.verificationUriComplete) else {
            throw PolarisError(
                code: ErrorCode.badResponse, message: "the verification URL is not a URL.")
        }
        var opener = browser
        if opener == nil { opener = await defaultSignInBrowser() }
        if let opener { try? await opener.open(url) }
        defer { if let opener { Task { @MainActor in opener.close() } } }
        return try await identity.waitForSignIn(prompt)
    }

    /// Sign out: release this device's seat and wipe its credential (`deactivate()`), emitting
    /// `license`. After a device-code sign-in the identity's licence IS the credential.
    public func signOut() async throws {
        try await deactivate()
    }

    /// The signed-in identity from the verified licence document, or nil.
    public func currentIdentity() async -> CurrentIdentity? {
        guard let p = await license.profile() else { return nil }
        return CurrentIdentity(name: p.name, email: p.email, activatedAt: p.activatedAt)
    }
}

@MainActor
func defaultSignInBrowser() -> (any SignInBrowser)? {
    #if canImport(AuthenticationServices) && (os(iOS) || os(macOS) || os(visionOS))
        return WebAuthenticationSignInBrowser()
    #else
        return nil
    #endif
}

#if canImport(AuthenticationServices) && (os(iOS) || os(macOS) || os(visionOS))
    /// The verification page in an `ASWebAuthenticationSession` sheet. The device-code page has
    /// no redirect back, so the session has no callback scheme: it shows the page and is cancelled
    /// by `close()` once polling settles (or by the player).
    @MainActor
    public final class WebAuthenticationSignInBrowser: NSObject, SignInBrowser,
        ASWebAuthenticationPresentationContextProviding
    {
        private var session: ASWebAuthenticationSession?

        public override init() { super.init() }

        public func open(_ url: URL) async throws {
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: nil) { _, _ in }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            _ = session.start()
        }

        public func close() {
            session?.cancel()
            session = nil
        }

        public nonisolated func presentationAnchor(for session: ASWebAuthenticationSession)
            -> ASPresentationAnchor
        {
            MainActor.assumeIsolated {
                #if os(macOS)
                    return NSApplication.shared.keyWindow ?? NSApplication.shared.windows.first
                        ?? ASPresentationAnchor()
                #else
                    let scenes = UIApplication.shared.connectedScenes.compactMap {
                        $0 as? UIWindowScene
                    }
                    if let window = scenes.flatMap(\.windows).first(where: \.isKeyWindow) {
                        return window
                    }
                    if let scene = scenes.first { return ASPresentationAnchor(windowScene: scene) }
                    return ASPresentationAnchor()
                #endif
            }
        }
    }
#endif
