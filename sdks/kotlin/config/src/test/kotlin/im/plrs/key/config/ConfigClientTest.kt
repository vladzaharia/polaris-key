// @pkey-feature config.secret config.resolve config.list config.schema config.mint
//
// The config client over a signed document it verified itself: secrets are read off the VERIFIED
// document only (strings only, never enumerated), resolution honours the management state, the
// catalog fetch never throws, and edge-mint refuses before any request when it must.

package im.plrs.key.config

import im.plrs.key.core.CoreContext
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class ConfigClientTest {
    private val now = 1_700_000_000L
    private val signer = TestSigner()

    private fun client(
        options: ConfigClientOptions = ConfigClientOptions(environment = emptyMap()),
        services: List<ServiceSlug>? = null,
        handler: (PolarisRequest) -> PolarisResponse,
    ): Pair<ConfigClient, ScriptedTransport> = runBlocking {
        val store = InMemoryStore("djdl", "dev1").also { it.setToken("pkeyt_held") }
        val transport = ScriptedTransport(handler)
        val core = CoreContext(
            CoreOptions(
                productSlug = "djdl", version = "1.0.0", pinnedKeys = signer.trust, trustRefresh = false,
                store = store, transport = transport, clock = { now }, expectedServices = services,
            ),
        )
        core.start()
        core.sync()
        ConfigClient(core, options) to transport
    }

    private val doc = signer.configDoc(
        "djdl", "dev1", now,
        config = mapOf("ui.theme" to JsonPrimitive("dark"), "run.concurrency" to JsonPrimitive(4), "secret.flag" to JsonPrimitive(true)),
        secrets = mapOf("api.key" to JsonPrimitive("s3cret"), "api.number" to JsonPrimitive(7)),
        states = mapOf("ui.theme" to "enforced", "secret.flag" to "hidden"),
    )

    private fun documents(r: PolarisRequest): PolarisResponse = when (r.path) {
        "/djdl/config/document" -> respond(200, doc)
        else -> respond(404)
    }

    @Test
    fun secretsComeOffTheVerifiedDocumentAsStringsOnly() = runBlocking {
        val (config, _) = client(handler = ::documents)
        assertEquals("s3cret", config.secret("api.key"))
        assertNull(config.secret("api.number"))
        assertNull(config.secret("absent"))
        // A secret is never a config value, and is never listed.
        assertEquals(JsonPrimitive("fallback"), config.config("api.key", JsonPrimitive("fallback")))
        assertTrue(config.listUserConfig().none { it.key == "api.key" })
    }

    @Test
    fun withoutADocumentThereAreNoSecrets() = runBlocking {
        val (config, _) = client { respond(404) }
        assertNull(config.secret("api.key"))
        assertNull(config.schemaVersion())
    }

    @Test
    fun resolutionHonoursTheManagementState() = runBlocking {
        val (config, _) = client(
            ConfigClientOptions(
                localOverrides = mapOf("ui.theme" to JsonPrimitive("light"), "run.concurrency" to JsonPrimitive(8)),
                environment = mapOf("PKEY_CONFIG_secret__flag" to "false"),
            ),
            handler = ::documents,
        )
        assertEquals(JsonPrimitive("dark"), config.config("ui.theme", JsonPrimitive("system")))
        assertEquals(ConfigSource.enforced, config.configSource("ui.theme"))
        assertEquals(JsonPrimitive(8), config.config("run.concurrency", JsonPrimitive(1)))
        assertEquals(ConfigSource.local, config.configSource("run.concurrency"))
        assertEquals(JsonPrimitive(true), config.config("secret.flag", JsonPrimitive(false)))
        assertEquals(ConfigSource.hidden, config.configSource("secret.flag"))
        assertEquals(ConfigSource.fallback, config.configSource("absent"))
        assertEquals(
            listOf(UserConfigEntry("run.concurrency", JsonPrimitive(8), false), UserConfigEntry("ui.theme", JsonPrimitive("dark"), true)),
            config.listUserConfig().sortedBy { it.key },
        )
        assertEquals(1L, config.schemaVersion())
    }

    @Test
    fun theCatalogFetchNeverThrows() = runBlocking {
        val catalog = """{"schemaVersion":2,"entries":[]}"""
        val (ok, _) = client { r -> if (r.path == "/djdl/config/schema") respond(200, catalog) else respond(404) }
        assertEquals(catalog, ok.fetchSchema()!!.toString(Charsets.UTF_8))
        val (notCatalog, _) = client { r -> if (r.path == "/djdl/config/schema") respond(200, """{"entries":{}}""") else respond(404) }
        assertNull(notCatalog.fetchSchema())
        val (fractional, _) = client { r -> if (r.path == "/djdl/config/schema") respond(200, """{"schemaVersion":1.5,"entries":[]}""") else respond(404) }
        assertNull(fractional.fetchSchema())
        val (down, _) = client { r -> if (r.path == "/djdl/config/schema") throw PolarisException(ErrorCode.networkError, "x") else respond(404) }
        assertNull(down.fetchSchema())
        // A product without Config is not even probed (D-21).
        val (off, transport) = client(services = listOf(ServiceSlug.license)) { respond(200, catalog) }
        val before = transport.requests().size
        assertNull(off.fetchSchema())
        assertEquals(before, transport.requests().size)
    }

    @Test
    fun edgeMintRefusesBeforeAnyRequest() = runBlocking {
        val (config, transport) = client { respond(404) }
        val before = transport.requests().size
        for (bad in listOf("", "../x", "UPPER", "a/b", "a%2Fb")) {
            try {
                config.mintToken(bad)
                fail("minted \"$bad\"")
            } catch (e: PolarisException) {
                assertEquals(ErrorCode.badRequest, e.code)
            }
        }
        val (off, _) = client(services = listOf(ServiceSlug.license)) { respond(404) }
        try {
            off.mintToken("recipe")
            fail("minted without Config")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.serviceUnavailable, e.code)
        }
        assertEquals(before, transport.requests().size)
    }

    @Test
    fun concurrentMintsShareOneRequestAndTheTokenIsRedacted() = runBlocking {
        var mints = 0
        val (config, _) = client { r ->
            if (r.path == "/djdl/config/mint/recipe/token") {
                mints++
                respond(200, """{"token":"third-party-secret","expiresAt":${now + 600}}""")
            } else {
                respond(404)
            }
        }
        val a = config.mintToken("recipe")
        val b = config.mintToken("recipe")
        assertEquals(a, b)
        assertEquals(1, mints)
        assertTrue("[redacted]" in a.toString())
        assertTrue("third-party-secret" !in a.toString())
    }
}
