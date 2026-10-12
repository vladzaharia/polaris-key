// @pkey-feature core.store update.driver update.bootguard
//
// The JVM desktop entry point (UK-40, SP-K12): PolarisKeyDesktop fills in the keyring store (and
// supports(core.store) follows it), the desktop install driver over the client's own verified
// record and builds route, and the default slots and boot guard under the data directory. A host
// that sets its own store or driver keeps it. State belongs to one control plane (SP-41): over one
// explicit data directory production keeps the directory itself and every other `baseUrl` gets its own
// directory beneath it, so two control planes share no token, device id, cache, installer, slot or
// guard file.

package im.plrs.key.desktop

import im.plrs.key.core.CacheRecord
import im.plrs.key.core.CoreOptions
import im.plrs.key.sdk.PolarisKeyClientOptions
import im.plrs.key.core.DecisionRelease
import im.plrs.key.core.DocumentSlice
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Feature
import im.plrs.key.core.FileStore
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.KeyringBackend
import im.plrs.key.core.KeyringStore
import im.plrs.key.core.NoKeyring
import im.plrs.key.core.StoreBackend
import im.plrs.key.core.Support
import im.plrs.key.core.UnsupportedReason
import im.plrs.key.core.UpdateCheck
import im.plrs.key.core.UpdateDecision
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.update.BootGuardState
import im.plrs.key.update.DesktopInstallDriver
import im.plrs.key.update.InstallResult
import im.plrs.key.update.SlotMeta
import im.plrs.key.update.UpdateClientOptions
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PolarisKeyDesktopTest {
    private val product = TestSigner("pkey-test-prod")
    private val release = TestSigner("djdl-release")
    private val localUrl = "http://localhost:8787"
    private val otherLocalUrl = "http://localhost:8788"

    private class MapKeyring : KeyringBackend {
        val entries = HashMap<String, String>()
        override fun unavailable(): String? = null
        override fun get(service: String, account: String): String? = entries["$service/$account"]
        override fun set(service: String, account: String, secret: String) {
            entries["$service/$account"] = secret
        }
        override fun delete(service: String, account: String) {
            entries.remove("$service/$account")
        }
    }

    private fun tempDir(): File = Files.createTempDirectory("pkey-desktop-sdk").toFile().also { it.deleteOnExit() }

    private fun options(
        update: UpdateClientOptions? = null,
        store: im.plrs.key.core.Store? = null,
        baseUrl: String = "https://key.plrs.im",
    ) = PolarisKeyClientOptions(
        core = CoreOptions(
            productSlug = "djdl", baseUrl = baseUrl, version = "1.2.0", pinnedKeys = product.trust, trustRefresh = false,
            store = store, transport = ScriptedTransport { ScriptedTransport.respond(404) },
        ),
        update = update,
    )

    @Test
    fun theTokenGoesToTheKeyringAndSupportsSaysSo() = runBlocking {
        val dir = tempDir()
        val ring = MapKeyring()
        val client = PolarisKeyDesktop.create(options(), DesktopOptions(dataDirectory = dir, keyring = ring))
        assertTrue(client.core.store is KeyringStore)
        client.core.setToken("pkeyt_desktop")
        assertEquals("pkeyt_desktop", ring.entries["pkey:djdl/device-token"])
        assertFalse(File(dir, "token").exists())
        assertEquals(StoreBackend.keyring, client.storeStatus()?.backend)
        assertTrue(File(dir, "device-id").isFile)
        if (client.supports(Feature.coreStore) !is Support.Supported) throw AssertionError("core.store is supported over a reachable keyring")
    }

    @Test
    fun localClientUsesAHostScopedKeyringService() = runBlocking {
        val dir = tempDir()
        val ring = MapKeyring()
        val client = PolarisKeyDesktop.create(
            options(baseUrl = localUrl),
            DesktopOptions(dataDirectory = dir, keyring = ring),
        )
        client.core.setToken("pkeyt_local")
        assertEquals("djdl@localhost_8787", client.core.storageNamespace)
        assertEquals("pkeyt_local", ring.entries["pkey:djdl@localhost_8787/device-token"])
        // Its files sit beneath the explicit directory, not in it: that directory is production's.
        assertTrue(File(dir, "djdl@localhost_8787/device-id").isFile)
        assertFalse(File(dir, "device-id").exists())
    }

    @Test
    fun withoutAKeyringTheTokenStaysInTheFileAndTheNaIsDependency() = runBlocking {
        val dir = tempDir()
        val client = PolarisKeyDesktop.create(options(), DesktopOptions(dataDirectory = dir, keyring = NoKeyring("java-keyring is not on the classpath")))
        client.core.setToken("pkeyt_file")
        assertTrue(File(dir, "token").isFile)
        assertEquals(StoreBackend.file, client.storeStatus()?.backend)
        val na = client.supports(Feature.coreStore) as Support.Unavailable
        assertEquals(UnsupportedReason.dependency, na.unsupported.reason)
    }

    @Test
    fun theDesktopArtifactBringsJavaKeyring() {
        // SP-50: polaris-key-desktop carries java-keyring at runtime (this test classpath has it only
        // through the module's runtimeOnly dependency), so the default keyring is never "missing".
        assertTrue(im.plrs.key.core.JavaKeyringBackend.onClasspath)
        val store = PolarisKeyDesktop.store("djdl", DesktopOptions(dataDirectory = tempDir()))
        val why = store.keyringUnavailable()
        assertFalse(why ?: "", (why ?: "").contains("not on the classpath"))
    }

    @Test
    fun aHostStoreIsKept() = runBlocking {
        val mine = InMemoryStore("djdl")
        val client = PolarisKeyDesktop.client(options(store = mine), DesktopOptions(dataDirectory = tempDir(), keyring = MapKeyring()))
        assertTrue(client.core.store === mine)
    }

    @Test
    fun theDesktopDriverIsWiredOverTheClient() = runBlocking {
        val client = PolarisKeyDesktop.create(
            options(UpdateClientOptions(pinnedReleaseKeys = release.trust)),
            DesktopOptions(dataDirectory = tempDir(), keyring = MapKeyring(), opener = { _, _ -> throw AssertionError("nothing to open") }),
        )
        val none = UpdateCheck("stable", UpdateDecision.None("up-to-date", false, false), UpdateCheck.FeedSource.network, UpdateCheck.RecordSource.none, emptyList())
        assertEquals(InstallResult.NothingToInstall, client.update.install(none))
        // A binary decision asks the client's own releaseRecord(), which refuses here (no Release
        // service is advertised): the refusal comes back typed, nothing is fetched or opened.
        val binary = UpdateCheck(
            "stable", UpdateDecision.Binary("download", DecisionRelease("1.4.0", 14, "a".repeat(64)), "macos-arm64", false, false, emptyList(), false),
            UpdateCheck.FeedSource.network, UpdateCheck.RecordSource.network, emptyList(),
        )
        val failed = client.update.install(binary) as InstallResult.Failed
        assertEquals(ErrorCode.serviceUnavailable, failed.code)
    }

    @Test
    fun aHostDriverIsKept() = runBlocking {
        var called = false
        val client = PolarisKeyDesktop.create(
            options(UpdateClientOptions(pinnedReleaseKeys = release.trust, installDriver = { called = true; InstallResult.Started })),
            DesktopOptions(dataDirectory = tempDir(), keyring = MapKeyring()),
        )
        val none = UpdateCheck("stable", UpdateDecision.None("up-to-date", false, false), UpdateCheck.FeedSource.network, UpdateCheck.RecordSource.none, emptyList())
        assertEquals(InstallResult.Started, client.update.install(none))
        assertTrue(called)
    }

    @Test
    fun theBootGuardRunsOverTheDefaultSlots() = runBlocking {
        val dir = tempDir()
        val desktop = DesktopOptions(dataDirectory = dir, keyring = MapKeyring())
        val guard = PolarisKeyDesktop.bootGuard("djdl", "1.2.0", desktop)
        assertEquals(im.plrs.key.core.BootEvent.GuardResult.ok, guard.run().result)
        assertEquals(File(dir, "updates/slots"), PolarisKeyDesktop.slots("djdl", desktop).root)
    }

    @Test
    fun anExplicitDirectoryIsProductionsAndEveryOtherControlPlaneNestsBeneathIt() {
        val base = tempDir()
        val desktop = DesktopOptions(dataDirectory = base, keyring = MapKeyring())
        // Production keeps the layout every earlier build wrote: the directory itself.
        for (production in listOf(null, "https://key.plrs.im", "https://KEY.PLRS.IM:443/")) {
            assertEquals("production: $production", base, PolarisKeyDesktop.dataDirectory("djdl", desktop, production))
        }
        // Any other control plane, port included, has a directory of its own below it.
        val local = File(base, "djdl@localhost_8787")
        assertEquals(local, PolarisKeyDesktop.dataDirectory("djdl", desktop, localUrl))
        assertEquals(File(base, "djdl@localhost_8788"), PolarisKeyDesktop.dataDirectory("djdl", desktop, otherLocalUrl))
        assertEquals(File(base, "djdl@key.example.com"), PolarisKeyDesktop.dataDirectory("djdl", desktop, "https://key.example.com"))
        // The store, the slots and the guard's state follow it, and the keyring service names the same control plane.
        val store = PolarisKeyDesktop.store("djdl", desktop, localUrl)
        assertEquals(local, store.directory)
        assertEquals("pkey:djdl@localhost_8787", store.service)
        assertEquals(File(base, "updates/slots"), PolarisKeyDesktop.slots("djdl", desktop).root)
        assertEquals(File(local, "updates/slots"), PolarisKeyDesktop.slots("djdl", desktop, localUrl).root)
    }

    @Test
    fun withoutAnExplicitDirectoryTheDefaultOneIsPerControlPlane() {
        val desktop = DesktopOptions(keyring = MapKeyring())
        assertEquals(FileStore.defaultDirectory("djdl"), PolarisKeyDesktop.dataDirectory("djdl", desktop))
        assertEquals(FileStore.defaultDirectory("djdl@localhost_8787"), PolarisKeyDesktop.dataDirectory("djdl", desktop, localUrl))
        assertNotEquals(PolarisKeyDesktop.dataDirectory("djdl", desktop), PolarisKeyDesktop.dataDirectory("djdl", desktop, localUrl))
    }

    @Test
    fun controlPlanesOverOneExplicitDirectoryShareNoFile() = runBlocking {
        val base = tempDir()
        // No keyring, so each token is the 0600 file the fallback writes: the place two clients could meet.
        val desktop = DesktopOptions(dataDirectory = base, keyring = NoKeyring("no keyring in this test"))
        val dirs = listOf(base, File(base, "djdl@localhost_8787"), File(base, "djdl@localhost_8788"))
        val clients = listOf("https://key.plrs.im", localUrl, otherLocalUrl).map { url ->
            PolarisKeyDesktop.create(options(UpdateClientOptions(pinnedReleaseKeys = release.trust), baseUrl = url), desktop)
        }
        clients.forEachIndexed { i, client ->
            client.core.setToken("pkeyt_$i")
            client.core.store.writeCache(CacheRecord(trustJws = "a.b.c", docs = mapOf(DocumentSlice.license to "d.e.f$i")))
            File(dirs[i], "updates/installer/djdl-$i.dmg").apply {
                parentFile.mkdirs()
                writeText("installer $i")
            }
        }
        val ids = clients.map { it.core.store.getDeviceId() }
        assertEquals("one device id per control plane", 3, ids.toSet().size)
        clients.forEachIndexed { i, client ->
            // Each control plane's token, device id and cache are in its own directory...
            assertEquals("pkeyt_$i", File(dirs[i], "token").readText())
            assertEquals(ids[i], File(dirs[i], "device-id").readText().trim())
            assertTrue(File(dirs[i], "cache.json").readText().contains("d.e.f$i"))
            // ...and read back through its own client, never another's.
            assertEquals("pkeyt_$i", client.core.store.getToken())
            assertEquals("d.e.f$i", client.core.store.readCache()?.docs?.get(DocumentSlice.license))
        }
        // The explicit directory holds production's files; the others' are one level below it.
        assertEquals(
            setOf("token", "device-id", "cache.json", "updates", "djdl@localhost_8787", "djdl@localhost_8788"),
            base.list()!!.toSet(),
        )
        // Installers are per control plane as well: a launch's cleanup() of one removes only its own.
        val removed = (clients[1].update.installDriver as DesktopInstallDriver).cleanup()
        assertEquals(listOf(File(dirs[1], "updates/installer/djdl-1.dmg")), removed)
        assertTrue(File(dirs[0], "updates/installer/djdl-0.dmg").isFile)
        assertTrue(File(dirs[2], "updates/installer/djdl-2.dmg").isFile)
    }

    @Test
    fun anUpdateStagedForOneControlPlaneIsNeverAppliedForAnother() = runBlocking {
        val base = tempDir()
        val desktop = DesktopOptions(dataDirectory = base, keyring = MapKeyring())
        val bytes = ByteArray(64) { it.toByte() }
        val payload = File(tempDir(), "payload.bin").apply { writeBytes(bytes) }
        val sha256 = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 0xff) }
        PolarisKeyDesktop.slots("djdl", desktop, localUrl).stage(payload, SlotMeta(version = "1.3.0", sha256 = sha256, size = bytes.size.toLong()))

        // Neither production nor the other local control plane has anything staged: their launches are ordinary ones.
        assertNull(PolarisKeyDesktop.slots("djdl", desktop).staged())
        assertNull(PolarisKeyDesktop.slots("djdl", desktop, otherLocalUrl).staged())
        val production = PolarisKeyDesktop.bootGuard("djdl", "1.2.0", desktop).run()
        assertEquals(im.plrs.key.core.BootEvent.GuardResult.ok, production.result)
        assertFalse(production.restart)
        // The control plane it was staged for applies it, and keeps the swap's state to itself.
        val applied = PolarisKeyDesktop.bootGuard("djdl", "1.2.0", desktop, baseUrl = localUrl).run()
        assertEquals(im.plrs.key.core.BootEvent.GuardResult.applied, applied.result)
        assertTrue(applied.restart)
        assertEquals("1.3.0", PolarisKeyDesktop.slots("djdl", desktop, localUrl).current()?.version)
        assertNull(PolarisKeyDesktop.slots("djdl", desktop).current())
        assertEquals("applied", BootGuardState.parse(File(base, "djdl@localhost_8787/updates/state.json").readText()).notice)
        assertNull(BootGuardState.parse(File(base, "updates/state.json").readText()).notice)
        assertFalse(File(base, "djdl@localhost_8788").exists())
    }
}
