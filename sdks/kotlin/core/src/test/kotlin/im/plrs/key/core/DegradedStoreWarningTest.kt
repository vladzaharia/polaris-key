// @pkey-feature core.store
//
// SP-50: a desktop keyring store that keeps the device token in its 0600 file (java-keyring missing,
// no reachable keyring, or a write the keyring would not verify) says so ONCE per run, never silently
// and never on every call; a healthy keyring says nothing.

package im.plrs.key.core

import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class DegradedStoreWarningTest {
    private val warnings = ArrayList<String>()
    private val original = DegradedStoreWarning.sink

    @Before
    fun capture() {
        DegradedStoreWarning.reset()
        DegradedStoreWarning.sink = { synchronized(warnings) { warnings += it } }
    }

    @After
    fun restore() {
        DegradedStoreWarning.sink = original
        DegradedStoreWarning.reset()
    }

    private fun dir() = Files.createTempDirectory("pkey-degraded").toFile().also { it.deleteOnExit() }

    @Test
    fun aStoreWithoutAKeyringWarnsOncePerRun() = runBlocking {
        val store = KeyringStore("demo", dir(), NoKeyring("java-keyring is not on the classpath"))
        store.setToken("pkeyt_one")
        store.setToken("pkeyt_two")
        assertEquals("pkeyt_two", store.getToken())
        // A second store in the same run: still one warning.
        KeyringStore("other", dir(), NoKeyring("no keyring")).setToken("pkeyt_three")
        assertEquals(1, warnings.size)
        assertTrue(warnings[0], warnings[0].contains("0600 file") && warnings[0].contains("java-keyring is not on the classpath"))
        assertTrue(warnings[0].contains("polaris-key-desktop"))
        assertTrue(DegradedStoreWarning.hasWarned)
    }

    @Test
    fun aWriteTheKeyringWillNotVerifyWarns() = runBlocking {
        val ring = FakeKeyring().apply { corruptWrites = true }
        KeyringStore("demo", dir(), ring).setToken("pkeyt_one")
        assertEquals(1, warnings.size)
        assertTrue(warnings[0], warnings[0].contains("did not verify"))
    }

    @Test
    fun aHealthyKeyringSaysNothing() = runBlocking {
        val store = KeyringStore("demo", dir(), FakeKeyring())
        store.setToken("pkeyt_one")
        assertEquals("pkeyt_one", store.getToken())
        assertTrue(warnings.isEmpty())
        assertFalse(DegradedStoreWarning.hasWarned)
    }
}
