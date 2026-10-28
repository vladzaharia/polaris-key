// @pkey-feature config.resolve
//
// The D9 setting handle: value, source, locked, visibility, set, clear, on and flow.

package im.plrs.key.config

import im.plrs.key.core.CoreContext
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.FileStateSlot
import im.plrs.key.core.FileStore
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.MemoryStateSlot
import im.plrs.key.core.PolarisException
import im.plrs.key.core.SettingVisibility
import im.plrs.key.core.StateSlot
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test
import java.nio.file.Files

class ConfigSettingTest {
    private val now = 1_700_000_000L
    private val signer = TestSigner()
    private val doc = signer.configDoc(
        "djdl",
        "dev1",
        now,
        config = mapOf("ui.theme" to JsonPrimitive("dark"), "run.concurrency" to JsonPrimitive(4), "admin.lock" to JsonPrimitive(true)),
        states = mapOf("admin.lock" to "enforced"),
    )
    private val catalog = """{"schemaVersion":1,"entries":[
        {"key":"ui.theme","kind":"config","label":"Theme","schema":{"type":"string","enum":["dark","light"]},"ui":{"widget":"select"}},
        {"key":"run.concurrency","kind":"config","label":"Workers","schema":{"type":"integer","minimum":1,"maximum":16}}]}"""

    private fun config(slot: StateSlot = MemoryStateSlot()): ConfigClient = runBlocking {
        val core = CoreContext(
            CoreOptions(
                productSlug = "djdl",
                version = "1.0.0",
                pinnedKeys = signer.trust,
                trustRefresh = false,
                store = InMemoryStore("djdl", "dev1").also { it.setToken("pkeyt_held") },
                clock = { now },
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

    @Test
    fun theHandleReadsWritesAndFollowsAKey() = runBlocking {
        val c = config()
        val theme = c.setting("ui.theme")
        assertEquals(JsonPrimitive("dark"), theme.value)
        assertEquals(ConfigSource.remoteDefault, theme.source)
        assertEquals(false, theme.locked)
        assertEquals(SettingVisibility.editable, theme.visibility)
        val seen = mutableListOf<ConfigChange>()
        val sub = theme.on { seen += it }
        theme.set(JsonPrimitive("light"))
        assertEquals(JsonPrimitive("light"), theme.flow.value)
        assertEquals(ConfigSource.local, theme.source)
        theme.clear()
        assertEquals(JsonPrimitive("dark"), theme.value)
        sub.cancel()
        theme.set(JsonPrimitive("light"))
        assertEquals(
            listOf(JsonPrimitive("light") to ConfigSource.local, JsonPrimitive("dark") to ConfigSource.remoteDefault),
            seen.map {
                it.value to
                    it.source
            },
        )
        assertEquals(true, sub.isCancelled)
    }

    @Test
    fun anEnforcedKeyIsLockedReadonlyAndRefusesSet() = runBlocking {
        val lock = config().setting("admin.lock")
        assertEquals(true, lock.locked)
        assertEquals(ConfigSource.enforced, lock.source)
        assertEquals(SettingVisibility.readonly, lock.visibility)
        try {
            lock.set(JsonPrimitive(false))
            fail("expected managed_by_admin")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.managedByAdmin, e.code)
        }
        val absent = config().setting("absent")
        assertNull(absent.value)
        assertEquals(ConfigSource.fallback, absent.source)
    }
}
