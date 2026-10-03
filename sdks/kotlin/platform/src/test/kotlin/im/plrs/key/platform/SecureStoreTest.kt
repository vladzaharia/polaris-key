package im.plrs.key.platform

import android.security.keystore.KeyPermanentlyInvalidatedException
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File
import java.security.AlgorithmParameters
import java.security.Key
import java.security.SecureRandom
import java.security.spec.AlgorithmParameterSpec
import javax.crypto.Cipher
import javax.crypto.CipherSpi
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/** A software AES key store standing in for AndroidKeyStore (which Robolectric does not provide). */
class FakeKeyProvider : KeyProvider {
    val keys = mutableMapOf<String, SecretKey>()
    var created = 0

    override fun get(alias: String): SecretKey? = keys[alias]

    override fun create(alias: String): SecretKey {
        created++
        return KeyGenerator.getInstance("AES").apply { init(256) }.generateKey().also { keys[alias] = it }
    }

    override fun delete(alias: String) {
        keys.remove(alias)
    }

    override fun describe(alias: String): JSONObject = JSONObject().put("backend", "fake").put("exists", keys.containsKey(alias))
}

/** A Cipher whose init throws KeyPermanentlyInvalidatedException, as AndroidKeyStore does after a lock-screen reset. */
class InvalidatedCipher : Cipher(
    object : CipherSpi() {
        override fun engineSetMode(mode: String?) {}
        override fun engineSetPadding(padding: String?) {}
        override fun engineGetBlockSize() = 16
        override fun engineGetOutputSize(inputLen: Int) = inputLen
        override fun engineGetIV(): ByteArray? = null
        override fun engineGetParameters(): AlgorithmParameters? = null
        override fun engineInit(opmode: Int, key: Key?, random: SecureRandom?): Unit = throw KeyPermanentlyInvalidatedException()
        override fun engineInit(opmode: Int, key: Key?, params: AlgorithmParameterSpec?, random: SecureRandom?): Unit = throw KeyPermanentlyInvalidatedException()
        override fun engineInit(opmode: Int, key: Key?, params: AlgorithmParameters?, random: SecureRandom?): Unit = throw KeyPermanentlyInvalidatedException()
        override fun engineUpdate(input: ByteArray?, inputOffset: Int, inputLen: Int): ByteArray? = null
        override fun engineUpdate(input: ByteArray?, inputOffset: Int, inputLen: Int, output: ByteArray?, outputOffset: Int) = 0
        override fun engineDoFinal(input: ByteArray?, inputOffset: Int, inputLen: Int): ByteArray? = null
        override fun engineDoFinal(input: ByteArray?, inputOffset: Int, inputLen: Int, output: ByteArray?, outputOffset: Int) = 0
    },
    null,
    "AES/GCM/NoPadding",
)

@RunWith(RobolectricTestRunner::class)
class SecureStoreTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private fun store(keys: FakeKeyProvider = FakeKeyProvider(), product: String = "diceroll", dir: File = tmp.root) =
        SecureStore(dir, product, keys)

    @Test
    fun roundTripsAndDeletes() {
        val s = store()
        assertNull(s.get("token").value)
        s.put("token", "pkeyt_abc")
        assertEquals(SecureStore.Read("pkeyt_abc"), s.get("token"))
        s.put("token", "pkeyt_def")
        assertEquals("pkeyt_def", s.get("token").value)
        assertTrue(s.delete("token"))
        assertFalse(s.delete("token"))
        assertNull(s.get("token").value)
    }

    @Test
    fun blobIsVersionedAndNeverPlaintext() {
        val s = store()
        s.put("token", "pkeyt_secret")
        val blob = File(tmp.root, "token.kv").readBytes()
        assertEquals(1, blob[0].toInt())
        assertEquals(1 + 12 + "pkeyt_secret".length + 16, blob.size)
        assertFalse(String(blob, Charsets.ISO_8859_1).contains("pkeyt_secret"))
        // A fresh IV per write.
        s.put("token", "pkeyt_secret")
        assertFalse(blob.contentEquals(File(tmp.root, "token.kv").readBytes()))
    }

    @Test
    fun aadBindsBlobToItsSlot() {
        val s = store()
        s.put("token", "pkeyt_abc")
        File(tmp.root, "token.kv").copyTo(File(tmp.root, "device.kv"))
        try {
            s.get("device")
            fail("a blob moved to another account must not decrypt")
        } catch (e: SecureStoreException) {
            assertEquals("corrupt", e.reason)
        }
    }

    @Test
    fun anotherProductCannotReadTheBlob() {
        val keys = FakeKeyProvider()
        val a = store(keys, "alpha", File(tmp.root, "a"))
        a.put("token", "pkeyt_abc")
        val b = store(keys, "beta", File(tmp.root, "b"))
        // Same key material under b's alias, the blob copied over: the AAD still refuses it.
        keys.keys[b.alias] = keys.keys[a.alias]!!
        File(tmp.root, "b").mkdirs()
        File(tmp.root, "a/token.kv").copyTo(File(tmp.root, "b/token.kv"))
        try {
            b.get("token")
            fail("a blob from another product must not decrypt")
        } catch (e: SecureStoreException) {
            assertEquals("corrupt", e.reason)
        }
    }

    @Test
    fun aliasIsPerProduct() {
        assertEquals("pkey:diceroll:device", store().alias)
    }

    @Test
    fun missingKeyDropsBlobsAndReportsReset() {
        val keys = FakeKeyProvider()
        val s = store(keys)
        s.put("token", "pkeyt_abc")
        s.put("device", "dev-1")
        keys.keys.clear()
        assertEquals(SecureStore.Read(null, SecureStore.RESET_MISSING), s.get("token"))
        assertFalse(File(tmp.root, "token.kv").exists())
        assertFalse(File(tmp.root, "device.kv").exists())
        assertNull(s.get("device").value)
    }

    @Test
    fun invalidatedKeyIsDeletedWithItsBlobs() {
        val keys = FakeKeyProvider()
        val s = store(keys)
        s.put("token", "pkeyt_abc")
        s.newCipher = { InvalidatedCipher() }
        assertEquals(SecureStore.Read(null, SecureStore.RESET_INVALIDATED), s.get("token"))
        assertTrue(keys.keys.isEmpty())
        assertFalse(File(tmp.root, "token.kv").exists())
    }

    @Test
    fun putRecreatesAnInvalidatedKeyOnce() {
        val keys = FakeKeyProvider()
        val s = store(keys)
        s.put("token", "old")
        var calls = 0
        s.newCipher = { if (calls++ == 0) InvalidatedCipher() else Cipher.getInstance("AES/GCM/NoPadding") }
        s.put("token", "new")
        assertEquals(2, keys.created)
        s.newCipher = { Cipher.getInstance("AES/GCM/NoPadding") }
        assertEquals("new", s.get("token").value)
    }

    @Test
    fun putWithANewKeyWipesUnreadableBlobs() {
        val keys = FakeKeyProvider()
        val s = store(keys)
        s.put("device", "dev-1")
        keys.keys.clear()
        s.put("token", "pkeyt_abc")
        assertFalse(File(tmp.root, "device.kv").exists())
        assertEquals("pkeyt_abc", s.get("token").value)
    }

    @Test
    fun corruptBlobIsSurfacedNotSwallowed() {
        val s = store()
        File(tmp.root, "token.kv").writeBytes(byteArrayOf(2, 0, 0))
        try {
            s.get("token")
            fail("a short or unknown-version blob is corrupt")
        } catch (e: SecureStoreException) {
            assertEquals("corrupt", e.reason)
        }
        s.put("token", "pkeyt_abc")
        val blob = File(tmp.root, "token.kv").readBytes()
        blob[blob.size - 1] = (blob[blob.size - 1].toInt() xor 1).toByte()
        File(tmp.root, "token.kv").writeBytes(blob)
        try {
            s.get("token")
            fail("a flipped tag bit is corrupt")
        } catch (e: SecureStoreException) {
            assertEquals("corrupt", e.reason)
        }
    }

    @Test
    fun namesCannotEscapeTheDirectory() {
        for (bad in listOf("../x", "a/b", "", ".hidden", "a..b", "x".repeat(129), "tab\t")) {
            try {
                store().put(bad, "v")
                fail("account \"$bad\" must be refused")
            } catch (e: SecureStoreException) {
                assertEquals("invalid-name", e.reason)
            }
        }
        try {
            SecureStore(tmp.root, "../evil", FakeKeyProvider())
            fail("a product with a separator must be refused")
        } catch (e: SecureStoreException) {
            assertEquals("invalid-name", e.reason)
        }
    }

    @Test
    fun noTempFileIsLeftBehind() {
        val s = store()
        s.put("token", "pkeyt_abc")
        assertArrayEquals(arrayOf("token.kv"), tmp.root.list()!!.sortedArray())
    }

    @Test
    fun infoNamesTheAlias() {
        val keys = FakeKeyProvider()
        val s = store(keys)
        s.put("token", "x")
        val info = s.info()
        assertEquals("pkey:diceroll:device", info.getString("alias"))
        assertTrue(info.getBoolean("exists"))
    }
}
