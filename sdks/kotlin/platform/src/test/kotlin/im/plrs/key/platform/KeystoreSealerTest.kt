package im.plrs.key.platform

import javax.crypto.Cipher
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** CC-26.5: the Keystore AES-GCM wrapper of the device keys' record. */
@RunWith(RobolectricTestRunner::class)
class KeystoreSealerTest {
    private val keys = FakeKeyProvider()
    private val alias = KeystoreSealer.aliasFor("diceroll")
    private val ctx = "pkey-device-keys/1/diceroll".toByteArray()
    private val secret = "raw 25519 key bytes, never in the clear".toByteArray()

    @Test
    fun sealsAndOpensAndHoldsNoPlaintext() {
        val s = KeystoreSealer(keys, alias)
        val blob = s.seal(secret, ctx)
        assertEquals(1, blob[0].toInt())
        assertFalse(String(blob, Charsets.ISO_8859_1).contains("25519"))
        assertArrayEquals(secret, s.open(blob, ctx))
        assertEquals(1, keys.created)
        // A second seal reuses the key; each blob has its own IV.
        assertFalse(s.seal(secret, ctx).contentEquals(blob))
        assertEquals(1, keys.created)
    }

    @Test
    fun aBlobIsBoundToItsContextAndRefusesTampering() {
        val s = KeystoreSealer(keys, alias)
        val blob = s.seal(secret, ctx)
        assertNull(s.open(blob, "pkey-device-keys/1/other".toByteArray()))
        val flipped = blob.copyOf().also { it[it.size - 1] = (it[it.size - 1].toInt() xor 1).toByte() }
        assertNull(s.open(flipped, ctx))
        assertNull(s.open(ByteArray(3), ctx))
        assertNull(s.open(byteArrayOf(2) + blob.copyOfRange(1, blob.size), ctx))
    }

    @Test
    fun aDestroyedOrMissingKeyMakesTheBlobUnreadableForGood() {
        val s = KeystoreSealer(keys, alias)
        val blob = s.seal(secret, ctx)
        s.destroy()
        assertTrue(keys.keys.isEmpty())
        assertNull(s.open(blob, ctx))
        // Sealing again makes a new key, which cannot open the old blob.
        s.seal(secret, ctx)
        assertNotNull(keys.keys[alias])
        assertNull(s.open(blob, ctx))
    }

    @Test
    fun aPermanentlyInvalidatedKeyIsRemovedAndSealRetriesOnce() {
        val s = KeystoreSealer(keys, alias)
        val blob = s.seal(secret, ctx)
        s.newCipher = { InvalidatedCipher() }
        assertNull(s.open(blob, ctx))
        assertTrue(keys.keys.isEmpty())
        var calls = 0
        s.newCipher = { if (calls++ == 0) InvalidatedCipher() else Cipher.getInstance("AES/GCM/NoPadding") }
        val again = s.seal(secret, ctx)
        s.newCipher = { Cipher.getInstance("AES/GCM/NoPadding") }
        assertArrayEquals(secret, s.open(again, ctx))
    }

    @Test
    fun aKeystoreFaultThrowsInsteadOfReadingAsGone() {
        val s = KeystoreSealer(keys, alias)
        val blob = s.seal(secret, ctx)
        val broken = object : KeyProvider by keys {
            override fun get(alias: String): javax.crypto.SecretKey? = throw java.security.ProviderException("keymaster busy")
        }
        try {
            KeystoreSealer(broken, alias).open(blob, ctx)
            fail("a provider fault must not read as a lost key")
        } catch (e: SecureStoreException) {
            assertEquals("keystore-provider", e.reason)
        }
    }

    @Test
    fun aPresentAliasThatWillNotLoadThrowsAndNeverGetsANewKey() {
        val s = KeystoreSealer(keys, alias)
        val blob = s.seal(secret, ctx)
        val created = keys.created
        val flaky = object : KeyProvider by keys {
            override fun get(alias: String): javax.crypto.SecretKey? = null
            override fun exists(alias: String): Boolean = true
        }
        val f = KeystoreSealer(flaky, alias)
        try {
            f.open(blob, ctx)
            fail("ambiguous answer must throw")
        } catch (e: SecureStoreException) {
        }
        try {
            f.seal(secret, ctx)
            fail("must not create over a present alias")
        } catch (e: SecureStoreException) {
        }
        assertEquals(created, keys.created)
        assertArrayEquals(secret, s.open(blob, ctx))
    }
}
