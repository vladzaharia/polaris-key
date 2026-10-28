// The authorization-code redirect core (WIRE-CONTRACT-V4 §12.4, §12.5; I-10b.18): everything the SDK
// does around the browser hop, with no I/O of its own. A port of client-core's `identityRedirect.ts`
// (and of Swift's `IdentityRedirect`); the vectors in `IdentityRedirectTest` are that file's.
//
//   1. `IdentityRedirect.start`            S256 PKCE, the `state`, and the authorize URL the host opens.
//   2. `IdentityRedirect.checkCallback`    the redirect back to the app: the redirect URI, then no
//                                          repeats, `state`, `iss` (RFC 9207), `error`, `code`. A
//                                          refusal here never reaches the token endpoint.
//   3. `IdentityRedirect.tokenForm`        the form body of `POST /<p>/identity/token`.
//   4. `IdentityRedirect.parseTokenAnswer` the answer: a token response, `choose` (by its `status`
//                                          member alone), or a refusal carrying the Worker's OAuth `error`.
//
// Safety rules the session layer relies on:
//   - S256 only. There is no `plain` path and no option to send one.
//   - `state` and the verifier are 32 random bytes each unless a test injects them. The session keeps
//     the pending request for ONE `checkCallback` and token request, then drops it.
//   - The verifier, the code and the token are never put in a URL or a log here; the authorize URL
//     carries only the challenge.

package im.plrs.key.identity

import im.plrs.key.core.Base64Url
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Feature
import im.plrs.key.core.ManageLink
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.TokenSource
import im.plrs.key.core.decimalValue
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.security.SecureRandom
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

/** Random bytes. Default `SecureRandom`; a test injects a fixed source. */
public typealias RandomBytes = (Int) -> ByteArray

/**
 * Why a callback was refused before any token request. The wire words are the shared vector
 * vocabulary; every SDK reports the same one for the same URL.
 */
public enum class CallbackFailure(public val wire: String) {
    /** Not an absolute URL, or a repeated parameter. */
    Malformed("malformed"),

    /** The callback is not at the redirect URI the request named. */
    RedirectMismatch("redirect-mismatch"),

    /** `state` absent or not this request's. */
    StateMismatch("state-mismatch"),

    /** `iss` absent or not the discovery issuer (RFC 9207). */
    IssuerMismatch("issuer-mismatch"),

    /** An `error` other than `access_denied`. */
    AuthorizationError("authorization-error"),
    MissingCode("missing-code"),
}

public sealed interface CallbackResult {
    /** The code to redeem. */
    public data class Code(val code: String) : CallbackResult

    /** The person pressed Cancel on the card (`error=access_denied`). */
    public data object Cancelled : CallbackResult

    /** Anything else (`sign-in-failed`); [error] is the callback's own `error` value when it carried one. */
    public data class Failed(val reason: CallbackFailure, val error: String? = null) : CallbackResult
}

public sealed interface TokenAnswer {
    /** `200` with an `access_token`: the activation response under its OAuth names. */
    public data class Token(
        val accessToken: String,
        val scope: String,
        val subject: String,
        val schemaVersion: Long,
        val device: JsonObject,
        val license: JsonObject?,
    ) : TokenAnswer {
        override fun toString(): String = "Token(accessToken=[redacted], scope=$scope, subject=$subject)"
    }

    /** `200` with `status: "choose"` (I-08b): the app shows the licence choice, then calls `choice/complete` with [grant]. */
    public data class Choose(val grant: String, val expiresIn: Double, val choices: JsonObject) : TokenAnswer {
        override fun toString(): String = "Choose(grant=[redacted], expiresIn=$expiresIn)"
    }

    /**
     * The Worker refused: [error] is its flat OAuth / Polaris code (`invalid_grant`, `rate_limited`, ...),
     * [retryAfterSeconds] when it named one. A 5xx or a body with no `error` is `server_error`.
     */
    public data class Refused(val error: String, val status: Int, val retryAfterSeconds: Int? = null) : TokenAnswer

    /** A `200` that is neither of the above, or lacks a member the call needs. */
    public data object Malformed : TokenAnswer
}

/**
 * One pending redirect sign-in. The session holds it between the navigation and the callback, uses it for
 * ONE `checkCallback` (and one token request), then drops it. [codeVerifier] is a secret: never log it,
 * never put it in a URL.
 */
public class RedirectPending internal constructor(
    /** The URL to open in the browser. Carries the challenge, never the verifier. */
    public val authorizeUrl: String,
    public val state: String,
    internal val codeVerifier: String,
    public val redirectUri: String,
    public val clientId: String,
    public val issuer: String,
    public val tokenEndpoint: String,
    /** The authorize request carried `license_choice=app`: the token endpoint may answer `choose`. */
    internal val licenseChoice: Boolean = false,
) {
    override fun toString(): String = "RedirectPending(authorizeUrl=$authorizeUrl, codeVerifier=[redacted])"
}

public object IdentityRedirect {
    /** RFC 7636 §4.1: the verifier is 43 to 128 characters of `A-Z a-z 0-9 - . _ ~`. */
    public const val VERIFIER_MIN: Int = 43
    public const val VERIFIER_MAX: Int = 128

    /** WIRE-CONTRACT-V4 §12.4: `state` is 16 to 512 printable ASCII characters. */
    public const val STATE_MIN: Int = 16
    public const val STATE_MAX: Int = 512

    /** The scope a sign-in asks for when the host names none (a subset of `profile email cloudSync`; `openid` is `invalid_scope` until I-21). */
    public const val DEFAULT_SCOPE: String = "profile email"

    /** The `Content-Type` of the token request. */
    public const val TOKEN_CONTENT_TYPE: String = "application/x-www-form-urlencoded"

    private val GRANT = Regex("sg_[A-Za-z0-9_-]{43}")
    private val secureRandom = SecureRandom()

    private fun systemRandom(length: Int): ByteArray = ByteArray(length).also { secureRandom.nextBytes(it) }

    // ── PKCE ─────────────────────────────────────────────────────────────────────────────

    /** A fresh PKCE verifier: 32 random bytes, 43 base64url characters. */
    @JvmOverloads
    public fun generateCodeVerifier(random: RandomBytes? = null): String = Base64Url.encode((random ?: ::systemRandom)(32))

    /** A fresh `state`: 32 random bytes, 43 base64url characters. */
    @JvmOverloads
    public fun generateState(random: RandomBytes? = null): String = Base64Url.encode((random ?: ::systemRandom)(32))

    /** The S256 challenge: `base64url(SHA-256(ASCII(verifier)))`, unpadded (RFC 7636 §4.2). */
    public fun pkceChallenge(verifier: String): String =
        Base64Url.encode(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.UTF_8)))

    // ── The authorize request ────────────────────────────────────────────────────────────

    /**
     * The shared rule for a host-supplied redirect URI: absolute `https:`, no userinfo, no fragment, no
     * whitespace or control characters. (Loopback, scheme and claimed-HTTPS URIs are I-15's.)
     */
    public fun isRedirectUri(raw: String?): Boolean {
        if (raw.isNullOrEmpty() || raw.length > 2048) return false
        if (raw.any { it.isWhitespace() || Character.isSpaceChar(it) || it == '﻿' || it.code < 0x20 || it.code == 0x7F || it == '\\' }) return false
        if (!raw.startsWith("https://") || raw.contains('#')) return false
        val rest = raw.substring("https://".length)
        val authority = rest.takeWhile { it != '/' && it != '?' }
        return authority.isNotEmpty() && !authority.contains('@')
    }

    private fun isAbsoluteHttp(s: String): Boolean {
        val rest = when {
            s.startsWith("https://") -> s.substring(8)
            s.startsWith("http://") -> s.substring(7)
            else -> return false
        }
        return rest.isNotEmpty() && rest.none { it.isWhitespace() || Character.isSpaceChar(it) || it == '﻿' }
    }

    private fun isPrintable(s: String): Boolean = s.isNotEmpty() && s.all { it.code in 0x21..0x7E }

    private fun invalid(message: String) = PolarisException(ErrorCode.invalidArgument, message)

    private fun scopeString(scope: List<String>?): String {
        if (scope == null) return DEFAULT_SCOPE
        val parts = scope.joinToString(" ").split(' ').filter { it.isNotEmpty() }
        if (parts.isEmpty() || !parts.all(::isPrintable)) throw invalid("scope must be a space-delimited list of printable scopes.")
        return parts.joinToString(" ")
    }

    private fun formBody(pairs: List<Pair<String, String>>): String =
        pairs.joinToString("&") { "${ManageLink.formEncode(it.first)}=${ManageLink.formEncode(it.second)}" }

    /**
     * Build the authorize request. Query order is fixed so every SDK emits the same bytes:
     * `response_type client_id redirect_uri state code_challenge code_challenge_method scope [login_hint]
     * [name_hint] [purpose] [license_choice]`, each value form-encoded (space as `+`). A hint that is empty
     * is not sent; a hint is sent verbatim (the Worker normalises, and drops a login hint that is not an
     * email). [licenseChoice] `"app"` is sent only when [choiceAvailable] (discovery has the `choice*`
     * endpoints). [state] and [codeVerifier] are test hooks. Throws `invalid-argument`.
     */
    @JvmOverloads
    public fun start(
        authorizeEndpoint: String,
        tokenEndpoint: String,
        issuer: String,
        clientId: String,
        redirectUri: String,
        scope: List<String>? = null,
        loginHint: String? = null,
        nameHint: String? = null,
        purpose: String? = null,
        licenseChoice: String? = null,
        choiceAvailable: Boolean = false,
        random: RandomBytes? = null,
        state: String? = null,
        codeVerifier: String? = null,
    ): RedirectPending {
        if (!isRedirectUri(redirectUri)) throw invalid("redirectUri must be an absolute https URL with no fragment.")
        for ((name, value) in listOf("authorize" to authorizeEndpoint, "token" to tokenEndpoint)) {
            if (!isAbsoluteHttp(value)) throw invalid("the $name endpoint is not an absolute URL.")
        }
        if (issuer.isEmpty()) throw invalid("discovery names no issuer.")
        if (clientId.isEmpty()) throw invalid("clientId is empty.")
        val theState = state ?: generateState(random)
        if (theState.length !in STATE_MIN..STATE_MAX || !isPrintable(theState)) throw invalid("state must be 16 to 512 printable characters.")
        val verifier = codeVerifier ?: generateCodeVerifier(random)
        if (verifier.length !in VERIFIER_MIN..VERIFIER_MAX ||
            !verifier.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '-' || it == '.' || it == '_' || it == '~' }
        ) {
            throw invalid("the PKCE verifier must be 43 to 128 unreserved characters.")
        }
        val pairs = arrayListOf(
            "response_type" to "code", "client_id" to clientId, "redirect_uri" to redirectUri,
            "state" to theState, "code_challenge" to pkceChallenge(verifier),
            "code_challenge_method" to "S256", "scope" to scopeString(scope),
        )
        if (!loginHint.isNullOrEmpty()) pairs += "login_hint" to loginHint
        if (!nameHint.isNullOrEmpty()) pairs += "name_hint" to nameHint
        if (!purpose.isNullOrEmpty()) pairs += "purpose" to purpose
        if (licenseChoice == "app" && choiceAvailable) pairs += "license_choice" to "app"
        val joiner = if (authorizeEndpoint.contains('?')) "&" else "?"
        return RedirectPending(
            "$authorizeEndpoint$joiner${formBody(pairs)}", theState, verifier, redirectUri, clientId, issuer, tokenEndpoint,
            licenseChoice == "app" && choiceAvailable,
        )
    }

    // ── The callback ─────────────────────────────────────────────────────────────────────

    /** `%XX` and `+` decoding; null on a bad escape or bytes that are not UTF-8. */
    private fun decode(s: String): String? {
        val bytes = java.io.ByteArrayOutputStream()
        var i = 0
        while (i < s.length) {
            val c = s[i]
            when {
                c == '+' -> {
                    bytes.write(' '.code)
                    i++
                }
                c == '%' -> {
                    if (i + 2 >= s.length) return null
                    val hi = Character.digit(s[i + 1], 16)
                    val lo = Character.digit(s[i + 2], 16)
                    if (hi < 0 || lo < 0) return null
                    bytes.write(hi * 16 + lo)
                    i += 3
                }
                else -> {
                    val cp = s.codePointAt(i)
                    bytes.write(String(Character.toChars(cp)).toByteArray(Charsets.UTF_8))
                    i += Character.charCount(cp)
                }
            }
        }
        return try {
            Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes.toByteArray())).toString()
        } catch (e: java.nio.charset.CharacterCodingException) {
            null
        }
    }

    /** The query pairs of [url] (before any `#`); null when a name repeats or an escape is bad. */
    private fun query(url: String): Map<String, String>? {
        val q = url.indexOf('?')
        if (q == -1) return emptyMap()
        val hash = url.indexOf('#')
        val end = if (hash == -1) url.length else hash
        if (q + 1 > end) return emptyMap()
        val out = LinkedHashMap<String, String>()
        for (part in url.substring(q + 1, end).split('&')) {
            if (part.isEmpty()) continue
            val eq = part.indexOf('=')
            val name = decode(if (eq == -1) part else part.substring(0, eq)) ?: return null
            val value = decode(if (eq == -1) "" else part.substring(eq + 1)) ?: return null
            if (out.containsKey(name)) return null
            out[name] = value
        }
        return out
    }

    private val ORIGIN_PATH = Regex("^([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*)([^?#]*)")

    /** `scheme://authority/path`, lower-cased scheme and host, no query or fragment. */
    private fun originPath(url: String): String? {
        val m = ORIGIN_PATH.find(url) ?: return null
        return "${m.groupValues[1].lowercase()}://${m.groupValues[2].lowercase()}${m.groupValues[3]}"
    }

    /**
     * Check the redirect back to the app. The order is fixed and the first failure wins: the callback is at
     * the redirect URI; no parameter repeats; `state` is this request's; `iss` is the discovery issuer (a
     * callback with no `iss` is refused: the Worker always sends it); then `error` (`access_denied` is
     * cancelled, any other is a failure); then `code`. Pure: the caller drops the pending request after the
     * first call, whatever the result.
     */
    public fun checkCallback(state: String, redirectUri: String, issuer: String, callbackUrl: String): CallbackResult {
        val got = originPath(callbackUrl)
        val want = originPath(redirectUri)
        if (got == null || want == null) return CallbackResult.Failed(CallbackFailure.Malformed)
        if (got != want) return CallbackResult.Failed(CallbackFailure.RedirectMismatch)
        val q = query(callbackUrl) ?: return CallbackResult.Failed(CallbackFailure.Malformed)
        if (q["state"] != state) return CallbackResult.Failed(CallbackFailure.StateMismatch)
        if (q["iss"] != issuer) return CallbackResult.Failed(CallbackFailure.IssuerMismatch)
        q["error"]?.let { error ->
            return if (error == "access_denied") CallbackResult.Cancelled else CallbackResult.Failed(CallbackFailure.AuthorizationError, error)
        }
        val code = q["code"]
        if (code.isNullOrEmpty()) return CallbackResult.Failed(CallbackFailure.MissingCode)
        return CallbackResult.Code(code)
    }

    internal fun checkCallback(pending: RedirectPending, callbackUrl: String): CallbackResult =
        checkCallback(pending.state, pending.redirectUri, pending.issuer, callbackUrl)

    // ── The token request ────────────────────────────────────────────────────────────────

    /**
     * The form body of `POST /<p>/identity/token` (§12.5). Member order is fixed:
     * `grant_type client_id code code_verifier redirect_uri [device_name]`.
     */
    @JvmOverloads
    public fun tokenForm(clientId: String, codeVerifier: String, redirectUri: String, code: String, deviceName: String? = null): String {
        val pairs = arrayListOf(
            "grant_type" to "authorization_code", "client_id" to clientId, "code" to code,
            "code_verifier" to codeVerifier, "redirect_uri" to redirectUri,
        )
        if (!deviceName.isNullOrEmpty()) pairs += "device_name" to deviceName
        return formBody(pairs)
    }

    /** Read the token endpoint's answer. `choose` is decided by the `status` member alone, never by the absence of `access_token`. */
    public fun parseTokenAnswer(status: Int, body: JsonElement?): TokenAnswer {
        val o = body.objectValue
        if (status != 200) {
            val error = o?.get("error").stringValue?.takeIf { it.isNotEmpty() } ?: "server_error"
            return TokenAnswer.Refused(error, status, wholeSeconds(o?.get("retryAfter"))?.toInt())
        }
        if (o == null) return TokenAnswer.Malformed
        if (o["status"].stringValue == "choose") {
            val grant = o["grant"].stringValue
            val expiresIn = o["expiresIn"].decimalValue
            val choices = o["choices"].objectValue
            if (grant == null || !GRANT.matches(grant) || expiresIn == null || choices == null) return TokenAnswer.Malformed
            return TokenAnswer.Choose(grant, expiresIn.toDouble(), choices)
        }
        val token = o["access_token"].stringValue?.takeIf { it.isNotEmpty() }
        val scope = o["scope"].stringValue
        val subject = o["subject"].stringValue?.takeIf { it.isNotEmpty() }
        val device = o["device"].objectValue
        val licenseMember = o["license"]
        if (token == null || scope == null || subject == null || device == null || licenseMember == null) return TokenAnswer.Malformed
        val license: JsonObject? = when (licenseMember) {
            is JsonNull -> null
            is JsonObject -> licenseMember
            else -> return TokenAnswer.Malformed
        }
        return TokenAnswer.Token(token, scope, subject, o["schemaVersion"].longValue ?: 1L, device, license)
    }
}

/** Marks the hooks only the conformance replayer may use. */
@RequiresOptIn(message = "A conformance-replay hook; not for apps.")
@Retention(AnnotationRetention.BINARY)
public annotation class ConformanceReplayOnly

/** The entropy of a recorded redirect conversation (replay only). */
public class RedirectEntropy(public val state: String?, public val codeVerifier: String?)

/** Conformance replay only: the exact `state` and verifier of a recorded redirect conversation. */
@ConformanceReplayOnly
public var IdentityClient.redirectEntropy: RedirectEntropy?
    get() = redirectEntropyValue
    set(value) {
        redirectEntropyValue = value
    }

/** Conformance replay only: false skips the sync after a redirect token (the `redirect-web-*` recordings hold the token exchange, not the sync that follows it). */
@ConformanceReplayOnly
public var IdentityClient.redirectAcquisitionSync: Boolean
    get() = redirectAcquisitionSyncValue
    set(value) {
        redirectAcquisitionSyncValue = value
    }

// ── The redirect channel of `signIn.start` (WIRE-CONTRACT-V4 §12.4, §12.5) ───────────────────

/**
 * Begin a redirect sign-in. Refuses before any sign-in request when the product does not run Identity
 * (`service-unavailable`) or its discovery serves no `authorize`, `token` or `issuer` (`sign-in-unavailable`):
 * an endpoint is used only when discovery names it, never built. The token endpoint must be on this
 * product: the device's headers go nowhere else.
 */
internal suspend fun IdentityClient.startRedirect(options: SignInOptions): RedirectPending {
    if (core.discoveryDocument() == null) {
        try {
            core.discover()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // `requireService` below answers for a product whose discovery is unknown.
        }
    }
    core.requireService(ServiceSlug.identity, Feature.identityRedirectWeb)
    val redirectUri = options.redirectUri ?: throw PolarisException(
        ErrorCode.invalidArgument, "redirectUri must be an absolute https URL with no fragment.",
    )
    val fragment = core.discoveryDocument()?.identity
    val authorize = fragment?.authorize?.takeIf { it.isNotEmpty() }
    val token = fragment?.token?.takeIf { it.isNotEmpty() }
    val issuer = fragment?.issuer?.takeIf { it.isNotEmpty() }
    if (authorize == null || token == null || issuer == null) {
        throw PolarisException(ErrorCode.signInUnavailable, "this product's discovery serves no redirect sign-in.")
    }
    if (!token.startsWith(core.endpoints.url(""))) {
        throw PolarisException(ErrorCode.badResponse, "the token endpoint points outside this product.")
    }
    val entropy = redirectEntropyValue
    val choiceAvailable = listOf("choiceLicenses", "choiceDevices", "choiceComplete", "choiceCancel").all { !fragment.endpoints[it].isNullOrEmpty() }
    return IdentityRedirect.start(
        authorizeEndpoint = authorize, tokenEndpoint = token, issuer = issuer, clientId = core.product,
        redirectUri = redirectUri, scope = options.scope, loginHint = options.loginHint, nameHint = options.nameHint,
        purpose = options.purpose?.wire, licenseChoice = options.licenseChoice, choiceAvailable = choiceAvailable, state = entropy?.state, codeVerifier = entropy?.codeVerifier,
    )
}

/**
 * Redeem the code at the token endpoint and, on a token, store it and run the acquisition sync as after
 * a device-code `ready`. A refusal is a [SignInError] under the Worker's code.
 */
internal suspend fun IdentityClient.redeemRedirect(pending: RedirectPending, code: String, deviceName: String?): SignInOutcome {
    val label = core.deviceLabel(deviceName)
    val form = IdentityRedirect.tokenForm(pending.clientId, pending.codeVerifier, pending.redirectUri, code, label)
    val response: PolarisResponse = try {
        core.request(
            pending.tokenEndpoint, method = "POST", headers = mapOf("content-type" to IdentityRedirect.TOKEN_CONTENT_TYPE),
            body = form.toByteArray(Charsets.UTF_8),
        )
    } catch (e: CancellationException) {
        throw e
    } catch (e: PolarisException) {
        if (e.code == ErrorCode.localOnly) throw e
        throw PolarisException(ErrorCode.networkError, e.message ?: "network error", cause = e)
    } catch (e: Exception) {
        throw PolarisException(ErrorCode.networkError, e.message ?: "network error", cause = e)
    }
    val body = JsonText.parseOrNull(response.text)
    return when (val answer = IdentityRedirect.parseTokenAnswer(response.status, body)) {
        TokenAnswer.Malformed -> throw PolarisException(ErrorCode.badResponse, "the token endpoint answered without a complete sign-in.")
        is TokenAnswer.Refused -> {
            val retry = answer.retryAfterSeconds ?: response.header("retry-after")?.trim()?.toIntOrNull()
            throw SignInError(
                if (answer.status >= 500) ErrorCode.serverError else answer.error,
                "the token endpoint refused the sign-in (${answer.error}).", retry,
            )
        }
        // Only `license_choice=app` makes the Worker answer this; nothing is stored and `identity.choice.*` finishes it.
        is TokenAnswer.Choose ->
            if (pending.licenseChoice) {
                SignInOutcome.Choose(answer.grant, answer.expiresIn, answer.choices)
            } else {
                throw PolarisException(ErrorCode.badResponse, "the token endpoint asked for a licence choice this sign-in did not request.")
            }
        is TokenAnswer.Token -> {
            if (core.storeSignIn(answer.accessToken, answer.subject, TokenSource.signin, personInitiated = true)) onSubject(answer.subject)
            if (redirectAcquisitionSyncValue) onAcquired?.invoke()
            SignInOutcome.SignedIn(answer.subject, answer.scope, answer.license?.get("id").stringValue)
        }
    }
}
