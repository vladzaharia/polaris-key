// `pkey-sync-cdc/1` (WIRE-CONTRACT-V5 §13.8.3): content-defined chunking of a file's plaintext,
// `fastcdc-2016-nc1`, streaming. Every implementation cuts at the same offsets (`cdcCases`).
//
//   gear[i]  xorshift32 from seed 0x9e3779b9: x ^= x << 13; x ^= x >> 17; x ^= x << 5 (32-bit),
//            one step per entry, 256 entries
//   min, max avg / 4 and avg * 4 (64 KiB, 256 KiB and 1 MiB by default)
//   masks    bits = log2(avg); the strict mask has the top bits + 1 bits set, the loose mask the
//            top bits - 1
//   scan     per chunk, h starts at 0 at offset min; h = (h << 1) + gear[byte] (32-bit); up to
//            offset avg a cut where h & strict == 0, after it where h & loose == 0; the cut is
//            after the matching byte, else at max (or at the end of the input)
//   tail     what remains is one chunk when it is at most min bytes
//
// The scan of a chunk never looks past `max` bytes, so a chunk is decided as soon as `max` bytes
// are buffered (or the input ends) and a chunker holds at most `max` bytes at a time.

package im.plrs.key.core.sync

import im.plrs.key.core.SYNC_CDC_AVG_BYTES
import im.plrs.key.core.SYNC_CDC_GEAR_SEED

public object SyncCdc {
    private const val MIN_AVG = 64
    private const val GEAR_ENTRIES = 256
    private const val MIN_DIVISOR_SHIFT = 2
    private const val MAX_FACTOR = 4
    private const val INT_BITS = 32
    private const val XS_A = 13
    private const val XS_B = 17
    private const val XS_C = 5
    private const val BYTE_MASK = 0xff

    public data class Params(val avg: Int, val min: Int, val max: Int)

    /** The parameters of `pkey-sync-cdc/1`: average 256 KiB, minimum 64 KiB, maximum 1 MiB. */
    public val DEFAULT_PARAMS: Params = requireNotNull(params(SYNC_CDC_AVG_BYTES))

    /** The parameters for an average chunk size, or null unless it is a power of two of at least 64. */
    public fun params(avg: Int): Params? {
        if (avg < MIN_AVG || (avg and (avg - 1)) != 0) return null
        return Params(avg, avg shr MIN_DIVISOR_SHIFT, avg * MAX_FACTOR)
    }

    private val gear: IntArray = IntArray(GEAR_ENTRIES).also { g ->
        var x = SYNC_CDC_GEAR_SEED.toInt()
        for (i in g.indices) {
            x = x xor (x shl XS_A)
            x = x xor (x ushr XS_B)
            x = x xor (x shl XS_C)
            g[i] = x
        }
    }

    private fun topMask(n: Int): Int = if (n >= INT_BITS) -1 else (-1 ushr n).inv()

    /** The length of the chunk at the start of `buf[0 until len]`: the rest of the input, or at least `max` bytes. */
    private fun cutLength(buf: ByteArray, len: Int, p: Params): Int {
        val bits = Integer.numberOfTrailingZeros(p.avg)
        val strict = topMask(bits + 1)
        val loose = topMask(bits - 1)
        val end = minOf(len, p.max)
        val normal = minOf(end, p.avg)
        var h = 0
        var i = p.min
        var cut = -1
        while (cut < 0 && i < end) {
            h = (h shl 1) + gear[buf[i].toInt() and BYTE_MASK]
            if (h and (if (i < normal) strict else loose) == 0) cut = i + 1
            i++
        }
        return if (len <= p.min) {
            len
        } else if (cut >= 0) {
            cut
        } else {
            end
        }
    }

    /** A push chunker: [push] returns the chunks that are decided, [finish] the rest. */
    public class Chunker(public val params: Params = DEFAULT_PARAMS) {
        private val buf = ByteArray(params.max)
        private var len = 0

        /** The chunks that [data] (its [from] until [to] range) completes, in order. Each is a fresh copy. */
        public fun push(data: ByteArray, from: Int = 0, to: Int = data.size): List<ByteArray> {
            require(from in 0..to && to <= data.size) { "bad range" }
            val out = ArrayList<ByteArray>()
            var at = from
            while (at < to) {
                val take = minOf(params.max - len, to - at)
                data.copyInto(buf, len, at, at + take)
                len += take
                at += take
                if (len == params.max) emit(out, cutLength(buf, len, params))
            }
            return out
        }

        /** The last chunks, once the input has ended. The chunker is empty afterwards. */
        public fun finish(): List<ByteArray> {
            val out = ArrayList<ByteArray>()
            while (len > 0) emit(out, cutLength(buf, len, params))
            return out
        }

        private fun emit(out: MutableList<ByteArray>, n: Int) {
            out.add(buf.copyOfRange(0, n))
            buf.copyInto(buf, 0, n, len)
            len -= n
        }
    }

    /** The chunk lengths of a whole buffer (tests and tools; production code streams). */
    public fun lengths(data: ByteArray, params: Params = DEFAULT_PARAMS): List<Int> {
        val c = Chunker(params)
        return (c.push(data) + c.finish()).map { it.size }
    }
}
