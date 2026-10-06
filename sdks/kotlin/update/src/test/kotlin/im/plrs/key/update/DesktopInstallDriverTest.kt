// @pkey-feature update.driver
//
// The JVM desktop install driver (UK-40, SP-K12): the verified record's one payload for the
// decision's build, fetched, checked against the record's size and SHA-256 BEFORE the OS opens it
// (a mismatch opens nothing), the decisions it declines, and the OS launcher commands. The fetch is
// OkHttpArtifactFetch over MockWebServer: Range resumption, the bearer kept to the control plane's
// origin and dropped across a redirect, an over-long body refused, local-only refused at the dial.

package im.plrs.key.update

import im.plrs.key.core.BinaryMethod
import im.plrs.key.core.CoreContext
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.DecisionRelease
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.NoNetworkTransport
import im.plrs.key.core.PolarisException
import im.plrs.key.core.ReleaseRecordArtifact
import im.plrs.key.core.ReleaseRecordBuild
import im.plrs.key.core.ReleaseRecordDoc
import im.plrs.key.core.UpdateCheck
import im.plrs.key.core.UpdateDecision
import im.plrs.key.core.testing.TestSigner
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class DesktopInstallDriverTest {
    private val bytes = ByteArray(200_000) { (it * 31 % 251).toByte() }
    private val sha = hex(bytes)
    private val recordHash = "a".repeat(64)

    private fun hex(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private fun tempDir(): File = Files.createTempDirectory("pkey-desktop").toFile().also { it.deleteOnExit() }

    private fun record(artifacts: List<ReleaseRecordArtifact> = listOf(ReleaseRecordArtifact("djdl-1.4.0-arm64.dmg", "payload", sha, bytes.size.toLong()))) = ReleaseRecordDoc(
        schemaVersion = 1, aud = "djdl", deliverable = "app", kind = "app", version = "1.4.0", seq = 14, issuedAt = 1_700_000_000,
        builds = listOf(
            ReleaseRecordBuild("macos-arm64", "macos", "arm64", "dmg", artifacts = artifacts),
            ReleaseRecordBuild("windows-x86_64", "windows", "x86_64", "msi", artifacts = listOf(ReleaseRecordArtifact("djdl.msi", "payload", "b".repeat(64), 3))),
        ),
        json = JsonObject(emptyMap()),
    )

    private fun binary(method: String = BinaryMethod.download, build: String = "macos-arm64", hash: String? = recordHash) = UpdateCheck(
        "stable",
        UpdateDecision.Binary(method, DecisionRelease("1.4.0", 14, hash), build, false, false, emptyList(), false),
        UpdateCheck.FeedSource.network, UpdateCheck.RecordSource.network, emptyList(),
    )

    private class Opened : InstallerOpener {
        val files = mutableListOf<Pair<File, String>>()
        override fun open(installer: File, build: ReleaseRecordBuild) {
            files += installer to DesktopInstallDriver.sha256(installer)
        }
    }

    private fun driver(
        dir: File,
        opener: InstallerOpener,
        payload: ByteArray = bytes,
        rec: ReleaseRecordDoc = record(),
        urls: MutableList<String> = mutableListOf(),
    ) = DesktopInstallDriver(
        records = { h -> assertEquals(recordHash, h); rec },
        buildUrl = { v, b -> "https://key.plrs.im/djdl/distribution/builds/$v/$b" },
        fetch = { url, part, _, _ -> urls += url; part.writeBytes(payload) },
        dir = dir,
        opener = opener,
    )

    @Test
    fun aVerifiedInstallerIsOpened() = runBlocking {
        val dir = tempDir()
        val opened = Opened()
        val urls = mutableListOf<String>()
        val d = driver(dir, opened, urls = urls)
        assertEquals(InstallResult.Started, d.install(binary()))
        assertEquals(listOf("https://key.plrs.im/djdl/distribution/builds/1.4.0/macos-arm64"), urls)
        val (file, digest) = opened.files.single()
        assertEquals(File(dir, "djdl-1.4.0-arm64.dmg"), file)
        assertEquals("the opened file is the record's bytes", sha, digest)
        assertFalse(File(dir, "djdl-1.4.0-arm64.dmg.part").exists())
        assertEquals(file, d.lastInstaller)
        // `native` is the same whole-build install on a JVM.
        assertEquals(InstallResult.Started, d.install(binary(BinaryMethod.native)))
    }

    @Test
    fun aDigestMismatchOpensNothing() = runBlocking {
        val dir = tempDir()
        val opened = Opened()
        val tampered = bytes.copyOf().also { it[100] = (it[100] + 1).toByte() }
        val r = driver(dir, opened, payload = tampered).install(binary())
        assertEquals(ErrorCode.payloadMismatch, (r as InstallResult.Failed).code)
        assertTrue("nothing was opened", opened.files.isEmpty())
        assertTrue("nothing is left behind", dir.listFiles().orEmpty().isEmpty())
    }

    @Test
    fun aSizeMismatchOpensNothing() = runBlocking {
        val opened = Opened()
        val r = driver(tempDir(), opened, payload = bytes + byteArrayOf(1)).install(binary())
        assertEquals(ErrorCode.payloadMismatch, (r as InstallResult.Failed).code)
        assertTrue(opened.files.isEmpty())
    }

    @Test
    fun theRecordMustPinOnePayloadForTheBuild() = runBlocking {
        val opened = Opened()
        assertEquals(ErrorCode.recordMismatch, (driver(tempDir(), opened).install(binary(build = "linux-x86_64")) as InstallResult.Failed).code)
        assertEquals(ErrorCode.recordMismatch, (driver(tempDir(), opened).install(binary(hash = null)) as InstallResult.Failed).code)
        val two = record(listOf(ReleaseRecordArtifact("a.dmg", "payload", sha, 1), ReleaseRecordArtifact("b.dmg", "payload", sha, 1)))
        assertEquals(ErrorCode.recordMismatch, (driver(tempDir(), opened, rec = two).install(binary()) as InstallResult.Failed).code)
        assertTrue(opened.files.isEmpty())
    }

    @Test
    fun aRefusedRecordOrMissingRouteFails() = runBlocking {
        val refused = DesktopInstallDriver(
            records = { throw PolarisException(ErrorCode.recordRejected, "bad signature") },
            buildUrl = { _, _ -> "https://x" }, fetch = { _, _, _, _ -> fail("never fetched") }, dir = tempDir(), opener = Opened(),
        )
        assertEquals(ErrorCode.recordRejected, (refused.install(binary()) as InstallResult.Failed).code)
        val noRoute = DesktopInstallDriver({ record() }, { _, _ -> null }, { _, _, _, _ -> fail("never fetched") }, tempDir(), Opened())
        assertEquals(ErrorCode.serviceUnavailable, (noRoute.install(binary()) as InstallResult.Failed).code)
    }

    @Test
    fun anOpenerFailureIsAPlatformError() = runBlocking {
        val r = driver(tempDir(), { _, _ -> throw java.io.IOException("no launcher") }).install(binary())
        assertEquals(ErrorCode.platformError, (r as InstallResult.Failed).code)
    }

    @Test
    fun otherDecisionsAreDeclinedOrNothing() = runBlocking {
        val d = driver(tempDir(), Opened())
        assertTrue(d.install(binary(BinaryMethod.sidecarPck)) is InstallResult.Declined)
        val store = UpdateCheck("stable", UpdateDecision.Store(DecisionRelease("1.4.0", 14), "https://apps.apple.com/app/id1", false, false, false), UpdateCheck.FeedSource.network, UpdateCheck.RecordSource.none, emptyList())
        assertTrue(d.install(store) is InstallResult.Declined)
        val none = UpdateCheck("stable", UpdateDecision.None("up-to-date", false, false), UpdateCheck.FeedSource.network, UpdateCheck.RecordSource.none, emptyList())
        assertEquals(InstallResult.NothingToInstall, d.install(none))
    }

    @Test
    fun cleanupRemovesOpenedInstallersAndKeepsPartials() = runBlocking {
        val dir = tempDir()
        val d = driver(dir, Opened())
        d.install(binary())
        File(dir, "next.dmg.part").writeText("x")
        assertEquals(listOf("djdl-1.4.0-arm64.dmg"), d.cleanup().map { it.name })
        assertTrue(File(dir, "next.dmg.part").exists())
    }

    @Test
    fun artifactNamesAreSafeBasenames() {
        assertEquals("djdl.dmg", DesktopInstallDriver.safeName("../../djdl.dmg"))
        assertEquals("evil.exe", DesktopInstallDriver.safeName("C:\\Windows\\evil.exe"))
        assertEquals("a_b_c.msi", DesktopInstallDriver.safeName("a b;c.msi"))
        assertEquals("bashrc", DesktopInstallDriver.safeName(".bashrc"))
        assertEquals("installer", DesktopInstallDriver.safeName("..."))
    }

    @Test
    fun theOsLauncherCommands() {
        val f = File("/tmp/djdl.dmg")
        val build = ReleaseRecordBuild("b", "macos", "arm64", "dmg", artifacts = emptyList())
        assertEquals(listOf("open", f.absolutePath), SystemInstallerOpener("Mac OS X").command(f, build))
        assertEquals(listOf("rundll32.exe", "shell32.dll,ShellExec_RunDLL", f.absolutePath), SystemInstallerOpener("Windows 11").command(f, build))
        assertEquals(listOf("xdg-open", f.absolutePath), SystemInstallerOpener("Linux").command(f, build))
        val appImage = File("/tmp/djdl-x86_64.AppImage")
        assertEquals(listOf(appImage.absolutePath), SystemInstallerOpener("Linux").command(appImage, build))
        val launched = mutableListOf<List<String>>()
        SystemInstallerOpener("Mac OS X") { launched += it }.open(f, build)
        assertEquals(listOf(listOf("open", f.absolutePath)), launched)
    }

    // ── OkHttpArtifactFetch ──────────────────────────────────────────────────────────────────

    private fun core(base: String, token: String? = "dev-token", local: Boolean = false): CoreContext = CoreContext(
        CoreOptions(
            baseUrl = base, productSlug = "djdl", version = "1.2.0", pinnedKeys = TestSigner("pkey-test-prod").trust,
            store = InMemoryStore("djdl"), transport = if (local) NoNetworkTransport else null, trustRefresh = false,
        ),
    ).also { c -> if (token != null) runBlocking { c.start(); c.setToken(token) } }

    private fun body(b: ByteArray) = Buffer().write(b)

    @Test
    fun aFetchSendsTheBearerToTheControlPlaneAndNoGzip() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(200).setBody(body(bytes)))
            val base = server.url("/").toString().trimEnd('/')
            val part = File(tempDir(), "x.part")
            OkHttpArtifactFetch(core(base)).fetch("$base/djdl/distribution/builds/1.4.0/macos-arm64", part, bytes.size.toLong(), null)
            assertEquals(sha, hex(part.readBytes()))
            val req = server.takeRequest()
            assertEquals("Bearer dev-token", req.getHeader("authorization"))
            assertEquals("identity", req.getHeader("accept-encoding"))
            assertNull(req.getHeader("range"))
        }
    }

    @Test
    fun aPartialDownloadResumesWithRange() = runBlocking {
        MockWebServer().use { server ->
            val have = 50_000
            server.enqueue(
                MockResponse().setResponseCode(206).setHeader("content-range", "bytes $have-${bytes.size - 1}/${bytes.size}")
                    .setBody(body(bytes.copyOfRange(have, bytes.size))),
            )
            val base = server.url("/").toString().trimEnd('/')
            val part = File(tempDir(), "x.part").also { it.writeBytes(bytes.copyOfRange(0, have)) }
            var last = 0L
            OkHttpArtifactFetch(core(base)).fetch("$base/b", part, bytes.size.toLong()) { got, _ -> last = got }
            assertEquals("bytes=$have-", server.takeRequest().getHeader("range"))
            assertEquals(sha, hex(part.readBytes()))
            assertEquals(bytes.size.toLong(), last)
        }
    }

    @Test
    fun aServerThatIgnoresRangeStartsOver() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(200).setBody(body(bytes)))
            val base = server.url("/").toString().trimEnd('/')
            val part = File(tempDir(), "x.part").also { it.writeBytes(ByteArray(1000) { 9 }) }
            OkHttpArtifactFetch(core(base)).fetch("$base/b", part, bytes.size.toLong(), null)
            assertEquals(sha, hex(part.readBytes()))
        }
    }

    @Test
    fun aCompletePartIsNotFetchedAgain() = runBlocking {
        MockWebServer().use { server ->
            val base = server.url("/").toString().trimEnd('/')
            val part = File(tempDir(), "x.part").also { it.writeBytes(bytes) }
            OkHttpArtifactFetch(core(base)).fetch("$base/b", part, bytes.size.toLong(), null)
            assertEquals(0, server.requestCount)
        }
    }

    @Test
    fun aCrossOriginRedirectDropsTheBearer() = runBlocking {
        MockWebServer().use { cdn ->
            MockWebServer().use { plane ->
                cdn.enqueue(MockResponse().setResponseCode(200).setBody(body(bytes)))
                // The control plane at 127.0.0.1, the CDN at localhost: different origins.
                val cdnUrl = cdn.url("/blob").newBuilder().host("localhost").build().toString()
                plane.enqueue(MockResponse().setResponseCode(302).setHeader("location", cdnUrl))
                val base = plane.url("/").toString().trimEnd('/')
                val part = File(tempDir(), "x.part")
                OkHttpArtifactFetch(core(base)).fetch("$base/b", part, bytes.size.toLong(), null)
                assertEquals("Bearer dev-token", plane.takeRequest().getHeader("authorization"))
                assertNull("the CDN never sees the bearer", cdn.takeRequest().getHeader("authorization"))
                assertEquals(sha, hex(part.readBytes()))
            }
        }
    }

    @Test
    fun aBuildUrlOffTheControlPlaneGetsNoBearer() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(200).setBody(body(bytes)))
            val other = server.url("/b").newBuilder().host("localhost").build().toString()
            val part = File(tempDir(), "x.part")
            OkHttpArtifactFetch(core("http://127.0.0.1:9")).fetch(other, part, bytes.size.toLong(), null)
            assertNull(server.takeRequest().getHeader("authorization"))
        }
    }

    @Test
    fun anOverLongBodyIsRefusedAndThePartRemoved() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(200).setBody(body(bytes + ByteArray(10))))
            val base = server.url("/").toString().trimEnd('/')
            val part = File(tempDir(), "x.part")
            try {
                OkHttpArtifactFetch(core(base)).fetch("$base/b", part, bytes.size.toLong(), null)
                fail("an over-long body is refused")
            } catch (e: PolarisException) {
                assertEquals(ErrorCode.responseTooLarge, e.code)
            }
            assertFalse(part.exists())
        }
    }

    @Test
    fun anErrorStatusIsAnHttpError() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(403))
            val base = server.url("/").toString().trimEnd('/')
            try {
                OkHttpArtifactFetch(core(base)).fetch("$base/b", File(tempDir(), "x.part"), 10, null)
                fail("403 is refused")
            } catch (e: PolarisException) {
                assertEquals(ErrorCode.httpError, e.code)
            }
        }
    }

    @Test
    fun plainHttpOffLoopbackIsRefused() = runBlocking {
        try {
            OkHttpArtifactFetch(core("https://key.plrs.im", token = null)).fetch("http://cdn.example.com/b", File(tempDir(), "x.part"), 10, null)
            fail("plain http is refused")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.insecureRedirect, e.code)
        }
    }

    @Test
    fun aLocalOnlyClientRefusesBeforeDialling() = runBlocking {
        try {
            OkHttpArtifactFetch(core("https://key.plrs.im", token = null, local = true)).fetch("https://key.plrs.im/b", File(tempDir(), "x.part"), 10, null)
            fail("local-only refuses")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.localOnly, e.code)
        }
    }

    @Test
    fun theDriverOverTheRealFetchVerifiesBeforeOpening() = runBlocking {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setResponseCode(200).setBody(body(bytes)))
            val base = server.url("/").toString().trimEnd('/')
            val opened = Opened()
            val d = DesktopInstallDriver({ record() }, { v, b -> "$base/djdl/distribution/builds/$v/$b" }, OkHttpArtifactFetch(core(base)), tempDir(), opened)
            assertEquals(InstallResult.Started, d.install(binary()))
            assertEquals(sha, opened.files.single().second)
        }
    }
}
