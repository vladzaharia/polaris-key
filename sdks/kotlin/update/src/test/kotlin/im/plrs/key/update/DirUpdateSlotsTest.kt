// @pkey-feature update.bootguard
//
// The default JVM UpdateSlots and BootGuardStore (UK-40, SP-K12; PARITY §5.5 note 9): staging,
// verification, the apply and rollback renames, recovery from a swap interrupted between its two
// renames, and the boot guard driving them end to end (apply-staged, counted launches, roll-back
// with skipVersion) with its state in a file.

package im.plrs.key.update

import im.plrs.key.core.BootEvent
import im.plrs.key.core.BootGuardAction
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DirUpdateSlotsTest {
    private fun tempDir(): File = Files.createTempDirectory("pkey-slots").toFile().also { it.deleteOnExit() }

    private fun payload(dir: File, text: String): Pair<File, SlotMeta> {
        val f = File(dir, "src-$text").also { it.writeText(text) }
        val sha = MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it.toInt() and 0xff) }
        return f to SlotMeta(text, sha, text.length.toLong())
    }

    @Test
    fun anEmptyRootHasNoSlots() = runBlocking {
        val slots = DirUpdateSlots(File(tempDir(), "slots"))
        assertNull(slots.current())
        assertNull(slots.staged())
        assertNull(slots.previous())
        assertFalse(slots.verifyStaged())
        assertFalse(slots.applyStaged())
        assertFalse(slots.rollBack())
    }

    @Test
    fun stageVerifyApplyAndRollBack() = runBlocking {
        val tmp = tempDir()
        val slots = DirUpdateSlots(File(tmp, "slots"))
        val (a, metaA) = payload(tmp, "1.1.0")
        slots.stage(a, metaA)
        assertEquals(metaA, slots.staged())
        assertTrue(slots.verifyStaged())
        assertTrue(slots.applyStaged())
        assertEquals(metaA, slots.current())
        assertNull(slots.staged())
        assertEquals("1.1.0", slots.payload("current")!!.readText())
        val (b, metaB) = payload(tmp, "1.2.0")
        slots.stage(b, metaB)
        assertTrue(slots.applyStaged())
        assertEquals(metaB, slots.current())
        assertEquals(metaA, slots.previous())
        assertTrue(slots.rollBack())
        assertEquals(metaA, slots.current())
        assertNull(slots.previous())
        slots.drop("current")
        assertNull(slots.current())
    }

    @Test
    fun aTamperedStagedPayloadDoesNotVerify() = runBlocking {
        val tmp = tempDir()
        val slots = DirUpdateSlots(File(tmp, "slots"))
        val (a, meta) = payload(tmp, "1.1.0")
        slots.stage(a, meta)
        File(slots.root, "staged/payload").writeText("1.1.X")
        assertFalse(slots.verifyStaged())
    }

    @Test
    fun aSwapInterruptedBetweenItsRenamesRecovers() = runBlocking {
        val tmp = tempDir()
        val slots = DirUpdateSlots(File(tmp, "slots"))
        val (a, metaA) = payload(tmp, "1.1.0")
        slots.stage(a, metaA)
        slots.applyStaged()
        val (b, metaB) = payload(tmp, "1.2.0")
        slots.stage(b, metaB)
        // The crash: current → previous happened, staged → current did not.
        Files.move(File(slots.root, "current").toPath(), File(slots.root, "previous").toPath())
        assertNull(slots.current())
        assertTrue(slots.verifyStaged())
        assertTrue(slots.applyStaged())
        assertEquals(metaB, slots.current())
        assertEquals("the earlier version is still the rollback target", metaA, slots.previous())
    }

    @Test
    fun theGuardOverDirectorySlotsAppliesCountsAndRollsBack() = runBlocking {
        val tmp = tempDir()
        val slots = DirUpdateSlots(File(tmp, "updates/slots"))
        val store = FileBootGuardStore(File(tmp, "updates/state.json"))
        val (a, metaA) = payload(tmp, "1.0.0")
        val (b, metaB) = payload(tmp, "1.1.0")
        slots.stage(a, metaA)
        slots.applyStaged()
        slots.stage(b, metaB)
        // The binary runs 1.0.0 (the current slot): the staged 1.1.0 is applied and the host restarts.
        val applied = BootGuard(store, slots, "1.0.0").run()
        assertEquals(BootEvent.GuardResult.applied, applied.result)
        assertTrue(applied.restart)
        assertEquals(metaB, slots.current())
        // 1.1.0 launches and never confirms, until the guard rolls it back.
        var outcome = BootGuard(store, slots, "1.1.0").run()
        assertEquals(BootEvent.GuardResult.applied, outcome.result)
        var launches = 1
        while (!outcome.restart && launches < 10) {
            outcome = BootGuard(store, slots, "1.1.0").run()
            launches++
        }
        assertEquals(BootGuardAction.rollBack, outcome.action)
        assertEquals(BootEvent.GuardResult.rolledBack, outcome.result)
        assertEquals(metaA, slots.current())
        assertEquals("1.1.0", BootGuard(store, slots, "1.0.0").skipVersion)
        assertTrue(store.file.isFile)
    }

    @Test
    fun withNothingStagedEveryLaunchIsOk() = runBlocking {
        val tmp = tempDir()
        val guard = BootGuard(FileBootGuardStore(File(tmp, "state.json")), DirUpdateSlots(File(tmp, "slots")), "2.0.0")
        repeat(5) { assertEquals(BootEvent.GuardResult.ok, guard.run().result) }
    }
}
