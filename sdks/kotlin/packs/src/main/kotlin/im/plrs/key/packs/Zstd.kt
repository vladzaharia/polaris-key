// The Kotlin zstd backend for packs (plans/P4-01.md §2.7, §5 "zstd per SDK"; PARITY §6.2; notes/E9),
// behind the same port as Swift's `Zstd.swift` (P6-08).
//
// zstd-jni (libzstd 1.5.7 through JNI) decodes every frame as a STREAM, so libzstd's own
// `ZSTD_d_windowLogMax` is enforced and nothing is sized from a frame header. A non-streamed decode
// (`decode`, `decodeWithPrefix`) allocates its output up front at the SIGNED size from the record or
// index, never the frame's declared content size; only `decodeStream` allocates as bytes arrive:
//
//   * plain frames: `ZstdInputStreamNoFinalizer` with `setLongMax(windowLogMax(size))`, read until the
//     frame ends; exactly `size` bytes or a refusal. A whole `full` payload streams to its sink
//     (`decodeStream`), so a large pack never sits in one buffer on a 2 GB device;
//   * `--patch-from` frames: the base loaded as the decoder's dictionary (`setDict`) with the
//     applier's `windowLogMax`. zstd-jni exposes no `ZSTD_DCtx_refPrefix`, only
//     `ZSTD_DCtx_loadDictionary`, which treats a base as RAW CONTENT unless it starts with the zstd
//     dictionary magic; §2.7 rule 5 keeps every published base from starting with it, and the
//     appliers refuse such a base before any decoder sees it (`prefixDecode`), so the two modes
//     decode every admitted frame alike. libzstd copies the dictionary, so a delta holds its base
//     twice while it decodes; `memBytes` (base + target) is the budget the planner checked.
//
// The window limit is the appliers' header check (`frameWindow` / `windowAllowed`), run before every
// prefix decode whatever the decoder. At start-up the backend decodes a tiny built-in prefix vector;
// `zstd-patch-from` is advertised only when that decodes byte for byte.
//
// Typed N/As (the registry's `packs.apply.delta` rows): a runtime where zstd-jni's native library
// cannot load (an unsupported OS/arch, or an Android build without the AAR's natives) has NO decoder:
// `selectZstd` answers `UnavailableZstd`, every zstd object fails its verdict, and
// `PackZstdInfo.unsupported` carries `dependency`. A decoder that loads but fails the probe (it ignored
// the dictionary) carries `version`. Never `runtime`.

package im.plrs.key.packs

import com.github.luben.zstd.ZstdInputStreamNoFinalizer
import im.plrs.key.core.Feature
import im.plrs.key.core.Unsupported
import im.plrs.key.core.UnsupportedReason
import java.io.ByteArrayInputStream
import java.io.InputStream

/** A zstd failure. */
public class ZstdException(message: String) : Exception(message)

/** P for this process: 31 on a 64-bit runtime, 30 on a 32-bit one. */
internal val POINTER_BITS: Int by lazy {
    val model = System.getProperty("sun.arch.data.model")
    val arch = System.getProperty("os.arch") ?: ""
    if (model == "32" || (model == null && !arch.contains("64"))) 30 else 31
}

/** An [InputStream] over a [ByteSource], read in [READ_CHUNK] pieces. */
private class SourceInputStream(private val source: ByteSource) : InputStream() {
    private var at = 0L
    private var buf = ByteArray(0)
    private var pos = 0

    private fun fill(): Boolean {
        if (pos < buf.size) return true
        if (at >= source.size) return false
        buf = source.read(at, minOf(READ_CHUNK.toLong(), source.size - at).toInt())
        pos = 0
        at += buf.size
        return buf.isNotEmpty()
    }

    override fun read(): Int = if (fill()) buf[pos++].toInt() and 0xff else -1

    override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (len == 0) return 0
        if (!fill()) return -1
        val n = minOf(len, buf.size - pos)
        System.arraycopy(buf, pos, b, off, n)
        pos += n
        return n
    }
}

/** libzstd through zstd-jni as a [ZstdPort]. */
public class LibZstd : ZstdPort {
    override val pointerBits: Int get() = POINTER_BITS

    override fun decode(frame: ByteArray, size: Int): ByteArray = decodeAll(ByteArrayInputStream(frame), null, size, windowLogMax(size.toLong(), pointerBits) ?: 10)

    override fun decodeWithPrefix(frame: ByteArray, prefix: ByteArray, size: Int, windowLogMax: Int): ByteArray =
        decodeAll(ByteArrayInputStream(frame), prefix, size, windowLogMax)

    private fun open(input: InputStream, dict: ByteArray?, wlm: Int): ZstdInputStreamNoFinalizer {
        val z = ZstdInputStreamNoFinalizer(input)
        try {
            z.setLongMax(wlm)
            if (dict != null) z.setDict(dict)
        } catch (e: Throwable) {
            z.close()
            throw ZstdException(e.message ?: "zstd setup failed")
        }
        return z
    }

    private fun decodeAll(input: InputStream, dict: ByteArray?, size: Int, wlm: Int): ByteArray {
        if (size < 0) throw ZstdException("negative size")
        val out = ByteArray(size)
        open(input, dict, wlm).use { z ->
            var got = 0
            try {
                while (got < size) {
                    val n = z.read(out, got, size - got)
                    if (n < 0) break
                    got += n
                }
                if (got != size) throw ZstdException("length $got is not $size")
                // The frame must end here: one more byte, or a truncated frame, is a refusal.
                if (z.read() != -1) throw ZstdException("overrun")
            } catch (e: ZstdException) {
                throw e
            } catch (e: Exception) {
                throw ZstdException(e.message ?: "zstd decode failed")
            }
        }
        return out
    }

    override val canStream: Boolean get() = true

    override fun decodeStream(frame: ByteSource, size: Long, onChunk: (ByteArray) -> Unit) {
        val wlm = windowLogMax(maxOf(size, 0), pointerBits) ?: 10
        open(SourceInputStream(frame), null, wlm).use { z ->
            val buf = ByteArray(1 shl 16)
            var total = 0L
            while (true) {
                val n = try {
                    z.read(buf, 0, buf.size)
                } catch (e: Exception) {
                    throw ZstdException(e.message ?: "zstd decode failed")
                }
                if (n < 0) break
                if (n == 0) continue
                total += n
                if (total > size) throw ZstdException("overrun")
                onChunk(buf.copyOf(n))
            }
            if (total != size) throw ZstdException("length $total is not $size")
        }
    }

    public companion object {
        /** Whether zstd-jni's native library loads in this process. */
        public val available: Boolean by lazy {
            try {
                com.github.luben.zstd.util.Native.load()
                com.github.luben.zstd.util.Native.isLoaded()
            } catch (e: Throwable) {
                false
            }
        }

        /** libzstd's version string, or null without the native library. */
        public val version: String? by lazy {
            if (!available) null else try {
                com.github.luben.zstd.ZstdDictCompress::class.java.`package`?.implementationVersion
                    ?: "1.5.7"
            } catch (e: Throwable) {
                null
            }
        }
    }
}

/** No decoder: every frame is refused (the `dependency` N/A at run time). */
public object UnavailableZstd : ZstdPort {
    override val pointerBits: Int get() = POINTER_BITS
    override fun decode(frame: ByteArray, size: Int): ByteArray = throw ZstdException("no zstd decoder")
    override fun decodeWithPrefix(frame: ByteArray, prefix: ByteArray, size: Int, windowLogMax: Int): ByteArray = throw ZstdException("no zstd decoder")
}

// ── The probe vector ────────────────────────────────────────────────────────────────────────────
// A 432-byte base and a `zstd --patch-from` frame (zstd 1.5.7) that decodes over it to a 469-byte
// target: the same vector as the Node, Python and Swift backends'.

public object ZstdProbe {
    public val base: ByteArray =
        (0 until 6).joinToString("") { "polaris key probe line ${"%03d".format(it)}: the quick brown fox jumps over the lazy dog\n" }
            .toByteArray(Charsets.US_ASCII)
    public val frame: ByteArray = hexBytes(
        "28b52ffd64d500150200540230736c65657079206361740a313278797a357461696c20616464656420666f70726f62650a0a00db6bf840c481b4bbab0c04d021809e01ca9ab04cf0c8b204205fff9e32",
    )
    public const val SIZE: Int = 469
    public const val SHA256: String = "cb0e436ee45ab5d453e18dd20612ce36c56e371dbf940bc5cabd20fd0ef27c27"

    /** base + target, so `windowLogMax` is 10. */
    public const val MEM_BYTES: Long = 901

    /** Whether a prefix decoder turns the probe vector into its target, byte for byte. */
    public fun passes(zstd: ZstdPort): Boolean {
        val wlm = windowLogMax(MEM_BYTES) ?: return false
        val out = try {
            zstd.decodeWithPrefix(frame, base, SIZE, wlm)
        } catch (e: Exception) {
            return false
        }
        return out.size == SIZE && sha256Of(out) == SHA256
    }
}

/** Which decoder serves frames, for diagnostics and `caps`. */
public data class PackZstdInfo(
    /** `libzstd <version> (zstd-jni)`, or `none`. */
    val library: String,
    /** `["zstd-patch-from"]` when the prefix decoder decodes the probe, else empty. */
    val patchMethods: List<String>,
    /** Why deltas are unsupported here (`packs.apply.delta`'s registry N/A), or null. */
    val unsupported: Unsupported? = null,
)

/** This process's zstd backend (probed once per call). */
public fun selectZstd(): Pair<ZstdPort, PackZstdInfo> {
    if (!LibZstd.available) {
        return UnavailableZstd to PackZstdInfo(
            "none", emptyList(),
            Unsupported(Feature.packsApplyDelta, UnsupportedReason.dependency, "zstd-jni's native library does not load on this runtime"),
        )
    }
    val z = LibZstd()
    val ok = ZstdProbe.passes(z)
    return z to PackZstdInfo(
        "libzstd ${LibZstd.version} (zstd-jni)",
        if (ok) listOf("zstd-patch-from") else emptyList(),
        if (ok) null else Unsupported(Feature.packsApplyDelta, UnsupportedReason.version, "this zstd decoder ignores the raw-content dictionary"),
    )
}
