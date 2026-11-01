// @pkey-feature identity.nearby
//
// The approving device's state holder (I-45.13): the three codes and Deny, the licence choice with one tap per licence, the
// outcomes by the UI matrix's step names, a second ask waiting behind the first, and every way out answering Deny.

package im.plrs.key.ui

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

class PolarisNearbyApprovalStateTest {
    private class Ask(override val device: String? = "Living-room console") : PolarisApprovalAsk {
        override val codes = listOf("111 111", "482 913", "222 222")
        val picked = CopyOnWriteArrayList<String>()
        val denies = AtomicInteger()
        var next: PolarisApprovalOutcome = PolarisApprovalOutcome.Done("approved")
        var denyNext: PolarisApprovalOutcome = PolarisApprovalOutcome.Done("denied")

        override suspend fun pick(code: String): PolarisApprovalOutcome {
            picked += code
            return next
        }

        override suspend fun deny(): PolarisApprovalOutcome {
            denies.incrementAndGet()
            return denyNext
        }
    }

    private class Handle : PolarisApprovalHandle {
        val stops = AtomicInteger()

        override suspend fun stop() {
            stops.incrementAndGet()
        }
    }

    private class Actions(var available: Boolean = true, var fails: Boolean = false) : PolarisApprovalActions {
        val handle = Handle()
        val listens = AtomicInteger()
        var onAsk: ((PolarisApprovalAsk) -> Unit)? = null

        override suspend fun available(): Boolean = available

        override suspend fun listen(onAsk: (PolarisApprovalAsk) -> Unit): PolarisApprovalHandle {
            listens.incrementAndGet()
            if (fails) error("no network")
            this.onAsk = onAsk
            return handle
        }
    }

    private val scopes = ArrayList<CoroutineScope>()
    private val closed = AtomicInteger()

    private fun state(a: Actions): PolarisNearbyApprovalState {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also { scopes += it }
        return PolarisNearbyApprovalState(a, scope, onClose = { closed.incrementAndGet() }, cleanup = scope)
    }

    private fun PolarisNearbyApprovalState.until(timeoutMillis: Long = 8000, cond: (PolarisApprovalUi) -> Boolean) {
        val end = System.nanoTime() + timeoutMillis * 1_000_000
        while (!cond(ui.value)) {
            if (System.nanoTime() > end) throw AssertionError("timed out in ${ui.value}")
            Thread.sleep(5)
        }
    }

    private fun until(timeoutMillis: Long = 8000, cond: () -> Boolean) {
        val end = System.nanoTime() + timeoutMillis * 1_000_000
        while (!cond()) {
            if (System.nanoTime() > end) throw AssertionError("timed out")
            Thread.sleep(5)
        }
    }

    private fun opened(a: Actions): PolarisNearbyApprovalState = state(a).also {
        it.open()
        until { a.onAsk != null }
    }

    @Test
    fun aProductOrRuntimeWithoutNearbyApprovalShowsNothingAndNeverAdvertises() {
        val a = Actions(available = false)
        val s = state(a)
        s.open()
        s.until { it == PolarisApprovalUi.Unavailable }
        assertEquals(0, a.listens.get())
        s.done()
        assertEquals(PolarisApprovalUi.Closed, s.ui.value)
        assertEquals(1, closed.get())
    }

    @Test
    fun anAdvertThatCannotStartIsUnavailableNotACrash() {
        val a = Actions(fails = true)
        val s = state(a)
        s.open()
        s.until { it == PolarisApprovalUi.Unavailable }
    }

    @Test
    fun theAskShowsTheThreeCodesAndOnlyATapOnOneApproves() {
        val a = Actions()
        val s = opened(a)
        assertEquals(PolarisApprovalUi.Listening, s.ui.value)
        val ask = Ask()
        a.onAsk!!(ask)
        s.until { it is PolarisApprovalUi.Ask }
        assertEquals(PolarisApprovalUi.Ask("Living-room console", ask.codes), s.ui.value)
        // Nothing is sent before a tap.
        assertTrue(ask.picked.isEmpty())
        s.pick(1)
        s.until { it is PolarisApprovalUi.Result }
        assertEquals(listOf("482 913"), ask.picked.toList())
        assertEquals(PolarisApprovalUi.Result("approved", "Living-room console"), s.ui.value)
        // A tap out of range is nothing.
        s.pick(7)
        assertEquals(1, ask.picked.size)
    }

    @Test
    fun aWrongCodeIsMismatchAndDenyAtTheAskIsDenied() {
        val a = Actions()
        val s = opened(a)
        val wrong = Ask().also { it.next = PolarisApprovalOutcome.Done("mismatch") }
        a.onAsk!!(wrong)
        s.until { it is PolarisApprovalUi.Ask }
        s.pick(0)
        s.until { it is PolarisApprovalUi.Result }
        assertEquals("mismatch", (s.ui.value as PolarisApprovalUi.Result).step)
        s.done()
        assertEquals(PolarisApprovalUi.Closed, s.ui.value)

        val b = Actions()
        val t = opened(b)
        val ask = Ask()
        b.onAsk!!(ask)
        t.until { it is PolarisApprovalUi.Ask }
        t.deny()
        t.until { it is PolarisApprovalUi.Result }
        assertEquals(1, ask.denies.get())
        assertTrue(ask.picked.isEmpty())
        assertEquals("denied", (t.ui.value as PolarisApprovalUi.Result).step)
    }

    private val rows = listOf(PolarisApprovalRow("lic_a", "Home"), PolarisApprovalRow("lic_b", "Studio"))

    private class ChoiceLog {
        val chosen = CopyOnWriteArrayList<String?>()
        val cancels = AtomicInteger()
    }

    private fun choose(log: ChoiceLog, canCreate: Boolean = true) = PolarisApprovalOutcome.NeedsLicense(
        rows = listOf(PolarisApprovalRow("lic_a", "Home"), PolarisApprovalRow("lic_b", "Studio")),
        canCreate = canCreate,
        onChoose = { id ->
            log.chosen += id
            PolarisApprovalOutcome.Done("approved")
        },
        onCancel = {
            log.cancels.incrementAndGet()
            PolarisApprovalOutcome.Done("denied")
        },
    )

    @Test
    fun aLicenceIsOneTapAndCreateIsOfferedWhereTheAccountAllowsIt() {
        val log = ChoiceLog()
        val a = Actions()
        val s = opened(a)
        val ask = Ask().also { it.next = choose(log) }
        a.onAsk!!(ask)
        s.until { it is PolarisApprovalUi.Ask }
        s.pick(1)
        s.until { it is PolarisApprovalUi.Choose }
        val shown = s.ui.value as PolarisApprovalUi.Choose
        assertEquals(rows, shown.rows)
        assertTrue(shown.canCreate)
        s.choose(1)
        s.until { it is PolarisApprovalUi.Result }
        assertEquals(listOf<String?>("lic_b"), log.chosen.toList())

        val log2 = ChoiceLog()
        val b = Actions()
        val t = opened(b)
        b.onAsk!!(Ask().also { it.next = choose(log2) })
        t.until { it is PolarisApprovalUi.Ask }
        t.pick(1)
        t.until { it is PolarisApprovalUi.Choose }
        t.createLicense()
        t.until { it is PolarisApprovalUi.Result }
        assertEquals(listOf<String?>(null), log2.chosen.toList())

        // Where create is not offered the call does nothing.
        val log3 = ChoiceLog()
        val c = Actions()
        val u = opened(c)
        c.onAsk!!(Ask().also { it.next = choose(log3, canCreate = false) })
        u.until { it is PolarisApprovalUi.Ask }
        u.pick(1)
        u.until { it is PolarisApprovalUi.Choose }
        u.createLicense()
        Thread.sleep(50)
        assertTrue(u.ui.value is PolarisApprovalUi.Choose)
        assertTrue(log3.chosen.isEmpty())
    }

    @Test
    fun denyAtTheLicenceChoiceCancelsTheChoice() {
        val log = ChoiceLog()
        val a = Actions()
        val s = opened(a)
        a.onAsk!!(Ask().also { it.next = choose(log) })
        s.until { it is PolarisApprovalUi.Ask }
        s.pick(1)
        s.until { it is PolarisApprovalUi.Choose }
        s.deny()
        s.until { it is PolarisApprovalUi.Result }
        assertEquals(1, log.cancels.get())
        assertEquals("denied", (s.ui.value as PolarisApprovalUi.Result).step)
    }

    @Test
    fun leavingTheAskByAnyRouteAnswersDenyAndStopsTheAdvert() {
        val a = Actions()
        val s = opened(a)
        val ask = Ask()
        a.onAsk!!(ask)
        s.until { it is PolarisApprovalUi.Ask }
        s.close()
        until { a.handle.stops.get() == 1 && ask.denies.get() == 1 }
        assertEquals(PolarisApprovalUi.Closed, s.ui.value)
        assertTrue(ask.picked.isEmpty())
        assertEquals(1, closed.get())
        // Idempotent: the window closing after the screen did does nothing more.
        s.close()
        Thread.sleep(50)
        assertEquals(1, a.handle.stops.get())
        assertEquals(1, ask.denies.get())
    }

    @Test
    fun leavingTheLicenceChoiceAnswersDeny() {
        val log = ChoiceLog()
        val a = Actions()
        val s = opened(a)
        a.onAsk!!(Ask().also { it.next = choose(log) })
        s.until { it is PolarisApprovalUi.Ask }
        s.pick(1)
        s.until { it is PolarisApprovalUi.Choose }
        s.close()
        until { log.cancels.get() == 1 && a.handle.stops.get() == 1 }
        assertTrue(log.chosen.isEmpty())
    }

    @Test
    fun aSecondAskWaitsBehindTheFirstAndIsShownWhenTheFirstIsDone() {
        val a = Actions()
        val s = opened(a)
        val first = Ask("First")
        val second = Ask("Second")
        a.onAsk!!(first)
        a.onAsk!!(second)
        s.until { it is PolarisApprovalUi.Ask }
        assertEquals("First", (s.ui.value as PolarisApprovalUi.Ask).device)
        s.pick(1)
        s.until { it is PolarisApprovalUi.Result }
        s.done()
        s.until { it is PolarisApprovalUi.Ask }
        assertEquals("Second", (s.ui.value as PolarisApprovalUi.Ask).device)
        assertEquals(0, second.denies.get())
        // Closing with one still waiting closes it too, and sends no pick.
        val third = Ask("Third")
        a.onAsk!!(third)
        s.close()
        until { third.denies.get() == 1 && second.denies.get() == 1 }
        assertTrue(second.picked.isEmpty() && third.picked.isEmpty())
    }

    @Test
    fun aFailedTapIsExpiredNotSignedIn() {
        val a = Actions()
        val s = opened(a)
        val ask = object : PolarisApprovalAsk {
            override val device: String? = null
            override val codes = listOf("1", "2", "3")

            override suspend fun pick(code: String): PolarisApprovalOutcome = error("boom")

            override suspend fun deny(): PolarisApprovalOutcome = PolarisApprovalOutcome.Done("denied")
        }
        a.onAsk!!(ask)
        s.until { it is PolarisApprovalUi.Ask }
        s.pick(0)
        s.until { it is PolarisApprovalUi.Result }
        assertEquals(PolarisApprovalUi.Result("expired", null), s.ui.value)
    }

    @Test
    fun theKitInputsAreTheMatrixStepsAndNameTheDeviceAsItReportedItself() {
        assertNull(PolarisNearbyApprovalState.inputsFor(PolarisApprovalUi.Listening))
        val ask = PolarisNearbyApprovalState.inputsFor(PolarisApprovalUi.Ask("Kitchen iPad", listOf("1", "2", "3")))
        assertNotNull(ask)
        assertEquals("ask", ask!!.obj("nearbyApproval").string("step"))
        assertEquals("Kitchen iPad", ask.obj("nearbyApproval").string("device"))
        val none = PolarisNearbyApprovalState.inputsFor(PolarisApprovalUi.Result("approved", null))
        assertNull(none!!.obj("nearbyApproval").string("device"))
    }
}
