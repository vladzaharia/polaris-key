// Cloud Sync saves (U-22.5; WIRE-CONTRACT-V5 sections 13.7, 13.8; plans D-2, D-3, D-8, D-11): `client.cloudSync.saves`.
// A port of client-core's `sync/saves.ts`, as Node's `cloudSync/saves.ts` and Python's `cloud_sync/saves.py` bind it.
//
// A save is a record of the `saves` collection with one file. A write goes in this order, so no save is ever torn:
//
//   1. upload the file (`begin`, bytes, `finalize`), which creates the record or bumps its version and answers it;
//   2. write the metadata (`putAt`) at `baseVersion` = the version `finalize` answered, and wait for the server's answer
//      to that one mutation. The wait has no timeout: `cancel()`, a sign-out (the write is dropped) and the host's
//      retries are what end it.
//
// In end-to-end mode the sealed metadata carries `"$file": {sha256, size, format}` (D-3). A reader downloads the
// revision whose `sha256` the binding names and fails with `sync-file-invalid` when none matches, so a Worker can
// neither swap the files of two slots nor show a new file under old metadata. In server mode there is no binding (the
// server holds the plaintext), and the record's own file is the file.
//
// The record layer is a port ([SaveRecords]) that the host binds to the Cloud Sync machine. This file owns the order
// of the steps, the choice of the revision, the format check (D-11), the slot cap, conflicts and the [SaveTransfer]
// handle. Metadata is a [JsonObject] or a `@Serializable` type; `formatVersion` (an integer member) above the app's
// `saveFormatVersion` reads as [SaveRead.NewerFormat].
//
// Conflicts (plans/U-08.md section 2.4): a write whose base is stale opens one [MergeRequest] per slot (S1) and the device
// keeps its copy unsent until the person or the app answers with `keep`. A write with no base is based on the version this
// device last listed, read or wrote for the slot this session (S2); a slot not seen is create-only; a pulled version is
// never a base. While a request is open a write with no base only replaces its local side (S3). Requests live in memory
// (S5): a relaunch drops them and the next write raises the conflict again through S2.

package im.plrs.key.sdk

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.MergeCause
import im.plrs.key.core.MergeChoice
import im.plrs.key.core.PolarisException
import im.plrs.key.core.SYNC_FILE_MAX_BYTES
import im.plrs.key.core.SYNC_KEY_PATTERN
import im.plrs.key.core.SYNC_SAVE_SLOTS
import im.plrs.key.core.arrayValue
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.sync.MergeFile
import im.plrs.key.core.sync.MergeKeep
import im.plrs.key.core.sync.MergeSide
import im.plrs.key.core.sync.RecordFile
import im.plrs.key.core.sync.SyncTransferPlan
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.put
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

public const val SAVES_COLLECTION: String = "saves"

/** The key of the E2E binding inside a save's sealed metadata (D-3). */
public const val SAVE_FILE_BINDING_KEY: String = "\$file"

/**
 * SDK-owned metadata keys written with every save (SAVES-META): when it was saved (epoch ms) and the device's display
 * name. A write overwrites an app value under either key. Never a hardware value.
 */
public const val SAVE_SAVED_AT_KEY: String = "savedAt"
public const val SAVE_DEVICE_KEY: String = "deviceLabel"

/** Retry-After is honoured up to an hour: a save may wait out a long throttle. */
public const val SAVES_MAX_RETRY_AFTER_SECONDS: Double = 3600.0

private const val DEFAULT_MAX_BYTES: Long = 32L * 1024 * 1024
private const val HTTP_NOT_FOUND = 404
private const val COPY_ATTEMPTS = 1000
private const val BACKGROUND_POLL_MS = 1_000L
private const val COPY_ID_ROOM = 120
private val SAVE_KEY = Regex(SYNC_KEY_PATTERN)
private val HEX64 = Regex("[0-9a-f]{64}")

/** Why a save call failed (D-8); a downloaded file that fails a check is [SYNC_FILE_INVALID]. */
public class SavesException(public val code: String, public val detail: String? = null, cause: Throwable? = null) :
    Exception("saves: $code" + (detail?.let { " ($it)" } ?: ""), cause) {
    public fun toPolarisException(): PolarisException = PolarisException(
        if (code == SYNC_FILE_INVALID) ErrorCode.syncFileInvalid else ErrorCode.syncFailed,
        message ?: "saves",
        detail,
    )

    public companion object {
        public const val SYNC_FILE_INVALID: String = "sync-file-invalid"
        public const val INVALID_SAVE: String = "invalid-save"
        public const val TOO_LARGE: String = "too-large"
        public const val SLOTS_FULL: String = "slots-full"
        public const val NOT_FOUND: String = "not-found"
        public const val TRANSFER_FAILED: String = "transfer-failed"
        public const val REJECTED: String = "rejected"
    }
}

/** One save record as the records layer holds it: [value] is the opened metadata, [file] the pull's `file` member. */
public class SaveRecord(public val id: String, public val version: Long, public val value: JsonObject, public val file: RecordFile?)

/** The server's answer to a save's metadata write or delete. */
public sealed interface SaveSetResult {
    public class Ok(public val version: Long) : SaveSetResult

    /** A stale `baseVersion`: [server] is the copy the server holds (null when the host could not read it). */
    public class Conflict(public val server: SaveRecord?) : SaveSetResult

    public class Rejected(public val code: String) : SaveSetResult
}

/** One save as listed: its metadata (without the E2E binding), version and file. */
public class SaveSummary(
    public val id: String,
    public val version: Long,
    public val metadata: JsonObject,
    /** Null when the record has no file (in E2E mode: no file the binding names). */
    public val file: RecordFile?,
    /** The save's `formatVersion` is above the app's `saveFormatVersion` (D-11). */
    public val newerFormat: Boolean,
)

/** One kept revision of a save's file, newest first. */
public class SaveRevision(
    public val version: Long,
    public val size: Long,
    public val sha256: String,
    public val format: String,
    public val createdAt: Long?,
)

public sealed interface SaveRead {
    public class Ok(
        public val id: String,
        public val version: Long,
        public val metadata: JsonObject,
        public val file: RecordFile?,
        /** The save's bytes; null when a sink took them or the save has no file. */
        public val bytes: ByteArray?,
    ) : SaveRead {
        /** The metadata as a `@Serializable` type; members the type lacks are ignored. */
        public inline fun <reified T> metadataAs(): T = metadataAs(kotlinx.serialization.serializer<T>())

        /** The metadata through [deserializer]; members it does not declare are ignored. */
        public fun <T> metadataAs(deserializer: kotlinx.serialization.DeserializationStrategy<T>): T =
            Json { ignoreUnknownKeys = true }.decodeFromJsonElement(deserializer, metadata)
    }

    public data object NotFound : SaveRead

    public class NewerFormat(public val formatVersion: Long, public val supported: Int) : SaveRead
}

public sealed interface SaveResult {
    /** [copyId] is the id a `keep(MergeKeep.Both)` copy was written under. */
    public class Done(public val id: String, public val version: Long, public val file: RecordFile, public val copyId: String? = null) : SaveResult

    /** A cancelled transfer is a state, not an error (D-8). */
    public data object Cancelled : SaveResult

    public class Failed(public val error: SavesException) : SaveResult

    /** The write was not sent: [request] holds it until `keep` (S1, S3). */
    public class Conflict(public val request: MergeRequest) : SaveResult
}

public enum class TransferState { RUNNING, PAUSED, DONE, CANCELLED, FAILED, CONFLICT }

/** The record layer of the saves, bound to the Cloud Sync machine by the host. */
internal interface SaveRecords {
    /** The record id as it goes on the wire (blinded in end-to-end mode). */
    suspend fun wireId(id: String): String

    /** The refusal reason when saves cannot be written now (signed out), else null. */
    suspend fun notReady(): String?

    suspend fun list(): List<SaveRecord>

    suspend fun get(id: String): SaveRecord?

    /**
     * Write the metadata at exactly [baseVersion]; a cancelled caller stops waiting (no timeout). [file] is the pointer
     * `finalize` returned: an acknowledged set adopts it on the row.
     */
    suspend fun set(id: String, value: JsonObject, baseVersion: JsonElement, file: RecordFile?): SaveSetResult

    suspend fun delete(id: String, baseVersion: Long): SaveSetResult

    /**
     * Pull the `saves` collection from the server and return when the pull ended. False when this port cannot pull (the cache
     * is all there is); a pull that failed still returns true, with the cache as it was.
     */
    suspend fun pull(): Boolean = false
}

@Suppress("LongParameterList")
internal class SavesDeps(
    val records: SaveRecords,
    val engine: FileTransferEngine,
    val transport: FileTransport,
    val codec: FileCodec,
    val delta: Boolean,
    val maxBytes: Long = DEFAULT_MAX_BYTES,
    val saveFormatVersion: Int? = null,
    val cache: ChunkCache? = null,
    /** The device's display name, stored with each save (SAVES-META); null stores none. */
    val deviceLabel: String? = null,
    /** The clock for `savedAt`, epoch milliseconds. */
    val now: () -> Long = System::currentTimeMillis,
)

private class Binding(val sha256: String, val size: Long, val format: String)

private fun splitBinding(value: JsonObject): Pair<JsonObject, Binding?> {
    val raw = value[SAVE_FILE_BINDING_KEY].objectValue
    val metadata = JsonObject(value - SAVE_FILE_BINDING_KEY)
    val sha = raw?.get("sha256").stringValue
    val size = raw?.get("size").longValue
    val format = raw?.get("format").stringValue
    val ok = sha != null && HEX64.matches(sha) && size != null && size > 0 && (format == "whole" || format == "chunks")
    return metadata to (if (ok) Binding(sha!!, size!!, format!!) else null)
}

private fun formatOf(metadata: JsonObject): Long? = (metadata["formatVersion"] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toLongOrNull()

private fun sha256Hex(d: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(d).joinToString("") { "%02x".format(it) }

private fun asSavesError(e: Throwable): SavesException = when {
    e is SavesException -> e
    e is TransferException && e.reason == Reason.FILE_INVALID -> SavesException(SavesException.SYNC_FILE_INVALID, e.detail, e)
    e is TransferException -> SavesException(SavesException.TRANSFER_FAILED, e.code ?: e.reason.wire, e)
    e is PolarisException -> SavesException(SavesException.TRANSFER_FAILED, e.code, e)
    else -> SavesException(SavesException.TRANSFER_FAILED, null, e)
}

/** How a write picks the version it is based on. */
private sealed interface WriteMode {
    data object Plain : WriteMode

    data object Copy : WriteMode

    class Base(val version: JsonElement) : WriteMode
}

/** What a [SavesClient] tells its owner as writes and reads move. */
internal class SavesHooks(
    val progress: (id: String, done: Long, total: Long) -> Unit = { _, _, _ -> },
    val settled: (id: String, result: SaveResult) -> Unit = { _, _ -> },
    val readDone: (id: String, failure: SavesException?) -> Unit = { _, _ -> },
    /** A write has been accepted and is about to start (U-41.7b). */
    val started: (id: String) -> Unit = {},
)

/**
 * `client.cloudSync.saves`. Every verb checks that the product runs the Sync service and declares a `saves`
 * collection (the typed `product` N/A otherwise). A product built with no signed-in person lists nothing and refuses
 * a write (`rejected`, `signed-out`).
 */
@Suppress("TooManyFunctions")
public class SavesClient internal constructor(
    private val scope: CoroutineScope,
    private val hooks: SavesHooks,
    internal val merge: MergeRegistry,
    private val deps: suspend () -> SavesDeps,
) {
    private val running = ConcurrentHashMap<String, SaveTransfer>()
    private val slots = ConcurrentHashMap<String, Slot>()

    /** S2: the version this device last listed, read or wrote for a slot this session. */
    private val seen = ConcurrentHashMap<String, Long>()

    /** One open save request (S1): the device's copy, retained in memory until `keep`. */
    @Suppress("LongParameterList")
    private class Slot(
        val id: String,
        var metadata: JsonObject,
        var source: RangedSource,
        var onProgress: ((Long, Long) -> Unit)?,
        /** The version the copy was written on; null: create-only. */
        var base: Long?,
        var remote: SaveSummary?,
        /** The server's version for `keep: local`; `"*"` when the save is gone. */
        var remoteVersion: JsonElement,
        var slotsFree: Boolean,
        var chunks: Boolean,
    ) {
        /** A keep is running: a conflict it meets reopens the request when the keep ends. */
        @Volatile var keeping: Boolean = false

        @Volatile var reopen: Boolean = false
    }

    /** The saves of this person, by id. */
    public suspend fun list(): List<SaveSummary> {
        val d = deps()
        val all = d.records.list()
        for (r in all) seen[r.id] = r.version
        return all.map { summary(d, it) }.sortedBy { it.id }
    }

    /** The kept revisions of a save's file, newest first. */
    public suspend fun revisions(id: String): List<SaveRevision> {
        checkId(id)
        return revisionsOf(deps(), id)
    }

    /**
     * Read a save: its metadata and bytes. See the file header for which revision; [sink] takes the bytes instead
     * (provisional until this returns: discard them if it throws).
     */
    @Suppress("TooGenericExceptionCaught")
    public suspend fun read(id: String, sink: (suspend (ByteArray) -> Unit)? = null, onProgress: ((Long, Long) -> Unit)? = null): SaveRead {
        checkId(id)
        val tid = "saves:read:$id"
        val d = deps()
        return try {
            readNow(d, id, sink) { done, total ->
                onProgress?.invoke(done, total)
                hooks.progress(tid, done, total)
            }.also { hooks.readDone(tid, null) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            hooks.readDone(tid, e as? SavesException ?: asSavesError(e))
            throw e
        }
    }

    @Suppress("CyclomaticComplexMethod", "ReturnCount", "ThrowsCount", "TooGenericExceptionCaught")
    private suspend fun readNow(d: SavesDeps, id: String, sink: (suspend (ByteArray) -> Unit)?, progress: (Long, Long) -> Unit): SaveRead {
        val rec = d.records.get(id) ?: return SaveRead.NotFound
        seen[id] = rec.version
        val (metadata, binding) = splitBinding(rec.value)
        val fv = formatOf(metadata)
        val supported = d.saveFormatVersion
        if (supported != null && fv != null && fv > supported) return SaveRead.NewerFormat(fv, supported)
        val ref: RecordFile? = if (d.codec.enc == "e2e") {
            when {
                binding != null -> revisionFor(d, id, rec, binding)

                // A malformed binding is not an absent one: the writer meant a file.
                rec.value.containsKey(SAVE_FILE_BINDING_KEY) -> throw SavesException(SavesException.SYNC_FILE_INVALID, "binding")

                else -> null
            }
        } else {
            rec.file
        }
        if (ref == null) return SaveRead.Ok(id, rec.version, metadata, null, null)
        if (ref.size > Int.MAX_VALUE || ref.version > Int.MAX_VALUE) throw SavesException(SavesException.SYNC_FILE_INVALID, "size")
        val collected = java.io.ByteArrayOutputStream()
        val take: suspend (ByteArray) -> Unit = sink ?: { collected.write(it) }
        try {
            d.engine.download(
                DownloadRequest(
                    collection = SAVES_COLLECTION,
                    record = d.records.wireId(id),
                    format = ref.format,
                    size = ref.size.toInt(),
                    sha256 = ref.sha256,
                    codec = d.codec,
                    sink = take,
                    version = ref.version.toInt(),
                    cache = d.cache,
                    onProgress = { done, total -> progress(done.toLong(), total.toLong()) },
                ),
            )
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw asSavesError(e)
        }
        return SaveRead.Ok(id, rec.version, metadata, ref, if (sink == null) collected.toByteArray() else null)
    }

    /**
     * Write a save. The handle settles when the file is stored and the metadata is written, or on a conflict, a
     * failure or a cancel. [baseVersion] is the version the caller last saw; absent is the version this device last
     * listed, read or wrote for the slot this session, or create-only for a slot not seen (S2). While a request is open
     * for the slot, a write with no base only replaces the request's local copy and settles `Conflict`; a write with a
     * base supersedes the request (S3).
     */
    public suspend fun write(
        id: String,
        bytes: ByteArray,
        metadata: JsonObject,
        baseVersion: Long? = null,
        onProgress: ((Long, Long) -> Unit)? = null,
    ): SaveTransfer = userWrite(SaveWrite(id, BytesSource(bytes), metadata, modeFor(baseVersion), stamp = true), baseVersion != null, onProgress)

    /** [write] with a `@Serializable` metadata type (its serializer must encode an object). */
    public suspend inline fun <reified T> writeAs(
        id: String,
        bytes: ByteArray,
        metadata: T,
        baseVersion: Long? = null,
        noinline onProgress: ((Long, Long) -> Unit)? = null,
    ): SaveTransfer = writeAs(id, bytes, metadata, kotlinx.serialization.serializer<T>(), baseVersion, onProgress)

    /** [write] with metadata encoded by [serializer]. */
    @Suppress("LongParameterList")
    public suspend fun <T> writeAs(
        id: String,
        bytes: ByteArray,
        metadata: T,
        serializer: kotlinx.serialization.SerializationStrategy<T>,
        baseVersion: Long? = null,
        onProgress: ((Long, Long) -> Unit)? = null,
    ): SaveTransfer = write(
        id,
        bytes,
        Json.encodeToJsonElement(serializer, metadata) as? JsonObject ?: throw SavesException(SavesException.INVALID_SAVE, "metadata"),
        baseVersion,
        onProgress,
    )

    /** [write] from a source read by range, so the file is never held whole by the caller. */
    public suspend fun writeFrom(
        id: String,
        source: RangedSource,
        metadata: JsonObject,
        baseVersion: Long? = null,
        onProgress: ((Long, Long) -> Unit)? = null,
    ): SaveTransfer = userWrite(SaveWrite(id, source, metadata, modeFor(baseVersion), stamp = true), baseVersion != null, onProgress)

    /**
     * Delete a save; its file is collected with the record. With a request open for the slot the default base is the
     * request's, so a delete that conflicts keeps the other copy (S3).
     */
    @Suppress("ReturnCount", "ComplexCondition")
    public suspend fun delete(id: String, baseVersion: Long? = null): SaveSetResult {
        checkId(id)
        val d = deps()
        val slot = slots[id]
        var base = baseVersion
        if (base == null) {
            if (slot != null) {
                base = slot.base
                if (base == null) {
                    val server = d.records.get(id)
                    closeSlot(id, "superseded")
                    return SaveSetResult.Conflict(server)
                }
            } else {
                base = d.records.get(id)?.version ?: return SaveSetResult.Rejected("not_found")
            }
        }
        val r = d.records.delete(id, base)
        if (slot != null && slots[id] === slot && (r is SaveSetResult.Ok || r is SaveSetResult.Conflict)) closeSlot(id, "superseded")
        if (r is SaveSetResult.Ok) seen.remove(id)
        return r
    }

    /** The writes in flight (running, paused or waiting on the network). */
    public fun transfers(): List<SaveTransfer> = running.values.sortedBy { it.id }

    /**
     * A scheduled background run of the write whose id hashes to [idHash]: wait for the live write and say how it came
     * out. No such write, a cancelled,
     * failed or paused one is [BackgroundTransferOutcome.STOP]; one the host stopped (the transfer scope went away) is
     * RETRY. The caller's own cancellation is the system stopping the run and passes through.
     */
    internal suspend fun awaitBackground(idHash: String): BackgroundTransferOutcome {
        val t = running.values.firstOrNull { ownerTag(it.id) == idHash } ?: return BackgroundTransferOutcome.STOP
        var result: SaveResult? = null
        while (result == null && t.state != TransferState.PAUSED) result = withTimeoutOrNull(BACKGROUND_POLL_MS) { t.await() }
        return when (result) {
            null, SaveResult.Cancelled -> BackgroundTransferOutcome.STOP
            is SaveResult.Done, is SaveResult.Conflict -> BackgroundTransferOutcome.DONE
            is SaveResult.Failed -> if (result.error.isStopped()) BackgroundTransferOutcome.RETRY else BackgroundTransferOutcome.STOP
        }
    }

    private fun SavesException.isStopped(): Boolean = code == SavesException.TRANSFER_FAILED && detail == "stopped"

    /** Cancel every write in flight (the person's data is gone). Each is tried whatever the other did. */
    internal suspend fun cancelAll() {
        val all = running.values.toList()
        running.clear()
        slots.clear()
        seen.clear()
        merge.closeAllExtra()
        for (t in all) runCatching { t.cancel() }
    }

    // -- internals ---------------------------------------------------------------------------------------------

    private fun checkId(id: String) {
        if (!SAVE_KEY.matches(id)) throw SavesException(SavesException.INVALID_SAVE, "id")
    }

    private fun summary(d: SavesDeps, rec: SaveRecord): SaveSummary {
        val (metadata, binding) = splitBinding(rec.value)
        val fv = formatOf(metadata)
        val supported = d.saveFormatVersion
        // In end-to-end mode the file is the one the binding names, and only when the record's current file is it.
        val file = if (d.codec.enc == "e2e") rec.file?.takeIf { binding != null && it.sha256 == binding.sha256 } else rec.file
        return SaveSummary(rec.id, rec.version, metadata, file, supported != null && fv != null && fv > supported)
    }

    @Suppress("ComplexCondition")
    private suspend fun revisionsOf(d: SavesDeps, id: String): List<SaveRevision> {
        val reply = d.transport.revisions(FileTarget(SAVES_COLLECTION, d.records.wireId(id)))
        if (reply is FileReply.Refused) {
            val missing = reply.refusal.status == HTTP_NOT_FOUND
            throw SavesException(if (missing) SavesException.NOT_FOUND else SavesException.REJECTED, reply.refusal.code)
        }
        val list = (reply as FileReply.Ok).value["revisions"].arrayValue.orEmpty()
        return list.mapNotNull { r ->
            val o = r.objectValue ?: return@mapNotNull null
            val sha = o["sha256"].stringValue
            val format = o["format"].stringValue
            val version = o["version"].longValue
            val size = o["size"].longValue
            if (version == null || size == null || sha == null ||
                format == null
            ) {
                null
            } else {
                SaveRevision(version, size, sha, format, o["createdAt"].longValue)
            }
        }
    }

    /** D-3: the revision the binding names, else a failure. */
    private suspend fun revisionFor(d: SavesDeps, id: String, rec: SaveRecord, b: Binding): RecordFile {
        fun fits(sha: String, size: Long, format: String) = sha == b.sha256 && size == b.size && format == b.format
        rec.file?.let { if (fits(it.sha256, it.size, it.format)) return it }
        val found =
            revisionsOf(d, id).firstOrNull { fits(it.sha256, it.size, it.format) }
                ?: throw SavesException(SavesException.SYNC_FILE_INVALID, "binding")
        return RecordFile(found.version, found.size, found.sha256, found.format)
    }

    private fun settled(id: String, result: SaveResult): SaveTransfer {
        val transfer = SaveTransfer(id, scope, { result }, {}, onSettle = { r -> hooks.settled(id, r) })
        transfer.start()
        return transfer
    }

    /** One write: what is stored, under which id, and how the server is asked to take it. */
    private class SaveWrite(val id: String, val source: RangedSource, val metadata: JsonObject, val mode: WriteMode, val stamp: Boolean = false)

    private fun modeFor(baseVersion: Long?): WriteMode = baseVersion?.let { WriteMode.Base(JsonPrimitive(it)) } ?: WriteMode.Plain

    /** A write the app asked for: with a request open for the slot, a write with no base only replaces the request's local side (S3). */
    @Suppress("ReturnCount")
    private suspend fun userWrite(write: SaveWrite, hasBase: Boolean, onProgress: ((Long, Long) -> Unit)?): SaveTransfer {
        val id = write.id
        val slot = slots[id]
        if (slot == null) return run(write, onProgress)
        if (hasBase) {
            closeSlot(id, "superseded")
            return run(write, onProgress)
        }
        val d = deps()
        val stamped = stamped(d, write.metadata)
        precheck(d, id, write.source, stamped)?.let { return settled(id, SaveResult.Failed(it)) }
        slot.metadata = stamped
        slot.source = write.source
        slot.onProgress = onProgress
        slot.chunks = isChunked(d, write.source)
        val side = localSide(slot)
        merge.update(requestId(id)) { it.copy(local = side) }
        return settled(id, SaveResult.Conflict(checkNotNull(merge.find(requestId(id)))))
    }

    private suspend fun run(write: SaveWrite, onProgress: ((Long, Long) -> Unit)?): SaveTransfer {
        val id = write.id
        val source = write.source
        val mode = write.mode
        val d = deps()
        // The SDK's own keys: when and where this save was written. A resolve keeps the stamps of the copy it writes (they are
        // already in the conflict's local metadata).
        val metadata = if (write.stamp) stamped(d, write.metadata) else write.metadata
        val transferId = "saves:$id"
        var sealed: Pair<ByteArray, String>? = null
        lateinit var transfer: SaveTransfer
        val attempt: suspend (Phase) -> SaveResult = { phase ->
            attemptWrite(d, id, transferId, source, metadata, mode, phase, onProgress, { done, total ->
                transfer.progress(done, total)
                onProgress?.invoke(done, total)
                hooks.progress(transferId, done, total)
            }, { sealed }, { sealed = it })
        }
        transfer = SaveTransfer(transferId, scope, attempt, { d.engine.cancel(transferId) }, onSettle = { r ->
            running.remove(transferId, transfer)
            hooks.settled(transferId, r)
        }, total = source.size.toLong())
        running[transferId] = transfer
        hooks.started(transferId)
        transfer.start()
        return transfer
    }

    private fun stamped(d: SavesDeps, metadata: JsonObject): JsonObject = JsonObject(
        metadata.filterKeys { it != SAVE_SAVED_AT_KEY && it != SAVE_DEVICE_KEY } +
            (SAVE_SAVED_AT_KEY to JsonPrimitive(d.now())) +
            (d.deviceLabel?.takeIf { it.isNotEmpty() }?.let { mapOf(SAVE_DEVICE_KEY to JsonPrimitive(it)) } ?: emptyMap()),
    )

    private fun precheck(d: SavesDeps, id: String, source: RangedSource, metadata: JsonObject): SavesException? = when {
        !SAVE_KEY.matches(id) -> SavesException(SavesException.INVALID_SAVE, "id")
        metadata.containsKey(SAVE_FILE_BINDING_KEY) -> SavesException(SavesException.INVALID_SAVE, "reserved-key")
        source.size > d.maxBytes || source.size > SYNC_FILE_MAX_BYTES -> SavesException(SavesException.TOO_LARGE)
        else -> null
    }

    @Suppress("LongParameterList", "CyclomaticComplexMethod", "ReturnCount", "LongMethod")
    private suspend fun attemptWrite(
        d: SavesDeps,
        id: String,
        transferId: String,
        source: RangedSource,
        metadata: JsonObject,
        mode: WriteMode,
        phase: Phase,
        userProgress: ((Long, Long) -> Unit)?,
        progress: (Long, Long) -> Unit,
        sealedNow: () -> Pair<ByteArray, String>?,
        keepSealed: (Pair<ByteArray, String>) -> Unit,
    ): SaveResult {
        precheck(d, id, source, metadata)?.let { return SaveResult.Failed(it) }
        d.records.notReady()?.let { return SaveResult.Failed(SavesException(SavesException.REJECTED, it)) }
        var targetId = id
        val base: JsonElement
        when (mode) {
            WriteMode.Copy -> {
                targetId = freeId(d, id) ?: return SaveResult.Failed(SavesException(SavesException.SLOTS_FULL))
                base = JsonPrimitive("*")
            }

            is WriteMode.Base -> base = mode.version

            WriteMode.Plain -> {
                // S2: the version this device saw this session; else create-only. A pulled version is never a base, so
                // another device's newer save is a conflict, not an overwrite.
                val saw = seen[id]
                if (saw != null) {
                    base = JsonPrimitive(saw)
                } else {
                    if (d.records.get(id) == null && d.records.list().size >= SYNC_SAVE_SLOTS) {
                        return SaveResult.Failed(SavesException(SavesException.SLOTS_FULL))
                    }
                    base = JsonPrimitive("*")
                }
            }
        }
        val wire = d.records.wireId(targetId)
        val onUpload: (Int, Int) -> Unit = { done, total -> progress(done.toLong(), total.toLong()) }
        val finalized: JsonObject
        try {
            val plan = SyncTransferPlan.plan(d.codec.storedSize(source.size.toLong()), d.delta)
            finalized = when (plan.mode) {
                SyncTransferPlan.Mode.TOO_LARGE -> return SaveResult.Failed(SavesException(SavesException.TOO_LARGE))

                SyncTransferPlan.Mode.CHUNKS -> phase.engine {
                    d.engine.uploadChunked(ChunkedUploadRequest(transferId, SAVES_COLLECTION, wire, source, d.codec, base, onUpload))
                }

                else -> {
                    val (stored, sha) = sealedNow() ?: run {
                        val bytes = d.codec.sealWhole(source.read(0, source.size))
                        (bytes to sha256Hex(bytes)).also(keepSealed)
                    }
                    phase.engine {
                        d.engine.upload(
                            UploadRequest(transferId, SAVES_COLLECTION, wire, BytesSource(stored), stored.size, sha, d.codec.enc, base, onUpload),
                        )
                    }
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: TransferException) {
            if (e.reason ==
                Reason.CONFLICT
            ) {
                return conflictOutcome(d, Written(id, metadata, source, userProgress, base), e.serverVersion?.toLong(), null, false)
            }
            return SaveResult.Failed(asSavesError(e))
        }
        val file = RecordFile.of(finalized) ?: return SaveResult.Failed(SavesException(SavesException.TRANSFER_FAILED, "bad-finalize"))
        val value = if (d.codec.enc == "e2e") {
            JsonObject(
                metadata + (
                    SAVE_FILE_BINDING_KEY to buildJsonObject {
                        put("sha256", file.sha256)
                        put("size", file.size)
                        put("format", file.format)
                    }
                    ),
            )
        } else {
            metadata
        }
        // The metadata `set` goes on the version `finalize` answered, not on the pulled row's.
        return when (val set = d.records.set(targetId, value, JsonPrimitive(file.version), file)) {
            is SaveSetResult.Ok -> {
                seen[targetId] = set.version
                SaveResult.Done(id, set.version, file, targetId.takeIf { it != id })
            }

            is SaveSetResult.Conflict -> conflictOutcome(d, Written(id, metadata, source, userProgress, base), set.server?.version, set.server, true)

            is SaveSetResult.Rejected -> SaveResult.Failed(SavesException(SavesException.REJECTED, set.code))
        }
    }

    /** The first `<id>.copy`, `<id>.copy2`, ... that is not a save; null when all 16 slots are in use. */
    @Suppress("ReturnCount")
    private suspend fun freeId(d: SavesDeps, id: String): String? {
        val all = d.records.list()
        if (all.size >= SYNC_SAVE_SLOTS) return null
        val taken = all.map { it.id }.toSet()
        for (n in 1 until COPY_ATTEMPTS) {
            val cand = id.take(COPY_ID_ROOM) + ".copy" + (if (n == 1) "" else n.toString())
            if (cand !in taken) return cand
        }
        return null
    }

    /** [known] is the server's copy when the metadata write answered one (null: it could not be read); otherwise the machine's. */
    @Suppress("LongParameterList")
    private suspend fun conflictOutcome(d: SavesDeps, w: Written, serverVersion: Long?, known: SaveRecord?, haveKnown: Boolean): SaveResult {
        // The cache may be behind the conflict: pull before reading it, so the screen shows what the server holds (and a save
        // deleted elsewhere reads as deleted).
        val id = w.id
        val pulled = d.records.pull()
        val slots = d.records.list().size
        // The server's answer wins. [known] is the copy a rejected set carried (null: deleted). A file begin answers
        // only a version, and the cached row stands in for it only while it is that very version; a stale row is
        // never presented as the server's copy.
        val remote: SaveSummary?
        val version: Long?
        if (haveKnown) {
            remote = known?.let { summary(d, it) }
            version = known?.version ?: serverVersion
        } else if (serverVersion == null) {
            val rec = d.records.get(id)
            remote = rec?.let { summary(d, it) }
            version = rec?.version
        } else if (serverVersion == 0L) {
            remote = null
            version = 0L
        } else {
            val rec = d.records.get(id)
            if (rec != null && rec.version >= serverVersion) {
                remote = summary(d, rec)
                version = rec.version
            } else if (pulled && rec == null) {
                // Pulled and gone: a tombstone's version, not a copy.
                remote = null
                version = null
            } else {
                remote = SaveSummary(id, serverVersion, JsonObject(emptyMap()), null, false)
                version = serverVersion
            }
        }
        val request = openSlot(d, w, remote, version, slots < SYNC_SAVE_SLOTS)
        return SaveResult.Conflict(request)
    }

    /** What a write sent, for the request a conflict opens. */
    private class Written(
        val id: String,
        val metadata: JsonObject,
        val source: RangedSource,
        val onProgress: ((Long, Long) -> Unit)?,
        val base: JsonElement,
    )

    // -- requests (S1, S3, S4) -----------------------------------------------------------------------------------

    private fun requestId(id: String): String = "w:$SAVES_COLLECTION/$id"

    private fun isChunked(d: SavesDeps, source: RangedSource): Boolean =
        SyncTransferPlan.plan(d.codec.storedSize(source.size.toLong()), d.delta).mode == SyncTransferPlan.Mode.CHUNKS

    private fun numberOf(v: JsonElement?): Long? = (v as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toDoubleOrNull()?.toLong()

    private fun stringOf(v: JsonElement?): String? = (v as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun localSide(slot: Slot): MergeSide = MergeSide(
        slot.metadata,
        slot.base,
        numberOf(slot.metadata[SAVE_SAVED_AT_KEY]),
        stringOf(slot.metadata[SAVE_DEVICE_KEY]),
        MergeFile(slot.source.size.toLong(), if (slot.chunks) "chunks" else "whole"),
    )

    private fun remoteSide(slot: Slot, version: Long?): MergeSide? = slot.remote?.let { r ->
        MergeSide(
            r.metadata,
            version ?: r.version,
            numberOf(r.metadata[SAVE_SAVED_AT_KEY]),
            stringOf(r.metadata[SAVE_DEVICE_KEY]),
            r.file?.let { MergeFile(it.size, it.format) },
        )
    }

    private fun view(slot: Slot, version: Long?, state: String, error: String?): MergeView {
        val choices = mutableListOf(MergeChoice.local, MergeChoice.remote)
        if (slot.remote != null && slot.slotsFree) choices.add(MergeChoice.both)
        return MergeView(
            requestId(slot.id),
            MergeCause.write,
            SAVES_COLLECTION,
            slot.id,
            localSide(slot),
            remoteSide(slot, version),
            choices,
            state,
            error,
        )
    }

    /** S1: open the slot's request, or (a keep conflicted again) bring the open one up to date. */
    private fun openSlot(d: SavesDeps, w: Written, remote: SaveSummary?, version: Long?, slotsFree: Boolean): MergeRequest {
        val remoteVersion: JsonElement = if (remote == null || (version ?: 0L) == 0L) JsonPrimitive("*") else JsonPrimitive(version)
        val base = (w.base as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toLongOrNull()
        val chunks = isChunked(d, w.source)
        val have = slots[w.id]
        val slot = if (have != null) {
            have.metadata = w.metadata
            have.source = w.source
            have.onProgress = w.onProgress
            have.base = base
            have.remote = remote
            have.remoteVersion = remoteVersion
            have.slotsFree = slotsFree
            have.chunks = chunks
            have.reopen = have.keeping
            have
        } else {
            Slot(w.id, w.metadata, w.source, w.onProgress, base, remote, remoteVersion, slotsFree, chunks).also { slots[w.id] = it }
        }
        val v = view(slot, version, if (slot.keeping) "applying" else "open", null)
        if (slot.keeping) {
            // The keep ends first; `keepSlot` reopens the request for the person.
            merge.update(v.id) { v }
            return checkNotNull(merge.find(v.id))
        }
        return merge.open(v) { choice -> keepSlot(w.id, choice) }
    }

    private fun closeSlot(id: String, how: String) {
        slots.remove(id)
        merge.close(requestId(id), how)
    }

    /** S4: answer the slot's request; the transfer's outcome settles the result. */
    @Suppress("CyclomaticComplexMethod", "LongMethod", "ReturnCount")
    private suspend fun keepSlot(id: String, choice: MergeKeep): MergeOutcome {
        val slot = slots[id] ?: return MergeOutcome.Refused(ErrorCode.syncMergeClosed, reopened = false)
        val rid = requestId(id)
        val name = choice.choice
        slot.keeping = true
        slot.reopen = false
        merge.update(rid) { it.copy(state = "applying", error = null) }
        fun reopen(code: String): MergeOutcome {
            slot.keeping = false
            val again = slot.reopen
            slot.reopen = false
            val v = view(slot, slot.remote?.version, "open", if (again) null else code)
            merge.update(rid) { v }
            if (again) merge.reannounce(rid)
            return MergeOutcome.Refused(if (again) "conflict" else code, reopened = true)
        }
        val d = deps()
        if (choice is MergeKeep.Remote) {
            // Pull first, so the cache holds the copy the person chose (not this device's old one).
            d.records.pull()
            val rec = d.records.get(id)
            if (rec != null) seen[id] = rec.version
            closeSlot(id, "remote")
            return MergeOutcome.Kept("remote", rec?.version)
        }
        if (choice is MergeKeep.Both && !slot.slotsFree) return reopen(SavesException.SLOTS_FULL)
        val mode: WriteMode = if (choice is MergeKeep.Both) WriteMode.Copy else WriteMode.Base(slot.remoteVersion)
        return when (val out = run(SaveWrite(id, slot.source, slot.metadata, mode), slot.onProgress).await()) {
            is SaveResult.Done -> {
                closeSlot(id, name)
                MergeOutcome.Kept(name, out.version, out.copyId)
            }

            is SaveResult.Conflict -> reopen("conflict")

            is SaveResult.Failed -> reopen(out.error.code)

            SaveResult.Cancelled -> reopen("cancelled")
        }
    }
}

/** The engine part of one attempt: [pause] cancels it alone, and nothing else (the metadata write is not paused). */
internal class Phase {
    @Volatile var job: Job? = null

    /** A pause cancelled the engine part; set under the transfer's lock, so a resume that lands first cannot hide it. */
    @Volatile var pauseRequested: Boolean = false

    suspend fun <T> engine(block: suspend () -> T): T = coroutineScope {
        val j = async { block() }
        job = j
        try {
            j.await()
        } finally {
            job = null
        }
    }
}

/**
 * A write in flight. [pause] stops the engine and keeps the journal, [resume] runs it again from where the journal
 * says, [cancel] releases the server's upload and stops waiting for the metadata write (D-8: a cancelled transfer is
 * [TransferState.CANCELLED], not an error).
 */
@Suppress("TooManyFunctions")
public class SaveTransfer internal constructor(
    public val id: String,
    private val scope: CoroutineScope,
    private val attempt: suspend (Phase) -> SaveResult,
    private val release: suspend () -> Unit,
    private val onSettle: (SaveResult) -> Unit,
    total: Long = 0,
) {
    private val lock = Any()
    private val result = CompletableDeferred<SaveResult>()
    private var job: Job? = null
    private var phase: Phase? = null
    private var gate: CompletableDeferred<Unit>? = null
    private var wanted = Wanted.RUN
    private var settling = false

    private enum class Wanted { RUN, PAUSE, CANCEL }

    @Volatile public var state: TransferState = TransferState.RUNNING
        private set

    /** Plaintext bytes accounted for. */
    @Volatile public var done: Long = 0
        private set

    /** The file's size. */
    @Volatile public var total: Long = total
        private set

    internal fun progress(done: Long, total: Long) {
        this.done = done
        this.total = total
    }

    internal fun start() {
        // Atomic: the body always runs, so a cancel before it starts still settles the transfer.
        synchronized(lock) { job = scope.launch(start = CoroutineStart.ATOMIC) { drive() } }
    }

    /** Settles on done, kept-remote, cancelled, failed or conflict; never throws. */
    public suspend fun await(): SaveResult = result.await()

    /** Stop moving bytes and keep the journal. A write already waiting for the metadata answer is not paused. */
    public fun pause() {
        synchronized(lock) {
            val running = phase?.job ?: return
            if (state != TransferState.RUNNING || wanted != Wanted.RUN) return
            wanted = Wanted.PAUSE
            gate = CompletableDeferred()
            phase?.pauseRequested = true
            running.cancel()
        }
    }

    public fun resume() {
        synchronized(lock) {
            if (wanted != Wanted.PAUSE) return
            wanted = Wanted.RUN
            gate?.complete(Unit)
        }
    }

    /**
     * Settles the transfer as cancelled, whether it is moving bytes, paused or waiting for the metadata answer. A metadata
     * write already queued is not recalled: it is exact, so it only lands at its base version.
     */
    public suspend fun cancel() {
        synchronized(lock) {
            if (state != TransferState.RUNNING && state != TransferState.PAUSED) return
            wanted = Wanted.CANCEL
            gate?.complete(Unit)
            job?.cancel()
        }
        result.await()
    }

    private fun settle(s: TransferState, r: SaveResult) {
        // The first settle wins. The settled hook runs before the result is released, so a caller that sees the
        // outcome (await, result) always finds the transfer already off the running map and its event delivered.
        val first = synchronized(lock) {
            val claim = !result.isCompleted && !settling
            if (claim) {
                settling = true
                state = s
            }
            claim
        }
        if (!first) return
        try {
            onSettle(r)
        } finally {
            result.complete(r)
        }
    }

    private suspend fun cancelNow() {
        withContext(NonCancellable) { runCatching { release() } }
        settle(TransferState.CANCELLED, SaveResult.Cancelled)
    }

    private fun stateOf(r: SaveResult): TransferState = when (r) {
        is SaveResult.Done -> TransferState.DONE
        is SaveResult.Conflict -> TransferState.CONFLICT
        is SaveResult.Failed -> TransferState.FAILED
        SaveResult.Cancelled -> TransferState.CANCELLED
    }

    private fun want(): Wanted = synchronized(lock) { wanted }

    @Suppress("NestedBlockDepth", "TooGenericExceptionCaught")
    private suspend fun drive() {
        try {
            while (true) {
                val p = Phase()
                synchronized(lock) { phase = p }
                val r = try {
                    attempt(p)
                } catch (e: CancellationException) {
                    // Only the engine part was cancelled when a pause asked for it (even if a resume has already
                    // undone it); anything else, a cancel included, goes up.
                    if (want() == Wanted.CANCEL || !p.pauseRequested) throw e
                    synchronized(lock) { state = TransferState.PAUSED }
                    val g = synchronized(lock) { gate }
                    g?.await()
                    if (want() == Wanted.CANCEL) {
                        cancelNow()
                        return
                    }
                    synchronized(lock) { state = TransferState.RUNNING }
                    continue
                }
                if (want() == Wanted.CANCEL) {
                    cancelNow()
                } else {
                    settle(stateOf(r), r)
                }
                return
            }
        } catch (e: CancellationException) {
            if (want() == Wanted.CANCEL) {
                cancelNow()
            } else {
                settle(TransferState.FAILED, SaveResult.Failed(SavesException(SavesException.TRANSFER_FAILED, "stopped", e)))
                throw e
            }
        } catch (e: Exception) {
            settle(TransferState.FAILED, SaveResult.Failed(asSavesError(e)))
        }
    }
}
