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
import kotlinx.serialization.json.JsonObject
import java.security.MessageDigest

/** The class of a native redirect URI (§12.12). */
public enum class NativeRedirectClass(public val wire: String) {
    Loopback("loopback"),
    Scheme("scheme"),
    Claimed("claimed"),
}

/**
 * `identity.nativeRedirect` of the discovery document (§12.6): the classes the product accepts through the pushed
 * `request`. `schemes` and `claimedHttps` hold full registered redirect URIs.
 */
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

/** The endpoints and identity a pushed request names; all come from discovery (and the product slug), none are built. */
public class NativeEndpoints(
    public val requestEndpoint: String,
    public val authorizeEndpoint: String,
    public val tokenEndpoint: String,
    public val issuer: String,
    public val clientId: String,
)

/** What a native push asked for beyond a sign-in: `license_choice=app`, and `key_return=allow` ([SignInOptions.keyReturn]). */
internal class NativeOptIns(val licenseChoice: Boolean = false, val keyReturn: Boolean = false)

/** One pending native sign-in. A secret holder: [codeVerifier] is never logged or put in a URL. */
public class NativePending internal constructor(
    public val redirectClass: NativeRedirectClass,
    public val redirectUri: String,
    public val state: String,
    internal val codeVerifier: String,
    internal val endpoints: NativeEndpoints,
    private val optIns: NativeOptIns = NativeOptIns(),
) {
    /** The push carried `license_choice=app`: the token endpoint may answer `choose`. */
    internal val licenseChoice: Boolean get() = optIns.licenseChoice

    /** The push carried `key_return=allow`: the token endpoint may answer [TokenAnswer.Activated]. */
    internal val keyReturn: Boolean get() = optIns.keyReturn

    public val clientId: String get() = endpoints.clientId
    public val issuer: String get() = endpoints.issuer
    public val authorizeEndpoint: String get() = endpoints.authorizeEndpoint
    public val tokenEndpoint: String get() = endpoints.tokenEndpoint

    override fun toString(): String = "NativePending(redirectClass=${redirectClass.wire}, redirectUri=$redirectUri, codeVerifier=[redacted])"
}

/** Test hooks for the PKCE and `state` entropy of a push: the source, or the exact values of a recorded conversation. */
public class PushEntropy @JvmOverloads constructor(
    public val random: RandomBytes? = null,
    public val state: String? = null,
    public val codeVerifier: String? = null,
)

/**
 * What a push carries beyond its endpoints and redirect URI. [scope] is left out when null (the Worker defaults it);
 * [licenseChoiceApp] sends `license_choice=app` (the caller decides: asked for AND discovery lists the choice endpoints).
 */
public class PushOptions @JvmOverloads constructor(
    public val deviceName: String? = null,
    public val returnUri: String? = null,
    public val scope: List<String>? = null,
    public val hints: PushHints = PushHints(),
    public val licenseChoiceApp: Boolean = false,
    /** Sends `key_return=allow` (after `license_choice`, before `device_name`); off by default. See [SignInOptions.keyReturn]. */
    public val keyReturn: Boolean = false,
)

/** The card's prefill (§12.4): verifies nothing. */
public class PushHints @JvmOverloads constructor(
    public val loginHint: String? = null,
    public val nameHint: String? = null,
    public val purpose: String? = null,
)

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

private const val MAX_URI_LENGTH = 2048
private const val MAX_PORT = 65535
private const val HTTP_PORT = 80
private const val FIRST_PRINTABLE = 0x20
private const val DEL = 0x7F
private const val HTTP_CREATED = 201
private const val MAX_RETRY_AFTER_SECONDS = 3600
private const val REQUEST_NOT_SERVED = "request-not-served"
private const val NO_CLASS = "no-class"

private val RESERVED_SCHEMES = setOf("http", "https", "javascript", "data", "file")
private val SCHEME_PATTERN = Regex("[a-z][a-z0-9+.-]*")
private val LOOPBACK = Regex("http://(127\\.0\\.0\\.1|\\[::1]):([0-9]{1,5})(/.*)")
private val CLAIMED = Regex("https://([^/?#@]+)(/[^?#]*)")
private val SCHEME_URI = Regex("([a-z][a-z0-9+.-]*):(/[^?#]*)")
private val REQUEST_URI = Regex("urn:ietf:params:oauth:request_uri:[A-Za-z0-9_-]{22}")
private val REQUEST_HANDLE = Regex("rq_[A-Za-z0-9_-]{22}")
private val BASE_OF = Regex("([A-Za-z][A-Za-z0-9+.-]*):(//[^/?#]*)?([^?#]*).*", RegexOption.DOT_MATCHES_ALL)
private val ABSOLUTE_HTTP = Regex("https?://\\S+")
private val SUCCESS_PARAMS = setOf("code", "state", "iss", "request")
private val ERROR_PARAMS = setOf("error", "error_description", "state", "iss", "request")

/** The shape of each class of redirect URI (§12.12). */
private object ClassRules {
    fun loopbackClass(uri: String): NativeRedirectClass? {
        val (_, digits, path) = (LOOPBACK.matchEntire(uri) ?: return null).destructured
        val leadingZero = digits.length > 1 && digits.startsWith("0")
        val ok = NativeUri.isUsablePort(digits.toInt()) && path == NativeRedirect.PATH && !leadingZero
        return NativeRedirectClass.Loopback.takeIf { ok }
    }

    fun claimedClass(uri: String): NativeRedirectClass? =
        NativeRedirectClass.Claimed.takeIf { CLAIMED.matchEntire(uri)?.groupValues?.get(2).let { it != null && it != "/" } }

    fun schemeClass(uri: String): NativeRedirectClass? {
        val m = SCHEME_URI.matchEntire(uri) ?: return null
        return NativeRedirectClass.Scheme.takeIf { m.groupValues[1] !in RESERVED_SCHEMES && m.groupValues[2] == NativeRedirect.PATH }
    }

    fun of(uri: String): NativeRedirectClass? = loopbackClass(uri) ?: claimedClass(uri) ?: schemeClass(uri)
}

/** The URI rules of §12.12, shared with the session layer. */
internal object NativeUri {
    private fun isBlank(c: Char) = c.isWhitespace() || Character.isSpaceChar(c) || c == '\uFEFF'

    private fun isControl(c: Char) = c.code < FIRST_PRINTABLE || c.code == DEL

    /** Whitespace, a control character or a backslash anywhere in [s]. */
    fun hasForbiddenChar(s: String): Boolean = s.any { isBlank(it) || isControl(it) || it == '\\' }

    fun isUsablePort(port: Int): Boolean = port in 1..MAX_PORT && port != HTTP_PORT

    fun ensure(ok: Boolean, message: String) {
        if (!ok) throw IdentityRedirect.invalid(message)
    }

    /** The class of [uri], or null when it is none. */
    fun classify(uri: String?): NativeRedirectClass? = if (uri.isNullOrEmpty() || uri.length > MAX_URI_LENGTH || hasForbiddenChar(uri)) {
        null
    } else {
        ClassRules.of(uri)
    }

    fun isSchemeName(scheme: String): Boolean = SCHEME_PATTERN.matches(scheme) && scheme !in RESERVED_SCHEMES

    fun isAbsoluteHttp(url: String): Boolean = ABSOLUTE_HTTP.matches(url)

    fun isRequestUri(uri: String): Boolean = REQUEST_URI.matches(uri)
}

/** Building a push (§12.12): the validated pieces and the form. */
private object PushRules {
    fun validate(endpoints: NativeEndpoints, redirectUri: String, options: PushOptions): NativeRedirectClass {
        val redirectClass = NativeUri.classify(redirectUri) ?: throw IdentityRedirect.invalid("redirectUri is not a native redirect URI.")
        NativeUri.ensure(
            options.returnUri == null || NativeUri.classify(options.returnUri) == NativeRedirectClass.Scheme,
            "returnUri must be a registered scheme's redirect URI.",
        )
        for ((name, value) in listOf(
            "request" to endpoints.requestEndpoint,
            "authorize" to endpoints.authorizeEndpoint,
            "token" to endpoints.tokenEndpoint,
        )) {
            NativeUri.ensure(NativeUri.isAbsoluteHttp(value), "the $name endpoint is not an absolute URL.")
        }
        NativeUri.ensure(endpoints.issuer.isNotEmpty(), "discovery names no issuer.")
        NativeUri.ensure(endpoints.clientId.isNotEmpty(), "clientId is empty.")
        return redirectClass
    }

    fun stateOf(entropy: PushEntropy): String {
        val state = entropy.state ?: IdentityRedirect.generateState(entropy.random)
        NativeUri.ensure(
            state.length in IdentityRedirect.STATE_MIN..IdentityRedirect.STATE_MAX && IdentityRedirect.isPrintable(state),
            "state must be 16 to 512 printable characters.",
        )
        return state
    }

    private fun isUnreserved(c: Char) = c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c == '-' || c == '.' || c == '_' || c == '~'

    fun verifierOf(entropy: PushEntropy): String {
        val verifier = entropy.codeVerifier ?: IdentityRedirect.generateCodeVerifier(entropy.random)
        NativeUri.ensure(
            verifier.length in IdentityRedirect.VERIFIER_MIN..IdentityRedirect.VERIFIER_MAX && verifier.all(::isUnreserved),
            "the PKCE verifier must be 43 to 128 unreserved characters.",
        )
        return verifier
    }

    private fun scopeText(scope: List<String>): String {
        val parts = scope.joinToString(" ").split(' ').filter { it.isNotEmpty() }
        NativeUri.ensure(parts.isNotEmpty() && parts.all(IdentityRedirect::isPrintable), "scope must be a space-delimited list of printable scopes.")
        return parts.joinToString(" ")
    }

    private fun optional(name: String, value: String?): Pair<String, String>? = value?.takeIf { it.isNotEmpty() }?.let { name to it }

    /**
     * Member order: `response_type client_id redirect_uri state code_challenge code_challenge_method [scope]
     * [login_hint] [name_hint] [purpose] [license_choice] [key_return] [device_name] [return_uri]`.
     */
    fun form(endpoints: NativeEndpoints, redirectUri: String, state: String, verifier: String, options: PushOptions): String =
        IdentityRedirect.formBody(
            listOfNotNull(
                "response_type" to "code", "client_id" to endpoints.clientId, "redirect_uri" to redirectUri, "state" to state,
                "code_challenge" to IdentityRedirect.pkceChallenge(verifier), "code_challenge_method" to "S256",
                options.scope?.let { "scope" to scopeText(it) },
                optional("login_hint", options.hints.loginHint), optional("name_hint", options.hints.nameHint),
                optional("purpose", options.hints.purpose),
                ("license_choice" to "app").takeIf { options.licenseChoiceApp },
                ("key_return" to IdentityRedirect.KEY_RETURN_ALLOW).takeIf { options.keyReturn },
                optional("device_name", options.deviceName), optional("return_uri", options.returnUri),
            ),
        )
}

/** Reading the Worker's answer to a push (§12.12). */
private object AnswerRules {
    fun refusal(status: Int, o: JsonObject?): PushedAnswer {
        val error = o?.get("error").stringValue?.takeIf { it.isNotEmpty() } ?: "server_error"
        return PushedAnswer.Refused(error, status, wholeSeconds(o?.get("retryAfter"))?.coerceAtMost(MAX_RETRY_AFTER_SECONDS.toLong())?.toInt())
    }
}

/** Reading the redirect back (§12.12): the first failure wins, in the order of [NativeRedirect.parseCallback]. */
private object CallbackRules {
    /** `scheme:` + authority lower-cased, path as given; null for anything not an absolute URL. */
    private fun baseOf(url: String): String? {
        val (scheme, authority, path) = (BASE_OF.matchEntire(url) ?: return null).destructured
        return "${scheme.lowercase()}:${authority.lowercase()}$path"
    }

    private fun failed(reason: CallbackFailure, error: String? = null) = NativeCallback.Failed(reason, error)

    /** The URL is absolute with no fragment, and at the redirect URI the request named. */
    private fun urlFailure(redirectUri: String, url: String?): NativeCallback.Failed? {
        val got = url?.takeUnless { it.contains('#') }?.let(::baseOf)
        val want = baseOf(redirectUri)
        return when {
            got == null || want == null -> failed(CallbackFailure.Malformed)
            got != want -> failed(CallbackFailure.RedirectMismatch)
            else -> null
        }
    }

    private fun sameText(a: String?, b: String) = a != null && MessageDigest.isEqual(a.toByteArray(Charsets.UTF_8), b.toByteArray(Charsets.UTF_8))

    private fun identityFailure(q: Map<String, String>, state: String, issuer: String): NativeCallback.Failed? = when {
        !sameText(q["state"], state) -> failed(CallbackFailure.StateMismatch)
        !sameText(q["iss"], issuer) -> failed(CallbackFailure.IssuerMismatch)
        else -> null
    }

    private fun requestInvalid(request: String?, required: Boolean) = if (request != null) !REQUEST_HANDLE.matches(request) else required

    private fun shapeFailure(q: Map<String, String>, loopback: Boolean): NativeCallback.Failed? {
        val error = q["error"]
        return when {
            error == null && q["code"].isNullOrEmpty() -> failed(CallbackFailure.MissingCode)
            q.keys.any { it !in (if (error != null) ERROR_PARAMS else SUCCESS_PARAMS) } -> failed(CallbackFailure.UnexpectedParameter)
            requestInvalid(q["request"], loopback && error == null) -> failed(CallbackFailure.RequestInvalid)
            else -> null
        }
    }

    private fun outcome(q: Map<String, String>): NativeCallback {
        val error = q["error"]
        return when {
            error == null -> NativeCallback.Code(q.getValue("code"), q["request"])
            error == "access_denied" -> NativeCallback.Cancelled(q["request"])
            else -> failed(CallbackFailure.AuthorizationError, error)
        }
    }

    private fun parseQuery(q: Map<String, String>, pending: NativePending): NativeCallback = identityFailure(q, pending.state, pending.issuer)
        ?: shapeFailure(q, pending.redirectClass == NativeRedirectClass.Loopback)
        ?: outcome(q)

    fun parse(pending: NativePending, callbackUrl: String?): NativeCallback {
        val bad = urlFailure(pending.redirectUri, callbackUrl)
        val q = if (bad == null) IdentityRedirect.query(callbackUrl.orEmpty()) else null
        return bad ?: q?.let { parseQuery(it, pending) } ?: failed(CallbackFailure.Malformed)
    }
}

public object NativeRedirect {
    /** §12.12: the one path of the loopback and scheme redirect URIs (RFC 8252 §7). */
    public const val PATH: String = "/pkey/callback"

    /** §12.12: how long a pushed request lives. */
    public const val PUSHED_REQUEST_TTL_SECONDS: Long = 600

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
    ): RedirectChoice = when {
        requestEndpoint.isNullOrEmpty() || discovery == null -> RedirectChoice.Unavailable(REQUEST_NOT_SERVED)

        canListen && discovery.loopback -> RedirectChoice.Loopback

        else -> registeredSchemes.firstOrNull { it in discovery.schemes }?.let(RedirectChoice::Scheme)
            ?: registeredClaimed.firstOrNull { it in discovery.claimedHttps }?.let(RedirectChoice::Claimed)
            ?: RedirectChoice.Unavailable(NO_CLASS)
    }

    // ── 2. the redirect URI ──────────────────────────────────────────────────────────────

    /**
     * The class of a native redirect URI, or null when it is none (§12.12: `localhost`, another path, a query, a
     * fragment, userinfo, port 80 or no port are all refused).
     */
    public fun classify(uri: String?): NativeRedirectClass? = NativeUri.classify(uri)

    /** The loopback redirect URI for a listener's OS-assigned port (IPv4). */
    public fun loopbackUri(port: Int): String {
        NativeUri.ensure(NativeUri.isUsablePort(port), "the loopback port must be an explicit port other than 80.")
        return "http://127.0.0.1:$port$PATH".also { NativeUri.ensure(classify(it) == NativeRedirectClass.Loopback, "not a native redirect URI.") }
    }

    /** The redirect URI of a registered scheme: `<scheme>:/pkey/callback`. */
    public fun schemeUri(scheme: String): String {
        NativeUri.ensure(NativeUri.isSchemeName(scheme), "the scheme is not a registrable URL scheme.")
        return "$scheme:$PATH".also { NativeUri.ensure(classify(it) == NativeRedirectClass.Scheme, "not a native redirect URI.") }
    }

    // ── 3. the pushed request ────────────────────────────────────────────────────────────

    /** Build the pushed request (§12.12). Nothing here touches the network. Throws `invalid-argument`. */
    @JvmOverloads
    public fun pushRequest(
        endpoints: NativeEndpoints,
        redirectUri: String,
        options: PushOptions = PushOptions(),
        entropy: PushEntropy = PushEntropy(),
    ): PushedRequest {
        val redirectClass = PushRules.validate(endpoints, redirectUri, options)
        val state = PushRules.stateOf(entropy)
        val verifier = PushRules.verifierOf(entropy)
        return PushedRequest(
            endpoints.requestEndpoint,
            IdentityRedirect.TOKEN_CONTENT_TYPE,
            PushRules.form(endpoints, redirectUri, state, verifier, options),
            NativePending(redirectClass, redirectUri, state, verifier, endpoints, NativeOptIns(options.licenseChoiceApp, options.keyReturn)),
        )
    }

    /** Read the answer of `POST /<p>/identity/request`: `201 {request_uri, expires_in}`. */
    public fun parsePushedAnswer(status: Int, body: JsonElement?): PushedAnswer {
        val o = body.objectValue
        val uri = o?.get("request_uri").stringValue?.takeIf { NativeUri.isRequestUri(it) }
        val expires = o?.get("expires_in").longValue?.takeIf { it in 1..PUSHED_REQUEST_TTL_SECONDS }
        return when {
            status != HTTP_CREATED -> AnswerRules.refusal(status, o)
            uri == null || expires == null -> PushedAnswer.Malformed
            else -> PushedAnswer.Pushed(uri, expires)
        }
    }

    // ── 5. the authorize URL ─────────────────────────────────────────────────────────────

    /** `authorize?client_id=<id>&request_uri=<uri>`: the only parameters a pushed request takes. */
    public fun authorizeUrlFor(authorizeEndpoint: String, clientId: String, requestUri: String): String {
        NativeUri.ensure(NativeUri.isRequestUri(requestUri), "not a pushed request URI.")
        val joiner = if (authorizeEndpoint.contains('?')) "&" else "?"
        return "$authorizeEndpoint${joiner}client_id=${ManageLink.formEncode(clientId)}&request_uri=${ManageLink.formEncode(requestUri)}"
    }

    // ── 6. the redirect back ─────────────────────────────────────────────────────────────

    /**
     * Check the redirect back to the app. The first failure wins, in this order: absolute URL with no fragment; at
     * the redirect URI the request named; no repeated parameter; `state` (constant time); `iss` (RFC 9207: a
     * callback with no `iss` is refused); `error` (`access_denied` is cancelled); `code`; no parameter beyond
     * `code state iss request` (or `error error_description state iss request`); on loopback, `request=` an `rq_`
     * handle. A delivery that carries `request` must hold a valid handle on any class.
     */
    public fun parseCallback(pending: NativePending, callbackUrl: String?): NativeCallback = CallbackRules.parse(pending, callbackUrl)

    // ── 7. the token request ─────────────────────────────────────────────────────────────

    /**
     * `POST /<p>/identity/token` for a code from a pushed request (§12.5): the form of
     * [IdentityRedirect.tokenForm] and the pusher's `X-PKey-Device` (a different device is `invalid_grant`).
     */
    @JvmOverloads
    public fun tokenRequest(pending: NativePending, code: String, deviceId: String, deviceName: String? = null): NativeTokenRequest {
        NativeUri.ensure(IdentityRedirect.isPrintable(deviceId), "deviceId is empty or not printable.")
        return NativeTokenRequest(
            pending.tokenEndpoint,
            deviceId,
            IdentityRedirect.TOKEN_CONTENT_TYPE,
            IdentityRedirect.tokenForm(pending.clientId, pending.codeVerifier, pending.redirectUri, code, deviceName),
        )
    }
}
