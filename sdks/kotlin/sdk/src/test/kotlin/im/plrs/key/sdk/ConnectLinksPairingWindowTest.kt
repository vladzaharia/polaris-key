// @pkey-feature connect.links
//
// The pairing window, two devices of two accounts end to end (WIRE-CONTRACT-V5 section 15.10): each opens the window
// over one fake LAN (real loopback TCP), both see the same code, and after both confirm each device stores the other's
// key and name under one shared contact secret; a decline stores nothing on either side.

package im.plrs.key.sdk

import im.plrs.key.core.peer.lan.MdnsAdapter
import im.plrs.key.core.peer.lan.MdnsAdvert
import im.plrs.key.core.peer.lan.MdnsFound
import im.plrs.key.core.peer.lan.MdnsHandle
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

class ConnectLinksPairingWindowTest : ConnectLanBase() {
    private inner class Person(val d: Device, val label: String, val confirm: Boolean) {
        val rows = CopyOnWriteArrayList<ContactRow>()
        val codes = CopyOnWriteArrayList<String>()
        val linked = CopyOnWriteArrayList<PairedLink>()
        val failed = CopyOnWriteArrayList<PairFailure>()

        val source = PairSource(
            slug = "djdl",
            now = { System.currentTimeMillis() / 1000 },
            agreeKey = { d.agreeKey },
            held = { rows.filter { it.pendingSince == null }.map { it.agreeKey } },
            store = { key, secret, lbl, cats ->
                synchronized(rows) {
                    val v = storeRow(rows.toList(), key, secret, lbl, cats, System.currentTimeMillis() / 1000) ?: return@PairSource null
                    rows.clear()
                    rows.addAll(v.rows)
                    StoredLink(contactId(key), v.pending)
                }
            },
            allowed = { true },
        )

        fun options(net: MdnsAdapter) = LinkPairOptions(
            categories = listOf("docs"),
            onCode = { offer ->
                codes += offer.code
                scope.launch { if (confirm) offer.confirm() else offer.decline() }
            },
            label = label,
            onLinked = { linked += it },
            onFailed = { failed += it },
            seconds = 30.0,
            mdns = net,
            host = "127.0.0.1",
            allowLoopback = true,
        )
    }

    private fun launchBoth(a: Person, b: Person): Pair<LinkPairHandle, LinkPairHandle> = runBlocking {
        val net = Network()
        LinkPairing.start(a.source, a.options(net)) to LinkPairing.start(b.source, b.options(net))
    }

    @Test
    fun twoDevicesPairAndBothStoreTheSameContactSecret() {
        val a = Person(device(idA), "Ana", true)
        val b = Person(device(idB), "Ben", true)
        val (ha, hb) = launchBoth(a, b)
        until { a.linked.isNotEmpty() && b.linked.isNotEmpty() }
        assertEquals(a.codes.first(), b.codes.first())
        assertEquals(listOf(b.d.agreeKey), a.rows.map { it.agreeKey })
        assertEquals(listOf(a.d.agreeKey), b.rows.map { it.agreeKey })
        assertEquals(a.rows.first().secret, b.rows.first().secret)
        assertEquals("Ben", a.rows.first().label)
        assertEquals("Ana", b.rows.first().label)
        assertEquals(listOf("docs"), a.linked.first().categories)
        assertTrue(a.failed.isEmpty() && b.failed.isEmpty())
        runBlocking {
            ha.stop()
            hb.stop()
        }
    }

    /** Hands every found advert the given factory, as the Android adapter does with the found network's. */
    private class WithFactory(val inner: MdnsAdapter, val factory: javax.net.SocketFactory) : MdnsAdapter {
        override suspend fun advertise(advert: MdnsAdvert): MdnsHandle = inner.advertise(advert)

        override suspend fun browse(onUp: (MdnsFound) -> Unit, onDown: (String) -> Unit, accept: (String) -> Boolean): MdnsHandle =
            inner.browse({ onUp(MdnsFound(it.instance, it.host, it.port, it.txt, it.hosts, factory)) }, onDown, accept)
    }

    private class CountingFactory : javax.net.SocketFactory() {
        val made = java.util.concurrent.atomic.AtomicInteger()

        override fun createSocket(): java.net.Socket = java.net.Socket().also { made.incrementAndGet() }

        override fun createSocket(h: String?, p: Int): java.net.Socket = throw UnsupportedOperationException()

        override fun createSocket(h: String?, p: Int, a: java.net.InetAddress?, lp: Int): java.net.Socket = throw UnsupportedOperationException()

        override fun createSocket(a: java.net.InetAddress?, p: Int): java.net.Socket = throw UnsupportedOperationException()

        override fun createSocket(a: java.net.InetAddress?, p: Int, la: java.net.InetAddress?, lp: Int): java.net.Socket =
            throw UnsupportedOperationException()
    }

    @Test
    fun aPairingDialUsesTheFoundNetworksFactory() {
        val a = Person(device(idA), "Ana", true)
        val b = Person(device(idB), "Ben", true)
        val net = Network()
        val fa = CountingFactory()
        val fb = CountingFactory()
        val (ha, hb) = runBlocking {
            LinkPairing.start(a.source, a.options(WithFactory(net, fa))) to LinkPairing.start(b.source, b.options(WithFactory(net, fb)))
        }
        until { a.linked.isNotEmpty() && b.linked.isNotEmpty() }
        // Exactly one side dials (the lower instance does not); its sockets all came from the found network's factory.
        assertEquals(1, fa.made.get() + fb.made.get())
        runBlocking {
            ha.stop()
            hb.stop()
        }
    }

    @Test
    fun aPairingDialFailsClosedWhenTheFoundNetworksFactoryCannotMakeASocket() {
        val a = Person(device(idA), "Ana", true)
        val b = Person(device(idB), "Ben", true)
        val net = Network()
        val broken = object : javax.net.SocketFactory() {
            override fun createSocket(): java.net.Socket = throw java.io.IOException("network is gone")

            override fun createSocket(h: String?, p: Int): java.net.Socket = throw UnsupportedOperationException()

            override fun createSocket(h: String?, p: Int, a: java.net.InetAddress?, lp: Int): java.net.Socket = throw UnsupportedOperationException()

            override fun createSocket(a: java.net.InetAddress?, p: Int): java.net.Socket = throw UnsupportedOperationException()

            override fun createSocket(a: java.net.InetAddress?, p: Int, la: java.net.InetAddress?, lp: Int): java.net.Socket =
                throw UnsupportedOperationException()
        }
        val (ha, hb) = runBlocking {
            LinkPairing.start(a.source, a.options(WithFactory(net, broken))) to LinkPairing.start(b.source, b.options(WithFactory(net, broken)))
        }
        Thread.sleep(1500)
        assertTrue(a.codes.isEmpty() && b.codes.isEmpty() && a.rows.isEmpty() && b.rows.isEmpty())
        runBlocking {
            ha.stop()
            hb.stop()
        }
    }

    @Test
    fun oneDeclineStoresNothingOnEitherDevice() {
        val a = Person(device(idA), "Ana", true)
        val b = Person(device(idB), "Ben", false)
        val (ha, hb) = launchBoth(a, b)
        until { a.failed.isNotEmpty() && b.failed.isNotEmpty() }
        assertTrue(a.rows.isEmpty() && b.rows.isEmpty())
        assertTrue(a.linked.isEmpty() && b.linked.isEmpty())
        assertEquals(PairFailureReason.Declined, b.failed.first().reason)
        runBlocking {
            ha.stop()
            hb.stop()
        }
    }
}
