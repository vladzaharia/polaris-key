// @pkey-feature connect.lan
package im.plrs.key.android

import android.net.Network
import im.plrs.key.core.peer.lan.MdnsAdvert
import im.plrs.key.core.peer.lan.MdnsFound
import im.plrs.key.core.peer.lan.MdnsUnavailableException
import im.plrs.key.platform.NsdAdvertResult
import im.plrs.key.platform.NsdResolved
import im.plrs.key.platform.PeerNsd
import im.plrs.key.platform.PeerNsdListener
import im.plrs.key.platform.Subnet
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.shadows.ShadowNetwork
import java.net.InetAddress
import javax.net.SocketFactory

@RunWith(RobolectricTestRunner::class)
class AndroidMdnsTest {
    private fun refused(block: suspend () -> Unit) {
        assertThrows(MdnsUnavailableException::class.java) { runBlocking { block() } }
    }

    private class FakeNsd(var api: Boolean = true) : NsdPort {
        class Reg(val instance: String, val port: Int, val txt: Map<String, ByteArray>, val onResult: (NsdAdvertResult) -> Unit) {
            var stopped = false
        }

        val regs = ArrayList<Reg>()
        var autoResult: ((String) -> NsdAdvertResult)? = { NsdAdvertResult.Registered }
        var browser: PeerNsdListener? = null
        var browseStopped = false
        val watchers = LinkedHashMap<String, PeerNsdListener>()
        val watchesStopped = ArrayList<String>()

        override fun supported() = api

        override fun advertise(instance: String, port: Int, txt: Map<String, ByteArray>, onResult: (NsdAdvertResult) -> Unit): NsdStop {
            val r = Reg(instance, port, txt, onResult)
            regs += r
            autoResult?.let { onResult(it(instance)) }
            return NsdStop { r.stopped = true }
        }

        var accept: (String) -> Boolean = { true }

        override fun browse(listener: PeerNsdListener, accept: (String) -> Boolean): NsdStop {
            browser = listener
            this.accept = accept
            return NsdStop { browseStopped = true }
        }

        override fun watch(instance: String, listener: PeerNsdListener): NsdStop {
            watchers[instance] = listener
            return NsdStop { watchesStopped += instance }
        }
    }

    private val wifi: Network = ShadowNetwork.newInstance(100)
    private val factory: SocketFactory = SocketFactory.getDefault()

    private class FakeNet(val subnets: List<Subnet>, val factory: SocketFactory?, var notVpn: Boolean = true) : NetworkPort {
        var changed: (() -> Unit)? = null
        var unsubscribed = false

        override fun isNotVpn(network: Network) = notVpn

        override fun subnetsOf(network: Network) = subnets

        override fun factoryOf(network: Network) = factory

        override fun onDefaultNetworkChange(onChange: () -> Unit): NsdStop {
            changed = onChange
            return NsdStop { unsubscribed = true }
        }
    }

    private fun lan() = FakeNet(
        listOf(Subnet(InetAddress.getByName("192.168.1.5"), 24), Subnet(InetAddress.getByName("fe80::1"), 64)),
        factory,
    )

    private fun resolved(
        name: String,
        addrs: List<String>,
        port: Int = 4000,
        attrs: Map<String, ByteArray?> = mapOf("v" to "1".toByteArray()),
        network: Network? = wifi,
    ) = NsdResolved(name, addrs, port, attrs, network)

    @Test
    fun advertiseRegistersOnceOnThePortWithKeyValueTxtAndStopWithdraws() = runBlocking {
        val nsd = FakeNsd()
        val net = lan()
        val mdns = AndroidMdns(nsd, net)
        val h = mdns.advertise(MdnsAdvert("p1-AAAAAAAAAAAAAAAA", 4321, listOf("v=1", "m=a", "h=abc")))
        assertEquals(1, nsd.regs.size)
        val r = nsd.regs[0]
        assertEquals(4321, r.port)
        assertEquals(setOf("v", "m", "h"), r.txt.keys)
        assertEquals("a", String(r.txt.getValue("m")))
        h.stop()
        h.stop()
        assertTrue(r.stopped)
        assertTrue(net.unsubscribed)
    }

    @Test
    fun aRenamedAdvertIsRefusedAndWithdrawn() = runBlocking {
        val nsd = FakeNsd().apply { autoResult = { NsdAdvertResult.Refused("renamed") } }
        val net = lan()
        refused { AndroidMdns(nsd, net).advertise(MdnsAdvert("p1-AAAAAAAAAAAAAAAA", 4321, listOf("v=1"))) }
        assertTrue(nsd.regs[0].stopped)
        assertTrue(net.unsubscribed)
    }

    @Test
    fun belowTheFloorNothingStarts() = runBlocking {
        val mdns = AndroidMdns(FakeNsd(api = false), lan())
        assertFalse(mdns.isSupported())
        refused { mdns.advertise(MdnsAdvert("p1-AAAAAAAAAAAAAAAA", 4321, listOf("v=1"))) }
        refused { mdns.browse({}, {}, { true }) }
    }

    @Test
    fun aRepeatedOrEmptyTxtKeyRefusesTheAdvert() = runBlocking {
        for (txt in listOf(listOf("v=1", "v=2"), listOf("=1"))) {
            refused { AndroidMdns(FakeNsd(), lan()).advertise(MdnsAdvert("p1-AAAAAAAAAAAAAAAA", 4321, txt)) }
        }
    }

    @Test
    fun aNetworkChangeRegistersTheAdvertAgain() = runBlocking {
        val nsd = FakeNsd()
        val net = lan()
        val h = AndroidMdns(nsd, net).advertise(MdnsAdvert("p1-AAAAAAAAAAAAAAAA", 4321, listOf("v=1")))
        net.changed!!.invoke()
        assertEquals(2, nsd.regs.size)
        assertTrue(nsd.regs[0].stopped)
        assertFalse(nsd.regs[1].stopped)
        assertEquals(nsd.regs[0].instance, nsd.regs[1].instance)
        h.stop()
        assertTrue(nsd.regs[1].stopped)
        net.changed!!.invoke() // after stop: nothing registers
        assertEquals(2, nsd.regs.size)
    }

    private class Seen {
        val up = ArrayList<MdnsFound>()
        val down = ArrayList<String>()
    }

    private fun browse(nsd: FakeNsd, net: FakeNet, seen: Seen, accept: (String) -> Boolean = { true }) = runBlocking {
        AndroidMdns(nsd, net).browse({ seen.up += it }, { seen.down += it }, accept)
    }

    @Test
    fun anAcceptedNameIsWatchedAndANameTheServiceRefusesIsNot() {
        val nsd = FakeNsd()
        val seen = Seen()
        browse(nsd, lan(), seen) { it.startsWith("p1-") }
        nsd.browser!!.onFound("stranger")
        nsd.browser!!.onFound("p1-BBBBBBBBBBBBBBBB")
        assertEquals(listOf("p1-BBBBBBBBBBBBBBBB"), nsd.watchers.keys.toList())
    }

    @Test
    fun aFullWatchTableMakesRoomForARealNameByDroppingTheOldestUnresolvedOne() {
        val nsd = FakeNsd()
        val seen = Seen()
        browse(nsd, lan(), seen)
        for (i in 0 until PeerNsd.MAX_WATCHED) nsd.browser!!.onFound("p1-%016d".format(i))
        // One of them resolves (a real peer); it is never the one to go.
        nsd.watchers.getValue("p1-%016d".format(0)).onResolved(resolved("p1-%016d".format(0), listOf("192.168.1.20")))
        nsd.browser!!.onFound("p1-REAL")
        assertTrue("p1-REAL" in nsd.watchers)
        assertEquals(listOf("p1-%016d".format(1)), nsd.watchesStopped)
        assertEquals(1, seen.up.size)
    }

    @Test
    fun aResolvedServiceIsJudgedAndReportedWithTheNetworksFactory() {
        val nsd = FakeNsd()
        val seen = Seen()
        browse(nsd, lan(), seen)
        nsd.browser!!.onFound("p1-BBBBBBBBBBBBBBBB")
        nsd.watchers.getValue("p1-BBBBBBBBBBBBBBBB").onResolved(
            resolved(
                "p1-BBBBBBBBBBBBBBBB",
                listOf(
                    "8.8.8.8", // not private
                    "192.168.9.9", // private but not on this link
                    "169.254.3.3", // link-local v4 is never a peer
                    "192.168.1.20",
                    "fe80::2%7",
                ),
            ),
        )
        val f = seen.up.single()
        assertEquals("192.168.1.20", f.host)
        assertEquals(listOf("192.168.1.20", "fe80::2%7"), f.hosts)
        assertEquals(4000, f.port)
        assertEquals(listOf("v=1"), f.txt)
        assertEquals(factory, f.socketFactory)
    }

    @Test
    fun aServiceWithNoNetworkOrNoAcceptableAddressOrBadTxtIsNotReported() {
        val nsd = FakeNsd()
        val seen = Seen()
        browse(nsd, lan(), seen)
        nsd.browser!!.onFound("p1-BBBBBBBBBBBBBBBB")
        val w = nsd.watchers.getValue("p1-BBBBBBBBBBBBBBBB")
        w.onResolved(resolved("p1-BBBBBBBBBBBBBBBB", listOf("192.168.1.20"), network = null))
        w.onResolved(resolved("p1-BBBBBBBBBBBBBBBB", listOf("8.8.8.8")))
        val bad = mapOf("v" to byteArrayOf(0xff.toByte(), 0xfe.toByte()))
        w.onResolved(resolved("p1-BBBBBBBBBBBBBBBB", listOf("192.168.1.20"), attrs = bad))
        w.onResolved(resolved("p1-BBBBBBBBBBBBBBBB", listOf("192.168.1.20"), port = 0))
        assertTrue(seen.up.isEmpty())
        assertTrue(seen.down.isEmpty())
    }

    @Test
    fun anAdvertThatLosesItsAddressesOrIsLostGoesDownOnce() {
        val nsd = FakeNsd()
        val seen = Seen()
        browse(nsd, lan(), seen)
        nsd.browser!!.onFound("p1-BBBBBBBBBBBBBBBB")
        val w = nsd.watchers.getValue("p1-BBBBBBBBBBBBBBBB")
        w.onResolved(resolved("p1-BBBBBBBBBBBBBBBB", listOf("192.168.1.20")))
        assertEquals(1, seen.up.size)
        w.onResolved(resolved("p1-BBBBBBBBBBBBBBBB", listOf("8.8.8.8")))
        assertEquals(listOf("p1-BBBBBBBBBBBBBBBB"), seen.down)
        w.onResolved(resolved("p1-BBBBBBBBBBBBBBBB", listOf("192.168.1.20")))
        nsd.browser!!.onLost("p1-BBBBBBBBBBBBBBBB")
        assertEquals(2, seen.down.size)
        assertEquals(listOf("p1-BBBBBBBBBBBBBBBB"), nsd.watchesStopped)
    }

    @Test
    fun stoppingTheBrowseEndsEveryWatchAndNothingIsReportedAfter() {
        val nsd = FakeNsd()
        val seen = Seen()
        val h = browse(nsd, lan(), seen)
        nsd.browser!!.onFound("p1-BBBBBBBBBBBBBBBB")
        nsd.browser!!.onFound("p1-CCCCCCCCCCCCCCCC")
        val w = nsd.watchers.getValue("p1-BBBBBBBBBBBBBBBB")
        runBlocking {
            h.stop()
            h.stop()
        }
        assertTrue(nsd.browseStopped)
        assertEquals(2, nsd.watchesStopped.size)
        w.onResolved(resolved("p1-BBBBBBBBBBBBBBBB", listOf("192.168.1.20")))
        assertTrue(seen.up.isEmpty())
        nsd.browser!!.onFound("p1-DDDDDDDDDDDDDDDD")
        assertNull(nsd.watchers["p1-DDDDDDDDDDDDDDDD"])
        assertNotNull(nsd.watchers["p1-CCCCCCCCCCCCCCCC"])
    }

    @Test
    fun txtRoundTripsAndANonUtf8ValueIsRefused() {
        assertEquals(listOf("a=b=c", "k"), AndroidMdns.txtList(linkedMapOf("a" to "b=c".toByteArray(), "k" to null)))
        assertNull(AndroidMdns.txtList(mapOf("a" to byteArrayOf(0xc3.toByte()))))
        assertEquals("b=c", String(AndroidMdns.txtMap(listOf("a=b=c"))!!.getValue("a")))
    }

    @Test
    fun theBrowsePassesItsNameFilterToTheFoundTable() {
        val nsd = FakeNsd()
        browse(nsd, lan(), Seen()) { it.startsWith("p1-") }
        assertFalse(nsd.accept("stranger"))
        assertTrue(nsd.accept("p1-BBBBBBBBBBBBBBBB"))
    }

    @Test
    fun aGlobalOrCgnatAddressOnTheLinkIsNotReported() {
        val net = FakeNet(
            listOf(
                Subnet(InetAddress.getByName("2606:4700::5"), 64),
                Subnet(InetAddress.getByName("169.254.3.1"), 16),
                Subnet(InetAddress.getByName("100.64.0.5"), 10),
                Subnet(InetAddress.getByName("192.168.1.5"), 24),
            ),
            factory,
        )
        val nsd = FakeNsd()
        val seen = Seen()
        browse(nsd, net, seen)
        nsd.browser!!.onFound("p1-BBBBBBBBBBBBBBBB")
        val w = nsd.watchers.getValue("p1-BBBBBBBBBBBBBBBB")
        w.onResolved(resolved("p1-BBBBBBBBBBBBBBBB", listOf("2606:4700::9", "169.254.3.9", "100.64.0.9")))
        assertTrue(seen.up.isEmpty())
        w.onResolved(resolved("p1-BBBBBBBBBBBBBBBB", listOf("2606:4700::9", "169.254.3.9", "100.64.0.9", "192.168.1.20")))
        assertEquals(listOf("192.168.1.20"), seen.up.single().hosts)
    }

    @Test
    fun aVpnNetworkOrOneWithNoFactoryIsNotALanCandidate() {
        for (net in listOf(lan().apply { notVpn = false }, FakeNet(lan().subnets, null))) {
            val nsd = FakeNsd()
            val seen = Seen()
            browse(nsd, net, seen)
            nsd.browser!!.onFound("p1-BBBBBBBBBBBBBBBB")
            nsd.watchers.getValue("p1-BBBBBBBBBBBBBBBB").onResolved(resolved("p1-BBBBBBBBBBBBBBBB", listOf("192.168.1.20")))
            assertTrue(seen.up.isEmpty())
        }
    }

    private class Timer {
        val tasks = ArrayList<Pair<Long, () -> Unit>>()
        var cancelled = 0

        fun schedule(delay: Long, task: () -> Unit): NsdStop {
            tasks += delay to task
            return NsdStop { cancelled++ }
        }
    }

    @Test
    fun aRenameAfterANetworkChangeIsRetriedWithABoundedBackoff() = runBlocking {
        val nsd = FakeNsd()
        val net = lan()
        val timer = Timer()
        AndroidMdns(nsd, net, timer::schedule).advertise(MdnsAdvert("p1-AAAAAAAAAAAAAAAA", 4321, listOf("v=1")))
        assertEquals(1, nsd.regs.size)
        nsd.autoResult = null // from here the test answers each registration itself
        net.changed!!.invoke()
        assertEquals(2, nsd.regs.size)
        // The OS renames the new registration (the old name is still held): a retry is scheduled, not dropped.
        nsd.regs[1].onResult(NsdAdvertResult.Refused("renamed"))
        assertEquals(listOf(AndroidMdns.RETRY_BASE_MILLIS), timer.tasks.map { it.first })
        timer.tasks.last().second()
        assertEquals(3, nsd.regs.size)
        nsd.regs[2].onResult(NsdAdvertResult.Refused("renamed"))
        assertEquals(AndroidMdns.RETRY_BASE_MILLIS * 2, timer.tasks.last().first)
        // A refusal of an older registration is ignored.
        nsd.regs[1].onResult(NsdAdvertResult.Refused("renamed"))
        assertEquals(2, timer.tasks.size)
        // The retries stop at the bound.
        repeat(AndroidMdns.MAX_RETRIES) {
            timer.tasks.last().second()
            nsd.regs.last().onResult(NsdAdvertResult.Refused("renamed"))
        }
        assertEquals(AndroidMdns.MAX_RETRIES, timer.tasks.size)
        // A registration that succeeds ends the sequence.
        net.changed!!.invoke()
        nsd.regs.last().onResult(NsdAdvertResult.Registered)
        assertEquals(AndroidMdns.MAX_RETRIES, timer.tasks.size)
    }

    @Test
    fun stoppingTheAdvertCancelsAPendingRetry() = runBlocking {
        val nsd = FakeNsd()
        val net = lan()
        val timer = Timer()
        val h = AndroidMdns(nsd, net, timer::schedule).advertise(MdnsAdvert("p1-AAAAAAAAAAAAAAAA", 4321, listOf("v=1")))
        net.changed!!.invoke()
        nsd.regs[1].onResult(NsdAdvertResult.Refused("renamed"))
        h.stop()
        assertEquals(1, timer.cancelled)
        timer.tasks.last().second()
        assertEquals(2, nsd.regs.size)
    }
}
