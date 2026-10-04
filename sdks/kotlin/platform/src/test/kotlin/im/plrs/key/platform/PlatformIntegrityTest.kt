package im.plrs.key.platform

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** The flavour-neutral Integrity surface, run in both flavours: argument refusals and the Unsupported Integrity. */
@RunWith(RobolectricTestRunner::class)
class PlatformIntegrityTest {
    private fun <T> await(call: ((IntegrityResult<T>) -> Unit) -> Unit): IntegrityResult<T> {
        var out: IntegrityResult<T>? = null
        call { out = it }
        return out!!
    }

    @Test
    fun refusalAcceptsPositiveProjectsAndHashesUpTo500Characters() {
        assertNull(PlatformIntegrity.refusal(1, "h"))
        assertNull(PlatformIntegrity.refusal(123456789012L, "a".repeat(500)))
        assertNull(PlatformIntegrity.refusal(7, null))
    }

    @Test
    fun refusalNamesEveryBadArgument() {
        assertEquals("cloudProjectNumber must be positive", PlatformIntegrity.refusal(0, "h"))
        assertEquals("cloudProjectNumber must be positive", PlatformIntegrity.refusal(-5, null))
        assertEquals("requestHash must be 1..500 characters", PlatformIntegrity.refusal(1, ""))
        assertEquals("requestHash must be 1..500 characters", PlatformIntegrity.refusal(1, "a".repeat(501)))
        // The project is checked first.
        assertEquals("cloudProjectNumber must be positive", PlatformIntegrity.refusal(0, ""))
    }

    @Test
    fun unsupportedAnswersEveryCallWithItsReason() {
        val i = PlatformIntegrity.unsupported()
        assertFalse(i.isSupported)
        assertEquals(IntegrityResult.Unsupported("outlet"), await<Boolean> { i.prepare(1, it) })
        assertEquals(IntegrityResult.Unsupported("outlet"), await<PlatformIntegrityToken> { i.request(1, "h", it) })
        // Unsupported wins over a refusal: the build cannot attest whatever the arguments.
        assertEquals(IntegrityResult.Unsupported("outlet"), await<PlatformIntegrityToken> { i.request(0, "", it) })
        val r = PlatformIntegrity.unsupported("runtime")
        assertEquals(IntegrityResult.Unsupported("runtime"), await<Boolean> { r.prepare(1, it) })
    }

    @Test
    fun createMatchesTheFlavour() {
        val i = PlatformIntegrity.create(ApplicationProvider.getApplicationContext())
        assertEquals(PolarisKeyPlatform.isPlay, i.isSupported)
    }
}
