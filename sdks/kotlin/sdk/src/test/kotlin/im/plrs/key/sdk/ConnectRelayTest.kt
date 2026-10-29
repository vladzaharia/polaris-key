// @pkey-feature connect.relay
//
// The relay socket (CC-12.13; WIRE-CONTRACT-V5 section 15.7, G13 to G15): ticket offer, open, reconnect
// policy, LIMIT and close codes, status. The room is the in-process [FakeRoom]; the default OkHttp opener
// is covered against a real loopback WebSocket server (MockWebServer). Mirrors the socket half of
// sdk-node's `relay.test.ts` and the Python `test_connect_relay.py`.

package im.plrs.key.sdk

import im.plrs.key.core.Base64Url
import im.plrs.key.core.peer.RELAY_MAX_MESSAGE
import im.plrs.key.core.peer.RelayMessage
import kotlinx.coroutines.runBlocking
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.ByteString
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Ignore
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

class ConnectRelayTest {
    private val ping = 1000.0 // a ping interval no backoff delay can equal
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

    private inner class Rig(device: String? = null, members: Set<String>? = null, room: FakeRoom? = null) {
        val world = TestWorld()
        val device = device ?: world.idA
        val room = room ?: FakeRoom(members ?: setOf(world.idA, world.idB))
        val sleep = ManualSleep()
        val errors = CopyOnWriteArrayList<Exception>()
        val refreshes = java.util.concurrent.atomic.AtomicInteger()
        val states = CopyOnWriteArrayList<RelayState>()

        @Volatile var clock = 100.0
        lateinit var svc: RelayService

        fun start(): RelayService {
            val dev = if (device == world.idA) world.a else world.b
            val src = world.source(dev, refresh = { refreshes.incrementAndGet() })
            svc = RelayService(
                src,
                {
                    errors.removeFirstOrNull()?.let { throw it }
                    room.issue(device)
                },
                RelayOptions(opener = room::opener, sleep = sleep, random = { 0.5 }, clock = { clock }, pingSeconds = ping),
            )
            svc.onState { states += it.state }
            services += svc
            svc.start()
            return svc
        }

        fun ready(): RelayService {
            val s = if (this::svc.isInitialized) svc else start()
            runBlocking { s.ready(5000) }
            return s
        }

        fun backoffDelays(): List<Double> = sleep.delays.filter { it != ping }

        fun wake() {
            until { sleep.fire { it != ping } }
        }
    }

    // -- the ticket and the open -----------------------------------------------------------------

    @Test
    fun theSocketOffersTheProtocolThenTheTicketAndANewTicketEachConnect() {
        val r = Rig()
        r.ready()
        val (proto, ticket) = r.room.offered[0]
        assertEquals("pkey-relay.1", proto)
        assertTrue(Regex("pkeyrt_[A-Za-z0-9_-]{32}").matches(ticket))
        assertEquals("wss://k.test/djdl/connect/relay", r.room.ever[0].url)
        r.room.dropAll(null)
        r.wake()
        until { r.room.offered.size == 2 }
        assertTrue(r.room.offered[1][1] != ticket)
        assertEquals(2, r.room.issued)
    }

    @Test
    fun onOpenItAsksForTheMembersAndReportsThem() = runBlocking {
        val r = Rig()
        val svc = r.ready()
        assertEquals(RelayState.open, r.states.last())
        assertEquals(0, svc.status.attempts)
        assertNull(svc.status.error)
        until { svc.members() == listOf(r.world.idA) }
        assertEquals(RelayMessage.List::class, r.room.received[0].second::class)
        // A second device arrives: the room never pushes joins, so the device asks.
        val r2 = Rig(device = r.world.idB, room = r.room)
        r2.ready()
        assertEquals(listOf(r.world.idA, r.world.idB).sorted(), svc.refreshMembers(3000).sorted())
    }

    @Test
    fun aPingIsAnsweredAndListedOnEveryInterval() {
        val r = Rig()
        r.ready()
        until { r.sleep.pending.any { it.first == ping } }
        val n = r.room.received.size
        assertTrue(r.sleep.fire { it == ping })
        until { r.room.received.size >= n + 2 }
        assertEquals(listOf(RelayMessage.Ping::class, RelayMessage.List::class), r.room.received.subList(n, n + 2).map { it.second::class })
        assertEquals(8, (r.room.received[n].second as RelayMessage.Ping).data.size)
    }

    @Test
    fun membersChangesAndGoneAreReported() {
        val r = Rig()
        val svc = r.ready()
        val seen = CopyOnWriteArrayList<List<String>>()
        svc.onMembers { seen += it }
        until { svc.members() == listOf(r.world.idA) }
        r.room.push(r.world.idA, RelayMessage.Gone(Base64Url.decodeStrict(r.world.idA)!!))
        until { svc.members().isEmpty() }
        until { seen.lastOrNull()?.isEmpty() == true }
    }

    // -- reconnect and the typed stops -----------------------------------------------------------

    // Disabled 2026-10-28 under the load rule: timing-dependent on the CI runners (one of four Connect tests
    // failing per main run) and passes locally. KT-CONNECT-FLAKE makes them deterministic and re-enables them
    // (_lead/flaky-disabled.md).
    @Ignore("2026-10-28: timing-dependent on CI runners; see _lead/flaky-disabled.md")
    @Test
    fun reconnectsWithAGrowingJitteredBackoffThatResetsOnlyAfterAStableOpen() {
        val r = Rig()
        val svc = r.ready()
        for (n in 2..4) {
            r.room.dropAll(null)
            r.wake()
            until { r.room.offered.size == n }
        }
        // Equal jitter at random() = 0.5: 0.75, 1.5, 3.0.
        assertEquals(listOf(0.75, 1.5, 3.0), r.backoffDelays().take(3))
        assertEquals(3, svc.status.attempts)
        // A socket that stays up for 30 seconds resets the backoff.
        until { svc.status.state == RelayState.open }
        r.clock += 31
        r.room.dropAll(null)
        r.wake()
        until { r.room.offered.size == 5 }
        assertEquals(0.75, r.backoffDelays()[3], 0.0)
    }

    @Test
    fun aRoomCloseBeforeOpenWith4001GetsANewTicketAfterTheBackoff() = runBlocking {
        val r = Rig()
        r.room.rejectWith = 4001
        r.start()
        r.wake()
        r.svc.ready(5000)
        assertEquals(2, r.room.offered.size)
        assertEquals(2, r.room.issued)
    }

    @Test
    fun aDroppedSocketReconnectsAndReadyWaitsForIt() = runBlocking {
        val r = Rig()
        val svc = r.ready()
        r.room.dropAll(1006)
        until { svc.status.state == RelayState.backoff }
        r.wake()
        svc.ready(5000)
    }

    @Test
    fun a4009StopsWithoutFightingBack() = runBlocking {
        val r = Rig()
        val svc = r.ready()
        r.room.dropAll(4009)
        until { svc.status.state == RelayState.blocked }
        assertEquals(RelayErrorReason.replaced, svc.status.error!!.reason)
        assertEquals("4009", svc.status.error!!.closeCode)
        try {
            svc.ready(1000)
            fail("blocked")
        } catch (e: RelayException) {
            assertEquals(RelayErrorReason.replaced, e.reason)
        }
        Thread.sleep(100)
        assertEquals(1, r.room.offered.size)
    }

    @Test
    fun theThirdSocketOfADeviceReplacesTheOldestWith4009() {
        val r = Rig()
        val svc = r.ready()
        Rig(room = r.room).ready()
        Rig(room = r.room).ready()
        until { svc.status.state == RelayState.blocked }
        assertEquals(RelayErrorReason.replaced, svc.status.error!!.reason)
    }

    @Test
    fun aProductThatTurnedTheRelayOffOrASpentQuotaEndsTheLoop() = runBlocking {
        for ((reason, scope) in listOf(
            RelayErrorReason.disabled to null,
            RelayErrorReason.quota to RelayQuotaScope.person,
            RelayErrorReason.quota to RelayQuotaScope.product,
        )) {
            val r = Rig()
            r.errors += RelayException(reason, "no", scope = scope, httpStatus = 403)
            val svc = r.start()
            until { svc.status.state == RelayState.blocked }
            assertEquals(reason, svc.status.error!!.reason)
            assertEquals(scope, svc.status.error!!.scope)
            try {
                svc.ready(1000)
                fail("blocked")
            } catch (e: RelayException) {
                assertEquals(reason, e.reason)
            }
            assertTrue(r.room.offered.isEmpty()) // no socket was opened
        }
    }

    @Test
    fun resumeAfterABlockTriesAgain() = runBlocking {
        val r = Rig()
        r.errors += RelayException(RelayErrorReason.quota, "spent", scope = RelayQuotaScope.person)
        val svc = r.start()
        until { svc.status.state == RelayState.blocked }
        svc.resume()
        svc.ready(5000)
        assertNull(svc.status.error)
    }

    @Test
    fun aPausedRelayWaitsForRetryAfterCappedAtAnHour() = runBlocking {
        val r = Rig()
        r.errors += RelayException(RelayErrorReason.paused, "paused", retryAfterSeconds = 300, httpStatus = 503)
        r.errors += RelayException(RelayErrorReason.paused, "paused", retryAfterSeconds = Int.MAX_VALUE, httpStatus = 503)
        val svc = r.start()
        until { r.sleep.pending.any { it.first != ping } }
        assertEquals(listOf(300.0), r.backoffDelays())
        r.wake()
        until { r.backoffDelays().size == 2 }
        assertEquals(3600.0, r.backoffDelays()[1], 0.0)
        r.wake()
        svc.ready(5000)
    }

    @Test
    fun aLimitForTheProductThen4008IsATypedQuotaStop() {
        val r = Rig()
        val svc = r.ready()
        r.room.push(r.world.idA, RelayMessage.Limit(3))
        until { svc.status.error?.reason == RelayErrorReason.quota }
        assertEquals(RelayQuotaScope.product, svc.status.error!!.scope)
        r.room.dropAll(4008)
        until { svc.status.state == RelayState.blocked }
        assertEquals(RelayQuotaScope.product, svc.status.error!!.scope)
        assertEquals("4008", svc.status.error!!.closeCode)
    }

    @Test
    fun a4008AfterARateLimitOrWithNoLimitBacksOffInstead() = runBlocking {
        val r = Rig()
        val svc = r.ready()
        r.room.push(r.world.idA, RelayMessage.Limit(1))
        until { svc.status.error?.reason == RelayErrorReason.rate_limited }
        r.room.dropAll(4008)
        until { svc.status.state == RelayState.backoff }
        r.wake()
        svc.ready(5000)
        assertNull(svc.status.error) // the last LIMIT is cleared on reopen
        r.room.dropAll(4008)
        until { svc.status.state == RelayState.backoff }
    }

    @Test
    fun aPausedLimitIsReportedAndTheSocketStays() {
        val r = Rig()
        val svc = r.ready()
        r.room.push(r.world.idA, RelayMessage.Limit(4))
        until { svc.status.error?.reason == RelayErrorReason.paused }
        assertEquals(RelayState.open, svc.status.state)
    }

    @Test
    fun a4003FetchesTheRosterAndStopsAfterThreeInARow() {
        val r = Rig(members = emptySet())
        val svc = r.start()
        for (n in 1..2) {
            until { r.room.offered.size == n }
            until { svc.status.state == RelayState.backoff && r.sleep.pending.isNotEmpty() }
            r.wake()
        }
        until { svc.status.state == RelayState.blocked }
        assertEquals(RelayErrorReason.not_member, svc.status.error!!.reason)
        until { r.refreshes.get() >= 1 }
    }

    @Test
    fun fiveAttemptsThatNeverOpenMakeTheRelayUnavailableAndSlowTheRetries() {
        val r = Rig()
        repeat(7) { r.errors += RelayException(RelayErrorReason.unavailable, "down") }
        val svc = r.start()
        for (n in 1..4) {
            until { svc.status.attempts == n && r.sleep.pending.isNotEmpty() }
            assertEquals(RelayState.backoff, svc.status.state)
            r.wake()
        }
        until { svc.status.attempts == 5 && svc.status.state == RelayState.unavailable && r.sleep.pending.any { it.first != ping } }
        assertTrue(r.backoffDelays().last() >= 300)
        r.wake()
        until { svc.status.attempts == 6 && r.backoffDelays().size == 6 }
        assertTrue(r.backoffDelays().last() >= 300)
        assertEquals(RelayState.unavailable, svc.status.state)
    }

    // -- refused envelopes -----------------------------------------------------------------------

    @Test
    fun anEnvelopeThatDoesNotMatchItsLayoutCloses1002AndNothingIsAnswered() {
        val bad: List<Any> = listOf(
            byteArrayOf(-1, 0),
            byteArrayOf(-0x7e, 5, 0),
            ByteArray(0),
            "text frame",
            byteArrayOf(-0x7f) + ByteArray(RELAY_MAX_MESSAGE),
        )
        for (b in bad) {
            val r = Rig()
            val svc = r.ready()
            until { svc.members() == listOf(r.world.idA) }
            val n = r.room.received.size
            val sock = r.room.sockets[0]
            r.room.push(r.world.idA, b)
            until { sock.closed }
            assertEquals(1002, sock.closeCode)
            Thread.sleep(50)
            assertEquals(n, r.room.received.size)
            until { svc.status.state == RelayState.backoff }
        }
    }

    @Test
    fun aBadRoomMessageIsNotACrashForTheNextSocket() = runBlocking {
        val r = Rig()
        val svc = r.ready()
        r.room.push(r.world.idA, byteArrayOf(-1))
        until { svc.status.state == RelayState.backoff }
        r.wake()
        svc.ready(5000)
    }

    // -- pushed documents ------------------------------------------------------------------------

    @Test
    fun aRelayRingAboveTheHeldEpochFetchesTheRosterAndOneAtItDoesNot() {
        val r = Rig()
        val svc = r.ready()
        until { svc.members() == listOf(r.world.idA) }
        r.room.pushRing(1) // the held epoch is 1
        Thread.sleep(300)
        assertEquals(0, r.refreshes.get())
        r.room.pushRing(2)
        until { r.refreshes.get() == 1 }
    }

    // -- stopping and the surface ----------------------------------------------------------------

    @Test
    fun stopClosesTheSocketAndReadyThenThrowsStopped() = runBlocking {
        val r = Rig()
        val svc = r.ready()
        val sock = r.room.sockets[0]
        svc.stop()
        assertTrue(sock.closed)
        assertEquals(1000, sock.closeCode)
        assertEquals(RelayState.stopped, svc.status.state)
        assertTrue(svc.members().isEmpty())
        try {
            svc.ready(1000)
            fail("stopped")
        } catch (e: RelayException) {
            assertEquals(RelayErrorReason.stopped, e.reason)
        }
        svc.stop() // twice is fine
    }

    @Test
    fun readyTimesOutWithNotConnectedWhenNothingOpens() = runBlocking {
        val r = Rig()
        val src = r.world.source(r.world.a)
        val svc = RelayService(
            src,
            { r.room.issue(r.device) },
            RelayOptions(opener = { _, _ ->
                kotlinx.coroutines.delay(3_600_000)
                error("never")
            }, sleep = r.sleep, openSeconds = 0.2),
        )
        services += svc
        try {
            svc.ready(300)
            fail("not connected")
        } catch (e: RelayException) {
            assertEquals(RelayErrorReason.not_connected, e.reason)
        }
    }

    @Test
    fun onlyModeAMayCrossTheRelay() {
        assertEquals("a", assertRelayMode("a"))
        for (mode in listOf("v", "p", "c", "")) {
            try {
                assertRelayMode(mode)
                fail("mode $mode")
            } catch (e: RelayException) {
                assertEquals(RelayErrorReason.mode_not_allowed, e.reason)
            }
        }
    }

    @Test
    fun aServiceDoesNotLeakTheTicketThroughToString() {
        val r = Rig()
        val svc = r.ready()
        val ticket = r.room.offered[0][1]
        assertFalse(svc.toString().contains(ticket))
        assertFalse(svc.status.toString().contains(ticket))
        assertFalse(r.room.issue(r.device).toString().contains("pkeyrt_"))
    }

    // -- the default opener against a real loopback WebSocket server ----------------------------

    private fun wsUrl(server: MockWebServer, path: String = "/room") = "ws://127.0.0.1:${server.port}$path"

    private fun quiet(s: MockWebServer) {
        try {
            s.shutdown()
        } catch (e: java.io.IOException) {
            // a closing handshake still in flight
        }
    }

    private val ticket = "pkeyrt_" + "A".repeat(32)

    private fun echoServer(
        protocol: String? = "pkey-relay.1",
        extensions: String? = null,
        received: CopyOnWriteArrayList<ByteString>? = null,
    ): MockWebServer {
        val server = MockWebServer()
        val listener = object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                received?.add(bytes)
                webSocket.send(bytes)
            }
        }
        val res = MockResponse().withWebSocketUpgrade(listener)
        protocol?.let { res.addHeader("Sec-WebSocket-Protocol", it) }
        extensions?.let { res.addHeader("Sec-WebSocket-Extensions", it) }
        server.enqueue(res)
        server.start()
        return server
    }

    @Test
    fun theDefaultOpenerNegotiatesTheProtocolAndCarriesBinaryMessagesWithNoCompression() = runBlocking {
        val server = echoServer()
        try {
            val open = okHttpOpener(allowPlainLoopback = true, openSeconds = 5.0)
            val ws = open(wsUrl(server), listOf("pkey-relay.1", ticket))
            val req = server.takeRequest()
            assertEquals("pkey-relay.1, $ticket", req.getHeader("Sec-WebSocket-Protocol"))
            assertNull(req.getHeader("Sec-WebSocket-Extensions")) // no permessage-deflate offered
            ws.send(byteArrayOf(1, 2, 3))
            val f = ws.receive() as RelayFrame.Binary
            assertEquals(listOf<Byte>(1, 2, 3), f.bytes.toList())
            ws.close(1000)
        } finally {
            quiet(server)
        }
    }

    @Test
    fun theDefaultOpenerRefusesAServerThatDoesNotEchoTheProtocolOrOffersAnExtension() = runBlocking {
        for (server in listOf(echoServer(protocol = null), echoServer(protocol = "other"), echoServer(extensions = "permessage-deflate"))) {
            try {
                okHttpOpener(allowPlainLoopback = true, openSeconds = 5.0)(wsUrl(server), listOf("pkey-relay.1", ticket))
                fail("refused")
            } catch (e: SocketClosed) {
                assertEquals(1002, e.code)
            } finally {
                quiet(server)
            }
        }
    }

    @Test
    fun theDefaultOpenerNeverFollowsARedirectSoTheTicketGoesNowhereElse() = runBlocking {
        val elsewhere = MockWebServer().also { it.start() }
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(302).addHeader("Location", "http://127.0.0.1:${elsewhere.port}/stolen"))
        server.start()
        try {
            okHttpOpener(allowPlainLoopback = true, openSeconds = 5.0)(wsUrl(server), listOf("pkey-relay.1", ticket))
            fail("a redirect is a failed open")
        } catch (e: SocketClosed) {
            assertNull(e.code)
            assertFalse(e.toString().contains(ticket))
        } finally {
            assertEquals(0, elsewhere.requestCount) // the second hop never happened
            assertEquals(1, server.requestCount)
            quiet(server)
            quiet(elsewhere)
        }
    }

    @Test
    fun theDefaultOpenerRefusesAnOversizeMessageAnUnreachableHostAndPlainText() = runBlocking {
        val big = MockWebServer()
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(ByteString.of(*ByteArray(RELAY_MAX_MESSAGE + 1)))
            }
        }
        big.enqueue(MockResponse().addHeader("Sec-WebSocket-Protocol", "pkey-relay.1").withWebSocketUpgrade(listener))
        big.start()
        try {
            val ws = okHttpOpener(allowPlainLoopback = true, openSeconds = 5.0)(wsUrl(big), listOf("pkey-relay.1", ticket))
            try {
                ws.receive()
                fail("oversize")
            } catch (e: SocketClosed) {
                assertEquals(1009, e.code)
            }
        } finally {
            quiet(big)
        }
        try {
            okHttpOpener(allowPlainLoopback = true, openSeconds = 2.0)("ws://127.0.0.1:1/x", listOf("pkey-relay.1", ticket))
            fail("unreachable")
        } catch (e: SocketClosed) {
            assertNull(e.code)
        }
        // TLS is never off: plain ws to a non-loopback host, or without the test flag, is not opened.
        for ((url, flag) in listOf("ws://10.0.0.1/x" to true, "ws://127.0.0.1/x" to false, "http://127.0.0.1/x" to true)) {
            try {
                okHttpOpener(allowPlainLoopback = flag)(url, listOf("pkey-relay.1", ticket))
                fail("plain $url")
            } catch (e: SocketClosed) {
                assertNull(e.code)
            }
        }
    }

    @Test
    fun theServiceRunsOverTheDefaultOpenerOnARealSocket() = runBlocking {
        val server = echoServer()
        try {
            val w = TestWorld()
            val svc = RelayService(
                w.source(w.a),
                { RelayGrant(ticket, wsUrl(server), "pkey-relay.1", 2_000_000_000) },
                RelayOptions(opener = okHttpOpener(allowPlainLoopback = true, openSeconds = 5.0)),
            )
            services += svc
            svc.start()
            svc.ready(5000)
            assertEquals(RelayState.open, svc.status.state)
            assertNotNull(svc.status)
            svc.stop()
        } finally {
            quiet(server)
        }
    }
}
