package im.plrs.key.games

/**
 * The slice of Play Games Services v2 that sign-in needs, as a port: [PlayGamesSdkClient] is the
 * real one and tests bring a fake. The server auth code is a secret; implementations never log it.
 */
public interface PlayGamesClient {
    /** Whether the player is signed in to Play Games (`GamesSignInClient.isAuthenticated()`). Starts no UI. */
    public suspend fun isAuthenticated(): Boolean

    /** Play Games' own sign-in (`GamesSignInClient.signIn()`): may show UI. Answers whether the player is signed in after it. */
    public suspend fun signIn(): Boolean

    /**
     * `GamesSignInClient.requestServerSideAccess(serverClientId, false)`: the server auth code for
     * [serverClientId], with no extra scopes. Throws when Play Games refuses.
     */
    public suspend fun requestServerSideAccess(serverClientId: String): String
}
