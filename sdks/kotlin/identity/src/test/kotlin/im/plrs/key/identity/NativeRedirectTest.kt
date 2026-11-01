// @pkey-feature identity.redirect.native
//
// I-15b.5: the native redirect sign-in (WIRE-CONTRACT-V5 §12.12). The client-core `redirect.ts` helpers ported
// (their vectors are the redirect-native-* recordings), then the loopback listener rule by rule over real
// sockets, then the session: bind first, one callback, the pusher's device, the typed fallbacks. The wire
// conversations themselves are the transcripts' (TranscriptTest).

package im.plrs.key.identity

import im.plrs.key.core.CoreContext
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.arrayValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.path
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.util.concurrent.atomic.AtomicReference

class NativeRedirectTest : NativeTestBase() {
    private companion object {
        const val DRIP_MAX_NANOS = 8_000_000_000L
        const val DRIP_CUT_NANOS = 7_500_000_000L
    }

    // ── The pure helpers ─────────────────────────────────────────────────────────────────

    @Test
    fun theClassOfARedirectUri() {
        val table = listOf(
            "http://127.0.0.1:49152/pkey/callback" to NativeRedirectClass.Loopback,
            scheme to NativeRedirectClass.Scheme,
            "https://app.example/open/pkey" to NativeRedirectClass.Claimed,
            "http://localhost:49152/pkey/callback" to null,
            "http://127.0.0.1/pkey/callback" to null,
            "http://127.0.0.1:80/pkey/callback" to null,
            "http://127.0.0.1:049152/pkey/callback" to null,
            "http://127.0.0.1:70000/pkey/callback" to null,
            "http://127.0.0.1:49152/other" to null,
            "http://127.0.0.1:49152/pkey/callback?x=1" to null,
            "http://127.0.0.1:49152/pkey/callback#f" to null,
            "http://user@127.0.0.1:49152/pkey/callback" to null,
            "com.x:/other" to null,
            "com.x:/pkey/callback?q=1" to null,
            "javascript:/pkey/callback" to null,
            "https://app.example/" to null,
            "http://127.0.0.1:49152/pkey/callback " to null,
            "" to null,
        )
        for ((uri, cls) in table) assertEquals(uri, cls, NativeRedirect.classify(uri))
        assertNull(NativeRedirect.classify(null))
        assertEquals("http://127.0.0.1:49152/pkey/callback", NativeRedirect.loopbackUri(49152))
        assertEquals(scheme, NativeRedirect.schemeUri("com.tidewater.studio"))
        for (port in listOf(0, 80, 65536)) assertInvalid { NativeRedirect.loopbackUri(port) }
        for (s in listOf("https", "", "Com.X", "1x")) assertInvalid { NativeRedirect.schemeUri(s) }
    }

    @Test
    fun theClassOrderIsLoopbackThenSchemeThenClaimedThenTheFallback() {
        val claimed = "https://app.example/open/pkey"
        val native = NativeRedirectDiscovery(true, listOf(scheme), listOf(claimed))
        val req = "$api/identity/request"
        assertEquals(RedirectChoice.Loopback, NativeRedirect.chooseClass(req, native, true, listOf(scheme), listOf(claimed)))
        assertEquals(RedirectChoice.Scheme(scheme), NativeRedirect.chooseClass(req, native, false, listOf(scheme), listOf(claimed)))
        assertEquals(RedirectChoice.Claimed(claimed), NativeRedirect.chooseClass(req, native, false, emptyList(), listOf(claimed)))
        // A class the host has but discovery does not list is not used.
        val bare = NativeRedirectDiscovery(false)
        assertEquals(RedirectChoice.Unavailable("no-class"), NativeRedirect.chooseClass(req, bare, true, listOf(scheme), listOf(claimed)))
        assertEquals(RedirectChoice.Unavailable("request-not-served"), NativeRedirect.chooseClass(null, native, true))
        assertEquals(RedirectChoice.Unavailable("request-not-served"), NativeRedirect.chooseClass(req, null, true))
    }

    private val endpoints = NativeEndpoints("$api/identity/request", "$api/identity/authorize", "$api/identity/token", iss, "djdl")

    private fun push(redirect: String = "http://127.0.0.1:49152/pkey/callback", name: String? = "Ada's Mac", returnUri: String? = null) =
        NativeRedirect.pushRequest(
            endpoints,
            redirect,
            PushOptions(deviceName = name, returnUri = returnUri),
            PushEntropy(state = state, codeVerifier = verifier),
        )

    @Test
    fun thePushIsTheRecordedForm() {
        val want = recorded("loopback")["steps"]!!.arrayValue!![0].objectValue!!["exchanges"].objectValue!!["items"].arrayValue!![0]
            .objectValue!!["request"].objectValue!!["body"].objectValue!!["json"].objectValue!!
        val pushed = push()
        val got = pushed.body.split('&').map { it.split('=', limit = 2).map { p -> URLDecoder.decode(p, "UTF-8") } }
        assertEquals(want.keys.toList(), got.map { it[0] })
        for ((k, v) in got) assertEquals(want[k].stringValue, v)
        assertFalse(pushed.body.contains(verifier))
        assertFalse(pushed.toString().contains(verifier))
        assertFalse(pushed.pending.toString().contains(verifier))
        assertEquals(NativeRedirectClass.Loopback, pushed.pending.redirectClass)
        assertTrue(push(scheme, returnUri = scheme).body.endsWith("&device_name=Ada%27s+Mac&return_uri=com.tidewater.studio%3A%2Fpkey%2Fcallback"))
    }

    @Test
    fun thePushRefusesBeforeBuildingAnything() {
        assertInvalid { push("https://app.example/") }
        assertInvalid { push("http://localhost:49152/pkey/callback") }
        assertInvalid { push(returnUri = "http://127.0.0.1:49152/pkey/callback") }
        val bareAuthorize = NativeEndpoints("$api/identity/request", "authorize", "$api/identity/token", iss, "djdl")
        assertInvalid { NativeRedirect.pushRequest(bareAuthorize, scheme) }
        assertInvalid { NativeRedirect.pushRequest(NativeEndpoints("$api/identity/request", "$api/a", "$api/t", "", "djdl"), scheme) }
        assertInvalid { NativeRedirect.pushRequest(endpoints, scheme, PushOptions(), PushEntropy(state = "short")) }
        assertInvalid { NativeRedirect.pushRequest(endpoints, scheme, PushOptions(), PushEntropy(codeVerifier = "short")) }
    }

    @Test
    fun thePushedAnswerIsReadStrictly() {
        fun body(s: String) = JsonText.parseOrNull(s)
        assertEquals(
            PushedAnswer.Pushed(requestUri, 600),
            NativeRedirect.parsePushedAnswer(201, body("""{"request_uri":"$requestUri","expires_in":600}""")),
        )
        for (bad in listOf(
            """{"request_uri":"urn:x","expires_in":600}""",
            """{"request_uri":"$requestUri","expires_in":601}""",
            """{"request_uri":"$requestUri","expires_in":0}""",
            """{"request_uri":"$requestUri"}""",
            """[]""",
        )) {
            assertEquals(bad, PushedAnswer.Malformed, NativeRedirect.parsePushedAnswer(201, body(bad)))
        }
        assertEquals(
            PushedAnswer.Refused("redirect_uri_mismatch", 400),
            NativeRedirect.parsePushedAnswer(400, body("""{"error":"redirect_uri_mismatch"}""")),
        )
        assertEquals(PushedAnswer.Refused("server_error", 503), NativeRedirect.parsePushedAnswer(503, null))
        assertEquals(
            PushedAnswer.Refused("rate_limited", 429, 7),
            NativeRedirect.parsePushedAnswer(429, body("""{"error":"rate_limited","retryAfter":6.2}""")),
        )
        val url = NativeRedirect.authorizeUrlFor("$api/identity/authorize", "djdl", requestUri)
        assertEquals("$api/identity/authorize?client_id=djdl&request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3AA1xUxaz50yGeWfx8JDSnAw", url)
        assertInvalid { NativeRedirect.authorizeUrlFor("$api/identity/authorize", "djdl", "urn:other") }
    }

    private fun pending(redirect: String = "http://127.0.0.1:49152/pkey/callback") = push(redirect).pending

    @Test
    fun theCallbackIsCheckedInOrder() {
        val p = pending()
        val base = "http://127.0.0.1:49152/pkey/callback"
        fun check(url: String?) = NativeRedirect.parseCallback(p, url)
        fun failed(r: CallbackFailure, e: String? = null) = NativeCallback.Failed(r, e)
        assertEquals(NativeCallback.Code(code, handle), check("$base?code=$code&state=$state&iss=$issEnc&request=$handle"))
        assertEquals(NativeCallback.Cancelled(handle), check("$base?error=access_denied&state=$state&iss=$issEnc&request=$handle"))
        assertEquals(
            failed(CallbackFailure.AuthorizationError, "server_error"),
            check("$base?error=server_error&state=$state&iss=$issEnc&request=$handle"),
        )
        assertEquals(failed(CallbackFailure.Malformed), check(null))
        assertEquals(failed(CallbackFailure.Malformed), check("$base?code=c&state=$state&iss=$issEnc&request=$handle#f"))
        assertEquals(failed(CallbackFailure.Malformed), check("$base?code=c&code=d&state=$state&iss=$issEnc&request=$handle"))
        assertEquals(
            failed(CallbackFailure.RedirectMismatch),
            check("http://127.0.0.1:49153/pkey/callback?code=c&state=$state&iss=$issEnc&request=$handle"),
        )
        assertEquals(failed(CallbackFailure.RedirectMismatch), check("http://127.0.0.1:49152/other?code=c&state=$state&iss=$issEnc&request=$handle"))
        assertEquals(failed(CallbackFailure.StateMismatch), check("$base?code=c&state=another-state-0123456789&iss=$issEnc&request=$handle"))
        assertEquals(failed(CallbackFailure.StateMismatch), check("$base?code=c&iss=$issEnc&request=$handle"))
        assertEquals(failed(CallbackFailure.IssuerMismatch), check("$base?code=c&state=$state&request=$handle"))
        assertEquals(failed(CallbackFailure.IssuerMismatch), check("$base?code=c&state=$state&iss=https%3A%2F%2Fevil.example&request=$handle"))
        assertEquals(failed(CallbackFailure.MissingCode), check("$base?state=$state&iss=$issEnc&request=$handle"))
        assertEquals(failed(CallbackFailure.UnexpectedParameter), check("$base?code=c&state=$state&iss=$issEnc&request=$handle&extra=1"))
        assertEquals(failed(CallbackFailure.RequestInvalid), check("$base?code=c&state=$state&iss=$issEnc"))
        assertEquals(failed(CallbackFailure.RequestInvalid), check("$base?code=c&state=$state&iss=$issEnc&request=rq_short"))
        // A scheme delivery has no handle; one that carries it must still hold a valid one.
        val s = pending(scheme)
        assertEquals(NativeCallback.Code("c", null), NativeRedirect.parseCallback(s, "$scheme?code=c&state=$state&iss=$issEnc"))
        assertEquals(failed(CallbackFailure.RequestInvalid), NativeRedirect.parseCallback(s, "$scheme?code=c&state=$state&iss=$issEnc&request=bad"))
        assertFalse(NativeCallback.Code(code, handle).toString().contains(code))
    }

    @Test
    fun theTokenRequestCarriesThePushingDevice() {
        val t = NativeRedirect.tokenRequest(pending(), code, "TRANSCRIPTDEVICE0000000000000001")
        assertEquals("$api/identity/token", t.url)
        assertEquals("TRANSCRIPTDEVICE0000000000000001", t.deviceId)
        assertEquals("application/x-www-form-urlencoded", t.contentType)
        assertEquals(
            "grant_type=authorization_code&client_id=djdl&code=$code&code_verifier=$verifier" +
                "&redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Fpkey%2Fcallback",
            t.body,
        )
        assertInvalid { NativeRedirect.tokenRequest(pending(), code, "") }
        assertFalse(t.toString().contains(code))
    }

    // ── The loopback listener, rule by rule, over a real socket ──────────────────────────

    private fun accepting(seen: MutableList<String>, location: String? = "https://key.example/signin/return?request=$handle") = { url: String ->
        seen += url
        NativeListenerReply(location, true)
    }

    @Test
    fun theListenerBindsLoopbackOnlyOnAnOsPortAndIsExclusive() {
        val l = LoopbackListener()
        try {
            assertTrue(l.port in 1..65535)
            assertTrue(
                "the redirect URI the port makes is a loopback one",
                NativeRedirect.classify(NativeRedirect.loopbackUri(l.port)) == NativeRedirectClass.Loopback,
            )
            // The socket exists before `start`: no other socket may take the port.
            assertFalse("a second socket shared the port", canBind(l.port))
        } finally {
            l.close()
        }
        assertTrue(l.closed)
        l.close()
    }

    @Test
    fun theListenerAnswersOnlyTheCallbackWithAnExactRequest() {
        val seen = ArrayList<String>()
        val l = LoopbackListener()
        l.start(
            { url ->
                seen += url
                if (url.contains(
                        "state=ok",
                    )
                ) {
                    NativeListenerReply("https://key.example/signin/return?request=$handle", true)
                } else {
                    NativeListenerReply(null, false)
                }
            },
        )
        try {
            val p = l.port
            // Other path, other method, other Host, no Host, a query on the root: a 404 each, never the accept.
            assertEquals(404, get(p, "/").status)
            assertEquals(404, get(p, "/pkey/callbackx?state=ok").status)
            assertEquals(404, get(p, "/pkey/callback?state=ok", method = "POST").status)
            assertEquals(404, get(p, "/pkey/callback?state=ok", method = "HEAD").status)
            assertEquals(404, get(p, "/pkey/callback?state=ok", host = "localhost:$p").status)
            assertEquals(404, get(p, "/pkey/callback?state=ok", host = "127.0.0.1:${p + 1}").status)
            assertEquals(404, get(p, "/pkey/callback?state=ok", host = null).status)
            assertEquals(404, get(p, "http://127.0.0.1:$p/pkey/callback?state=ok").status)
            assertTrue(seen.isEmpty())
            // A callback that is not this sign-in's keeps the listener waiting.
            assertEquals(404, get(p, "/pkey/callback?state=other").status)
            assertFalse(l.closed)
            // The first good one: one 303, no HTML, no CORS, no referrer, no cache; the listener closes.
            val r = get(p, "/pkey/callback?code=c&state=ok&iss=x&request=$handle")
            assertEquals(303, r.status)
            assertEquals("https://key.example/signin/return?request=$handle", r.headers["location"])
            assertEquals("no-store", r.headers["cache-control"])
            assertEquals("no-referrer", r.headers["referrer-policy"])
            assertEquals("0", r.headers["content-length"])
            assertFalse(r.headers.keys.any { it.startsWith("access-control-") })
            assertEquals(
                listOf("http://127.0.0.1:$p/pkey/callback?state=other", "http://127.0.0.1:$p/pkey/callback?code=c&state=ok&iss=x&request=$handle"),
                seen,
            )
            waitUntil { refused(p) }
            assertTrue(l.closed)
        } finally {
            l.close()
        }
    }

    @Test
    fun connectionsAreCappedAndASlowHeadIsCutOffByAWallClockDeadline() {
        val l = LoopbackListener()
        l.start { NativeListenerReply(null, false) }
        val loop = InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))
        val held = (1..8).map { Socket(loop, l.port) }
        try {
            Thread.sleep(300)
            // The ninth is closed unanswered while eight are held open.
            Socket(loop, l.port).use { extra ->
                extra.soTimeout = 3000
                extra.getOutputStream().write("GET / HTTP/1.1\r\n\r\n".toByteArray())
                assertEquals(-1, runCatching { extra.getInputStream().read() }.getOrDefault(-1))
            }
            // A drip-fed head does not outlive the deadline: a byte every half second still ends in about 5 s.
        } finally {
            held.forEach { it.close() }
        }
        Socket(loop, l.port).use { slow ->
            slow.soTimeout = 9000
            val out = slow.getOutputStream()
            val started = System.nanoTime()
            val cut = runCatching {
                while (System.nanoTime() - started < DRIP_MAX_NANOS) {
                    out.write('G'.code)
                    out.flush()
                    Thread.sleep(500)
                }
            }.isFailure // The listener cut it off.
            assertTrue("the head deadline ended the connection", cut && System.nanoTime() - started < DRIP_CUT_NANOS)
        }
        l.close()
    }

    @Test
    fun nothingEscapesAConnectionHandler() {
        val seen = java.util.concurrent.CopyOnWriteArrayList<Throwable>()
        val old = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { _, e -> seen += e }
        val l = LoopbackListener()
        try {
            l.start { throw IllegalStateException("boom") }
            val r = runCatching { get(l.port, "/pkey/callback?state=a").status }.getOrDefault(-1)
            assertTrue(r == 404 || r == -1)
            Thread.sleep(200)
            assertTrue(seen.toString(), seen.isEmpty())
            assertFalse("the listener still serves", l.closed)
            assertEquals(404, get(l.port, "/").status)
        } finally {
            l.close()
            Thread.setDefaultUncaughtExceptionHandler(old)
        }
    }

    @Test
    fun theListenerClosesAfterItsLifetime() {
        val l = LoopbackListener(lifetimeMillis = 300)
        l.start { NativeListenerReply(null, false) }
        waitUntil { l.closed }
        assertTrue(refused(l.port))
    }

    @Test
    fun aSecondCallbackAfterTheFirstIsNeverAccepted() {
        val seen = ArrayList<String>()
        val l = LoopbackListener()
        l.start(accepting(seen))
        val p = l.port
        assertEquals(303, get(p, "/pkey/callback?state=a").status)
        waitUntil { refused(p) }
        assertEquals(1, seen.size)
    }
}
