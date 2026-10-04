// The directory pack store (CONTENT §9–§10; the Kotlin port of Swift's `DirStorage.swift` and
// `@polaris-key/node`'s `DirPackStorage`): staging, the content-addressed store and the install-state
// file under one directory, by default `<data dir>/packs` (the data directory the Store port gives,
// never a cache directory the OS may purge; P1b-09).
//
//   <root>/state.json                         the install state, written by temp + rename
//   <root>/state.json.torn                    a torn document held aside (never overwritten)
//   <root>/state.json.torn.list               the torn hold's snapshot of the store
//   <root>/revocations.json                   the stored revocations, only once one is stored
//   <root>/staging/<planId>/objects/<sha256>  objects being fetched (appended, resumable)
//   <root>/staging/<planId>/out/              the payload being built (files, or `payload.bin`)
//   <root>/staging/<planId>/journal.json      a chunk plan's run journal (P4-11)
//   <root>/index/<sha256>                     the seed indexes (P4-11), written by temp + rename
//   <root>/store/<packId>/<payloadSha256>/    a committed payload, never overwritten; the files
//                                             index kept at install in `.pkey/files.json`
//
// Every read distinguishes "missing" from "cannot read": only a missing file (or a missing parent)
// is missing, anything else throws. A directory listing either answers whole or throws. Files and
// directories are synced (`FileChannel.force`) before a rename names them, so a power loss never
// leaves a torn state file or a half-written payload behind a pointer. The JVM cannot issue macOS's
// F_FULLFSYNC; `force` is `fsync(2)` there. java.nio.file needs Android API 26+ (as :core's FileStore).

package im.plrs.key.packs

import im.plrs.key.core.MAX_CHUNK_INDEX_BYTES
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.AccessDeniedException
import java.nio.file.DirectoryNotEmptyException
import java.nio.file.FileAlreadyExistsException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.NoSuchFileException
import java.nio.file.NotDirectoryException
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.BasicFileAttributes

/** A failure on a pack path. */
public class PackFileException(message: String, cause: Throwable? = null) : IOException(message, cause)

private fun isMissing(e: Throwable): Boolean = e is NoSuchFileException || e is NotDirectoryException || (e is java.io.FileNotFoundException && e !is AccessDeniedException)

/** The attributes of [p] (never following a link), or null ONLY when it does not exist. */
internal fun attrsOrNull(p: Path): BasicFileAttributes? = try {
    Files.readAttributes(p, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
} catch (e: IOException) {
    if (isMissing(e)) null else throw e
}

internal fun pathExists(p: Path): Boolean = attrsOrNull(p) != null

/** A directory's entries, or null ONLY when it does not exist. Never a partial listing. */
internal fun listDirectory(p: Path): List<Pair<String, BasicFileAttributes>>? {
    val stream = try {
        Files.newDirectoryStream(p)
    } catch (e: IOException) {
        if (isMissing(e)) return null
        throw e
    }
    stream.use { s ->
        val out = ArrayList<Pair<String, BasicFileAttributes>>()
        for (child in s) {
            val a = Files.readAttributes(child, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
            out += child.fileName.toString() to a
        }
        return out
    }
}

/** fsync a file or directory by path. A file system that cannot sync a directory is not an error. */
internal fun syncPath(p: Path, directory: Boolean = Files.isDirectory(p, LinkOption.NOFOLLOW_LINKS)) {
    try {
        FileChannel.open(p, StandardOpenOption.READ).use { it.force(true) }
    } catch (e: IOException) {
        if (!directory) throw e
    } catch (e: UnsupportedOperationException) {
        if (!directory) throw PackFileException("cannot sync $p", e)
    }
}

/** fsync every file under [dir], then each directory, depth first. */
private fun syncTree(dir: Path) {
    for ((name, a) in listDirectory(dir) ?: emptyList()) {
        val c = dir.resolve(name)
        if (a.isDirectory) syncTree(c) else if (a.isRegularFile) syncPath(c, false)
    }
    syncPath(dir, true)
}

/** Write [bytes] to a new file at [p], synced. [exclusive] refuses an existing one. */
private fun writeFileSynced(p: Path, bytes: ByteArray, exclusive: Boolean = false) {
    val opts = if (exclusive) arrayOf(StandardOpenOption.WRITE, StandardOpenOption.CREATE_NEW)
    else arrayOf(StandardOpenOption.WRITE, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING)
    FileChannel.open(p, *opts).use { ch ->
        val buf = ByteBuffer.wrap(bytes)
        while (buf.hasRemaining()) ch.write(buf)
        ch.force(true)
    }
}

/** The whole of a file, or null ONLY when it does not exist. */
internal fun readFileOrNull(p: Path): ByteArray? = try {
    Files.readAllBytes(p)
} catch (e: IOException) {
    if (isMissing(e)) null else throw e
}

private fun mkdirs(p: Path) {
    Files.createDirectories(p)
}

/** `rm -rf`: a missing path is fine; anything else that fails throws. */
private fun removeTree(p: Path) {
    val a = attrsOrNull(p) ?: return
    if (a.isDirectory) {
        for ((name, _) in listDirectory(p) ?: emptyList()) removeTree(p.resolve(name))
    }
    try {
        Files.delete(p)
    } catch (e: NoSuchFileException) {
        // Gone meanwhile.
    } catch (e: DirectoryNotEmptyException) {
        throw PackFileException("cannot remove $p", e)
    }
}

private fun renamePath(from: Path, to: Path) {
    try {
        Files.move(from, to, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    } catch (e: java.nio.file.AtomicMoveNotSupportedException) {
        Files.move(from, to, StandardCopyOption.REPLACE_EXISTING)
    }
}

/** A per-process token for temp names (ProcessHandle does not exist on Android). */
private val pid: String = java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 12)

/** A file on disk as a [ByteSource] (opened per read, so nothing stays open between reads). */
public class FileSource(public val path: Path, override val size: Long) : ByteSource {
    override fun read(offset: Long, length: Int): ByteArray {
        val n = maxOf(0L, minOf(length.toLong(), size - offset)).toInt()
        if (n == 0) return ByteArray(0)
        FileChannel.open(path, StandardOpenOption.READ).use { ch ->
            val buf = ByteBuffer.allocate(n)
            var at = offset
            while (buf.hasRemaining()) {
                val r = ch.read(buf, at)
                if (r < 0) break
                at += r
            }
            return if (buf.position() == n) buf.array() else buf.array().copyOf(buf.position())
        }
    }
}

/** A file's SHA-256 and size, read in chunks. */
public fun measureFile(p: Path): Pair<String, Long> {
    val a = attrsOrNull(p) ?: throw NoSuchFileException(p.toString())
    val src = FileSource(p, a.size())
    return hashSource(src) to src.size
}

/** Every regular file under [dir], as `/`-separated paths relative to it, skipping `.pkey/`. */
public fun walkTree(dir: Path): List<String> {
    val out = ArrayList<String>()
    fun walk(at: Path, rel: String) {
        val entries = listDirectory(at) ?: throw NoSuchFileException(at.toString())
        for ((name, a) in entries) {
            val r = if (rel.isEmpty()) name else "$rel/$name"
            if (r == ".pkey") continue
            if (a.isDirectory) walk(at.resolve(name), r) else if (a.isRegularFile) out += r
        }
    }
    walk(dir, "")
    return out
}

/** A directory's files with their sizes and SHA-256. */
public fun measureTree(dir: Path): List<TreeFile> = walkTree(dir).map { p ->
    val (sha, size) = measureFile(dir.resolve(p))
    TreeFile(p, size, sha)
}

/** `treeDigest` of a directory, minus `.pkey/` (plans/P4-01.md §2.6). */
public fun directoryTreeDigest(dir: Path): String = treeDigest(measureTree(dir))

private const val CONTAINER_FILE = "payload.bin"
private const val INDEX_FILE = ".pkey/files.json"

private fun isSha256Name(s: String): Boolean = s.length == 64 && s.all { it in '0'..'9' || it in 'a'..'f' }

/** `parts` joined under `base`, refusing anything that would land outside it. */
internal fun inside(base: Path, vararg parts: String): Path {
    var p = base
    for (part in parts) {
        for (seg in part.split('/')) {
            if (seg.isEmpty()) continue
            if (seg == "." || seg == ".." || seg.contains('\\') || seg.contains('\u0000')) throw PackFileException("unsafe path segment in $part")
            p = p.resolve(seg)
        }
    }
    return p
}

/** The seed indexes under `<root>/index/` (P4-11). */
public class DirChunkIndexStore(public val dir: Path) : ChunkIndexStore {
    private fun path(sha256: String): Path {
        if (!isSha256Name(sha256)) throw PackFileException("not a sha256 name: $sha256")
        return dir.resolve(sha256)
    }

    /** The stored index, or null when absent, not a regular file, or larger than `MAX_CHUNK_INDEX_BYTES`. */
    override fun get(sha256: String): ByteArray? {
        val p = path(sha256)
        val a = attrsOrNull(p) ?: return null
        if (!a.isRegularFile || a.size() > MAX_CHUNK_INDEX_BYTES) return null
        return readFileOrNull(p)?.takeIf { it.size <= MAX_CHUNK_INDEX_BYTES }
    }

    override fun put(sha256: String, bytes: ByteArray) {
        val p = path(sha256)
        mkdirs(dir)
        val tmp = dir.resolve("$sha256.$pid.tmp")
        writeFileSynced(tmp, bytes)
        renamePath(tmp, p)
        syncPath(dir, true)
    }

    override fun list(): List<String> = (listDirectory(dir) ?: emptyList()).filter { it.second.isRegularFile && isSha256Name(it.first) }.map { it.first }

    override fun remove(sha256: String) {
        removeTree(path(sha256))
    }
}

/** The run journals at `<root>/staging/<planId>/journal.json` (P4-11). */
public class DirRunJournalStore(public val stagingDir: Path) : RunJournalStore {
    override fun read(planId: String): String? = readFileOrNull(inside(stagingDir, planId, "journal.json"))?.toString(Charsets.UTF_8)

    override fun write(planId: String, text: String) {
        val dir = inside(stagingDir, planId)
        mkdirs(dir)
        val p = dir.resolve("journal.json")
        val tmp = dir.resolve("journal.json.$pid.tmp")
        writeFileSynced(tmp, text.toByteArray(Charsets.UTF_8))
        renamePath(tmp, p)
    }
}

/** The atomic-replace state file, with a torn document's quarantine and the hold's snapshot. */
public class DirPackStateStore(public val root: Path, public val name: String = "state.json") : PackStateStore {
    private val path: Path get() = root.resolve(name)
    private val torn: Path get() = root.resolve("$name.torn")
    private val holdList: Path get() = root.resolve("$name.torn.list")

    override fun read(): String? = readFileOrNull(path)?.toString(Charsets.UTF_8)

    override fun replace(text: String) {
        mkdirs(root)
        val tmp = root.resolve("$name.$pid.tmp")
        writeFileSynced(tmp, text.toByteArray(Charsets.UTF_8))
        renamePath(tmp, path)
        syncPath(root, true)
    }

    override fun quarantine(text: String) {
        if (pathExists(torn)) return
        try {
            writeFileSynced(torn, text.toByteArray(Charsets.UTF_8), exclusive = true)
        } catch (e: FileAlreadyExistsException) {
            return
        }
        syncPath(root, true)
    }

    override fun quarantined(): Boolean = pathExists(torn)

    override fun clearQuarantine() {
        removeTree(holdList)
        removeTree(torn)
    }

    override val keepsHoldList: Boolean get() = true

    override fun readHoldList(): String? = readFileOrNull(holdList)?.toString(Charsets.UTF_8)

    override fun writeHoldList(text: String) {
        if (pathExists(holdList)) return
        val tmp = root.resolve("$name.torn.list.$pid.tmp")
        writeFileSynced(tmp, text.toByteArray(Charsets.UTF_8))
        renamePath(tmp, holdList)
        syncPath(root, true)
    }
}

/** The [PackStorage] over a directory. */
public class DirPackStorage(root: Path) : PackStorage {
    public val root: Path = root.toAbsolutePath().normalize()
    public val stagingDir: Path = this.root.resolve("staging")
    public val storeDir: Path = this.root.resolve("store")
    private val embeddedFiles = java.util.concurrent.ConcurrentHashMap<String, List<InstalledFile>>()

    /** The state store beside the payloads. */
    public fun stateStore(): DirPackStateStore = DirPackStateStore(root)

    /** The sibling `revocations.json` (plans/P4-13.md §2.5): never created empty. */
    public fun revocationStore(): DirPackStateStore = DirPackStateStore(root, "revocations.json")

    override fun stagedObject(planId: String, sha256: String): StagedObject {
        val p = inside(stagingDir, planId, "objects", sha256)
        return object : StagedObject {
            override fun size(): Long = attrsOrNull(p)?.size() ?: 0
            override fun source(): ByteSource = FileSource(p, size())
            override fun append(bytes: ByteArray) {
                mkdirs(p.parent)
                FileChannel.open(p, StandardOpenOption.WRITE, StandardOpenOption.CREATE, StandardOpenOption.APPEND).use { ch ->
                    val buf = ByteBuffer.wrap(bytes)
                    while (buf.hasRemaining()) ch.write(buf)
                }
            }
            override fun reset() = removeTree(p)
        }
    }

    override fun output(planId: String, layout: String, resume: Boolean): PackOutput {
        val out = inside(stagingDir, planId, "out")
        val file = out.resolve(CONTAINER_FILE)
        val existing = attrsOrNull(file)
        val keep = resume && layout != "tree" && existing?.isRegularFile == true
        if (!keep) {
            removeTree(out)
            mkdirs(out)
        }
        if (layout == "tree") {
            return PackOutput(tree = { path, bytes ->
                val abs = inside(out, path)
                mkdirs(abs.parent)
                Files.write(abs, bytes)
            })
        }
        if (!keep) writeFileSynced(file, ByteArray(0))
        return PackOutput(
            sink = { offset, bytes ->
                RandomAccessFile(file.toFile(), "rw").use { raf ->
                    raf.seek(offset)
                    raf.write(bytes)
                }
            },
            read = { offset, length ->
                if (length <= 0 || offset < 0) ByteArray(0) else {
                    val a = attrsOrNull(file)
                    if (a == null) ByteArray(0) else FileSource(file, a.size()).read(offset, length)
                }
            },
        )
    }

    override val chunkIndexes: ChunkIndexStore get() = DirChunkIndexStore(root.resolve("index"))

    override val runJournal: RunJournalStore get() = DirRunJournalStore(stagingDir)

    override fun commit(planId: String, packId: String, payloadSha256: String, layout: String, index: FilesIndexDoc?): String {
        val out = inside(stagingDir, planId, "out")
        val location = inside(storeDir, packId, payloadSha256)
        if (index != null) {
            mkdirs(out.resolve(".pkey"))
            writeFileSynced(out.resolve(INDEX_FILE), canonicalJson(index.json).toByteArray(Charsets.UTF_8))
        }
        if (pathExists(location)) {
            // The same payload is already stored (a rollback target, say): keep the stored copy.
            removeTree(out)
            return location.toString()
        }
        // The payload is durable before the pointer can name it.
        syncTree(out)
        mkdirs(location.parent)
        renamePath(out, location)
        syncPath(location.parent, true)
        return location.toString()
    }

    private fun payloadFile(install: PackInstall): Path {
        val loc = Paths.get(install.location)
        return if (install.embedded == true) loc else loc.resolve(CONTAINER_FILE)
    }

    override fun installed(install: PackInstall): InstalledPayload? {
        val loc = Paths.get(install.location)
        if (!pathExists(loc)) return null
        if (install.layout == "tree") {
            val files = treeFiles(loc, install.embedded == true) ?: return null
            return InstalledPayload(null, files)
        }
        val file = payloadFile(install)
        val a = attrsOrNull(file) ?: return null
        val whole = FileSource(file, a.size())
        val index = if (install.embedded == true) null else readIndex(loc)
        return InstalledPayload(whole, index?.files?.map { InstalledFile(it.path, it.sha256, it.size, sliceSource(whole, it.offset ?: 0, it.size)) })
    }

    /** The index kept at install: null when missing or not an index; unreadable throws. */
    private fun readIndex(location: Path): FilesIndexDoc? {
        val bytes = readFileOrNull(location.resolve(INDEX_FILE)) ?: return null
        return FilesIndexDoc.from(parseJson(bytes.toString(Charsets.UTF_8)))
    }

    /** A tree's files: from the index kept at install, else (an embedded tree) measured once. */
    private fun treeFiles(location: Path, embedded: Boolean): List<InstalledFile>? {
        val index = if (embedded) null else readIndex(location)
        val entries: List<TreeFile> = if (index != null) {
            index.files.map { TreeFile(it.path, it.size, it.sha256) }
        } else {
            embeddedFiles[location.toString()]?.let { return it }
            measureTree(location)
        }
        val files = entries.map { InstalledFile(it.path, it.sha256, it.size, FileSource(inside(location, it.path), it.size)) }
        if (index == null) embeddedFiles[location.toString()] = files
        return files
    }

    override fun verify(install: PackInstall): Boolean {
        val loc = Paths.get(install.location)
        if (install.layout == "tree") {
            if (!pathExists(loc)) return false
            return directoryTreeDigest(loc) == install.payloadSha256
        }
        val file = payloadFile(install)
        if (!pathExists(file)) return false
        val (sha, size) = measureFile(file)
        return sha == install.payloadSha256 && size == install.payloadSize
    }

    override fun remove(location: String) {
        // Only ever inside the store: an embedded payload lives in the app's resources.
        val abs = Paths.get(location).toAbsolutePath().normalize()
        if (!abs.startsWith(storeDir) || abs == storeDir) return
        removeTree(abs)
    }

    override fun removeStaging(planId: String) {
        removeTree(inside(stagingDir, planId))
    }

    override fun list(): Pair<List<String>, List<String>> {
        val locations = ArrayList<String>()
        val plans = ArrayList<String>()
        for ((pack, a) in listDirectory(storeDir) ?: emptyList()) {
            if (!a.isDirectory) continue
            for ((v, b) in listDirectory(storeDir.resolve(pack)) ?: emptyList()) if (b.isDirectory) locations += storeDir.resolve(pack).resolve(v).toString()
        }
        for ((p, a) in listDirectory(stagingDir) ?: emptyList()) if (a.isDirectory) plans += p
        return locations to plans
    }

    override fun freeDisk(): Long {
        mkdirs(root)
        return Files.getFileStore(root).usableSpace
    }
}
