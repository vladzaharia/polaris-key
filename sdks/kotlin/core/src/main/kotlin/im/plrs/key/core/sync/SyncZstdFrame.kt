// The one field of a zstd frame header the chunk reader needs before it decodes anything: the
// content size (RFC 8878 §3.1.1). A reader checks it against its cap first, so a frame that
// claims a huge output is refused before any buffer is sized from it.

package im.plrs.key.core.sync

public object SyncZstdFrame {
    private const val MIN_HEADER = 6
    private const val DESCRIPTOR_AT = 4
    private const val FLAG_SHIFT = 6
    private const val SINGLE_SHIFT = 5
    private const val DICT_MASK = 3
    private const val SMALL_FIELD_OFFSET = 256L
    private const val BYTE_MASK = 0xff
    private const val BYTE_BITS = 8

    /** Declared sizes from here are far over any cap; the reader stops shifting before a Long overflows. */
    private const val SIZE_CLAMP: Long = 1L shl 47

    // RFC 8878 tables: the frame magic, the bytes of a dictionary id and of a content-size field.
    @Suppress("MagicNumber")
    private val magic = intArrayOf(0x28, 0xb5, 0x2f, 0xfd)

    @Suppress("MagicNumber")
    private val dictBytes = intArrayOf(0, 1, 2, 4)

    @Suppress("MagicNumber")
    private val sizeBytes = intArrayOf(0, 2, 4, 8)

    /**
     * The content size [f]'s header declares, or null when the frame does not start with the magic,
     * is cut short or declares none. A size too large to be real answers [Int.MAX_VALUE], which
     * every caller refuses as too large.
     */
    public fun contentSize(f: ByteArray): Int? {
        val hasMagic = f.size >= MIN_HEADER && magic.indices.all { (f[it].toInt() and BYTE_MASK) == magic[it] }
        val d = if (hasMagic) f[DESCRIPTOR_AT].toInt() and BYTE_MASK else 0
        val flag = d ushr FLAG_SHIFT
        val single = (d ushr SINGLE_SHIFT) and 1
        val at = DESCRIPTOR_AT + 1 + (1 - single) + dictBytes[d and DICT_MASK]
        val width = if (flag == 0) single else sizeBytes[flag]
        return if (hasMagic && width != 0 && f.size >= at + width) read(f, at, width, flag) else null
    }

    private fun read(f: ByteArray, at: Int, width: Int, flag: Int): Int {
        var v = 0L
        for (i in width - 1 downTo 0) v = if (v >= SIZE_CLAMP) v else (v shl BYTE_BITS) or (f[at + i].toLong() and BYTE_MASK.toLong())
        val size = v + (if (flag == 1) SMALL_FIELD_OFFSET else 0L)
        return if (size > Int.MAX_VALUE) Int.MAX_VALUE else size.toInt()
    }
}
