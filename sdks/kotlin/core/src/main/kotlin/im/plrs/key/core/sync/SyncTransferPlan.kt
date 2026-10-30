// The upload planner (WIRE-CONTRACT-V5 §13.8.1): from a stored size and the collection's
// `files.delta`, the mode of a file transfer, the part size of a multipart one and its part count.
// `begin` answers the same numbers; a client plans first so it can pick `format` and slice parts.
//
//   TOO_LARGE  over SYNC_FILE_MAX_BYTES (1 GiB)
//   CHUNKS     files.delta and at least 1 MiB (chunked, never multipart)
//   SINGLE     at most SYNC_SINGLE_PUT_MAX_BYTES (16 MiB): one PUT
//   MULTIPART  otherwise: partBytes = clamp(8 MiB .. 64 MiB, ceil(size / 9,999) up to a MiB)

package im.plrs.key.core.sync

import im.plrs.key.core.SYNC_FILE_MAX_BYTES
import im.plrs.key.core.SYNC_MAX_PARTS
import im.plrs.key.core.SYNC_PART_MAX_BYTES
import im.plrs.key.core.SYNC_PART_MIN_BYTES
import im.plrs.key.core.SYNC_PART_ROUND_BYTES
import im.plrs.key.core.SYNC_SINGLE_PUT_MAX_BYTES

public object SyncTransferPlan {
    /** A file below this is never chunked, even when its collection has `files.delta`. */
    public const val CHUNKED_MIN_BYTES: Long = 1_048_576L

    /** The mode of a transfer; [wire] is the word `begin` and the corpus use. */
    public enum class Mode(public val wire: String) {
        SINGLE("single"),
        MULTIPART("multipart"),
        CHUNKS("chunks"),
        TOO_LARGE("too_large"),
    }

    /** [partBytes] (every part but the last) and [parts] are set only for [Mode.MULTIPART]. */
    public data class Plan(val mode: Mode, val partBytes: Long?, val parts: Long?)

    /** The plan for a stored file of [size] bytes (the sealed size in E2E mode, [SyncFileStream.sealedSize]). */
    public fun plan(size: Long, delta: Boolean): Plan {
        require(size >= 0) { "transfer size" }
        return when {
            size > SYNC_FILE_MAX_BYTES -> Plan(Mode.TOO_LARGE, null, null)

            delta && size >= CHUNKED_MIN_BYTES -> Plan(Mode.CHUNKS, null, null)

            size <= SYNC_SINGLE_PUT_MAX_BYTES -> Plan(Mode.SINGLE, null, null)

            else -> {
                val perPart = ceilDiv(size, SYNC_MAX_PARTS.toLong())
                val rounded = ceilDiv(perPart, SYNC_PART_ROUND_BYTES.toLong()) * SYNC_PART_ROUND_BYTES
                val partBytes = rounded.coerceIn(SYNC_PART_MIN_BYTES.toLong(), SYNC_PART_MAX_BYTES.toLong())
                Plan(Mode.MULTIPART, partBytes, ceilDiv(size, partBytes))
            }
        }
    }

    /** Part [n] (from 1) of a multipart [plan] as a half-open byte range of the stored file of [size] bytes. */
    public fun partRange(plan: Plan, size: Long, n: Long): LongRange {
        val partBytes = plan.partBytes
        val parts = plan.parts
        require(plan.mode == Mode.MULTIPART && partBytes != null && parts != null) { "not a multipart plan" }
        require(n in 1..parts) { "part number" }
        val start = (n - 1) * partBytes
        return start until minOf(size, start + partBytes)
    }

    private fun ceilDiv(a: Long, b: Long): Long = (a + b - 1) / b
}
