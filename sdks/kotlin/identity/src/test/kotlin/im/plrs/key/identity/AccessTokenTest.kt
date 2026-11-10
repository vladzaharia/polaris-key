// @pkey-feature identity.accesstoken
//
// `identity.accessToken()` beyond what identity-access-token.json pins (that file replays in
// :conformance, every step with `refresh`): the discovery gate, no token, the exchange form, the
// 60 second reuse margin, the cache bound to the device token (a held token and an exchange in
// flight both carry it), single flight, failures not cached, a 429's wait honoured without a
// request, the own-origin pin, no redirect, the 8 KiB cap and the clear at sign-out. The clock is
// injected; nothing here reads the wall clock.

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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class AccessTokenTest {
    private val tokenUrl = "https://key.plrs.im/djdl/identity/token"

    private fun discovery(accessToken: Boolean = true, endpoint: String = tokenUrl) =
        """{"product":"djdl","services":{"identity":{"enabled":true,"account":true,"accessToken":$accessToken,""" +
            """"endpoints":{"token":"$endpoint","signout":"https://key.plrs.im/djdl/identity/signout"}}}}"""

    private fun jws(n: Int = 40) = "a".repeat(n - 4) + ".b.c"

    private fun grant(token: String = jws(), expiresIn: Int = 600) =
        """{"access_token":"$token","issued_token_type":"urn:ietf:params:oauth:token-type:access_token",""" +
            """"token_type":"Bearer","expires_in":$expiresIn,"scope":""}"""

    private class World(val core: CoreContext, val client: IdentityClient, val transport: ScriptedTransport, val store: InMemoryStore) {
        @Volatile var now = 1_000L
        val exchanges = AtomicInteger()
        suspend fun posts(): List<PolarisRequest> = transport.requests().filter { it.path == "/djdl/identity/token" }
    }

    private fun world(
        discovery: String = discovery(),
        token: String? = "pkeyt_A",
        exchange: (World, PolarisRequest) -> im.plrs.key.core.PolarisResponse = { _, _ -> respond(200, grant()) },
    ): World {
        lateinit var w: World
        val store = InMemoryStore("djdl", "dev1")
        if (token != null) runBlocking { store.setToken(token) }
        val transport = ScriptedTransport { r: PolarisRequest ->
            when (r.path) {
                "/djdl/.well-known/polaris.json" -> respond(200, discovery)
                "/djdl/identity/token" -> exchange(w, r).also { w.exchanges.incrementAndGet() }
                "/djdl/identity/signout" -> respond(200, """{"released":false}""")
                else -> respond(404)
            }
        }
        val core = CoreContext(
            CoreOptions(
                productSlug = "djdl",
                version = "1.0.0",
                pinnedKeys = emptyMap(),
                trustRefresh = false,
                store = store,
                transport = transport,
                clock = { w.now },
            ),
        )
        runBlocking { core.start() }
        w = World(core, IdentityClient(core), transport, store)
        return w
    }

    private suspend fun World.refusal(refresh: Boolean = false): PolarisException =
        runCatching { client.accessToken(refresh) }.exceptionOrNull() as? PolarisException ?: error("expected a refusal")

    @Test
    fun theFormIsExactAndCarriesNoAuthorization() = runBlocking {
        val w = world()
        val got = w.client.accessToken()
        assertEquals("Bearer", got.tokenType)
        assertEquals(600L, got.expiresIn)
        assertEquals(1_600L, got.expiresAt)
        val sent = w.posts().single()
        assertEquals(
            "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange&client_id=djdl&subject_token=pkeyt_A" +
                "&subject_token_type=urn%3Apolaris-key%3Atoken-type%3Adevice" +
                "&requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token",
            String(sent.body!!),
        )
        assertEquals("application/x-www-form-urlencoded", sent.headers["content-type"])
        assertNull(sent.headers.keys.firstOrNull { it.equals("authorization", true) })
        assertNotNull(sent.headers.entries.firstOrNull { it.key.equals("x-pkey-device", true) })
        assertFalse(sent.followRedirects)
        assertFalse(got.toString().contains(got.accessToken))
    }

    @Test
    fun discoveryGatesItAndNothingIsSent() = runBlocking {
        val w = world(discovery(accessToken = false))
        assertEquals(ErrorCode.serviceUnavailable, w.refusal().code)
        assertTrue(w.posts().isEmpty())
    }

    @Test
    fun noDeviceTokenIsNoTokenBeforeAnyRequest() = runBlocking {
        val w = world(token = null)
        assertEquals(ErrorCode.noToken, w.refusal().code)
        assertTrue(w.posts().isEmpty())
    }

    @Test
    fun aHeldTokenIsReusedUntilSixtySecondsBeforeItExpires() = runBlocking {
        val w = world()
        w.client.accessToken()
        w.now = 1_000 + 539
        val again = w.client.accessToken()
        assertEquals(61L, again.expiresIn)
        assertEquals(1, w.posts().size)
        w.now = 1_000 + 540
        w.client.accessToken()
        assertEquals(2, w.posts().size)
        // refresh skips the held token.
        w.client.accessToken(refresh = true)
        assertEquals(3, w.posts().size)
    }

    @Test
    fun aReplacedDeviceTokenIsAMissAndGetsItsOwnToken() = runBlocking {
        val w = world(exchange = { _, r -> respond(200, grant(if (String(r.body!!).contains("pkeyt_B")) jws(41) else jws(40))) })
        val a = w.client.accessToken()
        w.core.setToken("pkeyt_B")
        val b = w.client.accessToken()
        assertEquals(41, b.accessToken.length)
        assertEquals(40, a.accessToken.length)
        assertEquals(2, w.posts().size)
    }

    @Test
    fun anExchangeInFlightForAnotherKeyIsNotJoinedAndItsLateAnswerIsNotStored() = runBlocking {
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val w = world(exchange = { _, r ->
            if (String(r.body!!).contains("pkeyt_A")) {
                started.countDown()
                assertTrue(release.await(20, TimeUnit.SECONDS))
                respond(200, grant(jws(40)))
            } else {
                respond(200, grant(jws(41)))
            }
        })
        val late = async(Dispatchers.Default) { w.client.accessToken() }
        assertTrue(started.await(20, TimeUnit.SECONDS))
        w.core.setToken("pkeyt_B")
        assertEquals(41, w.client.accessToken().accessToken.length)
        release.countDown()
        assertEquals(40, late.await().accessToken.length)
        // The old key's late answer was not stored: asking as A again sends a new exchange.
        w.core.setToken("pkeyt_A")
        val before = w.posts().size
        w.client.accessToken()
        assertEquals(before + 1, w.posts().size)
    }

    @Test
    fun callersWithTheSameKeyShareOneExchange() = runBlocking {
        val w = world()
        val all = (1..4).map { async(Dispatchers.Default) { w.client.accessToken().accessToken } }.map { it.await() }
        assertEquals(1, all.toSet().size)
        assertEquals(1, w.posts().size)
    }

    @Test
    fun aFailureIsNotCachedAndKeepsTheWireCode() = runBlocking {
        for ((status, body, code) in listOf(
            Triple(400, """{"error":"invalid_grant"}""", "invalid_grant"),
            Triple(400, """{"error":"invalid_request","error_description":"x"}""", "invalid_request"),
        )) {
            var first = true
            val w = world(exchange = { _, _ -> if (first) respond(status, body).also { first = false } else respond(200, grant()) })
            val e = w.refusal()
            assertEquals(code, e.code)
            assertEquals(status, e.httpStatus)
            w.client.accessToken()
            assertEquals(2, w.posts().size)
        }
        val w = world(exchange = { _, _ -> respond(503, "down") })
        assertEquals(ErrorCode.serverError, w.refusal().code)
    }

    @Test
    fun aRateLimitIsRememberedPerKeyAndFailsFastWithoutARequest() = runBlocking {
        var limited = true
        val w = world(exchange = { _, _ -> if (limited) respond(429, """{"error":"rate_limited","retryAfter":60}""") else respond(200, grant()) })
        val first = w.refusal()
        assertEquals(ErrorCode.rateLimited, first.code)
        assertEquals(60, first.retryAfterSeconds)
        limited = false
        w.now = 1_030
        // Inside the wait: no request, refresh included.
        for (refresh in listOf(false, true)) {
            val e = w.refusal(refresh)
            assertEquals(ErrorCode.rateLimited, e.code)
            assertEquals(30, e.retryAfterSeconds)
        }
        assertEquals(1, w.posts().size)
        // Another device token is not held to it.
        w.core.setToken("pkeyt_B")
        w.client.accessToken()
        assertEquals(2, w.posts().size)
        // Past the wait the original key asks again.
        w.core.setToken("pkeyt_A")
        w.now = 1_060
        w.client.accessToken()
        assertEquals(3, w.posts().size)
    }

    @Test
    fun theRetryAfterHeaderIsReadWhenTheBodyHasNone() = runBlocking {
        val w = world(exchange = { _, _ -> respond(429, """{"error":"rate_limited"}""", mapOf("retry-after" to "7")) })
        assertEquals(7, w.refusal().retryAfterSeconds)
    }

    @Test
    fun anEndpointOutsideTheProductsOriginIsRefusedWithoutARequest() = runBlocking {
        for (other in listOf("https://evil.example/djdl/identity/token", "http://key.plrs.im/djdl/identity/token", "https://key.plrs.im:8443/x")) {
            val w = world(discovery(endpoint = other))
            assertEquals(ErrorCode.serviceUnavailable, w.refusal().code)
            assertTrue(w.transport.requests().none { it.path.endsWith("/token") })
        }
    }

    @Test
    fun aRedirectIsNeverFollowedAndNeverSucceeds() = runBlocking {
        val w = world(exchange = { _, _ -> respond(307, "", mapOf("location" to "https://evil.example/")) })
        assertEquals(ErrorCode.networkError, w.refusal().code)
        assertEquals(1, w.transport.requests().count { !it.followRedirects })
    }

    @Test
    fun anAccessTokenOverEightKibIsABadResponse() = runBlocking {
        val ok = world(exchange = { _, _ -> respond(200, grant(jws(ACCESS_TOKEN_MAX_LENGTH))) })
        assertEquals(ACCESS_TOKEN_MAX_LENGTH, ok.client.accessToken().accessToken.length)
        val big = world(exchange = { _, _ -> respond(200, grant(jws(ACCESS_TOKEN_MAX_LENGTH + 1))) })
        assertEquals(ErrorCode.badResponse, big.refusal().code)
    }

    @Test
    fun anAnswerThatIsNotAnAccessTokenIsABadResponse() = runBlocking {
        for (body in listOf(
            "not json",
            grant().replace("Bearer", "DPoP"),
            grant(expiresIn = 0),
            grant().replace("\"expires_in\":600", "\"expires_in\":\"600\""),
            grant().replace("urn:ietf:params:oauth:token-type:access_token", "x"),
            grant("not-a-jws"),
        )) {
            val w = world(exchange = { _, _ -> respond(200, body) })
            assertEquals(body, ErrorCode.badResponse, w.refusal().code)
        }
    }

    @Test
    fun signOutDropsTheHeldToken() = runBlocking {
        val w = world()
        w.client.accessToken()
        w.client.signOut()
        w.client.accessToken()
        assertEquals(2, w.posts().size)
    }
}
