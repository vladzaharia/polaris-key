// @pkey-feature update.bootguard
//
// The boot guard over a host's slots (P6-08, Godot's P3-10 semantics): a staged update is applied
// and reported once, unconfirmed launches of an applied update are counted and two of them roll back
// on the third (recording the bad version as skipVersion), a confirmed launch resets the count, an
// install replaced from outside forgets the slots, stale staged code is dropped, and with no slots
// nothing is counted. The launch decision itself is stage-matrix.json's guard and confirm rows
// (StageMatrixTest).

package im.plrs.key.update

import im.plrs.key.core.BootConfirmation
import im.plrs.key.core.BootEvent
import im.plrs.key.core.BootGuardAction
import im.plrs.key.core.BootOutcome
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private class MemorySlots : UpdateSlots {
    var cur: SlotMeta? = null
    var stg: SlotMeta? = null
    var prev: SlotMeta? = null
    var stagedVerifies = true
    override fun current() = cur
    override fun staged() = stg
    override fun previous() = prev
    override fun drop(slot: String) {
        when (slot) {
            "current" -> cur = null
            "staged" -> stg = null
            "previous" -> prev = null
        }
    }
    override suspend fun verifyStaged() = stagedVerifies
    override suspend fun applyStaged(): Boolean {
        val s = stg ?: return false
        prev = cur
        cur = s
        stg = null
        return true
    }
    override suspend fun rollBack(): Boolean {
        val p = prev ?: return false
        cur = p
        prev = null
        return true
    }
}

private class MemoryGuardStore : BootGuardStore {
    var text: String? = null
    override fun read() = text
    override fun write(text: String) {
        this.text = text
    }
}

class BootGuardTest {
    private fun meta(v: String) = SlotMeta(v, "a".repeat(64), 10)

    @Test
    fun aStagedUpdateIsAppliedAndReportedOnce() = runBlocking {
        val slots = MemorySlots().apply { cur = meta("1.0.0"); stg = meta("1.1.0") }
        val store = MemoryGuardStore()
        val first = BootGuard(store, slots, "1.0.0").run()
        assertEquals(BootGuardAction.applyStaged, first.action)
        assertEquals(BootEvent.GuardResult.applied, first.result)
        assertTrue(first.restart)
        // The restarted launch runs the new version and reports the swap once.
        val second = BootGuard(store, slots, "1.1.0").run()
        assertEquals(BootEvent.GuardResult.applied, second.result)
        assertFalse(second.restart)
        val third = BootGuard(store, slots, "1.1.0").run()
        assertEquals(BootEvent.GuardResult.ok, third.result)
    }

    @Test
    fun twoUnconfirmedLaunchesRollBackOnTheThirdAndAConfirmedOneResets() = runBlocking {
        val slots = MemorySlots().apply { cur = meta("1.1.0"); prev = meta("1.0.0") }
        val store = MemoryGuardStore()
        assertEquals(BootGuardAction.none, BootGuard(store, slots, "1.1.0").run().action)
        // A confirmed launch resets the count.
        assertEquals(BootConfirmation.now, BootGuard(store, slots, "1.1.0").confirm(BootOutcome.waiting))
        assertEquals(BootGuardAction.none, BootGuard(store, slots, "1.1.0").run().action)
        assertEquals(BootGuardAction.none, BootGuard(store, slots, "1.1.0").run().action)
        val rolled = BootGuard(store, slots, "1.1.0").run()
        assertEquals(BootGuardAction.rollBack, rolled.action)
        assertEquals(BootEvent.GuardResult.rolledBack, rolled.result)
        assertTrue(rolled.restart)
        assertEquals("1.0.0", slots.cur?.version)
        assertEquals("1.1.0", BootGuard(store, slots, "1.0.0").skipVersion)
        assertEquals(BootEvent.GuardResult.rolledBack, BootGuard(store, slots, "1.0.0").run().result)
    }

    @Test
    fun readyConfirmsAfterOkSecondsAndErrorNever() = runBlocking {
        val slots = MemorySlots().apply { cur = meta("1.1.0") }
        val store = MemoryGuardStore()
        val g = BootGuard(store, slots, "1.1.0")
        g.run()
        assertEquals(BootConfirmation.afterOkSeconds, g.confirm(BootOutcome.ready))
        assertEquals(1L, BootGuardState.parse(store.text).failedBoots)
        g.confirmNow()
        assertEquals(0L, BootGuardState.parse(store.text).failedBoots)
        assertEquals(BootConfirmation.never, g.confirm(BootOutcome.error))
    }

    @Test
    fun aReplacedInstallForgetsTheSlotsAndStaleStagedCodeIsDropped() = runBlocking {
        val slots = MemorySlots().apply { cur = meta("1.1.0"); prev = meta("1.0.0"); stg = meta("1.0.5") }
        val store = MemoryGuardStore()
        // Installed from outside at 2.0.0: current and previous are forgotten; 1.0.5 is not newer.
        val r = BootGuard(store, slots, "2.0.0").run()
        assertEquals(BootGuardAction.none, r.action)
        assertNull(slots.cur)
        assertNull(slots.prev)
        assertNull(slots.stg)
        // Staged code that no longer verifies is dropped too.
        slots.stg = meta("3.0.0")
        slots.stagedVerifies = false
        assertEquals(BootGuardAction.none, BootGuard(store, slots, "2.0.0").run().action)
        assertNull(slots.stg)
    }

    @Test
    fun withoutSlotsNothingIsCounted() = runBlocking {
        val store = MemoryGuardStore()
        repeat(3) { assertEquals(BootEvent.GuardResult.ok, BootGuard(store, null, "1.0.0").run().result) }
        assertNull(store.text)
    }
}
