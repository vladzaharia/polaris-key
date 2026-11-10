package im.plrs.key.godot

import android.util.Base64
import im.plrs.key.platform.PlatformBackup
import im.plrs.key.platform.PlatformBackupRead
import im.plrs.key.platform.PlatformBackupWrite
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** A [PlatformBackup] over a map, with a switch for each failure. */
private class FakeBackup(var supported: Boolean = true, var cloud: Boolean = true) : PlatformBackup {
    val items = HashMap<String, ByteArray>()
    var unavailable: String? = null
    var refused: String? = null
    val keys = mutableListOf<String>()

    override val isSupported: Boolean get() = supported

    override fun cloudBackup(callback: (Boolean) -> Unit) = callback(cloud)

    override fun get(key: String, callback: (PlatformBackupRead) -> Unit) {
        keys += key
        callback(
            unavailable?.let { PlatformBackupRead.Unavailable(it) } ?: refused?.let { PlatformBackupRead.Refused(it) }
                ?: items[key]?.let { PlatformBackupRead.Found(it) } ?: PlatformBackupRead.Missing,
        )
    }

    override fun set(key: String, bytes: ByteArray, callback: (PlatformBackupWrite) -> Unit) {
        keys += key
        callback(
            unavailable?.let { PlatformBackupWrite.Unavailable(it) } ?: refused?.let { PlatformBackupWrite.Refused(it) }
                ?: run {
                    items[key] = bytes
                    PlatformBackupWrite.Done(cloud)
                },
        )
    }

    override fun delete(key: String, callback: (PlatformBackupWrite) -> Unit) {
        keys += key
        items.remove(key)
        callback(unavailable?.let { PlatformBackupWrite.Unavailable(it) } ?: PlatformBackupWrite.Done(false))
    }
}

/** The bk_* ops over a fake backup: the keys they build, the value's path, and the fixed failure words. */
@RunWith(RobolectricTestRunner::class)
class BackupCommandsTest {
    private val fake = FakeBackup()
    private val c = Commands(TestHost(), backup = { fake })

    private fun ask(op: String, kind: String? = "restore", product: String? = "diceroll", value: String? = null): JSONObject {
        val q = JSONObject().put("op", op)
        if (kind != null) q.put("kind", kind)
        if (product != null) q.put("product", product)
        if (value != null) q.put("value", value)
        return c.json(q)
    }

    private fun result(op: String, kind: String? = "restore", product: String? = "diceroll", value: String? = null): JSONObject {
        val ack = ask(op, kind, product, value)
        assertTrue(ack.toString(), ack.getBoolean("ok"))
        return c.awaitResult(ack.getInt("req"))
    }

    private fun b64(s: String) = Base64.encodeToString(s.toByteArray(), Base64.NO_WRAP)

    @Test
    fun aValueRoundTripsUnderTheProductsKey() {
        val value = """{"v":1,"restoreId":"rk_x","secret":"rs_y"}"""
        assertTrue(result("bk_set", value = b64(value)).getBoolean("cloud"))
        assertEquals(listOf("pkey-restore-diceroll"), fake.keys)
        val got = result("bk_get")
        assertTrue(got.getBoolean("found"))
        assertEquals(value, String(Base64.decode(got.getString("value"), Base64.NO_WRAP)))
        assertTrue(result("bk_delete").getBoolean("ok"))
        assertFalse(result("bk_get").getBoolean("found"))
    }

    @Test
    fun theSyncRootHasItsOwnKey() {
        result("bk_set", kind = "sync", value = b64("root"))
        assertEquals(listOf("pkey-sync-diceroll"), fake.keys)
    }

    @Test
    fun theValueNeverRidesTheAckOrAFailure() {
        val ack = ask("bk_set", value = b64("SECRET"))
        assertFalse(ack.toString().contains("SECRET"))
        fake.unavailable = "no-play-services"
        val ev = result("bk_set", value = b64("SECRET"))
        assertFalse(ev.getBoolean("ok"))
        assertFalse(ev.toString().contains("SECRET"))
    }

    @Test
    fun aFailureCarriesAFixedWord() {
        fake.unavailable = "no-play-services"
        for (op in listOf("bk_get", "bk_delete")) {
            val ev = result(op)
            assertEquals("unavailable", ev.getString("error"))
            assertEquals("no-play-services", ev.getString("reason"))
        }
        fake.unavailable = null
        fake.refused = "too-large"
        val ev = result("bk_set", value = b64("x"))
        assertEquals("refused", ev.getString("error"))
        assertEquals("too-large", ev.getString("reason"))
    }

    @Test
    fun aMalformedRequestIsRefusedBeforeTheBackupIsAsked() {
        val bad = listOf(
            ask("bk_get", kind = "other"),
            ask("bk_get", kind = null),
            ask("bk_get", product = null),
            ask("bk_get", product = "../x"),
            ask("bk_get", product = "Upper"),
            ask("bk_get", product = "a".repeat(65)),
            ask("bk_set"),
            ask("bk_set", value = "!!not base64!!"),
        )
        for (r in bad) {
            assertFalse(r.toString(), r.getBoolean("ok"))
            assertEquals("bad_input", r.getString("error"))
        }
        assertTrue(fake.keys.isEmpty())
    }

    @Test
    fun infoReportsSupportAndCloud() {
        val on = result("bk_info", kind = null, product = null)
        assertTrue(on.getBoolean("supported") && on.getBoolean("cloud"))
        fake.cloud = false
        assertFalse(result("bk_info", kind = null, product = null).getBoolean("cloud"))
        fake.supported = false
        val off = result("bk_info", kind = null, product = null)
        assertFalse(off.getBoolean("supported") || off.getBoolean("cloud"))
    }

    @Test
    fun capabilitiesNameTheOps() {
        assertTrue(c.json(JSONObject().put("op", "capabilities")).getBoolean("platformBackup"))
        fake.supported = false
        val c2 = Commands(TestHost(), backup = { fake })
        assertFalse(c2.json(JSONObject().put("op", "capabilities")).getBoolean("platformBackup"))
    }

    @Test
    fun aMissingLibraryIsUnavailableNotACrash() {
        val c3 = Commands(TestHost(), backup = { throw NoClassDefFoundError("com/google/android/gms/auth/blockstore/Blockstore") })
        val ack = c3.json(JSONObject().put("op", "bk_get").put("kind", "restore").put("product", "diceroll"))
        val ev = c3.awaitResult(ack.getInt("req"))
        assertEquals("unavailable", ev.getString("error"))
        assertFalse(c3.json(JSONObject().put("op", "capabilities")).getBoolean("platformBackup"))
    }
}
