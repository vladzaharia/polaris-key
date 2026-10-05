// @pkey-feature release.download
//
// SP-K12: the opt-in JVM desktop install driver downloads the decision's installer through
// release.fetch (verified size and SHA-256, under the artifact's own name), hands it to the OS and
// journals the hand-off; with no desktop it still downloads and names the file; a store decision
// opens the listing.

package im.plrs.key.sdk

import im.plrs.key.core.CoreOptions
import im.plrs.key.core.DecisionRelease
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.ReleaseRecordArtifact
import im.plrs.key.core.ReleaseRecordBuild
import im.plrs.key.core.ReleaseRecordDoc
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.UpdateCheck
import im.plrs.key.core.UpdateDecision
import im.plrs.key.core.UpdateEvent
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import im.plrs.key.license.LicenseClientOptions
import im.plrs.key.update.InstallResult
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DesktopInstallDriverTest {
    private val signer = TestSigner()
    private val payload = ByteArray(4_096) { (it % 251).toByte() }
    private val sha = MessageDigest.getInstance("SHA-256").digest(payload).joinToString("") { "%02x".format(it) }
    private val recordSha = "ab".repeat(32)
    private val record = ReleaseRecordDoc(
        schemaVersion = 1, aud = "djdl", deliverable = "app", kind = "app", version = "1.4.0", seq = 14, issuedAt = 1_700_000_000, tag = "v1.4.0",
        builds = listOf(ReleaseRecordBuild("windows-x64", "windows", "x86_64", "msi", artifacts = listOf(ReleaseRecordArtifact("DJDL-1.4.0.msi", "payload", sha, payload.size.toLong())))),
        json = JsonObject(emptyMap()),
    )
    private val discovery = """{"product":"djdl","services":{"license":{"enabled":true},
        "release":{"enabled":true,"endpoints":{"builds":"https://key.plrs.im/djdl/release/builds/{selector}/{buildId}"}}}}"""

    private fun client(): PolarisKeyClient = runBlocking {
        PolarisKeyClient.create(
            PolarisKeyClientOptions(
                core = CoreOptions(
                    productSlug = "djdl", version = "1.3.0", pinnedKeys = signer.trust, trustRefresh = false,
                    store = InMemoryStore("djdl", "dev1").also { it.setToken("pkeyt_held") }, clock = { 1_700_000_000L },
                    expectedServices = listOf(ServiceSlug.license, ServiceSlug.release),
                    transport = ScriptedTransport { r ->
                        when (r.path) {
                            "/djdl/.well-known/polaris.json" -> respond(200, discovery)
                            "/djdl/release/builds/1.4.0/windows-x64" -> PolarisResponse(200, payload, mapOf("etag" to "\"v1\""))
                            else -> respond(404)
                        }
                    },
                ),
                license = LicenseClientOptions(fingerprint = false),
            ),
        )
    }

    private fun check(d: UpdateDecision) = UpdateCheck("stable", d, UpdateCheck.FeedSource.network, UpdateCheck.RecordSource.none, emptyList())

    private val binary = check(UpdateDecision.Binary("installer", DecisionRelease("1.4.0", 14, recordSha), "windows-x64", false, false, emptyList(), false))

    @Test
    fun aBinaryDecisionDownloadsVerifiesAndOpensTheInstaller() = runBlocking {
        val dir = Files.createTempDirectory("pkey-desktop").toFile()
        try {
            val c = client()
            val opened = mutableListOf<File>()
            val driver = DesktopInstallDriver(dir, open = { opened += it; true }, records = { assertEquals(recordSha, it); record }) { c }
            assertEquals(InstallResult.Started, driver.install(binary))
            assertEquals(listOf(File(dir, "DJDL-1.4.0.msi")), opened)
            assertTrue(opened.single().readBytes().contentEquals(payload))
            assertEquals(listOf(UpdateEvent.updateDownloaded, UpdateEvent.updateApplied), c.updateEvents.events().map { it.event })
            // A tagged record's events name the tag: the Worker counts an event under Release's releaseId.
            assertEquals(listOf("v1.4.0", "v1.4.0"), c.updateEvents.events().map { it.release })

            // No desktop: the file is still there, and the failure names it.
            val headless = DesktopInstallDriver(dir, open = { false }, records = { record }) { c }.install(binary)
            assertTrue(headless is InstallResult.Failed && headless.code == ErrorCode.unsupported && headless.detail!!.contains("DJDL-1.4.0.msi"))
            c.close()
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun aStoreDecisionOpensTheListingAndOthersAreNothing() = runBlocking {
        val c = client()
        val browsed = mutableListOf<String>()
        val driver = DesktopInstallDriver(browse = { browsed += it; true }) { c }
        val store = check(UpdateDecision.Store(DecisionRelease("1.4.0", 14), "https://store.steampowered.com/app/1", false, false, false))
        assertEquals(InstallResult.Started, driver.install(store))
        assertEquals(listOf("https://store.steampowered.com/app/1"), browsed)
        // Without a tag the version names the release; with the decision's record tag, the tag does.
        assertEquals("1.4.0", c.updateEvents.events().last().release)
        driver.install(store.copy(releaseTag = "v1.4.0"))
        assertEquals("v1.4.0", c.updateEvents.events().last().release)
        assertEquals(InstallResult.NothingToInstall, driver.install(check(UpdateDecision.None("current", false, false))))
        c.close()
    }
}
