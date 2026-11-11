// @pkey-feature connect.local
//
// The local-link record over a sealed file (the shape the Android store has: a wrapping key, the record's use bound in as
// the AAD): the links, the keys, the secret and the peer's platform come back from a reload, the file holds none of them in
// the clear, and a record sealed for another use does not open.

package im.plrs.key.sdk

import im.plrs.key.core.Base64Url
import im.plrs.key.core.DeviceKeySealer
import im.plrs.key.core.FileDeviceKeyStorage
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class ConnectLocalSealedStoreTest {
    @get:Rule val tmp = TemporaryFolder()

    /** AES-GCM under one key, the context as AAD: what the Keystore sealer does, with a software key. */
    private class AesSealer(private val key: ByteArray) : DeviceKeySealer {
        var destroyed = false

        override fun seal(plain: ByteArray, context: ByteArray): ByteArray {
            val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
            c.updateAAD(context)
            return iv + c.doFinal(plain)
        }

        override fun open(blob: ByteArray, context: ByteArray): ByteArray? = runCatching {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, blob.copyOfRange(0, 12)))
            c.updateAAD(context)
            c.doFinal(blob, 12, blob.size - 12)
        }.getOrNull()

        override fun destroy() {
            destroyed = true
        }
    }

    private val key = ByteArray(32) { it.toByte() }
    private val file: File get() = File(tmp.root, "local-links.bin")

    private fun storage(sealer: DeviceKeySealer = AesSealer(key), use: String = "pkey-connect-local-state/1/djdl") =
        FileDeviceKeyStorage(file, sealer, use.toByteArray())

    private fun bytes(seed: Int) = ByteArray(32) { (seed + it).toByte() }

    @Test
    fun aLinkAndItsPlatformSurviveAReloadAndTheFileHoldsNoSecretInTheClear() = runBlocking {
        val own = bytes(1)
        val secret = bytes(100)
        val store = LocalLinkStore("djdl") { storage() }
        val id = store.add(NewLocalLink(own, bytes(40), bytes(70), secret, "Anna", listOf("docs"), platform = "android"), 1_000L)!!

        val disk = file.readBytes()
        assertFalse(disk.toString(Charsets.ISO_8859_1).contains("Anna"))
        assertFalse(disk.toString(Charsets.ISO_8859_1).contains(Base64Url.encode(secret)))
        assertFalse(disk.toString(Charsets.ISO_8859_1).contains(LOCAL_STATE_SCHEMA))

        // A new store over the same file, as after a restart.
        val reloaded = LocalLinkStore("djdl") { storage() }.rows().single()
        assertEquals(id, reloaded.id)
        assertEquals("android", reloaded.platform)
        assertEquals("Anna", reloaded.label)
        assertEquals(listOf("docs"), reloaded.cats)
        assertEquals(1_000L, reloaded.createdAt)
        assertTrue(reloaded.reachable)
        assertArrayEquals(secret, Base64Url.decode(reloaded.secret))
        assertArrayEquals(own, Base64Url.decode(reloaded.ownKey))
        assertEquals(listOf("android"), infoOfLocal(listOf(reloaded)).map { it.platform })
    }

    @Test
    fun forgettingALinkRewritesTheSealedRecordWithoutIt() = runBlocking {
        val store = LocalLinkStore("djdl") { storage() }
        val keep = store.add(NewLocalLink(bytes(1), bytes(2), bytes(3), bytes(4), "Keep", emptyList(), platform = "macos"), 1L)!!
        val drop = store.add(NewLocalLink(bytes(11), bytes(12), bytes(13), bytes(14), "Drop", emptyList()), 1L)!!
        store.update { rows -> rows.filter { it.id != drop } }
        val after = LocalLinkStore("djdl") { storage() }.rows()
        assertEquals(listOf(keep), after.map { it.id })
        assertEquals("macos", after.single().platform)
        assertFalse(file.readBytes().toString(Charsets.ISO_8859_1).contains(Base64Url.encode(bytes(14))))
    }

    @Test
    fun clearDeletesTheFileAndDestroysTheWrappingKey() = runBlocking {
        val sealer = AesSealer(key)
        val s = storage(sealer)
        LocalLinkStore("djdl") { s }.add(NewLocalLink(bytes(1), bytes(2), bytes(3), bytes(4), null, emptyList()), 1L)
        assertTrue(file.exists())
        s.clear()
        assertFalse(file.exists())
        assertTrue(sealer.destroyed)
        assertNull(storage().get())
    }

    @Test
    fun aRecordSealedForAnotherUseIsUnreadableAndNeverReplaced() {
        runBlocking {
            LocalLinkStore("djdl") { storage(use = "pkey-connect-state/1/djdl") }
                .add(NewLocalLink(bytes(1), bytes(2), bytes(3), bytes(4), null, emptyList()), 1L)
        }
        val before = file.readBytes()
        val failure = runCatching { runBlocking { LocalLinkStore("djdl") { storage() }.rows() } }.exceptionOrNull()
        assertTrue(failure is im.plrs.key.core.PolarisException)
        assertArrayEquals(before, file.readBytes())
    }
}
