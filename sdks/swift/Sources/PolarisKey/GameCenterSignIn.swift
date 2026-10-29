// The umbrella's Game Center adapter (I-44.5): a thin layer over PolarisKeyGameCenter that hands the
// exchange the `gc1.` token. It keeps no Game Center state and never shows Game Center's sign-in.

import Foundation
import PolarisKeyGameCenter
import PolarisKeyIdentity

/// Game Center's provider for the automatic sign-in ladder.
///
/// Rung 3 (silent) answers when the local player is already signed in to Game Center and the
/// platform says its ids are persistent; rung 4 has no sheet of its own (Game Center sign-in is the
/// player's, in Settings or the Game Center app), so `sheet` fails at once. Game Center takes no
/// nonce: `nonce` is not signed into the token; the exchange proof binds it.
public struct GameCenterSignInProvider: PlatformIdentityProvider {
    public var kind: ExchangeKind { .gamecenter }

    private let identity: GameCenterIdentity

    public init(identity: GameCenterIdentity = GameCenterIdentity()) { self.identity = identity }

    public func silent(nonce: String) async throws -> PlatformSubjectToken {
        PlatformSubjectToken(token: try await identity.token(), nonce: nonce)
    }

    public func sheet(nonce: String) async throws -> PlatformSubjectToken {
        throw GameCenterFailure.notAuthenticated
    }

    public func signOutCleanup() async {}

    /// Game Center has no revocation signal.
    public func credentialRevoked() async -> Bool { false }
}
