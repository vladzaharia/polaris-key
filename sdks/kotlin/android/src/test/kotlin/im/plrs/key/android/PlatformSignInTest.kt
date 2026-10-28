package im.plrs.key.android

import android.app.Activity
import android.content.Context
import im.plrs.key.platform.PlatformIdentity
import im.plrs.key.platform.PlatformIdentityResult
import im.plrs.key.platform.PlatformIdentityToken
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PlatformSignInTest {
    private class Fake : PlatformIdentity {
        val calls = mutableListOf<String>()
        override val isSupported = true
        override val kinds = setOf("google")

        override fun silent(context: Context, serverClientId: String, nonce: String, callback: (PlatformIdentityResult) -> Unit) {
            calls += "silent:$serverClientId:$nonce"
            callback(PlatformIdentityResult.Success(PlatformIdentityToken("google", "tok")))
        }

        override fun sheet(context: Context, serverClientId: String, nonce: String, callback: (PlatformIdentityResult) -> Unit) {
            calls += "sheet:$serverClientId:$nonce"
            callback(PlatformIdentityResult.Cancelled)
        }

        override fun provider(context: Context, serverClientId: String, nonce: String, callback: (PlatformIdentityResult) -> Unit) {
            calls += "provider:$serverClientId:$nonce"
            callback(PlatformIdentityResult.Unavailable("no-credential"))
        }

        override fun signOutCleanup(context: Context, callback: (Boolean) -> Unit) {
            calls += "clear"
            callback(true)
        }
    }

    private val activity: Activity = Robolectric.buildActivity(Activity::class.java).setup().get()

    @Test
    fun forwardsEachRungWithTheNonce() = runTest {
        val fake = Fake()
        val s = PlatformSignIn({ activity }, fake)
        val r = s.silent("c", "n1")
        assertEquals("tok", (r as PlatformIdentityResult.Success).token.reveal())
        assertEquals(PlatformIdentityResult.Cancelled, s.sheet("c", "n2"))
        assertEquals(PlatformIdentityResult.Unavailable("no-credential"), s.provider("c", "n3"))
        assertTrue(s.signOutCleanup())
        assertEquals(listOf("silent:c:n1", "sheet:c:n2", "provider:c:n3", "clear"), fake.calls)
    }

    @Test
    fun noActivityIsUnavailable() = runTest {
        val s = PlatformSignIn({ null }, Fake())
        assertEquals(PlatformIdentityResult.Unavailable(PlatformIdentity.REASON_NO_ACTIVITY), s.silent("c", "n"))
        assertFalse(s.signOutCleanup())
    }

    @Test
    fun signOutCleanupRunsWithTheApplicationContextWhenNoActivityIsInFront() = runTest {
        val fake = Fake()
        val s = PlatformSignIn({ null }, fake, activity.applicationContext)
        assertTrue(s.signOutCleanup())
        assertEquals(listOf("clear"), fake.calls)
    }
}
