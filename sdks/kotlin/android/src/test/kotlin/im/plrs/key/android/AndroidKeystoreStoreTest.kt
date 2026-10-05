// @pkey-feature core.store
package im.plrs.key.android

import im.plrs.key.core.CacheRecord
import im.plrs.key.core.DeviceId
import im.plrs.key.core.FileStore
import im.plrs.key.core.StoreBackend
import im.plrs.key.core.StoreDegradedReason
import im.plrs.key.core.StoreException
import im.plrs.key.platform.SecureStore
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** core.store on Android: the Keystore for the token and device id, migration, surfaced failures. */
@RunWith(RobolectricTestRunner::class)
class AndroidKeystoreStoreTest {
    @get:Rule val tmp = TemporaryFolder()

    private val keys = SoftKeyProvider()
    private val product = "diceroll"

    private fun secure() = SecureStore(File(tmp.root, "keystore"), product, keys)

    private fun store(legacy: FileStore? = null, raw: String = "android-id-1") =
        AndroidKeystoreStore(product, secure(), File(tmp.root, "pkey/$product"), { raw }, legacy)

    @Test
    fun tokenLivesInTheKeystoreNeverInAFile() = runBlocking {
        val s = store()
        assertNull(s.getToken())
        s.setToken("pkeyt_secret")
        assertEquals("pkeyt_secret", s.getToken())
        // A second instance over the same key reads it back; no file holds it in the clear.
        assertEquals("pkeyt_secret", store().getToken())
        val clear = tmp.root.walkTopDown().filter { it.isFile }.any { it.readBytes().toString(Charsets.ISO_8859_1).contains("pkeyt_secret") }
        assertFalse("the token was written in the clear", clear)
        s.clearToken()
        assertNull(s.getToken())
        assertEquals(StoreBackend.keystore, s.status().backend)
        assertNull(s.status().degraded)
    }

    @Test
    fun deviceIdIsDerivedFromTheAnchorOnceAndKept() = runBlocking {
        val s = store(raw = "a1b2c3")
        val id = s.getDeviceId()
        assertEquals(DeviceId.fromRaw(product, "a1b2c3"), id)
        // Write-once: a new raw value later does not change it, and the Keystore holds it.
        assertEquals(id, store(raw = "other").getDeviceId())
        assertEquals(id, secure().get(AndroidKeystoreStore.DEVICE).value)
        assertEquals(id, File(tmp.root, "pkey/$product/device-id").readText())
    }

    @Test
    fun migratesTokenAndDeviceIdFromALegacyFileStore() = runBlocking {
        val legacy = FileStore(product, tmp.newFolder("legacy"))
        legacy.setToken("pkeyt_old")
        val oldId = legacy.getDeviceId()
        val s = store(legacy)
        assertEquals("pkeyt_old", s.getToken())
        assertEquals("pkeyt_old", secure().get(AndroidKeystoreStore.TOKEN).value)
        assertNull("the legacy token file must be removed", legacy.getToken())
        assertFalse(File(legacy.directory, "token").exists())
        assertEquals(oldId, s.getDeviceId())
        assertEquals(oldId, secure().get(AndroidKeystoreStore.DEVICE).value)
    }

    @Test
    fun aFailedKeystoreCallIsSurfacedAndNeverDowngraded() = runBlocking {
        val s = store()
        s.setToken("pkeyt_a")
        keys.broken = true
        try {
            s.getToken()
            fail("a Keystore failure must throw")
        } catch (e: StoreException) {
            assertTrue(e.message!!.contains("keystore"))
        }
        try {
            s.setToken("pkeyt_b")
            fail("a Keystore failure must throw")
        } catch (e: StoreException) {
            // expected
        }
        val st = s.status()
        assertEquals(StoreBackend.keystore, st.backend)
        assertEquals(StoreDegradedReason.keyringError, st.degraded?.reason)
        // No token file appeared as a fallback.
        assertFalse(File(tmp.root, "pkey/$product/token").exists())
        // The device id still answers (from the derivation, kept in its file).
        val id = s.getDeviceId()
        assertEquals(DeviceId.fromRaw(product, "android-id-1"), id)
        keys.broken = false
        assertEquals("pkeyt_a", s.getToken())
        assertNull("a successful Keystore call clears the degraded state", s.status().degraded)
    }

    @Test
    fun aLostKeyDropsTheTokenAndKeepsTheDeviceId() = runBlocking {
        val s = store()
        s.setToken("pkeyt_a")
        val id = s.getDeviceId()
        keys.keys.clear()
        val fresh = store(raw = "something-else")
        assertNull(fresh.getToken())
        assertEquals(SecureStore.RESET_MISSING, fresh.lastReset)
        assertEquals("the device id comes back from its file", id, fresh.getDeviceId())
        assertNull(fresh.status().degraded)
    }

    @Test
    fun cacheRoundTripsThroughAFile() = runBlocking {
        val s = store()
        assertNull(s.readCache())
        val record = CacheRecord(trustJws = "a.b.c", feeds = mapOf("stable" to "x.y.z"))
        s.writeCache(record)
        val back = s.readCache()
        assertNotNull(back)
        assertEquals("a.b.c", back!!.trustJws)
        assertEquals(mapOf("stable" to "x.y.z"), back.feeds)
        File(tmp.root, "pkey/$product/cache.json").writeText("{not json")
        assertNull("an unparseable cache is no cache", s.readCache())
        s.clearCache()
        assertNull(s.readCache())
    }
}
