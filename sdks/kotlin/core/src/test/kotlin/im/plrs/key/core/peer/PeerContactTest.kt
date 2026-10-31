// @pkey-feature connect.links
//
// Inter-account links in :core (WIRE-CONTRACT-V5 section 15.10): two real `PeerChannel`s pair in mode p with
// the contact exchange, then meet in mode c under the secret they derived; the pin, the shared listener's
// trial order and the exchange guards. The corpus `contact` rows run in :conformance (`PeerMatrixContactTest`).
// Mirrors client-core's `peerContact.test.ts` and `peerListener.test.ts`.

package im.plrs.key.core.peer

import im.plrs.key.core.Base64Url
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.SecureRandom

class PeerContactTest {
    private val rng = SecureRandom()

    private fun rnd(): ByteArray = ByteArray(32).also { rng.nextBytes(it) }

    private fun key(b: ByteArray): String = Base64Url.encode(b)

    private inner class Side(
        mode: PeerMode,
        role: NoiseRole,
        priv: ByteArray = rnd(),
        contacts: List<ContactLink> = emptyList(),
        exchange: ContactOffer? = null,
        limiter: HandshakeLimiter? = if (role == NoiseRole.responder && mode != PeerMode.a) HandshakeLimiter() else null,
    ) {
        val events = ArrayList<SessionEvent>()
        val out = ArrayList<ByteArray>()
        var clock = 0.0
        val pub: ByteArray = runBlocking { RawNoiseStatic(priv).publicKey() }
        val s = PeerChannel(
            role, "djdl", RawNoiseStatic(priv), null, HelloInfo("test", "demo", "Anna"),
            { out.add(it) }, { events.add(it) },
            caps = listOf("app/1"), mono = { clock }, mode = mode, admission = limiter,
            contacts = contacts, exchange = exchange,
        )

        inline fun <reified T : SessionEvent> of(): List<T> = events.filterIsInstance<T>()

        fun closed(): List<SessionEvent.Closed> = of<SessionEvent.Closed>()
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

    private class Paired(
        val secretA: ByteArray,
        val secretB: ByteArray,
        val privA: ByteArray,
        val privB: ByteArray,
        val pubA: ByteArray,
        val pubB: ByteArray,
    )

    private fun pair(
        catsA: List<String> = listOf("docs"),
        catsB: List<String> = listOf("docs", "photos"),
        heldA: List<String> = emptyList(),
    ): Paired = runBlocking {
        val privA = rnd()
        val privB = rnd()
        val pubA = RawNoiseStatic(privA).publicKey()
        val pubB = RawNoiseStatic(privB).publicKey()
        val d = Side(PeerMode.p, NoiseRole.initiator, exchange = ContactOffer(key(pubA), heldA, "Ana", catsA))
        val m = Side(PeerMode.p, NoiseRole.responder, exchange = ContactOffer(key(pubB), emptyList(), "Ben", catsB))
        d.s.start()
        pump(d, m)
        d.s.confirmSas()
        m.s.confirmSas()
        pump(d, m)
        val cd = d.of<SessionEvent.Contact>().single()
        val cm = m.of<SessionEvent.Contact>().single()
        assertArrayEquals("both sides derive the same secret", cd.secret, cm.secret)
        assertEquals(key(pubB), cd.body.agreeKey)
        assertEquals("Ben", cd.body.label)
        assertEquals(key(pubA), cm.body.agreeKey)
        assertFalse(cd.pending)
        Paired(cd.secret, cm.secret, privA, privB, pubA, pubB)
    }

    @Test
    fun pairingThenModeC() = runBlocking {
        val p = pair()
        val a = Side(PeerMode.c, NoiseRole.initiator, p.privA, listOf(ContactLink(p.secretA, key(p.pubB))))
        val b = Side(PeerMode.c, NoiseRole.responder, p.privB, listOf(ContactLink(p.secretB, key(p.pubA))))
        a.s.start()
        pump(a, b)
        val ea = a.of<SessionEvent.Established>().single()
        val eb = b.of<SessionEvent.Established>().single()
        assertEquals(0, ea.contactIndex)
        assertEquals(0, eb.contactIndex)
        assertFalse(ea.helloAuthenticated)
        assertFalse(eb.helloAuthenticated)
        assertNull(ea.peerDeviceId)
        a.s.sendRecord(0x0100, "hi".toByteArray())
        pump(a, b)
        assertEquals(listOf(0x0100), b.of<SessionEvent.Record>().map { it.recordType })
    }

    @Test
    fun thePinRefusesAWrongKeyAndSendsNothing() = runBlocking {
        val p = pair()
        val a = Side(PeerMode.c, NoiseRole.initiator, p.privA, listOf(ContactLink(p.secretA, key(rnd()))))
        val b = Side(PeerMode.c, NoiseRole.responder, p.privB, listOf(ContactLink(p.secretB, key(p.pubA))))
        a.s.start()
        pump(a, b)
        assertEquals("peer_revoked", a.closed().first().code)
        assertTrue(a.of<SessionEvent.Established>().isEmpty())
        assertTrue(b.of<SessionEvent.Established>().isEmpty())
    }

    @Test
    fun theResponderPicksTheRightSecretAmongMany() = runBlocking {
        val p = pair()
        val others = (0 until 5).map { ContactLink(rnd(), key(rnd())) }
        val b = Side(PeerMode.c, NoiseRole.responder, p.privB, others + ContactLink(p.secretB, key(p.pubA)))
        val a = Side(PeerMode.c, NoiseRole.initiator, p.privA, listOf(ContactLink(p.secretA, key(p.pubB))))
        a.s.start()
        pump(a, b)
        assertEquals(5, b.of<SessionEvent.Established>().single().contactIndex)
    }

    @Test
    fun aRePairOfAHeldPeerIsPending() = runBlocking {
        val privB = rnd()
        val privA = rnd()
        val pubB = RawNoiseStatic(privB).publicKey()
        val pubA = RawNoiseStatic(privA).publicKey()
        val d = Side(PeerMode.p, NoiseRole.initiator, exchange = ContactOffer(key(pubA), listOf(key(pubB)), null, emptyList()))
        val m = Side(PeerMode.p, NoiseRole.responder, exchange = ContactOffer(key(pubB), emptyList(), null, emptyList()))
        d.s.start()
        pump(d, m)
        d.s.confirmSas()
        m.s.confirmSas()
        pump(d, m)
        assertTrue(d.of<SessionEvent.Contact>().single().pending)
        assertFalse(m.of<SessionEvent.Contact>().single().pending)
    }

    @Test
    fun aContactBeforeOwnConfirmClosesBadFrame() = runBlocking {
        val pubA = RawNoiseStatic(rnd()).publicKey()
        val d = Side(PeerMode.p, NoiseRole.initiator, exchange = ContactOffer(key(pubA), emptyList(), null, emptyList()))
        val m = Side(PeerMode.p, NoiseRole.responder)
        d.s.start()
        pump(d, m)
        // The peer is a plain host: it confirms and sends CONTACT before d's person confirmed.
        m.s.confirmSas()
        m.s.sendRecord(RecordType.CONTACT, buildContact(key(rnd()), null, emptyList()))
        pump(d, m)
        assertEquals("peer_bad_frame", d.closed().first().code)
        assertTrue(d.of<SessionEvent.Contact>().isEmpty())
    }

    @Test
    fun theExchangeTimesOutAfterThirtySeconds() = runBlocking {
        val pubA = RawNoiseStatic(rnd()).publicKey()
        val d = Side(PeerMode.p, NoiseRole.initiator, exchange = ContactOffer(key(pubA), emptyList(), null, emptyList()))
        val m = Side(PeerMode.p, NoiseRole.responder)
        d.s.start()
        pump(d, m)
        d.s.confirmSas()
        d.clock += CONTACT_EXCHANGE_SECONDS + 1
        d.s.tick()
        assertEquals("peer_timeout", d.closed().first().code)
    }

    @Test
    fun aContactResponderTakesALimiterSlotUntilMessageThree() = runBlocking {
        val p = pair()
        val lim = HandshakeLimiter(maxPerMinute = 99, maxPending = 1)
        val b = Side(PeerMode.c, NoiseRole.responder, p.privB, listOf(ContactLink(p.secretB, key(p.pubA))), limiter = lim)
        val a = Side(PeerMode.c, NoiseRole.initiator, p.privA, listOf(ContactLink(p.secretA, key(p.pubB))))
        a.s.start()
        // Message 1 only: the slot is held.
        for (m in ArrayList(a.out)) b.s.receive(m)
        a.out.clear()
        assertNull("the slot is taken", lim.begin())
        for (m in ArrayList(b.out)) a.s.receive(m)
        b.out.clear()
        pump(a, b)
        assertNotNull("the slot is free once the session is open", lim.begin())
    }

    @Test
    fun theLimiterRefusesBeforeAnyContactSecretIsTried() = runBlocking {
        val p = pair()
        val lim = HandshakeLimiter(maxPerMinute = 0, maxPending = 4)
        val b = Side(PeerMode.c, NoiseRole.responder, p.privB, listOf(ContactLink(p.secretB, key(p.pubA))), limiter = lim)
        val a = Side(PeerMode.c, NoiseRole.initiator, p.privA, listOf(ContactLink(p.secretA, key(p.pubB))))
        a.s.start()
        pump(a, b)
        assertEquals("peer_busy", b.closed().first().code)
        assertTrue(b.out.isEmpty())
    }

    @Test
    fun theContactHelpersAgreeWithThemselves() {
        val p = pair()
        val rid = contactRid(p.secretA)
        assertEquals(22, rid.length)
        assertEquals(rid, contactRid(p.secretB))
        val devA = Base64Url.encode(ByteArray(24) { 1 })
        val devB = Base64Url.encode(ByteArray(24) { 2 })
        assertFalse(contactAlias(rid, devA).contentEquals(contactAlias(rid, devB)))
        assertEquals(rid, parseContactTicketBody(contactTicketBody(rid).toByteArray()))
        val name = contactInstance(p.secretA, p.pubB, 100)
        assertTrue(isInstanceName(name))
        // The two devices of a link publish different names (the advertiser's key is in the MAC).
        assertFalse(name == contactInstance(p.secretA, p.pubA, 100))
        assertEquals(listOf("docs"), contactCategories(listOf("docs"), listOf("photos", "docs")))
    }
}
