// @pkey-feature connect.local
//
// The local-pairing gate's enforcement (WIRE-CONTRACT-V5 section 15.12, "Gates"): reads apply in the order they began, an error
// changes nothing and does not advance the applied read, a cleared gate runs its effects, and a read that said nothing while the
// gate is on is read again. Clocks are injected: no test waits on wall time.

package im.plrs.key.sdk

import im.plrs.key.core.DiscoveryResult
import im.plrs.key.core.ProductDiscoveryDocument
import im.plrs.key.core.ServiceFragment
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.peer.GateState
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

class ConnectLocalGateTest {
    private val keepers = ArrayList<LocalGateKeeper>()

    @After
    fun close() {
        for (k in keepers) k.close()
    }

    private fun keeper(retry: (Int) -> Long = { 60 * 24 * 365L }): LocalGateKeeper =
        LocalGateKeeper(rereadMs = { 365L * 24 * 3_600_000 }, retryMinutes = retry).also { keepers += it }

    private fun doc(connect: ServiceFragment?): DiscoveryResult.Ok {
        val services = ServiceSlug.entries.associateWith { ServiceFragment.disabled } + listOfNotNull(connect?.let { ServiceSlug.connect to it })
        return DiscoveryResult.Ok(ProductDiscoveryDocument("djdl", services = services))
    }

    private val on = doc(ServiceFragment(true, extras = mapOf("localPairing" to JsonPrimitive(true))))
    private val off = doc(ServiceFragment(true, extras = mapOf("localPairing" to JsonPrimitive(false))))

    @Test
    fun readsApplyInTheOrderTheyBeganAndAnOlderAnswerNeverOverwritesANewerOne() = runBlocking {
        val k = keeper()
        k.read(on, 2)
        assertTrue(k.gate.allowed)
        // A slower, older read that says off arrives late: it changes nothing.
        k.read(off, 1)
        assertTrue(k.gate.allowed)
        // A newer one does.
        k.read(off, 3)
        assertFalse(k.gate.allowed)
        k.read(on, 2)
        assertFalse(k.gate.allowed)
    }

    @Test
    fun anErrorChangesNothingAndDoesNotAdvanceTheAppliedRead() = runBlocking {
        val k = keeper()
        k.read(on, 5)
        k.read(DiscoveryResult.Error(503, "down"), 7)
        assertTrue(k.gate.allowed)
        // The error carried number 7: had it advanced the applied read, this older-numbered clearing answer would be dropped.
        k.read(off, 6)
        assertFalse("the clearing read is applied", k.gate.allowed)
    }

    @Test
    fun aNotFoundClearsTheGateAndTheEffectsRunOnceAndTheListenersHearBothMoves() = runBlocking {
        val k = keeper()
        val cleared = AtomicInteger()
        val moved = AtomicInteger()
        k.onCleared = { cleared.incrementAndGet() }
        k.onMoved = { moved.incrementAndGet() }
        k.read(on, 1)
        assertEquals(1, moved.get())
        k.read(DiscoveryResult.NotFound, 2)
        assertEquals(GateState.None, k.gate.state)
        until { cleared.get() == 1 }
        assertEquals(2, moved.get())
        // Off again with nothing cached "on" has no effect to run.
        k.read(off, 3)
        Thread.sleep(50)
        assertEquals(1, cleared.get())
    }

    @Test
    fun aDisabledConnectServiceAndAnAbsentMemberReadAsOff() = runBlocking {
        val k = keeper()
        k.read(doc(ServiceFragment(false, extras = mapOf("localPairing" to JsonPrimitive(true)))), 1)
        assertFalse(k.gate.allowed)
        k.read(doc(ServiceFragment(true)), 2)
        assertFalse(k.gate.allowed)
        k.read(doc(null), 3)
        assertFalse(k.gate.allowed)
        // A string "true" is not the boolean true.
        k.read(doc(ServiceFragment(true, extras = mapOf("localPairing" to JsonPrimitive("true")))), 4)
        assertFalse(k.gate.allowed)
    }

    @Test
    fun aReadThatSaidNothingWhileTheGateIsOnIsReadAgainSoTheSwitchOffReachesIt() = runBlocking {
        val k = keeper(retry = { 0 })
        val again = java.util.concurrent.CountDownLatch(1)
        k.discover = {
            again.countDown()
            // The re-read finds the operator's switch-off.
            k.read(off, 10)
        }
        k.read(on, 1)
        k.read(DiscoveryResult.Error(0, "offline"), 2)
        assertTrue(again.await(5, java.util.concurrent.TimeUnit.SECONDS))
        until { !k.gate.allowed }
    }

    private fun until(cond: () -> Boolean) {
        val end = System.nanoTime() + 5_000_000_000L
        while (!cond()) {
            if (System.nanoTime() > end) throw AssertionError("timed out")
            Thread.sleep(10)
        }
    }
}
