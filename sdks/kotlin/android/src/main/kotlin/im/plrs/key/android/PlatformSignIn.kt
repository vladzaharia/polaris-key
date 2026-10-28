package im.plrs.key.android

import android.app.Activity
import im.plrs.key.platform.PlatformIdentity
import im.plrs.key.platform.PlatformIdentityResult
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * :android's thin adapter over :platform's [PlatformIdentity] (I-45.4): suspend functions for the
 * platform sign-in rungs, showing the sheet from the host's foreground activity. In the `direct`
 * flavour every call answers Unavailable("outlet").
 *
 * Hookup left to I-45.2: implement `:identity`'s `PlatformIdentityProvider` port with these four
 * calls (`silent`, `sheet`, `provider` and `signOutCleanup`), mapping [PlatformIdentityResult] to
 * the port's results; the token leaves only through `PlatformIdentityToken.reveal()`.
 */
public class PlatformSignIn(
    private val activity: () -> Activity?,
    private val identity: PlatformIdentity = PlatformIdentity.create(),
) {
    public val isSupported: Boolean get() = identity.isSupported

    public val kinds: Set<String> get() = identity.kinds

    /** Rung 3: no UI when exactly one previously authorised account exists. */
    public suspend fun silent(serverClientId: String, nonce: String): PlatformIdentityResult =
        ask { a, cb -> identity.silent(a, serverClientId, nonce, cb) }

    /** Rung 4: the account chooser sheet. */
    public suspend fun sheet(serverClientId: String, nonce: String): PlatformIdentityResult =
        ask { a, cb -> identity.sheet(a, serverClientId, nonce, cb) }

    /** The provider row: the explicit Sign in with Google flow. */
    public suspend fun provider(serverClientId: String, nonce: String): PlatformIdentityResult =
        ask { a, cb -> identity.provider(a, serverClientId, nonce, cb) }

    /** Sign-out: clears the credential state; false when it could not be cleared (sign-out still proceeds). */
    public suspend fun signOutCleanup(): Boolean {
        val host = activity() ?: return false
        return suspendCancellableCoroutine { k -> identity.signOutCleanup(host) { if (k.isActive) k.resume(it) } }
    }

    private suspend fun ask(call: (Activity, (PlatformIdentityResult) -> Unit) -> Unit): PlatformIdentityResult {
        val host = activity() ?: return PlatformIdentityResult.Unavailable(PlatformIdentity.REASON_NO_ACTIVITY)
        return suspendCancellableCoroutine { k -> call(host) { if (k.isActive) k.resume(it) } }
    }
}
