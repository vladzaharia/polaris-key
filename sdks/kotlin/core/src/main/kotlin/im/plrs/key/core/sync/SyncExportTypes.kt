// The ports and results of `cloudSync.export()` (WIRE-CONTRACT-V5 section 13.12, `pkey-sync-export/1`). The core
// ([SyncExport]) plans the archive and streams it into an [ExportSink]; it speaks to no network and opens no file. The
// host (the SDK's `CloudSyncExporter`) gives it the rows as the Worker served them, a [ExportFileSource] for the stored
// bytes, a file codec per collection and a sink over the destination.

package im.plrs.key.core.sync

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * `sync-export-failed`. [reason] is `destination` (the destination cannot be written, a disk that is full, a path that is
 * not a regular file), `network` (offline, retries spent, a Worker that answers wrongly, or a wait past its bound) or `busy`
 * (another export of this client is running). The message names no path.
 */
public class SyncExportException(public val reason: String) :
    PolarisException(ErrorCode.syncExportFailed, "The export failed: $reason", detail = reason) {
    public companion object {
        public const val DESTINATION: String = "destination"
        public const val NETWORK: String = "network"
        public const val BUSY: String = "busy"
    }
}

/** Where the archive goes: [write] is called in order. Committing and discarding the destination belong to the host. */
public fun interface ExportSink {
    /** The next [length] bytes of [bytes] from [offset]. May throw (a full disk): the export stops and the host discards the destination. */
    public fun write(bytes: ByteArray, offset: Int, length: Int)
}

/** Names one stored file: the record's wire id (blinded in end-to-end mode), a version, its format and the pointer's size (already checked). */
public class ExportFileRef(
    public val collection: String,
    public val record: String,
    public val version: JsonElement,
    /** `whole`, or `chunks` (the stored bytes are then the manifest's). */
    public val format: String,
    public val size: Long,
)

/** The stored bytes of one version, in pieces. The export closes it once it has what it plans for. */
public interface ExportStored : AutoCloseable {
    /** The next piece, or null at the end (also when the Worker has no such file). May throw what the transport throws. */
    public suspend fun next(): ByteArray?

    override fun close() {}
}

/**
 * Where a file's stored bytes come from. The transport's retries, `Range` resume, the hourly allowance and the bounded
 * waits are the source's. A missing object is not a throw: [stored] yields nothing and [chunk] answers null, and the file
 * is then written short and flagged partial.
 */
public interface ExportFileSource {
    /** Every kept version of a record's file, the current one included, in any order: `version`, `size`, `sha256` and `format` as served. */
    public suspend fun pointers(collection: String, record: String): List<JsonObject>

    /** The stored bytes of a version: a whole file, or the manifest of a chunked one. */
    public suspend fun stored(ref: ExportFileRef): ExportStored

    /** A chunk object by its id (64 lowercase hex), or null. */
    public suspend fun chunk(collection: String, idHex: String): ByteArray?
}

/** Opens a stored whole file as it arrives; [push] answers the plaintext of each segment that has verified. Throws [SyncFileStream.Failure]. */
public interface ExportFileOpener {
    /** A failure after good segments comes on the next call, so the good ones are returned first. */
    public fun push(data: ByteArray): List<ByteArray>

    /** The input has ended: throws when a planned segment is missing. */
    public fun finish()
}

/** What the export needs to know about how a collection stores its files; the root stays inside the implementation. */
public interface ExportFileCodec {
    /** The stored size of a file of [plainSize] bytes. */
    public fun storedSize(plainSize: Long): Long

    /** The plaintext size a stored size implies (the sealed size in end-to-end mode, the same in server mode), or null. */
    public fun plainSize(storedSize: Long): Long?

    /** The manifest's plaintext, or null when [stored] does not open. */
    public fun openManifest(stored: ByteArray): ByteArray?

    /** A chunk object's plaintext under [id], or null when it does not open. */
    public fun openChunk(id: ByteArray, obj: ByteArray): ByteArray?

    /** An opener of a whole file whose last segment is known from the plan: a stream cut on a segment boundary still yields every whole segment. */
    public fun newPlannedOpener(plainSize: Long): ExportFileOpener
}

/** Test and host overrides of the bounds; [maxBytes] is the zip32 total of section 13.12. */
public class ExportCaps(public val maxEntries: Int? = null, public val maxBytes: Long? = null)

@Suppress("LongParameterList")
public class ExportInput(
    public val product: String,
    /** The device clock, in milliseconds. */
    public val exportedAt: Long,
    /** Edits not yet pushed. */
    public val unsynced: Int,
    public val includeRevisions: Boolean,
    /** The changes of the pull as served (sealed in end-to-end mode): settings and records. */
    public val changes: List<JsonElement>,
    public val files: ExportFileSource,
    /** The host codec in end-to-end mode; null is server mode. */
    public val codec: SyncCodecPort?,
    public val fileCodec: (collection: String) -> ExportFileCodec,
    public val caps: ExportCaps? = null,
    /** Plaintext file bytes written so far, and the planned total. */
    public val onProgress: ((done: Long, total: Long) -> Unit)? = null,
)

@Suppress("LongParameterList")
public class ExportSummary(
    /** Bytes sent to the sink. */
    public val bytes: Long,
    /** The zip32 total the plan counted before the first byte. */
    public val plannedBytes: Long,
    public val entries: Int,
    public val settings: Int,
    public val records: Int,
    public val files: Int,
    /** What could not be written, as `data.json` lists it. */
    public val skipped: List<JsonObject>,
)
