// @pkey-feature connect.lan
//
// The JVM mDNS adapter against the real sockets (CC-12.11): two adapters on this host find each other
// (opt in, `PKEY_LIVE_MDNS=1`), and the TCP pipe moves bytes on loopback.

package im.plrs.key.core.peer.lan

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.IOException

class JvmMdnsLiveTest {
    private val inst = "p1-abcdefghijklmnop"

    @Test
    fun liveTwoAdaptersOnThisHostFindEachOther() = runBlocking {
        assumeTrue("live multicast: PKEY_LIVE_MDNS=1", System.getenv("PKEY_LIVE_MDNS") == "1")
        val scope = CoroutineScope(Dispatchers.Default + Job())
        val got = java.util.concurrent.LinkedBlockingQueue<MdnsFound>()
        val adapter = JvmMdns(scope, allowLoopback = true, interfaces = listOf("127.0.0.1"))
        val bh = try {
            adapter.browse({ got.add(it) })
        } catch (e: MdnsUnavailableException) {
            assumeTrue("no multicast socket here", false)
            return@runBlocking
        }
        val ah = adapter.advertise(MdnsAdvert(inst, 4242, listOf("v=1", "m=a")))
        try {
            val f = got.poll(8, java.util.concurrent.TimeUnit.SECONDS)
            assertNotNull(f)
            assertEquals(inst, f.instance)
            assertEquals(4242, f.port)
        } finally {
            ah.stop()
            bh.stop()
            scope.cancel()
        }
    }

    @Test
    fun liveTwoAdaptersFindEachOtherOverTheRealInterfacesOnBothFamilies() = runBlocking {
        assumeTrue("live multicast: PKEY_LIVE_MDNS=1", System.getenv("PKEY_LIVE_MDNS") == "1")
        val v4 = lanInterfaces().map { it.second }
        val v6 = lanInterfaces6()
        assumeTrue("no LAN interface on this host", v4.isNotEmpty() || v6.isNotEmpty())
        val scope = CoroutineScope(Dispatchers.Default + Job())
        val got = java.util.concurrent.LinkedBlockingQueue<MdnsFound>()
        val adapter = JvmMdns(scope)
        val bh = runCatching { adapter.browse({ got.add(it) }) }.getOrElse {
            assumeTrue("no multicast socket here", false)
            return@runBlocking
        }
        val ah = adapter.advertise(MdnsAdvert(inst, 4242, listOf("v=1", "m=a")))
        try {
            var f = got.poll(8, java.util.concurrent.TimeUnit.SECONDS)
            assertNotNull(f)
            assertEquals(inst, f.instance)
            // The report is repeated as each address arrives: collect for a moment.
            while (true) f = got.poll(3, java.util.concurrent.TimeUnit.SECONDS) ?: break
            println("[live] hosts=${f.hosts} v4=$v4 v6=${v6.map { it.zone to it.addresses }}")
            // every family this host announces on is heard, link-local with its zone
            if (v4.isNotEmpty()) assertTrue(f.hosts.toString(), f.hosts.any { '.' in it })
            if (v6.isNotEmpty()) assertTrue(f.hosts.toString(), f.hosts.any { it.startsWith("fe80:") && '%' in it })
        } finally {
            ah.stop()
            bh.stop()
            scope.cancel()
        }
    }

    @Test
    fun tcpPipeMovesBytesBothWaysOnLoopback() = runBlocking {
        val server = java.net.ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))
        try {
            val dialled = TcpPipe.connect("127.0.0.1", server.localPort, 2000)
            val accepted = TcpPipe(server.accept())
            dialled.write("ping".toByteArray())
            assertEquals("ping", String(accepted.read()!!))
            accepted.write("pong".toByteArray())
            assertEquals("pong", String(dialled.read()!!))
            assertEquals("127.0.0.1", dialled.remoteAddress)
            dialled.close()
            assertEquals(null, accepted.read())
            accepted.close()
            try {
                TcpPipe.connect("127.0.0.1", 1, 500)
                throw AssertionError("refused")
            } catch (e: IOException) {
                // nothing listens there
            }
        } finally {
            server.close()
        }
    }
}
