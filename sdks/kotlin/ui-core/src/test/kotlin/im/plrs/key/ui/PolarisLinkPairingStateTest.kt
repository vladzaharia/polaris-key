// @pkey-feature connect.links
//
// The pairing window's state holder (CC-19.10) over a fake driver, the Kotlin twin of ui-core's linkPairingModel.test.ts: open, the
// code with the categories, confirm, linked and failed; one device at a time; decline keeps the window; a late callback from a closed
// window is dropped; a session nobody saw fails silently; links off is its own state. Every step also resolves to its UI matrix screen.

package im.plrs.key.ui

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

class PolarisLinkPairingStateTest {
    private class Offer(override val label: String? = "Maya's laptop", override val code: String = "123 456") : PolarisLinkOffer {
        override val categories = listOf("contacts", "photos")
        val confirms = AtomicInteger()
        val declines = AtomicInteger()
        var confirmFails = false

        override suspend fun confirm() {
            confirms.incrementAndGet()
            if (confirmFails) error("closed")
        }

        override suspend fun decline() {
            declines.incrementAndGet()
        }
    }

    private class Window : PolarisLinkWindow {
        val stops = AtomicInteger()

        override suspend fun stop() {
            stops.incrementAndGet()
        }
    }

    private class Driver(var fails: Throwable? = null) : PolarisLinkPairingActions {
        val window = Window()
        val opens = AtomicInteger()
        var onCode: (PolarisLinkOffer) -> Unit = {}
        var onLinked: (String?, List<String>) -> Unit = { _, _ -> }
        var onFailed: (PolarisLinkFailure) -> Unit = {}
        var seconds: Double? = null

        override suspend fun pair(
            categories: List<String>,
            label: String?,
            seconds: Double?,
            onCode: (PolarisLinkOffer) -> Unit,
            onLinked: (String?, List<String>) -> Unit,
            onFailed: (PolarisLinkFailure) -> Unit,
        ): PolarisLinkWindow {
            opens.incrementAndGet()
            fails?.let { throw it }
            this.onCode = onCode
            this.onLinked = onLinked
            this.onFailed = onFailed
            this.seconds = seconds
            return window
        }

        override fun isUnavailable(error: Throwable): Boolean = error is IllegalStateException && error.message == "off"
    }

    private fun state(driver: Driver) = PolarisLinkPairingState(
        driver,
        categories = listOf("contacts", "photos"),
        label = "Ana's phone",
        seconds = 120.0,
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined),
        cleanup = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined),
    )

    private fun PolarisLinkPairingState.screen() = PolarisLinkPairingState.inputsFor(ui.value)?.let {
        KitStates.resolve(KitComponent.linkPairing, it)
    }

    @Test
    fun idleDrawsNothing() {
        val s = state(Driver())
        assertEquals(PolarisLinkStep.Idle, s.ui.value.step)
        assertNull(s.screen())
    }

    @Test
    fun startOpensTheWindowAndAnOfferShowsItsCodeLabelAndCategories() {
        val d = Driver()
        val s = state(d)
        s.start()
        assertEquals("open", s.screen()!!.state)
        assertEquals(120.0, d.seconds)
        d.onCode(Offer())
        val shown = s.ui.value
        assertEquals(PolarisLinkStep.Code, shown.step)
        assertEquals("123 456", shown.code)
        assertEquals("Maya's laptop", shown.device)
        assertEquals(listOf("contacts", "photos"), shown.categories)
        val screen = s.screen()!!
        assertEquals("code", screen.state)
        assertTrue(screen.shows("linkPairing.reported"))
        // The code is spelled for a screen reader, digit by digit.
        assertEquals("1 2 3   4 5 6", (screen.copy.first { it.key == "a11y.linkCode" }.args["code"] as CopyArgument.Text).value)
    }

    @Test
    fun anOfferWithNoLabelSaysSo() {
        val d = Driver()
        val s = state(d)
        s.start()
        d.onCode(Offer(label = "  "))
        assertNull(s.ui.value.device)
        assertTrue(s.screen()!!.shows("linkPairing.reportedUnnamed"))
    }

    @Test
    fun confirmWaitsThenLinks() {
        val d = Driver()
        val s = state(d)
        s.start()
        val offer = Offer()
        d.onCode(offer)
        s.confirm()
        assertEquals(1, offer.confirms.get())
        assertEquals("confirm", s.screen()!!.state)
        // The code stays on screen through the wait.
        assertEquals("123 456", s.ui.value.code)
        d.onLinked("Maya's laptop", listOf("contacts"))
        assertEquals("linked", s.screen()!!.state)
        assertEquals(listOf("contacts"), s.ui.value.categories)
        // Nothing is left to confirm.
        s.confirm()
        assertEquals(1, offer.confirms.get())
    }

    @Test
    fun aSecondDeviceWhileOneIsOnScreenIsDeclined() {
        val d = Driver()
        val s = state(d)
        s.start()
        val first = Offer()
        val second = Offer(label = "Other", code = "999 999")
        d.onCode(first)
        d.onCode(second)
        assertEquals("123 456", s.ui.value.code)
        assertEquals(1, second.declines.get())
        assertEquals(0, first.declines.get())
    }

    @Test
    fun declineClosesThatSessionAndTheWindowStaysOpen() {
        val d = Driver()
        val s = state(d)
        s.start()
        val offer = Offer()
        d.onCode(offer)
        s.decline()
        assertEquals(1, offer.declines.get())
        assertEquals(PolarisLinkStep.Open, s.ui.value.step)
        assertEquals(0, d.window.stops.get())
        // The next device gets the window.
        d.onCode(Offer(code = "777 777"))
        assertEquals("777 777", s.ui.value.code)
    }

    @Test
    fun aFailureShowsItsReasonAndTryAgainOpensAFreshWindow() {
        val d = Driver()
        val s = state(d)
        s.start()
        d.onCode(Offer())
        d.onFailed(PolarisLinkFailure.Full)
        assertEquals(PolarisLinkFailure.Full, s.ui.value.reason)
        val screen = s.screen()!!
        assertEquals("failed", screen.state)
        assertTrue(screen.shows("linkPairing.failedFull"))
        s.start()
        assertEquals(2, d.opens.get())
        assertEquals(1, d.window.stops.get())
        assertEquals(PolarisLinkStep.Open, s.ui.value.step)
    }

    @Test
    fun aSessionNobodySawFailsSilently() {
        val d = Driver()
        val s = state(d)
        s.start()
        d.onFailed(PolarisLinkFailure.Timeout)
        assertEquals(PolarisLinkStep.Open, s.ui.value.step)
    }

    @Test
    fun aConfirmThatThrowsEndsAsClosed() {
        val d = Driver()
        val s = state(d)
        s.start()
        d.onCode(Offer().also { it.confirmFails = true })
        s.confirm()
        assertEquals(PolarisLinkStep.Failed, s.ui.value.step)
        assertEquals(PolarisLinkFailure.Closed, s.ui.value.reason)
    }

    @Test
    fun cancelClosesTheWindowAndALateCallbackIsDropped() {
        val d = Driver()
        val s = state(d)
        s.start()
        val offer = Offer()
        d.onCode(offer)
        val late = d.onLinked
        s.cancel()
        assertEquals(PolarisLinkStep.Idle, s.ui.value.step)
        assertEquals(1, offer.declines.get())
        assertEquals(1, d.window.stops.get())
        late("Maya's laptop", listOf("contacts"))
        assertEquals(PolarisLinkStep.Idle, s.ui.value.step)
    }

    @Test
    fun linksOffForTheProductIsItsOwnState() {
        val s = state(Driver(fails = IllegalStateException("off")))
        s.start()
        assertEquals("unavailable", s.screen()!!.state)
    }

    @Test
    fun anyOtherFailureToOpenSaysTheConnectionClosed() {
        val s = state(Driver(fails = RuntimeException("no network")))
        s.start()
        assertEquals(PolarisLinkStep.Failed, s.ui.value.step)
        assertEquals(PolarisLinkFailure.Closed, s.ui.value.reason)
    }
}
