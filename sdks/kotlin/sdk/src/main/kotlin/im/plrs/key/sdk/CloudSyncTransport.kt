// The Cloud Sync host's transport: one bearer HTTP exchange per request the machine queued (H-3, H-4).
//
// It sends only what the machine produced, only to the product's own `/sync` routes on the product origin
// (the base URL joins them, so the device bearer never goes anywhere else), with the SDK's `X-PKey-*`
// headers. It never follows a redirect, so the bearer cannot be handed to another origin; a 3xx is an
// answer the machine does not act on. The host adds no request of its own (S3). Any failure to get an
// answer is a transport error, which the machine reads as "nothing was processed" and retries on its
// next trigger. The body is read under a byte cap (read as cap+1, so an over-cap body is no answer), and
// the exchange has a 15 s deadline so purge and flush are bounded.

package im.plrs.key.sdk

import im.plrs.key.core.CoreContext
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.stringValue
import im.plrs.key.core.sync.SyncResponse
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonObject

/** The most decoded bytes of one answer. */
public const val SYNC_MAX_RESPONSE_BYTES: Int = 8 * 1024 * 1024

/** The deadline of one sync request, in seconds. */
public const val SYNC_REQUEST_TIMEOUT_SECONDS: Double = 15.0

public object CloudSyncTransport {
    private val query = Regex("[A-Za-z0-9_=&.%-]*")
    private const val FIRST_2XX = 200
    private const val LAST_2XX = 299

    /** Whether [path] is one of the machine's two routes for [product] (a pull or a push). */
    public fun isSyncPath(product: String, path: String): Boolean {
        val base = "/$product/sync"
        return path == "$base/ops" || (path.startsWith("$base?") && query.matches(path.substring(base.length + 1)))
    }

    /** The wire request for [req], or null when it is not a sync route or there is no token (nothing is sent). */
    private suspend fun prepared(core: CoreContext, req: JsonObject, bound: String?): PolarisRequest? {
        val token = core.token()
        // The subject is stored before the token (every sign-in path), so a token that is another person's means the
        // stored subject already is: re-read it after the token and refuse a request bound to someone else.
        if (bound != null) {
            val now = core.storedSubject()
            if (now != null && now != bound) return null
        }
        val path = req["path"].stringValue
        val method = req["method"].stringValue
        val sendable = !token.isNullOrEmpty() && path != null && method != null
        if (!sendable || !isSyncPath(core.product, path!!)) return null
        val headers = linkedMapOf("authorization" to "Bearer $token", "accept" to "application/json")
        val body = if (method == "POST") (req["body"]?.toString() ?: "null").toByteArray(Charsets.UTF_8) else null
        if (body != null) headers["content-type"] = "application/json"
        return PolarisRequest(
            url = core.endpoints.baseUrl + path,
            method = method!!,
            headers = core.headers(headers),
            body = body,
            timeoutSeconds = SYNC_REQUEST_TIMEOUT_SECONDS,
            maxBodyBytes = SYNC_MAX_RESPONSE_BYTES + 1,
            followRedirects = false,
        )
    }

    /** Send one machine request; the answer is a [SyncResponse], or [SyncResponse.TRANSPORT]. */
    public suspend fun send(core: CoreContext, req: JsonObject, bound: String? = null): SyncResponse {
        val wire = prepared(core, req, bound) ?: return SyncResponse.TRANSPORT
        // Any failure to get an answer is "nothing was processed"; no message is kept (it could name a URL).
        val res = runCatching { core.transport.send(wire) }
            .onFailure { if (it is CancellationException) throw it }
            .getOrNull()
        return if (res == null) SyncResponse.TRANSPORT else answer(res.status, res.body)
    }

    internal fun answer(status: Int, bytes: ByteArray): SyncResponse {
        val parsed = if (bytes.isEmpty() || bytes.size > SYNC_MAX_RESPONSE_BYTES) null else JsonText.parseOrNull(String(bytes, Charsets.UTF_8))
        return when {
            bytes.size > SYNC_MAX_RESPONSE_BYTES -> SyncResponse.TRANSPORT

            bytes.isEmpty() -> SyncResponse(status, null)

            parsed != null -> SyncResponse(status, parsed)

            // A 2xx the machine cannot read is not an answer; an error page keeps its status.
            status in FIRST_2XX..LAST_2XX -> SyncResponse.TRANSPORT

            else -> SyncResponse(status, null)
        }
    }
}
