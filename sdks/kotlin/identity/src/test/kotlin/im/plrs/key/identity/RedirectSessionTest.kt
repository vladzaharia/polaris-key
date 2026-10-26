// @pkey-feature identity.redirect.web identity.signin.hints
//
// I-10b.18: the redirect channel of `identity.signIn.start` beyond what a recording shows: the session is
// single use, a refusal never wipes the device's token, a bad callback sends nothing, and the endpoints
// come from discovery or not at all. The wire conversation itself is the transcripts'.

package im.plrs.key.identity

import im.plrs.key.core.CoreContext
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.path
import java.net.URI
import java.net.URLDecoder
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class RedirectSessionTest {
    private val api = "https://key.example/djdl"
    private val redirect = "https://app.example/cb"
    private val tokenPath = "/djdl/identity/token"
    private val tokenOk = """{"access_token":"pkeyt_new","token_type":"Bearer","scope":"profile email","schemaVersion":1,"device":{"id":"D"},"license":{"id":"lic_1"},"subject":"ps_abc"}"""

    private fun fragment(token: String = "$api/identity/token") =
        """{"enabled":true,"configured":true,"issuer":"$api/identity","endpoints":{"authorize":"$api/identity/authorize","token":"$token"}}"""

    private class World(val client: IdentityClient, val core: CoreContext, val transport: ScriptedTransport, val store: InMemoryStore) {
        suspend fun tokenCalls() = transport.requests().filter { it.path == "/djdl/identity/token" }
    }

    private fun world(
        identity: String = fragment(),
        services: String? = null,
        token: String? = null,
        tokenReply: (PolarisRequest) -> im.plrs.key.core.PolarisResponse = { respond(404) },
    ): World {
        val store = InMemoryStore("djdl", "dev")
        if (token != null) runBlocking { store.setToken(token) }
        val transport = ScriptedTransport { r: PolarisRequest ->
            when (r.path) {
                "/djdl/.well-known/polaris.json" -> respond(200, """{"product":"djdl","services":${services ?: """{"identity":$identity}"""}}""")
                tokenPath -> tokenReply(r)
                "/djdl/identity/auth/device/start" -> respond(
                    200,
                    """{"deviceCode":"dc","userCode":"ABCD-EFGH","verificationUri":"https://key.example/d","verificationUriComplete":"https://key.example/d?user_code=ABCD-EFGH","expiresIn":600,"interval":1}""",
                )
                else -> respond(404)
            }
        }
        val core = CoreContext(
            CoreOptions(
                productSlug = "djdl", baseUrl = "https://key.example", version = "1.0.0", pinnedKeys = emptyMap(), trustRefresh = false,
                store = store, transport = transport, clock = { 1_700_000_000L }, expectedServices = listOf(ServiceSlug.identity),
            ),
        )
        runBlocking { core.start() }
        val client = IdentityClient(core).also {
            @OptIn(ConformanceReplayOnly::class)
            it.redirectAcquisitionSync = false
        }
        return World(client, core, transport, store)
    }

    private fun param(url: String, name: String): String? =
        URI(url).rawQuery.split('&').map { it.split('=', limit = 2) }.firstOrNull { it[0] == name }?.getOrNull(1)?.let { URLDecoder.decode(it, "UTF-8") }

    private suspend fun begin(w: World, hint: String? = null): Pair<SignInSession, String> {
        val s = w.client.signIn.start(SignInOptions(channel = SignInChannel.Redirect, redirectUri = redirect, loginHint = hint))
        return s to param(s.authorizeUrl!!, "state")!!
    }

    private fun callback(state: String, q: String = "code=C0DE") = "$redirect?$q&state=$state&iss=https%3A%2F%2Fkey.example%2Fdjdl%2Fidentity"

    @Test
    fun buildsTheAuthorizeUrlFromDiscoveryAndRedeemsTheCodeWithAForm() = runBlocking {
        val w = world(tokenReply = { respond(200, tokenOk) })
        val (s, state) = begin(w, "ada@example.com")
        assertEquals(SignInChannel.Redirect, s.channel)
        val url = s.authorizeUrl!!
        assertTrue(url.startsWith("$api/identity/authorize?"))
        assertEquals("djdl", param(url, "client_id"))
        assertEquals("S256", param(url, "code_challenge_method"))
        assertEquals("ada@example.com", param(url, "login_hint"))
        assertNull(param(url, "code_verifier"))
        assertEquals(SignInOutcome.Pending(0), s.outcome)

        val outcome = s.complete(callback(state))
        assertEquals(SignInOutcome.SignedIn("ps_abc", "profile email", "lic_1"), outcome)
        assertEquals(outcome, s.outcome)
        assertEquals("pkeyt_new", w.store.getToken())
        assertEquals("ps_abc", w.core.storedSubject())
        val calls = w.tokenCalls()
        assertEquals(1, calls.size)
        assertEquals("application/x-www-form-urlencoded", calls[0].headers["content-type"])
        val body = String(calls[0].body!!)
        assertTrue(body.startsWith("grant_type=authorization_code&client_id=djdl&code=C0DE&code_verifier="))
        assertTrue(body, body.contains("&redirect_uri=https%3A%2F%2Fapp.example%2Fcb"))
        assertNull(calls[0].headers["authorization"])
    }

    @Test
    fun theSessionIsSingleUse() = runBlocking {
        val w = world(tokenReply = { respond(200, tokenOk) })
        val (s, state) = begin(w)
        s.complete(callback(state))
        try {
            s.complete(callback(state))
            fail("a replayed callback was accepted")
        } catch (e: SignInError) {
            assertEquals(ErrorCode.signInFailed, e.code)
        }
        assertEquals("the replay never reached the token endpoint", 1, w.tokenCalls().size)
    }

    @Test
    fun aBadCallbackSendsNothingAndKeepsTheToken() = runBlocking {
        val w = world(token = "pkeyt_old")
        for (url in listOf(
            "$redirect?code=c&state=wrong-state-0123456789&iss=https%3A%2F%2Fkey.example%2Fdjdl%2Fidentity",
            "https://evil.example/cb?code=c",
        )) {
            val (s, _) = begin(w)
            try {
                s.complete(url)
                fail("accepted $url")
            } catch (e: SignInError) {
                assertEquals(ErrorCode.signInFailed, e.code)
            }
        }
        assertTrue(w.tokenCalls().isEmpty())
        assertEquals("pkeyt_old", w.store.getToken())
    }

    @Test
    fun accessDeniedIsACancelledOutcome() = runBlocking {
        val w = world()
        val (s, state) = begin(w)
        assertEquals(SignInOutcome.Cancelled, s.complete(callback(state, "error=access_denied")))
        assertTrue(w.tokenCalls().isEmpty())
    }

    @Test
    fun theWorkersRefusalIsTypedAndKeepsTheToken() = runBlocking {
        val w = world(token = "pkeyt_old", tokenReply = { respond(400, """{"error":"invalid_grant"}""") })
        val (s, state) = begin(w)
        try {
            s.complete(callback(state))
            fail("expected invalid_grant")
        } catch (e: SignInError) {
            assertEquals("invalid_grant", e.code)
        }
        assertEquals("pkeyt_old", w.store.getToken())
    }

    @Test
    fun aRateLimitCarriesItsRetryAfter() = runBlocking {
        val w = world(tokenReply = { respond(429, """{"error":"rate_limited"}""", mapOf("Retry-After" to "7")) })
        val (s, state) = begin(w)
        try {
            s.complete(callback(state))
            fail("expected rate_limited")
        } catch (e: SignInError) {
            assertEquals("rate_limited", e.code)
            assertEquals(7, e.retryAfterSeconds)
        }
    }

    @Test
    fun aFiveHundredIsServerError() = runBlocking {
        val w = world(tokenReply = { respond(502, "bad gateway") })
        val (s, state) = begin(w)
        try {
            s.complete(callback(state))
            fail("expected server-error")
        } catch (e: SignInError) {
            assertEquals(ErrorCode.serverError, e.code)
        }
    }

    @Test
    fun cancelDropsThePendingRequest() = runBlocking {
        val w = world()
        val (s, state) = begin(w)
        s.cancel()
        assertEquals(SignInOutcome.Cancelled, s.outcome)
        try {
            s.complete(callback(state))
            fail("a cancelled session completed")
        } catch (e: SignInError) {
            assertEquals(ErrorCode.signInFailed, e.code)
        }
        assertTrue(w.tokenCalls().isEmpty())
    }

    private suspend fun startCode(w: World): String? = try {
        w.client.signIn.start(SignInOptions(channel = SignInChannel.Redirect, redirectUri = redirect))
        null
    } catch (e: PolarisException) {
        e.code
    }

    @Test
    fun withoutEndpointsInDiscoveryThereIsNoRedirectSignIn() = runBlocking {
        assertEquals(ErrorCode.signInUnavailable, startCode(world(identity = """{"enabled":true,"configured":true}""")))
    }

    @Test
    fun aTokenEndpointOffTheProductIsRefused() = runBlocking {
        assertEquals(ErrorCode.badResponse, startCode(world(identity = fragment("https://evil.example/token"))))
    }

    @Test
    fun aProductWithoutIdentityRefusesBeforeAnyRequest() = runBlocking {
        val w = world(services = "{}")
        assertEquals(ErrorCode.serviceUnavailable, startCode(w))
    }

    @Test
    fun aMissingOrBadRedirectUriIsInvalidArgument() = runBlocking {
        val w = world()
        for (uri in listOf<String?>(null, "http://app.example/cb")) {
            try {
                w.client.signIn.start(SignInOptions(channel = SignInChannel.Redirect, redirectUri = uri))
                fail("accepted $uri")
            } catch (e: PolarisException) {
                assertEquals(ErrorCode.invalidArgument, e.code)
            }
        }
    }

    @Test
    fun completeBelongsToTheRedirectChannel() = runBlocking {
        val w = world()
        val s = w.client.signIn.start()
        assertEquals(SignInChannel.DeviceCode, s.channel)
        assertNull(s.authorizeUrl)
        try {
            s.complete(redirect)
            fail("expected invalid-argument")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.invalidArgument, e.code)
        }
        assertNotNull(s.userCode)
    }
}
