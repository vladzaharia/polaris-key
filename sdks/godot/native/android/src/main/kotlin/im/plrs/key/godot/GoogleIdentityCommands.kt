package im.plrs.key.godot

import im.plrs.key.platform.PlatformIdentity
import im.plrs.key.platform.PlatformIdentityResult
import im.plrs.key.platform.PolarisKeyPlatform
import org.json.JSONObject

/**
 * The Google sign-in ops of the Godot plugin (I-48.5a), over `:platform`'s [PlatformIdentity]
 * (Credential Manager in `play`, nothing in `direct`):
 *
 * - `gid_silent {serverClientId, nonce}`: rung 3, no UI for one previously authorised account;
 * - `gid_sheet {serverClientId, nonce}`: rung 4, the account chooser;
 * - `gid_provider {serverClientId, nonce}`: the sign-in form's "Sign in with Google" button;
 * - `gid_sign_out`: forget the credential state so the next launch does not sign straight back in.
 *
 * Each of the first three answers `{ok: true, req}` at once and its result arrives as a queued event
 * `{ev: "result", req, ok: true, token}` (a Google ID token, a secret: it is never logged and only
 * this event carries it), or `{ok: false, error: "cancelled" | "unavailable", reason}` where `reason`
 * is one of [PlatformIdentity]'s fixed words (`outlet`, `dependency`, `no-activity`, `no-credential`,
 * `no-play-services`, …), never provider text. `gid_sign_out` answers `{ok: true, cleared}`.
 *
 * The Godot export carries the Credential Manager libraries only when the preset asks for them
 * (android_export.gd): a build without them answers `unavailable(dependency)` here, checked before
 * any class that names them is loaded, so a missing library is a typed answer and never a
 * `NoClassDefFoundError`. The `direct` flavour answers `unavailable(outlet)`.
 */
class GoogleIdentityCommands(private val c: Commands, private val backend: Backend = Real) {
    /** What the ops act through: the real [PlatformIdentity] in the app, a fake in tests. */
    interface Backend {
        /** Whether the Credential Manager libraries are on the classpath. */
        fun dependencyPresent(): Boolean

        /** Whether this build's flavour carries Google sign-in (`play`). */
        fun flavorHasGoogle(): Boolean

        fun identity(): PlatformIdentity
    }

    /** The app's: class-presence check by name, the flavour from [PolarisKeyPlatform]. */
    object Real : Backend {
        override fun dependencyPresent(): Boolean = DEPENDENCY_CLASSES.all { classPresent(it) }

        override fun flavorHasGoogle(): Boolean = PolarisKeyPlatform.isPlay

        override fun identity(): PlatformIdentity = PlatformIdentity.create()

        private fun classPresent(name: String): Boolean = try {
            Class.forName(name, false, GoogleIdentityCommands::class.java.classLoader)
            true
        } catch (e: ClassNotFoundException) {
            false
        } catch (e: LinkageError) {
            false
        }
    }

    /** Why Google sign-in cannot run here, or null when it can. */
    private fun unavailableReason(): String? = when {
        !backend.flavorHasGoogle() -> PlatformIdentity.REASON_OUTLET
        !backend.dependencyPresent() -> REASON_DEPENDENCY
        else -> null
    }

    /** Whether the ops can reach Credential Manager in this build (the `googleId` capability). */
    fun available(): Boolean = unavailableReason() == null

    fun handle(op: String, q: JSONObject): JSONObject = when (op) {
        "gid_sign_out" -> signOut()
        else -> signIn(op, q)
    }

    private fun signIn(op: String, q: JSONObject): JSONObject {
        val serverClientId = q.optString("serverClientId")
        val nonce = q.optString("nonce")
        return c.onUiAsync { done ->
            val why = unavailableReason()
            val refused = PlatformIdentity.refusal(serverClientId, nonce)
            val activity = c.host.foregroundActivity
            when {
                why != null -> done(unavailable(why))
                refused != null -> done(unavailable(PlatformIdentity.REASON_REFUSED))
                activity == null -> done(unavailable(PlatformIdentity.REASON_NO_ACTIVITY))
                else -> {
                    val identity = try {
                        backend.identity()
                    } catch (e: LinkageError) {
                        null
                    }
                    if (identity == null) {
                        done(unavailable(REASON_DEPENDENCY))
                    } else {
                        val cb: (PlatformIdentityResult) -> Unit = { done(answer(it)) }
                        when (op) {
                            "gid_silent" -> identity.silent(activity, serverClientId, nonce, cb)
                            "gid_sheet" -> identity.sheet(activity, serverClientId, nonce, cb)
                            else -> identity.provider(activity, serverClientId, nonce, cb)
                        }
                    }
                }
            }
        }
    }

    private fun signOut(): JSONObject {
        // Nothing was signed in through a build that cannot sign in: nothing to clear.
        if (unavailableReason() != null) return JSONObject().put("ok", true).put("cleared", true)
        return c.onUiAsync { done ->
            val identity = try {
                backend.identity()
            } catch (e: LinkageError) {
                null
            }
            if (identity == null) {
                done(JSONObject().put("ok", true).put("cleared", true))
            } else {
                identity.signOutCleanup(c.host.appContext) { cleared -> done(JSONObject().put("ok", true).put("cleared", cleared)) }
            }
        }
    }

    private fun answer(r: PlatformIdentityResult): JSONObject = when (r) {
        is PlatformIdentityResult.Success -> JSONObject().put("ok", true).put("token", r.token.reveal())
        PlatformIdentityResult.Cancelled -> JSONObject().put("ok", false).put("error", "cancelled")
        is PlatformIdentityResult.Unavailable -> unavailable(r.reason)
    }

    private fun unavailable(reason: String): JSONObject =
        JSONObject().put("ok", false).put("error", "unavailable").put("reason", reason)

    companion object {
        /** The classes `play.GoogleSignIn` and its provider need; absent from a Godot export that did not add them. */
        val DEPENDENCY_CLASSES = listOf(
            "androidx.credentials.CredentialManager",
            "com.google.android.libraries.identity.googleid.GetGoogleIdOption",
            // The provider artifact: Credential Manager finds no Google provider without it.
            "androidx.credentials.playservices.CredentialProviderPlayServicesImpl",
        )

        /** [PlatformIdentityResult.Unavailable] reason: the Credential Manager libraries are not in this build. */
        const val REASON_DEPENDENCY = "dependency"
    }
}
