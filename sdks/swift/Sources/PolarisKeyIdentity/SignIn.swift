// Sign-in conveniences on `client.identity` (notes/SDK-PARITY-PASS.md §3.12, SP-S11).
//
//   signInWithBrowser()  device code with `verificationUriComplete` opened in a system browser
//                        sheet (ASWebAuthenticationSession), then the paced wait; the sheet is
//                        dismissed once the sign-in settles. No new route: this is the interim
//                        until the native redirect route (I-15) lands, and it never touches the
//                        deprecated `/identity/auth/poll`.
//   signOut()            the facade's `deactivate()` (release the seat, wipe the credential) —
//                        after a device-code sign-in the identity IS the credential — then the
//                        `license` event. The facade installs it (`installSignOut`), because the
//                        seat release belongs to the license module; a standalone IdentityClient
//                        refuses with `invalid-options` rather than pretending.
//   current()            the signed profile's name, e-mail and activation time, or nil.
//
// The same names as every SDK: `identity.signInWithBrowser()`, `identity.signOut()`,
// `identity.current()` (Python `identity.sign_in_with_browser()`, Godot `identity.current()`).

import Foundation
import PolarisKeyCore

#if canImport(AuthenticationServices) && !os(watchOS) && !os(tvOS)
    import AuthenticationServices
#endif
#if os(macOS)
    import AppKit
#elseif canImport(UIKit)
    import UIKit
#endif

/// The signed-in identity as the licence document states it (signed, so not spoofable locally).
/// A value the profile leaves empty is nil, as in Godot's `identity.current()` and Python's.
public struct CurrentIdentity: Sendable, Equatable {
    public let name: String?
    public let email: String?
    /// Epoch seconds the licence was first activated, or nil when the profile does not say.
    public let activatedAt: Int?

    public init(name: String?, email: String?, activatedAt: Int?) {
        self.name = name
        self.email = email
        self.activatedAt = activatedAt
    }
}

/// Opens the verification page while the SDK polls. `open` returns when the page is shown;
/// `close` dismisses it once the sign-in settled.
public protocol SignInBrowser: Sendable {
    @MainActor func open(_ url: URL) async throws
    @MainActor func close()
}

extension IdentityClient {
    /// Begin a device-code sign-in, show its page in `browser` (an in-app browser sheet by
    /// default), and wait for it. Throws `PolarisError` (`service-unavailable` when the product
    /// runs no Identity, `sign-in-unavailable`, …) or `CancellationError`.
    public func signInWithBrowser(
        deviceName: String? = nil, browser: (any SignInBrowser)? = nil
    ) async throws -> SignInResult {
        let prompt = try await beginSignIn(deviceName: deviceName)
        guard let url = URL(string: prompt.verificationUriComplete) else {
            throw PolarisError(
                code: ErrorCode.badResponse, message: "the verification URL is not a URL.")
        }
        var opener = browser
        if opener == nil { opener = await defaultSignInBrowser() }
        if let opener { try? await opener.open(url) }
        defer { if let opener { Task { @MainActor in opener.close() } } }
        return try await waitForSignIn(prompt)
    }

    /// Sign out: release this device's seat and wipe its credential (the facade's
    /// `deactivate()`), emitting `license`. After a device-code sign-in the identity's licence IS
    /// the credential. Throws `invalid-options` on an IdentityClient built without the facade.
    public func signOut() async throws {
        guard let hook = signOutHook.current else {
            throw PolarisError(
                code: ErrorCode.invalidOptions,
                message: "signOut() needs the PolarisKeyClient facade, which releases the seat.")
        }
        try await hook()
    }

    /// The signed-in identity from the verified licence document, or nil when the device holds no
    /// licence or its profile names no one. The server signs a profile on every licence; an
    /// anonymous (keyless) enrolment's carries empty strings, which read as nil here.
    public func current() async -> CurrentIdentity? {
        guard let p = await core.cache().license?.doc.profile else { return nil }
        let name = p.name.isEmpty ? nil : p.name
        let email = p.email.isEmpty ? nil : p.email
        if name == nil && email == nil { return nil }
        return CurrentIdentity(
            name: name, email: email, activatedAt: p.activatedAt > 0 ? p.activatedAt : nil)
    }

    /// The facade installs its `deactivate()` here so `signOut()` releases the seat and emits.
    public func installSignOut(_ hook: @escaping @Sendable () async throws -> Void) {
        signOutHook.set(hook)
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
