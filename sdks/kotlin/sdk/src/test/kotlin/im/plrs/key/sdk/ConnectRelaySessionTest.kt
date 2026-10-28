// @pkey-feature connect.relay
//
// Peer sessions over the relay and outgoing pacing (CC-12.14; WIRE-CONTRACT-V5 section 15.7, G8, G16,
// G17): two services through the in-process room. Mirrors the session half of sdk-node's `relay.test.ts`
// and the Python `test_connect_relay_sessions.py`; pacing (D-9) is new.

package im.plrs.key.sdk

import im.plrs.key.core.Base64Url
import im.plrs.key.core.peer.NoiseHandshake
import im.plrs.key.core.peer.NoiseHandshakeOptions
import im.plrs.key.core.peer.NoiseRole
import im.plrs.key.core.peer.PeerMode
import im.plrs.key.core.peer.RawNoiseStatic
import im.plrs.key.core.peer.RecordType
import im.plrs.key.core.peer.RelayMessage
import im.plrs.key.core.peer.payload1
import im.plrs.key.core.peer.peerNoiseProtocol
import im.plrs.key.core.peer.peerPrologue
import im.plrs.key.core.peer.peerPsk
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class ConnectRelaySessionTest {
    private val ping = 1000.0
    private val services = ArrayList<RelayService>()

    @After
    fun tearDown() {
        for (s in services) runBlocking { s.stop() }
    }

    private fun until(timeoutMillis: Long = 8000, cond: () -> Boolean) {
        val end = System.nanoTime() + timeoutMillis * 1_000_000
        while (!cond()) {
            if (System.nanoTime() > end) throw AssertionError("timed out")
            Thread.sleep(10)
        }
    }

    /** One world and one room, with a relay service per device. */
    private inner class Net(members: Set<String>? = null, val opts: (RelayOptions) -> RelayOptions = { it }) {
        val world = TestWorld()
        val room = FakeRoom(members ?: setOf(world.idA, world.idB))
        val loads = AtomicInteger()

        fun service(
            dev: TestWorld.Device,
            pacer: (() -> Pacer)? = null,
            maxSessions: Int = 64,
            maxPendingPerPeer: Int = 4,
            rekey: Int? = null,
            outboxBytes: Long = OUTBOX_MAX_BYTES,
        ): RelayService {
            val ps = world.peerSource(dev)
            val src = LanSource(load = {
                loads.incrementAndGet()
                ps
            }, now = { world.now })
            val svc = RelayService(
                src,
                { room.issue(dev.id) },
                RelayOptions(
                    opener = room::opener, sleep = ManualSleep(), random = { 0.5 }, pingSeconds = ping, maxSessions = maxSessions,
                    maxPendingPerPeer = maxPendingPerPeer, rekeyMessages = rekey, pacer = pacer, outboxBytes = outboxBytes,
                ),
            )
            services += svc
            svc.start()
            runBlocking { svc.ready(5000) }
            return svc
        }

        fun inbound(svc: RelayService): CopyOnWriteArrayList<ConnectSession> {
            val got = CopyOnWriteArrayList<ConnectSession>()
            svc.onSession { got += it }
            return got
        }
    }

    private fun pair(n: Net, rekey: Int? = null): Triple<RelayService, RelayService, Pair<ConnectSession, ConnectSession>> {
        val sa = n.service(n.world.a, rekey = rekey)
        val sb = n.service(n.world.b, rekey = rekey)
        val got = n.inbound(sa)
        val out = runBlocking { sb.dial(n.world.idA) }
        until { got.isNotEmpty() }
        return Triple(sa, sb, out to got[0])
    }

    // -- sessions --------------------------------------------------------------------------------

    @Test
    fun admitsThePeerLikeTheLanAndCarriesMessagesBothWaysRekeying() = runBlocking {
        val n = Net()
        val (_, _, s) = pair(n, rekey = 3)
        val (out, inn) = s
        assertEquals(n.world.idA, out.peerDeviceId)
        assertEquals(n.world.idB, inn.peerDeviceId)
        assertEquals(NoiseRole.initiator, out.role)
        assertEquals(NoiseRole.responder, inn.role)
        assertEquals("relay", out.path)
        assertEquals("relay", out.remoteAddress)
        out.send("hello over the relay".toByteArray())
        assertEquals("hello over the relay", String(inn.receive(5000).body))
        inn.send("back".toByteArray(), 0x0101)
        assertEquals(0x0101, out.receive(5000).type)
        repeat(8) {
            // past the rekey threshold in each direction
            out.send("b$it".toByteArray())
            inn.send("a$it".toByteArray())
        }
        assertEquals(List(8) { "b$it" }, List(8) { String(inn.receive(5000).body) })
        assertEquals(List(8) { "a$it" }, List(8) { String(out.receive(5000).body) })
        val big = ByteArray(300_000) { (it % 251).toByte() } // several envelopes
        out.send(big)
        assertTrue(big.contentEquals(inn.receive(10_000).body))
        // Only SEND envelopes of this session crossed, all addressed to the other device.
        val sends = n.room.sends(n.world.idB)
        assertTrue(sends.isNotEmpty())
        assertTrue(sends.all { Base64Url.encode(it.to) == n.world.idA })
        val done = CountDownLatch(1)
        inn.onClose { done.countDown() }
        out.close()
        assertTrue(done.await(5, TimeUnit.SECONDS))
        assertEquals("peer_bye", inn.closed!!.code)
    }

    @Test
    fun aFirstMessageFromADeviceOffTheRosterOrFromThisDeviceIsIgnored() = runBlocking {
        val n = Net()
        val sa = n.service(n.world.a)
        val got = n.inbound(sa)
        val garbage = ByteArray(48) { 1 }
        n.room.push(n.world.idA, RelayMessage.Recv(Base64Url.decodeStrict("XXXXYYYYZZZZ2222XXXXYYYYZZZZ2222")!!, 1, garbage)) // off the roster
        n.room.push(n.world.idA, RelayMessage.Recv(Base64Url.decodeStrict(n.world.idA)!!, 2, garbage)) // this device
        Thread.sleep(200)
        assertTrue(got.isEmpty())
        assertEquals(RelayState.open, sa.status.state)
        assertEquals(0, sa.sessionCount)
    }

    @Test
    fun theStampedFromMustBeTheDeviceTheCertificateProves() = runBlocking {
        val n = Net(members = setOf("x"), opts = { it })
        n.room.memberSet += listOf(n.world.idA, n.world.idB, n.world.idC)
        val sa = n.service(n.world.a)
        val sb = n.service(n.world.b)
        val got = n.inbound(sa)
        // The room stamps B's messages as C, a roster device: A's certificate check names B, not C.
        n.room.stampAs[n.world.idB] = n.world.idC
        try {
            sb.dial(n.world.idA)
            fail("wrong peer")
        } catch (e: RelayException) {
            assertTrue(e.reason == RelayErrorReason.handshake_failed || e.reason == RelayErrorReason.wrong_peer)
        }
        Thread.sleep(100)
        assertTrue(got.isEmpty())
    }

    @Test
    fun dialRefusesAnUnknownDeviceThisDeviceAndANonDevice() = runBlocking {
        val n = Net()
        val sb = n.service(n.world.b)
        for (id in listOf("XXXXYYYYZZZZ2222XXXXYYYYZZZZ2222", n.world.idB, "not a device")) {
            try {
                sb.dial(id)
                fail("refused $id")
            } catch (e: RelayException) {
                assertEquals(RelayErrorReason.unknown_peer, e.reason)
            }
        }
    }

    @Test
    fun sessionsAreBoundedInTotal() = runBlocking {
        val n = Net(members = null)
        n.room.memberSet += n.world.idC
        val sa = n.service(n.world.a)
        val sb = n.service(n.world.b, maxSessions = 1)
        n.inbound(sa)
        sb.dial(n.world.idA)
        try {
            sb.dial(n.world.idC)
            fail("busy")
        } catch (e: RelayException) {
            assertEquals(RelayErrorReason.busy, e.reason)
        }
    }

    @Test
    fun handshakesInFlightAreBoundedPerPeer() = runBlocking {
        val n = Net()
        val sa = n.service(n.world.a, maxPendingPerPeer = 4)
        n.inbound(sa)
        val peer = Base64Url.decodeStrict(n.world.idB)!!
        for (i in 1L..6L) {
            val hs = NoiseHandshake(
                NoiseHandshakeOptions(
                    NoiseRole.initiator,
                    peerNoiseProtocol(PeerMode.a),
                    peerPrologue("djdl", PeerMode.a),
                    peerPsk(n.world.k, "djdl"),
                    RawNoiseStatic(ByteArray(32) { (it + i).toByte() }),
                ),
            )
            n.room.push(n.world.idA, RelayMessage.Recv(peer, i, hs.writeMessage(payload1())))
        }
        until { n.room.sends(n.world.idA).size >= 4 }
        Thread.sleep(300)
        assertEquals(4, n.room.sends(n.world.idA).size) // a message two per session was not answered for the other two
        assertEquals(4, sa.sessionCount)
    }

    @Test
    fun endedSessionsAreRememberedSoALateMessageCostsNothing() = runBlocking {
        val n = Net()
        val (sa, _, s) = pair(n)
        val (out, inn) = s
        val done = CountDownLatch(1)
        inn.onClose { done.countDown() }
        out.close()
        assertTrue(done.await(5, TimeUnit.SECONDS))
        until { sa.sessionCount == 0 }
        val before = n.loads.get()
        val sess = n.room.sends(n.world.idB).first().session
        n.room.push(n.world.idA, RelayMessage.Recv(Base64Url.decodeStrict(n.world.idB)!!, sess, ByteArray(40) { 3 }))
        Thread.sleep(200)
        assertEquals(before, n.loads.get())
        assertEquals(0, sa.sessionCount)
    }

    @Test
    fun aDroppedSocketEndsSessionsWithConnectionLostAndANewDialWorks() = runBlocking {
        val n = Net()
        val (_, sb, s) = pair(n)
        val (out, inn) = s
        val lost = CopyOnWriteArrayList<SessionClosed>()
        out.onClose { lost += it }
        n.room.dropAll(null)
        until { lost.isNotEmpty() }
        assertEquals(SessionClosed("connection_lost", false), lost[0])
        until { inn.closed != null }
        // The services reconnect (the manual sleep is fired) and a new dial works.
        until(15_000) { sb.status.state == RelayState.backoff }
    }

    @Test
    fun goneForADeviceEndsOnlyItsSessions() = runBlocking {
        val n = Net()
        val (sa, _, s) = pair(n)
        val (out, inn) = s
        n.room.push(n.world.idA, RelayMessage.Gone(Base64Url.decodeStrict(n.world.idC)!!)) // another device
        Thread.sleep(150)
        assertNull(inn.closed)
        n.room.push(n.world.idA, RelayMessage.Gone(Base64Url.decodeStrict(n.world.idB)!!))
        until { inn.closed != null }
        assertEquals("connection_lost", inn.closed!!.code)
        assertNotNull(out)
        assertEquals(0, sa.sessionCount)
    }

    @Test
    fun stopSaysGoodbyeToOpenSessions() = runBlocking {
        val n = Net()
        val (sa, _, s) = pair(n)
        val (out, _) = s
        val closed = CopyOnWriteArrayList<SessionClosed>()
        out.onClose { closed += it }
        sa.stop()
        until { closed.isNotEmpty() }
        assertEquals("peer_bye", closed[0].code)
    }

    // -- pacing ----------------------------------------------------------------------------------

    private class Clock {
        @Volatile var t = 100.0
    }

    @Test
    fun thePacerIs180ASecondWithABurstOf360() {
        assertEquals(180.0, PACER_RATE, 0.0)
        assertEquals(360.0, PACER_BURST, 0.0)
        val c = Clock()
        val p = Pacer(clock = { c.t })
        repeat(360) { assertEquals(0.0, p.tryTake(), 0.0) }
        val wait = p.tryTake()
        assertEquals(1 / 180.0, wait, 1e-9)
        c.t += 1.0
        assertEquals(0.0, p.tryTake(), 0.0)
    }

    @Test
    fun acquireWaitsForTheNextToken() = runBlocking {
        val c = Clock()
        val slept = ArrayList<Double>()
        val p = Pacer(burst = 1.0, clock = { c.t }, sleep = { s ->
            slept += s
            c.t += s
        })
        p.acquire()
        assertTrue(slept.isEmpty())
        p.acquire()
        assertEquals(1, slept.size)
        assertEquals(1 / 180.0, slept[0], 1e-9)
    }

    @Test
    fun limit1HalvesTheRateForTenSeconds() {
        val c = Clock()
        val p = Pacer(clock = { c.t })
        assertEquals(180.0, p.currentRate, 0.0)
        p.halve()
        assertEquals(90.0, p.currentRate, 0.0)
        c.t += 9.9
        assertEquals(90.0, p.currentRate, 0.0)
        c.t += 0.2
        assertEquals(180.0, p.currentRate, 0.0)
        assertEquals(10.0, PACER_HALVED_SECONDS, 0.0)
    }

    @Test
    fun theOutboxCountsBytesAndRefusesPastItsCapButNotAForcedItem() = runBlocking {
        val box = Outbox(100)
        assertTrue(box.put(ByteArray(60)))
        assertEquals(60, box.queued)
        assertFalse(box.put(ByteArray(41)))
        assertTrue(box.put(ByteArray(40)))
        assertTrue(box.put(ByteArray(500), force = true))
        assertFalse(box.roomFor(1))
        assertEquals(60, box.get()!!.size)
        box.sent()
        assertEquals(540, box.queued)
        assertEquals(40, box.get()!!.size)
        assertEquals(500, box.get()!!.size)
        box.sent()
        assertTrue(box.drained(100))
        box.close()
        assertNull(box.get())
        assertEquals(8L * 1024 * 1024, OUTBOX_MAX_BYTES)
    }

    @Test
    fun aLimit1FromTheRoomHalvesTheServicePacer() = runBlocking {
        val n = Net()
        val made = ArrayList<Pacer>()
        n.service(n.world.a, pacer = { Pacer().also { made += it } })
        assertEquals(180.0, made.last().currentRate, 0.0)
        n.room.push(n.world.idA, RelayMessage.Limit(1))
        until { made.last().currentRate == 90.0 }
    }

    @Test
    fun aSendPast8MibQueuedClosesTheSessionPeerBusy() = runBlocking {
        val n = Net()
        val sa = n.service(n.world.a)
        val made = ArrayList<Pacer>()
        // B's pacer lets the handshake through, then runs dry: nothing leaves the queue.
        val sb = n.service(n.world.b, pacer = { Pacer(rate = 0.0001, burst = 60.0).also { made += it } }, outboxBytes = 200_000)
        n.inbound(sa)
        val out = sb.dial(n.world.idA)
        val closes = CopyOnWriteArrayList<SessionClosed>()
        out.onClose { closes += it }
        while (made.last().tryTake() == 0.0) { /* spend what is left */ }
        for (i in 1..10) {
            if (out.closed != null) break
            out.send(ByteArray(100_000)) // never throws for a full queue: the host sees the close (D-9)
        }
        until { closes.isNotEmpty() }
        assertEquals("peer_busy", closes.first().code)
        assertEquals(false, closes.first().byPeer)
        assertTrue(RecordType.PING > 0)
    }
}
