package im.plrs.key.games

import android.app.Activity
import android.content.Context
import com.google.android.gms.games.PlayGames
import com.google.android.gms.games.PlayGamesSdk
import com.google.android.gms.tasks.Task
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * [PlayGamesClient] over the Play Games Services v2 SDK. The app's manifest carries the
 * `com.google.android.gms.games.APP_ID` meta-data. [activity] is the host's foreground Activity,
 * which Play Games needs for its sign-in client; with none, every call throws and the ladder falls
 * to its next rung.
 */
public class PlayGamesSdkClient(private val activity: () -> Activity?) : PlayGamesClient {
    override suspend fun isAuthenticated(): Boolean = host().let { PlayGames.getGamesSignInClient(it).isAuthenticated().await().isAuthenticated }

    override suspend fun signIn(): Boolean = host().let { PlayGames.getGamesSignInClient(it).signIn().await().isAuthenticated }

    override suspend fun requestServerSideAccess(serverClientId: String): String =
        host().let { PlayGames.getGamesSignInClient(it).requestServerSideAccess(serverClientId, false).await() }

    private fun host(): Activity = checkNotNull(activity()) { "no foreground activity" }

    public companion object {
        /** `PlayGamesSdk.initialize`: once, from `Application.onCreate` or before the first call. */
        @JvmStatic
        public fun initialize(context: Context) {
            PlayGamesSdk.initialize(context.applicationContext)
        }
    }
}

private suspend fun <T> Task<T>.await(): T = suspendCancellableCoroutine { k ->
    addOnSuccessListener { if (k.isActive) k.resume(it) }
    addOnFailureListener { if (k.isActive) k.resumeWithException(it) }
    addOnCanceledListener { k.cancel() }
}
