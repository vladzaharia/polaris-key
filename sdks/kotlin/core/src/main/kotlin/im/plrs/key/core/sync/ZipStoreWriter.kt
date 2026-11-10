// A streaming STORED zip32 writer for the export (WIRE-CONTRACT-V5 section 13.12). Every entry is written as it arrives,
// with a data descriptor after its data, so memory is one piece of the caller's data and the central directory's records.
// `java.util.zip.ZipOutputStream` cannot do this: a STORED entry needs its size and CRC-32 up front, and its central
// directory lists entries in the order they were written, while the export lists them in the order of the contract.
//
// The layout is the one the overhead formula counts: a 30-byte local header, the data, a 16-byte descriptor and a
// 46-byte central record per entry (the name in the first and the last), then the 22-byte end record, with no extra
// field, no comment and no zip64. A write that would take the archive past zip32 (data, descriptors, central directory
// and end record together) or past 65,535 entries refuses with `sync-export-too-large` before it reaches the sink.

package im.plrs.key.core.sync

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.core.SYNC_EXPORT_MAX_BYTES
import im.plrs.key.core.SYNC_EXPORT_ZIP_END_BYTES
import im.plrs.key.core.SYNC_EXPORT_ZIP_ENTRY_BYTES
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.CRC32

private const val MAX_ENTRIES = 0xFFFF
private const val MAX_NAME_BYTES = 0xFFFF
private const val LOCAL_BYTES = 30
private const val DESCRIPTOR_BYTES = 16
private const val CENTRAL_BYTES = 46
private const val LOCAL_SIGNATURE = 0x04034B50
private const val DESCRIPTOR_SIGNATURE = 0x08074B50
private const val CENTRAL_SIGNATURE = 0x02014B50
private const val END_SIGNATURE = 0x06054B50

/** Version 2.0 to extract; no other feature is used. */
private const val VERSION_NEEDED = 20

/** Bit 3: sizes and CRC follow the data. Bit 11: names are UTF-8. */
private const val FLAGS = 0x0808

/** The fixed DOS date, 1980-01-01 (the time is 0): an archive never says when it was made. */
private const val DOS_DATE = 0x0021
private const val U32_MASK = 0xFFFFFFFFL

public class ZipStoreWriter(private val sink: ExportSink, private val limit: Long = SYNC_EXPORT_MAX_BYTES) {
    private class Done(val name: String, val raw: ByteArray, val offset: Long, val crc: Long, val size: Long)

    private class Open(val name: String, val raw: ByteArray, val offset: Long) {
        val crc = CRC32()
        var size = 0L
    }

    private var offset = 0L
    private val done = ArrayList<Done>()
    private val names = HashSet<String>()
    private var open: Open? = null
    private var finished = false

    /** What the archive still needs: central records of the entries done, the open entry's two, the end record. */
    private var reserve = SYNC_EXPORT_ZIP_END_BYTES.toLong()

    /** Bytes sent to the sink so far. */
    public val bytesWritten: Long get() = offset

    private fun tooLarge(what: String) = PolarisException(ErrorCode.syncExportTooLarge, "The export is too large: $what")

    private fun emit(b: ByteArray, from: Int = 0, to: Int = b.size) {
        sink.write(b, from, to - from)
        offset += to - from
    }

    private fun buffer(size: Int): ByteBuffer = ByteBuffer.allocate(size).order(ByteOrder.LITTLE_ENDIAN)

    private fun ByteBuffer.u16(v: Int): ByteBuffer = putShort(v.toShort())

    private fun ByteBuffer.u32(v: Long): ByteBuffer = putInt((v and U32_MASK).toInt())

    /** Starts an entry named [name]: the local header goes out now. */
    public fun begin(name: String) {
        check(!finished && open == null) { "zip: an entry is open or the archive is finished" }
        val raw = name.toByteArray(Charsets.UTF_8)
        require(raw.isNotEmpty() && raw.size <= MAX_NAME_BYTES) { "zip: entry name length" }
        require(names.add(name)) { "zip: entry name repeats" }
        if (done.size + 1 > MAX_ENTRIES) throw tooLarge("too many entries")
        val need = SYNC_EXPORT_ZIP_ENTRY_BYTES + 2L * raw.size
        if (offset + need + reserve > limit) throw tooLarge("over the size limit")
        reserve += DESCRIPTOR_BYTES + CENTRAL_BYTES + raw.size
        open = Open(name, raw, offset)
        val h = buffer(LOCAL_BYTES + raw.size)
        h.putInt(LOCAL_SIGNATURE).u16(VERSION_NEEDED).u16(FLAGS).u16(0).u16(0).u16(DOS_DATE)
        h.u32(0).u32(0).u32(0).u16(raw.size).u16(0).put(raw)
        emit(h.array())
    }

    /** Data of the open entry. */
    public fun write(data: ByteArray, from: Int = 0, to: Int = data.size) {
        val o = checkNotNull(open) { "zip: no entry is open" }
        val n = to - from
        if (n == 0) return
        if (offset + n + reserve > limit) throw tooLarge("over the size limit")
        o.crc.update(data, from, n)
        o.size += n
        emit(data, from, to)
    }

    /** Ends the open entry: its data descriptor goes out now. */
    public fun end() {
        val o = checkNotNull(open) { "zip: no entry is open" }
        // The descriptor's 16 bytes were reserved at `begin`.
        reserve -= DESCRIPTOR_BYTES
        open = null
        done.add(Done(o.name, o.raw, o.offset, o.crc.value, o.size))
        emit(buffer(DESCRIPTOR_BYTES).putInt(DESCRIPTOR_SIGNATURE).u32(o.crc.value).u32(o.size).u32(o.size).array())
    }

    public fun addBytes(name: String, data: ByteArray) {
        begin(name)
        write(data)
        end()
    }

    /** Writes the central directory (listing [order]: every entry once; omitted, as written) and the end record. Returns the archive's size. */
    public fun finish(order: List<String>? = null): Long {
        check(!finished && open == null) { "zip: an entry is open or the archive is finished" }
        val byName = done.associateBy { it.name }
        val listing = (order ?: done.map { it.name }).map { byName[it] }
        require(listing.size == done.size && listing.none { it == null } && listing.toSet().size == listing.size) {
            "zip: the order does not name every entry once"
        }
        finished = true
        val directoryAt = offset
        var directoryBytes = 0L
        for (d in listing.filterNotNull()) {
            val rec = buffer(CENTRAL_BYTES + d.raw.size)
            rec.putInt(CENTRAL_SIGNATURE).u16(VERSION_NEEDED).u16(VERSION_NEEDED).u16(FLAGS).u16(0).u16(0).u16(DOS_DATE)
            rec.u32(d.crc).u32(d.size).u32(d.size).u16(d.raw.size).u16(0).u16(0).u16(0).u16(0).u32(0).u32(d.offset).put(d.raw)
            directoryBytes += rec.capacity()
            emit(rec.array())
        }
        emit(
            buffer(
                SYNC_EXPORT_ZIP_END_BYTES,
            ).putInt(END_SIGNATURE).u16(0).u16(0).u16(listing.size).u16(listing.size).u32(directoryBytes).u32(directoryAt).u16(0).array(),
        )
        return offset
    }
}
