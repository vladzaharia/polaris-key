// @pkey-feature identity.redirect.web identity.signin.hints
//
// I-10b.18: the redirect core's vectors, ported from client-core's `identityRedirect.test.ts` (RFC 7636
// appendix B, the transcript conversation's authorize URL and form body, the callback checks, the token
// answers). The wire conversation itself is the transcripts' (`redirect-web-*`, `locker-redirect-web`,
// `identity-request-hints`).

package im.plrs.key.identity

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class IdentityRedirectTest {
    private val iss = "https://key.plrs.im/djdl/identity"
    private val state = "tidewater-state-0123456789"
    private val verifier = "transcript-verifier-0123456789-abcdefghijklmnopqrst"
    private val redirect = "https://app.example/auth/callback"
    private val authorizeEndpoint = "https://key.plrs.im/djdl/identity/authorize"
    private val tokenEndpoint = "https://key.plrs.im/djdl/identity/token"
    private val auth = "$authorizeEndpoint?response_type=code&client_id=djdl&redirect_uri=https%3A%2F%2Fapp.example%2Fauth%2Fcallback&state=$state&code_challenge=-583Jx3Gn4AKAj7xr5NSDQ3V6snyKHhZUDKua28Tp10&code_challenge_method=S256&scope=profile+email"

    private fun begin(
        redirectUri: String = redirect,
        scope: List<String>? = null,
        loginHint: String? = null,
        nameHint: String? = null,
        purpose: String? = null,
        licenseChoice: String? = null,
        choiceAvailable: Boolean = false,
        issuer: String = iss,
        token: String = tokenEndpoint,
        state: String = this.state,
        codeVerifier: String = verifier,
    ): RedirectPending = IdentityRedirect.start(
        authorizeEndpoint = authorizeEndpoint, tokenEndpoint = token, issuer = issuer, clientId = "djdl",
        redirectUri = redirectUri, scope = scope, loginHint = loginHint, nameHint = nameHint, purpose = purpose,
        licenseChoice = licenseChoice, choiceAvailable = choiceAvailable, state = state, codeVerifier = codeVerifier,
    )

    // ── S256 PKCE ────────────────────────────────────────────────────────────────────────

    @Test
    fun pkceChallenges() {
        // RFC 7636 appendix B
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", IdentityRedirect.pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
        // the conformance/transcripts conversation
        assertEquals("-583Jx3Gn4AKAj7xr5NSDQ3V6snyKHhZUDKua28Tp10", IdentityRedirect.pkceChallenge(verifier))
    }

    @Test
    fun generatedVerifiersAndStates() {
        val a = IdentityRedirect.generateCodeVerifier()
        assertTrue(Regex("^[A-Za-z0-9_-]{43}$").matches(a))
        assertNotEquals(a, IdentityRedirect.generateCodeVerifier())
        assertTrue(Regex("^[A-Za-z0-9_-]{43}$").matches(IdentityRedirect.generateState()))
        assertEquals("A".repeat(43), IdentityRedirect.generateState { ByteArray(it) })
    }

    // ── The authorize URL ────────────────────────────────────────────────────────────────

    @Test
    fun authorizeUrlVectors() {
        val vectors: List<Triple<String, () -> RedirectPending, String>> = listOf(
            Triple("the plain request", { begin() }, auth),
            Triple(
                "hints, verbatim and form-encoded",
                { begin(loginHint = "Ada@Example.com", nameHint = "Ada", purpose = "attach") },
                "$auth&login_hint=Ada%40Example.com&name_hint=Ada&purpose=attach",
            ),
            Triple("a hint that is not an email is still sent as given", { begin(loginHint = "not an email") }, "$auth&login_hint=not+an+email"),
            Triple(
                "license_choice=app when asked and the choice endpoints exist",
                { begin(licenseChoice = "app", choiceAvailable = true) }, "$auth&license_choice=app",
            ),
            Triple("license_choice withheld when discovery has no choice endpoints", { begin(licenseChoice = "app", choiceAvailable = false) }, auth),
            Triple("license_choice=card is never sent", { begin(licenseChoice = "card", choiceAvailable = true) }, auth),
            Triple("a scope list", { begin(scope = listOf("profile", "cloudSync")) }, auth.replace("scope=profile+email", "scope=profile+cloudSync")),
            Triple("empty hints are dropped", { begin(loginHint = "", nameHint = "") }, auth),
            Triple("UTF-8, * and ~ in a hint (WHATWG form encoding)", { begin(nameHint = "Zoë * ~") }, "$auth&name_hint=Zo%C3%AB+*+%7E"),
        )
        for ((name, build, url) in vectors) {
            val pending = build()
            assertEquals(name, url, pending.authorizeUrl)
            assertEquals(name, state, pending.state)
            assertFalse(name, pending.authorizeUrl.contains(verifier))
        }
    }

    @Test
    fun randomEntropyYieldsARequestThatSatisfiesItsOwnRules() {
        val p = IdentityRedirect.start(authorizeEndpoint, tokenEndpoint, iss, "djdl", redirect)
        assertTrue(Regex("^[A-Za-z0-9_-]{43}$").matches(p.state))
        assertTrue(p.authorizeUrl.contains("state=${p.state}"))
        assertFalse(p.authorizeUrl.contains("code_verifier"))
    }

    @Test
    fun refusesBeforeAnythingIsBuilt() {
        val cases: List<Pair<String, () -> RedirectPending>> = listOf(
            "http redirect" to { begin(redirectUri = "http://app.example/cb") },
            "loopback http (I-15's)" to { begin(redirectUri = "http://127.0.0.1:8080/cb") },
            "a fragment" to { begin(redirectUri = "$redirect#x") },
            "userinfo" to { begin(redirectUri = "https://u:p@app.example/cb") },
            "a relative URI" to { begin(redirectUri = "/cb") },
            "a short state" to { begin(state = "short") },
            "a short verifier" to { begin(codeVerifier = "too-short") },
            "a verifier outside the unreserved set" to { begin(codeVerifier = "a".repeat(42) + "+") },
            "no issuer" to { begin(issuer = "") },
            "a relative token endpoint" to { begin(token = "/djdl/identity/token") },
            "an empty scope" to { begin(scope = listOf("  ")) },
        )
        for ((name, build) in cases) {
            try {
                build()
                fail("$name was accepted")
            } catch (e: PolarisException) {
                assertEquals(name, ErrorCode.invalidArgument, e.code)
            }
        }
    }

    @Test
    fun isRedirectUri() {
        assertTrue(IdentityRedirect.isRedirectUri(redirect))
        assertTrue(IdentityRedirect.isRedirectUri("https://app.example"))
        assertFalse(IdentityRedirect.isRedirectUri("https://app.example/a b"))
        assertFalse(IdentityRedirect.isRedirectUri("https://app.example\\@evil.example/"))
        assertFalse(IdentityRedirect.isRedirectUri(null))
    }

    @Test
    fun thePendingRequestNeverPrintsItsVerifier() {
        assertFalse(begin().toString().contains(verifier))
    }

    // ── checkCallback ────────────────────────────────────────────────────────────────────

    private fun check(url: String): CallbackResult = IdentityRedirect.checkCallback(state, redirect, iss, url)

    private fun failed(reason: CallbackFailure, error: String? = null): CallbackResult = CallbackResult.Failed(reason, error)

    @Test
    fun callbackVectors() {
        val issEnc = "https%3A%2F%2Fkey.plrs.im%2Fdjdl%2Fidentity"
        val ok = "$redirect?code=abc_DEF-123&state=$state&iss=$issEnc"
        val vectors: List<Triple<String, String, CallbackResult>> = listOf(
            Triple("a valid callback", ok, CallbackResult.Code("abc_DEF-123")),
            Triple("parameters in another order, with an extra one", "$redirect?iss=$issEnc&x=1&state=$state&code=c", CallbackResult.Code("c")),
            Triple("access_denied is cancelled", "$redirect?error=access_denied&state=$state&iss=$issEnc", CallbackResult.Cancelled),
            Triple(
                "another error is a failure, naming it", "$redirect?error=server_error&state=$state&iss=$issEnc",
                failed(CallbackFailure.AuthorizationError, "server_error"),
            ),
            Triple("a wrong state", ok.replace(state, "another-state-0123456789"), failed(CallbackFailure.StateMismatch)),
            Triple("no state", "$redirect?code=c&iss=$issEnc", failed(CallbackFailure.StateMismatch)),
            Triple(
                "a wrong issuer (mix-up, RFC 9207)", "$redirect?code=c&state=$state&iss=https%3A%2F%2Fevil.example%2Fdjdl%2Fidentity",
                failed(CallbackFailure.IssuerMismatch),
            ),
            Triple("no issuer", "$redirect?code=c&state=$state", failed(CallbackFailure.IssuerMismatch)),
            Triple(
                "state is checked before iss, and iss before error", "$redirect?error=access_denied&state=bad-state-0123456789&iss=x",
                failed(CallbackFailure.StateMismatch),
            ),
            Triple(
                "an access_denied from the wrong issuer is not a cancel", "$redirect?error=access_denied&state=$state&iss=x",
                failed(CallbackFailure.IssuerMismatch),
            ),
            Triple("no code", "$redirect?state=$state&iss=$issEnc", failed(CallbackFailure.MissingCode)),
            Triple("an empty code", "$redirect?code=&state=$state&iss=$issEnc", failed(CallbackFailure.MissingCode)),
            Triple("a repeated code", "$ok&code=other", failed(CallbackFailure.Malformed)),
            Triple("another redirect URI path", ok.replace("/auth/callback", "/other"), failed(CallbackFailure.RedirectMismatch)),
            Triple("another origin", ok.replace("app.example", "evil.example"), failed(CallbackFailure.RedirectMismatch)),
            Triple("a fragment carrying the code is not read", "$redirect#code=c&state=$state&iss=$issEnc", failed(CallbackFailure.StateMismatch)),
            Triple("not a URL", "code=c&state=x", failed(CallbackFailure.Malformed)),
        )
        for ((name, url, expected) in vectors) assertEquals(name, expected, check(url))
    }

    @Test
    fun aMalformedPercentEscapeIsMalformedNotACrash() {
        val r = check("$redirect?code=%E0%A4%A&state=$state")
        assertEquals(failed(CallbackFailure.Malformed), r)
        // A valid escape that is not UTF-8 is malformed too (decodeURIComponent throws).
        assertEquals(failed(CallbackFailure.Malformed), check("$redirect?code=%FF&state=$state"))
    }

    // ── tokenForm ────────────────────────────────────────────────────────────────────────

    @Test
    fun tokenFormHasAFixedMemberOrder() {
        val code = "pql7NwTrZq8ADBYf14sz1sjf4BSnZl-AaWyCGWs9TX0"
        assertEquals(
            "grant_type=authorization_code&client_id=djdl&code=$code&code_verifier=$verifier&redirect_uri=https%3A%2F%2Fapp.example%2Fauth%2Fcallback",
            IdentityRedirect.tokenForm("djdl", verifier, redirect, code),
        )
    }

    @Test
    fun tokenFormAddsDeviceNameLast() {
        val form = IdentityRedirect.tokenForm("djdl", verifier, redirect, "c", "Ada's PC")
        assertTrue(form, form.endsWith("&redirect_uri=https%3A%2F%2Fapp.example%2Fauth%2Fcallback&device_name=Ada%27s+PC"))
    }

    // ── parseTokenAnswer ─────────────────────────────────────────────────────────────────

    private val grant = "sg_" + "A".repeat(43)

    private fun json(text: String) = JsonText.parse(text)

    @Test
    fun aTokenResponse() {
        val answer = IdentityRedirect.parseTokenAnswer(
            200,
            json("""{"access_token":"pkeyt_x","token_type":"Bearer","scope":"profile email","schemaVersion":1,"device":{"id":"D","status":"authorized"},"license":null,"subject":"ps_abc"}"""),
        )
        assertEquals(
            TokenAnswer.Token(
                "pkeyt_x", "profile email", "ps_abc", 1,
                JsonObject(mapOf("id" to JsonPrimitive("D"), "status" to JsonPrimitive("authorized"))), null,
            ),
            answer,
        )
    }

    @Test
    fun chooseIsDecidedByStatusAloneEvenBesideOtherMembers() {
        val answer = IdentityRedirect.parseTokenAnswer(
            200,
            json("""{"status":"choose","grant":"$grant","expiresIn":300,"choices":{"state":"choose"},"access_token":"pkeyt_ignored"}"""),
        )
        assertEquals(TokenAnswer.Choose(grant, 300.0, JsonObject(mapOf("state" to JsonPrimitive("choose")))), answer)
    }

    @Test
    fun a200ThatLacksWhatTheCallNeedsIsMalformed() {
        val bodies = listOf(
            "a bad grant" to """{"status":"choose","grant":"sg_short","expiresIn":1,"choices":{}}""",
            "no access_token" to """{"scope":"x","subject":"s","device":{"id":"D"},"license":null}""",
            "no subject" to """{"access_token":"t","scope":"x","device":{"id":"D"},"license":null}""",
            "no license member" to """{"access_token":"t","scope":"x","subject":"s","device":{"id":"D"}}""",
            "not an object" to "\"x\"",
        )
        for ((name, body) in bodies) assertEquals(name, TokenAnswer.Malformed, IdentityRedirect.parseTokenAnswer(200, json(body)))
    }

    @Test
    fun refusals() {
        val vectors = listOf(
            Triple(400, """{"error":"invalid_grant"}""", TokenAnswer.Refused("invalid_grant", 400, null)),
            Triple(401, """{"error":"invalid_client"}""", TokenAnswer.Refused("invalid_client", 401, null)),
            Triple(429, """{"error":"rate_limited","retryAfter":2.2}""", TokenAnswer.Refused("rate_limited", 429, 3)),
            Triple(500, "\"oops\"", TokenAnswer.Refused("server_error", 500, null)),
            Triple(502, """{"error":""}""", TokenAnswer.Refused("server_error", 502, null)),
        )
        for ((status, body, expected) in vectors) assertEquals("$status $body", expected, IdentityRedirect.parseTokenAnswer(status, json(body)))
        assertEquals(TokenAnswer.Refused("server_error", 500, null), IdentityRedirect.parseTokenAnswer(500, JsonNull))
    }
}
