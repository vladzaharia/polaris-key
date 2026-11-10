// `identity.accessToken()` (identity.accesstoken, D6, WIRE-CONTRACT-V5 section 12.13.10): the app's
// own short-lived access token for its own backend, from its device token. A port of client-core's
// `identityAccessToken.ts` and Node's `identity/accessToken.ts`.
//
// WHAT IT PROVES: this device holds a sign-in (`sub` is the device's pairwise subject, `client_id`
// the product). It is NOT a licence check: no tier, no entitlement, and a signed-in device has one
// whether or not its licence is valid. A backend that sells a licensed feature also checks the
// licence (the server drop-ins).
//
// Discovery gates it: only a product whose identity fragment carries `accessToken: true` and a
// `token` endpoint is asked; otherwise the call is the typed `service-unavailable` N/A with no
// request. The token lives in memory only (never stored, never logged), is bound to the device
// token it was asked with, is reused until 60 seconds before it expires, is asked for once at a
// time, and is dropped at sign-out. A 429's wait is honoured without a request. The SDK never
// verifies it: its signature is the backend's to check.

package im.plrs.key.identity

import im.plrs.key.core.CoreContext
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Feature
import im.plrs.key.core.IdentityDiscovery
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.Unsupported
import im.plrs.key.core.UnsupportedReason
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import java.net.URI

/** The reuse margin of section 12.13.10 rule 4: a held token is reused until this many seconds before it expires. */
public const val ACCESS_TOKEN_REUSE_MARGIN_SECONDS: Long = 60

/** The longest `access_token` accepted (8 KiB): a larger one is `bad_response`. */
public const val ACCESS_TOKEN_MAX_LENGTH: Int = 8192

/**
 * What `identity.accessToken()` answers. Kept in memory only; [toString] hides the token.
 */
public data class AccessToken(
    /** The compact `at+jwt`, for `Authorization: Bearer ...` on the app's own backend. */
    val accessToken: String,
    val tokenType: String = "Bearer",
    /** Seconds left on the token when it was handed out. A fresh exchange answers 600. */
    val expiresIn: Long,
    /** Epoch seconds, by the SDK's clock. */
    val expiresAt: Long,
) {
    override fun toString(): String = "AccessToken(accessToken=[redacted], tokenType=$tokenType, expiresIn=$expiresIn, expiresAt=$expiresAt)"
}

/** What a `200` carries, as the cache holds it. */
internal class AccessTokenGrant(val accessToken: String, val expiresIn: Long)

internal object AccessTokenWire {
    const val GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange"
    const val SUBJECT_TOKEN_TYPE = "urn:polaris-key:token-type:device"
    const val ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token"
    const val CONTENT_TYPE = "application/x-www-form-urlencoded"
    const val BODY_LIMIT = 16384
    const val HTTP_SERVER_ERROR = 500
    const val HTTP_TOO_MANY_REQUESTS = 429
    const val HTTPS_PORT = 443
    const val HTTP_PORT = 80
    const val REDIRECT_FIRST = 300
    const val REDIRECT_LAST = 399
    const val HTTP_OK = 200

    private val COMPACT_JWS = Regex("[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+")

    /** The exchange form; the parameter order is fixed so every SDK sends the same bytes. */
    fun form(clientId: String, deviceToken: String): String = IdentityRedirect.formBody(
        listOf(
            "grant_type" to GRANT_TYPE,
            "client_id" to clientId,
            "subject_token" to deviceToken,
            "subject_token_type" to SUBJECT_TOKEN_TYPE,
            "requested_token_type" to ACCESS_TOKEN_TYPE,
        ),
    )

    /**
     * Read a `200` answer: exactly an `access_token` (a compact JWS of at most 8 KiB), `issued_token_type` the
     * access-token type, `token_type` `Bearer` and a positive integer `expires_in`; anything else is `bad_response`.
     */
    fun read(text: String): AccessTokenGrant = grantOf(JsonText.parseOrNull(text).objectValue)
        ?: throw PolarisException(ErrorCode.badResponse, "the access token exchange answered without a usable access token.")

    private fun grantOf(b: JsonObject?): AccessTokenGrant? {
        val token = b?.get("access_token").stringValue
        val typed = b != null && b["issued_token_type"].stringValue == ACCESS_TOKEN_TYPE && b["token_type"].stringValue == "Bearer"
        val expiresIn = b?.get("expires_in").longValue?.takeIf { it > 0 }
        return if (typed && token != null && isCompactJws(token)) expiresIn?.let { AccessTokenGrant(token, it) } else null
    }

    private fun isCompactJws(token: String): Boolean = token.length <= ACCESS_TOKEN_MAX_LENGTH && COMPACT_JWS.matches(token)

    /** A refusal or a failure as the SDK's one taxonomy: the wire code, with the status and the wait the body or header named. */
    fun failure(res: PolarisResponse): PolarisException = when {
        // No redirect is followed: the device token is in the body.
        res.status in REDIRECT_FIRST..REDIRECT_LAST ->
            PolarisException(ErrorCode.networkError, "the access token exchange was redirected; it is never followed.")

        res.status >= HTTP_SERVER_ERROR ->
            PolarisException(ErrorCode.serverError, "the access token exchange failed with status ${res.status}.")

        else -> {
            val b = JsonText.parseOrNull(res.text).objectValue
            val code = IdentityExchange.errorCode(b, res.status)
            PolarisException(
                code,
                "the access token exchange was refused ($code).",
                httpStatus = res.status,
                retryAfterSeconds = IdentityExchange.retryAfter(res, b),
            )
        }
    }

    /** Scheme, host and port of both: the device token goes only to the client's own origin. */
    fun sameOrigin(url: String, base: String): Boolean = runCatching {
        val a = URI(url)
        val b = URI(base)
        a.scheme != null && a.host != null && a.scheme.equals(b.scheme, true) && a.host.equals(b.host, true) && portOf(a) == portOf(b)
    }.getOrDefault(false)

    private fun portOf(u: URI): Int = when {
        u.port != -1 -> u.port
        u.scheme.equals("https", true) -> HTTPS_PORT
        u.scheme.equals("http", true) -> HTTP_PORT
        else -> -1
    }

    /** The one transport failure: the SDK's `network-error` with the cause, except a cancellation or local-only mode, which pass through. */
    fun transportFailure(e: Throwable): Throwable = if (e is CancellationException || (e is PolarisException && e.code == ErrorCode.localOnly)) {
        e
    } else {
        PolarisException(ErrorCode.networkError, e.message ?: "network error", cause = e)
    }
}

/**
 * The one in-memory access token of a client, bound to the device token it was asked with (the `key`: a
 * replaced token, another account's sign-in or a re-activation is a different key, so nobody is handed a token
 * that belongs to another sign-in). [get] returns the held token while it is for this key and more than
 * [ACCESS_TOKEN_REUSE_MARGIN_SECONDS] remain, and otherwise runs `exchange` once: callers with the same key that
 * arrive while it runs share its answer, a caller with another key starts its own and never joins. `refresh`
 * skips the held token; it still joins an exchange in flight. A failure is not cached, except that a
 * `rate_limited` answer carrying `retryAfterSeconds` is remembered per key: until it has passed [get] fails
 * fast with `rate_limited`, sending nothing, `refresh` included. [clear] drops all of it and detaches any
 * exchange in flight, so its answer is not kept after a sign-out.
 *
 * The exchange runs in the cache's own scope, so one caller's cancellation does not fail the callers sharing it.
 */
internal class AccessTokenCache(private val now: suspend () -> Long) {
    private class Held(val key: String, val token: AccessToken)

    private class Pending(val key: String, val run: CompletableDeferred<AccessToken> = CompletableDeferred())

    private class Limited(val key: String, val until: Long)

    private val lock = Mutex()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var held: Held? = null
    private var pending: Pending? = null
    private var limited: Limited? = null

    private sealed interface Step {
        class Reuse(val token: AccessToken) : Step

        class Join(val pending: Pending) : Step

        class Start(val pending: Pending) : Step
    }

    suspend fun get(key: String, refresh: Boolean, exchange: suspend () -> AccessTokenGrant): AccessToken =
        when (val step = lock.withLock { plan(key, refresh) }) {
            is Step.Reuse -> step.token

            is Step.Join -> step.pending.run.await()

            is Step.Start -> {
                scope.async { settle(step.pending, exchange) }
                step.pending.run.await()
            }
        }

    /** What this call does, decided under the lock; a wait that has not passed is thrown, a passed one forgotten. */
    private suspend fun plan(key: String, refresh: Boolean): Step {
        val t = now()
        val h = held
        val p = pending
        return if (h != null && reusable(h, key, refresh, t)) {
            Step.Reuse(h.token.copy(expiresIn = h.token.expiresAt - t))
        } else if (p != null && p.key == key) {
            Step.Join(p)
        } else {
            checkWait(key, t)
            Step.Start(Pending(key).also { pending = it })
        }
    }

    private fun reusable(h: Held, key: String, refresh: Boolean, t: Long): Boolean =
        !refresh && h.key == key && h.token.expiresAt - ACCESS_TOKEN_REUSE_MARGIN_SECONDS > t

    private fun checkWait(key: String, t: Long) {
        val wait = limited?.takeIf { it.key == key } ?: return
        if (wait.until > t) {
            throw PolarisException(
                ErrorCode.rateLimited,
                "the access token exchange is rate limited; wait before asking again.",
                httpStatus = AccessTokenWire.HTTP_TOO_MANY_REQUESTS,
                retryAfterSeconds = (wait.until - t).coerceAtMost(Int.MAX_VALUE.toLong()).toInt(),
            )
        }
        limited = null
    }

    /**
     * Run the exchange, settle the cache state, and only then answer the callers: one that asks again the moment
     * it hears a failure must not find the failed exchange still in flight.
     */
    private suspend fun settle(mine: Pending, exchange: suspend () -> AccessTokenGrant) {
        val outcome = runCatching { exchange() }
        val token = outcome.getOrNull()?.let { AccessToken(it.accessToken, "Bearer", it.expiresIn, now() + it.expiresIn) }
        val wait = (outcome.exceptionOrNull() as? PolarisException)?.takeIf { it.code == ErrorCode.rateLimited }?.retryAfterSeconds
        val limitedUntil = if (wait != null && wait > 0) now() + wait else null
        lock.withLock {
            // Kept only while this is still the client's exchange: a clear() or a caller with another key took it over.
            if (pending === mine) {
                if (token != null) held = Held(mine.key, token)
                if (limitedUntil != null) limited = Limited(mine.key, limitedUntil)
                pending = null
            }
        }
        if (token !=
            null
        ) {
            mine.run.complete(token)
        } else {
            mine.run.completeExceptionally(outcome.exceptionOrNull() ?: IllegalStateException("no outcome"))
        }
    }

    /** Drop the token, the rate-limit wait and any exchange in flight (sign-out, deactivation). */
    suspend fun clear() {
        lock.withLock {
            held = null
            pending = null
            limited = null
        }
    }
}

internal class AccessTokens(
    private val core: CoreContext,
    /** The identity fragment, discovering once when this client has not yet (IdentityAccount's). */
    private val fragment: suspend () -> IdentityDiscovery?,
) {
    private val cache = AccessTokenCache { core.now() }

    suspend fun clear() = cache.clear()

    suspend fun get(refresh: Boolean): AccessToken {
        val endpoint = gate()
        // The cache is bound to this token: another sign-in or a replaced token is a different key.
        val deviceToken = core.token() ?: throw PolarisException(ErrorCode.noToken, "Sign in before asking for an access token.")
        checkOrigin(endpoint)
        return cache.get(deviceToken, refresh) { exchange(endpoint, deviceToken) }
    }

    private suspend fun exchange(endpoint: String, deviceToken: String): AccessTokenGrant {
        val sent = runCatching {
            core.request(
                endpoint,
                method = "POST",
                headers = mapOf("content-type" to AccessTokenWire.CONTENT_TYPE),
                body = AccessTokenWire.form(core.product, deviceToken).toByteArray(Charsets.UTF_8),
                // A 200 is a token of at most 8 KiB in a small object; a larger body is read no further.
                maxBodyBytes = AccessTokenWire.BODY_LIMIT,
                followRedirects = false,
            )
        }
        val response = sent.getOrElse { throw AccessTokenWire.transportFailure(it) }
        if (response.status != AccessTokenWire.HTTP_OK) throw AccessTokenWire.failure(response)
        return AccessTokenWire.read(response.text)
    }

    /** Discovery gates it (read first: the gate reads what it says); the token endpoint, else the typed N/A. */
    private suspend fun gate(): String {
        val fragment = fragment()
        core.requireService(ServiceSlug.identity, Feature.identityAccesstoken)
        val endpoint = fragment?.endpoints?.get("token")?.takeIf { it.isNotEmpty() }
        if (fragment == null || !fragment.accessToken || endpoint == null) {
            throw unavailable("this product's discovery names no access token exchange: its sign-in issuer is not served")
        }
        return endpoint
    }

    /** The device token travels in the body: only to the client's own origin. */
    private fun checkOrigin(endpoint: String) {
        if (!AccessTokenWire.sameOrigin(endpoint, core.endpoints.baseUrl)) {
            throw unavailable("this product's discovery names an access token exchange outside its own origin")
        }
    }

    private fun unavailable(detail: String): PolarisException {
        val unsupported = Unsupported(Feature.identityAccesstoken, UnsupportedReason.product, detail)
        return PolarisException(
            ErrorCode.serviceUnavailable,
            "The access token exchange is not available for ${core.product}.",
            detail = detail,
            unsupported = unsupported,
        )
    }
}
