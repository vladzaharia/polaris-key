// @pkey-feature identity.nearby
//
// The requester half of nearby approval (CC-15.K3; WIRE-CONTRACT-V5 section 15.6.1): browse for `m=v`
// adverts of this product, dial at most four at random with the code held, list them by their `HELLO`,
// start the code on the one the person tapped and close the rest `peer_bye`, send `VOUCH_REQ` after the
// code, read `VOUCH_RESULT`, hold Sync records until the account is confirmed, and end at `expiresIn`. The
// approvers are real [NearbyApprover]s on the fake LAN. Mirrors
// packages/sdk-node/test/connect/nearbyRequester.test.ts.

package im.plrs.key.core.peer.nearby

import im.plrs.key.core.peer.VouchStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

class NearbyRequesterTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val net = MemNetwork()
    private val keys = memoryKeys()

    private class Approver(val h: NearbyApproverHandle, val approvals: CopyOnWriteArrayList<NearbyApproval>)

    private val approvers = ArrayList<Approver>()
    private val requests = ArrayList<NearbyRequest>()

    private val dSrc = object : RequesterSource {
        override val slug = SLUG

        override fun now() = T0

        override suspend fun signer() = RequesterSigner(keys, D_ID)
    }

    @After
    fun tearDown() {
        for (r in requests) r.destroy()
        for (a in approvers) a.h.destroy()
        scope.cancel()
    }

    private fun approver(label: String, slug: String = SLUG): Approver = runBlocking {
        val approvals = CopyOnWriteArrayList<NearbyApproval>()
        val src = object : ApproverSource {
            override val slug = slug

            override fun now() = T0

            override suspend fun signedIn() = true

            override suspend fun nearbyServed() = true
        }
        val h = NearbyApprover.start(
            src,
            { approvals += it },
            NearbyApproverOptions(prompt = true, label = label, mdns = net, host = "127.0.0.1", allowLoopback = true),
        )
        Approver(h, approvals).also { approvers += it }
    }

    private fun request(
        request: String = REQUEST,
        label: String? = "New phone",
        expiresIn: Double = 300.0,
        timer: ((Double, () -> Unit) -> (() -> Unit))? = null,
        signal: Job? = null,
    ): NearbyRequest = runBlocking {
        NearbyRequester.start(
            dSrc,
            NearbyRequestOptions(
                request = request,
                label = label,
                expiresIn = expiresIn,
                signal = signal,
                mdns = net,
                allowLoopback = true,
                timer = timer,
            ),
        ).also { requests += it }
    }

    private fun realCode(a: NearbyApproval, code: String): String = a.codes.first { it.replace(" ", "") == code.replace(" ", "") }

    private fun listed(r: NearbyRequest, n: Int) = until(5000, "$n approvers") { r.approvers.size == n }

    // -- browsing and the list ---------------------------------------------------------------------

    @Test
    fun listsApproversByTheirHelloAndPromptsNoneOfThem() {
        approver("Ana's laptop")
        approver("Ben's tablet")
        val r = request()
        listed(r, 2)
        assertEquals(listOf("Ana's laptop", "Ben's tablet"), r.approvers.map { it.label }.sortedBy { it })
        for (a in r.approvers) assertEquals(im.plrs.key.core.peer.peerHostPlatform(), a.platform)
        settle()
        // The person has not chosen: nobody shows a code.
        assertTrue(approvers.all { it.approvals.isEmpty() })
    }

    @Test
    fun dialsAtMostFourApproversAtOnce() {
        repeat(6) { approver("device $it") }
        val r = request()
        listed(r, 4)
        settle(200)
        assertEquals(4, r.approvers.size)
    }

    @Test
    fun ignoresAnAdvertOfAnotherProduct() {
        approver("Other app", "otherapp")
        approver("Mine")
        val r = request()
        until { r.approvers.isNotEmpty() }
        settle()
        assertEquals(listOf("Mine"), r.approvers.map { it.label })
    }

    @Test
    fun dropsAnApproverWhoseSessionEndsFromTheList() = runBlocking<Unit> {
        val a = approver("Ana's laptop")
        approver("Ben's tablet")
        val r = request()
        listed(r, 2)
        a.h.pause()
        listed(r, 1)
        assertEquals("Ben's tablet", r.approvers[0].label)
    }

    @Test
    fun anUnknownIdIsRefused() {
        approver("Ana")
        val r = request()
        listed(r, 1)
        val e = assertThrows(NearbyException::class.java) { runBlocking { r.choose("ap_ffffffffffff") } }
        assertEquals(NearbyErrorReason.unknown_peer, e.reason)
    }

    // -- the choice ----------------------------------------------------------------------------------

    @Test
    fun startsTheCodeOnTheChosenApproverOnlyTheOthersClosePeerBye() = runBlocking<Unit> {
        val ana = approver("Ana's laptop")
        val ben = approver("Ben's tablet")
        val r = request()
        listed(r, 2)
        val pick = r.approvers.first { it.label == "Ben's tablet" }
        val code = r.choose(pick.id).code
        assertTrue(Regex("\\d{3} \\d{3}").matches(code))
        until { ben.approvals.size == 1 }
        realCode(ben.approvals[0], code)
        settle()
        // Ana never prompted, and her session is gone.
        assertEquals(0, ana.approvals.size)
        assertEquals(emptyList<NearbyApproverInfo>(), r.approvers)
        assertThrows(NearbyException::class.java) { runBlocking { r.choose(pick.id) } }
    }

    /** The whole vouch up to `approved`: the person taps, the codes match, M approves. */
    private suspend fun vouched(): Triple<NearbyRequest, NearbyApproval, im.plrs.key.core.peer.VouchRequest> {
        val worker = FakeNearbyWorker()
        worker.register(REQUEST, keys, D_ID)
        worker.mHasKeys = true
        val m = approver("Ana's laptop")
        val r = request()
        listed(r, 1)
        val code = r.choose(r.approvers[0].id).code
        until { m.approvals.size == 1 }
        val a = m.approvals[0]
        val req = (a.pick(realCode(a, code)) as PickOutcome.Verified).request
        val (http, body) = worker.approve(req)
        a.finish(ApproveAnswerInput(http, body, true))
        until { r.result == VouchStatus.approved }
        return Triple(r, a, req)
    }

    @Test
    fun runsTheWholeVouchTheCodeMatchesVouchReqIsVerifiedApprovedReachesD() = runBlocking<Unit> {
        val (r, _, req) = vouched()
        assertEquals(REQUEST, req.request)
        assertEquals(D_ID, req.deviceId)
        assertEquals("New phone", req.label)
        assertEquals(VouchStatus.approved, r.result)
    }

    @Test
    fun aWrongPickEndsTheChosenSessionTheRequestGoesOnAndThePersonMayChooseAgain() = runBlocking<Unit> {
        val m = approver("Ana's laptop")
        val r = request()
        listed(r, 1)
        val closes = CopyOnWriteArrayList<String>()
        r.onClose { closes += it }
        val code = r.choose(r.approvers[0].id).code
        until { m.approvals.size == 1 }
        val decoy = m.approvals[0].codes.first { it.replace(" ", "") != code.replace(" ", "") }
        assertEquals(PickOutcome.Mismatch, m.approvals[0].pick(decoy))
        until { closes.size == 1 }
        assertEquals(listOf("peer_bye"), closes.toList())
        assertNull(r.result)
        assertFalse(r.closed)
    }

    // -- the account gate -----------------------------------------------------------------------------

    @Test
    fun holdsAWrapUntilThePersonConfirmedTheAccountThenHandsItOver() = runBlocking<Unit> {
        val (r, a, _) = vouched()
        val got = CopyOnWriteArrayList<Int>()
        r.onRecord { got += it.type }
        a.sendRecord(0x0030, byteArrayOf(9))
        settle()
        assertEquals(emptyList<Int>(), got.toList())
        r.confirmAccount()
        assertEquals(listOf(0x0030), got.toList())
        a.sendRecord(0x0031, byteArrayOf(9))
        until { got.size == 2 }
    }

    @Test
    fun aDeclineDropsTheHeldRecordsAndClosesTheSession() = runBlocking<Unit> {
        val (r, a, _) = vouched()
        val got = CopyOnWriteArrayList<Int>()
        val closes = CopyOnWriteArrayList<String>()
        r.onRecord { got += it.type }
        r.onClose { closes += it }
        a.sendRecord(0x0030, byteArrayOf(9))
        r.declineAccount()
        until { closes.size == 1 }
        assertEquals(emptyList<Int>(), got.toList())
    }

    // -- the end --------------------------------------------------------------------------------------

    @Test
    fun expiresAtExpiresInTheSessionsClosePeerByeAndOnCloseSaysExpired() {
        val timers = FakeTimers()
        val m = approver("Ana's laptop")
        val r = request(timer = timers.timer)
        listed(r, 1)
        val closes = CopyOnWriteArrayList<String>()
        r.onClose { closes += it }
        timers.live(300.0).first().fn()
        until { r.closed }
        assertEquals(listOf("expired"), closes.toList())
        assertEquals(0, m.approvals.size)
    }

    @Test
    fun cancellingTheSignalClosesTheRequest() {
        approver("Ana")
        val signal = Job()
        val r = request(signal = signal)
        listed(r, 1)
        signal.cancel()
        until { r.closed }
    }

    // -- N1: one answer per request -------------------------------------------------------------------

    /** A new approver appears after the answer: it is not dialled, listed or choosable. */
    private fun expectNoMoreDials(r: NearbyRequest) {
        val mal = approver("Mal")
        settle(200)
        assertEquals(emptyList<NearbyApproverInfo>(), r.approvers)
        assertEquals(0, mal.approvals.size)
        val e = assertThrows(NearbyException::class.java) { runBlocking { r.choose("ap_ffffffffffff") } }
        assertEquals(NearbyErrorReason.closed, e.reason)
    }

    @Test
    fun afterApprovedALaterApproverIsNotDialledListedOrChoosable() = runBlocking<Unit> {
        val (r, a, _) = vouched()
        a.close()
        until { r.approvers.isEmpty() }
        expectNoMoreDials(r)
    }

    @Test
    fun afterConfirmAccountALaterApproverIsNotDialledOrChoosableEither() = runBlocking<Unit> {
        val (r, a, _) = vouched()
        r.confirmAccount()
        a.close()
        expectNoMoreDials(r)
    }

    // -- N8: an idle unchosen session is replaced after 20 s -------------------------------------------

    @Test
    fun anIdleSessionIsClosedPeerByeAndTheApproverIsDialledAgain() = runBlocking<Unit> {
        val timers = FakeTimers(only = 20.0)
        approver("Ana's laptop")
        val r = request(timer = timers.timer)
        listed(r, 1)
        val first = r.approvers[0].id
        val idle = timers.all.filter { it.live }
        assertEquals(1, idle.size)
        idle[0].fn()
        until(3000, "a new session") { r.approvers.size == 1 && r.approvers[0].id != first }
        val e = assertThrows(NearbyException::class.java) { runBlocking { r.choose(first) } }
        assertEquals(NearbyErrorReason.unknown_peer, e.reason)
    }

    @Test
    fun startsNoIdleClockOnASessionThePersonChose() = runBlocking<Unit> {
        val timers = FakeTimers(only = 20.0)
        val m = approver("Ana's laptop")
        val r = request(timer = timers.timer)
        listed(r, 1)
        r.choose(r.approvers[0].id)
        until { m.approvals.size == 1 }
        assertEquals(0, timers.all.count { it.live })
    }

    // -- N10: the request is checked when it starts ---------------------------------------------------

    private fun refuses(what: String, f: () -> Unit) {
        val e = assertThrows(what, NearbyException::class.java) { f() }
        assertEquals(what, "invalid-argument", e.code)
    }

    @Test
    fun refusesAHandleThatIsNotNrAnd22Characters() = refuses("short handle") { request(request = "nr_short") }

    @Test
    fun refusesALabelOf300Characters() = refuses("long label") { request(label = "x".repeat(300)) }

    @Test
    fun refusesAnExpiresInOf0ANegativeOneAndNaN() {
        refuses("zero") { request(expiresIn = 0.0) }
        refuses("negative") { request(expiresIn = -5.0) }
        refuses("nan") { request(expiresIn = Double.NaN) }
        refuses("infinite") { request(expiresIn = Double.POSITIVE_INFINITY) }
    }

    @Test
    fun clampsExpiresInTo300Seconds() {
        val seen = CopyOnWriteArrayList<Double>()
        request(expiresIn = 9999.0, timer = { s, fn ->
            seen += s
            val f = java.util.Timer(true)
            val cancel: () -> Unit = { f.cancel() }
            cancel
        })
        assertTrue(300.0 in seen)
        assertFalse(9999.0 in seen)
    }

    @Test
    fun aThrowingHostCallbackCannotSkipTheCleanup() = runBlocking<Unit> {
        val m = approver("Ana's laptop")
        val r = request()
        listed(r, 1)
        val lists = CopyOnWriteArrayList<Int>()
        r.onApprovers { throw IllegalStateException("host bug") }
        r.onApprovers { lists += it.size }
        r.onClose { throw IllegalStateException("host bug") }
        val closed = CopyOnWriteArrayList<String>()
        r.choose(r.approvers[0].id)
        until { m.approvals.size == 1 }
        m.approvals[0].onClose { closed += it.code }
        assertTrue(lists.isNotEmpty())
        r.close()
        until { closed.size == 1 }
        assertTrue(r.closed)
    }
}
