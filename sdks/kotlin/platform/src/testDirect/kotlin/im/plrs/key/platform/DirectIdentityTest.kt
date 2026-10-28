package im.plrs.key.platform

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** The `direct` flavour answers Unavailable("outlet") on every rung and holds no Credential Manager class. */
@RunWith(RobolectricTestRunner::class)
class DirectIdentityTest {
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

    @Test
    fun everyCallIsUnavailableWithTheOutletReason() {
        val id = PlatformIdentity.create()
        assertFalse(id.isSupported)
        assertTrue(id.kinds.isEmpty())
        val seen = mutableListOf<PlatformIdentityResult>()
        id.silent(context, "c", "n") { seen += it }
        id.sheet(context, "c", "n") { seen += it }
        id.provider(context, "c", "n") { seen += it }
        assertEquals(3, seen.size)
        for (r in seen) {
            assertEquals(PlatformIdentityResult.Unavailable("outlet"), r)
            assertEquals("platform-identity-unavailable", r.code)
        }
    }

    @Test
    fun noCredentialManagerClassIsOnTheClasspath() {
        assertTrue(runCatching { Class.forName("androidx.credentials.CredentialManager") }.isFailure)
    }
}
