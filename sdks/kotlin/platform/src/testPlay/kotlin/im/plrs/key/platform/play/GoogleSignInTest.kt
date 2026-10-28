package im.plrs.key.platform.play

import android.content.Context
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialCustomException
import androidx.credentials.exceptions.GetCredentialInterruptedException
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException
import androidx.credentials.exceptions.GetCredentialUnsupportedException
import androidx.credentials.exceptions.NoCredentialException
import androidx.test.core.app.ApplicationProvider
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import im.plrs.key.platform.PlatformIdentity
import im.plrs.key.platform.PlatformIdentityResult
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * [GoogleSignIn] over a fake Credential Manager: the nonce on both option types, the option flags of
 * each rung, the error mapping, `clearCredentialState()` on sign-out and the token's redaction.
 */
@RunWith(RobolectricTestRunner::class)
class GoogleSignInTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val clientId = "web-client.apps.googleusercontent.com"
    private val nonce = "server-nonce-1"

    // The googleid builder decodes the JWT payload, so the fake is a well-formed (unsigned) JWT.
    private val secretToken: String = run {
        fun b64(s: String) = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(s.toByteArray())
        b64("""{"alg":"none"}""") + "." + b64("""{"sub":"SECRET-SUB","email":"a@example.com"}""") + ".SECRET-SIG"
    }

    private class Fake : CredentialBackend {
        val requests = mutableListOf<GetCredentialRequest>()
        var clears = 0
        var response: Result<GetCredentialResponse>? = null
        var clearResult: Result<Unit> = Result.success(Unit)

        override fun get(context: Context, request: GetCredentialRequest, callback: (Result<GetCredentialResponse>) -> Unit) {
            requests += request
            callback(response!!)
        }

        override fun clear(context: Context, callback: (Result<Unit>) -> Unit) {
            clears++
            callback(clearResult)
        }
    }

    private fun googleResponse(token: String = secretToken): Result<GetCredentialResponse> {
        val data = GoogleIdTokenCredential.Builder().setId("a@example.com").setIdToken(token).build().data
        return Result.success(GetCredentialResponse(CustomCredential(GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL, data)))
    }

    private fun call(f: (GoogleSignIn, (PlatformIdentityResult) -> Unit) -> Unit, fake: Fake): PlatformIdentityResult {
        var out: PlatformIdentityResult? = null
        f(GoogleSignIn(fake)) { out = it }
        return out!!
    }

    @Test
    fun silentUsesTheAuthorisedAutoSelectOptionWithTheNonce() {
        val fake = Fake().apply { response = googleResponse() }
        val r = call({ g, cb -> g.silent(context, clientId, nonce, cb) }, fake)
        val option = fake.requests.single().credentialOptions.single() as GetGoogleIdOption
        assertEquals(nonce, option.nonce)
        assertEquals(clientId, option.serverClientId)
        assertTrue(option.filterByAuthorizedAccounts)
        assertTrue(option.autoSelectEnabled)
        assertEquals(secretToken, (r as PlatformIdentityResult.Success).token.reveal())
        assertEquals("google", r.token.kind)
    }

    @Test
    fun sheetListsTheAuthorisedAccountsWithTheNonce() {
        val fake = Fake().apply { response = googleResponse() }
        call({ g, cb -> g.sheet(context, clientId, nonce, cb) }, fake)
        val option = fake.requests.single().credentialOptions.single() as GetGoogleIdOption
        assertEquals(nonce, option.nonce)
        // The plan's rung 4 is the rung 3 call with auto-select off: the authorised accounts, always a sheet.
        assertTrue(option.filterByAuthorizedAccounts)
        assertFalse(option.autoSelectEnabled)
    }

    @Test
    fun providerRowUsesSignInWithGoogleWithTheNonce() {
        val fake = Fake().apply { response = googleResponse() }
        call({ g, cb -> g.provider(context, clientId, nonce, cb) }, fake)
        val option = fake.requests.single().credentialOptions.single() as GetSignInWithGoogleOption
        assertEquals(nonce, option.nonce)
        assertEquals(clientId, option.serverClientId)
    }

    @Test
    fun anEmptyNonceOrClientIdIsRefusedBeforeTheOsIsAsked() {
        val fake = Fake().apply { response = googleResponse() }
        val a = call({ g, cb -> g.silent(context, clientId, "", cb) }, fake)
        val b = call({ g, cb -> g.provider(context, " ", nonce, cb) }, fake)
        assertEquals(PlatformIdentityResult.Unavailable(PlatformIdentity.REASON_REFUSED), a)
        assertEquals(PlatformIdentityResult.Unavailable(PlatformIdentity.REASON_REFUSED), b)
        assertTrue(fake.requests.isEmpty())
    }

    @Test
    fun errorsMapToUnavailableOrCancelled() {
        fun map(e: Throwable): PlatformIdentityResult {
            val fake = Fake().apply { response = Result.failure(e) }
            return call({ g, cb -> g.sheet(context, clientId, nonce, cb) }, fake)
        }
        assertEquals(PlatformIdentityResult.Cancelled, map(GetCredentialCancellationException()))
        assertEquals(PlatformIdentityResult.CODE_CANCELLED, PlatformIdentityResult.Cancelled.code)
        val cases = mapOf(
            NoCredentialException() to PlatformIdentity.REASON_NO_CREDENTIAL,
            GetCredentialProviderConfigurationException() to PlatformIdentity.REASON_NO_PLAY_SERVICES,
            GetCredentialUnsupportedException() to PlatformIdentity.REASON_UNSUPPORTED,
            GetCredentialInterruptedException() to PlatformIdentity.REASON_INTERRUPTED,
            GetCredentialCustomException("x", "y") to PlatformIdentity.REASON_FAILED,
        )
        for ((e, reason) in cases) {
            val r = map(e)
            assertEquals(PlatformIdentityResult.Unavailable(reason), r)
            assertEquals("platform-identity-unavailable", r.code)
        }
        assertEquals(PlatformIdentityResult.Unavailable(PlatformIdentity.REASON_FAILED), map(IllegalStateException("boom")))
    }

    @Test
    fun aForeignCredentialIsUnavailable() {
        val fake = Fake().apply {
            response = Result.success(GetCredentialResponse(CustomCredential("other.type", android.os.Bundle())))
        }
        val r = call({ g, cb -> g.sheet(context, clientId, nonce, cb) }, fake)
        assertEquals(PlatformIdentityResult.Unavailable(PlatformIdentity.REASON_BAD_CREDENTIAL), r)
    }

    @Test
    fun signOutClearsTheCredentialState() {
        val fake = Fake()
        var cleared: Boolean? = null
        GoogleSignIn(fake).signOutCleanup(context) { cleared = it }
        assertEquals(1, fake.clears)
        assertEquals(true, cleared)
        fake.clearResult = Result.failure(IllegalStateException("no"))
        GoogleSignIn(fake).signOutCleanup(context) { cleared = it }
        assertEquals(false, cleared)
    }

    @Test
    fun theTokenNeverReachesToString() {
        val fake = Fake().apply { response = googleResponse() }
        val r = call({ g, cb -> g.silent(context, clientId, nonce, cb) }, fake) as PlatformIdentityResult.Success
        assertFalse(r.toString().contains("SECRET"))
        assertFalse(r.token.toString().contains("SECRET"))
        assertNull(PlatformIdentityResult.Cancelled.code?.takeIf { it != "cancelled" })
        assertNotNull(r.token.reveal())
    }

    @Test
    fun flavourReportsGoogle() {
        val id = PlatformIdentity.create()
        assertTrue(id.isSupported)
        assertEquals(setOf("google"), id.kinds)
    }
}
