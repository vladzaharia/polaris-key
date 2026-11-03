// @pkey-feature connect.transfer
//
// The offer prompt's state holder (CC-19.10, D-8): consent per transfer, answered once; Accept receives and ends as done or failed;
// Cancel stops it as failed and a late result is dropped; a name the contact chose is shortened for the heading; one prompt at a time.

package im.plrs.key.ui

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

class PolarisTransferOfferStateTest {
    private class Actions : PolarisTransferOfferActions {
        val accepts = AtomicInteger()
        val declines = AtomicInteger()
        val cancels = AtomicInteger()
        val arrival = CompletableDeferred<Unit>()
        var instant = false

        override suspend fun accept() {
            accepts.incrementAndGet()
            if (!instant) arrival.await()
        }

        override suspend fun decline() {
            declines.incrementAndGet()
        }

        override suspend fun cancel() {
            cancels.incrementAndGet()
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

    private fun offer(actions: Actions, name: String = "holiday.zip", device: String? = "Maya's laptop", onClosed: () -> Unit = {}) =
        PolarisTransferOfferState(actions, name, device, size = 1_200_000, type = "application/zip", scope = scope, onClosed = onClosed)

    private fun PolarisTransferOfferState.screen() = PolarisTransferOfferState.inputsFor(ui.value)?.let { KitStates.resolve(KitComponent.transferOffer, it) }

    @Test
    fun theOfferAsksFirstAndReceivesNothing() {
        val a = Actions()
        val s = offer(a)
        assertEquals("ask", s.screen()!!.state)
        assertEquals(0, a.accepts.get())
        assertEquals(0, a.declines.get())
    }

    @Test
    fun acceptReceivesThenIsDoneAndAnotherPressDoesNothing() {
        val a = Actions()
        val s = offer(a)
        s.accept()
        s.accept()
        s.decline()
        assertEquals("receiving", s.screen()!!.state)
        assertEquals(1, a.accepts.get())
        assertEquals(0, a.declines.get())
        a.arrival.complete(Unit)
        assertEquals("done", s.screen()!!.state)
    }

    @Test
    fun aTransferThatThrowsEndsAsFailed() {
        val a = object : PolarisTransferOfferActions {
            override suspend fun accept() = error("closed")

            override suspend fun decline() {}
        }
        val s = PolarisTransferOfferState(a, "holiday.zip", scope = scope)
        s.accept()
        assertEquals("failed", s.screen()!!.state)
    }

    @Test
    fun declineAnswersOnceAndClosesThePrompt() {
        val a = Actions()
        var closed = 0
        val s = offer(a, onClosed = { closed++ })
        s.decline()
        s.decline()
        s.accept()
        assertEquals(1, a.declines.get())
        assertEquals(0, a.accepts.get())
        assertNull(s.screen())
        assertEquals(1, closed)
    }

    @Test
    fun cancelStopsItAsFailedAndALateArrivalIsDropped() {
        val a = Actions()
        val s = offer(a)
        s.accept()
        s.cancel()
        assertEquals("failed", s.screen()!!.state)
        assertEquals(1, a.cancels.get())
        a.arrival.complete(Unit)
        assertEquals("failed", s.screen()!!.state)
        // Cancel only means something while receiving.
        s.cancel()
        assertEquals(1, a.cancels.get())
    }

    @Test
    fun aLongNameIsShortenedInTheHeadingKeepingItsExtension() {
        val name = "a-very-long-holiday-photo-collection-from-the-whole-family-trip-2026.zip"
        val s = offer(Actions(), name)
        val shown = (s.screen()!!.copy.first { it.key == "transferOffer.ask" }.args["name"] as CopyArgument.Text).value
        assertEquals(KitConnect.shortName(name), shown)
        assertEquals(40, KitConnect.shortName(name).length)
        assertTrue(KitConnect.shortName(name).endsWith(".zip"))
    }

    @Test
    fun theContactGivesNoLabelAndTheScreenSaysSo() {
        val s = offer(Actions(), device = null)
        assertTrue(s.screen()!!.shows("transferOffer.askUnnamed"))
    }

    @Test
    fun offersShowOneAtATimeAndAWithdrawnWaiterIsSkipped() {
        val host = PolarisTransferOffers()
        val a = offer(Actions(), "a.zip", onClosed = host::advance)
        val b = offer(Actions(), "b.zip", onClosed = host::advance)
        val c = offer(Actions(), "c.zip", onClosed = host::advance)
        host.present(a)
        host.present(b)
        host.present(c)
        assertSame(a, host.current.value)
        b.withdrawn()
        a.decline()
        assertSame(c, host.current.value)
        c.decline()
        assertNull(host.current.value)
    }
}
