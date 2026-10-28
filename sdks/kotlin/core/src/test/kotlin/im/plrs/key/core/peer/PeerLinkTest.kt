// @pkey-feature connect.app
//
// `PeerLink` (WIRE-CONTRACT-V5 section 15.6, CC-12.10): a channel bound to a byte pipe. Two links over
// in-memory pipes; the handshake limits, loss of the pipe and the read gate. Mirrors the link half of
// sdk-node's `connectHardening.test.ts` and the Python `test_connect_peer_link.py`.

package im.plrs.key.core.peer

import im.plrs.key.core.Base64Url
import im.plrs.key.core.testing.TestSigner
import kotlinx.coroutines.CompletableDeferred
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
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.security.SecureRandom

class PeerLinkTest {
    private val sub = "ps_AAAAAAAAAAAAAAAAAAAAAA"
    private val now = 1_700_001_000L
    private val signer = TestSigner("test-key")
    private val rng = SecureRandom()

    private fun rnd(): ByteArray = ByteArray(32).also { rng.nextBytes(it) }

    private fun b64(b: ByteArray) = Base64Url.encode(b)

    private class MemPipe(override val remoteAddress: String) : PeerPipe {
        val inbox = Channel<ByteArray>(Channel.UNLIMITED)
        var other: MemPipe? = null

        @Volatile var stall = false
        val closedGate = CompletableDeferred<Unit>()

        /** True once a write that was blocked on a peer that never reads has returned (a real socket throws on close). */
        @Volatile var stalledWriteReturned = false

        override suspend fun read(): ByteArray? = inbox.receiveCatching().getOrNull()

        override suspend fun write(bytes: ByteArray) {
            if (stall) {
                try {
                    closedGate.await()
                    throw java.io.IOException("closed")
                } finally {
                    stalledWriteReturned = true
                }
            }
            other!!.inbox.trySend(bytes.copyOf())
        }

        // The far end's stream ends before our own does, so the closing side's link cannot write a CLOSE
        // record into a stream the other side has yet to see end (a real socket close delivers nothing after it).
        override fun close() {
            closedGate.complete(Unit)
            other?.inbox?.close()
            inbox.close()
        }
    }

    private fun pipes(): Pair<MemPipe, MemPipe> {
        val a = MemPipe("10.0.0.1")
        val b = MemPipe("10.0.0.2")
        a.other = b
        b.other = a
        return a to b
    }

    private inner class Dev(val id: String, signByte: Int) {
        val stat = RawNoiseStatic(rnd())
        val pub: ByteArray = runBlocking { stat.publicKey() }
        val signKey = b64(ByteArray(32) { signByte.toByte() })

        val cert: String
            get() = signer.sign(
                "pkey-peer+jws",
                JsonObject(
                    mapOf(
                        "iss" to JsonPrimitive("key.plrs.im"), "aud" to JsonPrimitive("djdl"), "sub" to JsonPrimitive(sub),
                        "deviceId" to JsonPrimitive(id), "signKey" to JsonPrimitive(signKey), "agreeKey" to JsonPrimitive(b64(pub)),
                        "ringEpoch" to JsonPrimitive(1), "issuedAt" to JsonPrimitive(now - 10), "expiresAt" to JsonPrimitive(now + 1000),
                    ),
                ),
            )
    }

    private val idA = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH"
    private val idB = "HHHHGGGGFFFFEEEEDDDDCCCCBBBBAAAA"

    private class Seen {
        val records = Channel<Pair<Int, ByteArray>>(Channel.UNLIMITED)
        val closed = CompletableDeferred<SessionEvent.Closed>()
        val ended = CompletableDeferred<Unit>()
    }

    private fun link(scope: CoroutineScope, pipe: PeerPipe, dev: Dev, role: NoiseRole, disc: ByteArray, seen: Seen, handshakeSeconds: Double = 30.0) =
        PeerLink(
            pipe,
            scope,
            LinkHandlers(
                onEstablished = { _, _ -> Unit },
                onRecord = { _, t, b -> seen.records.trySend(t to b) },
                onClosed = { seen.closed.complete(it) },
                onEnded = { seen.ended.complete(Unit) },
            ),
            handshakeSeconds,
        ) { send, onEvent ->
            PeerChannel(
                role, "djdl", dev.stat,
                AccountContext(signer.trust, "djdl", dev.cert, sub, dev.id, { null }, listOf(disc)),
                HelloInfo("test", "demo"), send, onEvent,
                caps = listOf("app/1"), now = { now },
            )
        }

    private fun scope() = CoroutineScope(Dispatchers.Default + Job())

    private fun <T> bounded(block: suspend () -> T): T = runBlocking { withTimeout(10_000) { block() } }

    private class Pair2(val a: PeerLink<Unit>, val b: PeerLink<Unit>, val sa: Seen, val sb: Seen, val pa: MemPipe, val pb: MemPipe)

    private suspend fun connected(scope: CoroutineScope): Pair2 {
        val (pa, pb) = pipes()
        val k = rnd()
        val sa = Seen()
        val sb = Seen()
        val a = link(scope, pa, Dev(idA, 1), NoiseRole.initiator, k, sa)
        val b = link(scope, pb, Dev(idB, 2), NoiseRole.responder, k, sb)
        scope.launch { a.run() }
        scope.launch { b.run() }
        openInitiator(a)
        b.opened.await()
        return Pair2(a, b, sa, sb, pa, pb)
    }

    @Test
    fun twoLinksHandshakeExchangeRecordsAndClose() = bounded {
        val s = scope()
        try {
            val p = connected(s)
            p.a.sendRecord(0x0100, "hi".toByteArray())
            val (type, body) = p.sb.records.receive()
            assertEquals(0x0100, type)
            assertEquals("hi", String(body))
            assertEquals("10.0.0.1", p.a.remoteAddress)
            p.a.close()
            assertEquals(SessionEvent.Closed("peer_bye", false), p.sa.closed.await())
            assertEquals(SessionEvent.Closed("peer_bye", true), p.sb.closed.await())
            p.sa.ended.await()
            p.sb.ended.await()
            assertTrue(p.a.isEnded && p.b.isEnded)
        } finally {
            s.cancel()
        }
    }

    @Test
    fun aHandshakeFrameOverSixteenKibIsRefused() = bounded {
        val s = scope()
        try {
            val (pa, pb) = pipes()
            val seen = Seen()
            val b = link(s, pb, Dev(idB, 2), NoiseRole.responder, rnd(), seen)
            s.launch { b.run() }
            pa.write(encodeFrame(ByteArray(HANDSHAKE_FRAME_MAX + 1)))
            try {
                b.opened.await()
                fail("must be refused")
            } catch (e: LinkRefused) {
                assertEquals(HANDSHAKE_FAILED, e.closeCode)
            }
            seen.ended.await()
        } finally {
            s.cancel()
        }
    }

    @Test
    fun aZeroLengthFrameEndsTheLinkWithBadFrame() = bounded {
        val s = scope()
        try {
            val (pa, pb) = pipes()
            val b = link(s, pb, Dev(idB, 2), NoiseRole.responder, rnd(), Seen())
            s.launch { b.run() }
            pa.write(byteArrayOf(0, 0))
            try {
                b.opened.await()
                fail("must be refused")
            } catch (e: LinkRefused) {
                assertEquals("peer_bad_frame", e.closeCode)
            }
        } finally {
            s.cancel()
        }
    }

    @Test
    fun aPipeStillUnadmittedAfterTheDeadlineIsClosed() = bounded {
        val s = scope()
        try {
            val (_, pb) = pipes()
            val seen = Seen()
            val b = link(s, pb, Dev(idB, 2), NoiseRole.responder, rnd(), seen, handshakeSeconds = 0.2)
            s.launch { b.run() }
            try {
                b.opened.await()
                fail("must be refused")
            } catch (e: LinkRefused) {
                assertEquals(HANDSHAKE_FAILED, e.closeCode)
            }
            seen.ended.await()
        } finally {
            s.cancel()
        }
    }

    @Test
    fun aLostPipeEndsTheSessionAsConnectionLost() = bounded {
        val s = scope()
        try {
            val p = connected(s)
            p.pa.close()
            assertEquals(SessionEvent.Closed("connection_lost", false), p.sb.closed.await())
            p.sb.ended.await()
        } finally {
            s.cancel()
        }
    }

    @Test
    fun pauseHoldsTheReaderUntilResumed() = bounded {
        val s = scope()
        try {
            val p = connected(s)
            p.b.pause(true)
            // A read already in flight may land; the rest of the records wait for the resume.
            for (m in listOf("one", "two", "three")) p.a.sendRecord(0x0100, m.toByteArray())
            delay(300)
            var early = 0
            while (p.sb.records.tryReceive().isSuccess) early++
            assertTrue(early <= 1)
            p.b.pause(false)
            val rest = List(3 - early) { String(p.sb.records.receive().second) }
            assertEquals(listOf("one", "two", "three").drop(early), rest)
            assertFalse(p.b.isEnded)
        } finally {
            s.cancel()
        }
    }

    @Test
    fun aPeerThatNeverReadsClosesTheLinkPeerBusyAtTheWriteCap() = bounded {
        val s = scope()
        try {
            val p = connected(s)
            p.pa.stall = true // the first write after this one blocks and nothing drains
            val body = ByteArray(1 shl 20)
            repeat(10) {
                try {
                    p.a.sendRecord(0x0100, body)
                } catch (e: IllegalStateException) { /* already closing */ }
            }
            assertEquals(SessionEvent.Closed("peer_busy", false), p.sa.closed.await())
            // F1: the link that ended closed its pipe, so the blocked writer was released (no thread leaks).
            withTimeout(2_000) { p.pa.closedGate.await() }
            val end = System.nanoTime() + 2_000_000_000L
            while (!p.pa.stalledWriteReturned && System.nanoTime() < end) delay(10)
            assertTrue(p.pa.stalledWriteReturned)
        } finally {
            s.cancel()
        }
    }
}
