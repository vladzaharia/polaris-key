package im.plrs.key.platform.direct

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Looper
import android.provider.Settings
import androidx.test.core.app.ApplicationProvider
import im.plrs.key.platform.Digests
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
class ApkInstallerTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private lateinit var facts: FakeFacts
    private lateinit var apk: File
    private lateinit var sha: String
    private val pi: PackageInstaller get() = ctx.packageManager.packageInstaller

    @Before
    fun setUp() {
        facts = FakeFacts(listOf(ctx.filesDir, ctx.noBackupFilesDir, ctx.cacheDir), ArchiveFacts(ctx.packageName, 10, listOf(SIGNER_A)))
        apk = File(ctx.filesDir, "pkey/update.apk").apply {
            parentFile!!.mkdirs()
            writeBytes(ByteArray(10_000) { (it * 7).toByte() })
        }
        sha = Digests.sha256(apk)
        facts.archives[apk.path] = ArchiveFacts(ctx.packageName, 11, listOf(SIGNER_A))
        InstallJournal(ctx).clear()
    }

    @After
    fun tearDown() {
        InstallEvents.listener = null
    }

    private fun installer() = ApkInstaller(ctx, facts)

    @Test
    fun refusalsOpenNoSession() {
        val cases = listOf<Pair<() -> Unit, String>>(
            { } to "hash_mismatch",
            { facts.archives[apk.path] = ArchiveFacts(ctx.packageName, 11, listOf(SIGNER_B)) } to "signer_mismatch",
            { facts.archives[apk.path] = ArchiveFacts(ctx.packageName, 10, listOf(SIGNER_A)) } to "version_not_higher",
            { facts.archives[apk.path] = ArchiveFacts(ctx.packageName, 9, listOf(SIGNER_A)) } to "version_not_higher",
        )
        for ((arrange, reason) in cases) {
            setUp()
            arrange()
            val hash = if (reason == "hash_mismatch") "f".repeat(64) else sha
            val out = installer().install(apk, hash, null)
            assertFalse(out.committed)
            assertTrue("$reason in ${out.verdict.refused}", reason in out.verdict.refused)
            assertNull(out.sessionId)
            assertTrue(pi.allSessions.isEmpty())
        }
        setUp()
        val noHash = installer().install(apk, null, null)
        assertEquals(listOf("hash_required"), noHash.verdict.refused)
        assertTrue(pi.allSessions.isEmpty())
        assertNull(InstallJournal(ctx).last())
    }

    @Test
    @Config(sdk = [34])
    fun aVerifiedApkIsCommittedSilently() {
        val out = installer().install(apk, sha, 11)
        assertTrue(out.error ?: "", out.committed)
        assertNotNull(out.sessionId)
        assertTrue(out.applied.getBoolean("userActionNotRequired"))
        assertFalse(out.applied.has("gentle"))
        // Robolectric's SessionInfo does not carry the params back, so `applied` is the record.
        assertNotNull(pi.getSessionInfo(out.sessionId!!))
        assertFalse(out.applied.has("requestUpdateOwnership"))
        assertEquals("commit", InstallJournal(ctx).last()!!.getString("event"))
    }

    @Test
    @Config(sdk = [30])
    fun belowApi31TheCommitMayPrompt() {
        val out = installer().install(apk, sha, null)
        assertTrue(out.committed)
        assertFalse(out.applied.has("userActionNotRequired"))
    }

    @Test
    @Config(sdk = [34])
    fun silentCanBeTurnedOff() {
        val out = installer().install(apk, sha, null, InstallOptions(silent = false))
        assertTrue(out.committed)
        assertFalse(out.applied.has("userActionNotRequired"))
    }

    @Test
    fun bytesChangedAfterVerificationAbortTheSession() {
        // The archive read happens after the hash: swap the bytes then, as a racing writer would.
        facts.onArchive = { apk.appendBytes(byteArrayOf(1, 2, 3)) }
        val out = installer().install(apk, sha, null)
        assertFalse(out.committed)
        assertEquals(listOf("hash_changed"), out.verdict.refused)
        assertTrue(pi.allSessions.isEmpty())
    }

    @Test
    fun successReachesTheReceiverAndTheJournal() {
        val heard = mutableListOf<InstallStatus>()
        InstallEvents.listener = { heard.add(it) }
        val out = installer().install(apk, sha, null)
        shadowOf(pi).setSessionSucceeds(out.sessionId!!)
        shadowOf(Looper.getMainLooper()).idle()
        // Robolectric delivers the broadcast without the status extras; their mapping is
        // InstallStatusReceiverTest's. This proves the explicit PendingIntent reaches the receiver.
        val last = InstallJournal(ctx).last()!!
        assertEquals("status", last.getString("event"))
        assertTrue(last.getBoolean("listener"))
        assertTrue(heard.isNotEmpty())
    }

    @Test
    fun staleSessionsAreAbandoned() {
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        val a = pi.createSession(params)
        val b = pi.createSession(params)
        assertEquals(1, installer().abandonStaleSessions(keep = setOf(b)))
        assertNull(pi.getSessionInfo(a))
        assertNotNull(pi.getSessionInfo(b))
    }

    @Test
    @Config(sdk = [34])
    fun canInstallFollowsTheUserSetting() {
        shadowOf(ctx.packageManager).setCanRequestPackageInstalls(false)
        assertFalse(installer().canInstall())
        shadowOf(ctx.packageManager).setCanRequestPackageInstalls(true)
        assertTrue(installer().canInstall())
        val i = installer().settingsIntent()
        assertEquals(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, i.action)
        assertEquals("package:${ctx.packageName}", i.dataString)
    }

    @Test
    @Config(sdk = [33])
    fun gentleConstraintsNeedApi34() {
        var answer: Boolean? = true
        installer().gentleConstraintsSatisfied { answer = it }
        assertNull(answer)
    }

    @Test
    fun androidPackageFactsReadArchiveInfo() {
        val info = android.content.pm.PackageInfo().apply {
            packageName = ctx.packageName
            @Suppress("DEPRECATION")
            versionCode = 12
            longVersionCode = 12
        }
        shadowOf(ctx.packageManager).setPackageArchiveInfo(apk.path, info)
        val f = AndroidPackageFacts(ctx).archive(apk.path)!!
        assertEquals(ctx.packageName, f.packageName)
        assertEquals(12L, f.versionCode)
        assertTrue(AndroidPackageFacts(ctx).privateDirs().contains(ctx.filesDir))
    }
}

@RunWith(RobolectricTestRunner::class)
class InstallStatusReceiverTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()

    @After
    fun tearDown() {
        InstallEvents.listener = null
        InstallJournal(ctx).clear()
    }

    private fun intent(status: Int) = Intent(ctx, InstallStatusReceiver::class.java)
        .setAction(InstallStatusReceiver.ACTION)
        .putExtra(PackageInstaller.EXTRA_STATUS, status)
        .putExtra(PackageInstaller.EXTRA_STATUS_MESSAGE, "INSTALL_FAILED_ABORTED: User rejected permissions")
        .putExtra(PackageInstaller.EXTRA_SESSION_ID, 7)
        .putExtra(PackageInstaller.EXTRA_OTHER_PACKAGE_NAME, "com.android.vending")
        .putExtra(InstallStatusReceiver.EXTRA_PROMPT, true)

    @Test
    fun journalsTheStatusWithoutAGame() {
        InstallStatusReceiver().onReceive(ctx, intent(PackageInstaller.STATUS_FAILURE_ABORTED))
        val last = InstallJournal(ctx).last()!!
        assertEquals(3, last.getInt("status"))
        assertEquals("failure_aborted", last.getString("name"))
        assertEquals(7, last.getInt("session"))
        assertEquals("com.android.vending", last.getString("otherPackage"))
        assertFalse(last.getBoolean("listener"))
        assertTrue(last.has("at"))
    }

    @Test
    fun pendingUserActionCarriesTheConfirmIntent() {
        var heard: InstallStatus? = null
        InstallEvents.listener = { heard = it }
        val confirm = Intent("android.content.pm.action.CONFIRM_INSTALL")
        InstallStatusReceiver().onReceive(ctx, intent(PackageInstaller.STATUS_PENDING_USER_ACTION).putExtra(Intent.EXTRA_INTENT, confirm))
        assertEquals("pending_user_action", heard!!.name)
        assertEquals("android.content.pm.action.CONFIRM_INSTALL", heard!!.confirmIntent!!.action)
        assertTrue(heard!!.prompt)
        assertEquals("android.content.pm.action.CONFIRM_INSTALL", InstallJournal(ctx).last()!!.getString("confirmAction"))
    }

    @Test
    fun otherActionsAreIgnored() {
        InstallStatusReceiver().onReceive(ctx, Intent("something.else").putExtra(PackageInstaller.EXTRA_STATUS, 0))
        assertNull(InstallJournal(ctx).last())
    }

    @Test
    fun everyStatusHasAName() {
        val names = (-1..8).map { InstallStatus.statusName(it) }
        assertEquals(
            listOf("pending_user_action", "success", "failure", "failure_blocked", "failure_aborted", "failure_invalid", "failure_conflict", "failure_storage", "failure_incompatible", "failure_timeout"),
            names,
        )
        assertEquals("unknown", InstallStatus.statusName(99))
        assertEquals(JSONObject.NULL, InstallStatus(0, null, 1, null, 0, null, false).toJson().get("message"))
    }
}
