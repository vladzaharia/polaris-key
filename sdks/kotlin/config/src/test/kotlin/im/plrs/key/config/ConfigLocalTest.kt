// @pkey-feature config.resolve config.list config.schema config.local
//
// Persisted local overrides (notes/SDK-PARITY-PASS.md §3.11, `config.local`): set() beats a remote
// default and never an enforced or hidden entry, is checked against the catalog (or the document's
// type), survives a restart in its own file, and every change reaches the key's setting() and the
// changes flow.

package im.plrs.key.config

import im.plrs.key.core.CoreContext
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.FileStateSlot
import im.plrs.key.core.FileStore
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.MemoryStateSlot
import im.plrs.key.core.PolarisException
import im.plrs.key.core.StateSlot
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import java.nio.file.Files
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

class ConfigLocalTest {
    private val now = 1_700_000_000L
    private val signer = TestSigner()
    private val doc = signer.configDoc(
        "djdl", "dev1", now,
        config = mapOf("ui.theme" to JsonPrimitive("dark"), "run.concurrency" to JsonPrimitive(4), "admin.lock" to JsonPrimitive(true)),
        states = mapOf("admin.lock" to "enforced"),
    )
    private val catalog = """{"schemaVersion":1,"entries":[
        {"key":"ui.theme","kind":"config","label":"Theme","schema":{"type":"string","enum":["dark","light"]},"ui":{"widget":"select"}},
        {"key":"run.concurrency","kind":"config","label":"Workers","schema":{"type":"integer","minimum":1,"maximum":16}}]}"""

    private fun config(slot: StateSlot = MemoryStateSlot()): ConfigClient = runBlocking {
        val core = CoreContext(
            CoreOptions(
                productSlug = "djdl", version = "1.0.0", pinnedKeys = signer.trust, trustRefresh = false,
                store = InMemoryStore("djdl", "dev1").also { it.setToken("pkeyt_held") }, clock = { now },
                transport = ScriptedTransport { r ->
                    when (r.path) {
                        "/djdl/config/document" -> respond(200, doc)
                        "/djdl/config/schema" -> respond(200, catalog)
                        else -> respond(404)
                    }
                },
            ),
        )
        core.start()
        core.sync()
        ConfigClient(core, ConfigClientOptions(environment = emptyMap(), localStore = slot)).also { it.publish(emit = false) }
    }

    private suspend fun refused(code: String, body: suspend () -> Unit) {
        try {
            body()
            fail("expected $code")
        } catch (e: PolarisException) {
            assertEquals(code, e.code)
        }
    }

    @Test
    fun aLocalOverrideBeatsTheDefaultAndNeverAnEnforcedEntry() = runBlocking {
        val c = config()
        c.set("ui.theme", JsonPrimitive("light"))
        assertEquals(JsonPrimitive("light"), c.config("ui.theme", JsonPrimitive("x")))
        assertEquals(ConfigSource.local, c.configSource("ui.theme"))
        refused(ErrorCode.managedByAdmin) { c.set("admin.lock", JsonPrimitive(false)) }
        c.clear("ui.theme")
        assertEquals(ConfigSource.remoteDefault, c.configSource("ui.theme"))
    }

    @Test
    fun valuesAreCheckedAgainstTheCatalogOrTheDocumentsType() = runBlocking {
        val c = config()
        // Without a catalog: the document's JSON type.
        refused(ErrorCode.invalidOptions) { c.set("run.concurrency", JsonPrimitive("four")) }
        c.fetchCatalog()
        assertEquals("Theme", c.catalog?.entry("ui.theme")?.label)
        refused(ErrorCode.invalidOptions) { c.set("ui.theme", JsonPrimitive("neon")) }
        refused(ErrorCode.invalidOptions) { c.set("run.concurrency", JsonPrimitive(64)) }
        refused(ErrorCode.invalidOptions) { c.set("run.concurrency", JsonPrimitive(2.5)) }
        c.set("run.concurrency", JsonPrimitive(8))
        assertEquals(JsonPrimitive(8), c.config("run.concurrency", JsonPrimitive(0)))
    }

    @Test
    fun overridesSurviveARestartBesideTheStore() = runBlocking {
        val dir = Files.createTempDirectory("pkey-local").toFile()
        try {
            val core = CoreContext(CoreOptions(productSlug = "djdl", version = "1.0.0", pinnedKeys = signer.trust, store = FileStore("djdl", dir), transport = im.plrs.key.core.NoNetworkTransport))
            ConfigClient(core, ConfigClientOptions(environment = emptyMap())).set("ui.theme", JsonPrimitive("light"))
            val again = ConfigClient(core, ConfigClientOptions(environment = emptyMap()))
            assertEquals(mapOf("ui.theme" to JsonPrimitive("light")), again.localValues())
            assertEquals(JsonPrimitive("light"), again.config("ui.theme", JsonPrimitive("x")))
            assertEquals(true, java.io.File(dir, "local-config.json").isFile)
            // An explicit slot is honoured too.
            val slot = FileStateSlot(java.io.File(dir, "other.json"))
            ConfigClient(core, ConfigClientOptions(environment = emptyMap(), localStore = slot)).set("k", JsonPrimitive(1))
            assertEquals(true, java.io.File(dir, "other.json").isFile)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun aSettingAndTheChangesFlowFollowEveryChange() = runBlocking {
        val c = config()
        val theme = c.setting("ui.theme")
        assertEquals(JsonPrimitive("dark"), theme.value)
        val seen = mutableListOf<ConfigChange>()
        val job = launch { c.changes.collect { seen += it } }
        yield()
        c.set("ui.theme", JsonPrimitive("light"))
        assertEquals(JsonPrimitive("light"), theme.value)
        c.clear("ui.theme")
        assertEquals(JsonPrimitive("dark"), theme.value)
        c.set("run.concurrency", JsonPrimitive(2))
        yield()
        job.cancel()
        assertEquals(listOf("ui.theme" to ConfigSource.local, "ui.theme" to ConfigSource.remoteDefault, "run.concurrency" to ConfigSource.local), seen.map { it.key to it.source })
        assertNull(c.setting("absent").value)
    }
}
