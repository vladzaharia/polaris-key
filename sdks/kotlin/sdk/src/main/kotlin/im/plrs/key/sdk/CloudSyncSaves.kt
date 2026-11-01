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

package im.plrs.key.sdk

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.core.SYNC_FILE_MAX_BYTES
import im.plrs.key.core.SYNC_KEY_PATTERN
import im.plrs.key.core.SYNC_SAVE_SLOTS
import im.plrs.key.core.arrayValue
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
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

/** Retry-After is honoured up to an hour: a save may wait out a long throttle. */
public const val SAVES_MAX_RETRY_AFTER_SECONDS: Double = 3600.0

private const val DEFAULT_MAX_BYTES: Long = 32L * 1024 * 1024
private const val HTTP_NOT_FOUND = 404
private const val COPY_ATTEMPTS = 1000
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

/** What a device tried to write when another write got there first. */
public class SaveConflict(
    public val id: String,
    public val localMetadata: JsonObject,
    public val localSize: Int,
    /** The server's copy; null when it was deleted meanwhile. */
    public val remote: SaveSummary?,
    public val serverVersion: Long?,
    /** `SaveKeep.BOTH` needs a free slot of the 16. */
    public val bothAvailable: Boolean,
)

public enum class SaveKeep { LOCAL, REMOTE, BOTH }

public sealed interface SaveResult {
    /** [copyId] is the id a `SaveKeep.BOTH` copy was written under. */
    public class Done(public val id: String, public val version: Long, public val file: RecordFile, public val copyId: String? = null) : SaveResult

    /** `resolve(…, SaveKeep.REMOTE, …)`: nothing was written. */
    public class KeptRemote(public val id: String, public val version: Long?) : SaveResult

    /** A cancelled transfer is a state, not an error (D-8). */
    public data object Cancelled : SaveResult

    public class Failed(public val error: SavesException) : SaveResult

    public class Conflict(public val conflict: SaveConflict) : SaveResult
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
    private val deps: suspend () -> SavesDeps,
) {
    private val running = ConcurrentHashMap<String, SaveTransfer>()

    /** The saves of this person, by id. */
    public suspend fun list(): List<SaveSummary> {
        val d = deps()
        return d.records.list().map { summary(d, it) }.sortedBy { it.id }
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
     * failure or a cancel. [baseVersion] is the version the caller last saw; absent is the record's current one, or
     * create-only for a new id.
     */
    public suspend fun write(
        id: String,
        bytes: ByteArray,
        metadata: JsonObject,
        baseVersion: Long? = null,
        onProgress: ((Long, Long) -> Unit)? = null,
    ): SaveTransfer = run(id, BytesSource(bytes), metadata, baseVersion?.let { WriteMode.Base(JsonPrimitive(it)) } ?: WriteMode.Plain, onProgress)

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
    ): SaveTransfer = run(id, source, metadata, baseVersion?.let { WriteMode.Base(JsonPrimitive(it)) } ?: WriteMode.Plain, onProgress)

    /**
     * Settle a conflict. `REMOTE` keeps the server's copy and writes nothing; `LOCAL` writes this device's save on top
     * of the server's version; `BOTH` writes it as a new save in a free slot.
     */
    public suspend fun resolve(conflict: SaveConflict, keep: SaveKeep, bytes: ByteArray, onProgress: ((Long, Long) -> Unit)? = null): SaveTransfer {
        deps()
        return when {
            keep == SaveKeep.REMOTE -> settled(conflict.id, SaveResult.KeptRemote(conflict.id, conflict.serverVersion))

            keep == SaveKeep.BOTH && !conflict.bothAvailable -> settled(conflict.id, SaveResult.Failed(SavesException(SavesException.SLOTS_FULL)))

            keep == SaveKeep.BOTH -> run(conflict.id, BytesSource(bytes), conflict.localMetadata, WriteMode.Copy, onProgress)

            else -> run(
                conflict.id,
                BytesSource(bytes),
                conflict.localMetadata,
                WriteMode.Base(
                    conflict.serverVersion?.let {
                        JsonPrimitive(it)
                    } ?: JsonPrimitive("*"),
                ),
                onProgress,
            )
        }
    }

    /** Delete a save; its file is collected with the record. */
    public suspend fun delete(id: String, baseVersion: Long? = null): SaveSetResult {
        checkId(id)
        val d = deps()
        val base = baseVersion ?: (d.records.get(id)?.version ?: return SaveSetResult.Rejected("not_found"))
        return d.records.delete(id, base)
    }

    /** The writes in flight (running, paused or waiting on the network). */
    public fun transfers(): List<SaveTransfer> = running.values.sortedBy { it.id }

    /** Cancel every write in flight (the person's data is gone). Each is tried whatever the other did. */
    internal suspend fun cancelAll() {
        val all = running.values.toList()
        running.clear()
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

    private suspend fun run(
        id: String,
        source: RangedSource,
        metadata: JsonObject,
        mode: WriteMode,
        onProgress: ((Long, Long) -> Unit)?,
    ): SaveTransfer {
        val d = deps()
        val transferId = "saves:$id"
        var sealed: Pair<ByteArray, String>? = null
        lateinit var transfer: SaveTransfer
        val attempt: suspend (Phase) -> SaveResult = { phase ->
            attemptWrite(d, id, transferId, source, metadata, mode, phase, { done, total ->
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
        transfer.start()
        return transfer
    }

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
                val existing = d.records.get(id)
                if (existing == null) {
                    if (d.records.list().size >= SYNC_SAVE_SLOTS) return SaveResult.Failed(SavesException(SavesException.SLOTS_FULL))
                    base = JsonPrimitive("*")
                } else {
                    base = JsonPrimitive(existing.version)
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
            if (e.reason == Reason.CONFLICT) return conflictOutcome(d, id, metadata, source.size, e.serverVersion?.toLong(), null, false)
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
            is SaveSetResult.Ok -> SaveResult.Done(id, set.version, file, targetId.takeIf { it != id })
            is SaveSetResult.Conflict -> conflictOutcome(d, id, metadata, source.size, set.server?.version, set.server, true)
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
    private suspend fun conflictOutcome(
        d: SavesDeps,
        id: String,
        metadata: JsonObject,
        size: Int,
        serverVersion: Long?,
        known: SaveRecord?,
        haveKnown: Boolean,
    ): SaveResult {
        val rec = if (haveKnown) known else d.records.get(id)
        val slots = d.records.list().size
        return SaveResult.Conflict(
            SaveConflict(id, metadata, size, rec?.let { summary(d, it) }, rec?.version ?: serverVersion, slots < SYNC_SAVE_SLOTS),
        )
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
        synchronized(lock) { state = s }
        if (result.complete(r)) onSettle(r)
    }

    private suspend fun cancelNow() {
        withContext(NonCancellable) { runCatching { release() } }
        settle(TransferState.CANCELLED, SaveResult.Cancelled)
    }

    private fun stateOf(r: SaveResult): TransferState = when (r) {
        is SaveResult.Done, is SaveResult.KeptRemote -> TransferState.DONE
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
