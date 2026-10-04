// In-memory pack storage and state store (client-core `packs/memory.ts`; Swift's `Memory.swift` the
// structural model): the `PackStorage` and `PackStateStore` a test, a corpus harness or a host
// without persistent storage runs the engine over. Nothing survives the process.

package im.plrs.key.packs

/** One stored payload: a container's bytes or a tree's files, and the index kept with it. */
public class MemoryPayload(public val layout: String, public val payload: ByteArray?, public val tree: Map<String, ByteArray>?, public val index: FilesIndexDoc?)

private class MemoryOutput {
    var buf = ByteArray(0)
    var length = 0
    val tree = LinkedHashMap<String, ByteArray>()

    fun write(offset: Long, bytes: ByteArray) {
        val end = offset.toInt() + bytes.size
        if (buf.size < end) buf = buf.copyOf(maxOf(end, buf.size * 2))
        bytes.copyInto(buf, offset.toInt())
        length = maxOf(length, end)
    }

    fun read(offset: Long, n: Int): ByteArray {
        if (n <= 0 || offset < 0) return ByteArray(0)
        val lo = minOf(offset.toInt(), length)
        val hi = minOf(offset.toInt() + n, length)
        return buf.copyOfRange(lo, hi)
    }
}

/** [PackStorage] over maps. [freeDiskBytes] is what the planner is told (default 1 GiB). */
public class MemoryPackStorage(public val freeDiskBytes: Long = 1L shl 30) : PackStorage {
    private val lock = Any()

    /** The stored payloads by location (`<packId>/<payloadSha256>`). */
    public val store: MutableMap<String, MemoryPayload> = LinkedHashMap()

    /** The staged objects by plan id, then SHA-256. */
    public val staging: MutableMap<String, MutableMap<String, java.io.ByteArrayOutputStream>> = LinkedHashMap()
    private val outputs = HashMap<String, MemoryOutput>()

    /** The seed indexes by `chunks.sha256` (P4-11). */
    public val indexes: MutableMap<String, ByteArray> = LinkedHashMap()

    /** The run journals by plan id (P4-11). */
    public val journals: MutableMap<String, String> = LinkedHashMap()

    override fun stagedObject(planId: String, sha256: String): StagedObject = object : StagedObject {
        private fun obj(): java.io.ByteArrayOutputStream? = synchronized(lock) { staging[planId]?.get(sha256) }
        override fun size(): Long = obj()?.size()?.toLong() ?: 0
        override fun source(): ByteSource = MemorySource(synchronized(lock) { obj()?.toByteArray() } ?: ByteArray(0))
        override fun append(bytes: ByteArray) {
            synchronized(lock) { staging.getOrPut(planId) { LinkedHashMap() }.getOrPut(sha256) { java.io.ByteArrayOutputStream() }.write(bytes) }
        }
        override fun reset() {
            synchronized(lock) { staging[planId]?.remove(sha256) }
        }
    }

    override fun output(planId: String, layout: String, resume: Boolean): PackOutput {
        synchronized(lock) { if (!resume || !outputs.containsKey(planId)) outputs[planId] = MemoryOutput() }
        return PackOutput(
            sink = { offset, bytes -> synchronized(lock) { outputs.getOrPut(planId) { MemoryOutput() }.write(offset, bytes) } },
            tree = { path, bytes -> synchronized(lock) { outputs.getOrPut(planId) { MemoryOutput() }.tree[path] = bytes } },
            read = { offset, length -> synchronized(lock) { outputs[planId]?.read(offset, length) ?: ByteArray(0) } },
        )
    }

    override val chunkIndexes: ChunkIndexStore = object : ChunkIndexStore {
        /** Larger than `MAX_CHUNK_INDEX_BYTES` reads as absent, as the directory store. */
        override fun get(sha256: String): ByteArray? = synchronized(lock) { indexes[sha256]?.takeIf { it.size <= im.plrs.key.core.MAX_CHUNK_INDEX_BYTES } }
        override fun put(sha256: String, bytes: ByteArray) {
            synchronized(lock) { indexes[sha256] = bytes }
        }
        override fun list(): List<String> = synchronized(lock) { indexes.keys.toList() }
        override fun remove(sha256: String) {
            synchronized(lock) { indexes.remove(sha256) }
        }
    }

    override val runJournal: RunJournalStore = object : RunJournalStore {
        override fun read(planId: String): String? = synchronized(lock) { journals[planId] }
        override fun write(planId: String, text: String) {
            synchronized(lock) { journals[planId] = text }
        }
    }

    override fun commit(planId: String, packId: String, payloadSha256: String, layout: String, index: FilesIndexDoc?): String = synchronized(lock) {
        val o = outputs[planId] ?: throw PackPortException("no output for $planId")
        val location = "$packId/$payloadSha256"
        store[location] = if (layout == "tree") MemoryPayload(layout, null, LinkedHashMap(o.tree), index) else MemoryPayload(layout, o.buf.copyOf(o.length), null, index)
        outputs.remove(planId)
        location
    }

    override fun installed(install: PackInstall): InstalledPayload? {
        val p = synchronized(lock) { store[install.location] } ?: return null
        if (p.layout == "tree") {
            val files = (p.tree ?: emptyMap()).map { (path, bytes) -> InstalledFile(path, sha256Of(bytes), bytes.size.toLong(), MemorySource(bytes)) }
            return InstalledPayload(null, files)
        }
        val whole = MemorySource(p.payload ?: ByteArray(0))
        return InstalledPayload(whole, p.index?.files?.map { InstalledFile(it.path, it.sha256, it.size, sliceSource(whole, it.offset ?: 0, it.size)) })
    }

    override fun verify(install: PackInstall): Boolean {
        val p = synchronized(lock) { store[install.location] } ?: return false
        if (p.layout == "tree") {
            val files = (p.tree ?: emptyMap()).map { TreeFile(it.key, it.value.size.toLong(), sha256Of(it.value)) }
            return treeDigest(files) == install.payloadSha256
        }
        return sha256Of(p.payload ?: ByteArray(0)) == install.payloadSha256
    }

    override fun remove(location: String) {
        synchronized(lock) { store.remove(location) }
    }

    override fun removeStaging(planId: String) {
        synchronized(lock) {
            staging.remove(planId)
            outputs.remove(planId)
            journals.remove(planId)
        }
    }

    override fun list(): Pair<List<String>, List<String>> = synchronized(lock) { store.keys.toList() to staging.keys.toList() }

    override fun freeDisk(): Long = freeDiskBytes
}

/** A [PackStateStore] over one string, with its quarantine in [torn] and its hold list. */
public class MemoryPackStateStore(initial: String? = null) : PackStateStore {
    @Volatile public var text: String? = initial
    @Volatile public var torn: String? = null
    @Volatile public var holdList: String? = null

    override fun read(): String? = text
    override fun replace(text: String) {
        this.text = text
    }
    override fun quarantine(text: String) {
        synchronized(this) { if (torn == null) torn = text }
    }
    override fun quarantined(): Boolean = torn != null
    override fun clearQuarantine() {
        synchronized(this) {
            torn = null
            holdList = null
        }
    }
    override val keepsHoldList: Boolean get() = true
    override fun readHoldList(): String? = holdList
    override fun writeHoldList(text: String) {
        synchronized(this) { if (holdList == null) holdList = text }
    }
}
