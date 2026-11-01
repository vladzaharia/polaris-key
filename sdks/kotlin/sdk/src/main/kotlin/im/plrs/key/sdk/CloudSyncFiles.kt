// The Cloud Sync file transport (U-23.K5): the [FileTransport] of the transfer engine over bearer HTTP. It carries
// bytes to and from the product's own `/<p>/sync/files/…` routes (WIRE-CONTRACT-V5 section 13.2, 13.8) and nothing
// else. A port of Node's `cloudSync/files.ts`.
//
//   Paths      every URL is built from validated parts and then tested against a closed list of route shapes
//              ([isFilesPath]). The collection, the record id and the upload id use the sync key charset and may not
//              be `.` or `..`; a chunk id is 64 lowercase hex characters; a part number is 1 to [SYNC_MAX_PARTS].
//              A value that fails is a refusal to send, never a request.
//   Redirects  none are followed: a 3xx is a refusal, so the bearer and the file never leave the product's origin.
//   Bodies     a request that carries bytes also carries `Content-Digest: sha-256=:…:` of them. An answer is read
//              under a cap equal to what the call expects (a ranged `GET` the length asked for, a chunk `GET`
//              [SYNC_CHUNK_MAX_STORED_BYTES], an unranged `GET` the largest manifest, a JSON answer 1 MiB, an error
//              body 64 KiB); one byte more is no answer, so a hostile server cannot make the client hold more than
//              it asked for.
//   Retries    none here: the engine owns them. A request that gets no answer throws; an answer is a [FileReply],
//              with `Retry-After` read only as plain seconds (digits, at most nine, capped at an hour).
//
// The device bearer is read per request and never logged or put in an error. With no bearer, or one that belongs to
// another person than the session's, nothing is sent.

package im.plrs.key.sdk

import im.plrs.key.core.CoreContext
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.SYNC_CHUNK_ID_PATTERN
import im.plrs.key.core.SYNC_CHUNK_MAX_STORED_BYTES
import im.plrs.key.core.SYNC_KEY_PATTERN
import im.plrs.key.core.SYNC_MANIFEST_MAX_STORED_BYTES
import im.plrs.key.core.SYNC_MAX_PARTS
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.util.Base64

/** The most a JSON answer of a file route may be. */
public const val FILES_JSON_MAX_BYTES: Int = 1_048_576

/** The most an error body is read to. */
public const val FILES_ERROR_MAX_BYTES: Int = 65_536

/** The most an unranged file `GET` returns: a `chunks` file's manifest, sealed (it and the AEAD overhead). */
public const val FILES_MANIFEST_MAX_BYTES: Int = SYNC_MANIFEST_MAX_STORED_BYTES + 1024

/** A transfer slower than this is cut off: the deadline of a body grows by its size over this rate. */
public const val FILES_MIN_BYTES_PER_SECOND: Int = 65_536

private const val RETRY_AFTER_MAX_DIGITS = 9
private const val RETRY_AFTER_CAP_SECONDS = 3600.0
private const val STATUS_OK = 200
private const val STATUS_PARTIAL = 206
private const val FIRST_3XX = 300
private const val LAST_3XX = 399
private const val FIRST_ERROR = 400
private const val STATUS_BAD_REQUEST = 400
private const val STATUS_UNAUTHORIZED = 401
private const val STATUS_FORBIDDEN = 403
private const val STATUS_NOT_FOUND = 404
private const val STATUS_RATE_LIMITED = 429
private const val STATUS_SERVER_ERROR = 500
private const val STATUS_UNAVAILABLE = 503

/** A `?version=` is at most nine digits, so below this. */
private const val VERSION_LIMIT = 1_000_000_000
private const val HEX_RADIX = 16
private const val HEX_PAIR = 2

private val KEY = Regex(SYNC_KEY_PATTERN)
private val CHUNK_ID = Regex(SYNC_CHUNK_ID_PATTERN)
private val HEX64 = Regex("[0-9a-f]{64}")
private const val SEGMENT = "[A-Za-z0-9._:-]{1,128}"
private const val HEX64_PART = "[0-9a-f]{64}"

private fun isDotSegment(s: String) = s == "." || s == ".."

/** Whether [pathAndQuery] is one of the file routes of section 13.2 for [product]: dot segments are refused outright; the only query is `version=<digits>` on the file `GET`. */
public fun isFilesPath(product: String, pathAndQuery: String): Boolean {
    if (!KEY.matches(product) || isDotSegment(product)) return false
    val q = pathAndQuery.indexOf('?')
    val path = if (q < 0) pathAndQuery else pathAndQuery.substring(0, q)
    val query = if (q < 0) "" else pathAndQuery.substring(q + 1)
    if (path.split('/').any(::isDotSegment)) return false
    val base = "/" + Regex.escape(product) + "/sync/files/$SEGMENT"
    val rec = "$base/$SEGMENT"
    val upload = "$rec/upload/$SEGMENT"
    val shapes =
        listOf(
            "$rec/(?:begin|finalize|revisions)",
            rec,
            upload,
            "$upload/parts/[1-9][0-9]{0,3}",
            "$upload/chunks",
            "$upload/chunks/$HEX64_PART",
            "$base/chunks/$HEX64_PART",
        )
    if (shapes.none { Regex("^$it$").matches(path) }) return false
    if (query.isEmpty()) return true
    return Regex("^$rec$").matches(path) && Regex("^version=[0-9]{1,9}$").matches(query)
}

/** `Retry-After` as seconds: plain digits only (an HTTP date is ignored), at most nine of them, capped at an hour. */
internal fun parseRetryAfter(header: String?): Double? {
    val t = header?.trim() ?: return null
    if (t.isEmpty() || t.length > RETRY_AFTER_MAX_DIGITS || !t.all { it in '0'..'9' }) return null
    return minOf(t.toDouble(), RETRY_AFTER_CAP_SECONDS)
}

private fun statusCode(status: Int): String = when {
    status == STATUS_UNAUTHORIZED -> ErrorCode.unauthorized
    status == STATUS_FORBIDDEN -> ErrorCode.forbidden
    status == STATUS_NOT_FOUND -> ErrorCode.notFound
    status == STATUS_RATE_LIMITED -> ErrorCode.rateLimited
    status == STATUS_BAD_REQUEST -> ErrorCode.badRequest
    status == STATUS_UNAVAILABLE -> ErrorCode.unavailable
    status >= STATUS_SERVER_ERROR -> ErrorCode.serverError
    else -> ErrorCode.badResponse
}

/**
 * The file routes of section 13.2 as a [FileTransport]. [bound] is the person the session belongs to (the host's
 * subject): a request whose bearer is another person's is not sent.
 */
public class HttpFileTransport(private val core: CoreContext, private val bound: () -> String? = { null }) : FileTransport {
    private class Sent(
        val json: JsonObject? = null,
        val body: ByteArray? = null,
        val sha256: String? = null,
        val range: Pair<Int, Int>? = null,
        val ifMatch: String? = null,
    )

    private fun refusedToSend(what: String): Nothing = throw TransferException(Reason.REJECTED, code = "bad_path", detail = what)

    // -- Paths -----------------------------------------------------------------------------------------------

    private fun seg(value: String, what: String): String {
        if (!KEY.matches(value) || isDotSegment(value)) refusedToSend(what)
        return value
    }

    private fun base(collection: String) = "/${core.product}/sync/files/${seg(collection, "collection")}"

    private fun record(t: FileTarget) = "${base(t.collection)}/${seg(t.record, "record")}"

    private fun upload(t: FileTarget, uploadId: String) = "${record(t)}/upload/${seg(uploadId, "uploadId")}"

    private fun chunkId(id: String): String {
        if (!CHUNK_ID.matches(id)) refusedToSend("chunkId")
        return id
    }

    // -- The exchange ----------------------------------------------------------------------------------------

    private fun refusal(status: Int, code: String, body: JsonElement? = null, retry: Double? = null): FileReply.Refused =
        FileReply.Refused(FileRefusal(status, code, retry, body))

    /** One request. A refusal comes back as a value; a request that gets no answer throws, and the engine retries it. */
    private suspend fun exchange(method: String, path: String, sent: Sent = Sent(), cap: Int = FILES_JSON_MAX_BYTES): Pair<Int, PolarisResponseView> {
        if (!isFilesPath(core.product, path)) refusedToSend("route")
        val token = core.token()
        if (token.isNullOrEmpty()) return STATUS_UNAUTHORIZED to PolarisResponseView(ByteArray(0), emptyMap())
        val expected = bound()
        val now = core.storedSubject()
        if (expected != null && now != null && now != expected) return STATUS_UNAUTHORIZED to PolarisResponseView(ByteArray(0), emptyMap())
        val headers = linkedMapOf("authorization" to "Bearer $token", "accept" to "application/octet-stream, application/json")
        var body: ByteArray? = null
        if (sent.json != null) {
            headers["content-type"] = "application/json"
            body = sent.json.toString().toByteArray(Charsets.UTF_8)
        } else if (sent.body != null) {
            val sha = sent.sha256
            if (sha == null || !HEX64.matches(sha)) refusedToSend("digest")
            headers["content-type"] = "application/octet-stream"
            headers["content-digest"] =
                "sha-256=:" + Base64.getEncoder().encodeToString(sha!!.chunked(HEX_PAIR).map { it.toInt(HEX_RADIX).toByte() }.toByteArray()) + ":"
            body = sent.body
        }
        sent.range?.let { headers["range"] = "bytes=${it.first}-${it.second - 1}" }
        sent.ifMatch?.let { headers["if-match"] = it }
        val moved = maxOf(cap, body?.size ?: 0)
        val timeout = core.requestTimeoutSeconds.let { if (it > 0) it + (moved / FILES_MIN_BYTES_PER_SECOND + 1) else 0.0 }
        val wire = PolarisRequest(
            url = core.endpoints.baseUrl + path,
            method = method,
            headers = core.headers(headers),
            body = body,
            timeoutSeconds = timeout,
            // An error body is read to its own cap, whatever the success body is bounded to (a ranged GET asks for few bytes).
            maxBodyBytes = maxOf(cap, FILES_ERROR_MAX_BYTES) + 1,
            followRedirects = false,
        )
        val res = core.transport.send(wire)
        if (res.status in FIRST_3XX..LAST_3XX) return res.status to PolarisResponseView(ByteArray(0), emptyMap(), redirect = true)
        return res.status to PolarisResponseView(res.body, res.headers.mapKeys { it.key.lowercase() })
    }

    private class PolarisResponseView(val body: ByteArray, val headers: Map<String, String>, val redirect: Boolean = false)

    /** The refusal an error answer is: the server's code, `Retry-After` and the body's extra members. */
    private fun errorRefusal(status: Int, v: PolarisResponseView): FileReply.Refused {
        if (v.redirect) return refusal(status, "redirect_refused")
        val text = if (v.body.size > FILES_ERROR_MAX_BYTES) null else String(v.body, Charsets.UTF_8)
        val parsed = text?.let { JsonText.parseOrNull(it) } as? JsonObject
        val err = parsed?.get("error").objectValue
        val code = err?.get("code").stringValue ?: statusCode(status)
        val extras = LinkedHashMap<String, JsonElement>()
        parsed?.forEach { (k, x) -> if (k != "error") extras[k] = x }
        err?.forEach { (k, x) -> if (k != "code" && k != "message") extras[k] = x }
        return refusal(status, code, JsonObject(extras), parseRetryAfter(v.headers["retry-after"]))
    }

    private fun isError(status: Int, v: PolarisResponseView) = v.redirect || status >= FIRST_ERROR || status < STATUS_OK

    /** A route whose success carries no body. */
    private suspend fun empty(method: String, path: String, sent: Sent = Sent()): FileReply<Unit> {
        val (status, v) = exchange(method, path, sent)
        if (isError(status, v)) return errorRefusal(status, v)
        return FileReply.Ok(Unit)
    }

    /** A route whose success is a JSON object under the cap that [accept] likes. */
    private suspend fun json(method: String, path: String, sent: Sent = Sent(), accept: (JsonObject) -> Boolean = { true }): FileReply<JsonObject> {
        val (status, v) = exchange(method, path, sent)
        if (isError(status, v)) return errorRefusal(status, v)
        val parsed = if (v.body.isEmpty() || v.body.size > FILES_JSON_MAX_BYTES) null else JsonText.parseOrNull(String(v.body, Charsets.UTF_8))
        val o = parsed as? JsonObject
        return if (o == null || !accept(o)) refusal(status, ErrorCode.badResponse) else FileReply.Ok(o)
    }

    private fun JsonObject.isInt(k: String) =
        (get(k) as? kotlinx.serialization.json.JsonPrimitive)?.let { !it.isString && it.content.toLongOrNull() != null } == true

    // -- FileTransport ---------------------------------------------------------------------------------------

    override suspend fun begin(target: FileTarget, request: JsonObject): FileReply<JsonObject> =
        json("POST", "${record(target)}/begin", Sent(json = request)) { v ->
            val id = v["uploadId"].stringValue
            val mode = v["mode"].stringValue
            id != null && KEY.matches(id) && !isDotSegment(id) && (mode == "single" || mode == "multipart" || mode == "chunks") &&
                (v["expiresAt"] as? kotlinx.serialization.json.JsonPrimitive)?.let { !it.isString && it.content.toDoubleOrNull() != null } == true
        }

    override suspend fun status(target: FileTarget, uploadId: String): FileReply<JsonObject> =
        json("GET", upload(target, uploadId)) { it["mode"].stringValue != null }

    override suspend fun putSingle(target: FileTarget, uploadId: String, body: ByteArray, sha256: String): FileReply<Unit> =
        empty("PUT", upload(target, uploadId), Sent(body = body, sha256 = sha256))

    override suspend fun putPart(target: FileTarget, uploadId: String, n: Int, body: ByteArray, sha256: String): FileReply<Unit> {
        if (n < 1 || n > SYNC_MAX_PARTS) refusedToSend("part")
        return empty("PUT", "${upload(target, uploadId)}/parts/$n", Sent(body = body, sha256 = sha256))
    }

    override suspend fun abort(target: FileTarget, uploadId: String): FileReply<Unit> = empty("DELETE", upload(target, uploadId))

    override suspend fun finalize(target: FileTarget, request: JsonObject): FileReply<JsonObject> =
        json("POST", "${record(target)}/finalize", Sent(json = request)) { v ->
            val format = v["format"].stringValue
            v.isInt("version") && v.isInt("size") && v["sha256"].stringValue != null && (format == "whole" || format == "chunks")
        }

    override suspend fun planChunks(target: FileTarget, uploadId: String, request: JsonObject): FileReply<JsonObject> =
        json("POST", "${upload(target, uploadId)}/chunks", Sent(json = request))

    override suspend fun putChunk(target: FileTarget, uploadId: String, chunkId: String, body: ByteArray, sha256: String): FileReply<Unit> {
        if (body.size > SYNC_CHUNK_MAX_STORED_BYTES) refusedToSend("chunk")
        return empty("PUT", "${upload(target, uploadId)}/chunks/${chunkId(chunkId)}", Sent(body = body, sha256 = sha256))
    }

    override suspend fun getFile(target: FileTarget, query: FileQuery): FileReply<FileBody> {
        val range = query.range
        if (range != null && !(range.first >= 0 && range.second > range.first)) refusedToSend("range")
        val version = query.version
        if (version != null && (version < 0 || version >= VERSION_LIMIT)) refusedToSend("version")
        val path = record(target) + (version?.let { "?version=$it" } ?: "")
        // The body is bounded by the range asked, even for a 200: a server that ignores `Range` and sends more is refused.
        val cap = if (range != null) range.second - range.first else FILES_MANIFEST_MAX_BYTES
        val (status, v) = exchange("GET", path, Sent(range = range, ifMatch = query.ifMatch), cap)
        if (isError(status, v)) return errorRefusal(status, v)
        if ((status != STATUS_OK && status != STATUS_PARTIAL) || v.body.size > cap) return refusal(status, ErrorCode.badResponse)
        val m = Regex("^bytes ([0-9]{1,15})-([0-9]{1,15})/([0-9]{1,15})$").matchEntire(v.headers["content-range"] ?: "")
        val cr = m?.let {
            val (a, b, c) = it.destructured
            val start = a.toLongOrNull()
            val end = b.toLongOrNull()
            val total = c.toLongOrNull()
            if (start != null && end != null && total != null && end < Int.MAX_VALUE &&
                total <= Int.MAX_VALUE
            ) {
                ContentRange(start.toInt(), (end + 1).toInt(), total.toInt())
            } else {
                null
            }
        }
        return FileReply.Ok(FileBody(status, v.body, v.headers["etag"], cr))
    }

    override suspend fun revisions(target: FileTarget): FileReply<JsonObject> =
        json("GET", "${record(target)}/revisions") { it["revisions"] is kotlinx.serialization.json.JsonArray }

    override suspend fun getChunk(collection: String, chunkId: String): FileReply<ByteArray> {
        val (status, v) = exchange("GET", "${base(collection)}/chunks/${chunkId(chunkId)}", cap = SYNC_CHUNK_MAX_STORED_BYTES)
        if (isError(status, v)) return errorRefusal(status, v)
        if (status != STATUS_OK || v.body.size > SYNC_CHUNK_MAX_STORED_BYTES) return refusal(status, ErrorCode.badResponse)
        return FileReply.Ok(v.body)
    }
}
