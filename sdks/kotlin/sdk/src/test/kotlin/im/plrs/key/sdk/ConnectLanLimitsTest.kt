// @pkey-feature connect.lan
//
// The LAN service's listener and dial bounds (CC-12.12, CC-IPV6.5b; WIRE-CONTRACT-V5 section 15.4.1): the
// caps on sockets that have not handshaken, the deadline, a source off the LAN, IPv6 and the fall-through
// after a failed handshake. Fixtures: [ConnectLanBase].

package im.plrs.key.sdk

import im.plrs.key.core.Base64Url
import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.DeviceKeyStore
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.jsonInt
import im.plrs.key.core.peer.ADVERT_EPOCH_SECONDS
import im.plrs.key.core.peer.accountInstance
import im.plrs.key.core.peer.advertEpoch
import im.plrs.key.core.peer.lan.LAN_MAX_PENDING
import im.plrs.key.core.peer.lan.LAN_MAX_PENDING_PER_ADDRESS
import im.plrs.key.core.peer.lan.MdnsAdapter
import im.plrs.key.core.peer.lan.MdnsAdvert
import im.plrs.key.core.peer.lan.MdnsFound
import im.plrs.key.core.peer.lan.MdnsHandle
import im.plrs.key.core.testing.TestSigner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.net.Socket
import java.security.SecureRandom
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class ConnectLanLimitsTest : ConnectLanBase() {
    // -- the listener's bounds ------------------------------------------------------------------

    @Test
    fun theLimitsAre32UnauthenticatedSocketsAnd4PerAddress() {
        assertEquals(32, LAN_MAX_PENDING)
        assertEquals(4, LAN_MAX_PENDING_PER_ADDRESS)
        val o = LanOptions()
        assertEquals(32, o.maxPending)
        assertEquals(4, o.maxPendingPerAddress)
        assertEquals(30.0, o.handshakeSeconds, 0.0)
    }

    @Test
    fun garbageAndOversizedAndEmptyFirstFramesCloseWithoutAWord() = runBlocking {
        val w = World()
        val la = w.start(w.a)
        val g = Raw(la.port)
        g.write(byteArrayOf(0, 48) + ByteArray(48) { 1 })
        assertTrue(g.closed.await(5, TimeUnit.SECONDS))
        assertEquals(0, g.received)
        val big = Raw(la.port)
        big.write(byteArrayOf(-1, -1) + ByteArray(65535) { 2 })
        assertTrue(big.closed.await(5, TimeUnit.SECONDS))
        assertEquals(0, big.received)
        val zero = Raw(la.port)
        zero.write(byteArrayOf(0, 0))
        assertTrue(zero.closed.await(5, TimeUnit.SECONDS))
        assertEquals(0, zero.received)
    }

    @Test
    fun socketsThatHaveNotHandshakenAreCappedPerAddress() = runBlocking {
        val w = World()
        val la = w.start(w.a, maxPendingPerAddress = 2)
        val socks = List(4) { Raw(la.port) }
        until { socks.count { it.isClosed } == 2 }
        Thread.sleep(100)
        assertEquals(2, socks.count { it.isClosed })
        assertTrue(socks.all { it.received == 0 })
        // A closed pending socket frees its slot.
        socks.first { !it.isClosed }.drop()
        until { la.pendingCount == 1 }
        val extra = Raw(la.port)
        Thread.sleep(200)
        assertFalse(extra.isClosed)
    }

    @Test
    fun socketsThatHaveNotHandshakenAreCappedInTotal() = runBlocking {
        val w = World()
        val la = w.start(w.a, maxPending = 3, maxPendingPerAddress = 50)
        val socks = List(5) { Raw(la.port) }
        until { socks.count { it.isClosed } == 2 }
        assertEquals(3, la.pendingCount)
    }

    @Test
    fun aSocketThatStallsInTheHandshakeIsDropped() = runBlocking {
        val w = World()
        val la = w.start(w.a, handshakeSeconds = 0.3)
        val s = Raw(la.port)
        assertTrue(s.closed.await(3, TimeUnit.SECONDS))
        assertEquals(0, s.received)
        until { la.pendingCount == 0 && la.pendingAddresses.isEmpty() }
    }

    @Test
    fun anAdmittedSessionStopsCountingAsPending() = runBlocking {
        val w = World()
        val la = w.start(w.a)
        val lb = w.start(w.b)
        pair(la, lb)
        until { la.pendingCount == 0 && la.pendingAddresses.isEmpty() }
    }

    @Test
    fun aSourceOffTheLanIsRefusedAtAccept() = runBlocking {
        val w = World()
        val svc = w.start(w.a, allowLoopback = false, advertise = false, browse = false)
        // Loopback is not allowed: every 127.0.0.1 source is off the LAN.
        val s = Raw(svc.port)
        assertTrue(s.closed.await(5, TimeUnit.SECONDS))
        assertEquals(0, svc.pendingCount)
    }

    // -- IPv6 -----------------------------------------------------------------------------------

    private fun ipv6Loopback(): Boolean =
        runCatching { java.net.ServerSocket(0, 1, java.net.InetAddress.getByAddress(ByteArray(15) + 1)).use { true } }.getOrDefault(false)

    @Test
    fun twoServicesTalkOverIpv6Loopback() = runBlocking {
        org.junit.Assume.assumeTrue("no IPv6 loopback here", ipv6Loopback())
        val w = World(Network("::1"))
        val la = w.start(w.a, host = "::1")
        val lb = w.start(w.b, host = "::1")
        until { la.peers().size == 1 && lb.peers().size == 1 }
        assertEquals(LanPeer(idA, "::1", la.port), lb.peers()[0])
        val (out, inn) = pair(la, lb)
        out.send("over ipv6".toByteArray())
        assertEquals("over ipv6", String(inn.receive(5000).body))
        inn.send("and back".toByteArray())
        assertEquals("and back", String(out.receive(5000).body))
    }

    @Test
    fun theDefaultListenerServesBothFamiliesOnOnePort() = runBlocking {
        org.junit.Assume.assumeTrue("no IPv6 loopback here", ipv6Loopback())
        val w = World()
        val la = w.start(w.a, host = null, advertise = false, browse = false)
        val v4 = Raw(la.port, "127.0.0.1")
        val v6 = Raw(la.port, "::1")
        until { la.pendingCount == 2 }
        assertEquals(setOf("127.0.0.1", "::1"), la.pendingAddresses.keys)
        assertFalse(v4.isClosed || v6.isClosed)
    }

    @Test
    fun aSourceOffTheLanOnIpv6IsClosedWithNoRead() = runBlocking {
        org.junit.Assume.assumeTrue("no IPv6 loopback here", ipv6Loopback())
        val w = World()
        // ::1 is not a LAN address unless loopback is allowed.
        val svc = w.start(w.a, host = "::1", allowLoopback = false, advertise = false, browse = false)
        val s = Raw(svc.port, "::1")
        assertTrue(s.closed.await(5, TimeUnit.SECONDS))
        assertEquals(0, s.received)
        assertEquals(0, svc.pendingCount)
    }

    @Test
    fun theGroupCapAppliesToIpv4SourcesToo() = runBlocking {
        val w = World()
        // One source address, so the per-address cap is out of the way: the /24 group cap is what refuses.
        val la = w.start(w.a, maxPendingPerAddress = 50, maxPendingPerGroup = 3)
        val socks = List(5) { Raw(la.port) }
        until { socks.count { it.isClosed } == 2 }
        Thread.sleep(100)
        assertEquals(2, socks.count { it.isClosed })
        assertEquals(3, la.pendingCount)
    }

    @Test
    fun aSlotIsFreedAtTheDeadlineWhenTheIdentityReadHangs() = runBlocking {
        val w = World()
        val ps = w.peerSource(w.a)
        val hang = java.util.concurrent.atomic.AtomicBoolean(false)
        val src = LanSource(load = { if (hang.get()) awaitCancellation() else ps }, now = { w.now })
        val la = w.start(w.a, src, advertise = false, browse = false, handshakeSeconds = 0.4)
        // The held identity is stale at the next read, which then hangs (a refresh over the network).
        w.now += 100
        hang.set(true)
        val s = Raw(la.port)
        until { la.pendingCount == 1 }
        assertTrue(s.closed.await(5, TimeUnit.SECONDS))
        until { la.pendingCount == 0 && la.pendingAddresses.isEmpty() }
        // and the next socket is served again
        hang.set(false)
        val t = Raw(la.port)
        until { la.pendingCount == 1 }
        assertFalse(t.isClosed)
    }

    /** A neighbour on `::1` at the device port that accepts and hangs up, as a host that answers first. Null if the port is taken. */
    private fun neighbour(port: Int): java.net.ServerSocket? {
        val loopback6 = java.net.InetAddress.getByAddress(ByteArray(15) + 1)
        val server = runCatching { java.net.ServerSocket(port, 5, loopback6) }.getOrNull() ?: return null
        Thread { runCatching { while (true) server.accept().close() } }.also { it.isDaemon = true }.start()
        return server
    }

    @Test
    fun aFailedHandshakeFallsThroughToTheAddressesThatAreLeft() = runBlocking {
        org.junit.Assume.assumeTrue("no IPv6 loopback here", ipv6Loopback())
        val w = World()
        val la = w.start(w.a, advertise = false, browse = false)
        val lb = w.start(w.b, advertise = false, browse = false)
        val fake = neighbour(la.port)
        org.junit.Assume.assumeTrue("the port is taken on ::1", fake != null)
        fake!!.use {
            // The neighbour's address is first, wins the race, fails the handshake; the device is then reached.
            val s = lb.connect(LanPeer(idA, "::1", la.port, listOf("127.0.0.1")))
            assertEquals(idA, s.peerDeviceId)
            // With only the neighbour left, the dial fails with the handshake failure.
            try {
                lb.connect(LanPeer(idA, "::1", la.port))
                fail("no device behind the address")
            } catch (e: LanException) {
                assertEquals(LanErrorReason.handshake_failed, e.reason)
            }
        }
    }

    @Test
    fun theLimitsIncludeAGroupCap() {
        assertEquals(16, im.plrs.key.core.peer.lan.LAN_MAX_PENDING_PER_GROUP)
        assertEquals(16, LanOptions().maxPendingPerGroup)
    }

    @Test
    fun aHostThatIsNotAnAddressIsNeverResolved() = runBlocking {
        val w = World()
        val la = w.start(w.a, advertise = false, browse = false)
        try {
            la.connect(LanPeer(idB, "localhost", 9))
            fail("a name is not an address")
        } catch (e: LanException) {
            assertEquals(LanErrorReason.unknown_peer, e.reason)
        }
    }

    @Test
    fun aPushedRosterIsReportedAsANotice() = runBlocking {
        val w = World()
        val la = w.start(w.a)
        val notices = CopyOnWriteArrayList<ConnectNotice>()
        la.onNotice { notices += it }
        la.documents.ring(w.ring)
        until { notices.isNotEmpty() }
        assertEquals(ConnectNotice(NoticeType.ring, NoticeOutcome.refused, reason = "unsupported"), notices[0])
    }
}
