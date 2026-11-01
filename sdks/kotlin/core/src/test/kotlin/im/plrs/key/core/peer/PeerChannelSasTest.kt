// @pkey-feature connect.protocol
//
// `PeerChannel` in modes `v` and `p` (WIRE-CONTRACT-V5 sections 15.5 and 15.6): the commit-reveal
// SAS, the approver's limiter, the held records and the deadlines. Mirrors the modes v and p half of
// client-core's `peerSession.test.ts` and the Python engine's `test_connect_peer_sas.py`.

package im.plrs.key.core.peer

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.security.SecureRandom

class PeerChannelSasTest {
    private val rng = SecureRandom()

    private fun rnd(): ByteArray = ByteArray(32).also { rng.nextBytes(it) }

    private inner class Side(
        val mode: PeerMode,
        role: NoiseRole,
        label: String? = null,
        admission: HandshakeLimiter? = if (role == NoiseRole.responder) HandshakeLimiter() else null,
        ports: NoisePorts = NoisePorts(),
        holdSas: Boolean = false,
    ) {
        val events = ArrayList<SessionEvent>()
        val out = ArrayList<ByteArray>()
        var clock = 0.0
        val s = PeerChannel(
            role, "djdl", RawNoiseStatic(rnd()), null,
            HelloInfo("test", "demo", label),
            { out.add(it) }, { events.add(it) },
            caps = listOf("app/1", "ring/1"), ports = ports, mono = { clock },
            mode = mode, admission = admission, holdSas = holdSas,
        )

        inline fun <reified T : SessionEvent> of(): List<T> = events.filterIsInstance<T>()

        fun closed(): List<SessionEvent.Closed> = of<SessionEvent.Closed>()

        fun records(): List<Int> = of<SessionEvent.Record>().map { it.recordType }
    }

    private fun pump(a: Side, b: Side) = runBlocking {
        repeat(200) {
            if (a.out.isEmpty() && b.out.isEmpty()) return@runBlocking
            val ao = ArrayList(a.out)
            a.out.clear()
            for (m in ao) b.s.receive(m)
            val bo = ArrayList(b.out)
            b.out.clear()
            for (m in bo) a.s.receive(m)
        }
    }

    /** The first 32-byte draws go to the ephemeral key; the second is the nonce. */
    private fun fixedNonce(nonce: ByteArray): NoisePorts {
        var n = 0
        return NoisePorts(random = { len -> if (len == 32 && ++n == 2) nonce.copyOf() else NoisePorts.defaultRandom(len) })
    }

    private fun pair(mode: PeerMode): Pair<Side, Side> = Side(mode, NoiseRole.initiator) to Side(mode, NoiseRole.responder)

    private class Raw(val tp: NoiseTransport, val hash: ByteArray)

    /** A hand-driven device against a responder: handshake done, the approver's HELLO read, ours sent. */
    private fun rawDevice(m: Side): Raw = runBlocking {
        val mode = m.mode
        val raw = NoiseHandshake(
            NoiseHandshakeOptions(
                NoiseRole.initiator,
                peerNoiseProtocol(mode),
                peerPrologue("djdl", mode),
                null,
                RawNoiseStatic(
                    ByteArray(32) {
                        7
                    },
                ),
            ),
        )
        m.s.receive(raw.writeMessage(payload1()))
        raw.readMessage(m.out.removeAt(0))
        // Mode v needs `vouch/1` on both sides (N7); mode p lists nothing.
        val caps = if (mode == PeerMode.v) "[\"vouch/1\"]" else "[]"
        m.s.receive(raw.writeMessage("{\"v\":1,\"caps\":$caps}".toByteArray()))
        Raw(raw.transport(), raw.handshakeHash)
    }

    private fun put(m: Side, r: Raw, type: Int, body: ByteArray) = runBlocking {
        m.s.receive(r.tp.send.encrypt(ByteArray(0), encodeRecord(PeerRecord(type, 0, body))))
    }

    private fun hello(m: Side, r: Raw) {
        runBlocking { r.tp.receive.decrypt(ByteArray(0), m.out.removeAt(0)) }
        put(m, r, RecordType.HELLO, "{\"platform\":\"t\",\"app\":\"a\",\"maxMessage\":1048576}".toByteArray())
    }

    private fun body(member: SasMember, v: ByteArray) = sasBody(member, v)

    @Test
    fun bothSidesShowTheSameCodeThenRecordsFlow() = runBlocking {
        for (mode in listOf(PeerMode.v, PeerMode.p)) {
            val (d, m) = pair(mode)
            d.s.start()
            pump(d, m)
            val sd = d.of<SessionEvent.Sas>().single()
            val sm = m.of<SessionEvent.Sas>().single()
            assertEquals(7, sd.display.length)
            assertEquals(' ', sd.display[3])
            assertEquals(sasDisplay(sd.code), sd.display)
            assertEquals(sd.code, sm.code)
            val est = d.of<SessionEvent.Established>().single()
            // Mode v lists `vouch/1` itself (N7).
            assertEquals(if (mode == PeerMode.v) listOf("app/1", "ring/1", "vouch/1") else listOf("app/1", "ring/1"), est.caps)
            assertFalse(est.helloAuthenticated)
            try {
                d.s.sendRecord(RecordType.VOUCH_REQ, ByteArray(0))
                fail("not open before the person confirms")
            } catch (e: IllegalStateException) {
                assertEquals("session not open", e.message)
            }
            d.s.confirmSas()
            pump(d, m)
            assertTrue(m.records().isEmpty())
            m.s.confirmSas()
            pump(d, m)
            val expect = if (mode == PeerMode.p) listOf(RecordType.CONFIRM) else emptyList()
            assertEquals(expect, m.records())
            assertEquals(expect, d.records())
            assertTrue(d.s.isOpen && m.s.isOpen && d.closed().isEmpty())
        }
    }

    @Test
    fun theCodeIsBoundToTheHandshakeHashBothNoncesAndTheMode() = runBlocking {
        val nD = rnd()
        val m = Side(PeerMode.v, NoiseRole.responder)
        val r = rawDevice(m)
        hello(m, r)
        put(m, r, RecordType.SAS_COMMIT, body(SasMember.c, sasCommit(nD)))
        val nonce = r.tp.receive.decrypt(ByteArray(0), m.out.removeAt(0))
        val nM = parseSasBody(SasMember.nM, nonce.copyOfRange(3, nonce.size))!!
        put(m, r, RecordType.SAS_REVEAL, body(SasMember.nD, nD))
        val code = m.of<SessionEvent.Sas>().single().code
        assertEquals(sasValue(r.hash, nD, nM, PeerMode.v), code)
        assertTrue(m.closed().isEmpty())
    }

    @Test
    fun aDeviceNonceFromThePortIsUsedAndTheApproverKeepsItsOwn() = runBlocking {
        val nd = ByteArray(32) { 3 }
        val nm = ByteArray(32) { 9 }
        val d = Side(PeerMode.v, NoiseRole.initiator, ports = fixedNonce(nd))
        val m = Side(PeerMode.v, NoiseRole.responder, ports = fixedNonce(nm))
        d.s.start()
        pump(d, m)
        assertEquals(d.of<SessionEvent.Sas>().single().code, m.of<SessionEvent.Sas>().single().code)
        assertTrue(d.closed().isEmpty() && m.closed().isEmpty())
    }

    @Test
    fun aHostRecordIsHeldUntilThisSideConfirms() = runBlocking {
        val (d, m) = pair(PeerMode.v)
        d.s.start()
        pump(d, m)
        d.s.confirmSas()
        d.s.sendRecord(RecordType.VOUCH_REQ, "{}".toByteArray())
        pump(d, m)
        assertTrue(m.records().isEmpty())
        assertFalse(m.s.closed)
        m.s.confirmSas()
        assertEquals(listOf(RecordType.VOUCH_REQ), m.records())
    }

    @Test
    fun atMostSixteenRecordsAreHeld() = runBlocking {
        val (d, m) = pair(PeerMode.v)
        d.s.start()
        pump(d, m)
        d.s.confirmSas()
        repeat(16) { d.s.sendRecord(RecordType.VOUCH_REQ, "{}".toByteArray()) }
        pump(d, m)
        assertFalse(m.s.closed)
        d.s.sendRecord(RecordType.VOUCH_REQ, "{}".toByteArray())
        pump(d, m)
        assertEquals(listOf(SessionEvent.Closed("peer_busy", false)), m.closed())
    }

    @Test
    fun confirmingBeforeACodeCloses() = runBlocking {
        val (d, _) = pair(PeerMode.v)
        d.s.start()
        d.s.confirmSas()
        assertEquals(listOf(SessionEvent.Closed("peer_not_allowed", false)), d.closed())
    }

    @Test
    fun helloDisplayDataIsUnauthenticatedAndCleaned() = runBlocking {
        val d = Side(PeerMode.v, NoiseRole.initiator, label = "  Café ‮TV\u0000  ")
        val m = Side(PeerMode.v, NoiseRole.responder)
        d.s.start()
        pump(d, m)
        val est = m.of<SessionEvent.Established>().single()
        assertFalse(est.helloAuthenticated)
        assertEquals("Café TV", est.hello.label)
    }

    // -- HELLO from a peer that is not verified (section 15.6) ---------------------------------------

    private fun helloOf(platform: String, app: String, extra: String = ""): String =
        "{\"platform\":\"$platform\",\"app\":\"$app\",\"maxMessage\":1048576$extra}"

    /** A hand-driven device sends [body] as its HELLO to an approver in [mode]; the approver's events. */
    private fun approverSees(mode: PeerMode, body: String): Side {
        val m = Side(mode, NoiseRole.responder)
        val r = rawDevice(m)
        runBlocking { r.tp.receive.decrypt(ByteArray(0), m.out.removeAt(0)) }
        put(m, r, RecordType.HELLO, body.toByteArray())
        return m
    }

    @Test
    fun platformShowsAsSentOnlyInItsPlainSpellingAndAppIsCleanedLikeLabel() {
        for (mode in listOf(PeerMode.v, PeerMode.p)) {
            val plain = approverSees(mode, helloOf("iOS 17.2_beta+1-x", "Demo"))
            assertEquals("iOS 17.2_beta+1-x", plain.of<SessionEvent.Established>().single().hello.platform)
            for (bad in listOf("", "x".repeat(33), "Win\\u0000dows", "Caf\\u00e9", "a/b", "tab\\there", "\\u202eevil")) {
                val h = approverSees(mode, helloOf(bad, "Demo")).of<SessionEvent.Established>().single().hello
                assertEquals(bad, "Unknown", h.platform)
            }
            assertEquals("x".repeat(32), approverSees(mode, helloOf("x".repeat(32), "Demo")).of<SessionEvent.Established>().single().hello.platform)
            val app = approverSees(mode, helloOf("t", "  Caf\\u00e9 \\u202eTV\\u0000  ")).of<SessionEvent.Established>().single().hello.app
            assertEquals("Caf\u00e9 TV", app)
            // nothing left after cleaning: "Unknown"
            assertEquals("Unknown", approverSees(mode, helloOf("t", "\\u202e\\u0000 ")).of<SessionEvent.Established>().single().hello.app)
            // at most 64 code points
            assertEquals(64, approverSees(mode, helloOf("t", "a".repeat(100))).of<SessionEvent.Established>().single().hello.app.length)
        }
    }

    @Test
    fun aHelloOverFourKibIsRefusedInModesVAndPButNotInModeA() {
        for (mode in listOf(PeerMode.v, PeerMode.p)) {
            val fits = helloOf("t", "a", ",\"pad\":\"" + "x".repeat(4096 - helloOf("t", "a", ",\"pad\":\"\"").length) + "\"")
            assertEquals(4096, fits.length)
            assertEquals(1, approverSees(mode, fits).of<SessionEvent.Established>().size)
            val over = approverSees(mode, fits.replace("\"pad\":\"", "\"pad\":\"y"))
            assertTrue(over.of<SessionEvent.Established>().isEmpty())
            assertEquals(listOf(SessionEvent.Closed("peer_bad_frame", false)), over.closed())
        }
    }

    @Test
    fun heldBytesBeforeConfirmationAreCappedAt16Kib() = runBlocking {
        val (d, m) = pair(PeerMode.v)
        d.s.start()
        pump(d, m)
        d.s.confirmSas()
        d.s.sendRecord(RecordType.VOUCH_REQ, ByteArray(8000))
        d.s.sendRecord(RecordType.VOUCH_REQ, ByteArray(8000))
        pump(d, m)
        assertFalse(m.s.closed) // 16000 held
        d.s.sendRecord(RecordType.VOUCH_REQ, ByteArray(400))
        pump(d, m)
        assertEquals(listOf(SessionEvent.Closed("peer_busy", false)), m.closed())
    }

    @Test
    fun modeConfigurationIsChecked() {
        val none: (ByteArray) -> Unit = {}
        val ev: (SessionEvent) -> Unit = {}
        try {
            PeerChannel(NoiseRole.responder, "djdl", RawNoiseStatic(rnd()), null, HelloInfo("t", "a"), none, ev, mode = PeerMode.v)
            fail("an approver needs a limiter")
        } catch (e: IllegalArgumentException) {
            assertEquals("an approver needs an admission limiter", e.message)
        }
        try {
            PeerChannel(NoiseRole.initiator, "djdl", RawNoiseStatic(rnd()), null, HelloInfo("t", "a"), none, ev, mode = PeerMode.a)
            fail("mode a needs an account")
        } catch (e: IllegalArgumentException) {
            assertEquals("account context", e.message)
        }
    }

    @Test
    fun theLimiterRefusesOverTheRateAndPastThePendingCapAndReleasesOnClose() = runBlocking {
        val t = doubleArrayOf(0.0)
        val lim = HandshakeLimiter(5, 2) { t[0] }

        fun start(): Pair<Side, Side> {
            val m = Side(PeerMode.v, NoiseRole.responder, admission = lim)
            val d = Side(PeerMode.v, NoiseRole.initiator)
            runBlocking { d.s.start() }
            pump(d, m)
            return d to m
        }
        start()
        val (_, m2) = start()
        val third = Side(PeerMode.v, NoiseRole.responder, admission = lim)
        val d3 = Side(PeerMode.v, NoiseRole.initiator)
        d3.s.start()
        pump(d3, third)
        assertTrue(third.out.isEmpty())
        assertEquals(listOf(SessionEvent.Closed("peer_busy", false)), third.closed())
        m2.s.close()
        assertNotNull(lim.begin())
    }

    @Test
    fun theLimiterCountsFiveAMinuteOnAMonotonicClock() {
        val t = doubleArrayOf(0.0)
        val lim = HandshakeLimiter(5, 99) { t[0] }
        assertEquals(List(5) { true } + false, List(6) { lim.begin() != null })
        t[0] = 61.0
        assertNotNull(lim.begin())
    }

    @Test
    fun aReleaseRunsOnceAndAClosedSessionFreesItsSlot() = runBlocking {
        val lim = HandshakeLimiter(99, 1)
        val m = Side(PeerMode.v, NoiseRole.responder, admission = lim)
        val d = Side(PeerMode.v, NoiseRole.initiator)
        d.s.start()
        pump(d, m)
        assertNull(lim.begin())
        m.s.close()
        val rel = lim.begin()
        assertNotNull(rel)
        rel!!()
        rel() // idempotent
        assertNotNull(lim.begin())
        assertNull(lim.begin())
    }

    @Test
    fun aPeerCloseFreesTheResponderSlot() = runBlocking {
        // R-6K N5: the approver's slot is released when the peer sends CLOSE, not only on its own close.
        val lim = HandshakeLimiter(99, 1)
        val m = Side(PeerMode.v, NoiseRole.responder, admission = lim)
        val d = Side(PeerMode.v, NoiseRole.initiator)
        d.s.start()
        pump(d, m)
        assertNull(lim.begin())
        d.s.close()
        pump(d, m)
        assertEquals(listOf(true), m.closed().map { it.byPeer })
        assertNotNull(lim.begin())
    }

    @Test
    fun theConfirmedSessionFreesItsSlotToo() = runBlocking {
        val lim = HandshakeLimiter(99, 1)
        val m = Side(PeerMode.v, NoiseRole.responder, admission = lim)
        val d = Side(PeerMode.v, NoiseRole.initiator)
        d.s.start()
        pump(d, m)
        m.s.confirmSas()
        assertNotNull(lim.begin())
    }

    @Test
    fun theCodeDeadlineEndsAnUnconfirmedSession() = runBlocking {
        val (d, m) = pair(PeerMode.v)
        d.s.start()
        pump(d, m)
        assertEquals(SAS_DEADLINE_SECONDS.toDouble(), m.s.wakeIn()!!, 0.0)
        m.clock = SAS_DEADLINE_SECONDS - 1.0
        m.s.tick()
        assertTrue(m.closed().isEmpty())
        m.clock = SAS_DEADLINE_SECONDS.toDouble()
        m.s.tick()
        assertEquals(listOf(SessionEvent.Closed("peer_timeout", false)), m.closed())
        pump(d, m)
        assertEquals(listOf(SessionEvent.Closed("peer_timeout", true)), d.closed())
        // Confirming ends the deadline.
        val (d2, m2) = pair(PeerMode.v)
        d2.s.start()
        pump(d2, m2)
        m2.s.confirmSas()
        assertNull(m2.s.wakeIn())
    }

    @Test
    fun theTransportDeadlineClosesAStalledHandshake() = runBlocking {
        val (d, m) = pair(PeerMode.v)
        d.s.start()
        m.s.receive(d.out.removeAt(0))
        m.clock = TRANSPORT_DEADLINE_SECONDS.toDouble()
        m.s.tick()
        assertEquals(listOf(SessionEvent.Closed("peer_timeout", false)), m.closed())
    }

    @Test
    fun theFirstRecordMustBeHelloAndTheRefusalIsSaid() = runBlocking {
        val m = Side(PeerMode.p, NoiseRole.responder)
        val r = rawDevice(m)
        put(m, r, RecordType.PING, ByteArray(8))
        assertEquals(listOf(SessionEvent.Closed("peer_bad_frame", false)), m.closed())
        r.tp.receive.decrypt(ByteArray(0), m.out[0]) // HELLO
        val close = r.tp.receive.decrypt(ByteArray(0), m.out[1])
        assertEquals("{\"code\":\"peer_bad_frame\"}", String(close.copyOfRange(3, close.size)))
    }

    @Test
    fun aCertificateInAVOrPPayloadIsRefused() = runBlocking {
        val m = Side(PeerMode.v, NoiseRole.responder)
        val raw = NoiseHandshake(
            NoiseHandshakeOptions(
                NoiseRole.initiator,
                peerNoiseProtocol(PeerMode.v),
                peerPrologue("djdl", PeerMode.v),
                null,
                RawNoiseStatic(
                    ByteArray(32) {
                        7
                    },
                ),
            ),
        )
        m.s.receive(raw.writeMessage(payload1()))
        raw.readMessage(m.out.removeAt(0))
        m.s.receive(raw.writeMessage("{\"v\":1,\"caps\":[],\"cert\":\"x\",\"ring\":1}".toByteArray()))
        assertEquals(listOf(SessionEvent.Closed("handshake_failed", false)), m.closed())
    }

    @Test
    fun aRevealThatDoesNotMatchTheCommitmentCloses() = runBlocking {
        val m = Side(PeerMode.v, NoiseRole.responder)
        val r = rawDevice(m)
        hello(m, r)
        put(m, r, RecordType.SAS_COMMIT, body(SasMember.c, sasCommit(rnd())))
        put(m, r, RecordType.SAS_REVEAL, body(SasMember.nD, rnd()))
        assertEquals(listOf(SessionEvent.Closed("peer_bad_frame", false)), m.closed())
        assertTrue(m.of<SessionEvent.Sas>().isEmpty())
    }

    @Test
    fun outOfOrderSasRecordsClose() = runBlocking {
        val cases = listOf(
            listOf(RecordType.SAS_NONCE to SasMember.nM),
            listOf(RecordType.SAS_REVEAL to SasMember.nD),
            listOf(RecordType.SAS_COMMIT to SasMember.c, RecordType.SAS_COMMIT to SasMember.c),
        )
        for (records in cases) {
            val m = Side(PeerMode.v, NoiseRole.responder)
            val r = rawDevice(m)
            hello(m, r)
            for ((type, member) in records) put(m, r, type, body(member, ByteArray(32)))
            assertEquals(listOf(SessionEvent.Closed("peer_bad_frame", false)), m.closed())
        }
    }

    @Test
    fun aMalformedCommitCloses() = runBlocking {
        val m = Side(PeerMode.v, NoiseRole.responder)
        val r = rawDevice(m)
        hello(m, r)
        put(m, r, RecordType.SAS_COMMIT, "{\"c\":\"short\"}".toByteArray())
        assertEquals(listOf(SessionEvent.Closed("peer_bad_frame", false)), m.closed())
    }

    @Test
    fun noHostRecordIsDeliveredBeforeTheCodeIsConfirmed() = runBlocking {
        val (d, m) = pair(PeerMode.p)
        d.s.start()
        pump(d, m)
        assertTrue(d.of<SessionEvent.Record>().isEmpty() && m.of<SessionEvent.Record>().isEmpty())
    }

    @Test
    fun confirmIsOwnedByTheSessionInModePOnly() = runBlocking {
        val (d, m) = pair(PeerMode.p)
        d.s.start()
        pump(d, m)
        d.s.confirmSas()
        try {
            d.s.sendRecord(RecordType.CONFIRM, "{}".toByteArray())
            fail("owned in mode p")
        } catch (e: IllegalArgumentException) {
            assertEquals("record owned by the session", e.message)
        }
    }

    @Test
    fun noNonceOrCodeInAToString() = runBlocking {
        val (d, m) = pair(PeerMode.v)
        d.s.start()
        pump(d, m)
        val text = d.s.toString() + d.events + m.events
        assertFalse(text.contains(d.of<SessionEvent.Sas>().single().display))
    }

    // -- mode v hooks (CC-15): vouch/1, the handshake hash, holdSas and startSas --------------------

    @Test
    fun modeVListsVouch1ItselfAndExposesTheOrderGuardInModeVOnly() {
        assertEquals(VouchRole.Requester, Side(PeerMode.v, NoiseRole.initiator).s.vouch?.role)
        assertEquals(VouchRole.Approver, Side(PeerMode.v, NoiseRole.responder).s.vouch?.role)
        assertNull(Side(PeerMode.p, NoiseRole.initiator).s.vouch)
    }

    @Test
    fun handshakeHashIsTheSameOnBothEndsOnceEstablishedAndACopy() = runBlocking {
        val (d, m) = pair(PeerMode.v)
        try {
            d.s.handshakeHash()
            fail("not established yet")
        } catch (e: IllegalStateException) {
            assertEquals("session not established", e.message)
        }
        d.s.start()
        pump(d, m)
        val h = d.s.handshakeHash()
        assertEquals(32, h.size)
        assertTrue(h.contentEquals(m.s.handshakeHash()))
        h.fill(0)
        assertTrue(d.s.handshakeHash().contentEquals(m.s.handshakeHash()))
    }

    @Test
    fun holdSasStopsAfterHelloAndStartSasSendsTheCommitAndTheCodeFollows() = runBlocking {
        val d = Side(PeerMode.v, NoiseRole.initiator, holdSas = true)
        val m = Side(PeerMode.v, NoiseRole.responder)
        d.s.start()
        pump(d, m)
        assertEquals(1, d.of<SessionEvent.Established>().size)
        assertEquals(1, m.of<SessionEvent.Established>().size)
        assertTrue(d.of<SessionEvent.Sas>().isEmpty() && m.of<SessionEvent.Sas>().isEmpty())
        assertFalse(d.s.closed || m.s.closed)
        d.s.startSas()
        pump(d, m)
        assertEquals(d.of<SessionEvent.Sas>().single().code, m.of<SessionEvent.Sas>().single().code)
        // A second start is refused and closes the session.
        d.s.startSas()
        assertEquals(listOf(SessionEvent.Closed("peer_not_allowed", false)), d.closed())
    }

    @Test
    fun dRestartsItsCodeDeadlineAtStartSas() = runBlocking {
        val d = Side(PeerMode.v, NoiseRole.initiator, holdSas = true)
        val m = Side(PeerMode.v, NoiseRole.responder)
        d.s.start()
        pump(d, m)
        // Held at HELLO: the deadline from the first byte stands.
        assertEquals(SAS_DEADLINE_SECONDS.toDouble(), d.s.wakeIn()!!, 0.0)
        d.clock = 100.0
        assertEquals(20.0, d.s.wakeIn()!!, 0.0)
        d.s.startSas()
        assertEquals(SAS_DEADLINE_SECONDS.toDouble(), d.s.wakeIn()!!, 0.0)
        d.clock = 100.0 + SAS_DEADLINE_SECONDS
        d.s.tick()
        assertEquals(listOf(SessionEvent.Closed("peer_timeout", false)), d.closed())
    }

    @Test
    fun mRestartsItsCodeDeadlineWhenSasCommitArrives() = runBlocking {
        val d = Side(PeerMode.v, NoiseRole.initiator, holdSas = true)
        val m = Side(PeerMode.v, NoiseRole.responder)
        d.s.start()
        pump(d, m)
        m.clock = 100.0
        assertEquals(20.0, m.s.wakeIn()!!, 0.0)
        d.s.startSas()
        pump(d, m)
        // The commit came at 100 s on M's clock: its 120 s count from there.
        assertEquals(SAS_DEADLINE_SECONDS.toDouble(), m.s.wakeIn()!!, 0.0)
        m.clock = 100.0 + SAS_DEADLINE_SECONDS
        m.s.tick()
        assertEquals(listOf(SessionEvent.Closed("peer_timeout", false)), m.closed())
    }

    @Test
    fun modePKeepsItsDeadlineFromTheFirstByte() = runBlocking {
        val (d, m) = pair(PeerMode.p)
        d.s.start()
        m.clock = 0.0
        pump(d, m)
        assertEquals(SAS_DEADLINE_SECONDS.toDouble(), m.s.wakeIn()!!, 0.0)
    }

    @Test
    fun choosingOneOfTwoHeldApproversStartsTheSasOnThatSessionOnly() = runBlocking {
        val d1 = Side(PeerMode.v, NoiseRole.initiator, holdSas = true)
        val m1 = Side(PeerMode.v, NoiseRole.responder)
        val d2 = Side(PeerMode.v, NoiseRole.initiator, holdSas = true)
        val m2 = Side(PeerMode.v, NoiseRole.responder)
        d1.s.start()
        d2.s.start()
        pump(d1, m1)
        pump(d2, m2)
        d1.s.startSas()
        pump(d1, m1)
        d2.s.close(PeerCloseCode.peer_bye)
        pump(d2, m2)
        assertEquals(1, m1.of<SessionEvent.Sas>().size)
        assertEquals(0, m2.of<SessionEvent.Sas>().size)
        assertEquals(listOf(SessionEvent.Closed("peer_bye", true)), m2.closed())
    }

    @Test
    fun startSasIsRefusedBeforeEstablishedWithoutHoldSasAndHoldSasOutsideModeV() = runBlocking {
        val early = Side(PeerMode.v, NoiseRole.initiator, holdSas = true)
        early.s.start()
        early.s.startSas()
        assertEquals(listOf(SessionEvent.Closed("peer_not_allowed", false)), early.closed())
        val (plain, m) = pair(PeerMode.v)
        plain.s.start()
        pump(plain, m)
        plain.s.startSas()
        assertEquals(listOf(SessionEvent.Closed("peer_not_allowed", false)), plain.closed())
        for ((mode, role) in listOf(PeerMode.p to NoiseRole.initiator, PeerMode.v to NoiseRole.responder)) {
            try {
                Side(mode, role, holdSas = true)
                fail("holdSas is for the mode v initiator")
            } catch (e: IllegalArgumentException) {
                assertEquals("holdSas is for the mode v initiator", e.message)
            }
        }
    }

    @Test
    fun closesPeerNotAllowedAfterHelloAndBeforeAnySasRecordWhenThePeerLacksVouch1() = runBlocking {
        val m = Side(PeerMode.v, NoiseRole.responder)
        val raw = NoiseHandshake(
            NoiseHandshakeOptions(
                NoiseRole.initiator,
                peerNoiseProtocol(PeerMode.v),
                peerPrologue("djdl", PeerMode.v),
                null,
                RawNoiseStatic(
                    ByteArray(32) {
                        7
                    },
                ),
            ),
        )
        m.s.receive(raw.writeMessage(payload1()))
        raw.readMessage(m.out.removeAt(0))
        m.s.receive(raw.writeMessage("{\"v\":1,\"caps\":[\"app/1\"]}".toByteArray()))
        val tp = raw.transport()
        val hello = "{\"platform\":\"t\",\"app\":\"a\",\"maxMessage\":1048576}".toByteArray()
        m.s.receive(tp.send.encrypt(ByteArray(0), encodeRecord(PeerRecord(RecordType.HELLO, 0, hello))))
        assertTrue(m.of<SessionEvent.Established>().isEmpty())
        assertEquals(listOf(SessionEvent.Closed("peer_not_allowed", false)), m.closed())
        // Its own HELLO, then CLOSE: no SAS record.
        val types = m.out.map { o -> tp.receive.decrypt(ByteArray(0), o).let { ((it[0].toInt() and 0xff) shl 8) or (it[1].toInt() and 0xff) } }
        assertEquals(listOf(RecordType.HELLO, RecordType.CLOSE), types)
    }

    @Test
    fun anOpenMoreChainIsCappedAt16KibInModesVAndPButNotInModeA() {
        for (mode in listOf(RecordMode.v, RecordMode.p)) {
            val asm = RecordAssembler(mode)
            // 16 KiB is the most an open chain may reach; one more byte closes.
            val type = RecordType.HELLO
            assertTrue(asm.push(PeerRecord(type, 1, ByteArray(MAX_VP_CHAIN_BYTES))) is AssembleResult.Pending)
            val over = asm.push(PeerRecord(type, 0, ByteArray(1)))
            assertEquals(PeerCloseCode.peer_bad_frame, (over as AssembleResult.Close).code)
            // A single record under the cap is not a chain and is not capped by it.
            val single = RecordAssembler(mode).push(PeerRecord(type, 0, ByteArray(MAX_RECORD_BODY)))
            assertTrue(single is AssembleResult.Message)
            // The first MORE record over the cap closes at once.
            val first = RecordAssembler(mode).push(PeerRecord(type, 1, ByteArray(MAX_VP_CHAIN_BYTES + 1)))
            assertEquals(PeerCloseCode.peer_bad_frame, (first as AssembleResult.Close).code)
        }
        val a = RecordAssembler(RecordMode.a)
        assertTrue(a.push(PeerRecord(RecordType.HELLO, 1, ByteArray(MAX_VP_CHAIN_BYTES + 1))) is AssembleResult.Pending)
    }
}
