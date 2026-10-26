// @pkey-feature identity.devicecode identity.toggle
//
// RFC 8628 pacing and the prompt, beyond what the devicecode transcripts pin: `signIn.start` and
// `session.wait()`: it waits one interval before the first poll, lengthens the interval after a `slow_down` (by the
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
        val prompt = IdentityClient(core).signIn.start(SignInOptions(deviceName = "  Living room  ")).prompt
        assertEquals(2L, prompt.interval)
        assertEquals(600L, prompt.expiresIn)
        assertEquals(clock + 600, prompt.expiresAt)
        assertEquals("""{"deviceId":"dev1","deviceName":"Living room"}""", transport.requests().single().body!!.toString(Charsets.UTF_8))
        assertFalse(transport.requests().single().headers.containsKey("authorization"))
        assertTrue("[redacted]" in prompt.toString())
        assertFalse("dc_secret" in prompt.toString())
    }

    @Test
    fun waitPacesSlowsDownAndRidesOutFailures() = runBlocking {
        val polls = mutableListOf<() -> PolarisResponse>(
            { respond(200, """{"status":"pending"}""") },
            { respond(429, """{"status":"slow_down"}""") },
            { throw PolarisException(ErrorCode.networkError, "flaky") },
            { respond(503) },
            { respond(429, """{"status":"slow_down","interval":3}""") },
            { respond(200, """{"status":"ready","token":"pkeyt_signed_in","subject":"ps_""" + "a".repeat(32) + """"}""") },
        )
        val (core, _, store) = setup(polls)
        val slept = ArrayList<Long>()
        var acquired = 0
        val subjects = ArrayList<String?>()
        val identity = IdentityClient(core, onAcquired = { acquired++ }, onSubject = { subjects += it }, sleep = { s ->
            slept += s
            clock += s
        })
        val session = identity.signIn.start()
        assertEquals(SignInOutcome.SignedIn("ps_" + "a".repeat(32)), session.wait())
        assertEquals(SignInOutcome.SignedIn("ps_" + "a".repeat(32)), session.outcome)
        assertEquals(listOf<String?>("ps_" + "a".repeat(32)), subjects)
        assertEquals("ps_" + "a".repeat(32), core.storedSubject())
        // 2, then 2 (pending), then 2+5 after an interval-less slow_down, held through two
        // transient failures, and never shortened by a smaller server interval (3 < 7).
        assertEquals(listOf(2L, 2L, 7L, 7L, 7L, 7L), slept)
        assertEquals("pkeyt_signed_in", store.getToken())
        assertEquals(TokenSource.signin, core.tokenSource())
        assertEquals(1, acquired)
    }

    @Test
    fun waitStopsAtExpiryWithoutAskingTheServer() = runBlocking {
        val (core, transport, _) = setup(mutableListOf({ respond(200, """{"status":"pending"}""") }))
        val identity = IdentityClient(core, sleep = { s -> clock += s * 200 })
        assertEquals(SignInOutcome.Expired, identity.signIn.start().wait())
        assertEquals(2, transport.requests().size) // start + one poll; the second wait ran past expiry
    }

    @Test
    fun cancellingTheCoroutineStopsPolling() = runBlocking {
        val (core, transport, _) = setup(mutableListOf())
        val identity = IdentityClient(core, sleep = { awaitCancellation() })
        val session = identity.signIn.start()
        val wait = async { session.wait() }
        wait.cancel()
        try {
            wait.await()
            fail("a cancelled wait returned")
        } catch (e: CancellationException) {
            // expected: the caller's cancellation throws and the session keeps going
        }
        assertEquals(SignInOutcome.Pending(2), session.outcome)
        assertEquals(1, transport.requests().size)
    }

    @Test
    fun sessionCancelEndsTheWaitAsCancelled() = runBlocking {
        val (core, transport, _) = setup(mutableListOf())
        val session = IdentityClient(core, sleep = { awaitCancellation() }).signIn.start()
        val wait = async(kotlinx.coroutines.Dispatchers.Default) { session.wait() }
        kotlinx.coroutines.delay(50)
        session.cancel()
        assertEquals(SignInOutcome.Cancelled, wait.await())
        assertEquals(SignInOutcome.Cancelled, session.wait())
        assertEquals(SignInOutcome.Cancelled, session.outcome)
        assertEquals(1, transport.requests().size)
    }

    @Test
    fun waitOncePollsOnceAndReportsPendingAndSlowDown() = runBlocking {
        val polls = mutableListOf<() -> PolarisResponse>(
            { respond(200, """{"status":"pending"}""") },
            { respond(429, """{"status":"slow_down","interval":9}""") },
            { respond(503) },
        )
        val (core, transport, _) = setup(polls)
        val session = IdentityClient(core, sleep = { fail("once does not pause") }).signIn.start()
        assertEquals(SignInOutcome.Pending(2), session.wait(once = true))
        assertEquals(SignInOutcome.Pending(9, slowDown = true), session.wait(once = true))
        assertEquals(SignInOutcome.Pending(9), session.outcome)
        try {
            session.wait(once = true)
            fail("a 5xx poll answered")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.serverError, e.code)
        }
        assertEquals(4, transport.requests().size)
    }

    @Test
    fun aDenyOrFailureIsATypedSignInError() = runBlocking {
        for ((body, code) in listOf(
            """{"status":"error","reason":"access_denied"}""" to ErrorCode.signInDenied,
            """{"status":"error"}""" to ErrorCode.signInFailed,
        )) {
            val (core, _, _) = setup(mutableListOf({ respond(200, body) }))
            val session = IdentityClient(core, sleep = {}).signIn.start()
            try {
                session.wait()
                fail("a refused sign-in returned an outcome")
            } catch (e: SignInError) {
                assertEquals(code, e.code)
            }
            // A settled session answers the same again.
            try {
                session.wait()
                fail("settled")
            } catch (e: SignInError) {
                assertEquals(code, e.code)
            }
        }
    }

    @Test
    fun reopenUsesTheOpenerAndAnswersFalseWithout() = runBlocking {
        val (core, _, _) = setup(mutableListOf())
        val opened = ArrayList<String>()
        val session = IdentityClient(core).signIn.start(SignInOptions(opener = { opened += it; true }))
        assertEquals(listOf("https://key.plrs.im/djdl/identity/auth/device?user_code=ABCD-EFGH"), opened)
        assertTrue(session.reopen())
        assertEquals(2, opened.size)
        assertFalse(IdentityClient(core).signIn.start().reopen())
    }

    @Test
    fun aProductWithoutIdentityRefusesBeforeAnyRequest() = runBlocking {
        val (core, transport, _) = setup(mutableListOf(), services = listOf(ServiceSlug.license))
        try {
            IdentityClient(core).signIn.start()
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
