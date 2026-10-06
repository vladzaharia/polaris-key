// A minimal verified-download transport for the JVM desktop install driver (UK-40, SP-K12). The
// proposed `release.fetch` feature (PARITY §5.5, ⊕) is the SP-K13 task and has no registry id yet;
// until it lands, this is the Kotlin fetch, ported from Godot's `PKeyDownload` (core/download.gd),
// the one SDK that implements it, and it keeps every one of its rules:
//
//   - bytes go to the caller's `.part` file; a `.part` already there is resumed with
//     `Range: bytes=<size>-` (a 206 whose Content-Range starts there appends, a 200 starts over, a
//     416 starts over once);
//   - `Accept-Encoding: identity`, because gzip breaks `Range`;
//   - redirects are followed HERE: the bearer goes only to the control plane's own origin, is dropped
//     as soon as the origin changes and never comes back, and a redirect to plain http on a
//     non-loopback host is refused;
//   - a body longer than the expected size is refused and the `.part` removed;
//   - a local-only client refuses before dialling.
//
// The answer is never trusted: the caller verifies size and SHA-256 against the signed release
// record before the file is used (plans/P3-01.md §2.5 step 19). SP-K13 moves this behind
// `release.fetch` (with the record check inside) and the driver keeps this port.

package im.plrs.key.update

import im.plrs.key.core.CoreContext
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.core.sameOrigin
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

/** Downloads one artifact into a `.part` file, resuming what is there; never verifies (the caller does). */
public fun interface ArtifactFetch {
    /**
     * Fetch [url] into [part] until it holds [expectedSize] bytes. [progress] gets (received, total).
     * Throws [PolarisException] (`local-only`, `insecure-redirect`, `too-many-redirects`,
     * `http-error`, `response-too-large`, `network-error`).
     */
    public suspend fun fetch(url: String, part: File, expectedSize: Long, progress: ((Long, Long) -> Unit)?)
}

/** [ArtifactFetch] over OkHttp with Core's headers (see the file comment). */
public class OkHttpArtifactFetch(private val core: CoreContext, client: OkHttpClient) : ArtifactFetch {
    /** Over a default client (a 60-second read timeout); callers need not see OkHttp. */
    public constructor(core: CoreContext) : this(core, OkHttpClient.Builder().readTimeout(60, TimeUnit.SECONDS).build())

    private val http: OkHttpClient = client.newBuilder().followRedirects(false).followSslRedirects(false).build()

    override suspend fun fetch(url: String, part: File, expectedSize: Long, progress: ((Long, Long) -> Unit)?) {
        if (core.localOnly) throw PolarisException(ErrorCode.localOnly, "This client is local-only; network calls are refused.")
        if (expectedSize < 0) throw PolarisException(ErrorCode.invalidOptions, "A download needs the record's expected size.")
        val origin = url.toHttpUrlOrNull() ?: throw PolarisException(ErrorCode.transport, "not an http(s) URL: $url")
        val base = LinkedHashMap(core.headers())
        base["accept-encoding"] = "identity"
        core.token()?.let { if (sameOrigin(url, core.endpoints.baseUrl)) base["authorization"] = "Bearer $it" }
        withContext(Dispatchers.IO) {
            part.parentFile?.mkdirs()
            var restarted = false
            while (true) {
                var have = if (part.isFile) part.length() else 0L
                if (have > expectedSize) {
                    part.delete()
                    have = 0
                }
                if (have == expectedSize && expectedSize > 0) return@withContext
                when (val outcome = attempt(origin, base, part, have, expectedSize, progress)) {
                    Attempt.Done -> return@withContext
                    Attempt.Restart -> {
                        if (restarted) throw PolarisException(ErrorCode.httpError, "the server refused the resumed range twice")
                        restarted = true
                        part.delete()
                    }
                }
                ensureActive()
            }
        }
    }

    private enum class Attempt { Done, Restart }

    private fun attempt(origin: HttpUrl, base: Map<String, String>, part: File, have: Long, expected: Long, progress: ((Long, Long) -> Unit)?): Attempt {
        var current = origin
        var headers: Map<String, String> = base
        for (hop in 0..MAX_REDIRECTS) {
            if (current.scheme != "https" && !isLoopback(current.host)) {
                throw PolarisException(ErrorCode.insecureRedirect, "Refusing plain http to ${current.host}.")
            }
            // The bearer goes to the starting origin only, and never comes back once dropped.
            if (!sameOriginUrl(current, origin)) headers = headers.filterKeys { !it.equals("authorization", ignoreCase = true) }
            val request = Request.Builder().url(current).apply {
                for ((k, v) in headers) header(k, v)
                if (have > 0) header("range", "bytes=$have-")
            }.build()
            val response = try {
                http.newCall(request).execute()
            } catch (e: IOException) {
                throw PolarisException(ErrorCode.networkError, e.message ?: "network error", cause = e)
            }
            response.use { r ->
                val location = r.header("location")
                if (r.code in REDIRECTS && location != null) {
                    if (hop == MAX_REDIRECTS) throw PolarisException(ErrorCode.tooManyRedirects, "more than $MAX_REDIRECTS redirects")
                    current = r.request.url.resolve(location) ?: throw PolarisException(ErrorCode.insecureRedirect, "unusable redirect target")
                    return@use
                }
                val append = when {
                    r.code == 206 && have > 0 && r.header("content-range").orEmpty().startsWith("bytes $have-") -> true
                    r.code == 206 -> return Attempt.Restart
                    r.code == 200 -> false
                    r.code == 416 && have > 0 -> return Attempt.Restart
                    else -> throw PolarisException(ErrorCode.httpError, "the download answered ${r.code}")
                }
                val body = r.body ?: throw PolarisException(ErrorCode.invalidResponse, "the download has no body")
                var got = if (append) have else 0L
                try {
                    FileOutputStream(part, append).use { out ->
                        val buf = ByteArray(1 shl 16)
                        body.byteStream().use { input ->
                            while (true) {
                                val n = input.read(buf)
                                if (n < 0) break
                                got += n
                                if (got > expected) {
                                    out.close()
                                    part.delete()
                                    throw PolarisException(ErrorCode.responseTooLarge, "the download is longer than the record's $expected bytes")
                                }
                                out.write(buf, 0, n)
                                progress?.invoke(got, expected)
                            }
                        }
                    }
                } catch (e: IOException) {
                    // A broken connection keeps the `.part` for the next attempt.
                    throw PolarisException(ErrorCode.networkError, e.message ?: "the download was interrupted", cause = e)
                }
                return Attempt.Done
            }
        }
        throw PolarisException(ErrorCode.tooManyRedirects, "more than $MAX_REDIRECTS redirects")
    }

    private fun sameOriginUrl(a: HttpUrl, b: HttpUrl): Boolean = a.scheme == b.scheme && a.host == b.host && a.port == b.port

    private fun isLoopback(host: String): Boolean = host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"

    private companion object {
        const val MAX_REDIRECTS = 5
        val REDIRECTS = setOf(301, 302, 303, 307, 308)
    }
}
