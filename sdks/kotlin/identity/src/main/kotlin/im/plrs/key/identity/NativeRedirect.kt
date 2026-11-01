// The native redirect helpers (WIRE-CONTRACT-V5 §12.12; I-15b.5): everything the SDK does around a
// pushed authorization request, with no I/O of its own. A port of client-core's `redirect.ts` (and of
// Python's `native_redirect.py` and Swift's `NativeRedirect`); its vectors are the redirect-native-*
// recordings and `NativeRedirectTest`.
//
//   1. `NativeRedirect.chooseClass`      loopback, then scheme, then claimed HTTPS, else the fallback.
//   2. `NativeRedirect.redirectUri`      the redirect URI of a class; `classify` reads one.
//   3. `NativeRedirect.pushRequest`      the form body of `POST /<p>/identity/request`, PKCE and state.
//   4. `NativeRedirect.parsePushedAnswer` the `201` answer, or the flat refusal.
//   5. `NativeRedirect.authorizeUrlFor`  the authorize URL (`client_id` + `request_uri` only).
//   6. `NativeRedirect.parseCallback`    the redirect back: iss, state, code (and `request=` on loopback);
//                                        any other parameter is refused.
//   7. `NativeRedirect.tokenRequest`     the token request, with the `X-PKey-Device` header.
//
// Safety rules the session layer relies on: S256 only; the verifier, the code and the token are never put
// in a URL or a log by this module; a pending request is used for ONE callback check and one token
// request, then dropped.

package im.plrs.key.identity

import im.plrs.key.core.ManageLink
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonElement
import java.security.MessageDigest

/** The class of a native redirect URI (§12.12). */
public enum class NativeRedirectClass(public val wire: String) {
    Loopback("loopback"),
    Scheme("scheme"),
    Claimed("claimed"),
}

/** `identity.nativeRedirect` of the discovery document (§12.6): the classes the product accepts through the pushed `request`. `schemes` and `claimedHttps` hold full registered redirect URIs. */
public data class NativeRedirectDiscovery(
    val loopback: Boolean,
    val schemes: List<String> = emptyList(),
    val claimedHttps: List<String> = emptyList(),
) {
    internal companion object {
        fun parse(value: JsonElement?): NativeRedirectDiscovery? {
            val o = value.objectValue ?: return null
            fun strings(name: String): List<String> = o[name].arrayValue?.mapNotNull { it.stringValue } ?: emptyList()
            return NativeRedirectDiscovery(o["loopback"].boolValue == true, strings("schemes"), strings("claimedHttps"))
        }
    }
}

/** What the host gives a native redirect sign-in (`SignInOptions.native`). */
public data class NativeRedirectOptions @JvmOverloads constructor(
    /** Listen on a loopback port. Null: yes, unless the host is headless (SIGN-IN D-68) or cannot open a browser. */
    val loopback: Boolean? = null,
    /** The full redirect URIs (`<scheme>:/pkey/callback`) this build has registered with the OS. */
    val registeredSchemes: List<String> = emptyList(),
    /** The claimed HTTPS redirect URIs (full) this build has associated with the OS. */
    val registeredClaimed: List<String> = emptyList(),
    /** A registered scheme's redirect URI for "Return to <App>". Never carries a code. */
    val returnUri: String? = null,
    /** False: do not open the browser; the host opens `session.authorizeUrl` itself. */
    val openBrowser: Boolean = true,
)

/** The class [NativeRedirect.chooseClass] picked, or why none applies. */
public sealed interface RedirectChoice {
    public data object Loopback : RedirectChoice

    public data class Scheme(val redirectUri: String) : RedirectChoice

    public data class Claimed(val redirectUri: String) : RedirectChoice

    /** No native class applies: report `redirect-unavailable` and offer a code. [reason] is `request-not-served` or `no-class`. */
    public data class Unavailable(val reason: String) : RedirectChoice
}

/** One pending native sign-in. A secret holder: [codeVerifier] is never logged or put in a URL. */
public class NativePending internal constructor(
    public val redirectClass: NativeRedirectClass,
    public val redirectUri: String,
    public val state: String,
    internal val codeVerifier: String,
    public val clientId: String,
    public val issuer: String,
    public val authorizeEndpoint: String,
    public val tokenEndpoint: String,
    /** The push carried `license_choice=app`: the token endpoint may answer `choose`. */
    internal val licenseChoice: Boolean = false,
) {
    override fun toString(): String = "NativePending(redirectClass=${redirectClass.wire}, redirectUri=$redirectUri, codeVerifier=[redacted])"
}

/** The form of `POST /<p>/identity/request`; the caller adds the SDK headers. */
public class PushedRequest internal constructor(
    public val url: String,
    public val contentType: String,
    public val body: String,
    public val pending: NativePending,
) {
    override fun toString(): String = "PushedRequest(url=$url, body=[redacted])"
}

public sealed interface PushedAnswer {
    public data class Pushed(val requestUri: String, val expiresIn: Long) : PushedAnswer

    /** The Worker refused (a 5xx or a body with no `error` is `server_error`). */
    public data class Refused(val error: String, val status: Int, val retryAfterSeconds: Int? = null) : PushedAnswer

    public data object Malformed : PushedAnswer
}

public sealed interface NativeCallback {
    /** [request] is the `rq_` handle, present on a loopback delivery. */
    public data class Code(val code: String, val request: String?) : NativeCallback {
        override fun toString(): String = "Code(code=[redacted], request=$request)"
    }

    public data class Cancelled(val request: String?) : NativeCallback

    public data class Failed(val reason: CallbackFailure, val error: String? = null) : NativeCallback
}

/** `POST /<p>/identity/token` for a code from a pushed request: the pusher's device header and the form. */
public class NativeTokenRequest internal constructor(
    public val url: String,
    public val deviceId: String,
    public val contentType: String,
    public val body: String,
) {
    override fun toString(): String = "NativeTokenRequest(url=$url, body=[redacted])"
}

public object NativeRedirect {
    /** §12.12: the one path of the loopback and scheme redirect URIs (RFC 8252 §7). */
    public const val PATH: String = "/pkey/callback"

    /** §12.12: how long a pushed request lives. */
    public const val PUSHED_REQUEST_TTL_SECONDS: Long = 600

    private val RESERVED_SCHEMES = setOf("http", "https", "javascript", "data", "file")
    private val SCHEME_PATTERN = Regex("[a-z][a-z0-9+.-]*")
    private val LOOPBACK = Regex("http://(127\\.0\\.0\\.1|\\[::1]):([0-9]{1,5})(/.*)")
    private val CLAIMED = Regex("https://([^/?#@]+)(/[^?#]*)")
    private val SCHEME_URI = Regex("([a-z][a-z0-9+.-]*):(/[^?#]*)")
    private val REQUEST_URI = Regex("urn:ietf:params:oauth:request_uri:[A-Za-z0-9_-]{22}")
    private val REQUEST_HANDLE = Regex("rq_[A-Za-z0-9_-]{22}")
    private val BASE_OF = Regex("([A-Za-z][A-Za-z0-9+.-]*):(//[^/?#]*)?([^?#]*).*", RegexOption.DOT_MATCHES_ALL)

    // ── 1. the class ─────────────────────────────────────────────────────────────────────

    /**
     * The order is fixed: loopback (desktop), the registered scheme, claimed HTTPS, else the fallback. A class is
     * used only when discovery lists it AND the host has it; discovery with no `request` or no `nativeRedirect`
     * is `request-not-served` (device code).
     */
    public fun chooseClass(
        requestEndpoint: String?,
        discovery: NativeRedirectDiscovery?,
        canListen: Boolean,
        registeredSchemes: List<String> = emptyList(),
        registeredClaimed: List<String> = emptyList(),
    ): RedirectChoice {
        if (requestEndpoint.isNullOrEmpty() || discovery == null) return RedirectChoice.Unavailable("request-not-served")
        if (canListen && discovery.loopback) return RedirectChoice.Loopback
        registeredSchemes.firstOrNull { it in discovery.schemes }?.let { return RedirectChoice.Scheme(it) }
        registeredClaimed.firstOrNull { it in discovery.claimedHttps }?.let { return RedirectChoice.Claimed(it) }
        return RedirectChoice.Unavailable("no-class")
    }

    // ── 2. the redirect URI ──────────────────────────────────────────────────────────────

    /**
     * The class of a native redirect URI, or null when it is none (§12.12: `localhost`, another path, a query, a
     * fragment, userinfo, port 80 or no port are all refused).
     */
    public fun classify(uri: String?): NativeRedirectClass? {
        if (uri.isNullOrEmpty() || uri.length > 2048) return null
        if (uri.any { it.isWhitespace() || Character.isSpaceChar(it) || it == '﻿' || it.code < 0x20 || it.code == 0x7F || it == '\\' }) return null
        LOOPBACK.matchEntire(uri)?.let { m ->
            val digits = m.groupValues[2]
            val port = digits.toInt()
            return if (port in 1..65535 && port != 80 && m.groupValues[3] == PATH && !(digits.length > 1 && digits.startsWith("0"))) {
                NativeRedirectClass.Loopback
            } else {
                null
            }
        }
        CLAIMED.matchEntire(uri)?.let { m -> if (m.groupValues[2] != "/") return NativeRedirectClass.Claimed }
        SCHEME_URI.matchEntire(uri)?.let { m ->
            return if (m.groupValues[1] !in RESERVED_SCHEMES && m.groupValues[2] == PATH) NativeRedirectClass.Scheme else null
        }
        return null
    }

    /** The loopback redirect URI for a listener's OS-assigned port (IPv4). */
    public fun loopbackUri(port: Int): String {
        if (port < 1 || port > 65535 || port == 80) throw IdentityRedirect.invalid("the loopback port must be an explicit port other than 80.")
        return "http://127.0.0.1:$port$PATH".also {
            if (classify(it) != NativeRedirectClass.Loopback) throw IdentityRedirect.invalid("not a native redirect URI.")
        }
    }

    /** The redirect URI of a registered scheme: `<scheme>:/pkey/callback`. */
    public fun schemeUri(scheme: String): String {
        if (!SCHEME_PATTERN.matches(scheme) || scheme in RESERVED_SCHEMES) throw IdentityRedirect.invalid("the scheme is not a registrable URL scheme.")
        return "$scheme:$PATH".also {
            if (classify(it) != NativeRedirectClass.Scheme) throw IdentityRedirect.invalid("not a native redirect URI.")
        }
    }

    // ── 3. the pushed request ────────────────────────────────────────────────────────────

    /**
     * Build the pushed request (§12.12). Nothing here touches the network. Member order: `response_type client_id
     * redirect_uri state code_challenge code_challenge_method [scope] [login_hint] [name_hint] [purpose]
     * [license_choice] [device_name] [return_uri]`. [scope] is left out when null (the Worker defaults it);
     * `license_choice=app` is sent only when [choiceAvailable]. [state] and [codeVerifier] are test hooks.
     */
    @JvmOverloads
    public fun pushRequest(
        requestEndpoint: String,
        authorizeEndpoint: String,
        tokenEndpoint: String,
        issuer: String,
        clientId: String,
        redirectUri: String,
        deviceName: String? = null,
        returnUri: String? = null,
        scope: List<String>? = null,
        loginHint: String? = null,
        nameHint: String? = null,
        purpose: String? = null,
        licenseChoice: String? = null,
        choiceAvailable: Boolean = false,
        random: RandomBytes? = null,
        state: String? = null,
        codeVerifier: String? = null,
    ): PushedRequest {
        val redirectClass = classify(redirectUri) ?: throw IdentityRedirect.invalid("redirectUri is not a native redirect URI.")
        if (returnUri != null && classify(returnUri) != NativeRedirectClass.Scheme) {
            throw IdentityRedirect.invalid("returnUri must be a registered scheme's redirect URI.")
        }
        for ((name, value) in listOf("request" to requestEndpoint, "authorize" to authorizeEndpoint, "token" to tokenEndpoint)) {
            if (!Regex("https?://\\S+").matches(value)) throw IdentityRedirect.invalid("the $name endpoint is not an absolute URL.")
        }
        if (issuer.isEmpty()) throw IdentityRedirect.invalid("discovery names no issuer.")
        if (clientId.isEmpty()) throw IdentityRedirect.invalid("clientId is empty.")
        val theState = state ?: IdentityRedirect.generateState(random)
        if (theState.length !in IdentityRedirect.STATE_MIN..IdentityRedirect.STATE_MAX || !IdentityRedirect.isPrintable(theState)) {
            throw IdentityRedirect.invalid("state must be 16 to 512 printable characters.")
        }
        val verifier = codeVerifier ?: IdentityRedirect.generateCodeVerifier(random)
        if (verifier.length !in IdentityRedirect.VERIFIER_MIN..IdentityRedirect.VERIFIER_MAX ||
            !verifier.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '-' || it == '.' || it == '_' || it == '~' }
        ) {
            throw IdentityRedirect.invalid("the PKCE verifier must be 43 to 128 unreserved characters.")
        }
        val pairs = arrayListOf(
            "response_type" to "code", "client_id" to clientId, "redirect_uri" to redirectUri, "state" to theState,
            "code_challenge" to IdentityRedirect.pkceChallenge(verifier), "code_challenge_method" to "S256",
        )
        if (scope != null) {
            val parts = scope.joinToString(" ").split(' ').filter { it.isNotEmpty() }
            if (parts.isEmpty() || !parts.all(IdentityRedirect::isPrintable)) throw IdentityRedirect.invalid("scope must be a space-delimited list of printable scopes.")
            pairs += "scope" to parts.joinToString(" ")
        }
        if (!loginHint.isNullOrEmpty()) pairs += "login_hint" to loginHint
        if (!nameHint.isNullOrEmpty()) pairs += "name_hint" to nameHint
        if (!purpose.isNullOrEmpty()) pairs += "purpose" to purpose
        val choiceApp = licenseChoice == "app" && choiceAvailable
        if (choiceApp) pairs += "license_choice" to "app"
        if (!deviceName.isNullOrEmpty()) pairs += "device_name" to deviceName
        if (!returnUri.isNullOrEmpty()) pairs += "return_uri" to returnUri
        return PushedRequest(
            requestEndpoint, IdentityRedirect.TOKEN_CONTENT_TYPE, IdentityRedirect.formBody(pairs),
            NativePending(redirectClass, redirectUri, theState, verifier, clientId, issuer, authorizeEndpoint, tokenEndpoint, choiceApp),
        )
    }

    /** Read the answer of `POST /<p>/identity/request`: `201 {request_uri, expires_in}`. */
    public fun parsePushedAnswer(status: Int, body: JsonElement?): PushedAnswer {
        val o = body.objectValue
        if (status != 201) {
            val error = o?.get("error").stringValue?.takeIf { it.isNotEmpty() } ?: "server_error"
            return PushedAnswer.Refused(error, status, wholeSeconds(o?.get("retryAfter"))?.coerceAtMost(3600)?.toInt())
        }
        if (o == null) return PushedAnswer.Malformed
        val uri = o["request_uri"].stringValue
        val expires = o["expires_in"].longValue
        if (uri == null || !REQUEST_URI.matches(uri) || expires == null || expires < 1 || expires > PUSHED_REQUEST_TTL_SECONDS) {
            return PushedAnswer.Malformed
        }
        return PushedAnswer.Pushed(uri, expires)
    }

    // ── 5. the authorize URL ─────────────────────────────────────────────────────────────

    /** `authorize?client_id=<id>&request_uri=<uri>`: the only parameters a pushed request takes. */
    public fun authorizeUrlFor(authorizeEndpoint: String, clientId: String, requestUri: String): String {
        if (!REQUEST_URI.matches(requestUri)) throw IdentityRedirect.invalid("not a pushed request URI.")
        val joiner = if (authorizeEndpoint.contains('?')) "&" else "?"
        return "$authorizeEndpoint${joiner}client_id=${ManageLink.formEncode(clientId)}&request_uri=${ManageLink.formEncode(requestUri)}"
    }

    // ── 6. the redirect back ─────────────────────────────────────────────────────────────

    /** Constant-time string equality (no early exit on the first differing character). */
    public fun constantTimeEqual(a: String, b: String): Boolean =
        MessageDigest.isEqual(a.toByteArray(Charsets.UTF_8), b.toByteArray(Charsets.UTF_8))

    /** `scheme:` + authority lower-cased, path as given; null for anything not an absolute URL. */
    private fun baseOf(url: String): String? {
        val m = BASE_OF.matchEntire(url) ?: return null
        return "${m.groupValues[1].lowercase()}:${m.groupValues[2].lowercase()}${m.groupValues[3]}"
    }

    private val SUCCESS_PARAMS = setOf("code", "state", "iss", "request")
    private val ERROR_PARAMS = setOf("error", "error_description", "state", "iss", "request")

    /**
     * Check the redirect back to the app. The first failure wins, in this order: absolute URL with no fragment; at
     * the redirect URI the request named; no repeated parameter; `state` (constant time); `iss` (RFC 9207: a
     * callback with no `iss` is refused); `error` (`access_denied` is cancelled); `code`; no parameter beyond
     * `code state iss request` (or `error error_description state iss request`); on loopback, `request=` an `rq_`
     * handle. A delivery that carries `request` must hold a valid handle on any class.
     */
    public fun parseCallback(pending: NativePending, callbackUrl: String?): NativeCallback =
        parseCallback(pending.state, pending.issuer, pending.redirectUri, pending.redirectClass, callbackUrl)

    public fun parseCallback(
        state: String,
        issuer: String,
        redirectUri: String,
        redirectClass: NativeRedirectClass?,
        callbackUrl: String?,
    ): NativeCallback {
        fun fail(reason: CallbackFailure, error: String? = null) = NativeCallback.Failed(reason, error)
        if (callbackUrl == null || callbackUrl.contains('#')) return fail(CallbackFailure.Malformed)
        val got = baseOf(callbackUrl)
        val want = baseOf(redirectUri)
        if (got == null || want == null) return fail(CallbackFailure.Malformed)
        if (got != want) return fail(CallbackFailure.RedirectMismatch)
        val q = IdentityRedirect.query(callbackUrl) ?: return fail(CallbackFailure.Malformed)
        val theirState = q["state"]
        if (theirState == null || !constantTimeEqual(theirState, state)) return fail(CallbackFailure.StateMismatch)
        val iss = q["iss"]
        if (iss == null || !constantTimeEqual(iss, issuer)) return fail(CallbackFailure.IssuerMismatch)
        val error = q["error"]
        val code = q["code"]
        if (error == null && code.isNullOrEmpty()) return fail(CallbackFailure.MissingCode)
        val allowed = if (error != null) ERROR_PARAMS else SUCCESS_PARAMS
        if (q.keys.any { it !in allowed }) return fail(CallbackFailure.UnexpectedParameter)
        val request = q["request"]
        val loopback = (redirectClass ?: classify(redirectUri)) == NativeRedirectClass.Loopback
        if (if (request != null) !REQUEST_HANDLE.matches(request) else loopback && error == null) return fail(CallbackFailure.RequestInvalid)
        if (error != null) return if (error == "access_denied") NativeCallback.Cancelled(request) else fail(CallbackFailure.AuthorizationError, error)
        return NativeCallback.Code(code!!, request)
    }

    // ── 7. the token request ─────────────────────────────────────────────────────────────

    /**
     * `POST /<p>/identity/token` for a code from a pushed request (§12.5): the form of
     * [IdentityRedirect.tokenForm] and the pusher's `X-PKey-Device` (a different device is `invalid_grant`).
     */
    @JvmOverloads
    public fun tokenRequest(pending: NativePending, code: String, deviceId: String, deviceName: String? = null): NativeTokenRequest {
        if (!IdentityRedirect.isPrintable(deviceId)) throw IdentityRedirect.invalid("deviceId is empty or not printable.")
        return NativeTokenRequest(
            pending.tokenEndpoint, deviceId, IdentityRedirect.TOKEN_CONTENT_TYPE,
            IdentityRedirect.tokenForm(pending.clientId, pending.codeVerifier, pending.redirectUri, code, deviceName),
        )
    }
}
