// @pkey-feature connect.links
package im.plrs.key.android

import android.net.Network
import im.plrs.key.core.peer.ContactTxtResult
import im.plrs.key.core.peer.MAX_LIVE_CONTACT_ADVERTS
import im.plrs.key.core.peer.contactInstance
import im.plrs.key.core.peer.lan.MdnsAdvert
import im.plrs.key.core.peer.lan.MdnsFound
import im.plrs.key.core.peer.parseContactTxt
import im.plrs.key.platform.NsdAdvertResult
import im.plrs.key.platform.NsdResolved
import im.plrs.key.platform.PeerNsdListener
import im.plrs.key.platform.Subnet
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.shadows.ShadowNetwork
import java.net.InetAddress
import javax.net.SocketFactory

/**
 * CC-12b.7: the contact adverts (`m=c`, WIRE-CONTRACT-V5 sections 15.4 and 15.10) on Android. `LanService` (:sdk)
 * advertises them through whichever `MdnsAdapter` Connect uses, so Android needs no code of its own: this drives
 * the exact calls the service makes (`advertise(MdnsAdvert(name, listenerPort, ["v=1", "m=c"]))`, at most
 * `MAX_LIVE_CONTACT_ADVERTS` of them next to the account advert, all on the one listener) through [AndroidMdns]
 * over a fake NSD, and the contact advert a peer announces back. The gate on the cached `interAccount`, the cap
 * of 8 and the trial order are `LanService`'s and `PolarisKeyClient`'s and run in :sdk (`ConnectLinksTest`).
 */
@RunWith(RobolectricTestRunner::class)
class ConnectLinksAndroidTest {
    private class FakeNsd : NsdPort {
        class Reg(val instance: String, val port: Int, val txt: Map<String, ByteArray>) {
            var stopped = false
        }

        val regs = ArrayList<Reg>()
        var browser: PeerNsdListener? = null
        val watchers = LinkedHashMap<String, PeerNsdListener>()

        override fun supported() = true

        override fun advertise(instance: String, port: Int, txt: Map<String, ByteArray>, onResult: (NsdAdvertResult) -> Unit): NsdStop {
            val r = Reg(instance, port, txt)
            regs += r
            onResult(NsdAdvertResult.Registered)
            return NsdStop { r.stopped = true }
        }

        override fun browse(listener: PeerNsdListener, accept: (String) -> Boolean): NsdStop {
            browser = listener
            return NsdStop {}
        }

        override fun watch(instance: String, listener: PeerNsdListener): NsdStop {
            watchers[instance] = listener
            return NsdStop {}
        }
    }

    private class FakeNet(val factory: SocketFactory?) : NetworkPort {
        override fun subnetsOf(network: Network) = listOf(Subnet(InetAddress.getByName("192.168.1.5"), 24))

        override fun factoryOf(network: Network) = factory

        override fun isNotVpn(network: Network) = true

        override fun onDefaultNetworkChange(onChange: () -> Unit) = NsdStop {}
    }

    private val wifi: Network = ShadowNetwork.newInstance(100)

    private fun names(n: Int) = (0 until n).map { contactInstance(ByteArray(32) { b -> (it * 7 + b).toByte() }, ByteArray(32) { 5 }, 1234L) }

    @Test
    fun upToEightContactAdvertsShareTheListenerPortWithTheAccountAdvert() = runBlocking {
        val nsd = FakeNsd()
        val mdns = AndroidMdns(nsd, FakeNet(SocketFactory.getDefault()))
        val port = 45_678
        val handles = ArrayList<im.plrs.key.core.peer.lan.MdnsHandle>()
        handles += mdns.advertise(MdnsAdvert("p1-AAAAAAAAAAAAAAAA", port, listOf("v=1", "m=a", "h=abc")))
        for (name in names(MAX_LIVE_CONTACT_ADVERTS)) handles += mdns.advertise(MdnsAdvert(name, port, listOf("v=1", "m=c")))
        assertEquals(1 + MAX_LIVE_CONTACT_ADVERTS, nsd.regs.size)
        assertEquals("one listener, one port", setOf(port), nsd.regs.map { it.port }.toSet())
        val contact = nsd.regs.drop(1)
        assertEquals(MAX_LIVE_CONTACT_ADVERTS, contact.map { it.instance }.toSet().size)
        for (r in contact) {
            assertEquals(setOf("v", "m"), r.txt.keys)
            assertEquals("c", String(r.txt.getValue("m")))
            assertTrue(r.instance.startsWith("p1-"))
        }
        // A contact removed or gated off withdraws its own registration and leaves the others.
        handles[1].stop()
        assertTrue(nsd.regs[1].stopped)
        assertEquals(false, nsd.regs[0].stopped || nsd.regs[2].stopped)
        for (h in handles) h.stop()
        assertTrue(nsd.regs.all { it.stopped })
    }

    @Test
    fun aPeersContactAdvertIsReportedWithItsTxtForTheServiceToJudge() {
        val nsd = FakeNsd()
        val seen = ArrayList<MdnsFound>()
        runBlocking { AndroidMdns(nsd, FakeNet(SocketFactory.getDefault())).browse({ seen += it }, {}, { true }) }
        val name = names(1).single()
        nsd.browser!!.onFound(name)
        nsd.watchers.getValue(name).onResolved(
            NsdResolved(name, listOf("192.168.1.20"), 4000, mapOf("v" to "1".toByteArray(), "m" to "c".toByteArray()), wifi),
        )
        val f = seen.single()
        assertEquals("192.168.1.20", f.host)
        assertEquals(name, f.instance)
        // Only parseContactTxt judges an m=c advert (V5 15.4): the adapter carries the entries, nothing more.
        assertTrue(parseContactTxt(f.txt) is ContactTxtResult.Ok)
    }
}
