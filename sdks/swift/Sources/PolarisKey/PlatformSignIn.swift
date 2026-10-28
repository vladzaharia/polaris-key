// The umbrella's Sign in with Apple adapter (I-44.4): a thin layer over PolarisKeyPlatform's
// `AppleSignIn`. It hands the exchange what it needs (the identity token and the server nonce, as
// is: D-A4) and keeps no Apple state of its own; the Apple user id lives in `AppleSignIn`'s store.
//

import Foundation
import PolarisKeyIdentity
import PolarisKeyPlatform

/// Apple's provider for the automatic sign-in ladder.
public struct AppleSignInProvider: PlatformIdentityProvider {
    public var kind: ExchangeKind { .apple }

    private let apple: AppleSignIn

    public init(apple: AppleSignIn = AppleSignIn()) { self.apple = apple }

    public var hasSilentRung: Bool { false }

    /// Apple has no silent rung (its API shows a sheet whenever a credential exists): this throws
    /// at once and never reaches the authorizer.
    public func silent(nonce: String) async throws -> PlatformSubjectToken {
        _ = try await apple.silent(nonce: nonce)
        throw AppleSignInFailure.unavailable("Sign in with Apple has no silent rung.")
    }

    /// The one OS sheet, for a credential this app already has; runs only under `prompt: .optional`.
    public func sheet(nonce: String) async throws -> PlatformSubjectToken {
        let grant = try await apple.sheet(nonce: nonce)
        return PlatformSubjectToken(token: grant.identityToken, nonce: nonce, userID: grant.userID)
    }

    /// The Worker accepted the token: only now is the Apple user id kept for the launch check.
    public func sessionStarted(_ token: PlatformSubjectToken) async {
        if let id = token.userID { apple.remember(userID: id) }
    }

    public func signOutCleanup() async { apple.signOutCleanup() }

    public func credentialRevoked() async -> Bool { await apple.credentialRevoked() }
}
