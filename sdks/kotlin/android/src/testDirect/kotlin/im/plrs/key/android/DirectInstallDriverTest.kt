// @pkey-feature update.driver packs.transport.play
package im.plrs.key.android

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import im.plrs.key.core.DecisionRelease
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.core.ReleaseRecordArtifact
import im.plrs.key.core.ReleaseRecordBuild
import im.plrs.key.core.ReleaseRecordDoc
import im.plrs.key.core.UpdateCheck
import im.plrs.key.core.UpdateDecision
import im.plrs.key.platform.Digests
import im.plrs.key.platform.direct.ApkInstaller
import im.plrs.key.platform.direct.ArchiveFacts
import im.plrs.key.platform.direct.InstallOutcome
import im.plrs.key.platform.direct.PackageFacts
import im.plrs.key.platform.direct.Verdict
import im.plrs.key.update.InstallResult
import java.io.File
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Installer facts a test controls (PackageManager cannot parse a fake APK). */
class TestFacts(private val dirs: List<File>, var installed: ArchiveFacts) : PackageFacts {
    val archives = mutableMapOf<String, ArchiveFacts>()
    override fun archive(path: String): ArchiveFacts? = archives[path]
    override fun installed(): ArchiveFacts = installed
    override fun privateDirs(): List<File> = dirs
}

/**
 * update.driver on a direct build: the verified self-update through every step the driver can
 * refuse at (the record, the download's size and hash), every PackageInstaller refusal it surfaces,
 * and a committed session through :platform's real ApkInstaller.
 */
@RunWith(RobolectricTestRunner::class)
class DirectInstallDriverTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val bytes = ByteArray(20_000) { (it * 13).toByte() }
    private val sha = Digests.sha256(bytes)
    private lateinit var dir: File
    private var downloaded = 0
    private var served: ByteArray = bytes
    private var sessionCalls = mutableListOf<Pair<File, String>>()

    @Before
    fun setUp() {
        dir = File(ctx.filesDir, "pkey/diceroll/updates/apk")
        dir.deleteRecursively()
    }

    private fun record(artifacts: List<ReleaseRecordArtifact> = listOf(ReleaseRecordArtifact("diceroll.apk", "payload", sha, bytes.size.toLong()))) = ReleaseRecordDoc(
        schemaVersion = 1, aud = "diceroll", deliverable = "app", kind = "app", version = "1.4.0", seq = 14, issuedAt = 1_700_000_000,
        builds = listOf(ReleaseRecordBuild("android-arm64", "android", "arm64", "apk", artifacts = artifacts)),
        json = JsonObject(emptyMap()),
    )

    private fun driver(
        sessions: ApkSessions = ApkSessions { f, s, _ -> sessionCalls += f to s; outcome(emptyList(), committed = true) },
        records: suspend (String) -> ReleaseRecordDoc = { record() },
        buildUrl: suspend (String, String) -> String? = { v, b -> "https://key.plrs.im/diceroll/distribution/builds/$v/$b" },
    ) = DirectInstallDriver(sessions, records, buildUrl, { _, dest -> downloaded++; dest.writeBytes(served) }, dir)

    private fun outcome(refused: List<String>, committed: Boolean = false, error: String? = null) = InstallOutcome(
        Verdict(refused, File(dir, "update.apk").path, bytes.size.toLong(), sha, null, null),
        committed, if (committed) 7 else null, JSONObject(), error,
    )

    private fun binary(method: String = "native", hash: String? = "ab".repeat(32), build: String = "android-arm64") = UpdateCheck(
        "stable",
        UpdateDecision.Binary(method, DecisionRelease("1.4.0", 14, hash), build, false, false, emptyList(), false),
        UpdateCheck.FeedSource.network, UpdateCheck.RecordSource.network, emptyList(),
    )

    private fun failed(r: InstallResult): InstallResult.Failed {
        assertTrue("expected a failure, got $r", r is InstallResult.Failed)
        return r as InstallResult.Failed
    }

    @Test
    fun aVerifiedApkIsHandedToTheInstallerAndItsCopyRemoved() = runBlocking {
        val d = driver()
        assertEquals(InstallResult.Started, d.install(binary()))
        assertEquals(1, sessionCalls.size)
        assertEquals(sha, sessionCalls[0].second)
        assertEquals(File(dir, "update.apk"), sessionCalls[0].first)
        assertFalse("the session holds its own copy", File(dir, "update.apk").exists())
        assertTrue(d.lastOutcome!!.committed)
    }

    /** §3.13: a verified download and the hand-off each journal one event; a refusal journals no hand-off. */
    @Test
    fun theDriverJournalsTheDownloadAndTheHandOff() = runBlocking {
        val events = im.plrs.key.core.UpdateEventJournal(im.plrs.key.core.MemoryStateSlot()) { 100 }
        val d = DirectInstallDriver(
            { _, _, _ -> outcome(emptyList(), committed = true) }, { record() }, { _, _ -> "https://x" },
            { _, dest -> dest.writeBytes(served) }, dir, events = { events }, runningVersion = "1.3.0",
        )
        assertEquals(InstallResult.Started, d.install(binary()))
        assertEquals(listOf("update_downloaded", "update_applied"), events.events().map { it.event })
        assertTrue(events.events().all { it.release == "1.4.0" && it.fromRelease == "1.3.0" })
        val refused = im.plrs.key.core.UpdateEventJournal(im.plrs.key.core.MemoryStateSlot()) { 100 }
        DirectInstallDriver(
            { _, _, _ -> outcome(listOf("signer_mismatch")) }, { record() }, { _, _ -> "https://x" },
            { _, dest -> dest.writeBytes(served) }, dir, events = { refused },
        ).install(binary())
        assertEquals(listOf("update_downloaded"), refused.events().map { it.event })
    }

    @Test
    fun everyInstallerRefusalIsSwapRefused() = runBlocking {
        // Every reason ApkVerifier gives, the streamed re-hash, and the two session failures.
        val reasons = listOf(
            "missing_file", "path_not_private", "hash_required", "hash_mismatch", "unparseable", "package_mismatch",
            "signer_mismatch", "version_not_higher", "version_mismatch", "hash_changed",
        )
        for (reason in reasons) {
            val r = failed(driver(sessions = { _, _, _ -> outcome(listOf(reason)) }).install(binary()))
            assertEquals(reason, ErrorCode.swapRefused, r.code)
            assertEquals("apk-refused: $reason", r.detail)
            assertFalse(File(dir, "update.apk").exists())
        }
        val several = failed(driver(sessions = { _, _, _ -> outcome(listOf("signer_mismatch", "version_not_higher")) }).install(binary()))
        assertEquals("apk-refused: signer_mismatch, version_not_higher", several.detail)
        for (error in listOf("create_failed: no space", "commit_failed: SecurityException: denied")) {
            val r = failed(driver(sessions = { _, _, _ -> outcome(emptyList(), error = error) }).install(binary()))
            assertEquals(ErrorCode.swapRefused, r.code)
            assertEquals("apk-refused: $error", r.detail)
        }
        val io = failed(driver(sessions = { _, _, _ -> throw IOException("session gone") }).install(binary()))
        assertEquals(ErrorCode.platformError, io.code)
    }

    @Test
    fun aDownloadThatDoesNotMatchTheRecordIsNeverInstalled() = runBlocking {
        served = bytes.copyOf().also { it[5] = (it[5] + 1).toByte() }
        assertEquals(ErrorCode.payloadMismatch, failed(driver().install(binary())).code)
        served = bytes.copyOf(bytes.size - 1)
        assertEquals(ErrorCode.payloadMismatch, failed(driver().install(binary())).code)
        assertTrue("the installer was never called", sessionCalls.isEmpty())
        assertFalse(File(dir, "update.apk.part").exists())
        val dl = DirectInstallDriver({ _, _, _ -> error("unreachable") }, { record() }, { _, _ -> "https://x" }, { _, _ -> throw IOException("reset") }, dir)
        assertEquals(ErrorCode.networkError, failed(dl.install(binary())).code)
        val http = DirectInstallDriver({ _, _, _ -> error("unreachable") }, { record() }, { _, _ -> "https://x" }, { _, _ -> throw PolarisException(ErrorCode.httpError, "403") }, dir)
        assertEquals(ErrorCode.httpError, failed(http.install(binary())).code)
    }

    @Test
    fun theRecordMustNameTheBuildWithOnePayload() = runBlocking {
        assertEquals(ErrorCode.recordMismatch, failed(driver().install(binary(hash = null))).code)
        assertEquals(ErrorCode.recordMismatch, failed(driver().install(binary(build = "android-x86_64"))).code)
        val none = driver(records = { record(listOf(ReleaseRecordArtifact("notes.txt", "notes", sha, 3))) })
        assertEquals(ErrorCode.recordMismatch, failed(none.install(binary())).code)
        val two = ReleaseRecordArtifact("b.apk", "payload", sha, bytes.size.toLong())
        val twice = driver(records = { record(listOf(ReleaseRecordArtifact("a.apk", "payload", sha, bytes.size.toLong()), two)) })
        assertEquals(ErrorCode.recordMismatch, failed(twice.install(binary())).code)
        val rejected = driver(records = { throw PolarisException(ErrorCode.recordRejected, "bad signature") })
        assertEquals(ErrorCode.recordRejected, failed(rejected.install(binary())).code)
        assertEquals(ErrorCode.serviceUnavailable, failed(driver(buildUrl = { _, _ -> null }).install(binary())).code)
        assertEquals(0, downloaded)
    }

    @Test
    fun otherDecisions() = runBlocking {
        val d = driver()
        assertTrue(d.install(binary(method = "download")) is InstallResult.Declined)
        val store = UpdateCheck("stable", UpdateDecision.Store(DecisionRelease("1.4.0", 14), "https://f-droid.org/packages/gg.vlad.diceroll", false, false, false), UpdateCheck.FeedSource.network, UpdateCheck.RecordSource.none, emptyList())
        assertTrue(d.install(store) is InstallResult.Declined)
        val none = UpdateCheck("stable", UpdateDecision.None("up-to-date", false, false), UpdateCheck.FeedSource.network, UpdateCheck.RecordSource.none, emptyList())
        assertEquals(InstallResult.NothingToInstall, d.install(none))
        assertEquals(0, downloaded)
    }

    @Test
    fun throughThePlatformInstaller() = runBlocking {
        val facts = TestFacts(listOf(ctx.filesDir, ctx.noBackupFilesDir), ArchiveFacts(ctx.packageName, 10, listOf("aa".repeat(32))))
        val apk = File(dir, "update.apk").path
        // A different signer: refused before any session.
        facts.archives[apk] = ArchiveFacts(ctx.packageName, 11, listOf("bb".repeat(32)))
        val real = driver(sessions = ApkInstallerSessions(ApkInstaller(ctx, facts)))
        val r = failed(real.install(binary()))
        assertEquals("apk-refused: signer_mismatch", r.detail)
        assertTrue(ctx.packageManager.packageInstaller.mySessions.isEmpty())
        // The right signer and a higher versionCode: a committed session.
        facts.archives[apk] = ArchiveFacts(ctx.packageName, 11, listOf("aa".repeat(32)))
        assertEquals(InstallResult.Started, real.install(binary()))
        assertTrue(real.lastOutcome!!.committed)
    }

    @Test
    fun cleanupAndThePlayTransportsNa() {
        dir.mkdirs()
        File(dir, "update.apk").writeBytes(bytes)
        assertTrue(driver().cleanup())
        assertFalse(driver().cleanup())
        // A direct build has no Play Core: the typed `outlet` N/A, never a silent no-op.
        val packs = PlayPackTransport.create(ctx, listOf("diceroll.foes"))
        assertEquals("outlet", packs.availability()?.reason)
        assertTrue(packs.installed().isEmpty())
        val r = runBlocking { packs.ensure("diceroll.foes") }
        assertTrue(r is PlayPackResult.NotSupported)
        assertEquals("packs.transport.play", (r as PlayPackResult.NotSupported).unsupported.feature)
    }
}
