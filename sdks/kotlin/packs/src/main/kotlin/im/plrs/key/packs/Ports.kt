// The ports every pack function takes (plans/P4-01.md §2.13; client-core `packs/ports.ts`; Swift's
// `Ports.swift` is the structural model, P6-08). Nothing in the pure half of this module does I/O:
// byte storage, zstd and the network are injected through these interfaces, so the same appliers,
// planner and pipeline run over the directory store, over memory and under the corpus runner.
// Byte sources and sinks are positional, so a payload is streamed through them rather than held
// whole where the applier allows it (a 2 GB Android device never holds a whole pack).
//
// File reads and libzstd calls block; only the network suspends. SHA-256 is the JDK's streaming
// `MessageDigest`, so there is no hasher port.

package im.plrs.key.packs

import java.security.MessageDigest

/** A readable run of bytes of a known length. `read` returns exactly `length` bytes, or fewer only at the end. */
public interface ByteSource {
    public val size: Long
    public fun read(offset: Long, length: Int): ByteArray
}

/** A positional writer: a container payload being rebuilt. */
public fun interface ByteSink {
    public fun write(offset: Long, bytes: ByteArray)
}

/** Where a tree payload's files go while it is staged. Paths have passed `checkPaths`. */
public fun interface TreeSink {
    public fun writeFile(path: String, bytes: ByteArray)
}

/**
 * The zstd decoder (plans/P4-01.md §2.7 rules 1–3). [decode] takes one frame with its content size;
 * [decodeWithPrefix] one `zstd --patch-from` frame over the whole base as a raw-content prefix. Either
 * may throw: every failure is the applier's verdict, never an exception that escapes. The appliers run
 * the window check themselves before [decodeWithPrefix] (§2.7 rule 3), with [pointerBits] as P.
 */
public interface ZstdPort {
    /** 31 for a 64-bit decoder, 30 for a 32-bit one. */
    public val pointerBits: Int
    public fun decode(frame: ByteArray, size: Int): ByteArray
    public fun decodeWithPrefix(frame: ByteArray, prefix: ByteArray, size: Int, windowLogMax: Int): ByteArray

    /** Whether [decodeStream] is available; then `applyFull` streams a whole payload through it. */
    public val canStream: Boolean get() = false

    /** A streaming decode of one plain frame; the output arrives in order and totals [size] bytes. */
    public fun decodeStream(frame: ByteSource, size: Long, onChunk: (ByteArray) -> Unit): Unit = throw PackPortException("unsupported")
}

/** A port that cannot do what was asked. */
public class PackPortException(message: String) : Exception(message)

/** A stored object by the SHA-256 of its stored bytes, or null when the host has none. */
public typealias ObjectPort = (String) -> ByteSource?

/** One installed file, reachable by its SHA-256 (a tree's file, or a range of a container payload). */
public class InstalledFile(
    public val path: String,
    public val sha256: String,
    public val size: Long,
    public val source: ByteSource,
)

// ── Helpers over the ports ────────────────────────────────────────────────────────────────────

/** The chunk size every helper reads in: 1 MiB. */
public const val READ_CHUNK: Int = 1 shl 20

/** A source over bytes already in memory. */
public class MemorySource(public val bytes: ByteArray) : ByteSource {
    override val size: Long get() = bytes.size.toLong()

    override fun read(offset: Long, length: Int): ByteArray {
        val lo = offset.coerceIn(0, bytes.size.toLong()).toInt()
        val hi = (offset + maxOf(length, 0)).coerceIn(lo.toLong(), bytes.size.toLong()).toInt()
        return bytes.copyOfRange(lo, hi)
    }
}

/** A source over a range of another source. */
public class SliceSource(public val base: ByteSource, public val offset: Long, override val size: Long) : ByteSource {
    override fun read(offset: Long, length: Int): ByteArray =
        base.read(this.offset + offset, maxOf(0L, minOf(length.toLong(), size - offset)).toInt())
}

public fun sliceSource(source: ByteSource, offset: Long, size: Long): ByteSource = SliceSource(source, offset, size)

/** Every byte of a source, in one buffer. Only for objects the caller has bounded. */
public fun readAll(source: ByteSource): ByteArray {
    val n = source.size
    if (n > Int.MAX_VALUE - 8) throw PackPortException("too large to buffer")
    val out = java.io.ByteArrayOutputStream(n.toInt())
    var at = 0L
    while (at < n) {
        val chunk = source.read(at, minOf(READ_CHUNK.toLong(), n - at).toInt())
        if (chunk.isEmpty()) break
        out.write(chunk)
        at += chunk.size
    }
    return out.toByteArray()
}

private val HEX = "0123456789abcdef".toCharArray()

/** Lowercase hex. */
public fun hexString(bytes: ByteArray, from: Int = 0, to: Int = bytes.size): String {
    val out = CharArray((to - from) * 2)
    var k = 0
    for (i in from until to) {
        val b = bytes[i].toInt() and 0xff
        out[k++] = HEX[b ushr 4]
        out[k++] = HEX[b and 15]
    }
    return String(out)
}

/** Bytes from lowercase (or uppercase) hex; no validation beyond pairs. */
public fun hexBytes(hex: String): ByteArray {
    fun nibble(c: Char): Int = if (c <= '9') c - '0' else (c.code or 0x20) - 0x57
    return ByteArray(hex.length / 2) { ((nibble(hex[2 * it]) shl 4) or nibble(hex[2 * it + 1])).toByte() }
}

/** An incremental SHA-256. */
public class PackHasher {
    private val md = MessageDigest.getInstance("SHA-256")
    public fun update(bytes: ByteArray, from: Int = 0, length: Int = bytes.size - from): PackHasher = apply { md.update(bytes, from, length) }
    public fun digest(): String = hexString(md.digest())
}

/** The SHA-256 of bytes in memory. */
public fun sha256Of(bytes: ByteArray): String = hexString(MessageDigest.getInstance("SHA-256").digest(bytes))

/** The SHA-256 of a whole source, read in chunks. */
public fun hashSource(source: ByteSource): String {
    val h = PackHasher()
    var at = 0L
    while (at < source.size) {
        val chunk = source.read(at, minOf(READ_CHUNK.toLong(), source.size - at).toInt())
        if (chunk.isEmpty()) break
        h.update(chunk)
        at += chunk.size
    }
    return h.digest()
}

/** Whether two strings are the same UTF-16 code units (Kotlin's `==` never normalises). */
internal fun sameBytes(a: String, b: String): Boolean = a == b
