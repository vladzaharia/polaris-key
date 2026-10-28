// First contact with the Worker: the clock offset, the lifted pre-contact marks and a restamp of a
// far-off clock (Python `_first_contact`).

package im.plrs.key.core.sync

import im.plrs.key.core.SYNC_MAX_CLOCK_SKEW_MS

internal class MachineContact(private val p: MachineParts) {
    private val core get() = p.core

    /** The first answer sets the clock offset and lifts the pre-contact marks, restamping a far-off clock. */
    fun firstContact(serverNow: Long) {
        val s = core.s
        s.offsetMs = serverNow - core.now
        if (s.contacted) return
        s.contacted = true
        val offset = s.offsetMs
        val restamp = kotlin.math.abs(offset) > SYNC_MAX_CLOCK_SKEW_MS
        val shift = { h: String -> shifted(h, offset) }
        s.partitions.values.forEach { lift(it, restamp, shift) }
        for (d in core.drafts.values.filter { it.preContact }) {
            if (restamp) d.editedHlc = shift(d.editedHlc)
            d.preContact = false
        }
        if (restamp && s.hlcPhysical > 0) s.hlcPhysical += offset
    }

    private fun shifted(h: String, offset: Long): String = SyncValues.parseHlc(h).let { (ms, c) -> SyncValues.formatHlc(ms + offset, c) }

    private fun lift(part: SyncPartition, restamp: Boolean, shift: (String) -> String) {
        for (op in part.pending.filter { it.preContact }) {
            if (restamp) op.editedHlc?.let { op.editedHlc = shift(it) }
            op.preContact = false
        }
        for (d in part.device.values.filter { it.preContact }) {
            if (restamp) d.editedHlc = shift(d.editedHlc)
            d.preContact = false
        }
    }
}
