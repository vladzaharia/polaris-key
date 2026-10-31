// @pkey-feature ui.kit
// The SaveConflict state holder without a renderer (U-22.K4): the steps a choice goes through, that a
// choice is applied once, that Keep both needs a free slot and a copy, and that `kept` never follows a
// failure (UI-KITS Must not: a save is never discarded without a choice).
package im.plrs.key.ui

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PolarisSaveConflictStateTest {
    private val local = PolarisSaveVersion("today, 14:02")
    private val remote = PolarisSaveVersion("yesterday, 21:40", "Maya's Steam Deck")

    private class Fake : PolarisSaveResolver {
        val applied = mutableListOf<PolarisSaveKeep>()
        var gate: CompletableDeferred<Unit>? = null
        var failures = 0

        override suspend fun keep(keep: PolarisSaveKeep) {
            applied += keep
            gate?.await()
            if (failures > 0) {
                failures--
                error("no")
            }
        }
    }

    private fun TestScope.state(
        fake: Fake,
        remote: PolarisSaveVersion? = this@PolarisSaveConflictStateTest.remote,
        both: Boolean = true,
        newer: PolarisSaveNewer? = null,
    ) = PolarisSaveConflictState(local, remote, both, fake, backgroundScope, newer)

    @Test
    fun nothingIsAppliedUntilThePersonChoosesAndTheScreenTakesNoDefault() = runTest {
        val fake = Fake()
        val state = state(fake)
        runCurrent()
        assertEquals(PolarisSaveConflictUi.Choose, state.ui.value)
        assertTrue(fake.applied.isEmpty())
        val screen = state.kitScreen()!!
        assertEquals("choose", screen.state)
        assertEquals(listOf("cancel", "keep-both", "keep-local", "keep-remote"), screen.actions.map(KitAction::id))
    }

    @Test
    fun aChoiceRunsThenIsKeptAndNamesItselfOnce() = runTest {
        val fake = Fake()
        val gate = CompletableDeferred<Unit>()
        fake.gate = gate
        val state = state(fake)
        state.keep(PolarisSaveKeep.Local)
        runCurrent()
        assertEquals(PolarisSaveConflictUi.Keeping(PolarisSaveKeep.Local), state.ui.value)
        // No control is offered while it runs, and a second choice is ignored.
        assertTrue(state.kitScreen()!!.actions.isEmpty())
        state.keep(PolarisSaveKeep.Remote)
        state.cancel()
        gate.complete(Unit)
        runCurrent()
        assertEquals(listOf(PolarisSaveKeep.Local), fake.applied)
        assertEquals(PolarisSaveConflictUi.Kept(PolarisSaveKeep.Local), state.ui.value)
        assertTrue(state.kitScreen()!!.shows("saveConflict.keptLocalTitle"))
        // A kept result is closed by Done, and a later choice or Cancel changes nothing.
        state.keep(PolarisSaveKeep.Both)
        state.cancel()
        assertEquals(PolarisSaveConflictUi.Kept(PolarisSaveKeep.Local), state.ui.value)
        state.done()
        assertEquals(PolarisSaveConflictUi.Done, state.ui.value)
        assertNull(state.kitScreen())
    }

    @Test
    fun aFailureNeverSaysKeptAndTryAgainRepeatsTheSameChoice() = runTest {
        val fake = Fake()
        fake.failures = 1
        val state = state(fake)
        state.keep(PolarisSaveKeep.Remote)
        runCurrent()
        assertEquals(PolarisSaveConflictUi.Failed(PolarisSaveKeep.Remote), state.ui.value)
        val failed = state.kitScreen()!!
        assertEquals("failed", failed.state)
        assertFalse(failed.shows("saveConflict.keptRemoteTitle"))
        state.retry()
        runCurrent()
        assertEquals(listOf(PolarisSaveKeep.Remote, PolarisSaveKeep.Remote), fake.applied)
        assertEquals(PolarisSaveConflictUi.Kept(PolarisSaveKeep.Remote), state.ui.value)
    }

    @Test
    fun keepBothIsIgnoredWithoutAFreeSlotOrACopyToKeep() = runTest {
        val full = state(Fake(), both = false)
        assertEquals(listOf(KitAction.keepBoth), full.kitScreen()!!.disabledActions)
        assertFalse(KitAction.keepBoth in full.kitScreen()!!.actions)
        full.keep(PolarisSaveKeep.Both)
        assertEquals(PolarisSaveConflictUi.Choose, full.ui.value)
        val gone = state(Fake(), remote = null)
        gone.keep(PolarisSaveKeep.Both)
        assertEquals(PolarisSaveConflictUi.Choose, gone.ui.value)
        val screen = gone.kitScreen()!!
        assertTrue(screen.shows("saveConflict.deletedTitle"))
        assertFalse(screen.shows("saveConflict.title"))
    }

    @Test
    fun deletingTheOtherCopyIsKeptAsADeletion() = runTest {
        val fake = Fake()
        val state = state(fake, remote = null)
        state.keep(PolarisSaveKeep.Remote)
        runCurrent()
        assertTrue(state.kitScreen()!!.shows("saveConflict.keptDeletedTitle"))
    }

    @Test
    fun cancelLeavesTheConflictAsItWas() = runTest {
        val fake = Fake()
        val state = state(fake)
        state.cancel()
        assertEquals(PolarisSaveConflictUi.Cancelled, state.ui.value)
        assertTrue(fake.applied.isEmpty())
        assertNull(state.kitScreen())
    }

    @Test
    fun chooseAgainReturnsToTheChoicesWithTheSameVersionsAndAppliesNothing() = runTest {
        val fake = Fake()
        fake.failures = 1
        val state = state(fake, newer = PolarisSaveNewer.Remote)
        state.keep(PolarisSaveKeep.Local)
        runCurrent()
        val failed = state.kitScreen()!!
        assertEquals(listOf("cancel", "choose-again", "retry"), failed.actions.map(KitAction::id))
        state.chooseAgain()
        assertEquals(PolarisSaveConflictUi.Choose, state.ui.value)
        assertEquals(listOf(PolarisSaveKeep.Local), fake.applied)
        val choose = state.kitScreen()!!
        assertEquals("choose", choose.state)
        assertTrue(choose.shows("saveConflict.savedThis"))
        assertTrue(choose.shows("saveConflict.newerOther"))
        // Choose again is only for a failed choice.
        state.chooseAgain()
        assertEquals(PolarisSaveConflictUi.Choose, state.ui.value)
    }

    @Test
    fun newerTagsACardButNeverChoosesAndNeverAppearsWithOneCopy() = runTest {
        val tagged = state(Fake(), newer = PolarisSaveNewer.Local).kitScreen()!!
        assertTrue(tagged.shows("saveConflict.newerThis"))
        assertFalse(tagged.shows("saveConflict.newerOther"))
        val plain = state(Fake()).kitScreen()!!
        assertEquals(plain.actions, tagged.actions)
        val gone = state(Fake(), remote = null, newer = PolarisSaveNewer.Local).kitScreen()!!
        assertFalse(gone.shows("saveConflict.newerThis"))
        assertFalse(gone.shows("saveConflict.newerOther"))
    }

    @Test
    fun theDeletedVariantKeepsItsTitleAndFailedHasItsOwnLine() = runTest {
        val fake = Fake()
        fake.failures = 1
        val state = state(fake, remote = null)
        state.keep(PolarisSaveKeep.Remote)
        runCurrent()
        val failed = state.kitScreen()!!
        assertTrue(failed.shows("saveConflict.deletedTitle"))
        assertTrue(failed.shows("saveConflict.failedDeleted"))
        assertFalse(failed.shows("saveConflict.title"))
        assertFalse(failed.shows("saveConflict.failed"))
    }
}
