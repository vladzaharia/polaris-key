// Where an export goes (WIRE-CONTRACT-V5 section 13.12, "Destination"). The SDK never picks a location, never writes to shared
// storage on its own and never logs a path.
//
// A path. `<destination>.partial` is created exclusively (`CREATE_NEW`, never following a link) with owner-only access
// (`rw-------`) at creation, never loosened afterwards, so another process cannot pre-create it, link it or read it between
// steps; it is written, forced to disk and renamed over the destination atomically. A stale `.partial` an earlier crash left is
// removed first. A destination or partial that is not a regular file (a directory, a link, a device, a pipe) is refused with
// `sync-export-failed`, reason `destination`. The old destination survives every failure and cancel. No other plaintext copy
// exists. Nothing is created until the first write, so a refused export leaves nothing.
//
// A stream (Android's SAF `OutputStream`, or any the app holds). The SDK writes and flushes it and never closes or keeps it: the
// app closes it, and deletes the document it asked the person to create when the export fails.

package im.plrs.key.sdk

import im.plrs.key.core.sync.ExportSink
import im.plrs.key.core.sync.SyncExportException
import java.io.IOException
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.FileSystems
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.NoSuchFileException
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.BasicFileAttributes
import java.nio.file.attribute.PosixFilePermissions

/** What the host asks of a destination, beyond taking the archive's bytes. */
internal interface ExportDestination : ExportSink {
    /** Refuse a destination that is unusable before anything is read. */
    fun prepare() = Unit

    /** The archive is complete: make it the destination. */
    fun commit()

    /** The export failed or was cancelled: remove what this export made, and only that. */
    fun discard()
}

private fun destination(): SyncExportException = SyncExportException(SyncExportException.DESTINATION)

/**
 * A path destination: `<path>.partial`, then an atomic rename. A caught `IOException` is not chained: its message names the path, and
 * the SDK never puts a path in an error.
 */
@Suppress("SwallowedException")
internal class PartialFile(
    private val dest: Path,
    /** How bytes reach the channel; a test swaps it to run the disk out of room. */
    private val writer: (FileChannel, ByteBuffer) -> Unit = { ch, b -> while (b.hasRemaining()) ch.write(b) },
) : ExportDestination {
    private val partial: Path? = dest.fileName?.let { dest.resolveSibling("$it.partial") }
    private var channel: FileChannel? = null
    private var created = false

    /** The attributes of [p] without following a link, or null when there is nothing there. */
    private fun lstat(p: Path): BasicFileAttributes? = try {
        Files.readAttributes(p, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
    } catch (e: NoSuchFileException) {
        null
    } catch (e: IOException) {
        throw destination()
    }

    override fun prepare() {
        val partial = partial ?: throw destination()
        lstat(dest)?.let { if (!it.isRegularFile) throw destination() }
        val stale = lstat(partial) ?: return
        if (!stale.isRegularFile) throw destination()
        try {
            Files.delete(partial)
        } catch (e: IOException) {
            throw destination()
        }
    }

    private fun open(): FileChannel {
        val p = partial ?: throw destination()
        val options = setOf(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)
        val ch = try {
            if ("posix" in FileSystems.getDefault().supportedFileAttributeViews()) {
                FileChannel.open(p, options, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
            } else {
                FileChannel.open(p, options)
            }
        } catch (e: IOException) {
            throw destination()
        }
        created = true
        channel = ch
        return ch
    }

    override fun write(bytes: ByteArray, offset: Int, length: Int) {
        try {
            writer(channel ?: open(), ByteBuffer.wrap(bytes, offset, length))
        } catch (e: IOException) {
            throw destination()
        }
    }

    override fun commit() {
        val p = partial ?: throw destination()
        try {
            val ch = channel ?: open()
            ch.force(true)
            ch.close()
            channel = null
            lstat(dest)?.let { if (!it.isRegularFile) throw destination() }
            replace(p)
        } catch (e: IOException) {
            throw destination()
        }
        syncParent()
    }

    private fun replace(p: Path) {
        try {
            Files.move(p, dest, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (e: AtomicMoveNotSupportedException) {
            Files.move(p, dest, StandardCopyOption.REPLACE_EXISTING)
        }
        created = false
    }

    /** Best effort: a directory cannot be opened for syncing on every platform. */
    private fun syncParent() {
        val parent = dest.toAbsolutePath().parent ?: return
        try {
            FileChannel.open(parent, StandardOpenOption.READ).use { it.force(true) }
        } catch (e: IOException) {
            // Not every platform lets a directory be forced; the rename already happened.
        }
    }

    override fun discard() {
        channel?.let { runCatching { it.close() } }
        channel = null
        val p = partial
        if (created && p != null) runCatching { Files.deleteIfExists(p) }
        created = false
    }
}

/** A stream destination: written and flushed, never closed. The app cleans up after a failure; no `IOException` is chained (it may name a path). */
@Suppress("SwallowedException")
internal class StreamDestination(private val out: OutputStream) : ExportDestination {
    override fun write(bytes: ByteArray, offset: Int, length: Int) {
        try {
            out.write(bytes, offset, length)
        } catch (e: IOException) {
            throw destination()
        }
    }

    override fun commit() {
        try {
            out.flush()
        } catch (e: IOException) {
            throw destination()
        }
    }

    override fun discard() = Unit
}
