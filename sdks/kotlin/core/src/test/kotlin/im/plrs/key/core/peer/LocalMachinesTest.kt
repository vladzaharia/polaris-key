// @pkey-feature connect.local
//
// The pieces of :core's local links that the corpus rows cannot reach because they are about threads and a backend's answers
// (WIRE-CONTRACT-V5 section 15.12): the dial budget takes one dial in one step, a zero K is refused whatever the backend does
// with a low-order share, and a share or frame that breaks a rule is a refusal, not an exception.

package im.plrs.key.core.peer

import im.plrs.key.core.DeviceCurves
import im.plrs.key.core.RawEd25519Pair
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger

class LocalMachinesTest {
    /** A backend that answers 32 zero bytes for every agreement, as one that does not refuse a low-order share may. */
    private object ZeroCurves : DeviceCurves {
        override val name: String = "zero"

        override fun ed25519Generate(): RawEd25519Pair = throw UnsupportedOperationException()

        override fun ed25519Sign(seed: ByteArray, message: ByteArray): ByteArray = throw UnsupportedOperationException()

        override fun x25519(privateKey: ByteArray, peer: ByteArray): ByteArray = ByteArray(32)
    }

    @Test
    fun aDialBudgetTakesOneDialInOneStepSoOverlappingDialsCannotMultiplyThem() {
        val budget = DialBudget()
        val taken = AtomicInteger()
        val start = CountDownLatch(1)
        val threads = (0 until 32).map {
            Thread {
                start.await()
                if (budget.takeIfAllowed("48", 0.0).allowed) taken.incrementAndGet()
            }.also { it.start() }
        }
        start.countDown()
        threads.forEach { it.join() }
        assertEquals(LOCAL_DIAL_BUDGET, taken.get())
        // The window slides: 300 s on, the nameplate is dialled again.
        assertTrue(budget.takeIfAllowed("48", 301.0).allowed)
        // Another nameplate has its own budget.
        assertTrue(budget.takeIfAllowed("49", 0.0).allowed)
    }

    @Test
    fun aZeroKIsRefusedWhateverTheBackendDoes() {
        val sid = ByteArray(10)
        val share = ByteArray(32).also { it[0] = 9 }
        assertNull(cpaceIsk(sid, ByteArray(32) { 1 }, share, share, initiator = true, curves = ZeroCurves))
        assertNull(cpaceShare(ByteArray(32) { 1 }, share, ZeroCurves))
        // The scalar is overwritten even when the attempt aborts.
        val scalar = ByteArray(32) { 7 }
        cpaceIsk(sid, scalar, share, share, initiator = false, curves = ZeroCurves)
        assertTrue(scalar.all { it.toInt() == 0 })
    }

    @Test
    fun aFrameOrShareThatBreaksARuleIsARefusalNotAnException() {
        assertTrue(parseC1(ByteArray(3)) is FrameVerdict.Refused)
        assertTrue(parseC2(ByteArray(33) { 0xff.toByte() }) is FrameVerdict.Refused)
        assertFalse(checkShare(ByteArray(32)) is ShareVerdict.Ok)
        val good = ByteArray(32).also { it[0] = 9 }
        assertTrue(checkShare(good) is ShareVerdict.Ok)
        assertArrayEquals(good, (parseC2(encodeC2(good)) as FrameVerdict.Ok).share)
    }

    @Test
    fun theLocalLabelIsCleanedLikeAHelloLabel() {
        assertEquals("Anna Phone", cleanLocalLabel("  Anna\u200b  Phone "))
        assertNull(cleanLocalLabel("\u200b\u200b"))
    }
}
