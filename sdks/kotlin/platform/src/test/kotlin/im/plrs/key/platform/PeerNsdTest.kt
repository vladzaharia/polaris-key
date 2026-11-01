// @pkey-feature connect.lan
package im.plrs.key.platform

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.Executor

class PeerNsdTest {
    private class Fake : NsdApi {
        val registered = ArrayList<String>()
        val unregistered = ArrayList<Any>()
        var onRegister: ((String?) -> Unit)? = null
        var found: ((String) -> Unit)? = null
        var lost: ((String) -> Unit)? = null
        var resolved: HashMap<String, (NsdResolved) -> Unit> = HashMap()
        var watchLost: HashMap<String, () -> Unit> = HashMap()
        val unwatched = ArrayList<Any>()
        var stoppedDiscovery = 0

        override fun register(instance: String, type: String, port: Int, txt: Map<String, ByteArray>, onResult: (String?) -> Unit): Any {
            registered += instance
            onRegister = onResult
            return "reg-$instance"
        }

        override fun unregister(token: Any) {
            unregistered += token
        }

        override fun discover(type: String, onFound: (String) -> Unit, onLost: (String) -> Unit, onFailed: (String) -> Unit): Any {
            found = onFound
            lost = onLost
            return "disc"
        }

        override fun stopDiscovery(token: Any) {
            stoppedDiscovery++
        }

        override fun watch(instance: String, type: String, executor: Executor, onResolved: (NsdResolved) -> Unit, onLost: () -> Unit, onFailed: (String) -> Unit): Any {
            resolved[instance] = onResolved
            watchLost[instance] = onLost
            return "watch-$instance"
        }

        override fun unwatch(token: Any) {
            unwatched += token
        }
    }

    private val direct = Executor { it.run() }
    private fun nsd(api: Fake, sdk: Int = 34) = PeerNsd(api, direct, sdk)

    private class Rec : PeerNsdListener {
        val events = ArrayList<String>()
        val resolved = ArrayList<NsdResolved>()

        override fun onFound(instance: String) {
            events += "found:$instance"
        }

        override fun onLost(instance: String) {
            events += "lost:$instance"
        }

        override fun onResolved(resolved: NsdResolved) {
            this.resolved += resolved
        }

        override fun onFailed(reason: String) {
            events += "failed:$reason"
        }
    }

    @Test
    fun supportedFromApi34Only() {
        assertFalse(nsd(Fake(), 33).isSupported())
        assertTrue(nsd(Fake(), 34).isSupported())
        assertTrue(nsd(Fake(), 36).isSupported())
        try {
            nsd(Fake(), 33).browse(Rec())
            fail("expected an unsupported refusal")
        } catch (e: IllegalStateException) {
            assertEquals("unsupported", e.message)
        }
    }

    @Test
    fun advertRegistersUnderTheAskedName() {
        val api = Fake()
        var got: NsdAdvertResult? = null
        nsd(api).advertise("p1-aaaaaaaaaaaaaaaa", 4000, mapOf("m" to "a".toByteArray())) { got = it }
        api.onRegister!!("p1-aaaaaaaaaaaaaaaa")
        assertEquals(NsdAdvertResult.Registered, got)
        assertTrue(api.unregistered.isEmpty())
    }

    @Test
    fun aRenamedAdvertIsRefusedAndWithdrawn() {
        val api = Fake()
        var got: NsdAdvertResult? = null
        nsd(api).advertise("p1-aaaaaaaaaaaaaaaa", 4000, emptyMap()) { got = it }
        api.onRegister!!("p1-aaaaaaaaaaaaaaaa (2)")
        assertEquals(NsdAdvertResult.Refused("renamed"), got)
        assertEquals(listOf<Any>("reg-p1-aaaaaaaaaaaaaaaa"), api.unregistered)
    }

    @Test
    fun aFailedRegistrationIsRefused() {
        val api = Fake()
        var got: NsdAdvertResult? = null
        nsd(api).advertise("p1-aaaaaaaaaaaaaaaa", 4000, emptyMap()) { got = it }
        api.onRegister!!(null)
        assertEquals(NsdAdvertResult.Refused("failed"), got)
    }

    @Test
    fun stoppingAnAdvertUnregistersOnce() {
        val api = Fake()
        val h = nsd(api).advertise("p1-aaaaaaaaaaaaaaaa", 4000, emptyMap()) {}
        h.stop()
        h.stop()
        assertEquals(1, api.unregistered.size)
    }

    @Test
    fun browseReportsFoundAndLostOnce() {
        val api = Fake()
        val rec = Rec()
        val h = nsd(api).browse(rec)
        api.found!!("a")
        api.found!!("a")
        api.lost!!("b")
        api.lost!!("a")
        assertEquals(listOf("found:a", "lost:a"), rec.events)
        h.stop()
        assertEquals(1, api.stoppedDiscovery)
    }

    @Test
    fun browseTracksAtMost256Names() {
        val api = Fake()
        val rec = Rec()
        nsd(api).browse(rec)
        for (i in 0 until 300) api.found!!("n$i")
        assertEquals(PeerNsd.MAX_FOUND, rec.events.size)
    }

    @Test
    fun watchPassesResolvedUpdatesAndLoss() {
        val api = Fake()
        val rec = Rec()
        nsd(api).watch("a", rec)
        val r = NsdResolved("a", listOf("192.168.1.5"), 4000, mapOf("m" to "a".toByteArray()), null)
        api.resolved["a"]!!(r)
        api.watchLost["a"]!!()
        assertEquals(listOf(r), rec.resolved)
        assertEquals(listOf("lost:a"), rec.events)
    }

    @Test
    fun watchIsBoundedAt64AndASlotFreesOnStop() {
        val api = Fake()
        val n = nsd(api)
        val handles = (0 until 64).map { n.watch("n$it", Rec()) }
        val over = Rec()
        n.watch("extra", over)
        assertEquals(listOf("failed:limit"), over.events)
        handles[0].stop()
        handles[0].stop()
        assertEquals(1, api.unwatched.size)
        val again = Rec()
        n.watch("extra2", again)
        assertTrue(again.events.isEmpty())
    }

    @Test
    fun browseDropsRefusedNamesBeforeTheyTakeASlot() {
        val api = Fake()
        val rec = Rec()
        nsd(api).browse(rec, accept = { it == "real" })
        for (i in 0 until 400) api.found!!("forged$i")
        api.found!!("real")
        assertEquals(listOf("found:real"), rec.events)
    }

    @Test
    fun addressesAreOrderedSoTheCutNeverDropsIpv4() {
        val v4 = java.net.InetAddress.getByName("192.168.1.9")
        val ll = java.net.InetAddress.getByName("fe80::1")
        val ula = java.net.InetAddress.getByName("fd00::2")
        assertEquals(listOf(v4, ula, ll), orderAddresses(listOf(ll, ula, v4)))
    }

    @Test
    fun refusedAddressesAreDroppedBeforeTheCut() {
        fun ok(t: String) = lanCandidate(java.net.InetAddress.getByName(t))
        assertTrue(ok("192.168.1.2") && ok("10.1.2.3") && ok("172.31.0.1") && ok("fd00::2") && ok("fe80::1") && ok("2606:4700::1"))
        assertFalse(ok("100.64.0.1") || ok("169.254.1.1") || ok("8.8.8.8") || ok("172.32.0.1") || ok("127.0.0.1"))
        assertFalse(ok("::1") || ok("ff02::1") || ok("2001:0:1::1") || ok("2002::1"))
    }
}
