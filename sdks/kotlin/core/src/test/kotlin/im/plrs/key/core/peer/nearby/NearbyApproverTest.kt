// @pkey-feature identity.nearby
//
// The approver half of nearby approval (CC-15.K2; WIRE-CONTRACT-V5 section 15.6.1): the advert and its
// renewal, the sessions that hold at HELLO, three codes and one prompt at a time, the right pick delivering a
// verified `VOUCH_REQ`, the wrong pick, the failure budget, `finish` and its guard, the accept limits and the
// red-team round's rules (a stopped advert stays stopped, stop and sign-out do not wait, a failed renewal
// halts, one prompt held until the picked session finishes). D is a bare mode-v engine over a real loopback
// socket. Mirrors packages/sdk-node/test/connect/nearbyApprover.test.ts.

package im.plrs.key.core.peer.nearby

import im.plrs.key.core.peer.advertEpoch
import im.plrs.key.core.peer.lan.MdnsAdapter
import im.plrs.key.core.peer.lan.MdnsAdvert
import im.plrs.key.core.peer.lan.MdnsHandle
import im.plrs.key.core.peer.productTag
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

class NearbyApproverTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val net = MemNetwork()
    private val timers = FakeTimers()
    private val handles = ArrayList<NearbyApproverHandle>()
    private val ds = ArrayList<RawD>()
    private val approvals = CopyOnWriteArrayList<NearbyApproval>()
    private val notices = CopyOnWriteArrayList<ApprovalNotice>()
    private val stops = CopyOnWriteArrayList<NearbyStopReason>()

    @Volatile private var signedIn = true

    @Volatile private var served = true
    private val src = object : ApproverSource {
        override val slug = SLUG

        override fun now() = T0

        override suspend fun signedIn() = this@NearbyApproverTest.signedIn

        override suspend fun nearbyServed() = served
    }

    @After
    fun tearDown() {
        runBlocking { for (d in ds) d.close() }
        for (h in handles) h.destroy()
        scope.cancel()
    }

    private fun options(
        prompt: Boolean = true,
        background: Boolean = false,
        clock: FakeClock? = null,
        maxPendingPerAddress: Int = 1,
        allowLoopback: Boolean = true,
        mdns: MdnsAdapter = net,
        onStopped: ((NearbyStopReason) -> Unit)? = { stops += it },
        onNotice: ((ApprovalNotice) -> Unit)? = { notices += it },
    ) = NearbyApproverOptions(
        prompt = prompt,
        background = background,
        label = "Ana's laptop",
        onNotice = onNotice,
        onStopped = onStopped,
        mdns = mdns,
        host = "127.0.0.1",
        allowLoopback = allowLoopback,
        maxPendingPerAddress = maxPendingPerAddress,
        timer = timers.timer,
        mono = clock?.mono ?: { System.nanoTime() / 1e9 },
    )

    private fun start(
        o: NearbyApproverOptions = options(),
        source: ApproverSource = src,
        handler: (NearbyApproval) -> Unit = { approvals += it },
    ): NearbyApproverHandle = runBlocking { NearbyApprover.start(source, handler, o) }.also { handles += it }

    /** A D that dialled and said HELLO; the person has not chosen. */
    private fun held(auto: Boolean = false): RawD = runBlocking {
        val d = RawD.dial(net, scope, RawDOptions(auto = auto))
        ds += d
        d.waitFor("HELLO") { d.hello != null }
        d
    }

    /** A D that dialled and chose this approver; returns once the codes are on M's screen. */
    private fun chosen(wait: Boolean = true): RawD = runBlocking {
        val d = held()
        d.startSas()
        if (wait) d.waitFor("the code") { d.code != null }
        d
    }

    private fun shownOf(a: NearbyApproval, d: RawD): String = a.codes.first { it.replace(" ", "") == d.code.toString().padStart(6, '0') }

    private fun decoyOf(a: NearbyApproval, d: RawD): String = a.codes.first { it.replace(" ", "") != d.code.toString().padStart(6, '0') }

    private fun adverts() = net.approverAdverts()

    private fun waitApprovals(n: Int) = until(5000, "approval $n") { approvals.size >= n }

    private val approved = ApproveAnswerInput(200, "{\"status\":\"approved\"}", true)

    // -- the advert -------------------------------------------------------------------------------

    @Test
    fun advertisesARandomP1InstanceWithVersionModeAndTheProductTag() {
        start()
        val a = adverts().single()
        assertTrue(Regex("p1-[a-z2-7]{16}").matches(a.instance))
        assertEquals(listOf("v=1", "m=v", "h=${productTag(SLUG, advertEpoch(T0))}"), a.txt)
    }

    @Test
    fun renewsWithANewInstanceAndPortAndTheOldListenerAcceptsNothingMore() {
        start()
        val first = adverts().single()
        timers.fire(300.0)
        until(what = "a new instance") { adverts().singleOrNull()?.instance.let { it != null && it != first.instance } }
        val second = adverts().single()
        assertNotEquals(first.port, second.port)
        assertThrows(java.io.IOException::class.java) { runBlocking { RawD.dial(net, scope, RawDOptions(port = first.port)) } }
    }

    @Test
    fun keepsASessionThatIsPastTheTransportAcrossARenewal() {
        start()
        val d = chosen()
        timers.fire(300.0)
        until { adverts().size == 1 && adverts()[0].port != 0 }
        settle(150)
        assertNull(d.closed)
        assertEquals(1, approvals.size)
    }

    @Test
    fun stopsAtARenewalWhenTheDeviceSignedOutOrDiscoveryLostNearby() {
        start()
        signedIn = false
        timers.fire(300.0)
        until { stops.size == 1 }
        assertEquals(listOf(NearbyStopReason.signed_out), stops.toList())
        assertEquals(0, adverts().size)
        signedIn = true
        val h2 = start()
        served = false
        timers.fire(300.0)
        until { stops.size == 2 }
        assertEquals(NearbyStopReason.discovery, stops[1])
        assertEquals(NearbyState.stopped, h2.status().state)
    }

    @Test
    fun pauseTakesTheAdvertDownAndClosesLiveSessionsResumeStartsANewOne() = runBlocking<Unit> {
        val h = start()
        val before = adverts().single()
        val d = chosen()
        h.pause()
        assertEquals(0, adverts().size)
        d.waitFor { d.closed != null }
        assertEquals("peer_bye", d.closed!!.code)
        h.resume()
        assertNotEquals(before.instance, adverts().single().instance)
    }

    // -- holding and the prompt -------------------------------------------------------------------

    @Test
    fun showsNothingUntilDsPersonChoseASessionHeldAtHelloRaisesNoPrompt() {
        start()
        held()
        settle()
        assertEquals(0, approvals.size)
        assertEquals(0, notices.size)
    }

    @Test
    fun showsThreeDistinctCodesDsAmongThemWithTheHelloLabelAndPlatform() {
        start()
        val d = chosen()
        waitApprovals(1)
        val a = approvals[0]
        assertNull(a.label)
        assertEquals(im.plrs.key.core.peer.peerHostPlatform(), a.platform)
        assertEquals(3, a.codes.toSet().size)
        assertTrue(a.codes.map { it.replace(" ", "") }.contains(d.code.toString().padStart(6, '0')))
        for (c in a.codes) assertTrue(c, Regex("\\d{3} \\d{3}").matches(c))
    }

    @Test
    fun withThePromptClosedASessionRaisesANoticeAndTakesNoPick() = runBlocking<Unit> {
        val h = start(options(prompt = false, background = true))
        val d = chosen()
        until { notices.size == 1 }
        assertEquals(0, approvals.size)
        // Opening the screen shows the waiting session.
        h.setPrompt(true)
        waitApprovals(1)
        assertNull(d.closed)
    }

    @Test
    fun showsOnePromptAtATimeTheNextShowsWhenTheFirstEnds() = runBlocking<Unit> {
        start(options(maxPendingPerAddress = 4))
        val d1 = chosen()
        waitApprovals(1)
        val d2 = chosen()
        // The second is at the code stage too, but waits with no code shown.
        settle()
        assertEquals(1, approvals.size)
        assertNull(d2.closed)
        approvals[0].decline()
        d1.waitFor { d1.closed != null }
        waitApprovals(2)
        assertNull(d2.closed)
    }

    // -- the pick ---------------------------------------------------------------------------------

    @Test
    fun theRightCodeDeliversAVerifiedRequestWithExactlyDsKeys() = runBlocking<Unit> {
        start()
        val d = chosen()
        waitApprovals(1)
        val a = approvals[0]
        d.showAndRequest()
        val r = (a.pick(shownOf(a, d)) as PickOutcome.Verified).request
        val k = d.keys.ensure()
        assertEquals(REQUEST, r.request)
        assertEquals(D_ID, r.deviceId)
        assertEquals(k.signKey, r.signKey)
        assertEquals(k.agreeKey, r.agreeKey)
        assertNull(r.label)
    }

    @Test
    fun aWrongPickClosesPeerByeDeliversNoRequestAndRefusesFinish() = runBlocking<Unit> {
        start()
        val d = chosen()
        waitApprovals(1)
        d.showAndRequest()
        val a = approvals[0]
        assertEquals(PickOutcome.Mismatch, a.pick(decoyOf(a, d)))
        d.waitFor { d.closed != null }
        assertEquals("peer_bye", d.closed!!.code)
        assertEquals(NearbyErrorReason.closed, assertThrows(NearbyException::class.java) { runBlocking { a.finish(approved) } }.reason)
        assertNull(d.result())
    }

    @Test
    fun finishBeforeAPickIsRefused() {
        start()
        chosen()
        waitApprovals(1)
        val e = assertThrows(NearbyException::class.java) { runBlocking { approvals[0].finish(approved) } }
        assertEquals(NearbyErrorReason.not_picked, e.reason)
    }

    @Test
    fun aRequestThatDoesNotVerifyClosesPeerBadFrameAndAnswersInvalid() = runBlocking<Unit> {
        start()
        val d = chosen()
        waitApprovals(1)
        d.showAndRequest { b ->
            val o = Json.parseToJsonElement(String(b)).jsonObject.toMutableMap()
            o["request"] = JsonPrimitive("nr_AAAAAAAAAAAAAAAAAAAAAA")
            JsonObject(o).toString().toByteArray()
        }
        val a = approvals[0]
        assertEquals(PickOutcome.Invalid, a.pick(shownOf(a, d)))
        d.waitFor { d.closed != null }
        assertEquals("peer_bad_frame", d.closed!!.code)
    }

    @Test
    fun declineClosesPeerByeWithNoRequestDelivered() = runBlocking<Unit> {
        start()
        val d = chosen()
        waitApprovals(1)
        d.showAndRequest()
        approvals[0].decline()
        d.waitFor { d.closed != null }
        assertEquals("peer_bye", d.closed!!.code)
    }

    @Test
    fun aHandleThatDoesNotShowItsRequestInAnyRepresentation() = runBlocking<Unit> {
        start()
        val d = chosen()
        waitApprovals(1)
        d.showAndRequest()
        val a = approvals[0]
        val r = a.pick(shownOf(a, d))
        assertFalse(r.toString().contains(REQUEST))
        assertFalse((r as PickOutcome.Verified).request.toString().contains(REQUEST))
        assertFalse(a.toString().contains(REQUEST))
    }

    // -- the failure budget -----------------------------------------------------------------------

    @Test
    fun stopsTheAdvertAtTheSecondPromptedFailureAndStartsAgainOnReopen() = runBlocking<Unit> {
        val h = start(options(clock = FakeClock()))
        spendBudget()
        assertEquals(listOf(NearbyStopReason.budget), stops.toList())
        assertEquals(0, adverts().size)
        h.reopen()
        assertEquals(1, adverts().size)
        assertEquals(NearbyState.advertising, h.status().state)
    }

    @Test
    fun countsA120SecondTimeoutOfAShownPromptNotTheHostsClose() = runBlocking<Unit> {
        val clock = FakeClock()
        start(options(clock = clock))
        val d1 = chosen()
        waitApprovals(1)
        approvals[0].close()
        d1.waitFor { d1.closed != null }
        val d2 = chosen()
        waitApprovals(2)
        // The engine's deadline (120 s) runs out on a shown prompt: the first counted failure.
        clock.now += 121
        d2.showAndRequest()
        d2.waitFor { d2.closed != null }
        assertEquals("peer_timeout", d2.closed!!.code)
        settle()
        assertEquals(emptyList<NearbyStopReason>(), stops.toList())
    }

    /** Two declined prompts spend the failure budget (two in 10 minutes) and stop the advert. */
    private suspend fun spendBudget() {
        repeat(2) {
            val n = approvals.size
            val d = chosen()
            waitApprovals(n + 1)
            approvals[n].decline()
            d.waitFor { d.closed != null }
        }
        until { stops.isNotEmpty() }
    }

    // -- finish -----------------------------------------------------------------------------------

    private suspend fun picked(): Pair<RawD, NearbyApproval> {
        val n = approvals.size
        val d = chosen()
        waitApprovals(n + 1)
        d.showAndRequest()
        val a = approvals.last()
        assertTrue(a.pick(shownOf(a, d)) is PickOutcome.Verified)
        return d to a
    }

    @Test
    fun approvedReachesDThenASyncRecordIsCarried() = runBlocking<Unit> {
        start()
        val (d, a) = picked()
        assertEquals("approved", (a.finish(approved) as FinishOutcome.Sent).status.name)
        d.waitFor { d.result() != null }
        assertEquals("approved", d.result())
        a.sendRecord(0x0030, byteArrayOf(1, 2, 3))
        d.waitFor { d.records.any { it.first == 0x0030 } }
        assertEquals(
            NearbyErrorReason.bad_type,
            assertThrows(NearbyException::class.java) {
                runBlocking { a.sendRecord(0x0100, ByteArray(1)) }
            }.reason,
        )
        // The result is sent once.
        assertThrows(NearbyException::class.java) { runBlocking { a.finish(ApproveAnswerInput(204, null, true)) } }
    }

    /** The answer [http] and [body] of `approve` sends [status] to D and closes `peer_bye`. */
    private fun answerSends(http: Int, body: String?, status: String) = runBlocking<Unit> {
        start()
        val (d, a) = picked()
        assertEquals(status, (a.finish(ApproveAnswerInput(http, body, true)) as FinishOutcome.Sent).status.name)
        d.waitFor { d.closed != null }
        assertEquals(status, d.result())
        assertEquals("peer_bye", d.closed!!.code)
    }

    @Test
    fun answer204SendsDeniedAndClosesPeerBye() = answerSends(204, null, "denied")

    @Test
    fun answer403NotNearbySendsDeniedAndClosesPeerBye() = answerSends(403, "{\"code\":\"not_nearby\"}", "denied")

    @Test
    fun answer403DeviceLimitSendsDeniedAndClosesPeerBye() = answerSends(403, "{\"code\":\"device_limit\"}", "denied")

    @Test
    fun answer404SendsExpiredAndClosesPeerBye() = answerSends(404, null, "expired")

    @Test
    fun a404AfterDiscoveryLostNearbySendsNothingClosesAndStopsTheAdvert() = runBlocking<Unit> {
        start()
        val (d, a) = picked()
        assertEquals(FinishOutcome.Closed, a.finish(ApproveAnswerInput(404, null, false)))
        d.waitFor { d.closed != null }
        assertNull(d.result())
        until { NearbyStopReason.discovery in stops }
    }

    @Test
    fun deviceKeysRequiredWaitsOnceForTheKeysASecondOneCloses() = runBlocking<Unit> {
        start()
        val (d, a) = picked()
        val need = ApproveAnswerInput(409, "{\"code\":\"device_keys_required\"}", true)
        assertEquals("keys", (a.finish(need) as FinishOutcome.Wait).what)
        assertEquals(FinishOutcome.Closed, a.finish(need))
        d.waitFor { d.closed != null }
        assertNull(d.result())
    }

    @Test
    fun chooseWaitsForTheLicenceChoiceAsManyTimesAsItIsAsked() = runBlocking<Unit> {
        start()
        val (_, a) = picked()
        val choose = ApproveAnswerInput(200, "{\"status\":\"choose\"}", true)
        assertEquals("choice", (a.finish(choose) as FinishOutcome.Wait).what)
        assertEquals("choice", (a.finish(choose) as FinishOutcome.Wait).what)
    }

    @Test
    fun closesTheSession300SecondsAfterThePick() = runBlocking<Unit> {
        start()
        val (d, _) = picked()
        timers.fire(300.0)
        d.waitFor { d.closed != null }
        assertEquals("peer_bye", d.closed!!.code)
    }

    @Test
    fun aWorkerThatDoesNotKnowTheKeysTheRequestCarriesAnswersNotFoundNeverApproved() = runBlocking<Unit> {
        // The key binding: what pick() returned is exactly what approve is given.
        start()
        val worker = FakeNearbyWorker()
        worker.mHasKeys = true
        val d = chosen()
        waitApprovals(1)
        worker.register(REQUEST, d.keys, D_ID)
        d.showAndRequest()
        val a = approvals[0]
        val r = (a.pick(shownOf(a, d)) as PickOutcome.Verified).request
        val (http, body) = worker.approve(r)
        assertEquals(200, http)
        assertEquals("approved", (a.finish(ApproveAnswerInput(http, body, true)) as FinishOutcome.Sent).status.name)
        assertEquals(listOf(D_ID), worker.approved)
    }

    // -- the accept limits ------------------------------------------------------------------------

    @Test
    fun refusesASecondWaitingConnectionFromOneSourceAddress() = runBlocking<Unit> {
        start()
        val d1 = held()
        val d2 = RawD.dial(net, scope)
        ds += d2
        d2.waitFor { d2.closed != null }
        assertNull(d2.hello)
        assertNull(d1.closed)
    }

    @Test
    fun acceptsOnTheModeARuleASourceOffTheLanIsClosedAtOnceAndCostsNoSlot() = runBlocking<Unit> {
        // Loopback is not a LAN address unless the host opts in (tests only): the socket is judged on its own
        // addresses before a byte is read, and closed.
        start(options(allowLoopback = false))
        repeat(3) {
            val d = RawD.dial(net, scope)
            ds += d
            d.waitFor { d.closed != null }
            assertNull(d.hello)
        }
    }

    @Test
    fun allowsTwoWaitingConnectionsFromOneSlash24NotThree() = runBlocking<Unit> {
        start(options(maxPendingPerAddress = 4))
        val d1 = held()
        val d2 = held()
        val d3 = RawD.dial(net, scope)
        ds += d3
        d3.waitFor { d3.closed != null }
        assertNull(d3.hello)
        assertNull(d1.closed)
        assertNull(d2.closed)
    }

    // -- a stopped advert stays stopped (B1) --------------------------------------------------------

    /** Every call that could bring an advert back. */
    private suspend fun reviveAll(h: NearbyApproverHandle) {
        h.pause()
        h.resume()
        h.reopen()
        h.setPrompt(false)
        h.setPrompt(true)
    }

    @Test
    fun pauseAndResumeDoNotReviveABudgetStopOrOverwriteItsReason() = runBlocking<Unit> {
        val h = start(options(clock = FakeClock()))
        spendBudget()
        assertEquals(NearbyStopReason.budget, h.status().reason)
        h.pause()
        assertEquals(NearbyState.stopped to NearbyStopReason.budget, h.status().let { it.state to it.reason })
        h.resume()
        assertEquals(NearbyState.stopped to NearbyStopReason.budget, h.status().let { it.state to it.reason })
        assertEquals(0, adverts().size)
    }

    @Test
    fun reopenAndTheScreenOpeningAgainStillClearABudgetStop() = runBlocking<Unit> {
        val h = start(options(clock = FakeClock()))
        spendBudget()
        h.reopen()
        assertEquals(NearbyState.advertising, h.status().state)
        stops.clear()
        spendBudget()
        assertEquals(NearbyState.stopped, h.status().state)
        h.setPrompt(false)
        h.setPrompt(true)
        assertEquals(NearbyState.advertising to null, h.status().let { it.state to it.reason })
        assertEquals(1, adverts().size)
    }

    @Test
    fun aSignOutStopIsFinalPauseResumeReopenAndSetPromptReviveNothing() = runBlocking<Unit> {
        val h = start()
        signedIn = false
        timers.fire(300.0)
        until { stops.size == 1 }
        signedIn = true
        reviveAll(h)
        assertEquals(NearbyState.stopped to NearbyStopReason.signed_out, h.status().let { it.state to it.reason })
        assertEquals(0, adverts().size)
    }

    @Test
    fun stopIsFinal() = runBlocking<Unit> {
        val h = start()
        h.stop()
        reviveAll(h)
        assertEquals(NearbyState.stopped to NearbyStopReason.host, h.status().let { it.state to it.reason })
        assertEquals(0, adverts().size)
    }

    @Test
    fun pauseWorksOnlyFromAdvertisingResumeOnlyFromTheHostsOwnPause() = runBlocking<Unit> {
        val h = start()
        h.resume()
        assertEquals(NearbyState.advertising, h.status().state)
        assertEquals(1, adverts().size)
        h.pause()
        h.pause()
        assertEquals(NearbyState.paused to NearbyStopReason.host, h.status().let { it.state to it.reason })
        h.resume()
        assertEquals(NearbyState.advertising, h.status().state)
        assertEquals(1, adverts().size)
    }

    @Test
    fun resumeReadsSignedInAndDiscoveryAgain() = runBlocking<Unit> {
        val h = start()
        h.pause()
        signedIn = false
        h.resume()
        assertEquals(NearbyState.stopped to NearbyStopReason.signed_out, h.status().let { it.state to it.reason })
        assertEquals(listOf(NearbyStopReason.signed_out), stops.toList())
        assertEquals(0, adverts().size)
        signedIn = true
        val h2 = start()
        h2.pause()
        served = false
        h2.resume()
        assertEquals(NearbyState.stopped to NearbyStopReason.discovery, h2.status().let { it.state to it.reason })
        assertEquals(0, adverts().size)
    }

    // -- stopping and renewing (B2, B3) ---------------------------------------------------------------

    @Test
    fun stopDoesNotWaitBehindARenewalWhoseSignInCheckHangs() = runBlocking<Unit> {
        val gate = CompletableDeferred<Boolean>()
        var hang = false
        val source = object : ApproverSource by src {
            override suspend fun signedIn(): Boolean = if (hang) gate.await() else true
        }
        val h = start(options(onStopped = null), source)
        val d = chosen()
        hang = true
        timers.fire(300.0)
        settle()
        val stopped = scope.async { h.stop() }
        until(1000, "stop") { stopped.isCompleted }
        assertEquals(0, adverts().size)
        d.waitFor { d.closed != null }
        assertEquals(NearbyState.stopped to NearbyStopReason.host, h.status().let { it.state to it.reason })
        // The renewal answers late: it brings nothing back.
        gate.complete(true)
        settle(150)
        assertEquals(0, adverts().size)
        assertEquals(NearbyState.stopped, h.status().state)
    }

    @Test
    fun aRenewalThatFailsStopsTheAdvertWithOnStoppedAndReArmsNothingStale() {
        var n = 0
        val flaky = object : MdnsAdapter by net {
            override suspend fun advertise(advert: MdnsAdvert): MdnsHandle {
                if (++n >= 2) throw java.io.IOException("interface down")
                return net.advertise(advert)
            }
        }
        val h = start(options(mdns = flaky))
        timers.fire(300.0)
        until { stops.size == 1 }
        assertEquals(listOf(NearbyStopReason.discovery), stops.toList())
        assertEquals(NearbyState.stopped to NearbyStopReason.discovery, h.status().let { it.state to it.reason })
        assertEquals(0, adverts().size)
        assertEquals(0, timers.live(300.0).size)
    }

    @Test
    fun aRenewalWhoseSignInCheckHangsIsBoundedAndCountsAsSignedOut() {
        val source = object : ApproverSource by src {
            override suspend fun signedIn(): Boolean = CompletableDeferred<Boolean>().await()
        }
        start(options(), source)
        timers.fire(300.0)
        until { timers.live(15.0).isNotEmpty() }
        timers.fire(15.0)
        until { stops.size == 1 }
        assertEquals(listOf(NearbyStopReason.signed_out), stops.toList())
    }

    @Test
    fun destroyDropsTheListenerTheAdvertIsLeftToTheOwnerAndWaitsForNothing() {
        val h = start()
        val d = chosen()
        h.destroy()
        d.waitFor { d.closed != null }
        assertEquals(NearbyState.stopped, h.status().state)
    }

    // -- the prompt and the budget (N4, N5, N6) -----------------------------------------------------

    @Test
    fun countsAPeerThatClosesAfterThePromptShowedBeforeTheAnswer() = runBlocking<Unit> {
        start(options(clock = FakeClock()))
        val d1 = chosen()
        waitApprovals(1)
        d1.close()
        d1.waitFor { d1.closed != null }
        assertEquals(emptyList<NearbyStopReason>(), stops.toList())
        val d2 = chosen()
        waitApprovals(2)
        d2.close()
        until { stops.size == 1 }
        assertEquals(listOf(NearbyStopReason.budget), stops.toList())
    }

    @Test
    fun doesNotCountAPeerThatClosesBeforeAnyPromptShowed() = runBlocking<Unit> {
        start(options(clock = FakeClock()))
        repeat(3) {
            val d = held()
            d.close()
            d.waitFor { d.closed != null }
            settle(40)
        }
        assertEquals(emptyList<NearbyStopReason>(), stops.toList())
    }

    @Test
    fun holdsTheNextPromptUntilThePickedSessionFinishes() = runBlocking<Unit> {
        start(options(maxPendingPerAddress = 4))
        val d1 = chosen()
        waitApprovals(1)
        val d2 = chosen()
        d1.showAndRequest()
        val a = approvals[0]
        assertTrue(a.pick(shownOf(a, d1)) is PickOutcome.Verified)
        // The first is picked and not finished: the second waits with no code on the screen.
        settle()
        assertEquals(1, approvals.size)
        assertNull(d2.closed)
        a.finish(ApproveAnswerInput(204, null, true))
        waitApprovals(2)
    }

    @Test
    fun holdsTheNextPromptWhileThePickedSessionIsOpenAndShowsItWhenItCloses() = runBlocking<Unit> {
        start(options(maxPendingPerAddress = 4))
        val d1 = chosen()
        waitApprovals(1)
        chosen()
        d1.showAndRequest()
        val a = approvals[0]
        a.pick(shownOf(a, d1))
        settle()
        assertEquals(1, approvals.size)
        a.close()
        waitApprovals(2)
    }

    // -- background approval and host callbacks (N10) --------------------------------------------------

    @Test
    fun promptOffNeedsAnExplicitBackground() {
        val e = assertThrows(NearbyException::class.java) { runBlocking { NearbyApprover.start(src, { }, options(prompt = false)) } }
        assertEquals(NearbyErrorReason.bad_input, e.reason)
        assertEquals("invalid-argument", e.code)
        assertEquals(0, adverts().size)
    }

    @Test
    fun closingTheScreenOfAForegroundApproverStopsTheAdvertUntilItOpensAgain() = runBlocking<Unit> {
        val h = start()
        val d = chosen()
        waitApprovals(1)
        h.setPrompt(false)
        assertEquals(NearbyState.paused, h.status().state)
        assertFalse(h.status().prompt)
        assertEquals(0, adverts().size)
        d.waitFor { d.closed != null }
        h.setPrompt(true)
        assertEquals(NearbyState.advertising, h.status().state)
        assertEquals(1, adverts().size)
    }

    @Test
    fun aBackgroundApproverKeepsAdvertisingWhenTheScreenCloses() = runBlocking<Unit> {
        val h = start(options(background = true))
        h.setPrompt(false)
        assertEquals(NearbyState.advertising, h.status().state)
    }

    @Test
    fun aThrowingOnCloseCannotKeepTheNextPromptFromShowing() = runBlocking<Unit> {
        start(options(maxPendingPerAddress = 4))
        val d1 = chosen()
        waitApprovals(1)
        approvals[0].onClose { throw IllegalStateException("host bug") }
        chosen()
        d1.close()
        waitApprovals(2)
    }

    @Test
    fun aThrowingHandlerEndsItsSessionAndTheNextOneStillShows() = runBlocking<Unit> {
        var n = 0
        start(options(maxPendingPerAddress = 4), handler = {
            approvals += it
            if (++n == 1) throw IllegalStateException("host bug")
        })
        val d1 = chosen()
        d1.waitFor { d1.closed != null }
        chosen()
        waitApprovals(2)
    }

    @Test
    fun aThrowingOnStoppedOrOnNoticeCannotKeepTheAdvertUp() {
        val h = start(options(onStopped = { throw IllegalStateException("host bug") }))
        signedIn = false
        timers.fire(300.0)
        until { h.status().state == NearbyState.stopped }
        assertEquals(0, adverts().size)
        signedIn = true
        start(options(prompt = false, background = true, onNotice = { throw IllegalStateException("host bug") }))
        val d = chosen()
        settle()
        assertNull(d.closed)
    }

    @Test
    fun anHonestDWhoseLabelDoesNotCleanTwiceTheSameWayStillVerifies() = runBlocking<Unit> {
        start()
        // A zero-width space between a base letter and a combining acute: cleaning twice differs.
        val d = RawD.dial(net, scope, RawDOptions(label = "e\u200b\u0301x"))
        ds += d
        d.waitFor { d.hello != null }
        d.startSas()
        d.waitFor { d.code != null }
        waitApprovals(1)
        d.showAndRequest()
        val a = approvals[0]
        val r = (a.pick(shownOf(a, d)) as PickOutcome.Verified).request
        assertEquals(REQUEST, r.request)
        assertEquals("e\u0301x", r.label)
    }
}
