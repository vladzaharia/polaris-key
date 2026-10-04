package im.plrs.key.godot

import android.content.Intent
import android.content.pm.PackageInstaller
import im.plrs.key.platform.Digests
import im.plrs.key.platform.direct.ArchiveFacts
import im.plrs.key.platform.direct.InstallEvents
import im.plrs.key.platform.direct.InstallJournal
import im.plrs.key.platform.direct.InstallStatusReceiver
import im.plrs.key.platform.direct.PackageFacts
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import java.io.File

class StaticFacts(private val dir: File, private val archive: ArchiveFacts?) : PackageFacts {
    override fun archive(path: String): ArchiveFacts? = archive
    override fun installed(): ArchiveFacts = ArchiveFacts("im.plrs.key.godot.test", 10, listOf("a".repeat(64)))
    override fun privateDirs(): List<File> = listOf(dir)
}

@RunWith(RobolectricTestRunner::class)
class DirectCommandsTest {
    private val host = TestHost()
    private val apk = File(host.appContext.filesDir, "u.apk").apply { writeBytes(ByteArray(64) { it.toByte() }) }

    private fun commands(archive: ArchiveFacts?) = Commands(host) { DirectCommands(it, StaticFacts(host.appContext.filesDir, archive)) }

    @After
    fun tearDown() {
        InstallEvents.listener = null
        InstallJournal(host.appContext).clear()
    }

    @Test
    fun verifyRefusalsComeBackFromTheWorker() {
        val c = commands(ArchiveFacts("im.plrs.key.godot.test", 9, listOf("b".repeat(64))))
        val req = c.json(JSONObject().put("op", "pi_verify").put("path", apk.path).put("sha256", Digests.sha256(apk))).getInt("req")
        val r = c.awaitResult(req)
        assertTrue(r.getBoolean("ok"))
        val v = r.getJSONObject("verify")
        assertFalse(v.getBoolean("ok"))
        val refused = (0 until v.getJSONArray("refused").length()).map { v.getJSONArray("refused").getString(it) }
        assertEquals(listOf("signer_mismatch", "version_not_higher"), refused)
    }

    @Test
    fun installRefusesWithoutAHash() {
        val c = commands(ArchiveFacts("im.plrs.key.godot.test", 11, listOf("a".repeat(64))))
        val r = c.awaitResult(c.json(JSONObject().put("op", "pi_install").put("path", apk.path)).getInt("req"))
        assertFalse(r.getBoolean("committed"))
        assertEquals("hash_required", r.getJSONObject("verify").getJSONArray("refused").getString(0))
    }

    @Test
    fun installStatusesAreQueuedAndPromptsLaunched() {
        val c = commands(null)
        val confirm = Intent("android.content.pm.action.CONFIRM_INSTALL")
        InstallStatusReceiver().onReceive(
            host.appContext,
            Intent(InstallStatusReceiver.ACTION)
                .putExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_PENDING_USER_ACTION)
                .putExtra(PackageInstaller.EXTRA_SESSION_ID, 3)
                .putExtra(InstallStatusReceiver.EXTRA_PROMPT, true)
                .putExtra(Intent.EXTRA_INTENT, confirm),
        )
        val ev = c.json(JSONObject().put("op", "poll")).getJSONArray("events").getJSONObject(0)
        assertEquals("install_status", ev.getString("ev"))
        assertEquals("pending_user_action", ev.getString("name"))
        assertTrue(ev.getBoolean("promptLaunched"))
        assertEquals("android.content.pm.action.CONFIRM_INSTALL", shadowOf(host.act).nextStartedActivity.action)
        // The next launch reads the same outcome from the journal.
        val last = c.json(JSONObject().put("op", "pi_last").put("clear", true)).getJSONObject("last")
        assertEquals(3, last.getInt("session"))
        assertTrue(c.json(JSONObject().put("op", "pi_last")).isNull("last"))
    }

    @Test
    fun capabilitiesAdvertiseDirect() {
        val c = commands(null)
        val caps = c.json(JSONObject().put("op", "capabilities"))
        assertTrue(caps.getBoolean("packageInstaller"))
        assertFalse(caps.getBoolean("inAppUpdates"))
        assertEquals("outlet", c.json(JSONObject().put("op", "iau_check")).getString("reason"))
        assertEquals("outlet", c.json(JSONObject().put("op", "pad_fetch")).getString("reason"))
        // P6-02: no Play Integrity in the direct build (an install Play did not make cannot attest).
        assertFalse(caps.getBoolean("playIntegrity"))
        for (op in listOf("integrity_prepare", "integrity_token")) {
            val r = c.json(JSONObject().put("op", op).put("cloudProjectNumber", "1").put("requestHash", "h"))
            assertEquals(true, r.getBoolean("unsupported"))
            assertEquals("outlet", r.getString("reason"))
        }
        assertNotNull(c.json(JSONObject().put("op", "pi_can_install")).get("canInstall"))
        assertEquals(0, c.json(JSONObject().put("op", "pi_abandon_stale")).getInt("abandoned"))
    }

    @Test
    fun closingReleasesTheListener() {
        val c = commands(null)
        assertNotNull(InstallEvents.listener)
        c.close()
        assertEquals(null, InstallEvents.listener)
    }
}
