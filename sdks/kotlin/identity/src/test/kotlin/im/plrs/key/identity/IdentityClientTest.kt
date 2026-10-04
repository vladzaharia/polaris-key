// @pkey-feature identity.devicecode
//
// RFC 8628 pacing and the prompt, beyond what the devicecode transcripts pin: `waitForSignIn`
// waits one interval before the first poll, lengthens the interval after a `slow_down` (by the
// server's interval, or by five seconds when a 429 carries none) and never shortens it, rides out
// a transient failure at the same interval, stops at expiry without asking the server, and stops
// when the coroutine is cancelled. Server seconds round UP; the device code is redacted.

package im.plrs.key.identity

import im.plrs.key.core.CoreContext
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.TokenSource
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.path
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class IdentityClientTest {
    private var clock = 1_700_000_000L
    private val start = """{"status":"pending","deviceCode":"dc_secret","userCode":"ABCD-EFGH",""" +
        """"verificationUri":"https://key.plrs.im/djdl/identity/auth/device",""" +
        """"verificationUriComplete":"https://key.plrs.im/djdl/identity/auth/device?user_code=ABCD-EFGH","expiresIn":600,"interval":1.5}"""

    private fun setup(polls: MutableList<() -> PolarisResponse>, services: List<ServiceSlug> = listOf(ServiceSlug.identity)):
        Triple<CoreContext, ScriptedTransport, InMemoryStore> {
        val store = InMemoryStore("djdl", "dev1")
        val transport = ScriptedTransport { r: PolarisRequest ->
            when (r.path) {
                "/djdl/identity/auth/device/start" -> respond(200, start)
                "/djdl/identity/auth/device/poll" -> polls.removeAt(0)()
                else -> respond(404)
            }
        }
        val core = CoreContext(
            CoreOptions(
                productSlug = "djdl", version = "1.0.0", pinnedKeys = emptyMap(), trustRefresh = false,
                store = store, transport = transport, clock = { clock }, expectedServices = services,
            ),
        )
        runBlocking { core.start() }
        return Triple(core, transport, store)
    }

    @Test
    fun thePromptRoundsUpAndRedactsTheDeviceCode() = runBlocking {
        val (core, transport, _) = setup(mutableListOf())
        val prompt = IdentityClient(core).beginSignIn("  Living room  ")
        assertEquals(2L, prompt.interval)
        assertEquals(600L, prompt.expiresIn)
        assertEquals(clock + 600, prompt.expiresAt)
        assertEquals("""{"deviceId":"dev1","deviceName":"Living room"}""", transport.requests().single().body!!.toString(Charsets.UTF_8))
        assertFalse(transport.requests().single().headers.containsKey("authorization"))
        assertTrue("[redacted]" in prompt.toString())
        assertFalse("dc_secret" in prompt.toString())
    }

    @Test
    fun waitForSignInPacesSlowsDownAndRidesOutFailures() = runBlocking {
        val polls = mutableListOf<() -> PolarisResponse>(
            { respond(200, """{"status":"pending"}""") },
            { respond(429, """{"status":"slow_down"}""") },
            { throw PolarisException(ErrorCode.networkError, "flaky") },
            { respond(503) },
            { respond(429, """{"status":"slow_down","interval":3}""") },
            { respond(200, """{"status":"ready","token":"pkeyt_signed_in"}""") },
        )
        val (core, _, store) = setup(polls)
        val slept = ArrayList<Long>()
        var acquired = 0
        val identity = IdentityClient(core, onAcquired = { acquired++ }) { s ->
            slept += s
            clock += s
        }
        val prompt = identity.beginSignIn()
        assertEquals(SignInResult.Ready, identity.waitForSignIn(prompt))
        // 2, then 2 (pending), then 2+5 after an interval-less slow_down, held through two
        // transient failures, and never shortened by a smaller server interval (3 < 7).
        assertEquals(listOf(2L, 2L, 7L, 7L, 7L, 7L), slept)
        assertEquals("pkeyt_signed_in", store.getToken())
        assertEquals(TokenSource.signin, core.tokenSource())
        assertEquals(1, acquired)
    }

    @Test
    fun waitForSignInStopsAtExpiryWithoutAskingTheServer() = runBlocking {
        val (core, transport, _) = setup(mutableListOf({ respond(200, """{"status":"pending"}""") }))
        val identity = IdentityClient(core) { s -> clock += s * 200 }
        val prompt = identity.beginSignIn()
        assertEquals(SignInResult.Expired, identity.waitForSignIn(prompt))
        assertEquals(2, transport.requests().size) // start + one poll; the second wait ran past expiry
    }

    @Test
    fun cancellingTheCoroutineStopsPolling() = runBlocking {
        val (core, transport, _) = setup(mutableListOf())
        val identity = IdentityClient(core) { awaitCancellation() }
        val prompt = identity.beginSignIn()
        val wait = async { identity.waitForSignIn(prompt) }
        wait.cancel()
        try {
            wait.await()
            fail("a cancelled wait returned")
        } catch (e: CancellationException) {
            // expected
        }
        assertEquals(1, transport.requests().size)
    }

    @Test
    fun aProductWithoutIdentityRefusesBeforeAnyRequest() = runBlocking {
        val (core, transport, _) = setup(mutableListOf(), services = listOf(ServiceSlug.license))
        try {
            IdentityClient(core).beginSignIn()
            fail("began without Identity")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.serviceUnavailable, e.code)
        }
        assertTrue(transport.requests().isEmpty())
    }

    @Test
    fun secondsHelpers() {
        assertEquals(1L, wholeSeconds(JsonPrimitive(0.5)))
        assertEquals(null, wholeSeconds(JsonPrimitive(0)))
        assertEquals(null, wholeSeconds(JsonPrimitive("5")))
        assertEquals(Int.MAX_VALUE.toLong(), wholeSeconds(JsonPrimitive(1e30)))
        assertEquals(1L, pollDelay(0, 600))
        assertEquals(10L, pollDelay(60, 10))
    }
}
