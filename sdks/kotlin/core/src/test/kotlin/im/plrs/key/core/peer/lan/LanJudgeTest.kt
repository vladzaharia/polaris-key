// @pkey-feature connect.lan
//
// The address judge, the pre-handshake limiter and the dial race (WIRE-CONTRACT-V5 section 15.4.1;
// CC-IPV6.5b). Mirrors sdk-node's `connectHardening.test.ts` and `dial` tests.

package im.plrs.key.core.peer.lan

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class LanJudgeTest {
    @Test
    fun theTextOfAnAddressIsJudgedBeforeAnySocketExists() {
        assertTrue(textVerdict("192.168.1.9", false))
        assertTrue(textVerdict("fe80::1%en0", false))
        assertTrue(textVerdict("2001:db8:1::5", false)) // could be on-link: the connected socket decides
        assertFalse(textVerdict("8.8.8.8", false))
        assertFalse(textVerdict("2002:1::5", false)) // 6to4 never qualifies
        assertFalse(textVerdict("localhost", true))
        assertFalse(textVerdict("127.0.0.1", false))
        assertTrue(textVerdict("::1", true))
    }

    @Test
    fun theConnectedSocketIsJudgedOnItsOwnAddresses() {
        // A global peer is on-link only when this end's own address shares its /64.
        assertTrue(socketVerdict("2001:db8:1::5", "2001:db8:1::2", false).dial)
        assertFalse(socketVerdict("2001:db8:1::5", "2001:db8:9::2", false).dial)
        assertFalse(socketVerdict("2001:db8:1::5", null, false).dial)
        assertFalse(socketVerdict("2001:db8:1::5", "", false).dial)
        assertFalse(socketVerdict(null, "2001:db8:1::2", false).dial)
        assertFalse(socketVerdict("", null, true).dial)
        assertEquals("fe80::7%en0", socketVerdict("fe80::7%en0", null, false).key)
    }

    @Test
    fun theLimiterCapsAddressesSlash64sAndTheTotal() {
        val l = PendingLimiter(max = 6, perAddress = 2, perGroup = 3)
        val a = listOf(l.take("2001:db8:1::1"), l.take("2001:db8:1::1"), l.take("2001:db8:1::1"))
        assertNotNull(a[0])
        assertNotNull(a[1])
        assertNull(a[2]) // 2 per address
        assertNotNull(l.take("2001:db8:1::2")) // third of the /64
        assertNull(l.take("2001:db8:1::3")) // the /64 is full
        // another /64 and another zone are other groups
        assertNotNull(l.take("2001:db8:2::1"))
        assertNotNull(l.take("fe80::1%en0"))
        assertNotNull(l.take("fe80::1%en1")) // same address, another link: another host
        assertNull(l.take("10.0.0.1")) // 6 held: the total
        assertEquals(6, l.size)
        a[0]!!.invoke()
        a[0]!!.invoke() // a second release does nothing
        assertEquals(5, l.size)
        assertNotNull(l.take("10.0.0.1"))
        assertEquals(setOf("2001:db8:1::1", "2001:db8:1::2", "2001:db8:2::1", "fe80::1%en0", "fe80::1%en1", "10.0.0.1"), l.perAddressCounts().keys)
    }

    @Test
    fun theDefaultLimitsAre4PerAddress16PerSlash64And32InTotal() {
        val l = PendingLimiter()
        repeat(LAN_MAX_PENDING_PER_ADDRESS) { assertNotNull(l.take("10.0.0.1")) }
        assertNull(l.take("10.0.0.1"))
        // sixteen neighbours of one /64 fill it; the seventeenth is refused
        repeat(LAN_MAX_PENDING_PER_GROUP) { assertNotNull(l.take("fd12::${it + 1}")) }
        assertNull(l.take("fd12::ff"))
        assertEquals(LAN_MAX_PENDING_PER_ADDRESS + LAN_MAX_PENDING_PER_GROUP, l.size)
        // 10 further IPv4 hosts reach the total of 32
        repeat(LAN_MAX_PENDING - l.size) { assertNotNull(l.take("10.0.1.$it")) }
        assertNull(l.take("10.0.9.9"))
    }

    // -- the dial race ----------------------------------------------------------------------------

    private fun server(): ServerSocket = ServerSocket(0, 5, java.net.InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)))

    @Test
    fun anAddressThatIsNotALanAddressIsNeverConnected() {
        var connects = 0
        val o = LanDialOptions(false, 1000, 20) { _, _, _ -> connects++ }
        try {
            runBlocking { lanDialRace(listOf("8.8.8.8", "169.254.1.1", "localhost"), 9, o) }
            fail("refused")
        } catch (e: IOException) {
            assertEquals("address refused", e.message)
        }
        assertEquals(0, connects)
    }

    @Test
    fun theRaceKeepsAtMostTwoInFlightStartsTheNextAtOnceOnAFailureAndTheWinnerIsJudged() {
        server().use { srv ->
            val inFlight = AtomicInteger()
            val peak = AtomicInteger()
            val started = CopyOnWriteArrayList<String>()
            val release = CountDownLatch(1)
            val o = LanDialOptions(true, 5000, 80) { s, a, _ ->
                val host = a.address.hostAddress
                started += host
                peak.accumulateAndGet(inFlight.incrementAndGet()) { x, y -> maxOf(x, y) }
                try {
                    when (host) {
                        "10.0.0.1" -> release.await(3, TimeUnit.SECONDS).also { throw IOException("down") }
                        "10.0.0.2" -> release.await(3, TimeUnit.SECONDS).also { throw IOException("down") }
                        else -> s.connect(InetSocketAddress("127.0.0.1", srv.localPort))
                    }
                } finally {
                    inFlight.decrementAndGet()
                }
            }
            val done = CompletableFutureOf { runBlocking { lanDialRace(listOf("10.0.0.1", "10.0.0.2", "10.0.0.3"), srv.localPort, o) } }
            Thread.sleep(400) // several staggers: still two in flight, the third waits for a failure
            assertEquals(listOf("10.0.0.1", "10.0.0.2"), started.toList())
            release.countDown() // both fail at once; the third starts at once and wins
            val s = done.get(5)
            assertEquals(2, peak.get().coerceAtMost(2))
            assertTrue(peak.get() <= 2)
            assertEquals(listOf("10.0.0.1", "10.0.0.2", "10.0.0.3"), started.toList())
            assertTrue(s.isConnected)
            s.close()
        }
    }

    @Test
    fun theFirstAddressThatConnectsWinsAndTheLoserIsClosed() {
        server().use { srv ->
            val slow = CountDownLatch(1)
            val sockets = CopyOnWriteArrayList<Socket>()
            val o = LanDialOptions(true, 5000, 30) { s, a, _ ->
                sockets += s
                if (a.address.hostAddress == "10.0.0.1") slow.await(3, TimeUnit.SECONDS).also { throw IOException("cancelled") }
                s.connect(InetSocketAddress("127.0.0.1", srv.localPort))
            }
            val s = runBlocking { lanDialRace(listOf("10.0.0.1", "10.0.0.2"), srv.localPort, o) }
            assertTrue(s.isConnected)
            assertEquals(2, sockets.size)
            // the slow attempt's socket was closed when the race was won
            assertTrue(sockets.first { it !== s }.isClosed)
            slow.countDown()
            s.close()
        }
    }

    @Test
    fun aWinnerThatFailsTheVerdictOnItsOwnAddressesLosesAndNoByteIsSent() {
        server().use { srv ->
            // The connection lands on 127.0.0.1, which is not a LAN address without allowLoopback.
            val o = LanDialOptions(false, 2000, 20) { s, _, _ -> s.connect(InetSocketAddress("127.0.0.1", srv.localPort)) }
            try {
                runBlocking { lanDialRace(listOf("10.0.0.1"), srv.localPort, o) }
                fail("refused")
            } catch (e: IOException) {
                assertEquals("address refused", e.message)
            }
            srv.soTimeout = 2000
            srv.accept().use { accepted ->
                assertEquals(-1, accepted.getInputStream().read()) // closed, nothing written
            }
        }
    }

    @Test
    fun noAddressThatAnswersIsTheLastFailure() {
        val o = LanDialOptions(true, 1000, 20) { _, _, _ -> throw IOException("refused 1") }
        try {
            runBlocking { lanDialRace(listOf("10.0.0.1", "10.0.0.2"), 9, o) }
            fail("none")
        } catch (e: IOException) {
            assertEquals("refused 1", e.message)
        }
    }

    /** A thread that runs [f] and returns its result. */
    private class CompletableFutureOf<T>(f: () -> T) {
        private val box = java.util.concurrent.atomic.AtomicReference<Result<T>>()
        private val done = CountDownLatch(1)

        init {
            Thread {
                box.set(runCatching(f))
                done.countDown()
            }.also { it.isDaemon = true }.start()
        }

        fun get(seconds: Long): T {
            assertTrue("the race finished", done.await(seconds, TimeUnit.SECONDS))
            return box.get().getOrThrow()
        }
    }
}
