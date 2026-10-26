// @pkey-feature identity.attach
//
// `attach(confirm)` beyond what identity-attach.json and identity-attach-errors.json pin: the preview
// writes nothing, the confirm path rotates and stores the token and reports the subject, a Worker
// refusal is a typed `Refused` that keeps the token, and a product without the endpoint answers
// `Unavailable` and sends nothing.

package im.plrs.key.identity

import im.plrs.key.core.CoreContext
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.path
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class IdentityAttachTest {
    private val withAttach = """{"product":"djdl","services":{"identity":{"enabled":true,"account":true,""" +
        """"endpoints":{"attach":"https://key.plrs.im/djdl/identity/attach"}}}}"""
    private val noAccount = """{"product":"djdl","services":{"identity":{"enabled":true,"endpoints":{}}}}"""

    private class World(val core: CoreContext, val transport: ScriptedTransport, val store: InMemoryStore)

    private fun world(discovery: String, status: Int = 200, body: String = "{}", token: Boolean = true): World {
        val store = InMemoryStore("djdl", "dev1")
        if (token) runBlocking { store.setToken("pkeyt_old") }
        val transport = ScriptedTransport { r: PolarisRequest ->
            when (r.path) {
                "/djdl/.well-known/polaris.json" -> respond(200, discovery)
                "/djdl/identity/attach" -> respond(status, body)
                else -> respond(404)
            }
        }
        val core = CoreContext(
            CoreOptions(
                productSlug = "djdl", version = "1.0.0", pinnedKeys = emptyMap(), trustRefresh = false,
                store = store, transport = transport, clock = { 1_700_000_000L },
            ),
        )
        runBlocking { core.start() }
        return World(core, transport, store)
    }

    @Test
    fun thePreviewNamesTheLicenceAndWritesNothing() = runBlocking {
        val w = world(withAttach, body = """{"status":"confirm","license":{"id":"lic_1","tierId":"pro","name":"Ada"}}""")
        val got = IdentityClient(w.core).attach(false)
        assertEquals(AttachResult.Confirm(AttachLicense("lic_1", "pro", "Ada")), got)
        assertEquals("pkeyt_old", w.store.getToken())
        val sent = w.transport.requests().last()
        assertEquals("""{"confirm":false}""", String(sent.body!!))
        assertEquals("Bearer pkeyt_old", sent.headers["authorization"])
    }

    @Test
    fun confirmRotatesTheTokenAndReportsTheSubject() = runBlocking {
        val seen = mutableListOf<String?>()
        val w = world(withAttach, body = """{"token":"pkeyt_new","subject":"ps_abc","attached":"claimed"}""")
        val got = IdentityClient(w.core, onSubject = { seen += it }).attach(true)
        assertEquals(AttachResult.Ok("ps_abc", "claimed"), got)
        assertEquals("pkeyt_new", w.store.getToken())
        assertEquals("ps_abc", w.core.storedSubject())
        assertEquals(listOf<String?>("ps_abc"), seen)
    }

    @Test
    fun aRepeatedConfirmCarriesNoAttachedMarker() = runBlocking {
        val w = world(withAttach, body = """{"token":"pkeyt_new","subject":"ps_abc"}""")
        assertEquals(AttachResult.Ok("ps_abc", null), IdentityClient(w.core).attach(true))
    }

    @Test
    fun aRefusalIsATypedResultThatKeepsTheToken() = runBlocking {
        for ((status, body, code) in listOf(
            Triple(409, """{"error":{"code":"license_owned"}}""", "license_owned"),
            Triple(403, """{"error":{"code":"account_required"}}""", "account_required"),
            Triple(401, """{"error":"unauthorized"}""", "unauthorized"),
            Triple(502, "not json", "http_502"),
        )) {
            val w = world(withAttach, status = status, body = body)
            assertEquals(AttachResult.Refused(code, status), IdentityClient(w.core).attach(true))
            assertEquals("pkeyt_old", w.store.getToken())
        }
    }

    @Test
    fun aProductWithoutTheEndpointAnswersUnavailableAndSendsNothing() = runBlocking {
        val w = world(noAccount)
        assertEquals(AttachResult.Unavailable, IdentityClient(w.core).attach(true))
        assertTrue(w.transport.requests().none { it.path == "/djdl/identity/attach" })
    }

    @Test
    fun aDeviceWithNoTokenThrowsNoToken() = runBlocking {
        val w = world(withAttach, token = false)
        try {
            IdentityClient(w.core).attach(false)
            fail("expected no-token")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.noToken, e.code)
        }
        assertTrue(w.transport.requests().none { it.path == "/djdl/identity/attach" })
    }
}
