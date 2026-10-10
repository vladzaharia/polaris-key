// The transport seam — wire contract v3 §5. Everything that crosses the network goes through
// `PolarisTransport`, so every request carries the same `X-PKey-*` headers and deadline (R4-08),
// and §7.3's local-only profile is a TYPE: `NoNetworkTransport` refuses at the dial.
//
// The default transport is OkHttp, the one HTTP client that runs on Android API 24 and on the JVM
// (`java.net.http` does not exist on Android). It follows redirects ITSELF: an `Authorization`
// header is never forwarded across a redirect (OkHttp would keep it on a same-host hop), a redirect
// from https to plain http is refused, and at most `MAX_REDIRECTS` hops are taken. A request with
// `followRedirects = false` (the presentation icon) sees the 3xx itself.
//
// SP-50: `send` is main-safe. OkHttp's callback resumes the caller as soon as the HEADERS arrive, and
// the body is read after that; on Android, from `Dispatchers.Main`, that read throws
// NetworkOnMainThreadException whenever the body has not arrived with the headers (always, on a
// real network). The whole exchange, the body read included, runs on `Dispatchers.IO`.

package im.plrs.key.core

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/** The one error type the SDK throws; the verification path returns null instead. */
public class PolarisException(
    /** A registry code (`ErrorCode`), or the server's machine-readable code. */
    public val code: String,
    message: String,
    /** The refused step, where the code has one; null otherwise. */
    public val detail: String? = null,
    /** The typed N/A behind a `service-unavailable` refusal (P1b-10). */
    public val unsupported: Unsupported? = null,
    cause: Throwable? = null,
) : Exception(message, cause)

/** One HTTP response, reduced to what this SDK reads. */
public class PolarisResponse(
    public val status: Int,
    public val body: ByteArray,
    /** Response headers, one value per name (the last of a repeated one); read with [header]. */
    public val headers: Map<String, String> = emptyMap(),
    /**
     * Every response header line in arrival order, repeated names kept (`set-cookie`, `link`, a
     * multi-line `www-authenticate`); read with [headerValues]. Defaults to [headers]' pairs.
     */
    public val headerList: List<Pair<String, String>> = headers.entries.map { it.key to it.value },
) {
    public fun header(name: String): String? = headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value

    /** Every value of the header [name], case-insensitively, in arrival order. */
    public fun headerValues(name: String): List<String> =
        headerList.filter { it.first.equals(name, ignoreCase = true) }.map { it.second }

    public val isOk: Boolean get() = status in 200..299

    public val text: String get() = body.toString(Charsets.UTF_8)
}

/** One outbound request. */
public data class PolarisRequest(
    val url: String,
    val method: String = "GET",
    val headers: Map<String, String> = emptyMap(),
    val body: ByteArray? = null,
    /** Deadline in seconds; 0 disables it. */
    val timeoutSeconds: Double = 15.0,
    /** Stop reading the body after this many bytes; null reads it whole. */
    val maxBodyBytes: Int? = null,
    /**
     * False returns a 3xx as the response instead of following it (the presentation icon fetch:
     * plans/HA-13.md, no redirect is followed). A host's own transport should honour it too.
     */
    val followRedirects: Boolean = true,
)

/** Everything the SDK needs from a network stack. Safe to call concurrently. */
public interface PolarisTransport {
    /** One request. Throws on transport failure; a non-2xx status is a normal return. */
    public suspend fun send(request: PolarisRequest): PolarisResponse
}

/** The §7.3 local-only transport: it refuses, loudly, instead of dialling. */
public object NoNetworkTransport : PolarisTransport {
    override suspend fun send(request: PolarisRequest): PolarisResponse =
        throw PolarisException(ErrorCode.localOnly, "This client is in local-only mode; network calls are refused.")
}

/** The production transport, over OkHttp. Main-safe: every byte is read on `Dispatchers.IO`. */
public class OkHttpTransport private constructor(client: OkHttpClient, private val owned: Boolean) : PolarisTransport, AutoCloseable {
    /** A transport over an OkHttp client the SDK builds itself; [close] shuts that client down. */
    public constructor() : this(OkHttpClient(), true)

    /** A transport over the host's [client], which it shares: [close] leaves the host's client alone. */
    public constructor(client: OkHttpClient) : this(client, false)

    private val base: OkHttpClient = client.newBuilder().followRedirects(false).followSslRedirects(false).build()

    /**
     * Cancel in-flight calls and shut OkHttp's dispatcher and connection pool down (SP-51), so a JVM
     * `main` exits. Only when the SDK built the client itself: a host-supplied client shares its
     * dispatcher and pool with the host's other calls, so closing here would break them (close it
     * yourself if it is not otherwise needed).
     */
    override fun close() {
        if (!owned) return
        base.dispatcher.cancelAll()
        base.dispatcher.executorService.shutdown()
        base.connectionPool.evictAll()
    }

    override suspend fun send(request: PolarisRequest): PolarisResponse = withContext(Dispatchers.IO) { exchange(request) }

    private suspend fun exchange(request: PolarisRequest): PolarisResponse {
        val client = if (request.timeoutSeconds > 0) {
            base.newBuilder().callTimeout((request.timeoutSeconds * 1000).toLong(), TimeUnit.MILLISECONDS).build()
        } else {
            base
        }
        var url = request.url
        var method = request.method
        var body = request.body
        var headers = request.headers
        for (hop in 0..MAX_REDIRECTS) {
            val response = client.newCall(build(url, method, headers, body)).await()
            response.use { r ->
                val location = r.header("location")
                if (r.code in REDIRECTS && location != null && request.followRedirects) {
                    if (hop == MAX_REDIRECTS) {
                        throw PolarisException(ErrorCode.tooManyRedirects, "more than $MAX_REDIRECTS redirects")
                    }
                    val next = r.request.url.resolve(location)
                        ?: throw PolarisException(ErrorCode.insecureRedirect, "unusable redirect target")
                    if (r.request.url.isHttps && !next.isHttps) {
                        throw PolarisException(ErrorCode.insecureRedirect, "redirect from https to plain http")
                    }
                    // Never carry the bearer across a redirect, whatever the host.
                    headers = headers.filterKeys { !it.equals("authorization", ignoreCase = true) }
                    if (r.code == 303 || ((r.code == 301 || r.code == 302) && method == "POST")) {
                        method = "GET"
                        body = null
                    }
                    url = next.toString()
                    return@use
                }
                return PolarisResponse(
                    r.code, read(r, request.maxBodyBytes), r.headers.toMap(), r.headers.map { it.first to it.second },
                )
            }
        }
        throw PolarisException(ErrorCode.tooManyRedirects, "more than $MAX_REDIRECTS redirects")
    }

    private fun build(url: String, method: String, headers: Map<String, String>, body: ByteArray?): Request {
        val httpUrl = url.toHttpUrlOrNull() ?: throw PolarisException(ErrorCode.transport, "not an http(s) URL: $url")
        val builder = Request.Builder().url(httpUrl)
        for ((k, v) in headers) builder.header(k, v)
        val contentType = headers.entries.firstOrNull { it.key.equals("content-type", true) }?.value?.toMediaTypeOrNull()
        val requestBody = when {
            body != null -> body.toRequestBody(contentType)
            method == "POST" || method == "PUT" || method == "PATCH" -> ByteArray(0).toRequestBody(contentType)
            else -> null
        }
        return builder.method(method, requestBody).build()
    }

    private fun read(r: Response, limit: Int?): ByteArray {
        val source = r.body?.source() ?: return ByteArray(0)
        if (limit == null) return source.readByteArray()
        source.request(limit.toLong())
        val available = minOf(source.buffer.size, limit.toLong())
        return source.buffer.readByteArray(available)
    }

    private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
        cont.invokeOnCancellation { cancel() }
        enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                cont.resumeWithException(PolarisException(ErrorCode.networkError, e.message ?: "network error", cause = e))
            }

            override fun onResponse(call: Call, response: Response) {
                // A response that lands after the caller cancelled is closed, never leaked: its
                // connection goes back to the pool instead of holding a socket and a body open.
                cont.resume(response) { _, value, _ -> value.close() }
            }
        })
    }

    private companion object {
        const val MAX_REDIRECTS = 5
        val REDIRECTS = setOf(301, 302, 303, 307, 308)
    }
}
