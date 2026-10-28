package im.plrs.key.platform

import android.content.Context

/**
 * A platform identity token (a Google ID token) on its way to the Worker's exchange. The value is
 * reachable only through [reveal]; [toString] never carries it, so a log line, a string template or
 * a crash report that names this object cannot leak the token. Equality is by identity.
 */
public class PlatformIdentityToken(public val kind: String, private val value: String) {
    /** The raw token, for the exchange request and nothing else. */
    public fun reveal(): String = value

    override fun toString(): String = "PlatformIdentityToken(kind=$kind, token=redacted)"
}

/**
 * The outcome of a [PlatformIdentity] call. Exactly one of three. [code] is the parity error code a
 * non-success maps to: [CODE_UNAVAILABLE] (`platform-identity-unavailable`, the ladder falls to the
 * next rung) or [CODE_CANCELLED] (`cancelled`, a person dismissed the sheet).
 */
public sealed class PlatformIdentityResult {
    public class Success(public val token: PlatformIdentityToken) : PlatformIdentityResult() {
        override fun toString(): String = "Success($token)"
    }

    public data object Cancelled : PlatformIdentityResult()

    /** [reason] is a short fixed word (see [PlatformIdentity.Companion]), never provider text. */
    public data class Unavailable(public val reason: String) : PlatformIdentityResult()

    public val code: String?
        get() = when (this) {
            is Success -> null
            Cancelled -> CODE_CANCELLED
            is Unavailable -> CODE_UNAVAILABLE
        }

    public companion object {
        /** `platform-identity-unavailable` in conformance/parity/errors.json. */
        public const val CODE_UNAVAILABLE: String = "platform-identity-unavailable"

        /** `cancelled` in conformance/parity/errors.json. */
        public const val CODE_CANCELLED: String = "cancelled"
    }
}

/**
 * The platform sign-in rungs of automatic sign-in (I-45; plan-auto-sign-in rungs 3 and 4, and the
 * provider row), available in every flavour as one surface:
 *
 * - `play`: Credential Manager with Google ID (`play.GoogleSignIn`).
 * - `direct`: every call answers [PlatformIdentityResult.Unavailable] with [REASON_OUTLET], and the
 *   build carries no `androidx.credentials` or googleid class.
 *
 * Every request carries the server's [nonce] (the Worker's `nonce` route); an empty one is refused
 * before the OS is asked. The token binds to that nonce, so a token minted for another request
 * cannot be exchanged. Callbacks arrive on Android's main thread.
 */
public interface PlatformIdentity {
    /** False when every call answers [PlatformIdentityResult.Unavailable]. */
    public val isSupported: Boolean

    /** The provider kinds this build can sign in with (`google` in `play`). */
    public val kinds: Set<String>

    /** Rung 3: no UI when exactly one previously authorised account exists. */
    public fun silent(context: Context, serverClientId: String, nonce: String, callback: (PlatformIdentityResult) -> Unit)

    /** Rung 4: the account chooser sheet. */
    public fun sheet(context: Context, serverClientId: String, nonce: String, callback: (PlatformIdentityResult) -> Unit)

    /** The provider row: the explicit Sign in with Google button flow. */
    public fun provider(context: Context, serverClientId: String, nonce: String, callback: (PlatformIdentityResult) -> Unit)

    /** Sign-out: forget the credential state so the next launch does not sign straight back in. [callback] gets whether it was cleared. */
    public fun signOutCleanup(context: Context, callback: (Boolean) -> Unit)

    public companion object {
        public const val KIND_GOOGLE: String = "google"

        /** [PlatformIdentityResult.Unavailable] reasons. */
        public const val REASON_OUTLET: String = "outlet"
        public const val REASON_REFUSED: String = "refused"
        public const val REASON_NO_CREDENTIAL: String = "no-credential"
        public const val REASON_NO_PLAY_SERVICES: String = "no-play-services"
        public const val REASON_UNSUPPORTED: String = "unsupported"
        public const val REASON_INTERRUPTED: String = "interrupted"
        public const val REASON_BAD_CREDENTIAL: String = "bad-credential"
        public const val REASON_FAILED: String = "failed"

        /** The host had no foreground activity to show the sheet from. */
        public const val REASON_NO_ACTIVITY: String = "no-activity"

        /** This build's platform identity: Credential Manager in `play`, [unsupported] in `direct`. */
        public fun create(): PlatformIdentity = FlavorIdentity.create()

        /** A platform identity whose every call answers [PlatformIdentityResult.Unavailable] with [reason]. */
        public fun unsupported(reason: String = REASON_OUTLET): PlatformIdentity = UnsupportedIdentity(reason)

        /** Why the arguments are refused, or null when they are acceptable. */
        public fun refusal(serverClientId: String, nonce: String): String? = when {
            serverClientId.isBlank() -> "serverClientId must not be empty"
            nonce.isEmpty() -> "nonce must not be empty"
            else -> null
        }
    }
}

private class UnsupportedIdentity(private val reason: String) : PlatformIdentity {
    override val isSupported: Boolean get() = false
    override val kinds: Set<String> get() = emptySet()

    override fun silent(context: Context, serverClientId: String, nonce: String, callback: (PlatformIdentityResult) -> Unit): Unit =
        callback(PlatformIdentityResult.Unavailable(reason))

    override fun sheet(context: Context, serverClientId: String, nonce: String, callback: (PlatformIdentityResult) -> Unit): Unit =
        callback(PlatformIdentityResult.Unavailable(reason))

    override fun provider(context: Context, serverClientId: String, nonce: String, callback: (PlatformIdentityResult) -> Unit): Unit =
        callback(PlatformIdentityResult.Unavailable(reason))

    // Nothing was signed in here, so there is nothing to clear.
    override fun signOutCleanup(context: Context, callback: (Boolean) -> Unit): Unit = callback(true)
}
