package im.plrs.key.android

import im.plrs.key.core.Base64Url
import im.plrs.key.core.DeviceProofPurpose
import im.plrs.key.core.DeviceProofs
import im.plrs.key.core.DeviceKeyPersistence
import im.plrs.key.core.DeviceKeyStore
import im.plrs.key.core.FileDeviceKeyStorage
import im.plrs.key.core.StoreException
import im.plrs.key.platform.KeystoreSealer
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** CC-26.5: the device keys on Android, over a software stand-in for the Keystore. */
@RunWith(RobolectricTestRunner::class)
class AndroidDeviceKeysTest {
    @get:Rule val tmp = TemporaryFolder()

    private val keys = SoftKeyProvider()
    private val product = "diceroll"
    private val device = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
    private val file get() = File(tmp.root, "pkey/$product/device-keys.bin")

    private fun store(provider: SoftKeyProvider = keys) = DeviceKeyStore(
        FileDeviceKeyStorage(
            file,
            AndroidDeviceKeySealer(KeystoreSealer(provider, KeystoreSealer.aliasFor(product))),
            "pkey-device-keys/1/$product".toByteArray(),
        ),
    )

    @Test
    fun keysSurviveARestartAndTheFileHoldsNoKey() = runBlocking {
        val a = store().ensure()
        assertEquals(a, store().publicKeys())
        assertEquals(DeviceKeyPersistence.durable, store().persistence())
        val text = file.readBytes().toString(Charsets.ISO_8859_1)
        assertFalse(text.contains("seed"))
        assertFalse(text.contains(a.signKey))
        assertNotNull(keys.keys[KeystoreSealer.aliasFor(product)])
    }

    @Test
    fun signsEveryPurposeAndBuildsTheKeysRequest() = runBlocking {
        val s = store()
        for (p in DeviceProofPurpose.entries.filter { it != DeviceProofPurpose.keys }) {
            assertTrue(DeviceProofs.verify(DeviceProofs.sign(s, p, product, device, "v")))
        }
        val (path, body) = DeviceProofs.buildDeviceKeysRequest(s, product, device)
        assertEquals("/$product/devices/keys", path)
        assertEquals(s.publicKeys()!!.signKey, body.signKey)
        assertEquals(64, Base64Url.decodeStrict(body.sig)!!.size)
    }

    @Test
    fun wipeRemovesTheFileAndTheWrappingKey() = runBlocking {
        val s = store()
        val a = s.ensure()
        s.wipe()
        assertFalse(file.exists())
        assertTrue(keys.keys.isEmpty())
        assertNull(s.publicKeys())
        assertNotEquals(a.signKey, s.ensure().signKey)
    }

    @Test
    fun aLostWrappingKeyLeavesAnUnusablePairThatEnsureReplaces() = runBlocking {
        val a = store().ensure()
        keys.keys.clear()
        assertNull(store().publicKeys())
        assertNotEquals(a.signKey, store().ensure().signKey)
    }

    @Test
    fun aKeystoreFaultSurfacesAndNeverReplacesTheKeys() = runBlocking {
        val s = store()
        val a = s.ensure()
        keys.broken = true
        try {
            store().publicKeys()
            fail("a Keystore fault must surface")
        } catch (e: StoreException) {
            // expected
        }
        try {
            store().ensure()
            fail("a Keystore fault must not make new keys")
        } catch (e: StoreException) {
        }
        keys.broken = false
        assertEquals(a, store().publicKeys())
    }
}
