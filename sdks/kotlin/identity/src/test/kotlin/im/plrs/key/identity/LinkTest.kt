// @pkey-feature identity.link
//
// The Kotlin link offer (identity.link; WIRE-CONTRACT-V5 section 12.11.4) against a scripted Worker: when the offer
// opens, the bearer on the redirect redeem, the link proof, the handle's life, the decline record and the typed refusals.
// The recorded conversations (link-offer, link-errors, link-game) are replayed by the conformance runner.

package im.plrs.key.identity

import im.plrs.key.core.Base64Url
import im.plrs.key.core.CoreContext
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.DeviceKeyPersistence
import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.DeviceKeyStorage
import im.plrs.key.core.DeviceKeyStore
import im.plrs.key.core.DeviceProof
import im.plrs.key.core.DeviceProofFields
import im.plrs.key.core.DeviceProofs
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.Store
import im.plrs.key.core.TokenSource
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.path
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

private const val TOKEN_OK =
    """{"access_token":"pkeyt_signed","token_type":"Bearer","scope":"profile email","schemaVersion":1,""" +
        """"device":{"id":"D"},"license":null,"subject":"ps_QQMMVm-ciTWvmWEIfhAVgQ"}"""

@OptIn(ConformanceReplayOnly::class)
class LinkTest {
    private class DurableMem(private val inner: InMemoryDeviceKeyStorage = InMemoryDeviceKeyStorage()) : DeviceKeyStorage by inner {
        override val persistence: DeviceKeyPersistence = DeviceKeyPersistence.durable
    }

    /** A store with a state directory, to prove the decline outlives the client. */
    private class DirStore(inner: InMemoryStore, override val stateDirectory: File) : Store by inner

    private class FakeProvider(override val kind: ExchangeKind, val token: String) : PlatformIdentityProvider {
        var sheets = 0
        override suspend fun silent(nonce: String, serverClientId: String?): PlatformSubjectToken? = null
        override suspend fun sheet(nonce: String, serverClientId: String?): PlatformSubjectToken? {
            sheets++
            return PlatformSubjectToken(token, nonce)
        }
        override suspend fun signOutCleanup() = Unit
        override suspend fun credentialRevoked(): Boolean = false
    }

    private val device = "DEVICE00000000000000000000000001"
    private val handle = "lh_" + "C".repeat(43)
    private val otherHandle = "lh_" + "D".repeat(43)
    private val base = "https://key.plrs.im/djdl/identity"
    private val nonce1 = "-ajcZR-muye01GgH7qFEoDrU4G1DAv5L3MquJLU7_8Q"
    private val sub = "ps_QQMMVm-ciTWvmWEIfhAVgQ"
    private val grant = "sg_" + "B".repeat(43)
    private val tokenOk = TOKEN_OK
    private val chooseBody = """{"status":"choose","grant":"$grant","expiresIn":300,"choices":{"state":"choose","choices":[]}}"""

    private class World(
        val client: IdentityClient,
        val transport: ScriptedTransport,
        val store: Store,
        val port: DeviceKeyPort,
        val core: CoreContext,
        val answers: Answers,
    )

    class Answers {
        var offer: Pair<Int, String> =
            200 to """{"offer":[{"kind":"google","reach":null},{"kind":"apple","reach":null},{"kind":"other","reach":null}]}"""
        var link: Pair<Int, String> = 200 to """{"linked":{"kind":"apple","reach":"global"}}"""
        var token: Pair<Int, String> = 200 to TOKEN_OK
    }

    private fun world(stateDir: File? = null, linkRoute: Boolean = true, held: String? = "pkeyt_old"): World {
        val inner = InMemoryStore("djdl", device)
        val store: Store = if (stateDir != null) DirStore(inner, stateDir) else inner
        runBlocking { held?.let { store.setToken(it) } }
        val answers = Answers()
        val route = if (linkRoute) ",\"link\":\"$base/link\"" else ""
        val discovery = """{"product":"djdl","services":{"identity":{"enabled":true,"configured":true,"issuer":"$base",""" +
            """"exchange":{"kinds":["google","apple","pgs"]},"endpoints":{"nonce":"$base/nonce","token":"$base/token",""" +
            """"choiceComplete":"$base/choice/complete"$route}}}}"""
        val transport = ScriptedTransport { r: PolarisRequest ->
            when (r.path) {
                "/djdl/.well-known/polaris.json" -> respond(200, discovery)

                "/djdl/identity/nonce" -> respond(200, """{"nonce":"$nonce1","expiresIn":300}""")

                "/djdl/identity/token" -> respond(answers.token.first, answers.token.second)

                "/djdl/identity/choice/complete" -> respond(200, tokenOk)

                "/djdl/identity/link" -> if (r.method ==
                    "GET"
                ) {
                    respond(answers.offer.first, answers.offer.second)
                } else {
                    respond(answers.link.first, answers.link.second)
                }

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
                clock = { 1_700_000_000L },
            ),
        )
        runBlocking { core.start() }
        val port = DeviceKeyStore(DurableMem())
        val client = IdentityClient(core, deviceKeys = port)
        client.redirectAcquisitionSync = false
        return World(client, transport, store, port, core, answers)
    }

    private suspend fun World.reqs(path: String) = transport.requests().filter { it.path == path }

    private fun PolarisRequest.header(name: String) = headers.entries.firstOrNull { it.key.equals(name, true) }?.value

    private suspend fun World.signInOnThisDevice() {
        val out = client.redeemForm("$base/token", "grant_type=authorization_code", false) as SignInOutcome.SignedIn
        assertTrue(out.sameDevice)
    }

    private fun body(r: PolarisRequest): JsonObject = Json.parseToJsonElement(String(r.body!!)).objectValue!!

    // ── rule 1: the offer opens only after a same-device sign-in ────────────────────────────────

    @Test
    fun withoutASameDeviceSignInOfferAndAcceptAreUnavailableAndSendNothing() = runBlocking {
        val w = world()
        assertFalse(w.client.link.pending)
        assertEquals(LinkOfferResult.Unavailable, w.client.link.offer())
        assertEquals(LinkAcceptResult.Unavailable, w.client.link.accept())
        assertEquals(LinkAcceptResult.Unavailable, w.client.link.accept(handle))
        assertTrue(w.transport.requests().isEmpty())
    }

    @Test
    fun aRedirectSignInOpensTheOffer() = runBlocking {
        val w = world()
        w.signInOnThisDevice()
        assertTrue(w.client.link.pending)
        val ok = w.client.link.offer() as LinkOfferResult.Ok
        // Only the kinds this SDK knows come back.
        assertEquals(listOf(LinkOfferEntry("google", null), LinkOfferEntry("apple", null)), ok.kinds)
        val get = w.reqs("/djdl/identity/link").single()
        assertEquals("GET", get.method)
        assertEquals("Bearer pkeyt_signed", get.header("authorization"))
    }

    @Test
    fun anExchangeSignInDoesNotOpenTheOffer() = runBlocking {
        val w = world()
        w.answers.token = 200 to w.answers.token.second.replace("pkeyt_signed", "pkeyt_exchanged")
        val out = w.client.exchangeWithFreshNonce(ExchangeKind.google, "tok")
        assertTrue(out is ExchangeOutcome.SignedIn)
        assertFalse(w.client.link.pending)
        assertEquals(LinkOfferResult.Unavailable, w.client.link.offer())
    }

    @Test
    fun aRedirectAnswerWithoutASubjectOpensNothing() = runBlocking {
        val w = world()
        w.answers.token = 200 to w.answers.token.second.replace(""","subject":"$sub"""", "")
        try {
            w.client.redeemForm("$base/token", "grant_type=authorization_code", false)
            fail("expected a refusal")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.badResponse, e.code)
        }
        assertFalse(w.client.link.pending)
        assertEquals(LinkOfferResult.Unavailable, w.client.link.offer())
        // The member alone must not open it either.
        w.client.linkMemory.open(null)
        w.client.linkMemory.open("")
        assertFalse(w.client.link.pending)
    }

    @Test
    fun aLicenceChoiceThisDeviceStartedOpensTheOfferWhenItCompletes() = runBlocking {
        val w = world()
        w.answers.token = 200 to chooseBody
        val choose = w.client.redeemForm("$base/token", "x=y", true)
        assertTrue(choose is SignInOutcome.Choose)
        assertFalse(w.client.link.pending)
        w.client.choice.completeRecorded(grant, null)
        assertTrue(w.client.link.pending)
        // A grant this client did not start (an exchange's) does not open it.
        val other = world()
        other.client.choice.completeRecorded(grant, null)
        assertFalse(other.client.link.pending)
    }

    @Test
    fun theProductWithoutALinkRouteHasNoOffer() = runBlocking {
        val w = world(linkRoute = false)
        w.signInOnThisDevice()
        assertEquals(LinkOfferResult.Unavailable, w.client.link.offer())
        assertEquals(LinkAcceptResult.Unavailable, w.client.link.accept(handle))
        assertTrue(w.reqs("/djdl/identity/link").isEmpty())
    }

    @Test
    fun anotherAccountSigningInClosesTheOffer() = runBlocking {
        val w = world()
        w.signInOnThisDevice()
        w.core.storeSignIn("pkeyt_other", "ps_another", TokenSource.signin, personInitiated = true)
        assertEquals(LinkOfferResult.Unavailable, w.client.link.offer())
        assertFalse(w.client.link.pending)
    }

    // ── the bearer on the redirect redeem ───────────────────────────────────────────────────────

    @Test
    fun theHeldTokenRidesTheRedeemToAnOnProductTokenEndpointOnly() = runBlocking {
        val w = world()
        w.client.redeemForm("$base/token", "x=y", false)
        assertEquals("Bearer pkeyt_old", w.reqs("/djdl/identity/token").single().header("authorization"))
        // Off product: another host, a host that merely starts with the product's, another product's path.
        for (off in listOf("https://evil.example/djdl/identity/token", "https://key.plrs.im.evil.example/djdl/identity/token")) {
            val x = world()
            // The scripted Worker answers 404 off its paths; only the request matters here.
            runCatching { x.client.redeemForm(off, "x=y", false) }
            val sent = x.transport.requests().filter { it.url == off }
            assertEquals(1, sent.size)
            assertNull(sent.single().header("authorization"))
        }
        // No token held, no header.
        val bare = world(held = null)
        bare.client.redeemForm("$base/token", "x=y", false)
        assertNull(bare.reqs("/djdl/identity/token").single().header("authorization"))
    }

    // ── rule 2: the proof ───────────────────────────────────────────────────────────────────────

    @Test
    fun acceptWithAHandlePostsAProofBoundToTheHandleAndDropsIt() = runBlocking {
        val w = world()
        w.signInOnThisDevice()
        val keys = w.port.ensure()
        val linked = w.client.link.accept(handle) as LinkAcceptResult.Linked
        assertEquals("apple", linked.kind)
        assertEquals("global", linked.reach)
        val post = w.reqs("/djdl/identity/link").single { it.method == "POST" }
        assertEquals("Bearer pkeyt_signed", post.header("authorization"))
        val b = body(post)
        assertEquals(setOf("linkHandle", "proof"), b.keys)
        val proof = DeviceProof(DeviceProofFields("link", "djdl", device, handle, "-"), keys.signKey, b["proof"].stringValue!!)
        assertTrue(DeviceProofs.verify(proof))
        // Not a proof for another handle, another purpose or another device.
        assertFalse(DeviceProofs.verify(proof.copy(fields = proof.fields.copy(value = otherHandle))))
        assertFalse(DeviceProofs.verify(proof.copy(fields = proof.fields.copy(purpose = "exchange"))))
        assertFalse(DeviceProofs.verify(proof.copy(fields = proof.fields.copy(deviceId = "OTHER000000000000000000000000001"))))
        // pending semantics: the app closes the offer (the kit calls dismiss() after Linked).
        assertTrue(w.client.link.pending)
        w.client.link.dismiss()
        assertFalse(w.client.link.pending)
    }

    @Test
    fun theProviderPathAsksForANonceAndProvesTheTokenHash() = runBlocking {
        val w = world()
        val provider = FakeProvider(ExchangeKind.pgs, "4/auth-code")
        w.client.installPlatformIdentity(provider)
        w.signInOnThisDevice()
        w.answers.link = 200 to """{"linked":{"kind":"pgs","reach":"developer"}}"""
        val keys = w.port.ensure()
        val linked = w.client.link.accept() as LinkAcceptResult.Linked
        assertEquals(LinkAcceptResult.Linked("pgs", "developer"), linked)
        assertEquals(1, provider.sheets)
        val post = w.reqs("/djdl/identity/link").single { it.method == "POST" }
        val b = body(post)
        assertEquals("4/auth-code", b["subjectToken"].stringValue)
        assertEquals("urn:polaris-key:token-type:pgs-server-auth-code", b["subjectTokenType"].stringValue)
        assertEquals(nonce1, b["nonce"].stringValue)
        assertEquals(keys.signKey, b["signKey"].stringValue)
        val proof = DeviceProof(
            DeviceProofFields("link", "djdl", device, "$nonce1.${keys.signKey}", IdentityExchange.tokenHash("4/auth-code")),
            keys.signKey,
            b["proof"].stringValue!!,
        )
        assertTrue(DeviceProofs.verify(proof))
    }

    @Test
    fun withNoHandleAndNoProviderAcceptIsUnavailable() = runBlocking {
        val w = world()
        w.signInOnThisDevice()
        assertEquals(LinkAcceptResult.Unavailable, w.client.link.accept())
        assertTrue(w.reqs("/djdl/identity/link").isEmpty())
    }

    // ── the held handle ─────────────────────────────────────────────────────────────────────────

    @Test
    fun theHandleAnExchangeLeftIsHeldAndSpentByTheAttemptThatUsesIt() = runBlocking {
        val w = world()
        w.answers.token =
            403 to """{"error":"interstitial_required","reason":"no_link","url":"$base/authorize","linkHandle":"$handle","expiresIn":600}"""
        val out = w.client.exchangeWithFreshNonce(ExchangeKind.google, "tok") as ExchangeOutcome.NeedsSignIn
        assertEquals(handle, out.linkHandle)
        w.answers.token = 200 to tokenOk
        w.signInOnThisDevice()
        w.client.link.accept()
        val first = body(w.reqs("/djdl/identity/link").single { it.method == "POST" })
        assertEquals(handle, first["linkHandle"].stringValue)
        // Spent: a second accept has no handle and no provider.
        assertEquals(LinkAcceptResult.Unavailable, w.client.link.accept())
    }

    @Test
    fun aStaleStepUpLeavesTheHandleAndAConflictIsRememberedAsADecline() = runBlocking {
        val w = world()
        w.signInOnThisDevice()
        w.client.linkMemory.hold(handle, w.core.now() + 600)
        w.answers.link = 401 to """{"error":{"code":"step_up_required"}}"""
        assertEquals(LinkAcceptResult.Refused(401, ErrorCode.stepUpRequired), w.client.link.accept())
        assertEquals(LinkAcceptResult.Refused(401, ErrorCode.stepUpRequired), w.client.link.accept())
        val posts = w.reqs("/djdl/identity/link").filter { it.method == "POST" }
        assertEquals(listOf(handle, handle), posts.map { body(it)["linkHandle"].stringValue })
        w.answers.link = 409 to """{"error":{"code":"link_conflict"}}"""
        assertEquals(LinkAcceptResult.Refused(409, ErrorCode.linkConflict), w.client.link.accept())
        // Remembered: the offer is gone and nothing more is sent.
        val before = w.transport.requests().size
        assertEquals(LinkOfferResult.Unavailable, w.client.link.offer())
        assertEquals(before, w.transport.requests().size)
    }

    @Test
    fun theRefusalsAreTyped() = runBlocking {
        for ((status, code) in listOf(404 to "not_found", 400 to "invalid_grant", 401 to "step_up_required", 409 to "link_conflict")) {
            val w = world()
            w.signInOnThisDevice()
            w.answers.link = status to """{"error":{"code":"$code"}}"""
            assertEquals(LinkAcceptResult.Refused(status, code), w.client.link.accept(handle))
        }
        val w = world()
        w.signInOnThisDevice()
        w.answers.link = 500 to """{"error":{"code":"server_error"}}"""
        try {
            w.client.link.accept(handle)
            fail("a 5xx throws")
        } catch (e: PolarisException) {
            assertFalse(e.message!!.contains(handle))
        }
        // A handle that is not shaped like one never reaches the Worker.
        val shaped = world()
        shaped.signInOnThisDevice()
        assertEquals(LinkAcceptResult.Refused(404, ErrorCode.notFound), shaped.client.link.accept("lh_short"))
        assertTrue(shaped.reqs("/djdl/identity/link").isEmpty())
    }

    // ── rule 3: decline ─────────────────────────────────────────────────────────────────────────

    @Test
    fun declineKeepsTheHashOfIssuerAndSubjectOnlyAndOutlivesTheClient() = runBlocking {
        val dir = java.nio.file.Files.createTempDirectory("pkey-link").toFile()
        try {
            val w = world(stateDir = dir)
            w.signInOnThisDevice()
            w.client.link.decline()
            assertFalse(w.client.link.pending)
            val want = Base64Url.encode(java.security.MessageDigest.getInstance("SHA-256").digest("$base$sub".toByteArray()))
            val text = File(dir, "link-declined").readText()
            assertEquals(want, text.trim())
            assertFalse(text.contains(sub))
            // A new client over the same directory: the same account's next sign-in gets no offer and no request.
            val again = world(stateDir = dir)
            again.signInOnThisDevice()
            val before = again.transport.requests().size
            assertEquals(LinkOfferResult.Unavailable, again.client.link.offer())
            assertEquals(before, again.transport.requests().size)
            // Another account is not covered.
            val other = world(stateDir = dir)
            other.answers.token = 200 to other.answers.token.second.replace(sub, "ps_someoneelse")
            other.signInOnThisDevice()
            assertTrue(other.client.link.offer() is LinkOfferResult.Ok)
        } finally {
            dir.deleteRecursively()
        }
    }

    @Test
    fun dismissIsNotADecline() = runBlocking {
        val w = world()
        w.signInOnThisDevice()
        w.client.link.dismiss()
        w.signInOnThisDevice()
        assertTrue(w.client.link.offer() is LinkOfferResult.Ok)
    }

    @Test
    fun theDeclinedSetIsCapped() = runBlocking {
        val dir = java.nio.file.Files.createTempDirectory("pkey-link").toFile()
        try {
            val w = world(stateDir = dir)
            for (i in 0 until 70) w.client.linkDeclined.remember("key$i")
            val lines = File(dir, "link-declined").readText().split('\n')
            assertEquals(64, lines.size)
            assertEquals("key69", lines.last())
        } finally {
            dir.deleteRecursively()
        }
    }

    // ── rule 2: nothing secret prints ───────────────────────────────────────────────────────────

    @Test
    fun noHandleOrTokenReachesAnErrorOrAToString() = runBlocking {
        val w = world()
        w.signInOnThisDevice()
        w.answers.link = 403 to """{"error":{"code":"forbidden"},"echo":"$handle"}"""
        try {
            w.client.link.accept(handle)
            fail("expected a failure")
        } catch (e: PolarisException) {
            for (secret in listOf(handle, "pkeyt_signed")) {
                assertFalse(e.message!!.contains(secret))
                assertFalse(e.toString().contains(secret))
            }
        }
        val refused = LinkAcceptResult.Refused(401, "step_up_required").toString()
        assertFalse(refused.contains(handle))
        assertNotNull(w.client.link)
    }
}
