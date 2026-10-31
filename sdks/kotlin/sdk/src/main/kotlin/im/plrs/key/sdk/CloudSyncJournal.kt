// The Cloud Sync transfer journal (U-23.K4): what an interrupted file upload needs to carry on after a kill. A
// port of Python `cloud_sync/journal.py`. Host-local state, never a wire shape, so it has no corpus family; the
// unit tests prove it.
//
//   {v: 1, id, kind: "upload", collection, record, uploadId, mode, partBytes, done: [...], sha256, size,
//    expiresAt, state}
//
// `mode` is single, multipart or chunks; `done` is the part numbers the server holds, ascending (always empty
// for chunks, whose record only lets the next run abort the previous upload); `state` is uploading, then
// finalizing; a finished transfer's record is deleted. A reader refuses a `v` it does not know and leaves the
// record alone. A record holds ids, counts, hashes and times: no key, no plaintext, no bearer token.
//
// On disk ([FileJournal]) a record is one JSON file in `<state dir>/cloud-sync-transfers/` named by the
// SHA-256 of the transfer id, never by the id (the id is the caller's text, so no id can climb out of the
// directory or collide with another file), owner-only (0600 in a 0700 directory) where the platform has modes,
// written to a temporary name and renamed into place. On Android the state directory is the app's private
// no-backup directory (`noBackupFilesDir`, Q-6), which the platform module resolves: nothing here moves the
// file elsewhere, and Auto Backup and device transfer skip it. The directory is purged with the person
// ([FileJournal.clear]).

package im.plrs.key.sdk

import im.plrs.key.core.JsonText
import im.plrs.key.core.RuntimeFamily
import im.plrs.key.core.SYNC_FILE_MAX_BYTES
import im.plrs.key.core.SYNC_MAX_PARTS
import im.plrs.key.core.StoreException
import im.plrs.key.core.arrayValue
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.sync.SyncCrypto
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermissions
import java.util.UUID

public const val TRANSFER_JOURNAL_VERSION: Int = 1
public const val CLOUD_SYNC_TRANSFERS_DIR: String = "cloud-sync-transfers"

private const val JOURNAL_MAX_BYTES = 1024 * 1024
private val HEX64 = Regex("[0-9a-f]{64}")
private val JOURNAL_FILE = Regex("[0-9a-f]{64}\\.json")

/** One upload's record. [expiresAt] is Unix seconds, from `begin`. */
public data class JournalRecord(
    val id: String,
    val collection: String,
    val record: String,
    val uploadId: String,
    /** `single`, `multipart` or `chunks`. */
    val mode: String,
    val partBytes: Int?,
    val done: List<Int>,
    val sha256: String,
    val size: Int,
    val expiresAt: Double,
    /** `uploading`, then `finalizing`. */
    val state: String,
) {
    /** The record as JSON, the form a store keeps. */
    public fun toJson(): JsonObject = buildJsonObject {
        put("v", TRANSFER_JOURNAL_VERSION)
        put("id", id)
        put("kind", "upload")
        put("collection", collection)
        put("record", record)
        put("uploadId", uploadId)
        put("mode", mode)
        put("partBytes", partBytes?.let { JsonPrimitive(it) } ?: JsonNull)
        put("done", JsonArray(done.map { JsonPrimitive(it) }))
        put("sha256", sha256)
        put("size", size)
        put("expiresAt", expiresAt)
        put("state", state)
    }
}

/** Why a stored record was refused: [version] for a `v` this build does not know, otherwise [shape]. */
public class TransferJournalException(public val version: Boolean) :
    Exception(if (version) "transfer journal: version" else "transfer journal: shape")

private fun text(o: JsonObject, key: String): String? = o[key].stringValue?.takeIf { it.isNotEmpty() }

/** The record, or a [TransferJournalException]. The result is a fresh value; the input is not touched. */
public fun parseJournalRecord(raw: JsonElement?): JournalRecord {
    val o = raw as? JsonObject ?: throw TransferJournalException(false)
    if (o["v"].longValue != TRANSFER_JOURNAL_VERSION.toLong()) throw TransferJournalException(true)
    val mode = text(o, "mode")
    val sha = text(o, "sha256")
    val size = o["size"].longValue
    val expires = (o["expiresAt"] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toDoubleOrNull()
    val state = text(o, "state")
    val done = o["done"].arrayValue
    val sound = text(o, "id") != null && o["kind"].stringValue == "upload" && text(o, "collection") != null &&
        text(o, "record") != null && text(o, "uploadId") != null && mode in listOf("single", "multipart", "chunks") &&
        sha != null && HEX64.matches(sha) && size != null && size in 0..SYNC_FILE_MAX_BYTES &&
        expires != null && expires.isFinite() && state in listOf("uploading", "finalizing") && done != null
    if (!sound) throw TransferJournalException(false)
    var parts = 1L
    var partBytes: Int? = null
    if (mode == "multipart") {
        val pb = o["partBytes"].longValue
        if (pb == null || pb < 1 || pb > Int.MAX_VALUE) throw TransferJournalException(false)
        parts = maxOf(1L, (size!! + pb - 1) / pb)
        if (parts > SYNC_MAX_PARTS) throw TransferJournalException(false)
        partBytes = pb.toInt()
    } else if (o["partBytes"] != null && o["partBytes"] !is JsonNull) {
        throw TransferJournalException(false)
    }
    if (mode == "chunks" && done!!.isNotEmpty()) throw TransferJournalException(false)
    var last = 0L
    val numbers = done!!.map { e ->
        val n = e.longValue
        if (n == null || n <= last || n > parts) throw TransferJournalException(false)
        last = n
        n.toInt()
    }
    return JournalRecord(
        text(o, "id")!!, text(o, "collection")!!, text(o, "record")!!, text(o, "uploadId")!!, mode!!, partBytes, numbers, sha!!,
        size!!.toInt(), expires!!, state!!,
    )
}

/** Where records live. [get] returns what was stored, unchecked: the engine validates the version. */
public interface JournalStore {
    public fun get(id: String): JsonElement?

    public fun put(id: String, record: JournalRecord)

    public fun delete(id: String)

    /** The ids held. */
    public fun list(): List<String>
}

/** An in-memory journal: tests, and a host with nothing durable (a transfer then does not survive a kill). */
public class MemoryJournal : JournalStore {
    private val map = LinkedHashMap<String, JsonElement>()

    @Synchronized override fun get(id: String): JsonElement? = map[id]

    @Synchronized override fun put(id: String, record: JournalRecord) {
        map[id] = record.toJson()
    }

    /** A raw value, as a foreign build would have left it (tests). */
    @Synchronized public fun putRaw(id: String, value: JsonElement) {
        map[id] = value
    }

    @Synchronized override fun delete(id: String) {
        map.remove(id)
    }

    @Synchronized override fun list(): List<String> = map.keys.toList()
}

/** The file a transfer id lives in: the lowercase hex SHA-256 of the id, `.json`. */
public fun journalFileName(id: String): String = SyncCrypto.sha256(id.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) } + ".json"

/**
 * Write [bytes] to [target] the way the state file is written: a temporary name beside it created exclusively
 * (no symlink followed) with owner-only permissions where the platform has them, flushed to disk, then renamed
 * over the target. The directory is created (0700). A failed write leaves no temporary file.
 */
internal fun cloudSyncWriteAtomic(target: File, bytes: ByteArray) {
    val dir = target.parentFile ?: throw StoreException("no directory")
    if (!dir.isDirectory) {
        if (!dir.mkdirs() && !dir.isDirectory) throw StoreException("could not create the directory")
        if (!RuntimeFamily.isAndroid) {
            runCatching { Files.setPosixFilePermissions(dir.toPath(), PosixFilePermissions.fromString("rwx------")) }
        }
    }
    val tmp = File(dir, "${target.name}.${UUID.randomUUID()}.tmp")
    try {
        if (RuntimeFamily.isAndroid) {
            if (!tmp.createNewFile()) throw IOException("temporary file exists")
            tmp.setReadable(false, false)
            tmp.setReadable(true, true)
            tmp.setWritable(false, false)
            tmp.setWritable(true, true)
            java.io.FileOutputStream(tmp).use {
                it.write(bytes)
                it.fd.sync()
            }
            if (!tmp.renameTo(target)) throw IOException("could not replace the file")
        } else {
            val perms = runCatching { PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")) }.getOrNull()
            val opts = setOf(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)
            val channel = if (perms != null) FileChannel.open(tmp.toPath(), opts, perms) else FileChannel.open(tmp.toPath(), opts)
            channel.use {
                it.write(ByteBuffer.wrap(bytes))
                it.force(true)
            }
            runCatching { Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING) }
                .recoverCatching { Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING) }
                .getOrThrow()
        }
    } catch (e: IOException) {
        tmp.delete()
        throw StoreException("could not write the file", e)
    }
}

/** The journal on disk. [stateDir] is the host's state directory; the journal sits in a folder of its own. */
public class FileJournal(stateDir: File) : JournalStore {
    public val dir: File = File(stateDir, CLOUD_SYNC_TRANSFERS_DIR)

    /** Writes and deletes run one at a time, so a late write never lands after a delete. */
    private val lock = Any()

    private fun file(id: String): File = File(dir, journalFileName(id))

    private fun read(f: File): JsonElement? = runCatching {
        val plain = f.isFile && f.length() <= JOURNAL_MAX_BYTES && f.canonicalFile.parentFile == dir.canonicalFile
        if (plain) JsonText.parseOrNull(f.readText(Charsets.UTF_8)) else null
    }.getOrNull()

    /** A missing file or one that is not JSON is null; a record of another version or shape is returned as found. */
    override fun get(id: String): JsonElement? = read(file(id))

    override fun put(id: String, record: JournalRecord) {
        synchronized(lock) { runCatching { cloudSyncWriteAtomic(file(id), record.toJson().toString().toByteArray(Charsets.UTF_8)) } }
    }

    override fun delete(id: String) {
        synchronized(lock) { file(id).delete() }
    }

    /** The ids of the records held, keeping only a record whose file name is the hash of its own id. */
    override fun list(): List<String> = (dir.listFiles() ?: emptyArray()).filter { JOURNAL_FILE.matches(it.name) }.mapNotNull { f ->
        val rid = read(f).objectValue?.get("id").stringValue
        rid?.takeIf { journalFileName(it) == f.name }
    }

    /** The purge that goes with the person (sign-out, forget). */
    public fun clear() {
        synchronized(lock) { dir.deleteRecursively() }
    }
}
