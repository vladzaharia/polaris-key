// The machine's server rows: the E2E read guards (rule M-1), the `encryptionSince` clamp (M-2), and the
// parked edits a newer remote value replaces.

package im.plrs.key.core.sync

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

/** What the guards say of one row: `bad` (unreadable) or `plain` (legacy plaintext at this `seq`). */
internal class RowFlag(val bad: Boolean = false, val plain: Long? = null)

internal class MachineRows(private val p: MachineParts) {
    private val core get() = p.core

    /**
     * E2E `encryptionSince`: only the host's open result counts. A row opened from a `ct` is good (and
     * lowers the clamp); one it could not open is bad; a plaintext row is legacy only while its host-mapped
     * `seq` stays below the partition's `encryptionSince` (judged on every read, and, with a [cursor], at
     * the cursor the request carried). A plaintext row with no `seq` is bad at once. Server mode reads all rows.
     */
    fun rowBad(part: SyncPartition, latchKey: String, version: Long?, openRow: OpenedRow?, cursor: Long?): RowFlag {
        val open = openRow ?: OpenedRow()
        val since = part.encryptionSince
        val seq = open.seq
        return when {
            !core.requiresE2e() -> RowFlag()

            open.invalid -> RowFlag(bad = true)

            open.sealed -> RowFlag().also { noteSealed(part, version, latchKey) }

            seq == null -> RowFlag(bad = true)

            // Guard (c): a key this machine has seen sealed never reads as legacy plaintext.
            latchKey != "" && latchKey in part.sealedKeys -> RowFlag(bad = true)

            // Guard (b): legacy only if the request's cursor was still below the boundary.
            cursor != null && (since == null || cursor >= since) -> RowFlag(bad = true)

            else -> RowFlag(plain = seq)
        }
    }

    /** A conflict's `server` copy as a held row, judged at the [cursor] the push carried (X-1). */
    fun copyRow(part: SyncPartition, latchKey: String, server: JsonObject, openRow: OpenedRow?, cursor: Long): SyncRow {
        val version = SyncNum.long(server["version"])!!
        val flag = rowBad(part, latchKey, version, openRow, cursor)
        return SyncRow(server["value"] ?: JsonNull, version, null, flag.bad, flag.plain)
    }

    /** Take a served boundary: the least ever served, held at or below the sealed floor. */
    fun lowerSince(part: SyncPartition, served: Long) {
        if (served < 0) return
        var since = minOf(part.encryptionSince ?: served, served)
        part.sealedFloor?.let { since = minOf(since, it) }
        part.encryptionSince = since
    }

    /** This machine pushed, or opened, a sealed row at [version]: no plaintext at or above it is legacy. */
    fun noteSealed(part: SyncPartition, version: Long?, latchKey: String) {
        if (!core.requiresE2e() || version == null) return
        if (latchKey != "" && part.sealedKeys.add(latchKey)) {
            part.sealedKeys.toList().take(maxOf(0, part.sealedKeys.size - SEALED_LATCH_MAX)).forEach { part.sealedKeys.remove(it) }
        }
        val floor = minOf(part.sealedFloor ?: version, version)
        part.sealedFloor = floor
        part.encryptionSince?.let { part.encryptionSince = minOf(it, floor) }
    }

    /** A newer remote value of a `lastWrite` key replaces its parked `set` or `clear` (R5). */
    fun dropParkedByRemote(part: SyncPartition, serverKey: String, editedHlc: String?) {
        if (editedHlc == null) return
        part.pending = part.pending.filterNot { o ->
            val t = o.target as? OpTarget.Setting
            val hlc = o.editedHlc
            o.parked != null && t != null && o.op in listOf("set", "clear") && p.routing.alias(t.key) == serverKey &&
                p.routing.policyOf(t.key) == "lastWrite" && hlc != null && hlc < editedHlc
        }.toMutableList()
    }

    /** The number a `max`/`min` record compares: the value, or its `field` member. */
    fun compared(v: JsonElement?, field: String?): JsonElement? = if (field != null && v is JsonObject) v[field] else v

    /** Whether [local] beats [server] under a `max` or `min` policy (numbers only). */
    fun better(policy: String, local: JsonElement?, server: JsonElement?): Boolean {
        val l = SyncNum.double(local)
        val s = SyncNum.double(server)
        return l != null && s != null && (if (policy == "max") l > s else l < s)
    }

    /** Whether a held row may be compared: opened sealed, not unreadable, not plaintext. */
    fun decidable(row: SyncRow): Boolean = !row.bad && row.plain == null
}
