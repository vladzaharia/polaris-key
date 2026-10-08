// @pkey-feature core.store update.driver update.bootguard
//
// The JVM desktop entry point (UK-40, SP-K12): PolarisKeyDesktop fills in the keyring store (and
// supports(core.store) follows it), the desktop install driver over the client's own verified
// record and builds route, and the default slots and boot guard under the data directory. A host
// that sets its own store or driver keeps it.

package im.plrs.key.desktop

import im.plrs.key.core.CoreOptions
import im.plrs.key.sdk.PolarisKeyClientOptions
import im.plrs.key.core.DecisionRelease
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Feature
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
import im.plrs.key.update.InstallResult
import im.plrs.key.update.UpdateClientOptions
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PolarisKeyDesktopTest {
    private val product = TestSigner("pkey-test-prod")
    private val release = TestSigner("djdl-release")

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

    private fun options(update: UpdateClientOptions? = null, store: im.plrs.key.core.Store? = null) = PolarisKeyClientOptions(
        core = CoreOptions(
            productSlug = "djdl", version = "1.2.0", pinnedKeys = product.trust, trustRefresh = false,
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
}
