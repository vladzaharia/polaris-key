// The partial-file store of Direct Transfer (CC-20.7; WIRE-CONTRACT-V5 section 15.11 "Resume" and "The name is
// display data"). A receiving transfer is written to a partial file under the client's state directory
// (`<state>/xfer/`), named only by the partial path the machine derives from the peer key, the transfer id and the
// hash: never by the sender's `name`. Next to each file lies a small record of what it is (the peer key, id, hash,
// size and chunk), under the same derived name.
//
// Rules this file keeps:
//  - owner-only modes (`rwx------` for the directory, `rw-------` for a file) where the platform has them;
//  - a partial lives 24 hours from its last write; older ones are removed when the store is read;
//  - a finished transfer is moved to the destination the host chose with a temporary file in the destination's
//    own directory and an atomic rename, so a reader never sees half a file;
//  - space is reserved when a transfer is accepted: the bytes still to come are held against the quota and the
//    disk reserve until the transfer ends, so concurrent transfers cannot overshoot what one offer-time check
//    allowed, and a write past the offered size or past the free space is refused;
//  - a partial is touched only by the session that holds it and only for the peer it belongs to; eviction never
//    removes a partial a live transfer holds;
//  - sign-out, leaving the roster and a deleted contact purge: [purgeAll] and [purgePeer]. A purge ends the store's
//    epoch, and an effect of an older epoch that arrives late is refused, so it cannot bring the directory back.

package im.plrs.key.sdk

import im.plrs.key.core.StrictJson
import im.plrs.key.core.longValue
import im.plrs.key.core.peer.XFER_PARTIAL_SECONDS
import im.plrs.key.core.peer.XferEffect
import im.plrs.key.core.peer.XferPartial
import im.plrs.key.core.peer.xferHex
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.PosixFilePermissions
import java.security.MessageDigest

private const val PART = ".part"
private const val META = ".json"
private const val READ_BLOCK = 64 * 1024
private const val MILLIS = 1000.0
private const val MIB = 1024L * 1024
private val REF = Regex("[0-9a-f]{64}")

/** Space left free on the store's volume, whatever the transfers want. */
internal const val TRANSFER_DISK_RESERVE_BYTES: Long = 256 * MIB

/** The most the kept partials and the space reserved for transfers in flight may add up to, by default. */
internal const val TRANSFER_QUOTA_BYTES: Long = 4L * 1024 * MIB

internal class TransferStore(
    root: File,
    private val now: () -> Double,
    /** The quota in bytes; read at every check. */
    private val quota: () -> Long = { TRANSFER_QUOTA_BYTES },
    private val diskReserve: Long = TRANSFER_DISK_RESERVE_BYTES,
) {
    private val dir = File(root, "xfer")
    private val lock = Any()

    /** The part of an offered size a live transfer holds space for: [total] bytes, [written] of them on disk. */
    private class Hold(val owner: Any, val total: Long, var written: Long)

    private val holds = HashMap<String, Hold>()
    private var epochNo = 0

    /** The store's epoch; a purge ends it. */
    val epoch: Int get() = synchronized(lock) { epochNo }

    override fun toString(): String = "TransferStore"

    // -- reading ------------------------------------------------------------------------------------------------

    /** The partials of [peerKey], expired ones removed first. */
    fun partialsFor(peerKey: ByteArray): List<XferPartial> = synchronized(lock) {
        if (!dirIsPlain()) return@synchronized emptyList()
        sweep()
        val peer = xferHex(peerKey)
        val out = ArrayList<XferPartial>()
        for (m in metas()) {
            if (m.peer != peer) continue
            val f = part(m.ref)
            if (!f.isFile) {
                remove(m.ref)
                continue
            }
            out += XferPartial(m.ref, m.id, m.sha256, m.size, m.chunk, f.length(), f.lastModified() / MILLIS, held = holds.containsKey(m.ref))
        }
        out
    }

    /**
     * A hasher fed with the first [offset] bytes of the partial [ref], read back from disk. Throws [IOException]
     * when the file is gone or shorter than [offset] (another session finished or dropped it): the transfer then
     * starts again from 0.
     */
    fun rehash(ref: String, offset: Long): MessageDigest {
        val d = MessageDigest.getInstance("SHA-256")
        if (!dirIsPlain()) throw IOException("the transfer directory is not a plain directory")
        try {
            RandomAccessFile(part(ref), "r").use { f ->
                val buf = ByteArray(READ_BLOCK)
                var left = offset
                while (left > 0) {
                    val n = f.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
                    if (n <= 0) throw IOException("partial shorter than its record")
                    d.update(buf, 0, n)
                    left -= n
                }
            }
        } catch (e: java.io.FileNotFoundException) {
            throw IOException("partial is gone", e)
        }
        return d
    }

    /**
     * Bytes a new transfer may still take: the quota and the volume's space (less the disk reserve), each less what
     * the transfers in flight have reserved. Null when the volume cannot say.
     */
    fun free(): Long? = synchronized(lock) { freeLocked() }

    private fun freeLocked(): Long? {
        var d: File? = dir
        while (d != null && !d.exists()) d = d.parentFile
        val usable = d?.usableSpace?.takeIf { it > 0 } ?: return null
        val pending = holds.values.sumOf { it.total - it.written }
        val used = dir.listFiles { f -> f.name.endsWith(PART) }?.sumOf { it.length() } ?: 0L
        return minOf(quota() - used - pending, usable - diskReserve - pending).coerceAtLeast(0)
    }

    // -- effects ------------------------------------------------------------------------------------------------

    /**
     * Perform one effect of the machine for [owner] (the session's transfer layer) and [peerKey], if the store is
     * still in [epoch]. [destination] names where the host wants a transfer [XferEffect.Finalize]d.
     */
    fun apply(e: XferEffect, owner: Any, peerKey: ByteArray, epoch: Int, destination: (String) -> File?) {
        if (e is XferEffect.Finalize) {
            finalize(e, owner, peerKey, epoch, destination)
            return
        }
        synchronized(lock) {
            requireLive(epoch)
            when (e) {
                is XferEffect.Create -> create(e.partial, owner, peerKey)
                is XferEffect.Write -> write(e, owner, peerKey)
                is XferEffect.Truncate -> truncate(e, owner, peerKey)
                is XferEffect.Keep -> if (holds[e.ref]?.owner === owner) holds.remove(e.ref)
                is XferEffect.Discard -> drop(e.ref, owner, peerKey)
                is XferEffect.Delete -> drop(e.ref, owner, peerKey)
                is XferEffect.Evict -> {
                    // A partial a live transfer holds is never evicted, and nor is another peer's.
                    val h = holds[e.ref]
                    if ((h == null || h.owner === owner) && ownedBy(e.ref, peerKey)) remove(e.ref)
                }
                is XferEffect.Finalize -> Unit
            }
        }
    }

    private fun finalize(e: XferEffect.Finalize, owner: Any, peerKey: ByteArray, epoch: Int, destination: (String) -> File?) {
        val from = synchronized(lock) {
            requireLive(epoch)
            mine(e.ref, owner, peerKey)
            part(e.ref)
        }
        val to = destination(e.id) ?: throw IOException("no destination for the transfer")
        deliver(from, to)
        synchronized(lock) {
            requireLive(epoch)
            remove(e.ref)
        }
    }

    /** Write an empty file at [to] (a transfer of no bytes has no partial). */
    fun deliverEmpty(to: File) = deliver(null, to)

    private fun requireLive(epoch: Int) {
        if (epoch != epochNo) throw IOException("the store was purged")
    }

    /** The partial [ref] belongs to [peerKey] and to no other live transfer than [owner]'s. */
    private fun mine(ref: String, owner: Any, peerKey: ByteArray) {
        val h = holds[ref]
        if (h != null && h.owner !== owner) throw IOException("partial is in use")
        if (!ownedBy(ref, peerKey)) throw IOException("partial belongs to another peer")
    }

    private fun ownedBy(ref: String, peerKey: ByteArray): Boolean {
        val m = File(dir, ref + META)
        if (!m.isFile) return true
        return StrictJson.validate(m.readBytes())?.value?.get("peer").stringValue == xferHex(peerKey)
    }

    private fun drop(ref: String, owner: Any, peerKey: ByteArray) {
        if (File(dir, ref + META).exists() || part(ref).exists()) mine(ref, owner, peerKey)
        remove(ref)
    }

    private fun create(p: XferPartial, owner: Any, peerKey: ByteArray) {
        if (holds.containsKey(p.ref)) throw IOException("partial is in use")
        if (p.size > (freeLocked() ?: Long.MAX_VALUE)) throw IOException("not enough room for the transfer")
        ensureDir()
        val f = part(p.ref)
        if (f.exists() && !ownedBy(p.ref, peerKey)) throw IOException("partial belongs to another peer")
        if (!f.exists()) createOwned(f)
        RandomAccessFile(f, "rw").use { it.setLength(0) }
        val body = JsonObject(
            mapOf(
                "v" to JsonPrimitive(1),
                "peer" to JsonPrimitive(xferHex(peerKey)),
                "id" to JsonPrimitive(p.id),
                "sha256" to JsonPrimitive(p.sha256),
                "size" to JsonPrimitive(p.size),
                "chunk" to JsonPrimitive(p.chunk),
            ),
        )
        val meta = File(dir, p.ref + META)
        if (!meta.exists()) createOwned(meta)
        meta.writeText(body.toString(), Charsets.UTF_8)
        holds[p.ref] = Hold(owner, p.size, 0)
    }

    private fun truncate(e: XferEffect.Truncate, owner: Any, peerKey: ByteArray) {
        mine(e.ref, owner, peerKey)
        val size = metas().firstOrNull { it.ref == e.ref }?.size ?: throw IOException("partial is gone")
        val f = part(e.ref)
        if (!f.isFile) throw IOException("partial is gone")
        if (f.length() < e.to) throw IOException("partial shorter than its record")
        holds.remove(e.ref)
        if (size - e.to > (freeLocked() ?: Long.MAX_VALUE)) throw IOException("not enough room for the transfer")
        RandomAccessFile(f, "rw").use { it.setLength(e.to) }
        holds[e.ref] = Hold(owner, size, e.to)
    }

    private fun write(e: XferEffect.Write, owner: Any, peerKey: ByteArray) {
        mine(e.ref, owner, peerKey)
        val h = holds[e.ref] ?: throw IOException("no space reserved for the transfer")
        val end = e.offset + e.data.size
        if (end > h.total) throw IOException("write past the offered size")
        if (dir.usableSpace < e.data.size) throw IOException("the disk is full")
        RandomAccessFile(part(e.ref), "rw").use { f ->
            f.seek(e.offset)
            f.write(e.data)
        }
        h.written = maxOf(h.written, end)
    }

    private fun deliver(from: File?, to: File) {
        val parent = (to.absoluteFile.parentFile ?: throw IOException("no destination directory"))
        parent.mkdirs()
        val tmp = Files.createTempFile(parent.toPath(), ".pkey-xfer-", ".tmp")
        try {
            if (from != null) Files.copy(from.toPath(), tmp, StandardCopyOption.REPLACE_EXISTING)
            // Never over an existing file: a hard link fails if the destination appeared after the accept.
            try {
                Files.createLink(to.toPath(), tmp)
            } catch (e: java.nio.file.FileAlreadyExistsException) {
                throw IOException("the destination exists", e)
            } catch (e: UnsupportedOperationException) {
                Files.copy(tmp, to.toPath())
            } catch (e: IOException) {
                if (to.exists()) throw e
                Files.copy(tmp, to.toPath())
            }
        } finally {
            Files.deleteIfExists(tmp)
        }
    }

    // -- purging ------------------------------------------------------------------------------------------------

    /** Sign-out and leaving the roster: every partial goes, and what is still in flight is refused from now on. */
    fun purgeAll() = synchronized(lock) {
        epochNo++
        holds.clear()
        dir.listFiles()?.forEach { it.delete() }
        dir.delete()
    }

    /** A deleted contact: its partials go. */
    fun purgePeer(peerKey: ByteArray) = synchronized(lock) {
        val peer = xferHex(peerKey)
        for (m in metas()) if (m.peer == peer) remove(m.ref)
    }

    // -- internals ----------------------------------------------------------------------------------------------

    private class Meta(val ref: String, val peer: String, val id: String, val sha256: String, val size: Long, val chunk: Int)

    private fun part(ref: String): File {
        require(REF.matches(ref)) { "partial name" }
        return File(dir, ref + PART)
    }

    private fun remove(ref: String) {
        holds.remove(ref)
        part(ref).delete()
        File(dir, ref + META).delete()
    }

    private fun metas(): List<Meta> {
        val files = dir.listFiles { f -> f.name.endsWith(META) } ?: return emptyList()
        val out = ArrayList<Meta>()
        for (f in files) {
            val ref = f.name.removeSuffix(META)
            if (!REF.matches(ref)) continue
            val o = StrictJson.validate(f.readBytes())?.value
            val size = o?.get("size").longValue
            val chunk = o?.get("chunk").longValue
            val peer = o?.get("peer").stringValue
            val id = o?.get("id").stringValue
            val sha = o?.get("sha256").stringValue
            if (size == null || chunk == null || peer == null || id == null || sha == null) {
                // Not a record this store wrote (or a create that never got its record): the partial goes with it.
                if (!holds.containsKey(ref)) remove(ref)
            } else {
                out += Meta(ref, peer, id, sha, size, chunk.toInt())
            }
        }
        return out
    }

    /** Partials not written for [XFER_PARTIAL_SECONDS] go, and so do files with no record; a held one stays. */
    private fun sweep() {
        val files = dir.listFiles() ?: return
        val cutoff = now() - XFER_PARTIAL_SECONDS
        for (f in files) {
            if (!f.name.endsWith(PART)) continue
            val ref = f.name.removeSuffix(PART)
            if (!REF.matches(ref) || holds.containsKey(ref)) continue
            if (f.lastModified() / MILLIS < cutoff || !File(dir, ref + META).isFile) remove(ref)
        }
    }

    private fun ensureDir() {
        if (!Files.exists(dir.toPath(), LinkOption.NOFOLLOW_LINKS)) {
            dir.mkdirs()
            ownerOnly(dir, true)
        }
        // A link, or a directory another user owns, is refused: nothing is written through it.
        if (!dirIsPlain()) throw IOException("the transfer directory is not a plain directory")
    }

    /** True when the directory is absent, or a real directory this user owns; false for a link or a foreign one. */
    private fun dirIsPlain(): Boolean {
        val p = dir.toPath()
        if (!Files.exists(p, LinkOption.NOFOLLOW_LINKS)) return true
        if (Files.isSymbolicLink(p) || !Files.isDirectory(p, LinkOption.NOFOLLOW_LINKS)) return false
        return try {
            Files.getOwner(p, LinkOption.NOFOLLOW_LINKS).name == System.getProperty("user.name")
        } catch (e: UnsupportedOperationException) {
            true
        } catch (e: IOException) {
            false
        }
    }

    /** A new empty file that only the owner can open, from the first byte. */
    private fun createOwned(f: File) {
        try {
            Files.createFile(f.toPath(), PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
        } catch (e: UnsupportedOperationException) {
            Files.createFile(f.toPath())
            ownerOnly(f, false)
        }
    }

    private fun ownerOnly(f: File, directory: Boolean) {
        try {
            Files.setPosixFilePermissions(f.toPath(), PosixFilePermissions.fromString(if (directory) "rwx------" else "rw-------"))
        } catch (e: UnsupportedOperationException) {
            f.setReadable(false, false)
            f.setReadable(true, true)
            f.setWritable(false, false)
            f.setWritable(true, true)
        }
    }
}
