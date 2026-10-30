// @pkey-feature identity.nearby
//
// The mode-v vouch codecs (WIRE-CONTRACT-V5 section 15.6.1): VOUCH_REQ built by a real device key store and
// verified, VOUCH_RESULT, the approve-answer table, the decoys and their positions, the advert instance,
// the failure budget and the order guard. The shared vectors run in `:conformance` (peer-matrix `vouch`);
// these are the behaviours rows cannot show. Mirrors client-core's `peerVouch.test.ts`.

package im.plrs.key.core.peer

import im.plrs.key.core.DeviceKeyStore
import im.plrs.key.core.InMemoryDeviceKeyStorage
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.nio.ByteBuffer

class VouchTest {
    private val slug = "demo"
    private val device = "yLOTkYomb4xKmDRpnlnvrvB4_ktxXwrS"
    private val request = "nr_0IvbE7YHMGPBP0VAfZDQhg"
    private val h = ByteArray(32) { (it + 1).toByte() }
    private val otherH = ByteArray(32) { (200 - it).toByte() }
    private val hello = VouchHello("Ana's Switch", "linux")
    private val port = DeviceKeyStore(InMemoryDeviceKeyStorage())
    private val body: ByteArray = runBlocking { buildVouchRequest(port, slug, h, request, device, hello) }

    private fun edit(f: (MutableMap<String, kotlinx.serialization.json.JsonElement>) -> Unit): ByteArray {
        val o = Json.parseToJsonElement(String(body, Charsets.UTF_8)).jsonObject.toMutableMap()
        f(o)
        return JsonObject(o).toString().toByteArray(Charsets.UTF_8)
    }

    private fun verify(b: ByteArray, hh: ByteArray = h, he: VouchHello = hello): VouchRequest? = verifyVouchRequest(slug, hh, he, b)

    // -- VOUCH_REQ ----------------------------------------------------------------------------

    @Test
    fun aBuiltRequestVerifiesAndShowsWhatTheHelloShowed() {
        val v = verify(body)!!
        assertEquals(request, v.request)
        assertEquals(device, v.deviceId)
        assertEquals("Ana's Switch", v.label)
        assertEquals("linux", v.platform)
        val keys = runBlocking { port.publicKeys()!! }
        assertEquals(keys.signKey, v.signKey)
        assertEquals(keys.agreeKey, v.agreeKey)
    }

    @Test
    fun theBodyKeepsTheWireOrderAndFitsFourKib() {
        val text = String(body, Charsets.UTF_8)
        val order = listOf("v", "request", "deviceId", "signKey", "agreeKey", "label", "platform", "sig").map { text.indexOf("\"$it\"") }
        assertEquals(order.sorted(), order)
        assertTrue(body.size <= VOUCH_REQ_MAX)
    }

    @Test
    fun noLabelInTheHelloMeansNoLabelInTheRequest() {
        val b = runBlocking { buildVouchRequest(port, slug, h, request, device, VouchHello(null, "linux")) }
        assertFalse(String(b, Charsets.UTF_8).contains("\"label\""))
        assertNotNull(verify(b, h, VouchHello(null, "linux")))
        // A label the HELLO never showed is refused, and so is one dropped after it.
        assertNull(verify(body, h, VouchHello(null, "linux")))
        assertNull(verify(b, h, hello))
    }

    @Test
    fun comparesTheLabelToAHelloTheSessionAlreadyCleaned() {
        // A zero-width space between a base letter and a combining acute (N2). The strip comes before NFC,
        // so one cleaning composes the letter and a second one changes nothing.
        val raw = "e\u200b\u0301x"
        val once = cleanLabel(raw)!!
        assertEquals("\u00e9x", once)
        assertEquals(once, cleanLabel(once))
        val b = runBlocking { buildVouchRequest(port, slug, h, request, device, VouchHello(raw, "linux")) }
        val ok = verifyVouchRequest(slug, h, VouchHello(once, "linux"), b, helloCleaned = true)
        assertEquals(once, ok?.label)
        assertNull(verifyVouchRequest(slug, h, VouchHello("Other", "linux"), b, helloCleaned = true))
        // A raw HELLO (the corpus rows) is still cleaned once.
        assertNotNull(verifyVouchRequest(slug, h, VouchHello(raw, "linux"), b))
    }

    @Test
    fun isBoundToOneSession() {
        assertNull(verify(body, otherH))
        assertNull(verifyVouchRequest("other", h, hello, body))
    }

    @Test
    fun refusesAChangedFieldEachOfWhichTheProofOrTheChecksCover() {
        assertNull(verify(edit { it["request"] = JsonPrimitive("nr_AAAAAAAAAAAAAAAAAAAAAA") }))
        assertNull(verify(edit { it["deviceId"] = JsonPrimitive(device.replace("y", "z")) }))
        assertNull(verify(edit { it["label"] = JsonPrimitive("Someone else") }))
        assertNull(verify(edit { it["platform"] = JsonPrimitive("windows") }))
        assertNull(verify(edit { it.remove("sig") }))
        assertNull(verify(edit { it["v"] = JsonPrimitive(2) }))
        val otherKeys = runBlocking { DeviceKeyStore(InMemoryDeviceKeyStorage()).ensure() }
        assertNull(verify(edit { it["signKey"] = JsonPrimitive(otherKeys.signKey) }))
    }

    @Test
    fun ignoresUnknownMembersAndRefusesABodyOverFourKib() {
        assertNotNull(verify(edit { it["extra"] = buildJsonArray { add(1) } }))
        assertNull(verify(edit { it["extra"] = JsonPrimitive("x".repeat(VOUCH_REQ_MAX)) }))
    }

    @Test
    fun refusesABadInputWhenBuildingAndNeverNamesAValue() {
        fun build(hh: ByteArray = h, req: String = request, dev: String = device, he: VouchHello = hello) =
            runBlocking { buildVouchRequest(port, slug, hh, req, dev, he) }
        for (f in listOf<() -> ByteArray>({ build(hh = h.copyOfRange(1, 32)) }, { build(req = "nr_short") }, { build(dev = "short") })) {
            assertEquals("vouch request: bad input", assertThrows(IllegalArgumentException::class.java) { f() }.message)
        }
        val big = assertThrows(IllegalArgumentException::class.java) { build(he = VouchHello("x".repeat(5000), "p")) }
        assertEquals("vouch request: too large", big.message)
    }

    @Test
    fun theHandleIsInNoRepresentation() {
        val v = verify(body)!!
        assertFalse(v.toString().contains(request))
        assertFalse(parseVouchRequest(body)!!.toString().contains(request))
    }

    @Test
    fun theCloseCodesAreTheRegistrysPeerKind() {
        val registry = im.plrs.key.core.ERROR_CODE_KINDS.filterValues { it == "peer" }.keys
        assertEquals(registry, PeerCloseCode.values().map { it.name }.toSet())
    }

    // -- VOUCH_RESULT -------------------------------------------------------------------------

    @Test
    fun roundTripsTheThreeStatusesAndReadsAnUnknownOneAsDenied() {
        for (s in VouchStatus.values()) assertEquals(s, (parseVouchResult(buildVouchResult(s)) as VouchResultRead.Status).status)
        assertEquals(VouchStatus.denied, (parseVouchResult("{\"status\":\"not_nearby\"}".toByteArray()) as VouchResultRead.Status).status)
        assertEquals(PeerCloseCode.peer_bad_frame, (parseVouchResult("[]".toByteArray()) as VouchResultRead.Refuse).code)
    }

    // -- finishMap ----------------------------------------------------------------------------

    private fun ans(http: Int?, b: String? = null, discovery: Boolean = true, retried: Boolean = false) =
        finishMap(ApproveAnswer(http, b, discovery, retried))

    private fun FinishAction.sent(): VouchStatus? = (this as? FinishAction.Send)?.status

    @Test
    fun finishMapsTheTable() {
        assertEquals(VouchStatus.approved, ans(200, "{\"status\":\"approved\"}").sent())
        assertEquals(VouchStatus.denied, ans(204).sent())
        assertEquals(VouchStatus.denied, ans(403, "{\"code\":\"not_nearby\"}").sent())
        assertEquals(VouchStatus.denied, ans(403, "{\"code\":\"device_limit\"}").sent())
        assertEquals(VouchStatus.expired, ans(404).sent())
        assertEquals("choice", (ans(200, "{\"status\":\"choose\"}") as FinishAction.Wait).what)
        assertEquals("keys", (ans(409, "{\"code\":\"device_keys_required\"}") as FinishAction.Wait).what)
        assertEquals("choice", (ans(409, "{\"code\":\"license_choice_required\"}") as FinishAction.Wait).what)
    }

    @Test
    fun finishClosesOnEverythingElseAndTheKeysRetryHappensOnce() {
        val rows = listOf<Pair<Int?, String?>>(
            null to null,
            400 to null,
            403 to "{\"code\":\"account_required\"}",
            409 to "{\"code\":\"conflict\"}",
            429 to null,
            503 to null,
            200 to null,
            201 to "{\"status\":\"approved\"}",
        )
        for ((http, b) in rows) {
            val a = ans(http, b)
            assertTrue("$http", a is FinishAction.Close && !a.stopAdvert)
        }
        val again = ans(409, "{\"code\":\"device_keys_required\"}", retried = true)
        assertTrue(again is FinishAction.Close && !again.stopAdvert)
    }

    @Test
    fun a404AfterDiscoveryLostNearbyClosesAndStopsTheAdvert() {
        val a = ans(404, null, discovery = false)
        assertTrue(a is FinishAction.Close && a.stopAdvert)
    }

    // -- decoys, instance, budget -------------------------------------------------------------

    /** A source that hands out the given 32-bit draws, then draws near the top of the range. */
    private fun draws(vararg n: Long): (Int) -> ByteArray {
        var i = 0
        return { len ->
            assertEquals(4, len)
            val v = if (i < n.size) n[i] else 0xffff_fff0L - i
            i++
            ByteBuffer.allocate(4).putInt(v.toInt()).array()
        }
    }

    @Test
    fun decoysAreThreeDistinctCodesInRangeWithTheRealOneAtIndex() {
        val rnd = java.util.Random()
        repeat(200) {
            val real = rnd.nextInt(1_000_000)
            val d = decoyCodes(real)
            assertEquals(3, d.codes.toSet().size)
            assertTrue(d.codes.all { it in 0 until 1_000_000 })
            assertEquals(real, d.codes[d.index])
        }
    }

    @Test
    fun decoysRejectADrawInTheBiasedTailAndOneEqualToACodeAlreadyHeld() {
        // 2^32 = 4294 * 10^6 + 967296, so 4_294_000_000 and above is the biased tail.
        val src = draws(
            4_294_000_000L, // rejected: tail
            0xffff_ffffL, // rejected: tail
            7, // = real 7: rejected as a duplicate
            123_456, // decoy 1
            123_456, // duplicate of decoy 1: rejected
            999_999, // decoy 2
            0, // shuffle: position for slot 2
            0, // shuffle: position for slot 1
        )
        assertEquals(setOf(7, 123_456, 999_999), decoyCodes(7, src).codes.toSet())
    }

    @Test
    fun aSourceThatCannotProduceAValueIsGivenUpOnNotLoopedOn() {
        for (src in listOf<(Int) -> ByteArray>({ byteArrayOf(-1, -1, -1, -1) }, { ByteArray(4) })) {
            try {
                decoyCodes(5, src)
                fail("must give up")
            } catch (e: IllegalStateException) {
                assertEquals("vouch: random source", e.message)
            }
        }
    }

    @Test
    fun refusesARealCodeOutsideTheRange() {
        for (bad in listOf(-1, 1_000_000)) {
            try {
                decoyCodes(bad)
                fail("must refuse")
            } catch (e: IllegalArgumentException) {
                // expected
            }
        }
    }

    @Test
    fun putsTheRealCodeAtEachPositionAboutEquallyOften() {
        val seen = IntArray(3)
        repeat(3000) { seen[decoyCodes(42).index]++ }
        for (n in seen) assertTrue("$n", n in 801..1199)
    }

    @Test
    fun theShuffleIsAFisherYatesOverThreeSlotsEveryOrderReachable() {
        val orders = HashSet<List<Int>>()
        for (a in 0L until 3) {
            for (b in 0L until 2) {
                // real = 1; decoys 2 and 3 by draws 2 and 3, then the shuffle's two draws.
                orders += decoyCodes(1, draws(2, 3, a, b)).codes
            }
        }
        assertEquals(6, orders.size)
    }

    @Test
    fun theInstanceIsP1AndSixteenBase32CharactersOfTenRandomBytes() {
        val i = approverInstance()
        assertTrue(Regex("p1-[a-z2-7]{16}").matches(i))
        assertTrue(approverInstance() != i)
        var asked = 0
        approverInstance { n ->
            asked = n
            ByteArray(n)
        }
        assertEquals(10, asked)
        assertEquals("p1-" + "a".repeat(16), approverInstance { ByteArray(it) })
    }

    @Test
    fun theBudgetStopsTheAdvertAtTheSecondFailureWithinTenMinutesUntilReopened() {
        var t = 0.0
        val b = VouchFailureBudget { t }
        assertFalse(b.fail())
        t = 599.0
        assertTrue(b.fail())
        assertTrue(b.stopped)
        b.reopen()
        assertFalse(b.stopped)
        assertFalse(b.fail())
    }

    @Test
    fun aFailureOlderThanTheWindowDoesNotCount() {
        var t = 0.0
        val b = VouchFailureBudget { t }
        b.fail()
        t = 600.0
        assertFalse(b.fail())
        assertFalse(b.stopped)
    }

    // -- the order guard ----------------------------------------------------------------------

    private fun rec(type: Int, b: ByteArray = ByteArray(0)) = VouchMessage(type, b)

    private fun result(s: VouchStatus) = rec(RecordType.VOUCH_RESULT, buildVouchResult(s))

    private val caps = listOf("app/1", "vouch/1")

    private class Pair2(val d: VouchFlow<VouchMessage>, val m: VouchFlow<VouchMessage>)

    private fun pair(): Pair2 {
        val d = VouchFlow<VouchMessage>(VouchRole.Requester)
        val m = VouchFlow<VouchMessage>(VouchRole.Approver)
        assertTrue(d.negotiate(caps, caps) is VouchVerdict.Ok)
        assertTrue(m.negotiate(caps, caps) is VouchVerdict.Ok)
        d.codeShown()
        m.codeShown()
        return Pair2(d, m)
    }

    private fun VouchVerdict<VouchMessage>.closeCode(): PeerCloseCode? = (this as? VouchVerdict.Closed)?.close

    private fun VouchVerdict<VouchMessage>.delivered(): List<VouchMessage> = (this as VouchVerdict.Ok).deliver

    @Test
    fun negotiationFailsClosedNothingPassesBeforeItAndVouch1IsNeeded() {
        val m = VouchFlow<VouchMessage>(VouchRole.Approver)
        assertEquals(PeerCloseCode.peer_not_allowed, m.receive(rec(RecordType.VOUCH_REQ)).closeCode())
        val d = VouchFlow<VouchMessage>(VouchRole.Requester)
        assertEquals(PeerCloseCode.peer_not_allowed, d.negotiate(listOf("vouch/2"), listOf("vouch/2")).closeCode())
        assertEquals(PeerCloseCode.peer_not_allowed, d.send(rec(RecordType.VOUCH_REQ)).closeCode())
    }

    @Test
    fun mGetsTheRequestOnlyAfterTheRightPickAndMayFinishOnlyThen() {
        val m = pair().m
        val req = rec(RecordType.VOUCH_REQ, "{}".toByteArray())
        assertTrue(m.receive(req).delivered().isEmpty())
        assertFalse(m.mayFinish)
        assertEquals(listOf(req), m.picked().delivered())
        assertFalse(m.mayFinish) // verified is the host's next step
        m.verified()
        assertTrue(m.mayFinish)
        assertTrue(m.send(result(VouchStatus.approved)) is VouchVerdict.Ok)
        assertFalse(m.mayFinish) // one result
    }

    @Test
    fun mCannotSendAResultBeforeTheRequestVerified() {
        val m = pair().m
        m.receive(rec(RecordType.VOUCH_REQ))
        m.picked()
        assertEquals(PeerCloseCode.peer_not_allowed, m.send(result(VouchStatus.approved)).closeCode())
    }

    @Test
    fun aWrongPickNoneMatchAndStopClosePeerByeATimeoutPeerTimeoutNoneDelivers() {
        val rows = listOf(
            AbandonReason.WrongPick to PeerCloseCode.peer_bye,
            AbandonReason.NoneMatch to PeerCloseCode.peer_bye,
            AbandonReason.Stop to PeerCloseCode.peer_bye,
            AbandonReason.Timeout to PeerCloseCode.peer_timeout,
        )
        for ((why, code) in rows) {
            val m = pair().m
            m.receive(rec(RecordType.VOUCH_REQ))
            assertEquals(code, m.abandon(why).closeCode())
            assertEquals(code, m.picked().closeCode()) // dead, same code
            assertFalse(m.mayFinish)
        }
    }

    @Test
    fun aPickBeforeTheCodesWereShownAndOnDIsRefused() {
        val m = VouchFlow<VouchMessage>(VouchRole.Approver)
        m.negotiate(caps, caps)
        assertEquals(PeerCloseCode.peer_not_allowed, m.picked().closeCode())
        assertEquals(PeerCloseCode.peer_not_allowed, pair().d.picked().closeCode())
    }

    @Test
    fun dSendsItsRequestOnceAndOnlyAfterTheCode() {
        val d = VouchFlow<VouchMessage>(VouchRole.Requester)
        d.negotiate(caps, caps)
        assertTrue(d.send(rec(RecordType.VOUCH_REQ)) is VouchVerdict.Closed)
        val d2 = pair().d
        assertTrue(d2.send(rec(RecordType.VOUCH_REQ)) is VouchVerdict.Ok)
        assertEquals(PeerCloseCode.peer_bad_frame, d2.send(rec(RecordType.VOUCH_REQ)).closeCode())
    }

    @Test
    fun dReadsAResultOnlyAfterItsRequestOnceWithAGoodBody() {
        assertEquals(PeerCloseCode.peer_not_allowed, pair().d.receive(result(VouchStatus.approved)).closeCode())
        val e = pair().d
        e.send(rec(RecordType.VOUCH_REQ))
        assertEquals(PeerCloseCode.peer_bad_frame, e.receive(rec(RecordType.VOUCH_RESULT, "[]".toByteArray())).closeCode())
        val f = pair().d
        f.send(rec(RecordType.VOUCH_REQ))
        val r = result(VouchStatus.denied)
        assertEquals(listOf(r), f.receive(r).delivered())
        assertEquals(PeerCloseCode.peer_bad_frame, f.receive(result(VouchStatus.denied)).closeCode())
    }

    @Test
    fun directionsDRefusesARequestMRefusesAResultAndAny003xFromD() {
        val p = pair()
        assertTrue(p.d.receive(rec(RecordType.VOUCH_REQ)) is VouchVerdict.Closed)
        assertEquals(PeerCloseCode.peer_not_allowed, p.m.receive(result(VouchStatus.approved)).closeCode())
        val m2 = pair().m
        assertEquals(PeerCloseCode.peer_not_allowed, m2.receive(rec(RecordType.KEYRING_WRAP)).closeCode())
        assertTrue(m2.send(result(VouchStatus.approved)) is VouchVerdict.Closed)
        assertEquals(PeerCloseCode.peer_not_allowed, m2.send(rec(RecordType.KEYRING_WRAP)).closeCode())
    }

    /** D after an approved result. */
    private fun approved(): VouchFlow<VouchMessage> {
        val d = pair().d
        d.send(rec(RecordType.VOUCH_REQ))
        d.receive(result(VouchStatus.approved))
        return d
    }

    @Test
    fun dHoldsSyncRecordsUntilItsPersonConfirmsTheAccount() {
        val d = approved()
        val a = rec(0x0030, ByteArray(10))
        val b = rec(0x003f, ByteArray(10))
        assertTrue(d.receive(a).delivered().isEmpty())
        assertTrue(d.receive(b).delivered().isEmpty())
        assertEquals(listOf(a, b), d.confirmAccount().delivered())
        val c = rec(0x0031, ByteArray(10))
        assertEquals(listOf(c), d.receive(c).delivered())
    }

    @Test
    fun dKeeps16RecordsAnd16KibThenClosesPeerBusy() {
        val d = approved()
        repeat(VOUCH_HELD_RECORDS) { assertTrue(d.receive(rec(0x0030)) is VouchVerdict.Ok) }
        assertEquals(PeerCloseCode.peer_busy, d.receive(rec(0x0030)).closeCode())
        val e = approved()
        assertTrue(e.receive(rec(0x0030, ByteArray(VOUCH_HELD_BYTES))) is VouchVerdict.Ok)
        assertEquals(PeerCloseCode.peer_busy, e.receive(rec(0x0030, ByteArray(1))).closeCode())
    }

    @Test
    fun aDeclineDropsEveryHeldRecordAndTheFlowStaysClosed() {
        val d = approved()
        d.receive(rec(0x0030, ByteArray(5)))
        assertEquals(PeerCloseCode.peer_bye, d.declineAccount().closeCode())
        assertEquals(PeerCloseCode.peer_bye, d.confirmAccount().closeCode())
        assertEquals(PeerCloseCode.peer_bye, d.receive(rec(0x0031)).closeCode())
    }

    @Test
    fun aDeniedOrExpiredResultLetsNoRecordThrough() {
        for (s in listOf(VouchStatus.denied, VouchStatus.expired)) {
            val d = pair().d
            d.send(rec(RecordType.VOUCH_REQ))
            d.receive(result(s))
            assertEquals(PeerCloseCode.peer_not_allowed, d.receive(rec(0x0030)).closeCode())
        }
    }

    @Test
    fun recordsOutsideTheVouchSetPassThroughUntouched() {
        val m = pair().m
        val ping = rec(RecordType.PING, ByteArray(8))
        assertEquals(listOf(ping), m.receive(ping).delivered())
    }
}
