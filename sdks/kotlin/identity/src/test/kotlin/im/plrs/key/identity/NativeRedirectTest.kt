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
import java.io.File
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class NativeRedirectTest {
    private val api = "https://key.example/djdl"
    private val iss = "$api/identity"
    private val state = "tidewater-state-0123456789"
    private val verifier = "transcript-verifier-0123456789-abcdefghijklmnopqrst"
    private val handle = "rq_fxXQ7DEgqPUfZlsJYdm76w"
    private val requestUri = "urn:ietf:params:oauth:request_uri:A1xUxaz50yGeWfx8JDSnAw"
    private val scheme = "com.tidewater.studio:/pkey/callback"
    private val code = "nzMud_COpAeAOKaIdixAP_dJqIpwVVSjV3GCoBfT-eE"
    private val returnPage = "https://key.example/signin/return"
    private val tokenOk = """{"access_token":"pkeyt_new","token_type":"Bearer","scope":"profile email","schemaVersion":1,"device":{"id":"D"},"license":null,"subject":"ps_abc"}"""

    private fun recorded(name: String) = JsonText.parse(
        File(System.getProperty("pkey.repoRoot"), "conformance/transcripts/redirect-native-$name.json").readText(),
    ).objectValue!!

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

    private fun assertInvalid(block: () -> Unit) {
        try {
            block()
            fail("accepted")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.invalidArgument, e.code)
        }
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

    private fun push(redirect: String = "http://127.0.0.1:49152/pkey/callback", name: String? = "Ada's Mac", returnUri: String? = null) = NativeRedirect.pushRequest(
        requestEndpoint = "$api/identity/request", authorizeEndpoint = "$api/identity/authorize", tokenEndpoint = "$api/identity/token",
        issuer = iss, clientId = "djdl", redirectUri = redirect, deviceName = name, returnUri = returnUri, state = state, codeVerifier = verifier,
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
        assertInvalid { NativeRedirect.pushRequest("$api/identity/request", "authorize", "$api/identity/token", iss, "djdl", scheme) }
        assertInvalid { NativeRedirect.pushRequest("$api/identity/request", "$api/a", "$api/t", "", "djdl", scheme) }
        assertInvalid { NativeRedirect.pushRequest("$api/identity/request", "$api/a", "$api/t", iss, "djdl", scheme, state = "short") }
        assertInvalid { NativeRedirect.pushRequest("$api/identity/request", "$api/a", "$api/t", iss, "djdl", scheme, codeVerifier = "short") }
    }

    @Test
    fun thePushedAnswerIsReadStrictly() {
        fun body(s: String) = JsonText.parseOrNull(s)
        assertEquals(PushedAnswer.Pushed(requestUri, 600), NativeRedirect.parsePushedAnswer(201, body("""{"request_uri":"$requestUri","expires_in":600}""")))
        for (bad in listOf(
            """{"request_uri":"urn:x","expires_in":600}""", """{"request_uri":"$requestUri","expires_in":601}""",
            """{"request_uri":"$requestUri","expires_in":0}""", """{"request_uri":"$requestUri"}""", """[]""",
        )) {
            assertEquals(bad, PushedAnswer.Malformed, NativeRedirect.parsePushedAnswer(201, body(bad)))
        }
        assertEquals(PushedAnswer.Refused("redirect_uri_mismatch", 400), NativeRedirect.parsePushedAnswer(400, body("""{"error":"redirect_uri_mismatch"}""")))
        assertEquals(PushedAnswer.Refused("server_error", 503), NativeRedirect.parsePushedAnswer(503, null))
        assertEquals(PushedAnswer.Refused("rate_limited", 429, 7), NativeRedirect.parsePushedAnswer(429, body("""{"error":"rate_limited","retryAfter":6.2}""")))
        val url = NativeRedirect.authorizeUrlFor("$api/identity/authorize", "djdl", requestUri)
        assertEquals("$api/identity/authorize?client_id=djdl&request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3AA1xUxaz50yGeWfx8JDSnAw", url)
        assertInvalid { NativeRedirect.authorizeUrlFor("$api/identity/authorize", "djdl", "urn:other") }
    }

    private fun pending(redirect: String = "http://127.0.0.1:49152/pkey/callback") = push(redirect).pending
    private val issEnc = "https%3A%2F%2Fkey.example%2Fdjdl%2Fidentity"

    @Test
    fun theCallbackIsCheckedInOrder() {
        val p = pending()
        val base = "http://127.0.0.1:49152/pkey/callback"
        fun check(url: String?) = NativeRedirect.parseCallback(p, url)
        fun failed(r: CallbackFailure, e: String? = null) = NativeCallback.Failed(r, e)
        assertEquals(NativeCallback.Code(code, handle), check("$base?code=$code&state=$state&iss=$issEnc&request=$handle"))
        assertEquals(NativeCallback.Cancelled(handle), check("$base?error=access_denied&state=$state&iss=$issEnc&request=$handle"))
        assertEquals(failed(CallbackFailure.AuthorizationError, "server_error"), check("$base?error=server_error&state=$state&iss=$issEnc&request=$handle"))
        assertEquals(failed(CallbackFailure.Malformed), check(null))
        assertEquals(failed(CallbackFailure.Malformed), check("$base?code=c&state=$state&iss=$issEnc&request=$handle#f"))
        assertEquals(failed(CallbackFailure.Malformed), check("$base?code=c&code=d&state=$state&iss=$issEnc&request=$handle"))
        assertEquals(failed(CallbackFailure.RedirectMismatch), check("http://127.0.0.1:49153/pkey/callback?code=c&state=$state&iss=$issEnc&request=$handle"))
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
            "grant_type=authorization_code&client_id=djdl&code=$code&code_verifier=$verifier&redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Fpkey%2Fcallback",
            t.body,
        )
        assertInvalid { NativeRedirect.tokenRequest(pending(), code, "") }
        assertFalse(t.toString().contains(code))
    }

    // ── The loopback listener, rule by rule, over a real socket ──────────────────────────

    private class Reply(val status: Int, val headers: Map<String, String>, val raw: String)

    private fun get(port: Int, target: String, host: String? = "127.0.0.1:$port", method: String = "GET"): Reply {
        Socket(InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)), port).use { s ->
            s.soTimeout = 5000
            val req = "$method $target HTTP/1.1\r\n" + (if (host != null) "Host: $host\r\n" else "") + "Connection: close\r\n\r\n"
            s.getOutputStream().write(req.toByteArray())
            val text = s.getInputStream().readBytes().toString(Charsets.ISO_8859_1)
            val lines = text.split("\r\n")
            val headers = lines.drop(1).takeWhile { it.isNotEmpty() }.associate { it.substringBefore(':').lowercase() to it.substringAfter(':').trim() }
            return Reply(lines[0].split(' ')[1].toInt(), headers, text)
        }
    }

    private fun accepting(seen: MutableList<String>, location: String? = "https://key.example/signin/return?request=$handle") = { url: String ->
        seen += url
        NativeListenerReply(location, true)
    }

    private fun refused(port: Int): Boolean = try {
        Socket(InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)), port).close()
        false
    } catch (e: java.io.IOException) {
        true
    }

    @Test
    fun theListenerBindsLoopbackOnlyOnAnOsPortAndIsExclusive() {
        val l = LoopbackListener()
        try {
            assertTrue(l.port in 1..65535)
            assertTrue("the redirect URI the port makes is a loopback one", NativeRedirect.classify(NativeRedirect.loopbackUri(l.port)) == NativeRedirectClass.Loopback)
            // The socket exists before `start`: no other socket may take the port.
            try {
                ServerSocket().use {
                    it.reuseAddress = false
                    it.bind(InetSocketAddress(InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)), l.port))
                }
                fail("a second socket shared the port")
            } catch (e: java.net.BindException) {
                // Expected.
            }
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
                if (url.contains("state=ok")) NativeListenerReply("https://key.example/signin/return?request=$handle", true) else NativeListenerReply(null, false)
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
            assertEquals(listOf("http://127.0.0.1:$p/pkey/callback?state=other", "http://127.0.0.1:$p/pkey/callback?code=c&state=ok&iss=x&request=$handle"), seen)
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
                assertEquals(-1, try { extra.getInputStream().read() } catch (e: java.io.IOException) { -1 })
            }
            // A drip-fed head does not outlive the deadline: a byte every half second still ends in about 5 s.
        } finally {
            held.forEach { it.close() }
        }
        Socket(loop, l.port).use { slow ->
            slow.soTimeout = 9000
            val out = slow.getOutputStream()
            val started = System.nanoTime()
            var cut = false
            try {
                while (System.nanoTime() - started < 8_000_000_000L) {
                    out.write('G'.code)
                    out.flush()
                    Thread.sleep(500)
                }
            } catch (e: java.io.IOException) {
                cut = true // The listener cut it off.
            }
            assertTrue("the head deadline ended the connection", cut && System.nanoTime() - started < 7_500_000_000L)
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
            val r = try { get(l.port, "/pkey/callback?state=a").status } catch (e: Exception) { -1 }
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

    private fun waitUntil(what: () -> Boolean) {
        val end = System.nanoTime() + 5_000_000_000L
        while (!what()) {
            if (System.nanoTime() > end) fail("timed out")
            Thread.sleep(20)
        }
    }

    // ── The session ──────────────────────────────────────────────────────────────────────

    private fun fragment(nativeRedirect: String? = """{"loopback":true,"schemes":["$scheme"],"claimedHttps":[]}""", request: Boolean = true, signinReturn: String? = returnPage) =
        """{"enabled":true,"configured":true,"issuer":"$iss",""" + (nativeRedirect?.let { """"nativeRedirect":$it,""" } ?: "") +
            """"endpoints":{"authorize":"$api/identity/authorize","token":"$api/identity/token"""" +
            (if (request) ""","request":"$api/identity/request"""" else "") + (signinReturn?.let { ""","signinReturn":"$it"""" } ?: "") + "}}"

    private class World(val client: IdentityClient, val core: CoreContext, val transport: ScriptedTransport, val store: InMemoryStore, val clock: AtomicReference<Long>) {
        suspend fun calls(path: String) = transport.requests().filter { it.path == path }
    }

    private fun world(
        identity: String = fragment(),
        push: (PolarisRequest) -> im.plrs.key.core.PolarisResponse = { respond(201, """{"request_uri":"$requestUri","expires_in":600}""") },
        tokenReply: (PolarisRequest) -> im.plrs.key.core.PolarisResponse = { respond(200, tokenOk) },
    ): World {
        val store = InMemoryStore("djdl", "TRANSCRIPTDEVICE0000000000000001")
        val clock = AtomicReference(1_700_000_000L)
        val transport = ScriptedTransport { r: PolarisRequest ->
            when (r.path) {
                "/djdl/.well-known/polaris.json" -> respond(200, """{"product":"djdl","services":{"identity":$identity}}""")
                "/djdl/identity/request" -> push(r)
                "/djdl/identity/token" -> tokenReply(r)
                else -> respond(404)
            }
        }
        val core = CoreContext(
            CoreOptions(
                productSlug = "djdl", baseUrl = "https://key.example", version = "1.0.0", pinnedKeys = emptyMap(), trustRefresh = false,
                store = store, transport = transport, clock = { clock.get() }, expectedServices = listOf(ServiceSlug.identity), deviceName = "",
            ),
        )
        runBlocking { core.start() }
        val client = IdentityClient(core).also {
            @OptIn(ConformanceReplayOnly::class)
            it.redirectAcquisitionSync = false
            @OptIn(ConformanceReplayOnly::class)
            it.redirectEntropy = RedirectEntropy(state, verifier)
        }
        return World(client, core, transport, store, clock)
    }

    private fun loopbackOptions(openBrowser: Boolean = false) =
        SignInOptions(channel = SignInChannel.Redirect, native = NativeRedirectOptions(loopback = true, openBrowser = openBrowser), deviceName = "Ada's Mac")

    private fun portOf(session: SignInSession) = Regex("""127\.0\.0\.1:(\d+)""").find(session.redirectUri!!)!!.groupValues[1].toInt()

    private fun recordingPush(): (PolarisRequest) -> im.plrs.key.core.PolarisResponse = { r ->
        val form = String(r.body!!).split('&').associate { it.substringBefore('=') to URLDecoder.decode(it.substringAfter('='), "UTF-8") }
        // The port is already ours: nothing else can take it while the push is in flight.
        Regex("""127\.0\.0\.1:(\d+)""").find(form["redirect_uri"]!!)?.let { m ->
            try {
                ServerSocket().use {
                    it.reuseAddress = false
                    it.bind(InetSocketAddress(InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)), m.groupValues[1].toInt()))
                }
                bindOrder.add("free")
            } catch (e: java.net.BindException) {
                bindOrder.add("held")
            }
        }
        respond(201, """{"request_uri":"$requestUri","expires_in":600}""")
    }
    private val bindOrder = ArrayList<String>()

    private val callbackQuery get() = "code=$code&state=$state&iss=$issEnc&request=$handle"

    @Test
    fun aLoopbackStartBindsBeforePushingThenRedeemsFromThePushingDevice() = runBlocking {
        val w = world(push = recordingPush())
        val s = w.client.signIn.start(loopbackOptions())
        assertEquals(listOf("held"), bindOrder)
        assertEquals(SignInChannel.Redirect, s.channel)
        assertEquals(NativeRedirectClass.Loopback, s.redirectClass)
        assertEquals("$api/identity/authorize?client_id=djdl&request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3AA1xUxaz50yGeWfx8JDSnAw", s.authorizeUrl)
        assertEquals(SignInOutcome.Pending(0), s.outcome)
        assertEquals(SignInOutcome.Pending(0), s.wait(once = true))
        val push = w.calls("/djdl/identity/request").single()
        assertEquals("application/x-www-form-urlencoded", push.headers["content-type"])
        assertEquals("TRANSCRIPTDEVICE0000000000000001", push.headers.entries.first { it.key.equals("x-pkey-device", true) }.value)

        val reply = get(portOf(s), "/pkey/callback?$callbackQuery")
        assertEquals(303, reply.status)
        assertEquals("$returnPage?request=$handle", reply.headers["location"])
        assertTrue("the callback never reached the token endpoint before wait", w.calls("/djdl/identity/token").isEmpty())

        val outcome = s.wait()
        assertEquals(SignInOutcome.SignedIn("ps_abc", "profile email", null), outcome)
        assertEquals("pkeyt_new", w.store.getToken())
        val token = w.calls("/djdl/identity/token").single()
        assertEquals("TRANSCRIPTDEVICE0000000000000001", token.headers.entries.first { it.key.equals("x-pkey-device", true) }.value)
        val body = String(token.body!!)
        assertTrue(body, body.startsWith("grant_type=authorization_code&client_id=djdl&code=$code&code_verifier=$verifier&redirect_uri=http%3A%2F%2F127.0.0.1%3A"))
        assertFalse("the label went with the push, not the token request", body.contains("device_name"))
        assertEquals(outcome, s.wait())
    }

    @Test
    fun aCancelledCardReturnsToThePageWithTheFlag() = runBlocking {
        val w = world(push = recordingPush())
        val s = w.client.signIn.start(loopbackOptions())
        val reply = get(portOf(s), "/pkey/callback?error=access_denied&state=$state&iss=$issEnc&request=$handle")
        assertEquals("$returnPage?request=$handle&cancelled=1", reply.headers["location"])
        assertEquals(SignInOutcome.Cancelled, s.wait())
        assertTrue(w.calls("/djdl/identity/token").isEmpty())
    }

    @Test
    fun aWrongStateOnTheListenerIsIgnoredAndTheRightOneStillWorks() = runBlocking {
        val w = world(push = recordingPush())
        val s = w.client.signIn.start(loopbackOptions())
        val p = portOf(s)
        assertEquals(404, get(p, "/pkey/callback?code=evil&state=wrong-state-0123456789&iss=$issEnc&request=$handle").status)
        assertEquals(SignInOutcome.Pending(0), s.wait(once = true))
        assertEquals(303, get(p, "/pkey/callback?$callbackQuery").status)
        assertTrue(s.wait() is SignInOutcome.SignedIn)
    }

    @Test
    fun aCallbackThatFailsTheIssuerCheckSettlesAsAFailureAndSendsNothing() = runBlocking {
        val w = world(push = recordingPush())
        val s = w.client.signIn.start(loopbackOptions())
        assertEquals(404, get(portOf(s), "/pkey/callback?code=c&state=$state&iss=https%3A%2F%2Fevil.example&request=$handle").status)
        try {
            s.wait()
            fail("settled")
        } catch (e: SignInError) {
            assertEquals(ErrorCode.signInFailed, e.code)
        }
        assertTrue(w.calls("/djdl/identity/token").isEmpty())
    }

    @Test
    fun cancelClosesTheListenerAndTheWaitAnswersCancelled() = runBlocking {
        val w = world(push = recordingPush())
        val s = w.client.signIn.start(loopbackOptions())
        val p = portOf(s)
        s.cancel()
        assertEquals(SignInOutcome.Cancelled, s.wait())
        assertEquals(SignInOutcome.Cancelled, s.outcome)
        waitUntil { refused(p) }
        assertFalse(s.reopen())
    }

    @Test
    fun aNewStartEndsTheLastOne() = runBlocking {
        val w = world(push = recordingPush())
        val first = w.client.signIn.start(loopbackOptions())
        val firstPort = portOf(first)
        val second = w.client.signIn.start(loopbackOptions())
        waitUntil { refused(firstPort) }
        assertEquals(SignInOutcome.Cancelled, first.wait())
        assertEquals(SignInOutcome.Pending(0), second.wait(once = true))
        second.cancel()
    }

    @Test
    fun theBrowserOpensOnStartAndOpenAgainIsTheSameUrlUntilItLapses() = runBlocking {
        val w = world(push = recordingPush())
        val opened = ArrayList<String>()
        val s = w.client.signIn.start(
            SignInOptions(
                channel = SignInChannel.Redirect, opener = AccountOpener { opened += it; true },
                native = NativeRedirectOptions(loopback = true),
            ),
        )
        assertTrue(s.opened)
        assertTrue(s.reopen())
        assertEquals(listOf(s.authorizeUrl, s.authorizeUrl), opened)
        assertEquals("one push for all of them", 1, w.calls("/djdl/identity/request").size)
        w.clock.set(1_700_000_000L + 600)
        try {
            s.reopen()
            fail("reopened a lapsed request")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.signInExpired, e.code)
        }
        assertEquals(SignInOutcome.Expired, s.wait())
    }

    @Test
    fun aSchemeDeliveryGoesThroughHandleRedirect() = runBlocking {
        val w = world()
        val s = w.client.signIn.start(
            SignInOptions(channel = SignInChannel.Redirect, native = NativeRedirectOptions(loopback = false, registeredSchemes = listOf(scheme), openBrowser = false)),
        )
        assertEquals(NativeRedirectClass.Scheme, s.redirectClass)
        val push = String(w.calls("/djdl/identity/request").single().body!!)
        assertTrue(push, push.contains("redirect_uri=com.tidewater.studio%3A%2Fpkey%2Fcallback"))
        // Another URL, a wrong state, a malformed one: refused, and the sign-in keeps waiting.
        for (bad in listOf(
            "com.other.app:/pkey/callback?code=c&state=$state&iss=$issEnc",
            "$scheme?code=c&state=wrong-state-0123456789&iss=$issEnc",
            "not a url",
        )) {
            try {
                w.client.signIn.handleRedirect(bad)
                fail("accepted $bad")
            } catch (e: SignInError) {
                assertEquals(ErrorCode.signInFailed, e.code)
            }
        }
        assertTrue(w.calls("/djdl/identity/token").isEmpty())
        val outcome = w.client.signIn.handleRedirect("$scheme?code=$code&state=$state&iss=$issEnc")
        assertTrue(outcome is SignInOutcome.SignedIn)
        assertEquals(outcome, s.wait())
        // Single use: a replayed delivery is refused locally.
        try {
            w.client.signIn.handleRedirect("$scheme?code=$code&state=$state&iss=$issEnc")
            fail("replayed")
        } catch (e: SignInError) {
            assertEquals(ErrorCode.signInFailed, e.code)
        }
        assertEquals(1, w.calls("/djdl/identity/token").size)
    }

    @Test
    fun handleRedirectWithNoSignInWaitingIsRefused() = runBlocking {
        val w = world()
        try {
            w.client.signIn.handleRedirect("$scheme?code=c&state=$state&iss=$issEnc")
            fail("accepted")
        } catch (e: SignInError) {
            assertEquals(ErrorCode.signInFailed, e.code)
        }
    }

    private suspend fun assertUnavailable(w: World, options: SignInOptions, code: String = ErrorCode.redirectUnavailable) {
        try {
            w.client.signIn.start(options)
            fail("started")
        } catch (e: PolarisException) {
            assertEquals(code, e.code)
        }
        assertTrue("nothing was pushed", w.calls("/djdl/identity/request").isEmpty())
    }

    @Test
    fun noClassAppliesIsRedirectUnavailableAndNothingIsSent() = runBlocking {
        // A host that cannot listen and has no scheme.
        assertUnavailable(world(), SignInOptions(channel = SignInChannel.Redirect, native = NativeRedirectOptions(loopback = false)))
        // A product that does not serve the pushed request.
        assertUnavailable(world(identity = fragment(request = false)), loopbackOptions())
        // A product that lists no native classes.
        assertUnavailable(world(identity = fragment(nativeRedirect = """{"loopback":false,"schemes":[],"claimedHttps":[]}""")), loopbackOptions())
        // A loopback with no customer-host return page cannot be used.
        assertUnavailable(world(identity = fragment(signinReturn = null)), loopbackOptions())
        // A scheme the product did not register.
        assertUnavailable(
            world(),
            SignInOptions(channel = SignInChannel.Redirect, native = NativeRedirectOptions(loopback = false, registeredSchemes = listOf("com.other.app:/pkey/callback"))),
        )
    }

    @Test
    fun aReturnPageOutsideTheProductIsRefusedBeforeAnyPush() = runBlocking {
        assertUnavailable(world(identity = fragment(signinReturn = "https://evil.example/signin/return")), loopbackOptions(), ErrorCode.badResponse)
        assertUnavailable(world(identity = fragment(signinReturn = "http://key.example/signin/return")), loopbackOptions(), ErrorCode.badResponse)
    }

    @Test
    fun theWorkersRefusalIsATypedErrorAndTheListenerIsReleased() = runBlocking {
        val seenPort = AtomicReference<Int?>(null)
        val w = world(
            push = { r ->
                val form = String(r.body!!)
                seenPort.set(Regex("127\\.0\\.0\\.1%3A(\\d+)").find(form)!!.groupValues[1].toInt())
                respond(400, """{"error":"redirect_uri_mismatch"}""")
            },
        )
        try {
            w.client.signIn.start(loopbackOptions())
            fail("started")
        } catch (e: SignInError) {
            assertEquals("redirect_uri_mismatch", e.code)
        }
        assertTrue("a refused push closes the port it bound", refused(seenPort.get()!!))
        assertNull(w.client.nativeActive.get())
        assertNotNull(w.store)
    }

    @Test
    fun aTokenRefusalIsATypedErrorAndKeepsTheToken() = runBlocking {
        val w = world(push = recordingPush(), tokenReply = { respond(400, """{"error":"invalid_grant"}""") })
        val s = w.client.signIn.start(loopbackOptions())
        get(portOf(s), "/pkey/callback?$callbackQuery")
        try {
            s.wait()
            fail("redeemed")
        } catch (e: SignInError) {
            assertEquals("invalid_grant", e.code)
        }
        assertNull(w.store.getToken())
    }

    @Test
    fun theHeadlessRule() {
        val none = emptyMap<String, String>()
        assertFalse(NativeHost.isHeadless(none, "Mac OS X"))
        assertFalse(NativeHost.isHeadless(mapOf("DISPLAY" to ":0"), "Linux"))
        assertFalse(NativeHost.isHeadless(mapOf("WAYLAND_DISPLAY" to "wayland-0"), "Linux"))
        assertTrue(NativeHost.isHeadless(none, "Linux"))
        assertTrue(NativeHost.isHeadless(mapOf("SSH_CONNECTION" to "1 2 3 4"), "Mac OS X"))
        assertTrue(NativeHost.isHeadless(mapOf("SSH_TTY" to "/dev/pts/0"), "Mac OS X"))
        assertTrue(NativeHost.isHeadless(mapOf("CI" to "true"), "Windows 11"))
    }
}
