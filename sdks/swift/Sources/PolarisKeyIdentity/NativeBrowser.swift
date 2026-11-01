// The system browser of a native redirect sign-in (WIRE-CONTRACT-V5 §12.12; I-15b.4).
//
//   - macOS, loopback: the default browser (`NSWorkspace.open`); the listener receives the redirect.
//   - A registered scheme or a claimed HTTPS link: `ASWebAuthenticationSession` with the matching
//     callback (`.customScheme`, or `.https(host:path:)` on 17.4 and later), not ephemeral, so the
//     person's own browser session is used. It hands the callback URL straight back to the app.
//
// No embedded web view: nothing here accepts one.

import Foundation
import PolarisKeyCore

#if canImport(AuthenticationServices) && (os(iOS) || os(macOS) || os(visionOS))
    import AuthenticationServices
#endif
#if os(macOS)
    import AppKit
#endif

/// The browser a native sign-in opens its authorize URL in when the host gave none, or nil where
/// the platform has none for that redirect class. `deliver` takes the callback URL a system
/// browser session hands back; `cancelled` is the person closing it.
@MainActor
func defaultNativeBrowser(
    for flow: NativeFlow, deliver: @escaping @Sendable (String) -> Void,
    cancelled: @escaping @Sendable () -> Void
) -> (any SignInBrowser)? {
    #if os(macOS)
        if flow.redirectClass == .loopback { return SystemBrowser() }
    #endif
    #if canImport(AuthenticationServices) && (os(iOS) || os(macOS) || os(visionOS))
        if flow.redirectClass != .loopback {
            return NativeAuthSessionBrowser(
                redirectClass: flow.redirectClass, redirectUri: flow.redirectUri, deliver: deliver,
                cancelled: cancelled)
        }
    #endif
    return nil
}

#if os(macOS)
    /// The default browser. The redirect comes back to the loopback listener, so there is nothing
    /// to close.
    @MainActor
    final class SystemBrowser: SignInBrowser {
        func open(_ url: URL) async throws {
            guard NSWorkspace.shared.open(url) else {
                throw PolarisError(
                    code: ErrorCode.signInUnavailable,
                    message: "The system browser could not be opened for the sign-in page.")
            }
        }
        func close() {}
    }
#endif

#if canImport(AuthenticationServices) && (os(iOS) || os(macOS) || os(visionOS))
    /// `ASWebAuthenticationSession` for a registered scheme or a claimed HTTPS callback.
    @MainActor
    final class NativeAuthSessionBrowser: NSObject, SignInBrowser {
        private var session: ASWebAuthenticationSession?
        private var anchor: AnchorProvider?
        private let redirectClass: NativeRedirectClass
        private let redirectUri: String
        private let deliver: @Sendable (String) -> Void
        private let cancelled: @Sendable () -> Void

        init(
            redirectClass: NativeRedirectClass, redirectUri: String,
            deliver: @escaping @Sendable (String) -> Void, cancelled: @escaping @Sendable () -> Void
        ) {
            self.redirectClass = redirectClass
            self.redirectUri = redirectUri
            self.deliver = deliver
            self.cancelled = cancelled
            super.init()
        }

        func open(_ url: URL) async throws {
            let provider = AnchorProvider(anchor: WebAuthenticationSignInBrowser.currentAnchor())
            let deliver = self.deliver
            let cancelled = self.cancelled
            let completion: @Sendable (URL?, (any Error)?) -> Void = { callback, _ in
                // A callback is delivered; anything else (the person closed the sheet, or it
                // could not be shown) ends the sign-in.
                if let callback { deliver(callback.absoluteString) } else { cancelled() }
            }
            let session: ASWebAuthenticationSession
            if redirectClass == .claimed {
                guard #available(iOS 17.4, macOS 14.4, visionOS 1.2, *),
                    let parts = URLComponents(string: redirectUri), let host = parts.host
                else { throw Self.unavailable() }
                session = ASWebAuthenticationSession(
                    url: url, callback: .https(host: host, path: parts.path), completionHandler: completion)
            } else {
                let scheme = String(redirectUri.prefix(while: { $0 != ":" }))
                session = ASWebAuthenticationSession(
                    url: url, callbackURLScheme: scheme, completionHandler: completion)
            }
            session.presentationContextProvider = provider
            session.prefersEphemeralWebBrowserSession = false
            self.anchor = provider
            self.session = session
            guard session.start() else {
                self.session = nil
                self.anchor = nil
                throw Self.unavailable()
            }
        }

        func close() {
            session?.cancel()
            session = nil
            anchor = nil
        }

        private static func unavailable() -> PolarisError {
            PolarisError(
                code: ErrorCode.signInUnavailable,
                message: "The system browser sheet could not be shown for the sign-in page.")
        }
    }
#endif
