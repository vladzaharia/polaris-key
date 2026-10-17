// `client.backend` — the client half of a product backend (WIRE-CONTRACT-V4 §14, framework
// drop-ins §6). It sends the app's signed licence document to the app's own backend:
//
//     val http = client.backend.install(OkHttpClient.Builder()).build()
//     val headers = client.backend.headers()   // raw: you decide where they go
//
// The headers are `X-PKey-License` (the compact licence JWS, when one is held) and
// `X-PKey-Device`. Never the device token, never the config document.
//
// SECURITY. OkHttp follows redirects INSIDE an application interceptor's chain and keeps custom
// headers on a hop to another host, so an application interceptor alone cannot stop the licence
// leaving for another origin. The licence therefore rides on two halves that [install] adds
// together:
//
//   * [BackendClient.interceptor] (application level) checks the URL's origin, syncs a document
//     near its expiry, forces one sync and one retry on `license_stale` / `license_invalid`, and
//     throws the typed 403 errors. It attaches NO header itself.
//   * [BackendClient.networkInterceptor] (network level) runs on every hop, BEFORE the hop is sent:
//     a hop whose origin is not in `backend.origins` is refused (`backend-origin-not-allowed`), and
//     an allowed hop gets the headers.
//
// A refused hop may still cost a DNS lookup or a TLS handshake, but no header is sent. An app that
// logs with HttpLoggingInterceptor should call `redactHeader("X-PKey-License")` on it.
//
// Add `interceptor()` without the network half and the request goes out with no licence at all
// (nothing leaks); the call then throws `not-configured`. `headers()` is raw and checks nothing.
// An error message names the origin only: a URL's path and query can hold a secret.
//
// The rule is [clientBackendAction] (`backend-matrix.json`'s `client` section). Concurrent callers
// share one sync, and two forced syncs are at least 10 s apart, so a backend that answers
// `license_stale` to every request cannot make the client ask the Worker for a document per request.

package im.plrs.key.sdk

import im.plrs.key.core.Copy
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.core.REFRESH_MARGIN_SECONDS
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response

/** §14.5: what the client does next. */
public enum class BackendAction(public val wire: String) {
    send("send"),
    refreshThenSend("refresh-then-send"),
    refreshAndRetry("refresh-and-retry"),
    surface("surface"),
}

/** The held licence document's window, epoch seconds. */
public data class BackendDocument(val issuedAt: Long, val expiresAt: Long)

/** A backend's answer: its status and the problem body's `code` (null when it has none). */
public data class BackendResponse(val status: Int, val code: String?)

/**
 * §14.5. [document] is the held licence or null; [response] is null before sending.
 */
public fun clientBackendAction(
    document: BackendDocument?,
    now: Long,
    response: BackendResponse?,
    retried: Boolean = false,
): BackendAction {
    if (response == null) {
        if (document == null) return BackendAction.send
        return if (now > document.expiresAt - REFRESH_MARGIN_SECONDS) BackendAction.refreshThenSend else BackendAction.send
    }
    if (response.status == 401 && (response.code == "license_stale" || response.code == "license_invalid") && !retried) {
        return BackendAction.refreshAndRetry
    }
    return BackendAction.surface
}

public class BackendClient internal constructor(
    origins: Iterable<String>,
    private val held: suspend () -> Held?,
    private val deviceId: suspend () -> String,
    private val now: suspend () -> Long,
    /** True when the licence document is now current (applied or unchanged). */
    private val sync: suspend (force: Boolean) -> Boolean,
    private val monotonic: () -> Double = { System.nanoTime() / 1e9 },
) {
    internal data class Held(val jws: String, val issuedAt: Long, val expiresAt: Long)

    private val allowed: Set<String> = origins.map(::normalizeBackendOrigin).toSet()

    /** The configured origins, normalised and sorted. */
    public val origins: List<String> get() = allowed.sorted()

    // ── The headers ──────────────────────────────────────────────────────────────────────

    /**
     * `X-PKey-License` and `X-PKey-Device`, raw. A document within the refresh margin of its expiry
     * is synced first. Without a licence only `X-PKey-Device` is returned.
     */
    public suspend fun headers(): Map<String, String> {
        freshen()
        return build()
    }

    private suspend fun build(): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        held()?.let { out[HEADER_LICENSE] = it.jws }
        out[HEADER_DEVICE] = deviceId()
        return out
    }

    private suspend fun action(response: BackendResponse?, retried: Boolean = false): BackendAction {
        val h = held()
        return clientBackendAction(h?.let { BackendDocument(it.issuedAt, it.expiresAt) }, now(), response, retried)
    }

    private suspend fun freshen() {
        if (action(null) == BackendAction.refreshThenSend) shared(false)
    }

    // ── One shared sync ──────────────────────────────────────────────────────────────────

    private class Flight(val force: Boolean) {
        val result = CompletableDeferred<Boolean>()
    }

    private val lock = Mutex()
    private var flight: Flight? = null
    private var lastForced: Double? = null

    /** One sync for every concurrent caller; a forced caller joins only a forced one. */
    private suspend fun shared(force: Boolean): Boolean {
        var joined: Flight? = null
        val mine = Flight(force)
        lock.withLock {
            val live = flight
            if (live != null && (live.force || !force)) {
                joined = live
            } else {
                if (force) {
                    val at = monotonic()
                    val last = lastForced
                    if (last != null && at - last < FORCED_SYNC_MIN_INTERVAL_SECONDS) return false
                    lastForced = at
                }
                flight = mine
            }
        }
        joined?.let { return it.result.await() }
        try {
            mine.result.complete(runCatching { sync(force) }.getOrDefault(false))
        } finally {
            lock.withLock { if (flight === mine) flight = null }
        }
        return mine.result.await()
    }

    // ── Origins ──────────────────────────────────────────────────────────────────────────

    private fun assertAllowed(url: HttpUrl) {
        val origin = originOf(url)
        if (origin !in allowed) throw refusal(origin)
    }

    // ── OkHttp ───────────────────────────────────────────────────────────────────────────

    /** What the application half hands the network half through the request's tag. */
    private class Handoff(val headers: Map<String, String>) {
        val sent = AtomicBoolean(false)
    }

    /** Add [interceptor] and [networkInterceptor] to [builder] together. The usual call. */
    public fun install(builder: OkHttpClient.Builder): OkHttpClient.Builder =
        builder.addInterceptor(interceptor()).addNetworkInterceptor(networkInterceptor())

    /**
     * The application half; needs [networkInterceptor] on the same client (see [install]). Throws
     * [PolarisException] `backend-origin-not-allowed` for a URL outside `backend.origins`, and
     * `not_entitled` / `sign_in_required` for a 403 carrying them. Runs blocking work: call the
     * client off the main thread, as OkHttp requires anyway.
     */
    public fun interceptor(): Interceptor = Interceptor { chain ->
        val request = chain.request()
        assertAllowed(request.url)
        runBlocking { freshen() }
        var response = proceed(chain)
        var code = problemCode(response)
        if (runBlocking { action(BackendResponse(response.code, code)) } == BackendAction.refreshAndRetry &&
            runBlocking { shared(true) }
        ) {
            response.close()
            response = proceed(chain)
            code = problemCode(response)
        }
        if (response.code == 403 && (code == "not_entitled" || code == "sign_in_required")) {
            response.close()
            throw PolarisException(code, Copy.message(code))
        }
        response
    }

    private fun proceed(chain: Interceptor.Chain): Response {
        val handoff = Handoff(runBlocking { build() })
        val response = chain.proceed(chain.request().newBuilder().tag(Handoff::class.java, handoff).build())
        if (!handoff.sent.get()) {
            response.close()
            throw PolarisException(
                ErrorCode.notConfigured,
                "client.backend.interceptor() needs client.backend.networkInterceptor() on the same client; use install().",
            )
        }
        return response
    }

    /** The network half: on every hop, refuses a foreign origin before sending, else adds the headers. */
    public fun networkInterceptor(): Interceptor = Interceptor { chain ->
        val request = chain.request()
        val handoff = request.tag(Handoff::class.java) ?: return@Interceptor chain.proceed(request)
        assertAllowed(request.url)
        val builder = request.newBuilder()
        for ((k, v) in handoff.headers) builder.header(k, v)
        handoff.sent.set(true)
        chain.proceed(builder.build())
    }

    private fun problemCode(response: Response): String? {
        if (response.code != 401 && response.code != 403) return null
        return try {
            val text = response.peekBody(MAX_PROBLEM_BYTES).string()
            ((Json.parseToJsonElement(text) as? JsonObject)?.get("code") as? JsonPrimitive)?.takeIf { it.isString }?.content
        } catch (_: Exception) {
            null
        }
    }

    public companion object {
        public const val HEADER_LICENSE: String = "X-PKey-License"
        public const val HEADER_DEVICE: String = "X-PKey-Device"

        /** The least time between two forced syncs, seconds. */
        public const val FORCED_SYNC_MIN_INTERVAL_SECONDS: Double = 10.0
        private const val MAX_PROBLEM_BYTES = 64L * 1024
        private val LOOPBACK = setOf("localhost", "127.0.0.1", "[::1]")

        internal fun originOf(url: HttpUrl): String {
            val host = if (':' in url.host) "[${url.host}]" else url.host
            val default = if (url.scheme == "https") 443 else 80
            return if (url.port == default) "${url.scheme}://$host" else "${url.scheme}://$host:${url.port}"
        }

        internal fun refusal(origin: String): PolarisException =
            PolarisException(
                ErrorCode.backendOriginNotAllowed,
                // The origin only: a URL's path and query can hold a secret.
                Copy.message(ErrorCode.backendOriginNotAllowed, detail = origin),
            )

        /** One exact origin (`scheme://host[:port]`, lower-cased, default port dropped), or an `invalid-options` error. */
        @JvmStatic
        public fun normalizeOrigin(origin: String): String = normalizeBackendOrigin(origin)

        internal fun isLoopback(host: String): Boolean = host in LOOPBACK
    }
}

internal fun normalizeBackendOrigin(origin: String): String {
    fun bad() = PolarisException(
        ErrorCode.invalidOptions,
        "backend.origins: \"$origin\" is not an exact origin (https://host[:port]; http only on loopback).",
    )
    if ('*' in origin || origin.endsWith("?") || origin.endsWith("#")) throw bad()
    val url = origin.toHttpUrlOrNull() ?: throw bad()
    if (url.encodedPath != "/" || url.query != null || url.fragment != null || url.username.isNotEmpty() || url.password.isNotEmpty()) throw bad()
    // `https://a.example/x` has a path; `https://a.example` and `https://a.example/` do not.
    val afterAuthority = origin.substringAfter("://").substringAfter('/', "")
    if (afterAuthority.isNotEmpty()) throw bad()
    val shown = if (':' in url.host) "[${url.host}]" else url.host
    if (!(url.scheme == "https" || (url.scheme == "http" && BackendClient.isLoopback(shown)))) throw bad()
    return BackendClient.originOf(url)
}
