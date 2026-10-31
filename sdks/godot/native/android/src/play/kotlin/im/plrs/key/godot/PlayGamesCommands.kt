package im.plrs.key.godot

import android.app.Activity
import android.content.Context
import org.json.JSONObject

/** What the `pgs_*` ops ask of Play Games Services v2: the real SDK on a device, a fake in tests. */
interface PlayGamesBackend {
    /** Whether the Play Games libraries are on the classpath (the export opt-in adds them). */
    fun dependencyPresent(): Boolean

    fun isAuthenticated(activity: Activity, callback: (Result<Boolean>) -> Unit)

    fun signIn(activity: Activity, callback: (Result<Boolean>) -> Unit)

    fun requestServerSideAccess(activity: Activity, serverClientId: String, callback: (Result<String>) -> Unit)
}

/**
 * The Play Games ops of the Godot plugin (I-48.7a, `play` flavour only; Q-3):
 *
 * - `pgs_code {serverClientId}`: rung 3, no UI. If the player is already signed in to Play Games,
 *   `requestServerSideAccess(serverClientId, false)` yields a server auth code for the Worker's
 *   exchange. A player who is not signed in is `unavailable("not-authenticated")`: this op never
 *   starts Play Games' sign-in.
 * - `pgs_sign_in`: the sign-in form's row. `signIn()` may show Play Games' own sheet; the answer is
 *   `{ok: true, authenticated}`, and the code is then asked for with `pgs_code`.
 *
 * Each answers `{ok: true, req}` at once; its result arrives as a queued event: `{ok: true, code}`
 * (a server auth code, a secret: only this event carries it, it is never logged), `{ok: true,
 * authenticated}` for the row, or `{ok: false, error: "unavailable", reason}` with a fixed word:
 * `dependency` (the export carries no Play Games library, checked by class name before anything
 * that names one loads), `no-activity`, `refused` (an empty server client id), `not-authenticated`
 * or `failed` (never the exception's text).
 *
 * The Play Games libraries come with the export opt-in (`polaris_key/play_games`, which adds the
 * Maven dependency and the `com.google.android.gms.games.APP_ID` meta-data); the AAR compiles against
 * them (`compileOnly`) and carries none, so a game that does not sign in through Play Games ships none.
 */
class PlayGamesCommands(private val c: Commands, private val backend: PlayGamesBackend) {
    /** Whether the ops can reach Play Games in this build (the `playGames` capability). */
    fun available(): Boolean = backend.dependencyPresent()

    fun handle(op: String, q: JSONObject): JSONObject {
        val serverClientId = q.optString("serverClientId")
        return c.onUiAsync { done ->
            val activity = c.host.foregroundActivity
            when {
                !backend.dependencyPresent() -> done(unavailable("dependency"))
                op == "pgs_code" && serverClientId.isBlank() -> done(unavailable("refused"))
                activity == null -> done(unavailable("no-activity"))
                op == "pgs_sign_in" -> signIn(activity, done)
                else -> code(activity, serverClientId, done)
            }
        }
    }

    private fun signIn(activity: Activity, done: (JSONObject) -> Unit) {
        backend.signIn(activity) { r ->
            done(r.fold({ JSONObject().put("ok", true).put("authenticated", it) }, { unavailable("failed") }))
        }
    }

    private fun code(activity: Activity, serverClientId: String, done: (JSONObject) -> Unit) {
        backend.isAuthenticated(activity) { auth ->
            val signedIn = auth.getOrNull()
            when {
                auth.isFailure -> done(unavailable("failed"))
                signedIn != true -> done(unavailable("not-authenticated"))
                else -> backend.requestServerSideAccess(activity, serverClientId) { r ->
                    done(r.fold({ JSONObject().put("ok", true).put("code", it) }, { unavailable("failed") }))
                }
            }
        }
    }

    private fun unavailable(reason: String): JSONObject =
        JSONObject().put("ok", false).put("error", "unavailable").put("reason", reason)

    companion object {
        /** The class Play Games' presence is judged by. */
        const val SDK_CLASS = "com.google.android.gms.games.PlayGames"
    }
}

/** Play Games Services v2 itself; kept in its own class so nothing that names an SDK type loads without the library. */
internal class PlayGamesSdkBackend(private val context: Context) : PlayGamesBackend {
    private var initialized = false

    override fun dependencyPresent(): Boolean = true

    @Synchronized
    private fun client(activity: Activity): com.google.android.gms.games.GamesSignInClient {
        if (!initialized) {
            com.google.android.gms.games.PlayGamesSdk.initialize(context.applicationContext)
            initialized = true
        }
        return com.google.android.gms.games.PlayGames.getGamesSignInClient(activity)
    }

    override fun isAuthenticated(activity: Activity, callback: (Result<Boolean>) -> Unit) {
        client(activity).isAuthenticated().addOnCompleteListener { t ->
            callback(if (t.isSuccessful) Result.success(t.result.isAuthenticated) else Result.failure(t.exception ?: IllegalStateException()))
        }
    }

    override fun signIn(activity: Activity, callback: (Result<Boolean>) -> Unit) {
        client(activity).signIn().addOnCompleteListener { t ->
            callback(if (t.isSuccessful) Result.success(t.result.isAuthenticated) else Result.failure(t.exception ?: IllegalStateException()))
        }
    }

    override fun requestServerSideAccess(activity: Activity, serverClientId: String, callback: (Result<String>) -> Unit) {
        client(activity).requestServerSideAccess(serverClientId, false).addOnCompleteListener { t ->
            callback(if (t.isSuccessful) Result.success(t.result) else Result.failure(t.exception ?: IllegalStateException()))
        }
    }
}

/** The real backend: judges the library's presence by class name, then loads [PlayGamesSdkBackend]. */
internal class SystemPlayGames(private val context: () -> Context) : PlayGamesBackend {
    private val sdk: PlayGamesBackend? by lazy {
        if (classPresent()) PlayGamesSdkBackend(context()) else null
    }

    override fun dependencyPresent(): Boolean = classPresent()

    override fun isAuthenticated(activity: Activity, callback: (Result<Boolean>) -> Unit) =
        sdk?.isAuthenticated(activity, callback) ?: callback(Result.failure(IllegalStateException("dependency")))

    override fun signIn(activity: Activity, callback: (Result<Boolean>) -> Unit) =
        sdk?.signIn(activity, callback) ?: callback(Result.failure(IllegalStateException("dependency")))

    override fun requestServerSideAccess(activity: Activity, serverClientId: String, callback: (Result<String>) -> Unit) =
        sdk?.requestServerSideAccess(activity, serverClientId, callback) ?: callback(Result.failure(IllegalStateException("dependency")))

    private fun classPresent(): Boolean = try {
        Class.forName(PlayGamesCommands.SDK_CLASS, false, PlayGamesCommands::class.java.classLoader)
        true
    } catch (e: ClassNotFoundException) {
        false
    } catch (e: LinkageError) {
        false
    }
}
