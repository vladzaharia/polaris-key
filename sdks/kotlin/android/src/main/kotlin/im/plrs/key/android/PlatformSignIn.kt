package im.plrs.key.android

import android.app.Activity
import im.plrs.key.identity.ExchangeKind
import im.plrs.key.identity.PlatformIdentityProvider
import im.plrs.key.identity.PlatformSubjectToken
import im.plrs.key.platform.PlatformIdentity
import im.plrs.key.platform.PlatformIdentityResult
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * :android's thin adapter over :platform's [PlatformIdentity] (I-45.4): suspend functions for the
 * platform sign-in rungs, showing the sheet from the host's foreground activity. In the `direct`
 * flavour every call answers Unavailable("outlet").
 *
 * [asProvider] adapts it to `:identity`'s `PlatformIdentityProvider` port (I-45.2): hand the result to
 * `client.identity.installPlatformIdentity(...)` and `autoSignIn()` runs rungs 3 and 4 through it.
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

/**
 * The `:identity` port over [PlatformSignIn]. [fallbackClientId] is the fallback audience when the
 * product's discovery publishes none. An unavailable or dismissed answer is "no token" (the ladder
 * moves on); the token leaves only through `reveal()`. Google has no revocation signal at launch.
 */
public fun PlatformSignIn.asProvider(fallbackClientId: String? = null): PlatformIdentityProvider = object : PlatformIdentityProvider {
    override val kind: ExchangeKind = ExchangeKind.google

    override suspend fun silent(nonce: String, serverClientId: String?): PlatformSubjectToken? {
        val audience = serverClientId ?: fallbackClientId ?: return null
        return token(nonce, this@asProvider.silent(audience, nonce))
    }

    override suspend fun sheet(nonce: String, serverClientId: String?): PlatformSubjectToken? {
        val audience = serverClientId ?: fallbackClientId ?: return null
        return token(nonce, this@asProvider.sheet(audience, nonce))
    }

    /** The sign-in form's Google row: the explicit "Sign in with Google" flow (`GetSignInWithGoogleOption`). */
    override suspend fun providerSheet(nonce: String, serverClientId: String?): PlatformSubjectToken? {
        val audience = serverClientId ?: fallbackClientId ?: return null
        return token(nonce, this@asProvider.provider(audience, nonce))
    }

    override suspend fun signOutCleanup() {
        this@asProvider.signOutCleanup()
    }

    override suspend fun credentialRevoked(): Boolean = false

    private fun token(nonce: String, result: PlatformIdentityResult): PlatformSubjectToken? =
        (result as? PlatformIdentityResult.Success)?.let { PlatformSubjectToken(it.token.reveal(), nonce) }
}
