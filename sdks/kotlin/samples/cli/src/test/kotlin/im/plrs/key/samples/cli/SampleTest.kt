package im.plrs.key.samples.cli

import im.plrs.key.core.CoreOptions
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import im.plrs.key.license.LicenseClientOptions
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.PolarisKeyClientOptions
import java.io.ByteArrayOutputStream
import java.io.PrintStream
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The sample runs against a scripted Worker: status, a local override, usage. */
class SampleTest {
    private val now = 1_700_000_000L
    private val signer = TestSigner()

    private fun client(): PolarisKeyClient = runBlocking {
        val license = signer.licenseDoc("djdl", "dev1", now, entitlements = mapOf("pro" to JsonPrimitive(true)))
        val config = signer.configDoc("djdl", "dev1", now, config = mapOf("ui.theme" to JsonPrimitive("dark")))
        PolarisKeyClient.create(
            PolarisKeyClientOptions(
                core = CoreOptions(
                    productSlug = "djdl", version = "1.0.0", pinnedKeys = signer.trust, trustRefresh = false,
                    store = InMemoryStore("djdl", "dev1").also { it.setToken("pkeyt_held") }, clock = { now },
                    expectedServices = listOf(ServiceSlug.license, ServiceSlug.config),
                    transport = ScriptedTransport { r ->
                        when (r.path) {
                            "/djdl/license/document" -> respond(200, license)
                            "/djdl/config/document" -> respond(200, config)
                            else -> respond(404)
                        }
                    },
                ),
                license = LicenseClientOptions(fingerprint = false),
            ),
        )
    }

    private fun exec(c: PolarisKeyClient, vararg args: String): Pair<Int, String> {
        val buf = ByteArrayOutputStream()
        val code = runBlocking { run(c, args.toList(), PrintStream(buf)) }
        return code to buf.toString()
    }

    @Test
    fun commands() {
        val c = client()
        val (code, out) = exec(c, "status")
        assertEquals(0, code)
        assertTrue(out, out.contains("gate: ok") && out.contains("entitlements: pro"))
        assertEquals(0, exec(c, "set", "ui.theme", "\"light\"").first)
        assertTrue(exec(c, "config", "ui.theme").second.contains("\"light\" (local)"))
        assertEquals(64, exec(c, "bogus").first)
        assertEquals(mapOf("k1" to "abc", "k2" to "d=e"), parseTrust("k1=abc, k2=d=e"))
        c.close()
    }
}
