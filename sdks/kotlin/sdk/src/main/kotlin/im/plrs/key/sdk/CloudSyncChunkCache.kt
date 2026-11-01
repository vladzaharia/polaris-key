// The Cloud Sync chunk cache (U-23.K4, plan D-9): a port of Python `cloud_sync/chunk_cache.py`.
//
// It holds chunk objects as stored: ciphertext in end-to-end mode; in server mode the app's bytes, at the
// same protection as the state file, keyed by the 64-character lowercase hex chunk id, so a download
// fetches only the chunks the device lacks. Entries are named from the id alone, never from server text:
// [ChunkCache.get], `put` and `delete` refuse anything but such an id with [IllegalArgumentException]. A
// cache is best effort: the engine treats a failing `get` as a miss and a failing `put` as nothing, and
// it opens every cached object again before use, so a damaged entry costs a fetch. The host bounds it
// with an LRU of [chunkCacheBudget] bytes per (product, subject, collection), keeps it out of OS backup
// (on Android: under `noBackupFilesDir`, the state directory the platform module resolves), and purges it
// with the person (sign-out, forget): [ChunkCache.clear].

package im.plrs.key.sdk

import im.plrs.key.core.SYNC_CHUNK_MAX_STORED_BYTES
import im.plrs.key.core.sync.SyncCrypto
import java.io.File

public const val CLOUD_SYNC_CHUNKS_DIR: String = "cloud-sync-chunks"

/** The least a cache is allowed to hold (D-9). */
public const val CHUNK_CACHE_MIN_BYTES: Long = 256L * 1024 * 1024

private val CACHE_ID = Regex("[0-9a-f]{64}")

/** D-9: at most max(256 MiB, twice the largest save). */
public fun chunkCacheBudget(largestSaveBytes: Long): Long {
    require(largestSaveBytes >= 0) { "largest save" }
    return maxOf(CHUNK_CACHE_MIN_BYTES, 2 * largestSaveBytes)
}

/** True for a chunk id that is safe to turn into a file or key name. */
public fun isChunkCacheId(id: String): Boolean = CACHE_ID.matches(id)

private fun checkId(id: String) = require(isChunkCacheId(id)) { "chunk cache id" }

public interface ChunkCache {
    public fun get(id: String): ByteArray?

    public fun put(id: String, obj: ByteArray)

    public fun delete(id: String)

    /** Drop every entry: the purge that goes with the person. */
    public fun clear()
}

/** An in-memory LRU: tests, and a host with no durable store (the cache then lasts one session). */
public class MemoryChunkCache(private val maxBytes: Long = CHUNK_CACHE_MIN_BYTES) : ChunkCache {
    private val map = LinkedHashMap<String, ByteArray>() // oldest first
    private var total = 0L

    @Synchronized override fun get(id: String): ByteArray? {
        checkId(id)
        val v = map.remove(id) ?: return null
        map[id] = v
        return v.copyOf()
    }

    @Synchronized override fun put(id: String, obj: ByteArray) {
        checkId(id)
        map.remove(id)?.let { total -= it.size }
        if (obj.size > maxBytes) return
        map[id] = obj.copyOf()
        total += obj.size
        while (total > maxBytes && map.isNotEmpty()) {
            val oldest = map.keys.first()
            total -= map.remove(oldest)!!.size
        }
    }

    @Synchronized override fun delete(id: String) {
        checkId(id)
        map.remove(id)?.let { total -= it.size }
    }

    @Synchronized override fun clear() {
        map.clear()
        total = 0
    }
}

/** `<stateDir>/cloud-sync-chunks/<hash(subject)>/<hash(collection)>`: one person's chunks never serve another's. */
public fun chunkCacheDir(stateDir: File, subject: String, collection: String): File {
    fun h(s: String) = SyncCrypto.sha256(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    return File(File(File(stateDir, CLOUD_SYNC_CHUNKS_DIR), h(subject)), h(collection))
}

/** The cache on disk: an LRU of at most [maxBytes], one file per object named by its chunk id (0600). */
public class FileChunkCache(public val dir: File, private val maxBytes: Long = CHUNK_CACHE_MIN_BYTES) : ChunkCache {
    private var index: LinkedHashMap<String, Int>? = null // id -> size, oldest first; null until scanned
    private var total = 0L

    private fun path(id: String) = File(dir, id)

    /** The directory's entries, oldest first (by modification time), scanned once. */
    private fun load(): LinkedHashMap<String, Int> {
        index?.let { return it }
        val found = ArrayList<Triple<Long, String, Int>>()
        for (f in dir.listFiles() ?: emptyArray()) {
            if (!isChunkCacheId(f.name)) {
                // A temporary file a crash left behind, or anything else we did not write.
                if (f.name.endsWith(".tmp")) f.delete()
                continue
            }
            if (!f.isFile || f.length() > SYNC_CHUNK_MAX_STORED_BYTES) {
                f.delete()
                continue
            }
            found.add(Triple(f.lastModified(), f.name, f.length().toInt()))
        }
        found.sortWith(compareBy({ it.first }, { it.second }))
        val idx = LinkedHashMap<String, Int>()
        for ((_, name, size) in found) idx[name] = size
        total = found.sumOf { it.third.toLong() }
        index = idx
        return idx
    }

    private fun drop(id: String) {
        load().remove(id)?.let { total -= it }
        path(id).delete()
    }

    @Synchronized override fun get(id: String): ByteArray? {
        checkId(id)
        val idx = load()
        val size = idx[id] ?: return null
        val data = runCatching { path(id).readBytes() }.getOrNull()
        if (data == null || data.size != size) {
            drop(id)
            return null
        }
        idx.remove(id)
        idx[id] = size // newest goes last, here and on disk
        path(id).setLastModified(System.currentTimeMillis())
        return data
    }

    @Synchronized override fun put(id: String, obj: ByteArray) {
        checkId(id)
        load()
        drop(id)
        if (obj.size > maxBytes || obj.size > SYNC_CHUNK_MAX_STORED_BYTES) return
        cloudSyncWriteAtomic(path(id), obj)
        val idx = load()
        idx[id] = obj.size
        total += obj.size
        val it = idx.entries.iterator()
        while (total > maxBytes && it.hasNext()) {
            val e = it.next()
            if (e.key == id) continue
            path(e.key).delete()
            total -= e.value
            it.remove()
        }
    }

    @Synchronized override fun delete(id: String) {
        checkId(id)
        load()
        drop(id)
    }

    @Synchronized override fun clear() {
        dir.deleteRecursively()
        index = LinkedHashMap()
        total = 0
    }
}
