// @pkey-feature identity.exchange
//
// The Kotlin exchange primitive (I-45.1; WIRE-CONTRACT-V5 section 12.11.2 and 12.11.3) against a scripted
// Worker: the nonce route and the token form with a verifying `exchange` proof, every outcome, single-use
// nonces, the typed Unavailable results, and no token, grant or handle in a toString or an error.
// The recorded conversations are replayed by the conformance runner (I-45.3).

package im.plrs.key.identity

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
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.path
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.net.URLDecoder

@OptIn(ConformanceReplayOnly::class)
class IdentityExchangeTest {
    /** A durable-looking in-memory storage, so the happy paths pass the memory-only refusal. */
    private class DurableMem(private val inner: InMemoryDeviceKeyStorage = InMemoryDeviceKeyStorage()) : DeviceKeyStorage by inner {
        override val persistence: DeviceKeyPersistence = DeviceKeyPersistence.durable
    }

    private val nonce1 = "-ajcZR-muye01GgH7qFEoDrU4G1DAv5L3MquJLU7_8Q"
    private val subjectToken = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJnLXN1Yi0xIn0.c2ln"
    private val grant = "sg_" + "B".repeat(43)
    private val handle = "lh_" + "C".repeat(43)
    private val base = "https://key.plrs.im/djdl/identity"
    private val exchangeMember = """"exchange":{"kinds":["google","apple"],"google":{"serverClientId":"1234-web.apps.googleusercontent.com"}},"""
    private val tokenOk = """{"access_token":"pkeyt_exchanged","token_type":"Bearer","scope":"profile email","schemaVersion":1,""" +
        """"device":{"id":"D"},"license":null,"subject":"ps_QQMMVm-ciTWvmWEIfhAVgQ","issued_token_type":"urn:polaris-key:token-type:device"}"""
    private val consentBody =
        """{"status":"confirm","grant":"$grant","expiresIn":300,""" +
            """"consent":{"client":{"appName":"djdl","developerName":null,"iconUrl":null,"nameVerified":true},""" +
            """"as":{"provider":"google","email":"ada@example.com"},"items":[{"kind":"profile","claims":["name","email"]}],""" +
            """"scopeHash":"abc","firstTime":true,"changed":false}}"""
    private val chooseBody =
        """{"status":"choose","grant":"$grant","expiresIn":300,""" +
            """"choices":{"state":"choose","choices":[{"id":"lic_1","state":"free"}]}}"""

    private class World(
        val client: IdentityClient,
        val transport: ScriptedTransport,
        val store: InMemoryStore,
        val port: DeviceKeyPort,
        val core: CoreContext,
    )

    private fun discovery(member: String, endpoints: String) =
        """{"product":"djdl","services":{"identity":{"enabled":true,"configured":true,$member"endpoints":{$endpoints}}}}"""

    private val allEndpoints = """"nonce":"$base/nonce","token":"$base/token","choiceComplete":"$base/choice/complete""""

    private fun world(
        member: String = exchangeMember,
        endpoints: String = allEndpoints,
        nonceStatus: Int = 200,
        nonceBody: String = """{"nonce":"$nonce1","expiresIn":300}""",
        tokenStatus: Int = 200,
        tokenBody: String = tokenOk,
        tokenHeaders: Map<String, String> = emptyMap(),
        keys: Boolean = true,
        memory: Boolean = false,
    ): World {
        val store = InMemoryStore("djdl", "DEVICE00000000000000000000000001")
        runBlocking { store.setToken("pkeyt_old") }
        var n = 0
        val transport = ScriptedTransport { r: PolarisRequest ->
            when (r.path) {
                "/djdl/.well-known/polaris.json" -> respond(200, discovery(member, endpoints))

                "/djdl/identity/nonce" -> respond(
                    nonceStatus,
                    if (nonceStatus == 200 &&
                        nonceBody.contains(nonce1)
                    ) {
                        nonceBody.replace(nonce1, nonce1.dropLast(2) + "%02d".format(n++))
                    } else {
                        nonceBody
                    },
                )

                "/djdl/identity/token" -> respond(tokenStatus, tokenBody, tokenHeaders)

                "/djdl/identity/choice/complete" -> respond(200, tokenOk)

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
        val port = DeviceKeyStore(if (memory) InMemoryDeviceKeyStorage() else DurableMem())
        return World(IdentityClient(core, deviceKeys = if (keys) port else null), transport, store, port, core)
    }

    private fun form(body: ByteArray): Map<String, String> = String(body).split("&").associate { p ->
        p.substringBefore("=").let { URLDecoder.decode(it, "UTF-8") } to
            URLDecoder.decode(p.substringAfter("="), "UTF-8")
    }

    private suspend fun World.reqs(path: String) = transport.requests().filter { it.path == path }

    @Test
    fun theNonceRouteGetsTheKeysAndTheTokenFormCarriesAProofThatVerifies() = runBlocking {
        val w = world()
        val nonce = (w.client.exchangeNonce(ExchangeKind.google) as ExchangeNonceResult.Issued).nonce
        val keys = w.port.ensure()
        val nonceReq = w.reqs("/djdl/identity/nonce").single()
        assertEquals("POST", nonceReq.method)
        assertEquals("""{"signKey":"${keys.signKey}","agreeKey":"${keys.agreeKey}"}""", String(nonceReq.body!!))
        val out = w.client.exchange(ExchangeKind.google, subjectToken, nonce) as ExchangeOutcome.SignedIn
        assertEquals(ExchangeOutcome.SignedIn("ps_QQMMVm-ciTWvmWEIfhAVgQ", "profile email", null, "urn:polaris-key:token-type:device"), out)
        val req = w.reqs("/djdl/identity/token").single()
        assertEquals("application/x-www-form-urlencoded", req.headers.entries.first { it.key.equals("content-type", true) }.value)
        assertEquals("DEVICE00000000000000000000000001", req.headers.entries.first { it.key.equals("x-pkey-device", true) }.value)
        val f = form(req.body!!)
        assertEquals(
            listOf("grant_type", "client_id", "subject_token", "subject_token_type", "nonce", "device_key", "proof"),
            String(req.body!!).split("&").map { it.substringBefore("=") },
        )
        assertEquals("urn:ietf:params:oauth:grant-type:token-exchange", f["grant_type"])
        assertEquals("djdl", f["client_id"])
        assertEquals(subjectToken, f["subject_token"])
        assertEquals("urn:ietf:params:oauth:token-type:id_token", f["subject_token_type"])
        assertEquals(nonce.value, f["nonce"])
        assertEquals(keys.signKey, f["device_key"])
        val proof = DeviceProof(
            DeviceProofFields(
                "exchange",
                "djdl",
                "DEVICE00000000000000000000000001",
                "${nonce.value}.${keys.signKey}",
                IdentityExchange.tokenHash(subjectToken),
            ),
            keys.signKey,
            f["proof"]!!,
        )
        assertTrue(DeviceProofs.verify(proof))
        // The same proof over another token must not verify.
        assertFalse(DeviceProofs.verify(proof.copy(fields = proof.fields.copy(tokenHash = IdentityExchange.tokenHash("other")))))
        // Stored like any sign-in; no bearer rode either request.
        assertEquals("pkeyt_exchanged", w.store.getToken())
        assertEquals("ps_QQMMVm-ciTWvmWEIfhAVgQ", w.core.storedSubject())
        for (r in listOf(nonceReq, req)) assertNull(r.headers.entries.firstOrNull { it.key.equals("authorization", true) })
    }

    @Test
    fun confirmIsPendingConsentAndStoresNothing() = runBlocking {
        val w = world(tokenBody = consentBody)
        val out = w.client.exchangeWithFreshNonce(ExchangeKind.google, subjectToken) as ExchangeOutcome.PendingConsent
        assertEquals(grant, out.grant)
        assertEquals(300.0, out.expiresInSeconds, 0.0)
        assertTrue(out.consent.firstTime)
        assertFalse(out.consent.changed)
        assertEquals("google", out.consent.asProvider)
        assertEquals("ada@example.com", out.consent.asEmail)
        assertEquals("djdl", out.consent.appName)
        assertEquals("pkeyt_old", w.store.getToken())
        assertNull(w.core.storedSubject())
        assertFalse(out.toString().contains(grant))
    }

    @Test
    fun chooseIsPendingSignInAndStoresNothing() = runBlocking {
        val w = world(tokenBody = chooseBody)
        val out = w.client.exchangeWithFreshNonce(ExchangeKind.google, subjectToken) as ExchangeOutcome.PendingSignIn
        assertEquals(grant, out.grant)
        assertEquals(listOf("lic_1"), out.choices.licenseIds)
        assertEquals("pkeyt_old", w.store.getToken())
        assertFalse(out.toString().contains(grant))
    }

    @Test
    fun interstitialRequiredIsNeedsSignInWithTheLinkHandle() = runBlocking {
        val w =
            world(
                tokenStatus = 403,
                tokenBody = """{"error":"interstitial_required","reason":"no_link","url":"$base/authorize","linkHandle":"$handle","expiresIn":600}""",
            )
        val out = w.client.exchangeWithFreshNonce(ExchangeKind.google, subjectToken) as ExchangeOutcome.NeedsSignIn
        assertEquals("no_link", out.reason)
        assertEquals("$base/authorize", out.url)
        assertEquals(handle, out.linkHandle)
        assertEquals(600L, out.expiresInSeconds)
        assertFalse(out.toString().contains(handle))
        assertEquals("pkeyt_old", w.store.getToken())
        val terms = world(tokenStatus = 403, tokenBody = """{"error":"interstitial_required","reason":"terms","url":"$base/authorize"}""")
        val t = terms.client.exchangeWithFreshNonce(ExchangeKind.google, subjectToken) as ExchangeOutcome.NeedsSignIn
        assertEquals("terms", t.reason)
        assertNull(t.linkHandle)
        val odd = world(tokenStatus = 403, tokenBody = """{"error":"interstitial_required","reason":"surprise","url":"$base/authorize"}""")
        assertEquals("no_link", (odd.client.exchangeWithFreshNonce(ExchangeKind.google, subjectToken) as ExchangeOutcome.NeedsSignIn).reason)
    }

    private suspend fun refusal(w: World): PolarisException {
        try {
            w.client.exchangeWithFreshNonce(ExchangeKind.google, subjectToken)
        } catch (e: PolarisException) {
            assertFalse(e.message!!.contains(subjectToken))
            assertEquals("pkeyt_old", w.store.getToken())
            return e
        }
        fail("expected a PolarisException")
        error("unreachable after fail")
    }

    @Test
    fun refusalsThrowATypedExceptionWithTheWireCodeStatusAndRetry() = runBlocking {
        val g = refusal(world(tokenStatus = 400, tokenBody = """{"error":"invalid_grant"}"""))
        assertEquals("invalid_grant", g.code)
        assertEquals(400, g.httpStatus)
        assertNull(g.retryAfterSeconds)
        val l = refusal(world(tokenStatus = 429, tokenBody = """{"error":"rate_limited","retryAfter":4.2}"""))
        assertEquals("rate_limited", l.code)
        assertEquals(5, l.retryAfterSeconds)
        val h = refusal(world(tokenStatus = 429, tokenBody = """{"error":"rate_limited"}""", tokenHeaders = mapOf("retry-after" to "7")))
        assertEquals(7, h.retryAfterSeconds)
        val n = refusal(world(tokenStatus = 403, tokenBody = """{"error":{"code":"device_limit"}}"""))
        assertEquals("device_limit", n.code)
        assertEquals(403, n.httpStatus)
        assertEquals("unsupported_grant_type", refusal(world(tokenStatus = 400, tokenBody = """{"error":"unsupported_grant_type"}""")).code)
        // A nonce-route refusal throws too.
        val w = world(nonceStatus = 429, nonceBody = """{"error":"rate_limited"}""")
        try {
            w.client.exchangeNonce(ExchangeKind.google)
            fail("expected rate_limited")
        } catch (e: PolarisException) {
            assertEquals("rate_limited", e.code)
        }
    }

    @Test
    fun memoryOnlyKeysAreRefusedBeforeAnyRequest() = runBlocking {
        val w = world(memory = true)
        assertEquals(
            ExchangeNonceResult.Ended(ExchangeOutcome.Unavailable(ExchangeUnavailableReason.memoryOnlyKeys)),
            w.client.exchangeNonce(ExchangeKind.google),
        )
        assertEquals(
            ExchangeOutcome.Unavailable(ExchangeUnavailableReason.memoryOnlyKeys),
            w.client.exchange(ExchangeKind.google, subjectToken, ExchangeNonce(nonce1)),
        )
        assertEquals(
            ExchangeOutcome.Unavailable(ExchangeUnavailableReason.memoryOnlyKeys),
            w.client.exchangeWithFreshNonce(ExchangeKind.google, subjectToken),
        )
        assertTrue(w.reqs("/djdl/identity/nonce").isEmpty() && w.reqs("/djdl/identity/token").isEmpty())
        assertEquals("pkeyt_old", w.store.getToken())
    }

    @Test
    fun theInterstitialUrlMustBeHttpsOrLoopbackAndAnUnknownReasonCarriesNoHandle() = runBlocking {
        fun body(url: String, reason: String = "no_link") =
            """{"error":"interstitial_required","reason":"$reason","url":"$url","linkHandle":"$handle","expiresIn":600}"""
        for (bad in listOf("http://key.plrs.im/x", "javascript:alert(1)", "//evil", "")) {
            val w = world(tokenStatus = 403, tokenBody = body(bad))
            try {
                w.client.exchangeWithFreshNonce(ExchangeKind.google, subjectToken)
                fail("expected bad-response for $bad")
            } catch (e: PolarisException) {
                assertEquals(ErrorCode.badResponse, e.code)
            }
        }
        val loop = world(tokenStatus = 403, tokenBody = body("http://localhost:8787/x"))
        assertEquals(handle, (loop.client.exchangeWithFreshNonce(ExchangeKind.google, subjectToken) as ExchangeOutcome.NeedsSignIn).linkHandle)
        val odd = world(tokenStatus = 403, tokenBody = body("https://key.plrs.im/x", "surprise"))
        val o = odd.client.exchangeWithFreshNonce(ExchangeKind.google, subjectToken) as ExchangeOutcome.NeedsSignIn
        assertEquals("no_link", o.reason)
        assertNull(o.linkHandle)
    }

    @Test
    fun aShortOrOddNonceIsRefused() = runBlocking {
        val w = world(nonceBody = """{"nonce":"short","expiresIn":300}""")
        try {
            w.client.exchangeNonce(ExchangeKind.google)
            fail("expected bad-response")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.badResponse, e.code)
        }
    }

    @Test
    fun unavailableOnA404OrNoMemberOrAnUndeclaredKindOrNoKeys() = runBlocking {
        val notFound = world(nonceStatus = 404, nonceBody = """{"error":{"code":"not_found"}}""")
        assertEquals(
            ExchangeOutcome.Unavailable(ExchangeUnavailableReason.notServed),
            notFound.client.exchangeWithFreshNonce(ExchangeKind.google, subjectToken),
        )
        assertTrue(notFound.reqs("/djdl/identity/token").isEmpty())
        assertEquals(
            ExchangeNonceResult.Ended(ExchangeOutcome.Unavailable(ExchangeUnavailableReason.notServed)),
            notFound.client.exchangeNonce(ExchangeKind.google),
        )
        val tokenGone = world(tokenStatus = 404, tokenBody = """{"error":"not_found"}""")
        assertEquals(
            ExchangeOutcome.Unavailable(ExchangeUnavailableReason.notServed),
            tokenGone.client.exchangeWithFreshNonce(ExchangeKind.google, subjectToken),
        )
        val noMember = world(member = "")
        assertEquals(
            ExchangeOutcome.Unavailable(ExchangeUnavailableReason.noMember),
            noMember.client.exchangeWithFreshNonce(ExchangeKind.google, subjectToken),
        )
        val googleOnly = world(member = """"exchange":{"kinds":["google"]},""")
        assertEquals(
            ExchangeOutcome.Unavailable(ExchangeUnavailableReason.kindNotDeclared),
            googleOnly.client.exchangeWithFreshNonce(ExchangeKind.apple, subjectToken),
        )
        val noNonce = world(endpoints = """"token":"$base/token"""")
        assertEquals(
            ExchangeOutcome.Unavailable(ExchangeUnavailableReason.noEndpoint),
            noNonce.client.exchangeWithFreshNonce(ExchangeKind.google, subjectToken),
        )
        val noKeys = world(keys = false)
        assertEquals(
            ExchangeOutcome.Unavailable(ExchangeUnavailableReason.noDeviceKeys),
            noKeys.client.exchangeWithFreshNonce(ExchangeKind.google, subjectToken),
        )
        for (w in listOf(noMember, googleOnly, noNonce, noKeys)) {
            assertTrue(w.reqs("/djdl/identity/nonce").isEmpty() && w.reqs("/djdl/identity/token").isEmpty())
            assertEquals("pkeyt_old", w.store.getToken())
        }
    }

    @Test
    fun aNonceIsSingleUse() = runBlocking {
        val w = world()
        val a = (w.client.exchangeNonce(ExchangeKind.google) as ExchangeNonceResult.Issued).nonce
        val b = (w.client.exchangeNonce(ExchangeKind.google) as ExchangeNonceResult.Issued).nonce
        assertNotEquals(a.value, b.value)
        w.client.exchange(ExchangeKind.google, subjectToken, a)
        try {
            w.client.exchange(ExchangeKind.google, subjectToken, a)
            fail("expected a refusal of the spent nonce")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.invalidArgument, e.code)
        }
        assertEquals(1, w.reqs("/djdl/identity/token").size)
        // Without one, each exchange asks for its own.
        w.client.exchangeWithFreshNonce(ExchangeKind.google, subjectToken)
        w.client.exchangeWithFreshNonce(ExchangeKind.google, subjectToken)
        val sent = w.reqs("/djdl/identity/token").map { form(it.body!!)["nonce"] }
        assertEquals(sent.size, sent.toSet().size)
        assertFalse(a.toString().contains(a.value))
    }

    @Test
    fun aServerErrorThrowsWithoutTheTokenAndNothingIsStored() = runBlocking {
        val w = world(tokenStatus = 503, tokenBody = "down $subjectToken")
        try {
            w.client.exchangeWithFreshNonce(ExchangeKind.google, subjectToken)
            fail("expected server-error")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.serverError, e.code)
            assertFalse(e.message!!.contains(subjectToken))
        }
        assertEquals("pkeyt_old", w.store.getToken())
    }

    @Test
    fun aMalformedSignInThrowsAndStoresNothing() = runBlocking {
        val w = world(tokenBody = """{"access_token":"pkeyt_x"}""")
        try {
            w.client.exchangeWithFreshNonce(ExchangeKind.google, subjectToken)
            fail("expected bad-response")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.badResponse, e.code)
            assertFalse(e.message!!.contains("pkeyt_x"))
        }
        assertEquals("pkeyt_old", w.store.getToken())
    }

    @Test
    fun completeWithConsentSendsTheGrantAndTheConsentAndNoChoice() = runBlocking {
        val w = world()
        val r = w.client.choice.complete(grant, null, ConsentInput(listOf("profile", "email"))) as ChoiceResult.Ok
        assertEquals("ps_QQMMVm-ciTWvmWEIfhAVgQ", r.value.subject)
        val sent = w.reqs("/djdl/identity/choice/complete").single()
        assertEquals("""{"grant":"$grant","consent":{"claims":["profile","email"]}}""", String(sent.body!!))
        assertNull(sent.headers.entries.firstOrNull { it.key.equals("authorization", true) })
        assertEquals("pkeyt_exchanged", w.store.getToken())
        // Choice and consent together.
        w.client.choice.complete(grant, LicenseChoice.License("lic_1"), ConsentInput(listOf("profile")))
        val both = w.reqs("/djdl/identity/choice/complete").last()
        assertEquals("""{"grant":"$grant","choice":{"kind":"license","licenseId":"lic_1"},"consent":{"claims":["profile"]}}""", String(both.body!!))
    }
}
