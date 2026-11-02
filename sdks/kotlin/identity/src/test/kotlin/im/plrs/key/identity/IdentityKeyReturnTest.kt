// @pkey-feature identity.keyreturn
//
// LK-SKIP.10: the key return of the redirect channel, web and native. The opt-in is never sent unless set; a
// `via: "key"` body is an activation only with it; the session stores a key activation and clears the stored subject; the
// refusals a key bind shares with `license/activate` surface with their details. The wire conversations are the transcripts' (redirect-web-key-return*).

package im.plrs.key.identity

import im.plrs.key.core.CoreContext
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.TokenProvenance
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.path
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.net.URI
import java.net.URLDecoder

class IdentityKeyReturnTest {
    private val api = "https://key.example/djdl"
    private val redirect = "https://app.example/cb"
    private val subject = "ps_" + "a".repeat(22)
    private val keyBody = """{"access_token":"pkeyt_key","token_type":"Bearer","scope":"","via":"key","schemaVersion":1,""" +
        """"device":{"id":"D"},"license":{"id":"lic_1"},"keyEntries":{"used":2,"limit":10},"subject":null}"""
    private val signInBody = """{"access_token":"pkeyt_new","token_type":"Bearer","scope":"profile email","schemaVersion":1,""" +
        """"device":{"id":"D"},"license":{"id":"lic_1"},"subject":"$subject"}"""

    private fun parse(status: Int, body: String, keyReturn: Boolean) =
        IdentityRedirect.parseTokenAnswer(status, JsonText.parseOrNull(body), keyReturn)

    private class World(val client: IdentityClient, val core: CoreContext, val store: InMemoryStore, val subjects: MutableList<String?>)

    private fun world(tokenReply: (PolarisRequest) -> im.plrs.key.core.PolarisResponse): World {
        val store = InMemoryStore("djdl", "dev")
        val transport = ScriptedTransport { r: PolarisRequest ->
            when (r.path) {
                "/djdl/.well-known/polaris.json" -> respond(
                    200,
                    """{"product":"djdl","services":{"identity":{"enabled":true,"configured":true,"issuer":"$api/identity",""" +
                        """"endpoints":{"authorize":"$api/identity/authorize","token":"$api/identity/token"}}}}""",
                )

                "/djdl/identity/token" -> tokenReply(r)

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
        val subjects = ArrayList<String?>()
        val client = IdentityClient(core, onSubject = { subjects += it }).also {
            @OptIn(ConformanceReplayOnly::class)
            it.redirectAcquisitionSync = false
        }
        return World(client, core, store, subjects)
    }

    private fun param(url: String, name: String): String? = URI(url).rawQuery.split('&').map {
        it.split('=', limit = 2)
    }.firstOrNull { it[0] == name }?.getOrNull(1)?.let { URLDecoder.decode(it, "UTF-8") }

    private suspend fun begin(w: World, keyReturn: Boolean): Pair<SignInSession, String> {
        val s = w.client.signIn.start(SignInOptions(channel = SignInChannel.Redirect, redirectUri = redirect, keyReturn = keyReturn))
        return s to param(s.authorizeUrl!!, "state")!!
    }

    private fun callback(state: String) = "$redirect?code=C0DE&state=$state&iss=https%3A%2F%2Fkey.example%2Fdjdl%2Fidentity"

    // Rule 1: the opt-in is never sent unless set, web and native.
    @Test
    fun theOptInIsSentLastAndOnlyWhenSet() = runBlocking {
        val w = world { respond(404) }
        val (bare, _) = begin(w, false)
        assertNull(param(bare.authorizeUrl!!, "key_return"))
        val (opted, _) = begin(w, true)
        assertEquals("allow", param(opted.authorizeUrl!!, "key_return"))
        assertTrue(opted.authorizeUrl!!.endsWith("&key_return=allow"))
        assertFalse(SignInOptions().keyReturn)
        assertFalse(
            IdentityRedirect.start(
                "$api/identity/authorize",
                "$api/identity/token",
                "$api/identity",
                "djdl",
                redirect,
            ).authorizeUrl.contains("key_return"),
        )
    }

    @Test
    fun theNativePushCarriesTheOptInBeforeTheDeviceName() {
        val ep = NativeEndpoints("$api/identity/request", "$api/identity/authorize", "$api/identity/token", "$api/identity", "djdl")
        val uri = "http://127.0.0.1:49152/pkey/callback"
        val entropy = PushEntropy(state = "tidewater-state-0123456789", codeVerifier = "transcript-verifier-0123456789-abcdefghijklmnopqrst")
        val bare = NativeRedirect.pushRequest(ep, uri, PushOptions(deviceName = "Mac"), entropy)
        assertFalse(bare.body.contains("key_return"))
        val opted = NativeRedirect.pushRequest(ep, uri, PushOptions(deviceName = "Mac", keyReturn = true), entropy)
        assertTrue(opted.body, opted.body.contains("&key_return=allow&device_name=Mac"))
    }

    // Rule 2: via "key" is an activation with the opt-in, malformed without it.
    @Test
    fun aKeyBodyIsAnActivationOnlyWithTheOptIn() {
        val got = parse(200, keyBody, true) as TokenAnswer.Activated
        assertEquals("pkeyt_key", got.accessToken)
        assertNull(got.subject)
        assertEquals(KeyReturnEntries(2, 10), got.keyEntries)
        assertEquals("[redacted]", got.toString().substringAfter("accessToken=").substringBefore(")"))
        assertEquals(TokenAnswer.Malformed, parse(200, keyBody, false))
        assertEquals(TokenAnswer.Malformed, parse(200, keyBody.replace("\"key\"", "\"other\""), true))
        assertEquals(subject, (parse(200, keyBody.replace("\"subject\":null", "\"subject\":\"$subject\""), true) as TokenAnswer.Activated).subject)
        for (bad in listOf(
            keyBody.replace("\"scope\":\"\"", "\"scope\":\"profile\""),
            keyBody.replace("\"subject\":null", "\"subject\":\"nope\""),
            keyBody.replace("\"license\":{\"id\":\"lic_1\"}", "\"license\":null"),
            keyBody.replace("\"used\":2", "\"used\":-1"),
            keyBody.replace("\"keyEntries\":{\"used\":2,\"limit\":10},", ""),
            keyBody.replace(",\"subject\":null", ""),
        )) {
            assertEquals(bad, TokenAnswer.Malformed, parse(200, bad, true))
        }
        assertTrue(parse(200, signInBody, true) is TokenAnswer.Token)
    }

    @Test
    fun activationStoresAKeyActivationAndClearsTheAccount() = runBlocking {
        val w = world { respond(200, keyBody) }
        w.core.setSubject(subject)
        val (s, state) = begin(w, true)
        val outcome = s.complete(callback(state))
        assertEquals(SignInOutcome.Activated("lic_1", KeyReturnEntries(2, 10), null), outcome)
        assertEquals("activated", outcome.kind)
        assertEquals("pkeyt_key", w.store.getToken())
        assertNull(w.core.storedSubject())
        assertEquals(TokenProvenance.key, w.core.tokenProvenance())
        assertEquals("the identity event is the subject cleared", listOf<String?>(null), w.subjects)
    }

    // A key return is a key activation: it leaves the explicit sign-out flag alone, so automatic sign-in stays signed out.
    @Test
    fun aKeyReturnLeavesTheExplicitSignOutFlagSet() = runBlocking {
        val w = world { respond(200, keyBody) }
        w.core.setExplicitSignOut(true)
        val (s, state) = begin(w, true)
        assertTrue(s.complete(callback(state)) is SignInOutcome.Activated)
        assertTrue(w.core.explicitSignOut())
        val auto = w.client.autoSignIn() as AutoSignInResult.NeedsSignIn
        assertEquals(AutoSignInReason.SignedOut, auto.reason)
    }

    @Test
    fun anAnsweredSubjectIsNotStored() = runBlocking {
        val w = world { respond(200, keyBody.replace("\"subject\":null", "\"subject\":\"$subject\"")) }
        val (s, state) = begin(w, true)
        assertEquals(SignInOutcome.Activated("lic_1", KeyReturnEntries(2, 10), null), s.complete(callback(state)))
        assertNull(w.core.storedSubject())
    }

    @Test
    fun withoutTheOptInTheSameBodyIsABadResponseAndStoresNothing() = runBlocking {
        val w = world { respond(200, keyBody) }
        val (s, state) = begin(w, false)
        try {
            s.complete(callback(state))
            fail("a key body was accepted without the opt-in")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.badResponse, e.code)
        }
        assertNull(w.store.getToken())
    }

    // Rule 2, refusals: flat, with their details.
    @Test
    fun refusalsSurfaceFlatWithTheirDetails() = runBlocking {
        suspend fun refusal(status: Int, body: String): SignInError {
            val w = world { respond(status, body) }
            val (s, state) = begin(w, true)
            try {
                s.complete(callback(state))
            } catch (e: SignInError) {
                assertNull("a refusal stores nothing", w.store.getToken())
                return e
            }
            throw AssertionError("not refused")
        }
        val owned = refusal(403, """{"error":"license_owned","signInUrl":"https://key.example/signin?product=djdl"}""")
        assertEquals("license_owned", owned.code)
        assertEquals(RefusalDetails(signInUrl = "https://key.example/signin?product=djdl"), owned.details)
        val entries =
            refusal(403, """{"error":"key_entry_limit","keyEntries":{"used":1,"limit":1},"manageUrl":"https://key.example/activate?product=djdl"}""")
        assertEquals("key_entry_limit", entries.code)
        assertEquals(RefusalDetails(keyEntries = KeyReturnEntries(1, 1), manageUrl = "https://key.example/activate?product=djdl"), entries.details)
        val seats = refusal(403, """{"error":"device_limit","limit":1,"deviceCount":1,"manageUrl":"https://key.example/activate"}""")
        assertEquals(RefusalDetails(limit = 1, deviceCount = 1, manageUrl = "https://key.example/activate"), seats.details)
        // A link that is not a plain https link is dropped; a refusal with no details has none.
        assertNull(refusal(403, """{"error":"license_owned","signInUrl":"javascript:alert(1)"}""").details)
        assertNull(refusal(400, """{"error":"invalid_grant"}""").details)
        assertNull(refusal(503, """{"error":"device_limit","limit":1}""").details)
    }

    // The device-code channel has no key return in v1.
    @Test
    fun theDeviceCodeChannelRefusesTheOption() = runBlocking {
        val w = world { respond(404) }
        try {
            w.client.signIn.start(SignInOptions(keyReturn = true))
            fail("device code took keyReturn")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.invalidArgument, e.code)
        }
    }
}
