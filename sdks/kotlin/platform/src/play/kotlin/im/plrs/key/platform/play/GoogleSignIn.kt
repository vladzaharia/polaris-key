package im.plrs.key.platform.play

import android.content.Context
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CredentialManager
import androidx.credentials.CredentialManagerCallback
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.exceptions.ClearCredentialException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialInterruptedException
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException
import androidx.credentials.exceptions.GetCredentialUnsupportedException
import androidx.credentials.exceptions.NoCredentialException
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.google.android.libraries.identity.googleid.GoogleIdTokenParsingException
import im.plrs.key.platform.PlatformIdentity
import im.plrs.key.platform.PlatformIdentityResult
import im.plrs.key.platform.PlatformIdentityToken
import java.util.concurrent.Executor

/** What [GoogleSignIn] asks of Credential Manager: the real [CredentialManager], or a fake in tests. */
internal interface CredentialBackend {
    fun get(context: Context, request: GetCredentialRequest, callback: (Result<GetCredentialResponse>) -> Unit)

    fun clear(context: Context, callback: (Result<Unit>) -> Unit)
}

internal class CredentialManagerBackend : CredentialBackend {
    private val main = Executor { Handler(Looper.getMainLooper()).post(it) }

    override fun get(context: Context, request: GetCredentialRequest, callback: (Result<GetCredentialResponse>) -> Unit) {
        val manager = try {
            CredentialManager.create(context)
        } catch (e: Exception) {
            callback(Result.failure(e))
            return
        }
        manager.getCredentialAsync(
            context,
            request,
            CancellationSignal(),
            main,
            object : CredentialManagerCallback<GetCredentialResponse, GetCredentialException> {
                override fun onResult(result: GetCredentialResponse) = callback(Result.success(result))

                override fun onError(e: GetCredentialException) = callback(Result.failure(e))
            },
        )
    }

    override fun clear(context: Context, callback: (Result<Unit>) -> Unit) {
        val manager = try {
            CredentialManager.create(context)
        } catch (e: Exception) {
            callback(Result.failure(e))
            return
        }
        manager.clearCredentialStateAsync(
            ClearCredentialStateRequest(),
            CancellationSignal(),
            main,
            object : CredentialManagerCallback<Void?, ClearCredentialException> {
                override fun onResult(result: Void?) = callback(Result.success(Unit))

                override fun onError(e: ClearCredentialException) = callback(Result.failure(e))
            },
        )
    }
}

/**
 * [PlatformIdentity] over Credential Manager with Google ID (I-45.4):
 *
 * - [silent] (rung 3): `GetGoogleIdOption` with `setFilterByAuthorizedAccounts(true)` and
 *   `setAutoSelectEnabled(true)`: no UI when exactly one authorised account exists. CAVEAT: Credential
 *   Manager auto-selects only that one account. With two or more authorised accounts it shows its account
 *   chooser, and it gives no signal beforehand (nor a "silent only" mode) to stop that, so this rung
 *   cannot be guaranteed sheet-free; an app that must never show a sheet should not install the provider.
 * - [sheet] (rung 4): the same authorised-accounts option with auto-select off, so the chooser lists the
 *   accounts the person already used with this app (the plan's rung 4 is "the same call").
 * - [provider]: `GetSignInWithGoogleOption`, the explicit button flow.
 *
 * The server nonce goes on every option; the ID token carries it and the Worker checks it. Errors
 * map to [PlatformIdentityResult.Cancelled] (a person dismissed the sheet) or
 * [PlatformIdentityResult.Unavailable] with a fixed reason, never the exception's text. Sign-out
 * runs `clearCredentialState()` so the next launch does not auto-select the same account.
 * The token never reaches a log or a `toString`.
 */
public class GoogleSignIn internal constructor(private val backend: CredentialBackend) : PlatformIdentity {
    public constructor() : this(CredentialManagerBackend())

    override val isSupported: Boolean get() = true
    override val kinds: Set<String> get() = setOf(PlatformIdentity.KIND_GOOGLE)

    override fun silent(context: Context, serverClientId: String, nonce: String, callback: (PlatformIdentityResult) -> Unit): Unit =
        ask(context, serverClientId, nonce, callback) {
            GetGoogleIdOption.Builder()
                .setServerClientId(serverClientId)
                .setFilterByAuthorizedAccounts(true)
                .setAutoSelectEnabled(true)
                .setNonce(nonce)
                .build()
        }

    override fun sheet(context: Context, serverClientId: String, nonce: String, callback: (PlatformIdentityResult) -> Unit): Unit =
        ask(context, serverClientId, nonce, callback) {
            GetGoogleIdOption.Builder()
                .setServerClientId(serverClientId)
                .setFilterByAuthorizedAccounts(true)
                .setAutoSelectEnabled(false)
                .setNonce(nonce)
                .build()
        }

    override fun provider(context: Context, serverClientId: String, nonce: String, callback: (PlatformIdentityResult) -> Unit): Unit =
        ask(context, serverClientId, nonce, callback) {
            GetSignInWithGoogleOption.Builder(serverClientId).setNonce(nonce).build()
        }

    override fun signOutCleanup(context: Context, callback: (Boolean) -> Unit) {
        backend.clear(context) { callback(it.isSuccess) }
    }

    private fun ask(
        context: Context,
        serverClientId: String,
        nonce: String,
        callback: (PlatformIdentityResult) -> Unit,
        option: () -> androidx.credentials.CredentialOption,
    ) {
        if (PlatformIdentity.refusal(serverClientId, nonce) != null) {
            callback(PlatformIdentityResult.Unavailable(PlatformIdentity.REASON_REFUSED))
            return
        }
        val request = try {
            GetCredentialRequest.Builder().addCredentialOption(option()).build()
        } catch (e: Exception) {
            callback(PlatformIdentityResult.Unavailable(PlatformIdentity.REASON_REFUSED))
            return
        }
        backend.get(context, request) { r -> callback(r.fold({ token(it) }, { failure(it) })) }
    }

    private fun token(response: GetCredentialResponse): PlatformIdentityResult {
        val credential = response.credential
        if (credential !is CustomCredential || credential.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
            return PlatformIdentityResult.Unavailable(PlatformIdentity.REASON_BAD_CREDENTIAL)
        }
        return try {
            val id = GoogleIdTokenCredential.createFrom(credential.data)
            PlatformIdentityResult.Success(PlatformIdentityToken(PlatformIdentity.KIND_GOOGLE, id.idToken))
        } catch (e: GoogleIdTokenParsingException) {
            PlatformIdentityResult.Unavailable(PlatformIdentity.REASON_BAD_CREDENTIAL)
        }
    }

    private fun failure(e: Throwable): PlatformIdentityResult = when (e) {
        is GetCredentialCancellationException -> PlatformIdentityResult.Cancelled
        is NoCredentialException -> PlatformIdentityResult.Unavailable(PlatformIdentity.REASON_NO_CREDENTIAL)
        is GetCredentialProviderConfigurationException -> PlatformIdentityResult.Unavailable(PlatformIdentity.REASON_NO_PLAY_SERVICES)
        is GetCredentialUnsupportedException -> PlatformIdentityResult.Unavailable(PlatformIdentity.REASON_UNSUPPORTED)
        is GetCredentialInterruptedException -> PlatformIdentityResult.Unavailable(PlatformIdentity.REASON_INTERRUPTED)
        else -> PlatformIdentityResult.Unavailable(PlatformIdentity.REASON_FAILED)
    }
}
