// @pkey-feature connect.local
//
// Local links end to end in :core, in memory (WIRE-CONTRACT-V5 section 15.12): CPace to a mode-q pairing with the consent
// and LOCAL_LINK exchange, then mode l under the link it made; the pin, a wrong code, a decline, a peer without `local/1`,
// the shared listener's trial order and its limiter. The byte-level rows are noise-vectors.json `cpace` and
// peer-matrix.json `local`, which :conformance runs. Mirrors client-core's `peerLocalPairing.test.ts`.

package im.plrs.key.core.peer

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicInteger

class PeerLocalPairingTest {
    private val rng = SecureRandom()

    private fun rnd(n: Int = 32): ByteArray = ByteArray(n).also { rng.nextBytes(it) }

    private fun utf8(s: String): ByteArray = s.toByteArray(Charsets.UTF_8)

    private fun pub(priv: ByteArray): ByteArray = runBlocking { RawNoiseStatic(priv).publicKey() }

    private inner class Side(
        mode: PeerMode,
        role: NoiseRole,
        priv: ByteArray? = null,
        locals: List<LocalLink> = emptyList(),
        contacts: List<ContactLink> = emptyList(),
        pair: PairingOptions? = null,
        limiter: HandshakeLimiter? = null,
        group: String? = null,
        ports: NoisePorts = NoisePorts(),
    ) {
        val events = ArrayList<SessionEvent>()
        val out = ArrayList<ByteArray>()
        val s = PeerChannel(
            role, "djdl", priv?.let { RawNoiseStatic(it) }, null, HelloInfo("test", "demo"),
            { out.add(it) }, { events.add(it) },
            caps = listOf("app/1"), ports = ports, mode = mode, admission = limiter, contacts = contacts,
            locals = locals, pair = pair, admissionGroup = group,
        )

        inline fun <reified T : SessionEvent> of(): List<T> = events.filterIsInstance<T>()

        fun closed(): SessionEvent.Closed? = of<SessionEvent.Closed>().firstOrNull()
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

    private class Cp(val psk: ByteArray, val isk: ByteArray)

    /** CPace between a joiner and a shower: the PSK and ISK each holds. */
    private fun cpace(joinerCode: String, showerCode: String): Pair<Cp, Cp> {
        val sid = rnd(10)
        val ci = peerPrologue("djdl", PeerMode.q)
        val gJ = cpaceGenerator(cpacePrsCode(joinerCode), ci, sid)
        val gS = cpaceGenerator(cpacePrsCode(showerCode), ci, sid)
        val ya = cpaceScalar()
        val yb = cpaceScalar()
        val shareA = cpaceShare(ya, gJ)!!
        val shareB = cpaceShare(yb, gS)!!
        val iskJ = cpaceIsk(sid, ya, shareA, shareB, initiator = true)!!
        val iskS = cpaceIsk(sid, yb, shareA, shareB, initiator = false)!!
        return Cp(cpacePsk(iskJ, "djdl"), iskJ) to Cp(cpacePsk(iskS, "djdl"), iskS)
    }

    private class Pairing(val joiner: Side, val shower: Side, val jKey: ByteArray, val sKey: ByteArray)

    private fun pairSides(
        joinerCode: String = "123456",
        showerCode: String = "123456",
        showerHeld: Int = 0,
        showerElapsed: Double = 0.0,
        permit: () -> Boolean = { true },
    ): Pairing {
        val (j, s) = cpace(joinerCode, showerCode)
        val jKey = rnd()
        val sKey = rnd()
        val joiner = Side(
            PeerMode.q, NoiseRole.initiator, jKey,
            pair = PairingOptions(j.psk, j.isk, 0, listOf("docs"), "Anna", 0.0),
        )
        val shower = Side(
            PeerMode.q, NoiseRole.responder, sKey,
            pair = PairingOptions(s.psk, s.isk, showerHeld, listOf("docs", "music"), "Bo", showerElapsed, permit),
        )
        return Pairing(joiner, shower, jKey, sKey)
    }

    /** Both handshakes, both persons' answers, then the exchange; the shower's person may decline. */
    private fun settle(p: Pairing, decline: Boolean = false): Pairing {
        runBlocking {
            p.joiner.s.start()
            pump(p.joiner, p.shower)
            p.joiner.s.confirmPairing()
            if (decline) p.shower.s.declinePairing() else p.shower.s.confirmPairing()
            pump(p.joiner, p.shower)
        }
        return p
    }

    private fun pairUp(): Pairing = settle(pairSides())

    @Test
    fun makesOneLinkSecretOnBothSidesWithEachOthersKeysLabelAndSharedCategories() {
        val p = pairUp()
        val est = p.shower.of<SessionEvent.Established>().single()
        assertFalse(est.helloAuthenticated)
        assertTrue(LOCAL_CAP in est.caps)
        assertEquals(listOf(SessionEvent.Guess::class), p.shower.of<SessionEvent.Guess>().map { it::class })
        assertTrue(p.shower.of<SessionEvent.Guess>().single().opens)
        val lj = p.joiner.of<SessionEvent.LocalLinked>().single()
        val ls = p.shower.of<SessionEvent.LocalLinked>().single()
        assertEquals(32, lj.secret.size)
        assertArrayEquals(lj.secret, ls.secret)
        assertArrayEquals(pub(p.jKey), lj.ownKey)
        assertArrayEquals(pub(p.sKey), lj.peerKey)
        assertArrayEquals(pub(p.jKey), ls.peerKey)
        assertEquals("Bo", lj.label)
        assertEquals("Anna", ls.label)
        assertEquals(listOf("docs"), lj.cats)
        assertEquals(listOf("docs"), ls.cats)
        // Each side closed after it stored the link.
        assertEquals("peer_bye", p.joiner.closed()!!.code)
        assertEquals("peer_bye", p.shower.closed()!!.code)
    }

    @Test
    fun makesANewLinkForEveryPairing() {
        val a = pairUp()
        val b = pairUp()
        assertFalse(a.joiner.of<SessionEvent.LocalLinked>().single().secret.contentEquals(b.joiner.of<SessionEvent.LocalLinked>().single().secret))
    }

    @Test
    fun aWrongCodeIsOneFailedGuessAndTheShowerClosesSilently() = runBlocking {
        val p = pairSides(joinerCode = "123457", showerCode = "123456")
        p.joiner.s.start()
        pump(p.joiner, p.shower)
        assertFalse(p.shower.of<SessionEvent.Guess>().single().opens)
        val c = p.shower.closed()!!
        assertEquals(HANDSHAKE_FAILED, c.code)
        assertFalse(c.byPeer)
        assertTrue(p.shower.out.isEmpty())
        assertTrue(p.shower.of<SessionEvent.Established>().isEmpty())
        assertTrue(p.shower.of<SessionEvent.LocalLinked>().isEmpty())
    }

    @Test
    fun neverTriesTheTagWithoutAPermitOrPast30SecondsAndTriesItOnceWithOne() = runBlocking {
        for (p in listOf(pairSides(permit = { false }), pairSides(showerElapsed = 30.0))) {
            p.joiner.s.start()
            pump(p.joiner, p.shower)
            assertTrue(p.shower.of<SessionEvent.Guess>().isEmpty())
            assertEquals(HANDSHAKE_FAILED, p.shower.closed()!!.code)
        }
        val asked = AtomicInteger()
        val p = pairSides(permit = { asked.incrementAndGet() > 0 })
        p.joiner.s.start()
        pump(p.joiner, p.shower)
        assertEquals(1, asked.get())
    }

    @Test
    fun refusesAModeQResponderWithoutAPermitAndAPairingWithoutValidSizes() {
        val (_, s) = cpace("123456", "123456")
        assertThrows(IllegalArgumentException::class.java) {
            Side(PeerMode.q, NoiseRole.responder, rnd(), pair = PairingOptions(s.psk, s.isk, 0, emptyList(), null, 0.0))
        }
        assertThrows(IllegalArgumentException::class.java) {
            Side(PeerMode.q, NoiseRole.responder, rnd(), pair = PairingOptions(ByteArray(31), s.isk, 0, emptyList(), null, 0.0) { true })
        }
        assertThrows(IllegalArgumentException::class.java) {
            Side(PeerMode.q, NoiseRole.responder, rnd(), pair = PairingOptions(s.psk, s.isk, 0, emptyList(), null, -1.0) { true })
        }
        assertThrows(IllegalArgumentException::class.java) { Side(PeerMode.q, NoiseRole.responder, rnd()) }
    }

    @Test
    fun aDeclineClosesBothSidesPeerByeAndStoresNothing() {
        val p = settle(pairSides(), decline = true)
        assertEquals("peer_bye", p.shower.closed()!!.code)
        assertFalse(p.shower.closed()!!.byPeer)
        assertEquals("peer_bye", p.joiner.closed()!!.code)
        assertTrue(p.joiner.closed()!!.byPeer)
        assertTrue(p.joiner.of<SessionEvent.LocalLinked>().isEmpty())
        assertTrue(p.shower.of<SessionEvent.LocalLinked>().isEmpty())
    }

    @Test
    fun aSideThatHoldsTheMostLinksRefusesAValidLocalLinkAndStoresNothing() {
        val p = settle(pairSides(showerHeld = MAX_LOCAL_LINKS))
        assertTrue(p.shower.of<SessionEvent.LocalLinked>().isEmpty())
        assertEquals("peer_not_allowed", p.shower.closed()!!.code)
    }

    @Test
    fun ownsEveryRecordTheHostCannotSendOne() = runBlocking<Unit> {
        val p = pairSides()
        assertThrows(IllegalStateException::class.java) { runBlocking { p.joiner.s.sendRecord(0x0100, utf8("{}")) } }
        p.joiner.s.start()
        pump(p.joiner, p.shower)
        p.joiner.s.confirmPairing()
        assertThrows(IllegalArgumentException::class.java) { runBlocking { p.joiner.s.sendRecord(0x0100, utf8("{}")) } }
    }

    @Test
    fun aPeerWithoutLocalCapClosesTheSessionBeforeAnyConsent() = runBlocking {
        val (j, s) = cpace("123456", "123456")
        val shower = Side(
            PeerMode.q, NoiseRole.responder, rnd(),
            pair = PairingOptions(s.psk, s.isk, 0, emptyList(), "Bo", 0.0) { true },
        )
        val raw = NoiseHandshake(
            NoiseHandshakeOptions(
                NoiseRole.initiator, peerNoiseProtocol(PeerMode.q), peerPrologue("djdl", PeerMode.q), j.psk, RawNoiseStatic(rnd()),
            ),
        )
        shower.s.receive(raw.writeMessage(utf8("{\"v\":1}")))
        raw.readMessage(shower.out.removeAt(0))
        shower.s.receive(raw.writeMessage(utf8("{\"v\":1,\"caps\":[]}")))
        val tp = raw.transport()
        val hello = encodeRecord(PeerRecord(RecordType.HELLO, 0, utf8("{\"platform\":\"test\",\"app\":\"demo\",\"maxMessage\":1048576}")))
        shower.s.receive(tp.send.encrypt(ByteArray(0), hello))
        assertTrue(shower.of<SessionEvent.Established>().isEmpty())
        assertEquals("peer_not_allowed", shower.closed()!!.code)
        // The CLOSE record names the code (after the session's own HELLO).
        val types = shower.out.map { parseRecord(tp.receive.decrypt(ByteArray(0), it))!!.type }
        assertEquals(listOf(RecordType.HELLO, RecordType.CLOSE), types)
    }

    // -- mode l under the link a pairing made --------------------------------------------------------

    private class Keys(val a: ByteArray, val b: ByteArray, val aPub: ByteArray, val bPub: ByteArray)

    private fun keys(): Keys {
        val a = rnd()
        val b = rnd()
        return Keys(a, b, pub(a), pub(b))
    }

    private fun link(secret: ByteArray, own: ByteArray, peer: ByteArray) = LocalLink(secret, own, peer)

    private fun linkSecret(): ByteArray = pairUp().joiner.of<SessionEvent.LocalLinked>().single().secret

    @Test
    fun modeLOpensASessionAndCarriesRecordsAndNeverThePairingRecords() = runBlocking {
        val secret = linkSecret()
        val k = keys()
        val initiator = Side(PeerMode.l, NoiseRole.initiator, locals = listOf(link(secret.copyOf(), k.a, k.bPub)))
        val decoy = link(rnd(), rnd(), rnd())
        val responder = Side(PeerMode.l, NoiseRole.responder, locals = listOf(decoy, link(secret.copyOf(), k.b, k.aPub)), limiter = HandshakeLimiter())
        initiator.s.start()
        pump(initiator, responder)
        val ei = initiator.of<SessionEvent.Established>().single()
        val er = responder.of<SessionEvent.Established>().single()
        assertEquals(0, ei.localIndex)
        assertEquals(1, er.localIndex)
        assertFalse(ei.helloAuthenticated)
        assertArrayEquals(k.aPub, er.remoteStatic)
        initiator.s.sendRecord(0x0100, utf8("hi"))
        pump(initiator, responder)
        assertEquals(0x0100, responder.of<SessionEvent.Record>().single().recordType)
        // A pairing record in mode l is refused by the peer.
        initiator.s.sendRecord(RecordType.CONFIRM, utf8("{}"))
        pump(initiator, responder)
        assertEquals("peer_not_allowed", responder.closed()!!.code)
    }

    @Test
    fun aPeerKeyThatIsNotTheStoredOneEndsTheSessionPeerRevokedAndSendsNothing() = runBlocking {
        val secret = linkSecret()
        val k = keys()
        val other = keys()
        val initiator = Side(PeerMode.l, NoiseRole.initiator, locals = listOf(link(secret.copyOf(), k.a, other.aPub)))
        val responder = Side(PeerMode.l, NoiseRole.responder, locals = listOf(link(secret.copyOf(), k.b, k.aPub)), limiter = HandshakeLimiter())
        initiator.s.start()
        pump(initiator, responder)
        assertEquals("peer_revoked", initiator.closed()!!.code)
        assertTrue(initiator.of<SessionEvent.Established>().isEmpty())
    }

    @Test
    fun anotherLinksSecretOpensNothingTheResponderClosesSilently() = runBlocking {
        val k = keys()
        val initiator = Side(PeerMode.l, NoiseRole.initiator, locals = listOf(link(rnd(), k.a, k.bPub)))
        val responder = Side(PeerMode.l, NoiseRole.responder, locals = listOf(link(rnd(), k.b, k.aPub)), limiter = HandshakeLimiter())
        initiator.s.start()
        pump(initiator, responder)
        assertEquals(HANDSHAKE_FAILED, responder.closed()!!.code)
        assertTrue(responder.out.isEmpty())
    }

    @Test
    fun theSharedListenerTriesLocalLinksAfterItsContactsBehindTheLimiter() = runBlocking {
        val secret = linkSecret()
        val k = keys()
        val locals = (0 until 2).map { link(rnd(), rnd(), rnd()) }
        val mine = link(secret.copyOf(), k.b, k.aPub)

        fun listener(limiter: HandshakeLimiter) = Side(
            PeerMode.c, NoiseRole.responder, rnd(),
            contacts = listOf(ContactLink(rnd(), "x".repeat(43))), locals = locals + mine, limiter = limiter,
        )

        fun initiator() = Side(PeerMode.l, NoiseRole.initiator, locals = listOf(link(secret.copyOf(), k.a, k.bPub)))
        val ok = listener(HandshakeLimiter())
        val i1 = initiator()
        i1.s.start()
        pump(i1, ok)
        assertEquals(2, ok.of<SessionEvent.Established>().single().localIndex)

        val busy = listener(HandshakeLimiter(0))
        val i2 = initiator()
        i2.s.start()
        pump(i2, busy)
        assertEquals("peer_busy", busy.closed()!!.code)
        assertTrue(busy.of<SessionEvent.Established>().isEmpty())
    }

    // -- a listener with no account key: the source group's budget first (section 15.10) -------------

    private class Attempted(val responder: Side, val tries: AtomicInteger)

    /** One initiator holding a link that the responder either holds ([opens]) or does not. */
    private fun attempt(limiter: HandshakeLimiter, group: String?, opens: Boolean): Attempted = runBlocking {
        val k = keys()
        val secret = rnd()
        val initiator = Side(PeerMode.l, NoiseRole.initiator, locals = listOf(link(secret.copyOf(), k.a, k.bPub)))
        val tries = AtomicInteger()
        val counting = object : NoiseAead {
            override fun seal(key: ByteArray, nonce: ByteArray, aad: ByteArray, plaintext: ByteArray) = JcaNoiseAead.seal(key, nonce, aad, plaintext)

            override fun open(key: ByteArray, nonce: ByteArray, aad: ByteArray, ciphertext: ByteArray): ByteArray? {
                tries.incrementAndGet()
                return JcaNoiseAead.open(key, nonce, aad, ciphertext)
            }
        }
        val responder = Side(
            PeerMode.l, NoiseRole.responder,
            locals = listOf(link(if (opens) secret.copyOf() else rnd(), k.b, k.aPub)),
            limiter = limiter, group = group, ports = NoisePorts(aead = counting),
        )
        initiator.s.start()
        pump(initiator, responder)
        Attempted(responder, tries)
    }

    private class Clock {
        @Volatile var t = 0.0
    }

    private fun clocked(): Pair<Clock, HandshakeLimiter> {
        val c = Clock()
        return c to HandshakeLimiter(5, 4) { c.t }
    }

    @Test
    fun aGroupThatSentTwoMessage1sIsRefusedTheThirdBeforeAnySecretIsTriedAnotherGroupIsNot() {
        val (c, limiter) = clocked()
        for (t in listOf(0.0, 1.0)) {
            c.t = t
            assertEquals(HANDSHAKE_FAILED, attempt(limiter, "g1", false).responder.closed()!!.code)
        }
        c.t = 2.0
        val third = attempt(limiter, "g1", true)
        assertEquals("peer_busy", third.responder.closed()!!.code)
        assertEquals(0, third.tries.get())
        assertEquals(1, attempt(limiter, "g2", true).responder.of<SessionEvent.Established>().size)
        // The window slides: a minute on, the group is heard again.
        c.t = 70.0
        assertEquals(1, attempt(limiter, "g1", true).responder.of<SessionEvent.Established>().size)
    }

    @Test
    fun aTrialThatOpensIsNotCountedAgainstTheGroupAndOnlyAFailedTrialSpendsTheSharedBudget() {
        val (c, limiter) = clocked()
        // Three opening attempts from one group inside a minute (a group allows two failures).
        for (i in 0 until 3) {
            c.t = i.toDouble()
            assertEquals(1, attempt(limiter, "g1", true).responder.of<SessionEvent.Established>().size)
        }
        // Five groups, one failure each, use the shared budget; a sixth is refused behind it.
        for (i in 0 until 5) {
            c.t = 10.0 + i
            assertEquals(HANDSHAKE_FAILED, attempt(limiter, "f$i", false).responder.closed()!!.code)
        }
        c.t = 20.0
        val six = attempt(limiter, "f5", true)
        assertEquals("peer_busy", six.responder.closed()!!.code)
        assertEquals(0, six.tries.get())
    }

    @Test
    fun oneGroupCanUseTwoOfTheSharedFiveNotAllOfIt() {
        val (c, limiter) = clocked()
        for (i in 0 until 6) {
            c.t = i.toDouble()
            attempt(limiter, "noisy", false)
        }
        c.t = 7.0
        assertEquals(1, attempt(limiter, "quiet", true).responder.of<SessionEvent.Established>().size)
    }

    @Test
    fun withoutAGroupTheSharedLimiterCountsTheAttemptAsBefore() {
        val (c, limiter) = clocked()
        for (i in 0 until 5) {
            c.t = i.toDouble()
            attempt(limiter, null, true)
        }
        c.t = 6.0
        assertEquals("peer_busy", attempt(limiter, null, true).responder.closed()!!.code)
    }

    @Test
    fun aMissCountsOnlyTheRealTrialsOnTheHostsPorts() {
        // The dummy trials that pad a miss to TRIAL_TOTAL run on the default ports, so a host's own ports see one trial here.
        val (_, limiter) = clocked()
        assertEquals(1, attempt(limiter, "a", false).tries.get())
    }

    @Test
    fun refusesConstructionsThatNameNoLinkTooManyLinksOrNoLimiter() {
        val l = link(rnd(), rnd(), rnd())
        assertThrows(IllegalArgumentException::class.java) { Side(PeerMode.l, NoiseRole.initiator) }
        assertThrows(IllegalArgumentException::class.java) { Side(PeerMode.l, NoiseRole.initiator, locals = listOf(l, l)) }
        assertThrows(IllegalArgumentException::class.java) { Side(PeerMode.l, NoiseRole.responder, locals = listOf(l)) }
        assertThrows(IllegalArgumentException::class.java) {
            Side(PeerMode.l, NoiseRole.responder, locals = List(MAX_LOCAL_LINKS + 1) { l }, limiter = HandshakeLimiter())
        }
        assertThrows(IllegalArgumentException::class.java) { Side(PeerMode.l, NoiseRole.initiator, locals = listOf(LocalLink(ByteArray(31), rnd(), rnd()))) }
    }
}
