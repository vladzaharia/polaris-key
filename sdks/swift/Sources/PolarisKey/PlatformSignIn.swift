// The umbrella's Sign in with Apple adapter (I-44.4): a thin layer over PolarisKeyPlatform's
// `AppleSignIn`. It hands the exchange what it needs (the identity token and the server nonce, as
// is: D-A4) and keeps no Apple state of its own; the Apple user id lives in `AppleSignIn`'s store.
//
// TODO(I-44.2): declare `AppleSignInProvider: PlatformIdentityProvider` once that protocol lands
// (`silent(nonce:)`, `sheet(nonce:)`, `signOutCleanup()`, `credentialRevoked()`); the four methods
// below already have those names.

import Foundation
import PolarisKeyPlatform

/// What the exchange takes: `exchange(kind: .apple, subjectToken: token, nonce: nonce)`.
public struct PlatformSubjectToken: Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible {
    /// The identity token. A secret.
    public let token: String
    /// The server nonce that was bound into the request.
    public let nonce: String
    public init(token: String, nonce: String) {
        self.token = token
        self.nonce = nonce
    }
    public var description: String { "PlatformSubjectToken(<redacted>)" }
    public var debugDescription: String { description }
}

/// Apple's provider for the automatic sign-in ladder.
public struct AppleSignInProvider: Sendable {
    private let apple: AppleSignIn

    public init(apple: AppleSignIn = AppleSignIn()) { self.apple = apple }

    public func silent(nonce: String) async throws -> PlatformSubjectToken {
        PlatformSubjectToken(token: try await apple.silent(nonce: nonce).identityToken, nonce: nonce)
    }

    public func sheet(nonce: String) async throws -> PlatformSubjectToken {
        PlatformSubjectToken(token: try await apple.sheet(nonce: nonce).identityToken, nonce: nonce)
    }

    public func signOutCleanup() { apple.signOutCleanup() }

    public func credentialRevoked() async -> Bool { await apple.credentialRevoked() }
}
