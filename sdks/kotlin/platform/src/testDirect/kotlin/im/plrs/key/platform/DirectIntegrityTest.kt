package im.plrs.key.platform

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** The direct flavour cannot attest: every Integrity call is Unsupported("outlet"), with any arguments. */
@RunWith(RobolectricTestRunner::class)
class DirectIntegrityTest {
    private val integrity = PlatformIntegrity.create(ApplicationProvider.getApplicationContext())

    @Test
    fun directIntegrityIsUnsupportedForTheOutlet() {
        assertFalse(integrity.isSupported)
        val outlet = IntegrityResult.Unsupported(PlatformIntegrity.REASON_OUTLET)
        val seen = mutableListOf<IntegrityResult<*>>()
        integrity.prepare(123456789012L) { seen += it }
        integrity.prepare(0) { seen += it }
        integrity.request(123456789012L, "h") { seen += it }
        integrity.request(-1, "") { seen += it }
        integrity.request(1, "a".repeat(501)) { seen += it }
        assertEquals(List(5) { outlet }, seen)
    }

    @Test
    fun directBuildHasNoPlayIntegrityClass() {
        val found = runCatching { Class.forName("im.plrs.key.platform.play.PlayIntegrity") }.isSuccess
        assertFalse(found)
        assertFalse(runCatching { Class.forName("com.google.android.play.core.integrity.IntegrityManagerFactory") }.isSuccess)
    }
}
