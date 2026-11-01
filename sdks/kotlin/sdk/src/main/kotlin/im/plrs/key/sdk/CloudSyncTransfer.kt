// The Cloud Sync file transfer engine (U-23.K4; WIRE-CONTRACT-V5 §13.8): uploads in modes `single` and
// `multipart` ([FileTransferEngine.upload]) and `chunks` ([FileTransferEngine.uploadChunked]), and downloads of
// both formats ([FileTransferEngine.download]). A port of Python `cloud_sync/transfer.py` over coroutines. The
// engine owns the order of calls and the recovery rules, and nothing else. The ports keep it pure: a
// [FileTransport] (the routes of §13.8, typed; a host maps them to HTTP and never lets a server-chosen path
// through), a [JournalStore] (what survives a kill), a [RangedSource] (the bytes to send, read by range, so a
// part is read when it is sent and never held longer), a [FileCodec] (whether and how a collection seals its
// files and chunks) and a [ChunkCache] (the chunk objects a device already holds).
//
//     begin -> parts, at most 4 at once and in any order -> finalize
//
// resume        a journal record for the same transfer id, bytes and record is resumed: the server's `received`
//               list is the truth, so a part the journal calls done but the server lost is sent again. A record
//               past `expiresAt`, or one for other bytes, is dropped and the upload begins afresh.
// 408, 429, 5xx or no answer (the transport throws)
//               wait and retry. `Retry-After` is honoured and holds every request of the pass, not just the one
//               that was told; without it the wait doubles from 0.5 s to 30 s, with jitter.
// 410 / 404 inside an upload
//               the upload expired or is gone: forget it and begin again (a few times, then fail). On `begin`
//               and on a download they are a rejection.
// 409           [Reason.CONFLICT] (a stale `baseVersion` carries the server's version). Nothing is retried; at
//               finalize the upload is aborted.
// 400 upload_mismatch
//               [Reason.MISMATCH]; no retry can fix the bytes.
//
// A download checks, in order: the declared size and SHA-256 hex, then for each range its status and
// `Content-Range` against what was asked, the ETag held fixed with `If-Match`, the stored length and SHA-256
// after the last range, then the format's own checks (segment tags; for `chunks` the manifest size and hash, the
// manifest, its size against the record's, per chunk the stored cap, the object's own checks and its length,
// last `plainSize` and `plainSha256`). The sink receives plaintext that is only provisional until `download`
// returns: on a throw the host discards what it wrote. Anything the server could have altered is
// [Reason.FILE_INVALID], the client's `sync-file-invalid` ([TransferException.toPolarisException]).
//
// Cancelling the coroutine stops the transfer at its next step with the usual [CancellationException]; the
// journal keeps the progress. A transport is called from several coroutines and must be thread-safe.
//
// Nothing here puts a key, a plaintext byte or a bearer token in an exception or a log line.

package im.plrs.key.sdk

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.core.SYNC_CHUNK_MAX_STORED_BYTES
import im.plrs.key.core.SYNC_CHUNK_PLAN_MAX_IDS
import im.plrs.key.core.SYNC_FILE_MAX_BYTES
import im.plrs.key.core.SYNC_MAX_CHUNKS_PER_FILE
import im.plrs.key.core.SYNC_MAX_PARTS
import im.plrs.key.core.SYNC_PART_MAX_BYTES
import im.plrs.key.core.SYNC_SINGLE_PUT_MAX_BYTES
import im.plrs.key.core.SYNC_UPLOAD_PARALLELISM
import im.plrs.key.core.arrayValue
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.sync.SyncCdc
import im.plrs.key.core.sync.SyncFileStream
import im.plrs.key.core.sync.SyncManifest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.MessageDigest

/** §13.8.1: at most 4 parts in flight. */
public const val TRANSFER_MAX_PARALLEL_PARTS: Int = SYNC_UPLOAD_PARALLELISM

/** The longest range one request asks for. */
public const val DOWNLOAD_RANGE_BYTES: Int = 8 * 1024 * 1024

/** The most a manifest can be before sealing: 16,384 records and the header. */
private const val MANIFEST_PLAIN_MAX_BYTES: Long = SyncManifest.HEADER_BYTES.toLong() + SyncManifest.RECORD_BYTES.toLong() * SYNC_MAX_CHUNKS_PER_FILE

private const val HASH_SLICE = 1_048_576
private const val MS_PER_SECOND = 1000
private const val BACKOFF_BASE = 0.5
private const val BACKOFF_CAP = 30.0
private const val RETRYABLE_FROM = 500
private const val HTTP_REQUEST_TIMEOUT = 408
private const val HTTP_TOO_MANY = 429
private const val HTTP_CONFLICT = 409
private const val HTTP_FORBIDDEN = 403
private const val HTTP_GONE = 410
private const val HTTP_NOT_FOUND = 404
private const val HTTP_BAD_REQUEST = 400
private const val HTTP_PARTIAL = 206
private const val HTTP_OK = 200
private const val MAX_RESEND = 2

private fun sha256Hex(d: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(d).joinToString("") { "%02x".format(it) }

private fun hexOf(d: ByteArray): String = d.joinToString("") { "%02x".format(it) }

// -- Ports -----------------------------------------------------------------------------------------------------

/** The stored bytes of one file, read by half-open range. [size] is fixed for the life of the source. */
public interface RangedSource {
    public val size: Int

    public fun read(start: Int, end: Int): ByteArray
}

/** A source over bytes already in memory. */
public class BytesSource(data: ByteArray) : RangedSource {
    private val bytes = data.copyOf()
    override val size: Int get() = bytes.size

    override fun read(start: Int, end: Int): ByteArray = if (start in 0..end && end <= bytes.size) bytes.copyOfRange(start, end) else ByteArray(0)
}

/** Which file a call is about: [record] is the wire id (blinded in E2E mode). */
public class FileTarget(public val collection: String, public val record: String)

/**
 * A refusal is a value; a call that gets no answer at all (the network, a timeout) throws, and the engine
 * retries it. [code] is the server's `error.code`; [body] is the error body (`missing` on `upload_incomplete`,
 * `server.version` on `revision_conflict`).
 */
public class FileRefusal(
    public val status: Int,
    public val code: String,
    public val retryAfterSeconds: Double? = null,
    public val body: JsonElement? = null,
)

public sealed class FileReply<out T> {
    public class Ok<out T>(public val value: T) : FileReply<T>()

    public class Refused(public val refusal: FileRefusal) : FileReply<Nothing>()
}

public class FileQuery(
    public val version: Int? = null,
    /** Half-open byte range of the stored file, `[first, endExclusive)`. */
    public val range: Pair<Int, Int>? = null,
    /** An ETag from an earlier answer; a changed file is then 412. */
    public val ifMatch: String? = null,
)

/** A 206's `Content-Range`: bytes [start] up to [end] (exclusive) of [total]. */
public class ContentRange(public val start: Int, public val end: Int, public val total: Int)

/** A file answer, headers parsed. */
public class FileBody(
    public val status: Int,
    public val data: ByteArray,
    /** The `ETag`, verbatim. */
    public val etag: String? = null,
    public val contentRange: ContentRange? = null,
)

/**
 * The upload and download routes of §13.8 under `/<p>/sync/files/{collection}/{id}`. `sha256` is the lowercase
 * hex of the body; a host sends it as `Content-Digest`. Requests and answers are the JSON objects of the wire
 * (`protocol/sync.ts`). A host bounds [getFile] to the range it asked for and [getChunk] to
 * [SYNC_CHUNK_MAX_STORED_BYTES].
 */
public interface FileTransport {
    public suspend fun begin(target: FileTarget, request: JsonObject): FileReply<JsonObject>

    /** `GET …/upload/{uploadId}`. */
    public suspend fun status(target: FileTarget, uploadId: String): FileReply<JsonObject>

    /** `PUT …/upload/{uploadId}`: the whole body of a `single` upload, or the manifest of a `chunks` one. */
    public suspend fun putSingle(target: FileTarget, uploadId: String, body: ByteArray, sha256: String): FileReply<Unit>

    /** `PUT …/upload/{uploadId}/parts/{n}`, n from 1. */
    public suspend fun putPart(target: FileTarget, uploadId: String, n: Int, body: ByteArray, sha256: String): FileReply<Unit>

    /** `DELETE …/upload/{uploadId}`. */
    public suspend fun abort(target: FileTarget, uploadId: String): FileReply<Unit>

    /** `POST …/finalize`. */
    public suspend fun finalize(target: FileTarget, request: JsonObject): FileReply<JsonObject>

    /** `POST …/upload/{uploadId}/chunks`: at most [SYNC_CHUNK_PLAN_MAX_IDS] ids. */
    public suspend fun planChunks(target: FileTarget, uploadId: String, request: JsonObject): FileReply<JsonObject>

    /** `PUT …/upload/{uploadId}/chunks/{chunkId}`: one chunk object. */
    public suspend fun putChunk(target: FileTarget, uploadId: String, chunkId: String, body: ByteArray, sha256: String): FileReply<Unit>

    /** `GET …/{id}[?version=]`, with `Range` and `If-Match` when asked. */
    public suspend fun getFile(target: FileTarget, query: FileQuery): FileReply<FileBody>

    /** `GET /<p>/sync/files/{collection}/chunks/{chunkId}`: the object's bytes. */
    public suspend fun getChunk(collection: String, chunkId: String): FileReply<ByteArray>

    /** `GET …/{id}/revisions`: `{revisions: [{version, size, sha256, format, createdAt}]}`, newest first. */
    public suspend fun revisions(target: FileTarget): FileReply<JsonObject>
}

// -- Errors ----------------------------------------------------------------------------------------------------

/** Why a transfer failed. */
public enum class Reason(public val wire: String) {
    /** The source's size or hash is not what the caller declared. Nothing was sent. */
    SOURCE_MISMATCH("source-mismatch"),

    /** The journal record has a `v` this build does not know. It is left as found. */
    JOURNAL_VERSION("journal-version"),

    /** The journal record is malformed. It is left as found. */
    JOURNAL_MALFORMED("journal-malformed"),

    /** A 409: `revision_conflict` ([TransferException.serverVersion] set) or another. */
    CONFLICT("conflict"),

    /** `400 upload_mismatch`: the server holds other bytes than were declared. */
    MISMATCH("mismatch"),

    /** Any other refusal (401, 403, 413, 404 on begin, …): `status` and `code` say which. */
    REJECTED("rejected"),

    /** The server answered with a mode, part size, plan or range this engine cannot use. */
    BAD_REPLY("bad-reply"),

    /** Retries ran out; the journal keeps the progress for a later `upload`. */
    RETRIES_EXHAUSTED("retries-exhausted"),

    /** The upload kept expiring or vanishing. */
    RESTARTS_EXHAUSTED("restarts-exhausted"),

    /** A download failed a check the server could have caused; `detail` says which. */
    FILE_INVALID("file-invalid"),
}

public class TransferException(
    public val reason: Reason,
    public val status: Int? = null,
    public val code: String? = null,
    /** On a `revision_conflict`: the server's current version. */
    public val serverVersion: Int? = null,
    /** On [Reason.FILE_INVALID]: the first check that failed. */
    public val detail: String? = null,
    /** On a `quota_exceeded`: whose quota (`user`, `collection` or `product`). */
    public val scope: String? = null,
) : Exception(
    "file transfer: ${reason.wire}" + (code?.let { " ($it)" } ?: "") + (detail?.let { " [$it]" } ?: ""),
) {
    /** As the SDK's one error type: a failed check is `sync-file-invalid`. */
    public fun toPolarisException(): PolarisException = PolarisException(
        if (reason == Reason.FILE_INVALID) ErrorCode.syncFileInvalid else code ?: ErrorCode.syncFailed,
        message ?: "file transfer",
        detail,
        httpStatus = status,
    )
}

private fun invalid(detail: String) = TransferException(Reason.FILE_INVALID, detail = detail)

private class Restart : Exception()

// -- Requests --------------------------------------------------------------------------------------------------

public class UploadRequest(
    /** Stable per intended write; the journal key. A rerun with the same id resumes. */
    public val id: String,
    public val collection: String,
    /** The wire record id. */
    public val record: String,
    public val source: RangedSource,
    /** The stored size, `source.size`. */
    public val size: Int,
    /** Lowercase hex SHA-256 of the stored bytes. */
    public val sha256: String,
    public val enc: String,
    /** A version number, `"*"` or null. */
    public val baseVersion: JsonElement? = null,
    /** Stored bytes accepted so far and the stored size. */
    public val onProgress: ((Int, Int) -> Unit)? = null,
)

public class ChunkedUploadRequest(
    public val id: String,
    public val collection: String,
    public val record: String,
    /** The plaintext of the file. */
    public val source: RangedSource,
    public val codec: FileCodec,
    public val baseVersion: JsonElement? = null,
    /** Plaintext bytes accounted for so far (a chunk the server already holds counts at once) and the file's size. */
    public val onProgress: ((Int, Int) -> Unit)? = null,
)

public class DownloadRequest(
    public val collection: String,
    public val record: String,
    /** What the record's `file` says: `whole` or `chunks`. */
    public val format: String,
    /** The stored size and SHA-256 (lowercase hex) of that file: for `chunks`, the file's stored size and the stored manifest's hash. */
    public val size: Int,
    public val sha256: String,
    public val codec: FileCodec,
    /** Receives plaintext in order; provisional until `download` returns. */
    public val sink: suspend (ByteArray) -> Unit,
    /** The revision to read (`?version=`); null is the current one. */
    public val version: Int? = null,
    /** Used for `chunks`; the engine reads through it and fills it. */
    public val cache: ChunkCache? = null,
    /** Plaintext bytes written and the file's plaintext size. */
    public val onProgress: ((Int, Int) -> Unit)? = null,
)

// -- The engine ------------------------------------------------------------------------------------------------

/** A time before which no request is sent: a `Retry-After` holds every part, not just the one told. */
internal class Hold {
    private var until = 0.0

    @Synchronized fun value(): Double = until

    @Synchronized fun raise(t: Double) {
        until = maxOf(until, t)
    }
}

public class FileTransferEngine(
    internal val transport: FileTransport,
    internal val journal: JournalStore,
    private val now: () -> Double = { System.currentTimeMillis() / 1000.0 },
    private val sleeper: suspend (Double) -> Unit = { delay((it * 1000).toLong()) },
    private val random: () -> Double = { Math.random() },
    private val maxAttempts: Int = 8,
    private val maxRestarts: Int = 3,
    private val maxRetryAfterSeconds: Double = 900.0,
    parallelism: Int = TRANSFER_MAX_PARALLEL_PARTS,
) {
    internal val parallelism: Int = maxOf(1, minOf(parallelism, TRANSFER_MAX_PARALLEL_PARTS))

    /** Upload one file and finalize it. Returns the `finalize` answer; the journal record is gone by then. */
    public suspend fun upload(req: UploadRequest): JsonObject {
        if (req.source.size != req.size) throw TransferException(Reason.SOURCE_MISMATCH)
        verifySource(req)
        // Read before anything is sent: an unreadable record stops the transfer untouched.
        val resume = loadRecord(req)
        return restarting(req.id) { first -> UploadRun(this, req, if (first) resume else null).go() }
    }

    /**
     * Upload one file as a manifest over content-defined chunks and finalize it. `req.source` is the
     * plaintext. Returns the `finalize` answer; the journal record is gone by then.
     */
    public suspend fun uploadChunked(req: ChunkedUploadRequest): JsonObject {
        if (req.source.size > SYNC_FILE_MAX_BYTES) throw TransferException(Reason.REJECTED, code = "file_too_large")
        // Read before anything is sent: an unreadable record stops the transfer untouched. A record of an earlier
        // run only tells which server upload to release.
        releasePrior(req.id)
        val cut = cut(req)
        return restarting(req.id) { ChunkedRun(this, req, cut).go() }
    }

    /**
     * Fetch one file and write its plaintext to `req.sink`. Returns when every check has passed; a throw
     * ([Reason.FILE_INVALID] for anything the server could have altered) leaves the sink's contents unusable, and
     * the host discards them.
     */
    public suspend fun download(req: DownloadRequest) {
        DownloadRun(this, req).go()
    }

    /** Drop a transfer: abort the server's upload (best effort) and forget the record. */
    public suspend fun cancel(id: String) {
        val raw = journal.get(id) ?: return
        // A record this build cannot read stays for the build that wrote it.
        val rec = runCatching { parseJournalRecord(raw) }.getOrNull() ?: return
        abortQuietly(FileTarget(rec.collection, rec.record), rec.uploadId)
        journal.delete(id)
    }

    private suspend fun restarting(id: String, run: suspend (Boolean) -> JsonObject): JsonObject {
        var restarts = 0
        while (true) {
            try {
                return run(restarts == 0)
            } catch (e: Restart) {
                if (restarts >= maxRestarts) throw TransferException(Reason.RESTARTS_EXHAUSTED, status = HTTP_GONE)
                journal.delete(id)
                restarts++
            }
        }
    }

    internal suspend fun abortQuietly(target: FileTarget, uploadId: String) {
        try {
            transport.abort(target, uploadId) // the server expires it within the day
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Best effort.
        }
    }

    private fun readRecord(id: String): JournalRecord? {
        val raw = journal.get(id) ?: return null
        return try {
            parseJournalRecord(raw)
        } catch (e: TransferJournalException) {
            throw TransferException(if (e.version) Reason.JOURNAL_VERSION else Reason.JOURNAL_MALFORMED)
        }
    }

    private suspend fun releasePrior(id: String) {
        val rec = readRecord(id) ?: return
        abortQuietly(FileTarget(rec.collection, rec.record), rec.uploadId)
        journal.delete(id)
    }

    /** The matching journal record, or null (and the stale one dropped). A record that cannot be read is an error and stays. */
    private suspend fun loadRecord(req: UploadRequest): JournalRecord? {
        val rec = readRecord(req.id) ?: return null
        val same = rec.collection == req.collection && rec.record == req.record && rec.sha256 == req.sha256 && rec.size == req.size
        // `expiresAt` is epoch MILLISECONDS (V5 §13); `now` is seconds.
        if (same && rec.expiresAt > now() * MS_PER_SECOND) return rec
        if (!same) abortQuietly(FileTarget(rec.collection, rec.record), rec.uploadId)
        journal.delete(req.id)
        return null
    }

    private fun verifySource(req: UploadRequest) {
        val h = MessageDigest.getInstance("SHA-256")
        var at = 0
        while (at < req.size) {
            val end = minOf(req.size, at + HASH_SLICE)
            val piece = req.source.read(at, end)
            if (piece.size != end - at) throw TransferException(Reason.SOURCE_MISMATCH)
            h.update(piece)
            at = end
        }
        if (hexOf(h.digest()) != req.sha256) throw TransferException(Reason.SOURCE_MISMATCH)
    }

    /** Pass one over the plaintext: cut it, name the chunks, hash it, and write the manifest. */
    private suspend fun cut(req: ChunkedUploadRequest): Cut {
        val source = req.source
        val chunker = SyncCdc.Chunker()
        val whole = MessageDigest.getInstance("SHA-256")
        val records = ArrayList<SyncManifest.Record>()
        val offsets = ArrayList<Int>()
        var at = 0

        fun take(chunks: List<ByteArray>) {
            for (c in chunks) {
                if (records.size >= SYNC_MAX_CHUNKS_PER_FILE) throw TransferException(Reason.REJECTED, code = "file_too_large")
                records.add(SyncManifest.Record(req.codec.chunkId(c), c.size))
                offsets.add(at)
                at += c.size
            }
        }
        var from = 0
        while (from < source.size) {
            currentCoroutineContext().ensureActive()
            val end = minOf(source.size, from + HASH_SLICE)
            val piece = source.read(from, end)
            if (piece.size != end - from) throw TransferException(Reason.SOURCE_MISMATCH)
            whole.update(piece)
            take(chunker.push(piece))
            from = end
        }
        take(chunker.finish())
        val manifest = SyncManifest.encode(SyncManifest.Manifest(source.size.toLong(), whole.digest(), records))
        return Cut(records, offsets, manifest, source.size)
    }

    /** One request with the recovery rules: a refusal is returned, a retryable failure is waited out. */
    internal suspend fun <T> call(hold: Hold, op: suspend () -> FileReply<T>): FileReply<T> {
        var attempt = 0
        while (true) {
            currentCoroutineContext().ensureActive()
            val wait = hold.value() - now()
            if (wait > 0) sleeper(wait)
            val reply: FileReply<T>? = try {
                op()
            } catch (e: CancellationException) {
                throw e
            } catch (e: TransferException) {
                throw e
            } catch (e: Exception) {
                null // no answer: the network, a timeout
            }
            if (reply is FileReply.Ok) return reply
            val refusal = (reply as FileReply.Refused?)?.refusal
            val status = refusal?.status ?: 0
            val retryable = refusal == null || status == HTTP_REQUEST_TIMEOUT || status == HTTP_TOO_MANY || status >= RETRYABLE_FROM
            if (!retryable) return reply!!
            if (attempt + 1 >= maxAttempts) {
                throw TransferException(Reason.RETRIES_EXHAUSTED, status = refusal?.status, code = refusal?.code)
            }
            val told = refusal?.retryAfterSeconds
            val delay = if (told != null && told >= 0) {
                minOf(told, maxRetryAfterSeconds)
            } else {
                minOf(BACKOFF_CAP, BACKOFF_BASE * Math.pow(2.0, attempt.toDouble())) * (0.5 + random() / 2)
            }
            hold.raise(now() + delay)
            attempt++
        }
    }
}

private class Cut(
    val records: List<SyncManifest.Record>,
    /** Where each record starts in the plaintext. */
    val offsets: List<Int>,
    /** The plain `pkey-sync-chunks/1` manifest. */
    val manifest: ByteArray,
    val plainSize: Int,
)

/** A refusal that no retry mends, as the error it is. A 410 or 404 starts the upload over. */
private fun refuseUpload(r: FileRefusal): Exception {
    if (r.status == HTTP_GONE || r.status == HTTP_NOT_FOUND) return Restart()
    if (r.status == HTTP_CONFLICT) {
        val v = r.body.objectValue?.get("server").objectValue?.get("version").longValue?.toInt()
        return TransferException(Reason.CONFLICT, HTTP_CONFLICT, r.code, serverVersion = v)
    }
    if (r.status == HTTP_BAD_REQUEST && r.code == "upload_mismatch") return TransferException(Reason.MISMATCH, HTTP_BAD_REQUEST, r.code)
    return TransferException(Reason.REJECTED, r.status, r.code, scope = r.body.objectValue?.get("scope").stringValue)
}

private fun <T> FileReply<T>.orRefuse(): T = when (this) {
    is FileReply.Ok -> value
    is FileReply.Refused -> throw refuseUpload(refusal)
}

/** Run [items] with at most [width] in flight; the first failure cancels the rest and is thrown once they settle. */
private suspend fun <T> pool(items: List<T>, width: Int, fn: suspend (T) -> Unit) = coroutineScope {
    val gate = Semaphore(width)
    for (item in items) {
        gate.acquire()
        launch {
            try {
                fn(item)
            } finally {
                gate.release()
            }
        }
    }
}

// -- Upload passes ---------------------------------------------------------------------------------------------

/** A pass that journals: the record, kept in step with what the server holds. */
private open class UploadPass(val engine: FileTransferEngine, collection: String, record: String) {
    val target = FileTarget(collection, record)
    val hold = Hold()
    private val lock = Any()
    private val progressLock = Any()
    private lateinit var rec: JournalRecord

    val record: JournalRecord get() = synchronized(lock) { rec }
    val uploadId: String get() = record.uploadId

    fun adopt(r: JournalRecord) = synchronized(lock) { rec = r }

    /** Persist a change to the record. Changes are applied and written under one lock, so a late write never overtakes an early one. */
    fun update(change: (JournalRecord) -> JournalRecord) = synchronized(lock) {
        rec = change(rec)
        engine.journal.put(rec.id, rec)
    }

    fun addDone(n: Int) = update { it.copy(done = (it.done + n).distinct().sorted()) }

    fun progress(body: () -> Unit) = synchronized(progressLock) { body() }

    suspend fun <T> send(op: suspend () -> FileReply<T>): FileReply<T> = engine.call(hold, op)

    suspend fun discard() {
        engine.abortQuietly(target, uploadId)
        engine.journal.delete(record.id)
    }

    class Begun(val uploadId: String, val mode: String, val expiresAt: Double, val raw: JsonObject)

    /** `begin`; a refusal is thrown (a 410 or 404 here is not a stale upload, so it surfaces). */
    suspend fun beginCall(request: JsonObject): Begun {
        val reply = send { engine.transport.begin(target, request) }
        if (reply is FileReply.Refused) {
            val r = reply.refusal
            if (r.status == HTTP_GONE || r.status == HTTP_NOT_FOUND) throw TransferException(Reason.REJECTED, r.status, r.code)
            throw refuseUpload(r)
        }
        val o = (reply as FileReply.Ok).value
        val expires = (o["expiresAt"] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toDoubleOrNull()
        val id = o["uploadId"].stringValue?.takeIf { it.isNotEmpty() }
        val mode = o["mode"].stringValue
        if (id == null || mode == null || expires == null) throw TransferException(Reason.BAD_REPLY)
        return Begun(id, mode, expires, o)
    }

    fun begun(id: String, b: Begun, partBytes: Int?, sha256: String, size: Int) {
        adopt(JournalRecord(id, target.collection, target.record, b.uploadId, b.mode, partBytes, emptyList(), sha256, size, b.expiresAt, "uploading"))
        update { it }
    }

    /**
     * `finalize`. On `409 upload_incomplete` (at most twice) [resend] gets the `missing` list and sends those again,
     * answering false when the list is not one this upload could have; a 409 or a mismatch otherwise releases the upload.
     */
    suspend fun finalizeCall(resend: suspend (JsonElement?) -> Boolean): JsonObject {
        var again = 0
        while (true) {
            val reply = send { engine.transport.finalize(target, buildJsonObject { put("uploadId", uploadId) }) }
            if (reply is FileReply.Ok) {
                engine.journal.delete(record.id)
                return reply.value
            }
            val r = (reply as FileReply.Refused).refusal
            if (r.status == HTTP_CONFLICT && r.code == "upload_incomplete" && again < MAX_RESEND && resend(r.body.objectValue?.get("missing"))) {
                again++
                continue
            }
            if (r.status == HTTP_CONFLICT || r.status == HTTP_FORBIDDEN || (r.status == HTTP_BAD_REQUEST && r.code == "upload_mismatch")) discard()
            throw refuseUpload(r)
        }
    }
}

/** One pass at one `single` or `multipart` upload: begin or resume, send what is missing, finalize. */
private class UploadRun(engine: FileTransferEngine, val req: UploadRequest, val resume: JournalRecord?) :
    UploadPass(engine, req.collection, req.record) {
    suspend fun go(): JsonObject {
        if (resume != null) {
            adopt(resume)
            if (resume.state == "uploading") reconcile()
        } else {
            begin()
        }
        if (record.state == "uploading") {
            sendMissing()
            update { it.copy(state = "finalizing") }
        }
        return finalizeCall { missing ->
            val parts = partCount()
            val list = missing.arrayValue
            val lost = list?.map { it.longValue }
            if (list == null || lost!!.any { it == null || it < 1 || it > parts }) {
                false
            } else {
                update { it.copy(state = "uploading", done = it.done.filter { n -> n.toLong() !in lost }) }
                sendMissing()
                update { it.copy(state = "finalizing") }
                true
            }
        }
    }

    private fun partCount(): Int {
        val r = record
        return if (r.mode == "multipart" && r.partBytes != null) (r.size + r.partBytes - 1) / r.partBytes else 1
    }

    private suspend fun begin() {
        val request = buildJsonObject {
            put("size", req.size)
            put("sha256", req.sha256)
            put("format", "whole")
            put("enc", req.enc)
            req.baseVersion?.takeIf { it !is JsonNull }?.let { put("baseVersion", it) }
        }
        val b = beginCall(request)
        var partBytes: Int? = null
        if (b.mode == "multipart") {
            val pb = b.raw["partBytes"].longValue
            val ok = pb != null && pb in 1..SYNC_PART_MAX_BYTES && (req.size + pb - 1) / pb <= SYNC_MAX_PARTS
            if (!ok) {
                engine.abortQuietly(target, b.uploadId)
                throw TransferException(Reason.BAD_REPLY)
            }
            partBytes = pb!!.toInt()
        } else if (b.mode != "single" || req.size > SYNC_SINGLE_PUT_MAX_BYTES) {
            // `chunks` is the other upload; a file this big is never one PUT.
            engine.abortQuietly(target, b.uploadId)
            throw TransferException(Reason.BAD_REPLY)
        }
        begun(req.id, b, partBytes, req.sha256, req.size)
    }

    /** The server's list of received parts replaces the journal's `done`. */
    private suspend fun reconcile() {
        val id = uploadId
        val v = send { engine.transport.status(target, id) }.orRefuse()
        if (record.mode != "multipart") return
        val parts = partCount()
        val got = v["received"].arrayValue.orEmpty().mapNotNull { it.longValue?.toInt() }.filter { it in 1..parts }.distinct().sorted()
        update { it.copy(done = got) }
    }

    private fun partRange(r: JournalRecord, n: Int): IntRange? {
        val pb = r.partBytes
        if (pb == null || n < 1 || n > partCount()) return null
        val start = (n - 1) * pb
        return start until minOf(r.size, start + pb)
    }

    private fun reportProgress() {
        val r = record
        val sent = if (r.mode == "single") {
            if (r.done.isEmpty()) 0 else r.size
        } else {
            r.done.sumOf { n -> partRange(r, n)?.let { it.last - it.first + 1 } ?: 0 }
        }
        req.onProgress?.let { cb -> progress { cb(sent, r.size) } }
    }

    private suspend fun sendMissing() {
        val done = record.done.toSet()
        pool((1..partCount()).filter { it !in done }, engine.parallelism) { n -> sendPart(n) }
    }

    private suspend fun sendPart(n: Int) {
        val r = record
        val (start, end) = if (r.mode == "single") 0 to r.size else partRange(r, n)!!.let { it.first to it.last + 1 }
        val body = req.source.read(start, end)
        if (body.size != end - start) throw TransferException(Reason.SOURCE_MISMATCH)
        val digest = sha256Hex(body)
        val id = r.uploadId
        if (r.mode == "single") {
            send { engine.transport.putSingle(target, id, body, digest) }.orRefuse()
        } else {
            send { engine.transport.putPart(target, id, n, body, digest) }.orRefuse()
        }
        addDone(n)
        reportProgress()
    }
}

/** One pass at one `chunks` upload: begin, plan, send the missing chunks, the manifest, finalize. */
private class ChunkedRun(engine: FileTransferEngine, val req: ChunkedUploadRequest, val cut: Cut) :
    UploadPass(engine, req.collection, req.record) {
    private var stored = ByteArray(0)
    private var storedSha = ""

    /** hex id -> the first record that has it, and the ids in file order. */
    private val unique = LinkedHashMap<String, Int>()
    private var accounted = 0

    init {
        cut.records.forEachIndexed { i, r -> unique.putIfAbsent(hexOf(r.id), i) }
    }

    suspend fun go(): JsonObject {
        begin()
        account(0)
        val missing = plan()
        pool(missing, engine.parallelism) { id -> sendChunk(id) }
        sendManifest()
        return finalizeCall { lost ->
            val ids = lost.arrayValue?.map { it.stringValue }
            if (ids == null || ids.any { it == null || it !in unique }) {
                false
            } else {
                pool(ids.filterNotNull(), engine.parallelism) { id -> sendChunk(id) }
                true
            }
        }
    }

    private fun account(add: Int) = progress {
        accounted += add
        req.onProgress?.invoke(accounted, cut.plainSize)
    }

    private suspend fun bad(): Nothing {
        discard()
        throw TransferException(Reason.BAD_REPLY)
    }

    private suspend fun begin() {
        // A sealed manifest is different on every run, so it is sealed per begin.
        stored = req.codec.sealManifest(cut.manifest)
        storedSha = sha256Hex(stored)
        val size = req.codec.storedSize(cut.plainSize.toLong()).toInt()
        val request = buildJsonObject {
            put("size", size)
            put("sha256", storedSha)
            put("format", "chunks")
            put("enc", req.codec.enc)
            req.baseVersion?.takeIf { it !is JsonNull }?.let { put("baseVersion", it) }
        }
        val b = beginCall(request)
        if (b.mode != "chunks") {
            engine.abortQuietly(target, b.uploadId)
            throw TransferException(Reason.BAD_REPLY)
        }
        begun(req.id, b, null, storedSha, size)
    }

    /** The ids the server lacks, in file order. Every id sent is answered exactly once or the reply is refused. */
    private suspend fun plan(): List<String> {
        val ids = unique.keys.toList()
        val missing = HashSet<String>()
        for (at in ids.indices step SYNC_CHUNK_PLAN_MAX_IDS) {
            val batch = ids.subList(at, minOf(ids.size, at + SYNC_CHUNK_PLAN_MAX_IDS))
            val asked = batch.toSet()
            val request = buildJsonObject {
                put(
                    "chunks",
                    JsonArray(
                        batch.map {
                            JsonArray(listOf(JsonPrimitive(it), JsonPrimitive(req.codec.chunkObjectBytes(cut.records[unique.getValue(it)].plainLen))))
                        },
                    ),
                )
            }
            val id = uploadId
            val o = send { engine.transport.planChunks(target, id, request) }.orRefuse()
            val miss = o["missing"].arrayValue
            val present = o["present"].arrayValue
            if (miss == null || present == null) bad()
            val said = HashSet<String>()
            for (m in miss) {
                val s = m.stringValue
                if (s == null || s !in asked || !said.add(s)) bad()
                missing.add(s)
            }
            for (entry in present) {
                val s = entry.arrayValue?.firstOrNull().stringValue
                if (s == null || s !in asked || !said.add(s)) bad()
                account(cut.records[unique.getValue(s)].plainLen)
            }
            if (said.size != asked.size) bad()
        }
        return ids.filter { it in missing }
    }

    private suspend fun sendChunk(id: String) {
        val i = unique[id] ?: throw TransferException(Reason.BAD_REPLY)
        val rec = cut.records[i]
        val start = cut.offsets[i]
        val plain = req.source.read(start, start + rec.plainLen)
        // The file may have changed since it was cut: what is sent must still be the chunk named.
        if (plain.size != rec.plainLen || !java.security.MessageDigest.isEqual(req.codec.chunkId(plain), rec.id)) {
            throw TransferException(Reason.SOURCE_MISMATCH)
        }
        val obj = req.codec.sealChunk(rec.id, plain)
        val digest = sha256Hex(obj)
        val up = uploadId
        send { engine.transport.putChunk(target, up, id, obj, digest) }.orRefuse()
        account(rec.plainLen)
    }

    private suspend fun sendManifest() {
        val up = uploadId
        send { engine.transport.putSingle(target, up, stored, storedSha) }.orRefuse()
        update { it.copy(state = "finalizing") }
    }
}

// -- Download --------------------------------------------------------------------------------------------------

/** One download: fetch the stored bytes, check them, and write the plaintext. */
private class DownloadRun(val engine: FileTransferEngine, val req: DownloadRequest) {
    private val target = FileTarget(req.collection, req.record)
    private val hold = Hold()
    private var written = 0
    private var total = 0

    suspend fun go() {
        if (req.size <= 0 || req.size.toLong() > req.codec.storedSize(SYNC_FILE_MAX_BYTES.toLong())) throw invalid("size")
        if (!Regex("[0-9a-f]{64}").matches(req.sha256)) throw invalid("sha256")
        try {
            if (req.format == "whole") whole() else chunked()
        } catch (f: SyncFileStream.Failure) {
            throw invalid(f.reason.wire)
        }
    }

    private suspend fun emit(piece: ByteArray) {
        if (piece.isEmpty()) return
        req.sink(piece)
        written += piece.size
        req.onProgress?.invoke(written, total)
    }

    // Nothing here restarts: a 404 or 410 means the revision is gone.
    private fun <T> FileReply<T>.orReject(): T = when (this) {
        is FileReply.Ok -> value
        is FileReply.Refused -> throw TransferException(Reason.REJECTED, refusal.status, refusal.code)
    }

    /**
     * A whole file: ranges of the stored bytes, opened as they arrive. Every range is asked with the ETag the
     * first answer gave (`If-Match`), its status and `Content-Range` are checked against what was asked, and the
     * length and SHA-256 are checked after the last one.
     */
    private suspend fun whole() {
        val plainSize = req.codec.plainSize(req.size.toLong()) ?: throw invalid("size")
        total = plainSize.toInt()
        val opener = req.codec.newOpener()
        val digest = MessageDigest.getInstance("SHA-256")
        var etag: String? = null
        var at = 0
        while (at < req.size) {
            currentCoroutineContext().ensureActive()
            val end = minOf(req.size, at + DOWNLOAD_RANGE_BYTES)
            val ask = at
            val query = FileQuery(req.version, ask to end, etag)
            val body = engine.call(hold) { engine.transport.getFile(target, query) }.orReject()
            val got = body.etag
            if (etag != null && got != null && got != etag) throw TransferException(Reason.BAD_REPLY, detail = "etag")
            if (etag == null) etag = got
            val piece = body.data
            if (body.status == HTTP_PARTIAL) {
                val cr = body.contentRange
                val ok =
                    cr != null && cr.start == ask && cr.total == req.size && cr.end > cr.start && cr.end <= end && piece.size == cr.end - cr.start
                if (!ok) throw TransferException(Reason.BAD_REPLY, detail = "content-range")
            } else if (body.status == HTTP_OK) {
                // A server that ignores `Range` sends the whole file, which only fits from the start.
                if (ask != 0 || piece.size != req.size) throw TransferException(Reason.BAD_REPLY, detail = "status")
            } else {
                throw TransferException(Reason.BAD_REPLY, detail = "status")
            }
            digest.update(piece)
            at += piece.size
            for (plain in opener.push(piece)) emit(plain)
        }
        if (hexOf(digest.digest()) != req.sha256) throw invalid("sha256")
        emit(opener.finish())
        if (written.toLong() != plainSize) throw invalid("size")
    }

    /** A chunked file: the manifest, then each chunk from the cache or the server. */
    private suspend fun chunked() {
        val codec = req.codec
        val manifestMax = codec.storedSize(MANIFEST_PLAIN_MAX_BYTES)
        val body = engine.call(hold) { engine.transport.getFile(target, FileQuery(req.version)) }.orReject()
        if (body.status != HTTP_OK) throw TransferException(Reason.BAD_REPLY, detail = "status")
        if (body.data.size > manifestMax) throw invalid("manifest-size")
        if (sha256Hex(body.data) != req.sha256) throw invalid("sha256")
        val opened = codec.openManifest(body.data)
        if (opened is FileOpened.Invalid) throw invalid("manifest-" + opened.reason)
        val parsed = SyncManifest.parse((opened as FileOpened.Ok).plain)
        if (parsed is SyncManifest.Parsed.Refused) throw invalid("manifest-" + parsed.reason.wire)
        val manifest = (parsed as SyncManifest.Parsed.Ok).manifest
        // The record's size and the manifest's must agree.
        if (codec.storedSize(manifest.plainSize) != req.size.toLong()) throw invalid("size")
        total = manifest.plainSize.toInt()
        val reassembly = SyncFileStream.Reassembly(manifest.plainSize, manifest.plainSha256)
        // A short window of chunks in flight, delivered in file order.
        for (batch in manifest.records.chunked(engine.parallelism)) {
            currentCoroutineContext().ensureActive()
            val plains = coroutineScope { batch.map { rec -> async { fetchOne(rec) } }.awaitAll() }
            for (plain in plains) {
                reassembly.push(plain)
                emit(plain)
            }
        }
        reassembly.finish()
    }

    private suspend fun fetchOne(rec: SyncManifest.Record): ByteArray {
        val id = hexOf(rec.id)
        val cache = req.cache
        if (cache != null) {
            val held = runCatching { cache.get(id) }.getOrNull() // a cache that fails is a miss
            if (held != null) {
                val o = req.codec.openChunk(rec.id, held)
                if (o is FileOpened.Ok && o.plain.size == rec.plainLen) return o.plain
                runCatching { cache.delete(id) } // damage costs a fetch
            }
        }
        val obj = engine.call(hold) { engine.transport.getChunk(req.collection, id) }.orReject()
        if (obj.size > SYNC_CHUNK_MAX_STORED_BYTES) throw invalid("chunk-size")
        val o = req.codec.openChunk(rec.id, obj)
        if (o is FileOpened.Invalid) throw invalid("chunk-" + o.reason)
        val plain = (o as FileOpened.Ok).plain
        if (plain.size != rec.plainLen) throw invalid("chunk-length")
        if (cache != null) runCatching { cache.put(id, obj) }
        return plain
    }
}
