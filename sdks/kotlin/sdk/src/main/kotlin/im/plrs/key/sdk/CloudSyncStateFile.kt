// The Cloud Sync host's state file: `<state dir>/cloud-sync.json` (H-6). It holds the machine's journal,
// the catalog last served by `/config/schema` (so a relaunch routes settings before the first fetch) and
// the names of the person's open settings (so a blinded tombstone can be mapped back).
//
// The file holds the WHOLE opened snapshot of the signed-in person's settings, not only the pending
// edits: whoever signs out, or loses the account, must purge it ([remove]); until then it is as
// sensitive as the settings themselves. The root is never written: the key ring keeps it in memory.
//
// A write creates its temporary file exclusively (CREATE_NEW, no symlink followed) with owner-only
// permissions where the platform has them, flushes it to disk, then renames it over the file, so a
// planted symlink or file is refused and the target of a symlink at the final name is never written
// through. On Android the state directory is the app's private no-backup directory (Q-6): the store
// resolves it, and nothing here moves the file elsewhere.

package im.plrs.key.sdk

import im.plrs.key.core.JsonText
import im.plrs.key.core.RuntimeFamily
import im.plrs.key.core.StoreException
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
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

public const val CLOUD_SYNC_FILE: String = "cloud-sync.json"

/** Holds no data: it says the legacy `config.local` store was offered to the machine once (A-6). Purge leaves it. */
public const val CLOUD_SYNC_IMPORTED_FILE: String = "cloud-sync-imported.json"

/** Open-setting names kept for tombstone mapping; past this the oldest are dropped. */
public const val OPEN_KEYS_MAX: Int = 4096

/** What the file holds (after `load` validated it). */
public class CloudSyncFileContents(public val persisted: JsonObject?, public val catalog: JsonObject?, public val openKeys: List<String>)

/** The catalog's outer shape; the host derives routes from it with `SyncRoutes.syncedSettings`. */
internal fun isCatalogShape(v: JsonElement?): Boolean = v is JsonObject && v["schemaVersion"].longValue != null && v["entries"] is JsonArray

/** Test seam: take the java.io path of an Android below API 26 on any runtime. */
internal var forceLegacyIo: Boolean = false

private val nioAvailable: Boolean by lazy {
    try {
        Class.forName("java.nio.file.Files")
        true
    } catch (e: Throwable) {
        false
    }
}

private fun legacyIo(): Boolean = forceLegacyIo || !nioAvailable

public class CloudSyncStateFile(private val dir: File, private val product: String) {
    public val file: File = File(dir, CLOUD_SYNC_FILE)
    private val lock = Any()

    /** Delete the file (after any write in progress). Throws if it stays. */
    public fun remove() {
        synchronized(lock) {
            // java.nio.file arrives on API 26 and the minimum is 24: Android below that deletes through java.io.
            if (legacyIo()) {
                if (file.exists() && !file.delete()) throw IOException("could not remove the Cloud Sync state")
            } else {
                Files.deleteIfExists(file.toPath())
            }
        }
    }

    /** Whether the legacy store was offered to the machine already. */
    public fun imported(): Boolean = File(dir, CLOUD_SYNC_IMPORTED_FILE).isFile

    public fun markImported() {
        synchronized(lock) { writeAtomic("""{"v":1}""".toByteArray(Charsets.UTF_8), File(dir, CLOUD_SYNC_IMPORTED_FILE)) }
    }

    /** Delete every leftover temporary file of a write (a crash, or a purge racing a write). */
    public fun sweepTemporaries() {
        synchronized(lock) {
            dir.listFiles { f -> f.name.startsWith("$CLOUD_SYNC_FILE.") && f.name.endsWith(".tmp") }?.forEach { it.delete() }
        }
    }

    /** The saved file, or an empty one when it is missing, corrupt, a symlink or another product's. */
    public fun load(): CloudSyncFileContents {
        val empty = CloudSyncFileContents(null, null, emptyList())
        val raw = readJson() as? JsonObject
        if (raw == null || raw["v"].longValue != 1L || raw["product"].stringValue != product) return empty
        val persisted = raw["persisted"].objectValue
        val keys = raw["openKeys"].arrayValue?.mapNotNull { it.stringValue }.orEmpty()
        return CloudSyncFileContents(
            persisted?.takeIf { it["partitions"] is JsonObject && it["hlc"] is JsonArray && it["contacted"].boolValue != null },
            raw["catalog"].objectValue?.takeIf { isCatalogShape(it) },
            keys.takeLast(OPEN_KEYS_MAX),
        )
    }

    public fun save(persisted: JsonObject, catalog: JsonObject?, openKeys: List<String>, allowed: () -> Boolean = { true }) {
        val body = buildJsonObject {
            put("v", 1)
            put("product", product)
            put("persisted", persisted)
            put("catalog", catalog ?: JsonNull)
            put("openKeys", JsonArray(openKeys.map { JsonPrimitive(it) }))
        }
        // Checked under the same lock [remove] takes: after a purge removed the file, no save lands (H-7).
        synchronized(lock) { if (allowed()) writeAtomic(body.toString().toByteArray(Charsets.UTF_8)) }
    }

    private fun readJson(): JsonElement? = runCatching {
        if (legacyIo()) {
            // No symlink API below 26: a file whose canonical path is not its own path is a link and reads as empty.
            val plain = file.isFile && file.canonicalFile.path == File(file.parentFile.canonicalFile, file.name).path
            return@runCatching if (plain) JsonText.parseOrNull(file.readText(Charsets.UTF_8)) else null
        }
        val p = file.toPath()
        val plain = !Files.isSymbolicLink(p) && Files.isRegularFile(p, LinkOption.NOFOLLOW_LINKS)
        if (plain) JsonText.parseOrNull(file.readText(Charsets.UTF_8)) else null
    }.getOrNull()

    private fun writeAtomic(bytes: ByteArray, target: File = file) {
        if (!dir.isDirectory && !dir.mkdirs() && !dir.isDirectory) throw StoreException("could not create the state directory")
        val tmp = File(dir, "${target.name}.${UUID.randomUUID()}.tmp")
        try {
            if (RuntimeFamily.isAndroid) writeAndroid(tmp, bytes, target) else writePosix(tmp, bytes, target)
        } catch (e: IOException) {
            tmp.delete()
            throw StoreException("could not write the Cloud Sync state", e)
        }
    }

    /** Exclusive create, owner-only, fsync, then rename: a symlink at the target is replaced, never written through. */
    private fun writePosix(tmp: File, bytes: ByteArray, target: File) {
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

    /** java.nio.file arrives on API 26; the app-private directory is the protection, the create is exclusive. */
    private fun writeAndroid(tmp: File, bytes: ByteArray, target: File) {
        if (!tmp.createNewFile()) throw IOException("temporary file exists")
        tmp.setReadable(false, false)
        tmp.setReadable(true, true)
        tmp.setWritable(false, false)
        tmp.setWritable(true, true)
        java.io.FileOutputStream(tmp).use {
            it.write(bytes)
            it.fd.sync()
        }
        if (!tmp.renameTo(target)) throw IOException("could not replace the state file")
    }
}
