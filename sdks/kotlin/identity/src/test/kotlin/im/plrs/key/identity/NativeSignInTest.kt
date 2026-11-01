// @pkey-feature identity.redirect.native
//
// I-15b.5 (the session half): the native redirect sign-in (WIRE-CONTRACT-V5 §12.12). The client-core `redirect.ts` helpers ported
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

class NativeSignInTest : NativeTestBase() {
    // ── The session ──────────────────────────────────────────────────────────────────────

    private fun fragment(
        nativeRedirect: String? = """{"loopback":true,"schemes":["$scheme"],"claimedHttps":[]}""",
        request: Boolean = true,
        signinReturn: String? = returnPage,
    ) = """{"enabled":true,"configured":true,"issuer":"$iss",""" + (nativeRedirect?.let { """"nativeRedirect":$it,""" } ?: "") +
        """"endpoints":{"authorize":"$api/identity/authorize","token":"$api/identity/token"""" +
        (if (request) ""","request":"$api/identity/request"""" else "") + (signinReturn?.let { ""","signinReturn":"$it"""" } ?: "") + "}}"

    private class World(
        val client: IdentityClient,
        val core: CoreContext,
        val transport: ScriptedTransport,
        val store: InMemoryStore,
        val clock: AtomicReference<Long>,
    ) {
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

    private fun loopbackOptions(openBrowser: Boolean = false) = SignInOptions(
        channel = SignInChannel.Redirect,
        native = NativeRedirectOptions(loopback = true, openBrowser = openBrowser),
        deviceName = "Ada's Mac",
    )

    private fun portOf(session: SignInSession) = Regex("""127\.0\.0\.1:(\d+)""").find(session.redirectUri!!)!!.groupValues[1].toInt()

    private fun recordingPush(): (PolarisRequest) -> im.plrs.key.core.PolarisResponse = { r ->
        val form = String(r.body!!).split('&').associate { it.substringBefore('=') to URLDecoder.decode(it.substringAfter('='), "UTF-8") }
        // The port is already ours: nothing else can take it while the push is in flight.
        Regex("""127\.0\.0\.1:(\d+)""").find(form["redirect_uri"]!!)?.let { m ->
            bindOrder.add(if (canBind(m.groupValues[1].toInt())) "free" else "held")
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
        assertEquals(
            "$api/identity/authorize?client_id=djdl&request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3AA1xUxaz50yGeWfx8JDSnAw",
            s.authorizeUrl,
        )
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
        assertTrue(
            body,
            body.startsWith("grant_type=authorization_code&client_id=djdl&code=$code&code_verifier=$verifier&redirect_uri=http%3A%2F%2F127.0.0.1%3A"),
        )
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
                channel = SignInChannel.Redirect,
                opener = AccountOpener {
                    opened += it
                    true
                },
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
            SignInOptions(
                channel = SignInChannel.Redirect,
                native = NativeRedirectOptions(loopback = false, registeredSchemes = listOf(scheme), openBrowser = false),
            ),
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
            SignInOptions(
                channel = SignInChannel.Redirect,
                native = NativeRedirectOptions(loopback = false, registeredSchemes = listOf("com.other.app:/pkey/callback")),
            ),
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
    fun aFailureAtRedemptionSettlesTheSignInAsFailed() = runBlocking {
        val w = world(push = recordingPush(), tokenReply = { respond(200, "not json") })
        val s = w.client.signIn.start(loopbackOptions())
        get(portOf(s), "/pkey/callback?$callbackQuery")
        val first = try {
            s.wait()
            null
        } catch (e: PolarisException) {
            e
        }
        assertNotNull("redemption failure surfaces", first)
        // A second wait reports the same failure; it does not wait forever.
        try {
            s.wait()
            fail("settled")
        } catch (_: PolarisException) {
            // same failure
        }
        assertNull(w.store.getToken())
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
    fun androidNeverListensOnLoopback() = runBlocking {
        NativeHost.onAndroid = { true }
        try {
            // Loopback asked for, no scheme registered: nothing to fall back to, nothing sent.
            assertUnavailable(world(), loopbackOptions())
            // A registered scheme is taken, and the opener is told which redirect URI to watch for.
            val seen = AtomicReference<Pair<String, String>?>(null)
            val opener = object : NativeRedirectOpener {
                override suspend fun open(url: String): Boolean = false

                override suspend fun open(url: String, redirectUri: String): Boolean {
                    seen.set(url to redirectUri)
                    return true
                }
            }
            val w = world()
            val s = w.client.signIn.start(
                SignInOptions(
                    channel = SignInChannel.Redirect,
                    opener = opener,
                    native = NativeRedirectOptions(loopback = true, registeredSchemes = listOf(scheme)),
                ),
            )
            assertEquals(scheme, s.redirectUri)
            assertEquals(scheme, seen.get()?.second)
            assertTrue(seen.get()!!.first.contains("request_uri="))
        } finally {
            NativeHost.onAndroid = { NativeHost.isAndroid() }
        }
    }

    @Test
    fun theAndroidRuntimeIsRecognised() {
        assertTrue(NativeHost.isAndroid("The Android Project", ""))
        assertTrue(NativeHost.isAndroid("", "The Android Project"))
        assertFalse(NativeHost.isAndroid("Eclipse Adoptium", "Oracle Corporation"))
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
