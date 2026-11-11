// @pkey-feature connect.local
//
// LocalPairing's and PairedDevices' state holders over a fake driver, with a virtual clock (the Kotlin twin of ui-core's
// localPairingModel.test.ts and the Swift LocalPairingModelTests): the stale-code guard, the 30 s wait and its warning, the prompt that
// outlives a changed code, a busy Pair, a join that is cancelled, and the list's rows. Every step also resolves to its matrix screen.

package im.plrs.key.ui

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.LocalLinksCap
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

private class FakeOffer(override val label: String? = "Maya") : PolarisLocalOffer {
    override val categories = listOf("crates")
    var confirms = 0
    var declines = 0

    override suspend fun confirm() {
        confirms++
    }

    override suspend fun decline() {
        declines++
    }
}

private fun code(text: String, reason: String, expires: Long = 1300) = PolarisLocalCode(text, "PKP1:T:X:Y", reason, expires)

private class FakeLinks : PolarisLocalLinks {
    var gate = true
    var rows = listOf<PolarisPairedDevice>()
    var dials: Int? = 2
    var events: PolarisLocalEvents? = null
    var joinError: Throwable? = null
    var joinOffer: PolarisLocalOffer? = null
    var renameError: Throwable? = null
    var removeError: Throwable? = null
    var pairError: Throwable? = null
    var renewCode: PolarisLocalCode? = null
    var changed: (() -> Unit)? = null
    var stops = 0

    override fun localPairing() = gate

    override suspend fun list() = rows

    override suspend fun rename(id: String, label: String) {
        renameError?.let { throw it }
        rows = rows.map { if (it.id == id) it.copy(label = label) else it }
    }

    override suspend fun remove(id: String) {
        removeError?.let { throw it }
        rows = rows.filterNot { it.id == id }
    }

    override suspend fun setReachable(id: String, reachable: Boolean) = Unit

    override fun onChange(fn: () -> Unit): () -> Unit {
        changed = fn
        return {}
    }

    override fun dialsLeft(text: String) = dials

    override suspend fun pair(categories: List<String>, label: String?, events: PolarisLocalEvents): PolarisLocalWindow {
        pairError?.let { throw it }
        this.events = events
        return object : PolarisLocalWindow {
            override suspend fun stop() {
                stops++
            }

            override suspend fun renew(): PolarisLocalCode = renewCode ?: code("5000 0000", "opened")
        }
    }

    override suspend fun join(code: String, categories: List<String>, label: String?, onConfirm: (PolarisLocalOffer) -> Unit): PolarisLocalPaired {
        joinOffer?.let(onConfirm)
        joinError?.let { throw it }
        delay(50)
        return PolarisLocalPaired("L9", "Maya")
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class PolarisLocalPairingStateTest {
    private fun TestScope.make(links: FakeLinks = FakeLinks(), canOpenSettings: Boolean = false) =
        PolarisLocalPairingState(links, listOf("crates"), backgroundScope, "Studio PC", canOpenSettings = canOpenSettings, now = {
            1000.0 +
                currentTime / 1000.0
        })

    private suspend fun TestScope.shown(state: PolarisLocalPairingState, links: FakeLinks, text: String = "4812 3456") {
        state.start()
        state.show()
        assertEquals("opening", state.ui.value.step)
        links.events!!.onCode(code(text, "opened"))
        runCurrent()
    }

    @Test
    fun startReadsTheGateAndTheCap() = runTest {
        val off = FakeLinks().apply { gate = false }
        val a = make(off)
        a.start()
        assertEquals("off", a.ui.value.step)
        val full = FakeLinks().apply { rows = (0 until KitLocal.MAX_PAIRED).map { PolarisPairedDevice("L$it", null, null, true) } }
        val b = make(full)
        b.start()
        assertEquals("choose", b.ui.value.step)
        assertTrue(b.ui.value.full)
        assertEquals(listOf("localPairing.enter", "localPairing.show"), b.ui.value.screen().disabledKeys)
        b.show()
        assertEquals("choose", b.ui.value.step)
    }

    @Test
    fun showIsAPlaceholderUntilTheFirstCode() = runTest {
        val links = FakeLinks()
        val state = make(links)
        shown(state, links)
        assertEquals("show", state.ui.value.step)
        assertEquals(300, state.ui.value.secondsLeft)
        assertNull(state.ui.value.notice)
    }

    @Test
    fun aWrongCodeLightsTheChangedDigitsAndBumpsTheRotation() = runTest {
        val links = FakeLinks()
        val state = make(links)
        shown(state, links)
        val before = state.ui.value.rotation
        links.events!!.onCode(code("4812 9999", "wrong-code"))
        runCurrent()
        assertEquals("rotated", state.ui.value.notice)
        assertEquals(listOf(5, 6, 7, 8), state.ui.value.changed)
        assertEquals(before + 1, state.ui.value.rotation)
    }

    @Test
    fun fiveWrongCodesWarnThatSomeoneMayBeGuessing() = runTest {
        val links = FakeLinks()
        val state = make(links)
        shown(state, links)
        repeat(5) { n ->
            links.events!!.onCode(code("48${n}2 0000", "wrong-code"))
            runCurrent()
        }
        assertEquals("guessing", state.ui.value.notice)
    }

    @Test
    fun tooManyTriesWaitsThirtySecondsThenTheSecondTimeWarns() = runTest {
        val links = FakeLinks()
        val state = make(links)
        shown(state, links)
        links.events!!.onEnd("too-many-tries")
        runCurrent()
        assertEquals("closed", state.ui.value.step)
        assertEquals(30, state.ui.value.cooldownLeft)
        state.showNew()
        assertEquals("closed", state.ui.value.step)
        advanceTimeBy(10_000)
        runCurrent()
        assertEquals(20, state.ui.value.cooldownLeft)
        advanceTimeBy(25_000)
        runCurrent()
        assertEquals(0, state.ui.value.cooldownLeft)
        assertFalse(state.ui.value.warn)
        state.showNew()
        links.events!!.onCode(code("5000 0000", "opened"))
        runCurrent()
        links.events!!.onEnd("too-many-tries")
        runCurrent()
        assertTrue(state.ui.value.warn)
    }

    @Test
    fun aWindowThatRanOutHasNoWait() = runTest {
        val links = FakeLinks()
        val state = make(links)
        shown(state, links)
        links.events!!.onEnd("expired")
        runCurrent()
        assertEquals("expired", state.ui.value.closedBy)
        assertNull(state.ui.value.cooldownLeft)
    }

    @Test
    fun theSdkFloorIsWaitedOutNotShownAsAFailure() = runTest {
        val links = FakeLinks().apply { pairError = PolarisLocalFailure(ErrorCode.peerClosed, "cooldown") }
        val state = make(links)
        state.start()
        state.show()
        assertEquals("closed", state.ui.value.step)
        assertEquals("too-many-tries", state.ui.value.closedBy)
        assertTrue((state.ui.value.cooldownLeft ?: 0) > 0)
    }

    @Test
    fun thePromptOutlivesAChangedCodeSoTheNextDeviceIsNotRefused() = runTest {
        val links = FakeLinks()
        val state = make(links)
        shown(state, links)
        val maya = FakeOffer("Maya")
        links.events!!.onConfirm(maya)
        runCurrent()
        assertEquals("confirm", state.ui.value.step)
        links.events!!.onCode(code("4812 1111", "timeout"))
        runCurrent()
        assertEquals("show", state.ui.value.step)
        assertEquals("declined", state.ui.value.notice)
        assertEquals("Maya", state.ui.value.device)
        val theo = FakeOffer("Theo")
        links.events!!.onConfirm(theo)
        runCurrent()
        assertEquals("confirm", state.ui.value.step)
        assertEquals("Theo", state.ui.value.device)
        assertEquals(0, theo.declines)
    }

    @Test
    fun aSecondDeviceAtThePromptIsDeclined() = runTest {
        val links = FakeLinks()
        val state = make(links)
        shown(state, links)
        links.events!!.onConfirm(FakeOffer("Maya"))
        runCurrent()
        val theo = FakeOffer("Theo")
        links.events!!.onConfirm(theo)
        runCurrent()
        assertEquals("Maya", state.ui.value.device)
        assertEquals(1, theo.declines)
    }

    @Test
    fun pairIsBusyAfterThePressAndARepeatDoesNothing() = runTest {
        val links = FakeLinks()
        val state = make(links)
        shown(state, links)
        val offer = FakeOffer()
        links.events!!.onConfirm(offer)
        runCurrent()
        state.confirm()
        assertEquals("pair", state.ui.value.busy)
        assertEquals(listOf("common.notNow", "localPairing.pair"), state.ui.value.screen().disabledKeys)
        state.confirm()
        state.notNow()
        assertEquals(1, offer.confirms)
        assertEquals(0, offer.declines)
    }

    @Test
    fun blockedNoticeAtThreeInterruptionsAndTheNextCodeClearsIt() = runTest {
        val links = FakeLinks()
        val state = make(links)
        shown(state, links)
        links.events!!.onInterrupted(2)
        runCurrent()
        assertNull(state.ui.value.notice)
        links.events!!.onInterrupted(3)
        runCurrent()
        assertEquals("blocked", state.ui.value.notice)
        links.events!!.onCode(code("4812 2222", "wrong-code"))
        runCurrent()
        assertEquals("rotated", state.ui.value.notice)
    }

    @Test
    fun aStoredWindowGoesToPairedAndDoneRenames() = runTest {
        val links = FakeLinks().apply { rows = listOf(PolarisPairedDevice("L1", "Maya", null, false)) }
        val state = make(links)
        shown(state, links)
        links.events!!.onLinked(PolarisLocalPaired("L1", "Maya"))
        runCurrent()
        assertEquals("paired", state.ui.value.step)
        assertEquals("Maya", state.ui.value.name)
        assertTrue(state.ui.value.cantConnect)
        state.setName("Maya's phone")
        state.done()
        assertEquals("Maya's phone", links.rows.first().label)
        assertTrue(state.ui.value.left)
    }

    @Test
    fun aFailedRenameKeepsThePairedScreen() = runTest {
        val links = FakeLinks().apply { renameError = PolarisLocalFailure("store-failed") }
        val state = make(links)
        shown(state, links)
        links.events!!.onLinked(PolarisLocalPaired("L1", "Maya"))
        runCurrent()
        state.setName("Other")
        state.done()
        assertEquals("paired", state.ui.value.step)
        assertTrue(state.ui.value.nameError)
        assertFalse(state.ui.value.left)
    }

    @Test
    fun cancelOnTheCodeWithdrawsTheWindow() = runTest {
        val links = FakeLinks()
        val state = make(links)
        shown(state, links)
        state.cancel()
        assertEquals("choose", state.ui.value.step)
        assertEquals(1, links.stops)
    }

    @Test
    fun wrongKeepsTheFirstTwoDigitsAndHoldsPairUntilTheyDiffer() = runTest {
        val links = FakeLinks().apply { joinError = PolarisLocalFailure(ErrorCode.pairingCodeFailed, "wrong") }
        val state = make(links)
        state.start()
        state.enter()
        assertTrue(state.ui.value.pairDisabled)
        state.setEntry("48123456")
        assertEquals("4812 3456", state.ui.value.entry)
        assertFalse(state.ui.value.pairDisabled)
        state.pair()
        assertEquals("enter", state.ui.value.step)
        assertEquals("wrong", state.ui.value.error)
        assertEquals("48", state.ui.value.entry)
        state.setEntry("48123456")
        assertTrue("the failed code is held", state.ui.value.pairDisabled)
        state.pair()
        assertEquals("wrong", state.ui.value.error)
        state.setEntry("48123457")
        assertFalse(state.ui.value.pairDisabled)
    }

    @Test
    fun pairUnderEightDigitsAnswersItsReason() = runTest {
        val state = make()
        state.start()
        state.enter()
        state.setEntry("4873")
        state.pair()
        assertEquals("not-a-code", state.ui.value.error)
        assertEquals(listOf("localPairing.pair"), state.ui.value.screen().disabledKeys)
    }

    @Test
    fun spentLeavesAnEmptyEditableFieldAndNotFoundKeepsTheCode() = runTest {
        val spent = FakeLinks().apply { joinError = PolarisLocalFailure(ErrorCode.pairingCodeFailed, "spent") }
        val a = make(spent)
        a.start()
        a.enter()
        a.setEntry("48123456")
        a.pair()
        assertEquals("too-many", a.ui.value.error)
        assertEquals("", a.ui.value.entry)
        val missing = FakeLinks().apply { joinError = PolarisLocalFailure(ErrorCode.pairingNotFound) }
        val b = make(missing)
        b.start()
        b.enter()
        b.setEntry("48123456")
        b.pair()
        assertEquals("not-found", b.ui.value.error)
        assertEquals("4812 3456", b.ui.value.entry)
    }

    @Test
    fun theOtherPromptConfirmsAtOnceAndWaits() = runTest {
        val offer = FakeOffer("Theo")
        val links = FakeLinks().apply { joinOffer = offer }
        val state = make(links)
        state.start()
        state.enter()
        state.setEntry("48123456")
        launch { state.pair() }
        runCurrent()
        assertEquals("waiting", state.ui.value.step)
        assertEquals("Theo", state.ui.value.device)
        assertEquals(1, offer.confirms)
        advanceTimeBy(100)
        assertEquals("paired", state.ui.value.step)
    }

    @Test
    fun cancelWhileJoiningReturnsToTheFieldWithTheTypedCode() = runTest {
        val state = make()
        state.start()
        state.enter()
        state.setEntry("48123456")
        launch { state.pair() }
        runCurrent()
        assertEquals("joining", state.ui.value.step)
        state.cancel()
        assertEquals("enter", state.ui.value.step)
        assertEquals("4812 3456", state.ui.value.entry)
        advanceTimeBy(100)
        assertEquals("enter", state.ui.value.step)
    }

    @Test
    fun theNetworkAnswerReturnsToTheStepItCameFromAndFullOnShowReturnsToChoose() = runTest {
        val links = FakeLinks().apply { pairError = PolarisLocalFailure(ErrorCode.nearbyPermissionDenied) }
        val state = make(links, canOpenSettings = true)
        state.start()
        state.show()
        assertEquals("network-blocked", state.ui.value.step)
        assertTrue(state.ui.value.canOpenSettings)
        links.pairError = null
        state.retry()
        assertEquals("opening", state.ui.value.step)
        val full = FakeLinks().apply { pairError = PolarisLocalFailure(ErrorCode.localLinksFull, cap = LocalLinksCap.stored) }
        val b = make(full)
        b.start()
        b.show()
        assertEquals("choose", b.ui.value.step)
        assertTrue(b.ui.value.full)
    }

    // ── PairedDevices ───────────────────────────────────────────────────────────────────────────

    private fun rows(n: Int) = (1..n).map { PolarisPairedDevice("L$it", "Device $it", 1_700_000_000, true) }

    @Test
    fun theFirstReadShowsNothingAboutWhatIsPairedUntilItAnswers() = runTest {
        val links = FakeLinks().apply { rows = rows(2) }
        val state = PolarisPairedDevicesState(links)
        assertEquals("loading", state.ui.value.screen().state)
        state.start()
        assertEquals("list", state.ui.value.screen().state)
        assertTrue(state.ui.value.entryVisible)
        assertFalse(state.ui.value.screen().shows("pairedDevices.canConnect"))
    }

    @Test
    fun theSwitchColumnShowsWhenOneIsOffOrMoreThanEight() {
        assertFalse(KitLocal.showSwitchColumn(List(8) { true }))
        assertTrue(KitLocal.showSwitchColumn(List(9) { true }))
        assertTrue(KitLocal.showSwitchColumn(listOf(true, false, true)))
    }

    @Test
    fun aChangeFromTheSdkIsReadAgainAndGateOffKeepsTheRows() = runTest {
        val links = FakeLinks().apply { rows = rows(1) }
        val state = PolarisPairedDevicesState(links)
        state.start { reload -> launch { reload() } }
        links.rows = rows(3)
        links.changed!!.invoke()
        runCurrent()
        assertEquals(3, state.ui.value.devices.size)
        links.gate = false
        state.refresh()
        assertEquals("off", state.ui.value.step)
        assertTrue(state.ui.value.entryVisible)
    }

    @Test
    fun renameRefusalsKeepTheTextAndSayWhy() = runTest {
        val links = FakeLinks().apply { rows = rows(2) }
        val state = PolarisPairedDevicesState(links)
        state.start()
        state.startRename("L1")
        assertEquals("Device 1", state.ui.value.draft)
        state.setDraft("   ")
        state.saveRename()
        assertEquals("empty", state.ui.value.renameError)
        state.setDraft("x".repeat(65))
        state.saveRename()
        assertEquals("long", state.ui.value.renameError)
        assertEquals(65, state.ui.value.draft.length)
        links.renameError = PolarisLocalFailure("unknown")
        state.setDraft("New")
        state.saveRename()
        assertEquals("failed", state.ui.value.renameError)
        assertEquals("New", state.ui.value.draft)
        links.renameError = null
        state.saveRename()
        assertEquals("list", state.ui.value.step)
        assertEquals(PolarisPairedFocus.Row("L1"), state.ui.value.focus)
        assertEquals("New", state.ui.value.devices.first().label)
    }

    @Test
    fun forgetMovesFocusToTheNextRowThenTheTitleAndAFailedForgetKeepsTheQuestion() = runTest {
        val links = FakeLinks().apply { rows = rows(2) }
        val state = PolarisPairedDevicesState(links)
        state.start()
        state.askForget("L1")
        links.removeError = PolarisLocalFailure("unknown")
        state.confirmForget()
        assertEquals("forgetting", state.ui.value.step)
        assertTrue(state.ui.value.forgetError)
        assertTrue(state.ui.value.screen().shows("pairedDevices.forgetFailed"))
        links.removeError = null
        state.confirmForget()
        assertEquals(PolarisPairedFocus.Row("L2"), state.ui.value.focus)
        state.askForget("L2")
        state.confirmForget()
        assertEquals(PolarisPairedFocus.Title, state.ui.value.focus)
        assertEquals("empty", state.ui.value.screen().state)
    }

    @Test
    fun tryAgainOnTheBusyNoticeShowsItBusyUntilTheHostAnswers() = runTest {
        val links = FakeLinks().apply { rows = rows(2) }
        val state = PolarisPairedDevicesState(links)
        state.start()
        state.report("L2", "busy")
        state.retryNotice("L2")
        assertTrue(state.ui.value.noticeBusy)
        state.report("L2", null)
        assertFalse(state.ui.value.noticeBusy)
        assertNull(state.ui.value.notice)
    }

    @Test
    fun aNewCodeAfterShowNewIsMarkedReplacedSoItIsAnnounced() = runTest {
        val links = FakeLinks()
        val state = make(links)
        shown(state, links)
        assertFalse(state.ui.value.replaced)
        links.events!!.onCode(code("4812 1111", "wrong-code"))
        runCurrent()
        assertTrue(state.ui.value.replaced)
        state.showNew()
        assertTrue(state.ui.value.replaced)
    }

    @Test
    fun theAppsOwnAnswersAreShownWithTheList() = runTest {
        val links = FakeLinks().apply { rows = rows(2) }
        val state = PolarisPairedDevicesState(links)
        state.start()
        state.report("L2", "not-found")
        assertTrue(state.ui.value.screen().shows("pairedDevices.notFoundTitle"))
        state.report("L2", null)
        assertFalse(state.ui.value.screen().shows("pairedDevices.notFoundTitle"))
    }
}
