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

    public func silent(nonce: String) async throws -> PlatformSubjectToken {
        PlatformSubjectToken(token: try await apple.silent(nonce: nonce).identityToken, nonce: nonce)
    }

    public func sheet(nonce: String) async throws -> PlatformSubjectToken {
        PlatformSubjectToken(token: try await apple.sheet(nonce: nonce).identityToken, nonce: nonce)
    }

    public func signOutCleanup() async { apple.signOutCleanup() }

    public func credentialRevoked() async -> Bool { await apple.credentialRevoked() }
}
