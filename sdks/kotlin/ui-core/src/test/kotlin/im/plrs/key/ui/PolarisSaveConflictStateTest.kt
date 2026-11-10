// @pkey-feature ui.kit
// @pkey-feature sync.conflict
// The SaveConflict state holder without a renderer (U-22.K4): the steps a choice goes through, that a
// choice is applied once, that Keep both needs a free slot and a copy, and that `kept` never follows a
// failure (UI-KITS Must not: a save is never discarded without a choice).
package im.plrs.key.ui

import im.plrs.key.core.sync.MergeKeep
import im.plrs.key.core.sync.MergeSide
import im.plrs.key.sdk.MergeOutcome
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
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

    // ── bound to a MergeRequest (U-08.K4): the copies, `newer` and the free slot come from the request, a choice is its keep ──

    private val mine = MergeSide(JsonNull, 3, savedAt = 1_700_000_000_000, device = "This PC")
    private val theirs = MergeSide(JsonNull, 7, savedAt = 1_700_100_000_000, device = "Maya's Steam Deck")

    @Test
    fun aStateBoundToARequestTakesItsCopiesNewerAndFreeSlotAndKeepsThroughIt() = runTest {
        val asked = mutableListOf<MergeKeep>()
        val resolver = PolarisSaveResolver.of {
            asked += it
            MergeOutcome.Kept("remote", 7)
        }
        val state = PolarisSaveConflictState.of(
            mine,
            theirs,
            listOf("local", "remote", "both"),
            "remote",
            resolver,
            backgroundScope,
            describe = { side, other -> PolarisSaveVersion("v${side.version}", if (other) side.device else null) },
        )
        val choose = state.kitScreen()!!
        assertEquals(listOf("cancel", "keep-both", "keep-local", "keep-remote"), choose.actions.map(KitAction::id))
        assertTrue(choose.shows("saveConflict.newerOther"))
        state.keep(PolarisSaveKeep.Remote)
        runCurrent()
        assertEquals(listOf<MergeKeep>(MergeKeep.Remote), asked)
        assertEquals(PolarisSaveConflictUi.Kept(PolarisSaveKeep.Remote), state.ui.value)
    }

    @Test
    fun aKeepThatFailedIsAFailureAndBothIsOfferedOnlyWhenTheRequestListsIt() = runTest {
        val resolver = PolarisSaveResolver.of { MergeOutcome.Refused("offline", reopened = true) }
        val full = PolarisSaveConflictState.of(mine, theirs, listOf("local", "remote"), null, resolver, backgroundScope)
        val screen = full.kitScreen()!!
        assertEquals(listOf(KitAction.keepBoth), screen.disabledActions)
        full.keep(PolarisSaveKeep.Both)
        runCurrent()
        assertEquals(PolarisSaveConflictUi.Choose, full.ui.value)
        full.keep(PolarisSaveKeep.Local)
        runCurrent()
        assertEquals(PolarisSaveConflictUi.Failed(PolarisSaveKeep.Local), full.ui.value)
        // The copy deleted elsewhere: no remote card, and the default medium date-time names the copy's time only.
        val gone = PolarisSaveConflictState.of(mine, null, listOf("local", "remote"), "remote", resolver, backgroundScope)
        assertFalse(gone.kitScreen()!!.shows("saveConflict.newerOther"))
    }

    /** keep, then a third write: back to the choices on the new remote, nothing applied, and a line says so. */
    @Test
    fun aKeepThatMeetsANewerCopyGoesBackToChooseOnTheNewRemote() = runTest {
        var request = PolarisSaveSides(mine.copy(savedAt = 1_700_200_000_000), theirs, listOf("local", "remote", "both"), "local")
        var calls = 0
        // The other device saves again, later than this one, while the keep runs: the request reopens on it.
        val state = PolarisSaveConflictState.of(
            { request },
            PolarisSaveResolver.of {
                calls++
                request = request.copy(remote = theirs.copy(version = 8, savedAt = 1_700_300_000_000), newer = "remote")
                MergeOutcome.Refused("conflict", reopened = true)
            },
            backgroundScope,
        )
        assertTrue(state.kitScreen()!!.shows("saveConflict.newerThis"))
        state.keep(PolarisSaveKeep.Local)
        runCurrent()
        assertEquals("never Failed: a Try again would overwrite a copy nobody saw", PolarisSaveConflictUi.Choose, state.ui.value)
        assertEquals(1, calls)
        val screen = state.kitScreen()!!
        assertTrue(screen.shows("saveConflict.reopened"))
        assertTrue("the cards are the request's now, not the ones the holder was built with", screen.shows("saveConflict.newerOther"))
        assertFalse(screen.shows("saveConflict.newerThis"))
        state.retry()
        runCurrent()
        assertEquals("Try again is for a failure only", 1, calls)
        // Choosing again clears the line.
        state.keep(PolarisSaveKeep.Remote)
        runCurrent()
        assertEquals(2, calls)
    }

    /** The pieces overload has fixed sides: a reopen closes it, so no keep can run on cards the person never saw. */
    @Test
    fun aReopenOnFixedPiecesClosesTheScreenAndNeverSendsAKeep() = runTest {
        val asked = mutableListOf<MergeKeep>()
        val state = PolarisSaveConflictState.of(
            mine,
            theirs,
            listOf("local", "remote", "both"),
            null,
            PolarisSaveResolver.of {
                asked += it
                MergeOutcome.Refused("conflict", reopened = true)
            },
            backgroundScope,
        )
        state.keep(PolarisSaveKeep.Local)
        runCurrent()
        assertEquals(PolarisSaveConflictUi.Cancelled, state.ui.value)
        assertNull(state.kitScreen())
        state.keep(PolarisSaveKeep.Remote)
        state.keep(PolarisSaveKeep.Both)
        state.retry()
        runCurrent()
        assertEquals("only the first keep was sent", listOf<MergeKeep>(MergeKeep.Local), asked)
    }

    @Test
    fun aClosedRequestClosesTheScreenAndASlotsFullReopenDisablesKeepBoth() = runTest {
        val closed = PolarisSaveConflictState.of(
            mine,
            theirs,
            listOf("local", "remote", "both"),
            null,
            PolarisSaveResolver.of {
                MergeOutcome.Refused("sync-merge-closed", reopened = false)
            },
            backgroundScope,
        )
        closed.keep(PolarisSaveKeep.Local)
        runCurrent()
        assertEquals(PolarisSaveConflictUi.Cancelled, closed.ui.value)
        assertNull(closed.kitScreen())
        val choices = mutableListOf("local", "remote", "both")
        val full = PolarisSaveConflictState.of(
            mine,
            theirs,
            choices,
            null,
            PolarisSaveResolver.of {
                MergeOutcome.Refused("slots-full", reopened = true)
            },
            backgroundScope,
        )
        full.keep(PolarisSaveKeep.Both)
        runCurrent()
        assertEquals(PolarisSaveConflictUi.Choose, full.ui.value)
        assertFalse(full.kitScreen()!!.shows("saveConflict.reopened"))
    }

    @Test
    fun theDefaultWhenIsAWordedDayOrAShortDate() {
        val zone = java.time.ZoneId.of("UTC")
        val now = java.time.Instant.parse("2026-11-05T12:00:00Z")
        fun at(s: String) = java.time.Instant.parse(s).toEpochMilli()
        val en = java.util.Locale.US
        assertTrue(PolarisWhen.worded(at("2026-11-05T10:42:00Z"), en, now, zone).startsWith("today, 10:42"))
        assertTrue(PolarisWhen.worded(at("2026-11-04T21:40:00Z"), en, now, zone).startsWith("yesterday, 9:40"))
        val sameYear = PolarisWhen.worded(at("2026-10-30T10:12:00Z"), en, now, zone)
        assertTrue(sameYear, sameYear.startsWith("Oct 30, ") && !sameYear.contains("2026"))
        assertTrue(PolarisWhen.worded(at("2025-10-30T10:12:00Z"), en, now, zone).contains("2025"))
        assertTrue(PolarisWhen.worded(at("2026-11-05T10:42:00Z"), java.util.Locale.GERMANY, now, zone).startsWith("heute, 10:42"))
        val de = PolarisWhen.worded(at("2026-10-30T10:12:00Z"), java.util.Locale.GERMANY, now, zone)
        assertTrue(de, !de.contains("2026"))
        val ja = PolarisWhen.worded(at("2026-10-30T10:12:00Z"), java.util.Locale.JAPAN, now, zone)
        assertTrue(ja, !ja.contains("2026"))
    }
}
