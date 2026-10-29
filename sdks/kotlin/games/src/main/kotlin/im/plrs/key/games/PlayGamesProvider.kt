package im.plrs.key.games

import im.plrs.key.identity.ExchangeKind
import im.plrs.key.identity.PlatformIdentityProvider
import im.plrs.key.identity.PlatformSubjectToken
import kotlinx.coroutines.CancellationException

/**
 * Play Games as the platform identity of `identity.autoSignIn()` (V5 section 12.11.7). The subject
 * token is the server auth code for the `serverClientId` of discovery's `exchange.pgs`. Play Games
 * takes no nonce, so the exchange proof binds the code to the Worker's nonce instead.
 *
 * Launch never starts Play Games' sign-in: [silent] and [sheet] answer null for a player who is not
 * signed in. Only the provider row ([providerSheet], pressed by the person) calls `signIn()`.
 * Nothing here logs, prints or keeps the code; the token's `toString` redacts it.
 *
 * Install it with `client.identity.installPlatformIdentity(PlayGamesProvider(...))`, or pass it in
 * `AutoSignInOptions(provider = ...)`. The ladder asks the Worker for a `pgs` nonce, so the product
 * must list `pgs` in discovery; otherwise the ladder ends `Unavailable`.
 */
public class PlayGamesProvider(
    private val games: PlayGamesClient,
    /** The audience when discovery publishes none. */
    private val fallbackServerClientId: String? = null,
) : PlatformIdentityProvider {
    override val kind: ExchangeKind = ExchangeKind.pgs

    override suspend fun silent(nonce: String, serverClientId: String?): PlatformSubjectToken? {
        val audience = serverClientId ?: fallbackServerClientId ?: return null
        if (!games.isAuthenticated()) return null
        return code(nonce, audience)
    }

    // Play Games has no account chooser to show at launch: the sheet rung is the silent one.
    override suspend fun sheet(nonce: String, serverClientId: String?): PlatformSubjectToken? = silent(nonce, serverClientId)

    override suspend fun providerSheet(nonce: String, serverClientId: String?): PlatformSubjectToken? {
        val audience = serverClientId ?: fallbackServerClientId ?: return null
        if (!games.isAuthenticated() && !games.signIn()) return null
        return code(nonce, audience)
    }

    // Play Games keeps the player's session; there is nothing of ours to forget.
    override suspend fun signOutCleanup() {}

    override suspend fun credentialRevoked(): Boolean = false

    private suspend fun code(nonce: String, audience: String): PlatformSubjectToken? = try {
        games.requestServerSideAccess(audience).takeIf { it.isNotEmpty() }?.let { PlatformSubjectToken(it, nonce) }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        null
    }
}
