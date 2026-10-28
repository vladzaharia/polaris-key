package im.plrs.key.godot

import android.util.Base64
import im.plrs.key.platform.KeyProvider
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/** The Godot device key store's sealer ops (CC-26.7) over a software KeyProvider (Robolectric has no AndroidKeyStore). */
@RunWith(RobolectricTestRunner::class)
class SealerCommandsTest {
    private class Keys : KeyProvider {
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

        override fun describe(alias: String): JSONObject = JSONObject()
    }

    private val keys = Keys()
    private val c = Commands(TestHost(), keyProvider = { keys })
    private val plain = ByteArray(141) { it.toByte() }
    private val ctx = "pkey-device-keys/1/diceroll".toByteArray()

    private fun b64(b: ByteArray) = Base64.encodeToString(b, Base64.NO_WRAP)

    private fun op(name: String, vararg kv: Pair<String, String>): JSONObject =
        c.json(JSONObject().put("op", name).also { o -> kv.forEach { o.put(it.first, it.second) } })

    private fun seal(product: String = "diceroll") =
        op("ks_seal", "product" to product, "context" to b64(ctx), "plain" to b64(plain))

    @Test
    fun sealsAndOpensWithoutPlaintextInTheBlob() {
        val r = seal()
        assertTrue(r.getBoolean("ok"))
        val blob = Base64.decode(r.getString("blob"), Base64.NO_WRAP)
        assertEquals(1, blob[0].toInt())
        val open = op("ks_open", "product" to "diceroll", "context" to b64(ctx), "blob" to r.getString("blob"))
        assertEquals(b64(plain), open.getString("plain"))
        assertEquals(setOf("pkey:diceroll:devicekeys"), keys.keys.keys)
    }

    @Test
    fun aLostKeyOrAnotherContextIsUnopenableNotAFault() {
        val blob = seal().getString("blob")
        val wrong = op("ks_open", "product" to "diceroll", "context" to b64("other".toByteArray()), "blob" to blob)
        assertFalse(wrong.getBoolean("ok"))
        assertEquals("unopenable", wrong.getString("error"))
        assertTrue(op("ks_destroy", "product" to "diceroll").getBoolean("ok"))
        val gone = op("ks_open", "product" to "diceroll", "context" to b64(ctx), "blob" to blob)
        assertEquals("unopenable", gone.getString("error"))
        assertEquals("open never created a key", 1, keys.created)
    }

    @Test
    fun aKeystoreFaultIsAnErrorNeverUnopenable() {
        val blob = seal().getString("blob")
        val broken = Commands(TestHost(), keyProvider = {
            object : KeyProvider by keys {
                override fun get(alias: String): SecretKey? = throw java.security.ProviderException("boom")
            }
        })
        val r = broken.json(
            JSONObject().put("op", "ks_open").put("product", "diceroll").put("context", b64(ctx)).put("blob", blob),
        )
        assertFalse(r.getBoolean("ok"))
        assertEquals("keystore", r.getString("error"))
        assertEquals("keystore-provider", r.getString("reason"))
    }

    @Test
    fun productsAreBoundAndInputsChecked() {
        seal("diceroll")
        seal("other")
        assertEquals(setOf("pkey:diceroll:devicekeys", "pkey:other:devicekeys"), keys.keys.keys)
        assertEquals("invalid-name", seal("../x").getString("reason"))
        // android.util.Base64 skips stray characters ("!!" decodes to nothing); one lone sextet is its malformed input.
        assertEquals("bad_input", op("ks_seal", "product" to "diceroll", "context" to "A", "plain" to "A").getString("error"))
    }
}

/** The no-backup directory the GDScript stores root their sensitive files in (GODOT-BACKUP-EXCL). */
@RunWith(RobolectricTestRunner::class)
class NoBackupDirTest {
    @Test
    fun answersTheNoBackupFilesDir() {
        val host = TestHost()
        val r = Commands(host).json(JSONObject().put("op", "no_backup_dir"))
        assertTrue(r.getBoolean("ok"))
        val path = r.getString("path")
        assertEquals(host.appContext.noBackupFilesDir.absolutePath, path)
        assertTrue(java.io.File(path).isDirectory)
    }
}
