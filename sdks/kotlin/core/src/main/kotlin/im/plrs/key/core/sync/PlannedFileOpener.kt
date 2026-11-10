// A `pkey-sync-file/1` opener whose last segment is known from the plan (WIRE-CONTRACT-V5 section 13.12): the export
// knows each file's plaintext size before it reads a byte, so a stream cut on a segment boundary still yields every whole
// segment before it fails, and no segment is held back waiting for the next byte to prove it is not the last.

package im.plrs.key.core.sync

import im.plrs.key.core.sync.SyncFileFormat.WHOLE_SEGMENT
import im.plrs.key.core.sync.SyncFileFormat.nonce
import im.plrs.key.core.sync.SyncFileFormat.parseHeader
import im.plrs.key.core.sync.SyncFileFormat.refuse
import im.plrs.key.core.sync.SyncFileFormat.segmentsOf

/** Opens a stored stream of a file of [plainSize] plaintext bytes under [collKey] and [kid]; holds at most one segment. */
public class PlannedFileOpener(private val collKey: ByteArray, private val kid: ByteArray, private val plainSize: Long) : ExportFileOpener {
    private val segments = segmentsOf(plainSize)
    private val head = ByteArray(SyncFileStream.HEADER_BYTES)
    private var headLen = 0
    private var parsed: SyncFileFormat.Parsed? = null
    private var key = ByteArray(0)
    private val buf = ByteArray(WHOLE_SEGMENT)
    private var len = 0
    private var index = 0L
    private var pending: SyncFileStream.Failure? = null

    override fun push(data: ByteArray): List<ByteArray> {
        pending?.let { throw it }
        val out = ArrayList<ByteArray>()
        try {
            feed(data, out)
        } catch (f: SyncFileStream.Failure) {
            if (out.isEmpty()) throw f
            pending = f
        }
        return out
    }

    override fun finish() {
        pending?.let { throw it }
        if (index < segments) refuse(SyncFileStream.Invalid.SHAPE)
    }

    /** The sealed length of the segment being read: the last one is as long as the plan says. */
    private fun want(): Int = if (index ==
        segments - 1
    ) {
        (plainSize - index * SyncFileStream.SEGMENT_BYTES).toInt() + SyncFileStream.TAG_BYTES
    } else {
        WHOLE_SEGMENT
    }

    private fun feed(data: ByteArray, out: MutableList<ByteArray>) {
        var at = 0
        while (at < data.size && index < segments) {
            at += if (parsed == null) header(data, at) else segment(data, at, out)
        }
    }

    private fun header(data: ByteArray, at: Int): Int {
        val take = minOf(head.size - headLen, data.size - at)
        data.copyInto(head, headLen, at, at + take)
        headLen += take
        if (headLen == head.size) {
            val p = parseHeader(head, kid)
            parsed = p
            key = SyncKeys.deriveFileKey(collKey, p.salt)
        }
        return take
    }

    private fun segment(data: ByteArray, at: Int, out: MutableList<ByteArray>): Int {
        val want = want()
        val take = minOf(want - len, data.size - at)
        data.copyInto(buf, len, at, at + take)
        len += take
        if (len == want) {
            val plain = SyncCrypto.aesGcmOpen(key, parsed!!.header, buf.copyOfRange(0, want), nonce(index, index == segments - 1))
                ?: refuse(SyncFileStream.Invalid.AUTH)
            index++
            len = 0
            out.add(plain)
        }
        return take
    }
}
