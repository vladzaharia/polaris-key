// @pkey-feature connect.transfer
//
// Two behaviours of the transfer machine the corpus rows do not reach (WIRE-CONTRACT-V5 section 15.11 "Resume"):
// a kept partial the store can no longer read back is not resumed, and the partial evicted at the limit is never
// one a live transfer holds.

package im.plrs.key.core.peer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class XferMachineTest {
    private val id = "AAAAAAAAAAAAAAAAAAAAAA"
    private val sha = "0".repeat(64)
    private val key = ByteArray(32) { 3 }

    private fun ref(n: Int) = "%064x".format(n)

    private fun offerBody(size: Int, chunk: Int, theId: String = id) =
        """{"id":"$theId","size":$size,"sha256":"$sha","chunk":$chunk}""".toByteArray()

    private fun machine(partials: List<XferPartial>, rehash: ((String, Long) -> java.security.MessageDigest)? = null) = XferMachine(
        XferMachineOptions(
            mode = RecordMode.a,
            caps = listOf(XFER_CAP),
            maxMessage = 1 shl 20,
            peerKey = key,
            handler = XferHandler { XferAnswer.accept },
            partials = partials,
            rehash = rehash,
            newRef = { _, _ -> ref(99) },
        ),
    )

    @Test
    fun aPartialThatCannotBeReadBackStartsAgainAtZeroOnAFreshFile() {
        val kept = XferPartial(ref(1), id, sha, 1000, 10, 80, 0.0)
        val m = machine(listOf(kept)) { _, _ -> throw IOException("gone") }
        val out = m.receive(1.0, XferType.OFFER, offerBody(1000, 10))
        assertEquals(null, out.close)
        assertEquals(listOf("Discard", "Create"), out.partial.map { it::class.simpleName })
        val accept = out.send.single() as XferSend.Accept
        assertEquals(0L, accept.offset)
    }

    @Test
    fun aPartialThatReadsBackIsResumed() {
        val kept = XferPartial(ref(1), id, sha, 1000, 10, 80, 0.0)
        val m = machine(listOf(kept)) { _, _ -> java.security.MessageDigest.getInstance("SHA-256") }
        val out = m.receive(1.0, XferType.OFFER, offerBody(1000, 10))
        assertEquals(listOf("Truncate"), out.partial.map { it::class.simpleName })
        assertEquals(80L, (out.send.single() as XferSend.Accept).offset)
    }

    @Test
    fun theOldestPartialALiveTransferDoesNotHoldIsTheOneEvicted() {
        val eight = (1..XFER_MAX_PARTIALS_PER_PEER).map {
            XferPartial(ref(it), "BBBBBBBBBBBBBBBBBBBB%02d".format(it).take(22), sha, 100, 10, 10, it.toDouble(), held = it == 1)
        }
        val out = machine(eight).receive(50.0, XferType.OFFER, offerBody(100, 10))
        val evict = out.partial.filterIsInstance<XferEffect.Evict>().single()
        assertEquals("the oldest partial is held, so the next oldest goes", ref(2), evict.ref)

        val allHeld = eight.map { it.copy(held = true) }
        val out2 = machine(allHeld).receive(50.0, XferType.OFFER, offerBody(100, 10))
        assertTrue(out2.partial.none { it is XferEffect.Evict })
    }
}
