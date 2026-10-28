// @pkey-feature connect.app
//
// `ConnectSession` (CC-12.10; WIRE-CONTRACT-V5 sections 15.5 and 15.6): the APP range, the queue
// bounds (256 messages, pause at 4 MiB, resume under 1 MiB, `peer_busy` at 8 MiB, a shared budget),
// an APP-critical record, pushed RING and TRUST. The bounds run against a recording link; the rest
// through two real links over in-memory pipes. Mirrors sdk-node's `connect.test.ts` and
// `connectHardening.test.ts` and the Python `test_connect_session.py`.

package im.plrs.key.sdk

import im.plrs.key.core.Base64Url
import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.DeviceKeyStore
import im.plrs.key.core.InMemoryDeviceKeyStorage
import im.plrs.key.core.PeerTrustResult
import im.plrs.key.core.jsonInt
import im.plrs.key.core.peer.HeldRing
import im.plrs.key.core.peer.HelloInfo
import im.plrs.key.core.peer.LinkRefused
import im.plrs.key.core.peer.NoiseRole
import im.plrs.key.core.peer.PeerCloseCode
import im.plrs.key.core.peer.PeerHello
import im.plrs.key.core.peer.PeerLink
import im.plrs.key.core.peer.PeerLinkPort
import im.plrs.key.core.peer.PeerPipe
import im.plrs.key.core.peer.RecordType
import im.plrs.key.core.peer.SessionEvent
import im.plrs.key.core.peer.openInitiator
import im.plrs.key.core.testing.TestSigner
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.TimeoutException

class ConnectSessionTest {
    private val sub = "ps_AbCdEfGhIjKlMnOpQrStUv"
    private val now = 1_700_000_000L
    private val signer = TestSigner()

    private fun <T> bounded(block: suspend () -> T): T = runBlocking { withTimeout(15_000) { block() } }

    // -- the bounds, against a recording link ----------------------------------------------------

    private class FakeLink : PeerLinkPort {
        override val remoteAddress = "10.0.0.9"
        val pauses = ArrayList<Boolean>()
        val closes = ArrayList<PeerCloseCode>()
        val sent = ArrayList<Pair<Int, ByteArray>>()
        var sendFails: Exception? = null

        override suspend fun sendRecord(type: Int, body: ByteArray) {
            sendFails?.let { throw it }
            sent += type to body
        }

        override suspend fun close(code: PeerCloseCode) {
            closes += code
        }

        override fun closeNow(code: PeerCloseCode) {
            closes += code
        }

        override fun pause(on: Boolean) {
            pauses += on
        }
    }

    private fun session(link: PeerLinkPort = FakeLink(), budget: QueueBudget = QueueBudget()) = ConnectSession(
        link,
        "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH",
        listOf("app/1"),
        PeerHello("test", "demo", 1 shl 20),
        NoiseRole.initiator,
        "10.0.0.9",
        "lan",
        budget,
    )

    private fun msg(n: Int, type: Int = 0x0100) = SessionMessage(type, ByteArray(n))

    @Test
    fun appRecordsAreQueuedInOrderAndReceived() = bounded {
        val s = session()
        s.deliver(SessionMessage(0x0100, "a".toByteArray()))
        s.deliver(SessionMessage(0x0101, "bb".toByteArray()))
        assertEquals("a", String(s.receive().body))
        val m = s.receive()
        assertEquals(0x0101, m.type)
        assertEquals("bb", String(m.body))
        try {
            s.receive(timeoutMillis = 20)
            fail("nothing is waiting")
        } catch (e: TimeoutException) {
            assertEquals("no message", e.message)
        }
    }

    @Test
    fun onMessageTakesMessagesInsteadOfTheQueue() = bounded {
        val s = session()
        val seen = ArrayList<Int>()
        val off = s.onMessage { seen += it.body.size }
        s.deliver(msg(3))
        off()
        s.deliver(msg(4))
        assertEquals(listOf(3), seen)
        assertEquals(4, s.receive().body.size)
    }

    @Test
    fun theSocketPausesAtFourMibAndResumesUnderOne() = bounded {
        val link = FakeLink()
        val s = session(link)
        val mib = 1 shl 20
        repeat(4) { s.deliver(msg(mib)) }
        assertTrue(link.pauses.isEmpty()) // exactly 4 MiB is not over
        s.deliver(msg(1))
        assertEquals(listOf(true), link.pauses)
        repeat(3) { s.receive() } // 1 MiB + 1 left: not under 1 MiB
        assertEquals(listOf(true), link.pauses)
        s.receive()
        assertEquals(listOf(true, false), link.pauses)
        assertTrue(link.closes.isEmpty())
    }

    @Test
    fun overEightMibClosesPeerBusy() = bounded {
        val link = FakeLink()
        val s = session(link)
        val mib = 1 shl 20
        repeat(8) { s.deliver(msg(mib)) }
        assertTrue(link.closes.isEmpty())
        s.deliver(msg(1))
        assertEquals(listOf(PeerCloseCode.peer_busy), link.closes)
    }

    @Test
    fun the257thQueuedMessageClosesPeerBusy() = bounded {
        val link = FakeLink()
        val s = session(link)
        repeat(MAX_QUEUED_MESSAGES) { s.deliver(msg(1)) }
        assertTrue(link.closes.isEmpty())
        s.deliver(msg(1))
        assertEquals(listOf(PeerCloseCode.peer_busy), link.closes)
        // Reading frees a slot again.
        s.receive()
        s.deliver(msg(1))
        assertEquals(1, link.closes.size)
    }

    @Test
    fun allSessionsShareOneBudgetAndAClosedSessionGivesItBack() = bounded {
        val budget = QueueBudget(1000)
        val l1 = FakeLink()
        val l2 = FakeLink()
        val a = session(l1, budget)
        val b = session(l2, budget)
        a.deliver(msg(600))
        assertEquals(600, budget.used)
        b.deliver(msg(500)) // 1100 > 1000
        assertEquals(listOf(PeerCloseCode.peer_busy), l2.closes)
        assertEquals(600, budget.used)
        a.ended(SessionClosed("peer_bye", true))
        assertEquals(0, budget.used)
        b.deliver(msg(500))
        assertEquals(500, budget.used)
        b.receive()
        assertEquals(0, budget.used)
        assertEquals(TOTAL_QUEUE_BYTES, 32 * 1024 * 1024)
    }

    @Test
    fun aClosedSessionDropsItsQueueAndReceiveSaysClosed() = bounded {
        val s = session()
        val seen = ArrayList<SessionClosed>()
        s.deliver(msg(2))
        s.ended(SessionClosed("peer_revoked", true))
        s.onClose { seen += it } // late subscriber hears at once
        assertEquals(listOf(SessionClosed("peer_revoked", true)), seen)
        assertEquals(SessionClosed("peer_revoked", true), s.closed)
        try {
            s.receive()
            fail("closed")
        } catch (e: LanException) {
            assertEquals(LanErrorReason.closed, e.reason)
        }
        s.deliver(msg(1)) // ignored once closed
        s.ended(SessionClosed("other", false)) // only the first end counts
        assertEquals(1, seen.size)
    }

    @Test
    fun aWaitingReceiveEndsWhenTheSessionCloses() = bounded {
        val s = session()
        val waiting = CoroutineScope(Dispatchers.Default + Job())
        try {
            val r = waiting.launch { runCatching { s.receive() }.exceptionOrNull() }
            delay(50)
            s.ended(SessionClosed("connection_lost", false))
            r.join()
            assertFalse(r.isCancelled)
        } finally {
            waiting.cancel()
        }
    }

    @Test
    fun sendKeepsToTheAppRangeAndNamesItsRefusals() = bounded {
        val link = FakeLink()
        val s = session(link)
        for (t in listOf(0x00ff, 0x8000, 0x8100, -1)) {
            try {
                s.send(ByteArray(1), t)
                fail("type $t is outside the APP range")
            } catch (e: LanException) {
                assertEquals(LanErrorReason.bad_type, e.reason)
            }
        }
        s.send("x".toByteArray())
        s.send("y".toByteArray(), 0x7fff)
        assertEquals(listOf(0x0100, 0x7fff), link.sent.map { it.first })
        link.sendFails = IllegalArgumentException("message too large")
        try {
            s.send(ByteArray(1))
            fail("too large")
        } catch (e: LanException) {
            assertEquals(LanErrorReason.too_large, e.reason)
        }
        link.sendFails = IllegalStateException("session not open")
        try {
            s.send(ByteArray(1))
            fail("closed")
        } catch (e: LanException) {
            assertEquals(LanErrorReason.closed, e.reason)
        }
        s.ended(SessionClosed("peer_bye", true))
        try {
            s.send(ByteArray(1))
            fail("closed")
        } catch (e: LanException) {
            assertEquals(LanErrorReason.closed, e.reason)
        }
    }

    @Test
    fun closeTakesOnlyTheHostCodes() = bounded {
        val link = FakeLink()
        val s = session(link)
        s.close()
        s.close("peer_busy")
        assertEquals(listOf(PeerCloseCode.peer_bye, PeerCloseCode.peer_busy), link.closes)
        try {
            s.close("peer_revoked")
            fail("not a host code")
        } catch (e: IllegalArgumentException) {
            assertEquals("close code", e.message)
        }
    }

    @Test
    fun routeRecordSendsAppToTheHostClosesOnACriticalTypeAndIgnoresTheRest() = bounded {
        val link = FakeLink()
        val s = session(link)
        routeRecord(link, s, 0x0100, ByteArray(1))
        routeRecord(link, s, 0x7fff, ByteArray(1))
        assertEquals(0x0100, s.receive().type)
        assertEquals(0x7fff, s.receive().type)
        routeRecord(link, s, 0x8200, ByteArray(0))
        routeRecord(link, s, 0xFFFD, ByteArray(0))
        assertEquals(listOf(PeerCloseCode.peer_unknown_critical, PeerCloseCode.peer_unknown_critical), link.closes)
        link.closes.clear()
        routeRecord(link, s, 0x0013, ByteArray(0)) // CONTACT: not the host's, ignored
        routeRecord(link, s, 0x80ff, ByteArray(0))
        routeRecord(link, null, 0x0100, ByteArray(0))
        assertTrue(link.closes.isEmpty())
    }

    @Test
    fun noSecretInAToString() {
        val s = session()
        assertEquals("ConnectSession(peer=AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH, path=lan, role=initiator)", s.toString())
        assertEquals("SessionMessage(type=256, 3 bytes)", msg(3).toString())
    }

    // -- two real links over in-memory pipes ------------------------------------------------------

    private class MemPipe(override val remoteAddress: String) : PeerPipe {
        val inbox = Channel<ByteArray>(Channel.UNLIMITED)
        var other: MemPipe? = null

        override suspend fun read(): ByteArray? = inbox.receiveCatching().getOrNull()

        override suspend fun write(bytes: ByteArray) {
            other!!.inbox.trySend(bytes.copyOf())
        }

        override fun close() {
            inbox.close()
            other?.inbox?.close()
        }
    }

    private class Device(val id: String, val port: DeviceKeyPort, val signKey: String, val agreeKey: String)

    private fun device(id: String): Device = runBlocking {
        val port = DeviceKeyStore(InMemoryDeviceKeyStorage())
        val k = port.ensure()
        Device(id, port, k.signKey, k.agreeKey)
    }

    private fun ring(devs: List<Device>, epoch: Long): String = signer.sign(
        "pkey-ring+jws",
        JsonObject(
            mapOf(
                "iss" to JsonPrimitive("key.plrs.im"),
                "aud" to JsonPrimitive("djdl"),
                "sub" to JsonPrimitive(sub),
                "epoch" to jsonInt(epoch),
                "issuedAt" to jsonInt(now - 10),
                "expiresAt" to jsonInt(now + 600_000),
                "devices" to JsonArray(
                    devs.sortedBy { it.id }.map {
                        JsonObject(
                            mapOf(
                                "deviceId" to JsonPrimitive(it.id),
                                "signKey" to JsonPrimitive(it.signKey),
                                "agreeKey" to JsonPrimitive(it.agreeKey),
                            ),
                        )
                    },
                ),
            ),
        ),
    )

    private fun source(d: Device, all: List<Device>, epoch: Long, disc: ByteArray): PeerSource {
        val cert = signer.sign(
            "pkey-peer+jws",
            JsonObject(
                mapOf(
                    "iss" to JsonPrimitive("key.plrs.im"), "aud" to JsonPrimitive("djdl"), "sub" to JsonPrimitive(sub),
                    "deviceId" to JsonPrimitive(d.id), "signKey" to JsonPrimitive(d.signKey), "agreeKey" to JsonPrimitive(d.agreeKey),
                    "ringEpoch" to jsonInt(epoch), "issuedAt" to jsonInt(now - 10), "expiresAt" to jsonInt(now + 1000),
                ),
            ),
        )
        return PeerSource(
            slug = "djdl", trust = signer.trust, sub = sub, deviceId = d.id, certificate = cert, certificateExpiresAt = now + 1000,
            ring = ring(all, epoch), ringEpoch = epoch, roster = all.map { it.id }, discovery = DiscoveryKeys(disc, null),
            agreePublic = Base64Url.decodeStrict(d.agreeKey)!!, keys = d.port,
        )
    }

    private class Rig(
        val a: PeerLink<ConnectSession>,
        val b: PeerLink<ConnectSession>,
        val sa: ConnectSession,
        val sb: ConnectSession,
        val docsB: PeerDocs?,
    )

    private val idA = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
    private val idB = "HHHHGGGGFFFFEEEEDDDDCCCCBBBBAAAA"

    private suspend fun connect(
        scope: CoroutineScope,
        epochA: Long = 1,
        epochB: Long = 1,
        docsB: PeerDocs? = null,
        budgetB: QueueBudget? = null,
    ): Rig {
        val da = device(idA)
        val db = device(idB)
        val all = listOf(da, db)
        val k = ByteArray(32) { 5 }
        val pa = MemPipe("10.0.0.1")
        val pb = MemPipe("10.0.0.2")
        pa.other = pb
        pb.other = pa
        val baseA = ChannelBase(source(da, all, epochA, k), caps = listOf("app/1"), now = { now })
        val baseB = ChannelBase(source(db, all, epochB, k), caps = listOf("app/1"), now = { now })
        val a = PeerLink(pa, scope, sessionHandlers(NoiseRole.initiator), build = baseA.builder(NoiseRole.initiator))
        val b = PeerLink(pb, scope, sessionHandlers(NoiseRole.responder, docs = docsB, budget = budgetB), build = baseB.builder(NoiseRole.responder))
        scope.launch { a.run() }
        scope.launch { b.run() }
        val sa = openInitiator(a)
        val sb = b.opened.await()
        return Rig(a, b, sa, sb, docsB)
    }

    private fun ChannelBase.builder(
        role: NoiseRole,
    ): (send: (ByteArray) -> Unit, onEvent: (SessionEvent) -> Unit) -> im.plrs.key.core.peer.PeerChannel =
        { send, onEvent -> channel(role, send, onEvent) }

    private fun scope() = CoroutineScope(Dispatchers.Default + Job())

    @Test
    fun twoSessionsExchangeMessagesAndEndTogether() = bounded {
        val s = scope()
        try {
            val r = connect(s)
            assertEquals(idB, r.sa.peerDeviceId)
            assertEquals(idA, r.sb.peerDeviceId)
            assertEquals(listOf("app/1"), r.sa.caps)
            assertEquals("djdl", r.sa.hello.app)
            assertEquals("10.0.0.1", r.sa.remoteAddress)
            r.sa.send("hello".toByteArray())
            r.sa.send("typed".toByteArray(), 0x0200)
            assertEquals("hello", String(r.sb.receive(5000).body))
            assertEquals(0x0200, r.sb.receive(5000).type)
            r.sb.send("back".toByteArray())
            assertEquals("back", String(r.sa.receive(5000).body))
            val closed = Channel<SessionClosed>(Channel.UNLIMITED)
            r.sb.onClose { closed.trySend(it) }
            r.sa.close()
            assertEquals(SessionClosed("peer_bye", true), closed.receive())
            assertEquals(
                SessionClosed("peer_bye", false),
                r.sa.closed ?: run {
                    delay(100)
                    r.sa.closed
                },
            )
        } finally {
            s.cancel()
        }
    }

    @Test
    fun anUnknownAppCriticalRecordClosesTheSession() = bounded {
        val s = scope()
        try {
            val r = connect(s)
            val closed = Channel<SessionClosed>(Channel.UNLIMITED)
            r.sa.onClose { closed.trySend(it) }
            r.sa.sendRecord(0x8100, ByteArray(0))
            assertEquals(SessionClosed("peer_unknown_critical", true), closed.receive())
            assertEquals(
                "peer_unknown_critical",
                r.sb.closed?.code ?: run {
                    delay(100)
                    r.sb.closed?.code
                },
            )
        } finally {
            s.cancel()
        }
    }

    @Test
    fun aPeerThatOutrunsTheHostIsClosedPeerBusy() = bounded {
        val s = scope()
        try {
            val r = connect(s)
            val closed = Channel<SessionClosed>(Channel.UNLIMITED)
            r.sa.onClose { closed.trySend(it) }
            repeat(MAX_QUEUED_MESSAGES + 1) { r.sa.send(ByteArray(1)) }
            assertEquals(SessionClosed("peer_busy", true), closed.receive())
        } finally {
            s.cancel()
        }
    }

    @Test
    fun aSessionWithoutAHostListenerStillQueuesAndAHandshakeRefusalIsTyped() = bounded {
        val s = scope()
        try {
            val da = device(idA)
            val db = device(idB)
            val pa = MemPipe("10.0.0.1")
            val pb = MemPipe("10.0.0.2")
            pa.other = pb
            pb.other = pa
            // Different discovery keys: the responder cannot read message 1 and closes silently.
            val baseA = ChannelBase(source(da, listOf(da, db), 1, ByteArray(32) { 5 }), now = { now })
            val baseB = ChannelBase(source(db, listOf(da, db), 1, ByteArray(32) { 6 }), now = { now })
            val a = PeerLink(pa, s, sessionHandlers(NoiseRole.initiator), 0.3, baseA.builder(NoiseRole.initiator))
            val b = PeerLink(pb, s, sessionHandlers(NoiseRole.responder), 0.3, baseB.builder(NoiseRole.responder))
            s.launch { a.run() }
            s.launch { b.run() }
            try {
                waitOpenedFor(a)
                fail("not admitted")
            } catch (e: LanException) {
                assertEquals(LanErrorReason.handshake_failed, e.reason)
                assertNotNull(e.closeCode)
            }
            try {
                b.opened.await()
                fail("not admitted")
            } catch (e: LinkRefused) {
                assertEquals("handshake_failed", e.closeCode)
            }
        } finally {
            s.cancel()
        }
    }

    private suspend fun waitOpenedFor(a: PeerLink<ConnectSession>) {
        a.start()
        waitOpened(a.opened, 5000)
    }

    // -- pushed documents ------------------------------------------------------------------------

    private fun docs(
        adopt: (suspend (String) -> RingAdoption)? = null,
        apply: (suspend (String) -> PeerTrustResult)? = null,
        refresh: (suspend () -> Unit)? = null,
        clock: () -> Long = { now },
        timers: ArrayList<Pair<Double, () -> Unit>> = ArrayList(),
        notices: ArrayList<ConnectNotice> = ArrayList(),
        onStored: () -> Unit = {},
    ): PeerDocs {
        val d = PeerDocs(
            PeerDocsSource(clock, refresh, adopt, apply),
            onStored,
            spawn = { job -> runBlocking { job() } },
            timer = { secs, fn ->
                timers += secs to fn;
                {}
            },
        )
        d.onNotice { notices += it }
        return d
    }

    @Test
    fun aPushedRosterIsStoredReportedAndTriggersOneRefresh() {
        val notices = ArrayList<ConnectNotice>()
        var refreshes = 0
        var stored = 0
        val d = docs(
            adopt = { RingAdoption.Stored(7) },
            refresh = { refreshes++ },
            notices = notices,
            onStored = { stored++ },
        )
        d.onRing("ring.jws", 7)
        assertEquals(listOf(ConnectNotice(NoticeType.ring, NoticeOutcome.stored, epoch = 7)), notices)
        assertEquals(1, refreshes)
        assertEquals(2, stored) // the store, then the refresh
        assertEquals(7L, d.pushed?.epoch)
        d.onRing("older.jws", 3)
        assertEquals(7L, d.pushed?.epoch)
    }

    @Test
    fun aRefusedRosterIsReportedWithItsReasonAndNothingElseHappens() {
        val notices = ArrayList<ConnectNotice>()
        var refreshes = 0
        val d = docs(adopt = { RingAdoption.Refused("other_subject") }, refresh = { refreshes++ }, notices = notices)
        d.ring("x.y.z")
        assertEquals(listOf(ConnectNotice(NoticeType.ring, NoticeOutcome.refused, reason = "other_subject")), notices)
        assertEquals(0, refreshes)
    }

    @Test
    fun refreshRunsOnceAMinuteAndADeferredRetryCoversTheRest() {
        var t = now
        val timers = ArrayList<Pair<Double, () -> Unit>>()
        var refreshes = 0
        val d = docs(adopt = { RingAdoption.Stored(it.length.toLong()) }, refresh = { refreshes++ }, clock = { t }, timers = timers)
        d.ring("a")
        assertEquals(1, refreshes)
        t += 10
        d.ring("bb") // inside the minute: a retry is set for the end of the gap
        assertEquals(1, refreshes)
        assertEquals(1, timers.size)
        assertEquals(50.0, timers[0].first, 0.0)
        d.ring("ccc")
        assertEquals(1, timers.size) // one retry at a time
        t += 50
        timers[0].second()
        assertEquals(2, refreshes)
        assertTrue(runBlocking { !d.wantRing() }) // the minute started again
    }

    @Test
    fun aFailedRefreshIsRetriedAFewTimesThenStops() {
        var t = now
        val timers = ArrayList<Pair<Double, () -> Unit>>()
        var calls = 0
        val d = docs(adopt = { RingAdoption.Stored(1) }, refresh = {
            calls++
            error("offline")
        }, clock = { t }, timers = timers)
        d.ring("a")
        repeat(10) {
            if (timers.isNotEmpty()) {
                t += 60
                timers.removeAt(0).second()
            }
        }
        assertEquals(6, calls) // the first try and five retries
        assertTrue(timers.isEmpty())
    }

    @Test
    fun aNewerRosterHintRefreshesWithoutStoringAnything() {
        var refreshes = 0
        val d = docs(refresh = { refreshes++ })
        d.onRingWanted()
        assertEquals(1, refreshes)
        d.onRingWanted() // inside the minute and not a retry
        assertEquals(1, refreshes)
        assertFalse(runBlocking { docs().wantRing() }) // no refresh configured
    }

    @Test
    fun trustIsAppliedOrRefusedWithTheCustodiansReason() {
        val notices = ArrayList<ConnectNotice>()
        val d = docs(apply = { if (it == "good") PeerTrustResult(true) else PeerTrustResult(false, "not_newer") }, notices = notices)
        d.onTrust("good")
        d.onTrust("old")
        assertEquals(
            listOf(
                ConnectNotice(NoticeType.trust, NoticeOutcome.applied),
                ConnectNotice(NoticeType.trust, NoticeOutcome.refused, reason = "not_newer"),
            ),
            notices,
        )
    }

    @Test
    fun withoutAClientCallTheDocumentIsRefusedUnsupported() {
        val notices = ArrayList<ConnectNotice>()
        val d = docs(notices = notices)
        d.ring("r")
        d.trust("t")
        assertEquals(
            listOf(
                ConnectNotice(NoticeType.ring, NoticeOutcome.refused, reason = "unsupported"),
                ConnectNotice(NoticeType.trust, NoticeOutcome.refused, reason = "unsupported"),
            ),
            notices,
        )
    }

    @Test
    fun aDocumentThatThrowsIsRefusedFailedAndFreesItsSlot() {
        val notices = ArrayList<ConnectNotice>()
        val d = docs(apply = { error("boom") }, notices = notices)
        d.trust("t")
        d.trust("t") // not stuck as "already queued"
        assertEquals(2, notices.count { it == ConnectNotice(NoticeType.trust, NoticeOutcome.refused, reason = "failed") })
    }

    @Test
    fun atMostEightDocumentsWaitTheLastSlotIsForARosterAndBusyNoticesAreRateLimited() {
        val notices = ArrayList<ConnectNotice>()
        val queue = ArrayList<suspend () -> Unit>()
        var t = now
        val d = PeerDocs(
            PeerDocsSource({ t }, null, { RingAdoption.Stored(1) }, { PeerTrustResult(true) }),
            {},
            spawn = { queue += it },
            timer = { _, _ -> {} },
        )
        d.onNotice { notices += it }
        repeat(7) { d.trust("t$it") }
        assertTrue(notices.isEmpty())
        d.trust("t7") // the eighth slot is kept for a roster
        d.trust("t8")
        assertEquals(listOf(ConnectNotice(NoticeType.trust, NoticeOutcome.refused, reason = "busy")), notices)
        d.ring("r") // a roster may take the last slot
        assertEquals(1, notices.size)
        d.ring("r2") // now eight wait
        assertEquals(2, notices.size)
        assertEquals(NoticeType.ring, notices[1].type)
        t += 2
        d.trust("t9")
        assertEquals(3, notices.size)
        d.trust("t0") // already waiting: refused, but inside the second
        assertEquals(3, notices.size)
        runBlocking { queue.forEach { it() } }
        assertEquals(8, notices.count { it.outcome == NoticeOutcome.applied || it.outcome == NoticeOutcome.stored })
    }

    @Test
    fun closeStopsTheWorkerNothingQueuedRunsAndNothingStartsAfterIt() {
        val scope = CoroutineScope(Dispatchers.Default + Job())
        try {
            val started = java.util.concurrent.CountDownLatch(1)
            val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
            val adopted = java.util.concurrent.atomic.AtomicInteger()
            val refreshes = java.util.concurrent.atomic.AtomicInteger()
            val d = PeerDocs(
                PeerDocsSource({ now }, { refreshes.incrementAndGet() }, {
                    started.countDown()
                    gate.await()
                    adopted.incrementAndGet()
                    RingAdoption.Stored(1)
                }, null),
                scope = scope,
            )
            d.ring("r1")
            assertTrue(started.await(5, java.util.concurrent.TimeUnit.SECONDS))
            d.ring("r2")
            d.ring("r3") // queued behind the one in flight
            d.close()
            gate.complete(Unit)
            Thread.sleep(300)
            assertEquals(1, adopted.get()) // only the one already running; the queued two never ran
            assertEquals(0, refreshes.get()) // and it started no refresh
            d.ring("r4")
            assertFalse(runBlocking { d.wantRing() })
            d.onRingWanted()
            Thread.sleep(200)
            assertEquals(1, adopted.get())
            assertEquals(0, refreshes.get())
        } finally {
            scope.cancel()
        }
    }

    @Test
    fun theRefreshGapFollowsTheMonotonicClockNotTheWallClock() {
        var wall = now
        var mono = 1000L
        var refreshes = 0
        val d = PeerDocs(
            PeerDocsSource({ wall }, { refreshes++ }, null, null, { mono }),
            spawn = { job -> runBlocking { job() } },
            timer = { _, _ -> {} },
        )
        assertTrue(runBlocking { d.wantRing() })
        wall -= 6 * 3600 // the wall clock is set back by hours
        mono += 30
        assertFalse(runBlocking { d.wantRing() }) // still inside the minute
        mono += 31
        assertTrue(runBlocking { d.wantRing() }) // the minute has passed whatever the wall clock says
        wall += 24 * 3600 // set forward: no earlier release
        mono += 5
        assertFalse(runBlocking { d.wantRing() })
        assertEquals(2, refreshes)
    }

    @Test
    fun aListenerThatThrowsDoesNotStopTheOthers() {
        val notices = ArrayList<ConnectNotice>()
        val d = docs(apply = { PeerTrustResult(true) }, notices = notices)
        val off = d.onNotice { error("host bug") }
        d.trust("a")
        off()
        d.trust("b")
        assertEquals(2, notices.size)
    }

    @Test
    fun aPushedRosterReachesTheClientThroughTwoRealLinks() = bounded {
        val s = scope()
        try {
            val notices = Channel<ConnectNotice>(Channel.UNLIMITED)
            val adopted = Channel<String>(Channel.UNLIMITED)
            val docsB = PeerDocs(
                PeerDocsSource({ now }, null, {
                    adopted.trySend(it)
                    RingAdoption.Stored(5)
                }, null),
                {},
                scope = s,
            )
            docsB.onNotice { notices.trySend(it) }
            // a holds the newer roster (epoch 5) and pushes it; b holds epoch 1 and asks nothing.
            val r = connectWithEpochs(s, 5, 1, docsB)
            assertNotNull(r)
            assertEquals(ConnectNotice(NoticeType.ring, NoticeOutcome.stored, epoch = 5), notices.receive())
            assertTrue(adopted.receive().isNotEmpty())
            assertEquals(5L, docsB.pushed?.epoch)
        } finally {
            s.cancel()
        }
    }

    private suspend fun connectWithEpochs(s: CoroutineScope, a: Long, b: Long, docs: PeerDocs) = connect(s, a, b, docs)

    @Test
    fun aPushedTrustManifestReachesTheClient() = bounded {
        val s = scope()
        try {
            val got = Channel<String>(Channel.UNLIMITED)
            val docsB = PeerDocs(
                PeerDocsSource({ now }, null, null, {
                    got.trySend(it)
                    PeerTrustResult(true)
                }),
                {},
                scope = s,
            )
            val r = connect(s, docsB = docsB)
            r.sa.sendRecord(RecordType.TRUST, "{\"trust\":\"x.y.z\"}".toByteArray())
            assertEquals("x.y.z", got.receive())
            assertNull(r.sb.closed)
        } finally {
            s.cancel()
        }
    }
}
