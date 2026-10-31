// @pkey-feature connect.transfer
//
// Direct Transfer (CC-20.7; WIRE-CONTRACT-V5 section 15.11) between two real sessions over in-memory pipes:
// an offer that is accepted and delivered, a decline (no handler, and the handler's), an answer given later, a
// consent that runs out, a cancel from either side, a resume after a dropped session, a hash that does not match,
// names that stay display data, an empty transfer, the partial store's layout and a session without `xfer/1`.
// The machine itself is checked row by row in :conformance (`PeerMatrixXferTest`).

package im.plrs.key.sdk

import im.plrs.key.core.peer.XferReason
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest

internal class CloudTransferTest {
    private val rigs = ConnectSessionTest()
    private val xfer = listOf("app/1", "xfer/1")
    private val scopes = ArrayList<CoroutineScope>()
    private val dirs = ArrayList<File>()
    private val transfers = ArrayList<CloudTransfer>()

    @After
    fun cleanUp() {
        transfers.forEach { it.shutdown() }
        scopes.forEach { it.cancel() }
        dirs.forEach { it.deleteRecursively() }
    }

    private fun <T> bounded(block: suspend () -> T): T = runBlocking { withTimeout(20_000) { block() } }

    private fun scope() = CoroutineScope(Dispatchers.Default + Job()).also { scopes += it }

    private fun dir(): File = Files.createTempDirectory("pkey-xfer-test").toFile().also { dirs += it }

    private fun content(n: Int): ByteArray = ByteArray(n) { ((it * 7 + 13) and 0xff).toByte() }

    private fun partFiles(state: File): List<File> = File(state, "xfer").listFiles()?.filter { it.name.endsWith(".part") } ?: emptyList()

    /** Two sides with their transfer layer bound; [speed] runs both clocks faster than real time. */
    private inner class Side(val state: File = dir(), speed: Double = 1.0) {
        val transfer = CloudTransfer({ state }, { true }, speed).also { transfers += it }
    }

    private suspend fun waitFor(what: String, cond: () -> Boolean) {
        repeat(400) {
            if (cond()) return
            delay(25)
        }
        fail("timed out waiting for $what")
    }

    /** A source that reads from [bytes] and can be made to wait before the [stallAt]th read, until released. */
    private class Probe(
        val bytes: ByteArray,
        override val name: String? = null,
        val stallAt: Int = Int.MAX_VALUE,
        private val declared: String? = null,
    ) : TransferSource {
        val offsets = java.util.Collections.synchronizedList(ArrayList<Long>())
        val release = CompletableDeferred<Unit>()
        override val size: Long = bytes.size.toLong()
        override val sha256: String = declared ?: MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

        override suspend fun read(offset: Long, length: Int): ByteArray {
            offsets += offset
            if (offsets.size >= stallAt) release.await()
            return bytes.copyOfRange(offset.toInt(), offset.toInt() + length)
        }
    }

    @Test
    fun anAcceptedOfferIsDeliveredToTheChosenFile() = bounded {
        val r = rigs.connect(scope(), caps = xfer)
        val a = Side()
        val b = Side()
        a.transfer.bind(r.sa)
        b.transfer.bind(r.sb)
        val data = content(200_000)
        val dst = File(dir(), "got.bin")
        val seen = Channel<TransferOffer>(Channel.UNLIMITED)
        val results = Channel<TransferResult>(Channel.UNLIMITED)
        b.transfer.onResult { results.trySend(it) }
        b.transfer.onOffer {
            seen.trySend(it)
            OfferDecision.Accept(dst)
        }
        val h = a.transfer.send(r.sa, TransferSource.ofBytes(data, "report.bin", "application/octet-stream"))
        val res = h.await()
        assertEquals(TransferOutcome.delivered, res.outcome)
        val offer = seen.receive()
        assertEquals("report.bin", offer.name)
        assertEquals("application/octet-stream", offer.type)
        assertEquals(200_000L, offer.size)
        val got = results.receive()
        assertTrue(got.incoming)
        assertEquals(TransferOutcome.delivered, got.outcome)
        assertEquals(dst, got.destination)
        assertArrayEquals(data, dst.readBytes())
        assertTrue("no partial file is left", partFiles(b.state).isEmpty())
        assertTrue("no temporary file is left", dst.parentFile.listFiles()!!.all { !it.name.endsWith(".tmp") })
    }

    @Test
    fun withoutAHandlerEveryOfferIsDeclined() = bounded {
        val r = rigs.connect(scope(), caps = xfer)
        val a = Side()
        val b = Side()
        a.transfer.bind(r.sa)
        b.transfer.bind(r.sb)
        val h = a.transfer.send(r.sa, TransferSource.ofBytes(content(1000), "x"))
        try {
            h.await()
            fail("declined")
        } catch (e: TransferCancelledException) {
            assertEquals(XferReason.declined, e.reason)
            assertEquals("transfer-cancelled", e.code)
        }
        assertTrue(partFiles(b.state).isEmpty())
    }

    @Test
    fun theHandlerCanDeclineAndAnswerLater() = bounded {
        val r = rigs.connect(scope(), caps = xfer)
        val a = Side()
        val b = Side()
        a.transfer.bind(r.sa)
        b.transfer.bind(r.sb)
        val dst = File(dir(), "later.bin")
        val pending = Channel<TransferOffer>(Channel.UNLIMITED)
        var round = 0
        b.transfer.onOffer {
            when (round++) {
                0 -> OfferDecision.Decline
                else -> {
                    pending.trySend(it)
                    OfferDecision.Ask
                }
            }
        }
        val first = a.transfer.send(r.sa, TransferSource.ofBytes(content(10), "a"))
        try {
            first.await()
            fail("declined")
        } catch (e: TransferCancelledException) {
            assertEquals(XferReason.declined, e.reason)
        }
        val data = content(70_000)
        val second = a.transfer.send(r.sa, TransferSource.ofBytes(data, "b"))
        val offer = pending.receive()
        assertFalse(offer.isWithdrawn)
        offer.accept(dst)
        assertEquals(TransferOutcome.delivered, second.await().outcome)
        assertArrayEquals(data, dst.readBytes())
    }

    @Test
    fun aConsentThatRunsOutEndsWithATimeoutAndWithdrawsTheQuestion() = bounded {
        val r = rigs.connect(scope(), caps = xfer)
        // 120 seconds of consent last 0.12 s here.
        val a = Side(speed = 1000.0)
        val b = Side(speed = 1000.0)
        a.transfer.bind(r.sa)
        b.transfer.bind(r.sb)
        val pending = Channel<TransferOffer>(Channel.UNLIMITED)
        b.transfer.onOffer {
            pending.trySend(it)
            OfferDecision.Ask
        }
        val h = a.transfer.send(r.sa, TransferSource.ofBytes(content(100), "slow"))
        val offer = pending.receive()
        try {
            h.await()
            fail("timeout")
        } catch (e: TransferCancelledException) {
            assertEquals(XferReason.timeout, e.reason)
        }
        waitFor("the question to be withdrawn") { offer.isWithdrawn }
    }

    @Test
    fun theSenderCanCancelAnActiveTransfer() = bounded {
        val r = rigs.connect(scope(), caps = xfer)
        val a = Side()
        val b = Side()
        a.transfer.bind(r.sa)
        b.transfer.bind(r.sb)
        val results = Channel<TransferResult>(Channel.UNLIMITED)
        b.transfer.onResult { results.trySend(it) }
        b.transfer.onOffer { OfferDecision.Accept(File(dir(), "never.bin")) }
        val src = Probe(content(2_000_000), "big", stallAt = 3)
        val h = a.transfer.send(r.sa, src)
        waitFor("the third read") { src.offsets.size >= 3 }
        h.cancel()
        src.release.complete(Unit)
        val got = results.receive()
        assertEquals(TransferOutcome.cancelled, got.outcome)
        assertEquals(XferReason.cancelled, got.reason)
        try {
            h.await()
            fail("cancelled")
        } catch (e: TransferCancelledException) {
            assertEquals(XferReason.cancelled, e.reason)
        }
        assertTrue("a cancelled receive leaves no partial", partFiles(b.state).isEmpty())
    }

    @Test
    fun theReceiverCanCancelAnActiveTransfer() = bounded {
        val r = rigs.connect(scope(), caps = xfer)
        val a = Side()
        val b = Side()
        a.transfer.bind(r.sa)
        b.transfer.bind(r.sb)
        val offers = Channel<TransferOffer>(Channel.UNLIMITED)
        b.transfer.onOffer {
            offers.trySend(it)
            OfferDecision.Accept(File(dir(), "never.bin"))
        }
        val src = Probe(content(2_000_000), "big", stallAt = 3)
        val h = a.transfer.send(r.sa, src)
        val offer = offers.receive()
        waitFor("the third read") { src.offsets.size >= 3 }
        b.transfer.cancel(r.sb, offer.id)
        src.release.complete(Unit)
        try {
            h.await()
            fail("cancelled")
        } catch (e: TransferCancelledException) {
            assertEquals(XferReason.cancelled, e.reason)
        }
        waitFor("the partial to go") { partFiles(b.state).isEmpty() }
    }

    @Test
    fun aDroppedSessionResumesAtTheVerifiedOffset() = bounded {
        val scope = scope()
        val devices = rigs.devices()
        val a = Side()
        val b = Side()
        val dst = File(dir(), "resumed.bin")
        val data = content(1_000_000)
        val first = rigs.connect(scope, caps = xfer, devices = devices)
        a.transfer.bind(first.sa)
        b.transfer.bind(first.sb)
        val closed = Channel<TransferResult>(Channel.UNLIMITED)
        b.transfer.onResult { closed.trySend(it) }
        b.transfer.onOffer { OfferDecision.Accept(dst) }
        val stalled = Probe(data, "big", stallAt = 6)
        val h = a.transfer.send(first.sa, stalled)
        waitFor("five chunks on disk") { partFiles(b.state).singleOrNull()?.length() == 5L * 61_440 }
        first.sa.close()
        assertEquals(TransferOutcome.closed, closed.receive().outcome)
        stalled.release.complete(Unit)
        assertEquals("the partial is kept", 1, partFiles(b.state).size)
        assertFalse(dst.exists())

        val second = rigs.connect(scope, caps = xfer, devices = devices)
        a.transfer.bind(second.sa)
        b.transfer.bind(second.sb)
        val again = Probe(data, "big")
        val h2 = a.transfer.send(second.sa, again, TransferSendOptions(id = h.id))
        assertEquals(TransferOutcome.delivered, h2.await().outcome)
        assertEquals("resumed after the five chunks that were verified", 5L * 61_440, again.offsets.first())
        assertArrayEquals(data, dst.readBytes())
        assertTrue(partFiles(b.state).isEmpty())
    }

    @Test
    fun aHashThatDoesNotMatchDeliversNothing() = bounded {
        val r = rigs.connect(scope(), caps = xfer)
        val a = Side()
        val b = Side()
        a.transfer.bind(r.sa)
        b.transfer.bind(r.sb)
        val dst = File(dir(), "bad.bin")
        b.transfer.onOffer { OfferDecision.Accept(dst) }
        val wrong = "0".repeat(64)
        val h = a.transfer.send(r.sa, Probe(content(5000), "x", declared = wrong))
        try {
            h.await()
            fail("hash")
        } catch (e: TransferCancelledException) {
            assertEquals(XferReason.hash, e.reason)
        }
        assertFalse(dst.exists())
        assertTrue(partFiles(b.state).isEmpty())
    }

    @Test
    fun aTraversalShapedNameStaysDisplayData() = bounded {
        val r = rigs.connect(scope(), caps = xfer)
        val a = Side()
        val b = Side()
        a.transfer.bind(r.sa)
        b.transfer.bind(r.sb)
        val outer = dir()
        val inner = File(outer, "inbox").also { it.mkdirs() }
        val dst = File(inner, "chosen.bin")
        val src = Probe(content(100_000), "../../etc/passwd", stallAt = 2)
        val shown = Channel<String?>(Channel.UNLIMITED)
        b.transfer.onOffer {
            shown.trySend(it.name)
            OfferDecision.Accept(dst)
        }
        val h = a.transfer.send(r.sa, src, TransferSendOptions(type = "text/plain"))
        assertEquals("../../etc/passwd", shown.receive())
        waitFor("a partial file") { partFiles(b.state).isNotEmpty() }
        for (f in File(b.state, "xfer").listFiles()!!) {
            assertTrue("named by the derived path only: ${f.name}", Regex("[0-9a-f]{64}\\.(part|json)").matches(f.name))
        }
        src.release.complete(Unit)
        assertEquals(TransferOutcome.delivered, h.await().outcome)
        assertEquals(listOf("chosen.bin"), inner.list()!!.toList())
        assertEquals(listOf("inbox"), outer.list()!!.toList())
    }

    @Test
    fun anEmptyTransferWritesAnEmptyFile() = bounded {
        val r = rigs.connect(scope(), caps = xfer)
        val a = Side()
        val b = Side()
        a.transfer.bind(r.sa)
        b.transfer.bind(r.sb)
        val dst = File(dir(), "empty.bin")
        b.transfer.onOffer { OfferDecision.Accept(dst) }
        assertEquals(TransferOutcome.delivered, a.transfer.send(r.sa, TransferSource.ofBytes(ByteArray(0), "e")).await().outcome)
        assertTrue(dst.isFile)
        assertEquals(0L, dst.length())
    }

    @Test
    fun theLimitsOfTheReceiverAreRefusedWithTheirReasons() = bounded {
        val r = rigs.connect(scope(), caps = xfer)
        val a = Side()
        val b = Side()
        b.transfer.maxIncomingBytes = 10
        a.transfer.bind(r.sa)
        b.transfer.bind(r.sb)
        b.transfer.onOffer { OfferDecision.Accept(File(dir(), "big.bin")) }
        try {
            a.transfer.send(r.sa, TransferSource.ofBytes(content(11), "big")).await()
            fail("size")
        } catch (e: TransferCancelledException) {
            assertEquals(XferReason.size, e.reason)
        }
    }

    @Test
    fun aSessionWithoutTheCapabilityCarriesNoTransfers() = bounded {
        val r = rigs.connect(scope())
        val a = Side()
        a.transfer.bind(r.sa)
        assertFalse(r.sa.canTransfer)
        try {
            a.transfer.send(r.sa, TransferSource.ofBytes(content(1), "x"))
            fail("unavailable")
        } catch (e: TransferUnavailableException) {
            assertNotNull(e.message)
        }
    }

    @Test
    fun aNameThePeerWouldRefuseIsRefusedBeforeAnythingIsSent() = bounded {
        val r = rigs.connect(scope(), caps = xfer)
        val a = Side()
        a.transfer.bind(r.sa)
        try {
            a.transfer.send(r.sa, TransferSource.ofBytes(content(1), "x".repeat(300)))
            fail("name")
        } catch (e: IllegalArgumentException) {
            assertNotNull(e.message)
        }
        try {
            a.transfer.send(r.sa, TransferSource.ofBytes(content(1), "x"), TransferSendOptions(category = "Not Valid"))
            fail("category")
        } catch (e: IllegalArgumentException) {
            assertNotNull(e.message)
        }
    }

    @Test
    fun purgeDeletesTheKeptPartials() = bounded {
        val scope = scope()
        val devices = rigs.devices()
        val a = Side()
        val b = Side()
        val first = rigs.connect(scope, caps = xfer, devices = devices)
        a.transfer.bind(first.sa)
        b.transfer.bind(first.sb)
        b.transfer.onOffer { OfferDecision.Accept(File(dir(), "p.bin")) }
        val stalled = Probe(content(400_000), "big", stallAt = 3)
        a.transfer.send(first.sa, stalled)
        waitFor("a partial") { partFiles(b.state).isNotEmpty() }
        first.sa.close()
        stalled.release.complete(Unit)
        delay(200)
        assertTrue(partFiles(b.state).isNotEmpty())
        b.transfer.purgeAll()
        assertFalse(File(b.state, "xfer").exists())
    }

    /** The first partial's bytes on disk, shortened or removed to make the partial unreadable at accept. */
    private suspend fun resumeAfterDamage(damage: (File) -> Unit) {
        val scope = scope()
        val devices = rigs.devices()
        val a = Side()
        val b = Side()
        val dst = File(dir(), "fresh.bin")
        val data = content(1_000_000)
        val first = rigs.connect(scope, caps = xfer, devices = devices)
        a.transfer.bind(first.sa)
        b.transfer.bind(first.sb)
        val closed = Channel<TransferResult>(Channel.UNLIMITED)
        b.transfer.onResult { closed.trySend(it) }
        b.transfer.onOffer { OfferDecision.Accept(dst) }
        val stalled = Probe(data, "big", stallAt = 6)
        val h = a.transfer.send(first.sa, stalled)
        waitFor("five chunks on disk") { partFiles(b.state).singleOrNull()?.length() == 5L * 61_440 }
        first.sa.close()
        assertEquals(TransferOutcome.closed, closed.receive().outcome)
        stalled.release.complete(Unit)
        val second = rigs.connect(scope, caps = xfer, devices = devices)
        a.transfer.bind(second.sa)
        // The partial is read at bind; it is damaged after that, as when another session finishes or drops it.
        b.transfer.bind(second.sb)
        damage(partFiles(b.state).single())
        val again = Probe(data, "big")
        val h2 = a.transfer.send(second.sa, again, TransferSendOptions(id = h.id))
        assertEquals(TransferOutcome.delivered, h2.await().outcome)
        assertEquals("starts again from 0", 0L, again.offsets.first())
        assertArrayEquals(data, dst.readBytes())
        assertTrue(partFiles(b.state).isEmpty())
    }

    @Test
    fun aPartialThatWentMissingBeforeTheAcceptStartsAgainAtZero() = bounded { resumeAfterDamage { it.delete() } }

    @Test
    fun aPartialThatIsShortBeforeTheAcceptStartsAgainAtZero() = bounded {
        resumeAfterDamage { java.io.RandomAccessFile(it, "rw").use { f -> f.setLength(1000) } }
    }

    @Test
    fun spaceIsReservedAtAcceptSoConcurrentTransfersCannotOvershootTheQuota() = bounded {
        val scope = scope()
        val devices = rigs.devices()
        val a = Side()
        val b = Side()
        b.transfer.storeQuotaBytes = 250_000
        b.transfer.onOffer { OfferDecision.Accept(File(dir(), "q-${System.nanoTime()}.bin")) }
        // One session each, so that a source waiting in one does not hold the others up.
        val sources = List(3) { Probe(content(100_000), "q$it", stallAt = 1) }
        val handles = ArrayList<TransferHandle>()
        for ((i, src) in sources.withIndex()) {
            val r = rigs.connect(scope, caps = xfer, devices = devices)
            a.transfer.bind(r.sa)
            b.transfer.bind(r.sb)
            handles += a.transfer.send(r.sa, src)
            if (i < 2) waitFor("transfer $i to hold its space") { partFiles(b.state).size == i + 1 }
        }
        // The third offer did not fit next to the two accepted ones: refused with `quota`.
        try {
            handles[2].await()
            fail("quota")
        } catch (e: TransferCancelledException) {
            assertEquals(XferReason.quota, e.reason)
        }
        sources.forEach { it.release.complete(Unit) }
        assertEquals(TransferOutcome.delivered, handles[0].await().outcome)
        assertEquals(TransferOutcome.delivered, handles[1].await().outcome)
    }

    @Test
    fun aPurgeClosesTheSessionAndALateWriteDoesNotBringTheStoreBack() = bounded {
        val r = rigs.connect(scope(), caps = xfer)
        val a = Side()
        val b = Side()
        a.transfer.bind(r.sa)
        b.transfer.bind(r.sb)
        b.transfer.onOffer { OfferDecision.Accept(File(dir(), "p.bin")) }
        val src = Probe(content(400_000), "big", stallAt = 3)
        val h = a.transfer.send(r.sa, src)
        waitFor("a partial") { partFiles(b.state).isNotEmpty() }
        b.transfer.purgeAll()
        src.release.complete(Unit)
        try {
            h.await()
            fail("closed")
        } catch (e: LanException) {
            assertEquals(LanErrorReason.closed, e.reason)
        }
        waitFor("the receiving session to close") { r.sb.closed != null }
        delay(200)
        assertFalse(File(b.state, "xfer").exists())
    }

    @Test
    fun aDestinationThatCannotBeWrittenEndsTheSessionNotTheProcess() = bounded {
        val r = rigs.connect(scope(), caps = xfer)
        val a = Side()
        val b = Side()
        a.transfer.bind(r.sa)
        b.transfer.bind(r.sb)
        val blocker = File(dir(), "a-file").also { it.writeText("x") }
        b.transfer.onOffer { OfferDecision.Accept(File(blocker, "inside/out.bin")) }
        val h = a.transfer.send(r.sa, TransferSource.ofBytes(content(5000), "x"))
        try {
            h.await()
            fail("the session closes")
        } catch (e: LanException) {
            assertEquals(LanErrorReason.closed, e.reason)
        }
        waitFor("the receiving session to close") { r.sb.closed != null }
        assertEquals("the partial is kept", 1, partFiles(b.state).size)
    }
}
