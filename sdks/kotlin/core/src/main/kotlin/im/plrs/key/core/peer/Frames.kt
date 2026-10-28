// WIRE-CONTRACT-V5 section 15.6: TCP framing, `u16be len || Noise message`, len 1 to 65,535
// (CC-12.3). Mirrors client-core's `peer/frame.ts`. A zero length closes the session with
// `peer_bad_frame`, wherever it occurs.

package im.plrs.key.core.peer

/** The largest frame body. */
public const val MAX_FRAME: Int = 65535

private const val HEADER = 2
private const val BYTE = 0xff
private const val SHIFT = 8

/** `u16be len || noise`. Throws [IllegalArgumentException] for a body of 0 or over 65,535 bytes. */
public fun encodeFrame(noise: ByteArray): ByteArray {
    require(noise.size in 1..MAX_FRAME) { "frame length" }
    val out = ByteArray(HEADER + noise.size)
    out[0] = (noise.size shr SHIFT).toByte()
    out[1] = (noise.size and BYTE).toByte()
    noise.copyInto(out, HEADER)
    return out
}

/** The result of cutting a byte stream into frames. */
public sealed class FrameDecode {
    /** The complete frames and the unread rest (a trailing partial frame). */
    public class Frames(public val frames: List<ByteArray>, public val rest: ByteArray) : FrameDecode() {
        override fun toString(): String = "Frames(${frames.size})"
    }

    /** A zero length: the session closes with `peer_bad_frame`. */
    public object BadFrame : FrameDecode() {
        public const val CODE: String = "peer_bad_frame"
    }
}

private fun lengthAt(b: ByteArray, at: Int): Int = ((b[at].toInt() and BYTE) shl SHIFT) or (b[at + 1].toInt() and BYTE)

/** Cuts a byte stream into frames; a trailing partial frame is `rest`. A zero length is [FrameDecode.BadFrame]. */
public fun decodeFrames(stream: ByteArray): FrameDecode {
    val frames = ArrayList<ByteArray>()
    var i = 0
    while (stream.size - i >= HEADER) {
        val len = lengthAt(stream, i)
        if (len == 0) return FrameDecode.BadFrame
        if (stream.size - i - HEADER < len) break
        frames += stream.copyOfRange(i + HEADER, i + HEADER + len)
        i += HEADER + len
    }
    return FrameDecode.Frames(frames, stream.copyOfRange(i, stream.size))
}

/**
 * A stateful reader over a socket's chunks. One growing buffer and an offset: every byte is copied
 * in once and out once, so a peer that trickles a frame one byte at a time costs linear work
 * ([copied] counts the bytes moved, for the test). Not thread safe: one reader per socket.
 */
public class FrameReader {
    private var buf = ByteArray(1024)
    private var start = 0
    private var end = 0

    /** Bytes moved so far. */
    public var copied: Long = 0
        private set

    /** Adds [chunk] and returns the frames now complete, or null after a zero length (close `peer_bad_frame`). */
    public fun push(chunk: ByteArray): List<ByteArray>? {
        grow(chunk.size)
        chunk.copyInto(buf, end)
        end += chunk.size
        copied += chunk.size
        val frames = ArrayList<ByteArray>()
        while (end - start >= HEADER) {
            val len = lengthAt(buf, start)
            if (len == 0) {
                reset()
                return null
            }
            if (end - start - HEADER < len) break
            frames += buf.copyOfRange(start + HEADER, start + HEADER + len)
            copied += len
            start += HEADER + len
        }
        if (start == end) reset()
        return frames
    }

    private fun grow(extra: Int) {
        if (end + extra <= buf.size) return
        val live = end - start
        var cap = buf.size
        while (cap < live + extra) cap *= 2
        val next = if (cap == buf.size) buf else ByteArray(cap)
        buf.copyInto(next, 0, start, end)
        copied += live
        buf = next
        start = 0
        end = live
    }

    private fun reset() {
        start = 0
        end = 0
    }

    override fun toString(): String = "FrameReader"
}
