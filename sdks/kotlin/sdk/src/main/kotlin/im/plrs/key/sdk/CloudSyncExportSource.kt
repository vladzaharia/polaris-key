// The export's file source and its bounded waits (WIRE-CONTRACT-V5 section 13.12): whole files by `Range` of the stored bytes,
// a chunked file by its manifest and its chunks, through the same retrying engine `saves.read` uses, so they spend the
// device's hourly file allowance. Everything the Worker serves is untrusted: an answer that is inconsistent (another file, another
// range, a `200` for a range) ends the stream there, and the core flags what was read as partial. All the waits of one export
// (a `Retry-After`, a retry's backoff) add up to at most `SYNC_EXPORT_MAX_WAIT_MS`; one is cut to `SYNC_EXPORT_RETRY_AFTER_MAX_MS`.

package im.plrs.key.sdk

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.core.SYNC_EXPORT_MAX_WAIT_MS
import im.plrs.key.core.SYNC_EXPORT_RETRY_AFTER_MAX_MS
import im.plrs.key.core.arrayValue
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.sync.ExportFileRef
import im.plrs.key.core.sync.ExportFileSource
import im.plrs.key.core.sync.ExportStored
import im.plrs.key.core.sync.SyncExportException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

private const val MS_PER_SECOND = 1000.0
private const val NOT_FOUND = 404
private const val GONE = 410
private const val FORBIDDEN = 403
private const val OK = 200
private const val PARTIAL = 206
private const val VERSION_LIMIT = 1_000_000_000L

/** Everything the export waits for, added up: past `SYNC_EXPORT_MAX_WAIT_MS` it fails (reason `network`). A cancel ends a wait at once. */
internal class ExportBudget(private val onWait: (Boolean) -> Unit, private val sleeper: suspend (Long) -> Unit = { delay(it) }) {
    private var waitedMs = 0.0

    suspend fun sleep(seconds: Double) {
        currentCoroutineContext().ensureActive()
        val s = maxOf(0.0, minOf(seconds, SYNC_EXPORT_RETRY_AFTER_MAX_MS / MS_PER_SECOND))
        if (waitedMs + s * MS_PER_SECOND > SYNC_EXPORT_MAX_WAIT_MS) throw SyncExportException(SyncExportException.NETWORK)
        waitedMs += s * MS_PER_SECOND
        onWait(true)
        try {
            sleeper((s * MS_PER_SECOND).toLong())
        } finally {
            onWait(false)
        }
    }
}

/** A version the file routes can name (`?version=` is at most nine digits), or null. */
private fun versionOf(v: JsonElement): Int? = v.longValue?.takeIf { it in 0 until VERSION_LIMIT }?.toInt()

internal class HttpExportSource(private val transport: FileTransport, private val engine: FileTransferEngine) : ExportFileSource {
    private val hold = Hold()

    /** The reply of one route call with the engine's recovery rules; null when the route cannot be built (nothing there to ask for). */
    private suspend fun <T> reply(op: suspend () -> FileReply<T>): FileReply<T>? = try {
        engine.call(hold, op)
    } catch (e: TransferException) {
        if (e.reason == Reason.REJECTED && e.code == "bad_path") null else throw SyncExportException(SyncExportException.NETWORK)
    }

    /** A refusal: null is "the Worker has none"; any other refusal is the export's failure. */
    private fun missing(refusal: FileRefusal): Nothing? {
        if (refusal.status == FORBIDDEN && refusal.code == ErrorCode.accountRequired) {
            throw PolarisException(ErrorCode.accountRequired, "Cloud Sync needs a signed-in account")
        }
        if (refusal.status != NOT_FOUND && refusal.status != GONE) throw SyncExportException(SyncExportException.NETWORK)
        return null
    }

    private suspend fun <T> call(op: suspend () -> FileReply<T>): T? = when (val r = reply(op)) {
        null -> null
        is FileReply.Ok -> r.value
        is FileReply.Refused -> missing(r.refusal)
    }

    override suspend fun pointers(collection: String, record: String): List<JsonObject> {
        val body = call { transport.revisions(FileTarget(collection, record)) } ?: return emptyList()
        return body["revisions"].arrayValue?.mapNotNull { it.objectValue } ?: emptyList()
    }

    override suspend fun stored(ref: ExportFileRef): ExportStored {
        val version = versionOf(ref.version)
        return when {
            version == null || ref.size > Int.MAX_VALUE -> Empty
            ref.format == "chunks" -> Manifest(FileTarget(ref.collection, ref.record), version)
            else -> Ranged(FileTarget(ref.collection, ref.record), version, ref.size.toInt())
        }
    }

    override suspend fun chunk(collection: String, idHex: String): ByteArray? = call { transport.getChunk(collection, idHex) }

    private object Empty : ExportStored {
        override suspend fun next(): ByteArray? = null
    }

    /** The manifest: one unranged `GET`, read under the manifest cap. */
    private inner class Manifest(private val target: FileTarget, private val version: Int) : ExportStored {
        private var done = false

        override suspend fun next(): ByteArray? {
            if (done) return null
            done = true
            val body = call { transport.getFile(target, FileQuery(version = version)) }
            return if (body != null && body.status == OK) body.data else null
        }
    }

    /** A whole file in `Range` pieces under one ETag. */
    private inner class Ranged(private val target: FileTarget, private val version: Int, private val size: Int) : ExportStored {
        private var at = 0
        private var etag: String? = null
        private var ended = false

        override suspend fun next(): ByteArray? {
            val end = minOf(size, at + DOWNLOAD_RANGE_BYTES)
            val body = if (ended ||
                at >= size
            ) {
                null
            } else {
                call { transport.getFile(target, FileQuery(version = version, range = at to end, ifMatch = etag)) }
            }
            val ok = body != null && consistent(body, end)
            if (body != null && ok) {
                if (etag == null) etag = body.etag
                at += body.data.size
            } else {
                ended = true
            }
            return if (ok) body?.data else null
        }

        /** A Worker that answers inconsistently (another file, another range, a `200` for a range) ends the stream here. */
        private fun consistent(body: FileBody, end: Int): Boolean {
            val held = etag
            if (held != null && body.etag != null && body.etag != held) return false
            val cr = body.contentRange
            return when (body.status) {
                PARTIAL ->
                    cr != null && cr.start == at && cr.total == size && cr.end > cr.start && cr.end <= end &&
                        body.data.size == cr.end - cr.start

                OK -> at == 0 && body.data.size == size

                else -> false
            }
        }
    }
}
