// @pkey-feature connect.lan
//
// The JVM mDNS adapter (CC-12.11; WIRE-CONTRACT-V5 section 15.4, G5): the responder and the browser
// over a fake socket. Mirrors sdk-node's `connectMdns.test.ts` and the Python `test_connect_mdns.py`.
// No network: the live test needs `PKEY_LIVE_MDNS=1`.

package im.plrs.key.core.peer.lan

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.IOException

class JvmMdnsTest {
    private val inst = "p1-abcdefghijklmnop"
    private val fq = "$inst.$PEER_SERVICE"
    private val host = "$inst.local"

    private class FakeSocket(val onPacket: (ByteArray, String) -> Unit) : MdnsSocket {
        val sent = ArrayList<MdnsPacket>()
        var closed = false

        override fun send(data: ByteArray) {
            sent += parseMdnsPacket(data)
        }

        override fun close() {
            closed = true
        }
    }

    private class Rig(val addresses: (() -> List<String>)? = null, val allowLoopback: Boolean = false, val interfaces: List<String>? = null) {
        val scope = CoroutineScope(Dispatchers.Default + Job())
        val socks = ArrayList<FakeSocket>()
        var t = 1000.0
        val adapter = JvmMdns(
            scope,
            { on -> FakeSocket(on).also { socks += it } },
            addresses,
            allowLoopback,
            interfaces,
            { t },
        )
        val sock: FakeSocket get() = socks.last()
        val up = ArrayList<MdnsFound>()
        val down = ArrayList<String>()

        fun browse() = runBlocking { adapter.browse({ up += it }, { down += it }) }

        fun push(records: List<MdnsRecord>, src: String = "192.168.1.20") = sock.onPacket(buildMdnsResponse(records), src)

        fun close() = scope.cancel()
    }

    private fun srv(i: String = inst, port: Int = 4242, target: String? = null) =
        MdnsRecord(fqdn(i), MdnsType.SRV, 120, MdnsData.Srv(port, target ?: "$i.local"))

    private fun txt(i: String = inst, vararg e: String) =
        MdnsRecord(fqdn(i), MdnsType.TXT, 4500, MdnsData.Txt(if (e.isEmpty()) listOf("v=1", "m=a") else e.toList()))

    private fun ptr(i: String = inst, ttl: Long = 120) = MdnsRecord(PEER_SERVICE, MdnsType.PTR, ttl, MdnsData.Ptr(fqdn(i)))

    private fun a(i: String = inst, ip: String = "192.168.1.20") = MdnsRecord("$i.local", MdnsType.A, 120, MdnsData.Address(ip))

    private fun fqdn(i: String) = "$i.$PEER_SERVICE"

    private fun full(i: String = inst, ip: String = "192.168.1.20") = listOf(ptr(i), srv(i), txt(i), a(i, ip))

    @Test
    fun lanAddresses() {
        val ok = listOf("10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.0.1")
        val bad = listOf(
            "172.32.0.1", "172.15.0.1", "192.169.0.1", "169.254.1.1", "100.64.0.1", "8.8.8.8", "127.0.0.1",
            "010.0.0.1", "10.0.0.256", "10.0.0", "::1", "fe80::1",
        )
        for (ip in ok) assertTrue(ip, isLanAddress(ip))
        for (ip in bad) assertFalse(ip, isLanAddress(ip))
        assertTrue(isLanAddress("127.0.0.1", true))
    }

    // -- advertise -------------------------------------------------------------------------------

    private fun advertise(r: Rig): MdnsHandle = runBlocking { r.adapter.advertise(MdnsAdvert(inst, 4242, listOf("v=1", "m=a"))) }

    @Test
    fun advertAnnouncesPtrSrvTxtAndTheLanAddressesWithTheInstanceAsHostName() {
        val r = Rig(addresses = { listOf("192.168.1.20", "8.8.8.8", "169.254.3.3", "10.1.2.3") })
        advertise(r)
        val p = r.sock.sent[0]
        assertTrue(p.isResponse)
        val by = p.answers.associateBy { it.type to it.name }
        assertEquals(MdnsData.Ptr(fq), by[MdnsType.PTR to PEER_SERVICE]!!.data)
        assertEquals(MdnsData.Srv(4242, host, 0, 0), by[MdnsType.SRV to fq]!!.data)
        assertEquals(MdnsData.Txt(listOf("v=1", "m=a")), by[MdnsType.TXT to fq]!!.data)
        val ips = p.answers.filter { it.type == MdnsType.A }
        assertEquals(listOf("10.1.2.3", "192.168.1.20"), ips.map { (it.data as MdnsData.Address).ip }.sorted())
        assertTrue(ips.all { it.name == host })
        r.close()
    }

    @Test
    fun interfacesOverrideAndOnlyLanOnesAreAdvertised() {
        val r = Rig(interfaces = listOf("10.9.9.9", "100.64.1.1"))
        advertise(r)
        assertEquals(listOf("10.9.9.9"), r.sock.sent[0].answers.filter { it.type == MdnsType.A }.map { (it.data as MdnsData.Address).ip })
        val none = Rig(addresses = { listOf("8.8.4.4") })
        advertise(none)
        assertTrue(none.sock.sent.isEmpty()) // no LAN address: nothing to say
        r.close()
        none.close()
    }

    @Test
    fun aBadAdvertIsRefused() {
        val r = Rig(addresses = { listOf("10.0.0.2") })
        for ((i, port) in listOf("nope" to 1, "p1-ABCDEFGHIJKLMNOP" to 1, inst to 0, inst to 70000)) {
            try {
                runBlocking { r.adapter.advertise(MdnsAdvert(i, port, listOf("v=1"))) }
                throw AssertionError("must refuse $i $port")
            } catch (e: IllegalArgumentException) {
                // refused
            }
        }
        r.close()
    }

    private fun query(r: Rig, name: String = PEER_SERVICE): Int {
        val before = r.sock.sent.size
        r.sock.onPacket(buildMdnsQuery(listOf(MdnsQuestion(name, MdnsType.PTR))), "10.0.0.9")
        return r.sock.sent.size - before
    }

    @Test
    fun repliesToMatchingQueriesAtMostOnceASecond() {
        val r = Rig(addresses = { listOf("10.0.0.2") })
        advertise(r)
        r.t += 5
        assertEquals(1, query(r))
        assertEquals(0, query(r))
        r.t += 0.5
        assertEquals(0, query(r))
        r.t += 0.6
        assertEquals(1, query(r, fq))
        r.t += 2
        assertEquals(0, query(r, "other.local"))
        assertEquals(1, query(r, host))
        r.close()
    }

    @Test
    fun responsesAndMalformedPacketsAreIgnoredByTheResponder() {
        val r = Rig(addresses = { listOf("10.0.0.2") })
        advertise(r)
        val n = r.sock.sent.size
        r.sock.onPacket(buildMdnsResponse(listOf(ptr())), "10.0.0.9")
        r.sock.onPacket(ByteArray(40) { -1 }, "10.0.0.9")
        r.sock.onPacket(ByteArray(0), "10.0.0.9")
        assertEquals(n, r.sock.sent.size)
        r.close()
    }

    @Test
    fun stopSaysGoodbyeWithZeroTtlAndClosesTheSocket() = runBlocking {
        val r = Rig(addresses = { listOf("10.0.0.2") })
        val h = advertise(r)
        h.stop()
        val bye = r.sock.sent.last()
        assertTrue(bye.answers.all { it.ttl == 0L })
        assertTrue(r.sock.closed)
        h.stop() // twice is fine
        assertTrue(r.sock.sent.last() === bye)
        r.close()
    }

    @Test
    fun theAdvertIsRepeatedAfterASecond() = runBlocking {
        val r = Rig(addresses = { listOf("10.0.0.2") })
        advertise(r)
        delay(1400)
        assertTrue(r.sock.sent.size >= 2)
        r.close()
    }

    @Test
    fun aSocketThatCannotOpenIsMdnsUnavailable() {
        val scope = CoroutineScope(Dispatchers.Default + Job())
        val a = JvmMdns(scope, { throw MdnsUnavailableException("no socket") })
        try {
            runBlocking { a.browse({}) }
            throw AssertionError("unavailable")
        } catch (e: MdnsUnavailableException) {
            assertEquals("mdns_unavailable", e.reason)
        }
        scope.cancel()
    }

    // -- browse ----------------------------------------------------------------------------------

    @Test
    fun browseAsksForTheServiceAtOnce() = runBlocking {
        val r = Rig()
        val h = r.browse()
        val q = r.sock.sent[0]
        assertFalse(q.isResponse)
        assertEquals(listOf(MdnsQuestion(PEER_SERVICE, MdnsType.PTR)), q.questions)
        h.stop()
        assertTrue(r.sock.closed)
        r.close()
    }

    @Test
    fun aCompleteAdvertIsReportedOnceWithTheAddressToDial() {
        val r = Rig()
        r.browse()
        r.push(full())
        assertEquals(listOf(MdnsFound(inst, "192.168.1.20", 4242, listOf("v=1", "m=a"))), r.up)
        r.push(full())
        assertEquals(1, r.up.size) // same signature: not repeated
        r.push(listOf(srv(port = 4243)))
        assertEquals(2, r.up.size)
        assertEquals(4243, r.up[1].port)
        r.close()
    }

    @Test
    fun recordsArrivingInPiecesJoinUp() {
        val r = Rig()
        r.browse()
        r.push(listOf(ptr()))
        r.push(listOf(srv()))
        r.push(listOf(txt()))
        assertTrue(r.up.isEmpty())
        r.push(listOf(a()))
        assertEquals(1, r.up.size)
        r.close()
    }

    @Test
    fun aGoodbyePtrReportsDownOnce() {
        val r = Rig()
        r.browse()
        r.push(full())
        r.push(listOf(ptr(ttl = 0)))
        assertEquals(listOf(inst), r.down)
        r.push(listOf(ptr(ttl = 0)))
        assertEquals(listOf(inst), r.down)
        r.close()
    }

    @Test
    fun anARecordIsBelievedOnlyFromItsOwnSource() {
        val r = Rig()
        r.browse()
        // A neighbour at .66 claims the instance lives at .20.
        r.push(full(ip = "192.168.1.20"), src = "192.168.1.66")
        assertTrue(r.up.isEmpty())
        // The name belongs to the first source that announced it: .20 cannot claim it afterwards.
        r.push(listOf(a(ip = "192.168.1.20")), src = "192.168.1.20")
        assertTrue(r.up.isEmpty())
        r.close()
    }

    @Test
    fun anAddressOutsideTheLanIsNeverDialled() {
        for (ip in listOf("8.8.8.8", "169.254.9.9", "100.64.0.9", "127.0.0.1")) {
            val r = Rig()
            r.browse()
            r.push(full(ip = ip), src = ip)
            assertTrue(ip, r.up.isEmpty())
            r.close()
        }
        val r = Rig(allowLoopback = true)
        r.browse()
        r.push(full(ip = "127.0.0.1"), src = "127.0.0.1")
        assertEquals("127.0.0.1", r.up[0].host)
        r.close()
    }

    @Test
    fun aNamesAddressBelongsToTheSourceThatAnnouncedItAndAnotherSourceCannotAddOrReplaceIt() {
        val r = Rig()
        r.browse()
        r.push(listOf(ptr(), srv(), txt()), "192.168.1.30")
        r.push(listOf(a(ip = "192.168.1.30")), "192.168.1.30")
        assertEquals(listOf("192.168.1.30"), r.up.map { it.host })
        for (n in 31..39) r.push(listOf(a(ip = "192.168.1.$n")), "192.168.1.$n")
        r.push(listOf(srv(port = 5000)), "192.168.1.31") // another source cannot change the port
        assertEquals(1, r.up.size)
        assertEquals(listOf("192.168.1.30"), r.up[0].hosts)
        r.push(listOf(srv(port = 5000)), "192.168.1.30") // the owner can
        assertEquals("192.168.1.30", r.up.last().host)
        assertEquals(5000, r.up.last().port)
        r.close()
    }

    @Test
    fun anAddressAnnouncedFirstByAStrangerDoesNotBeatTheNamesOwnSource() {
        val r = Rig()
        r.browse()
        r.push(listOf(a(ip = "192.168.1.66")), "192.168.1.66") // the stranger is first with an A
        r.push(full(ip = "192.168.1.20"), "192.168.1.20")
        assertEquals(listOf("192.168.1.20"), r.up.map { it.host })
        assertEquals(1, r.up.size)
        r.close()
    }

    @Test
    fun datagramsFromOutsideTheLanAreDroppedBeforeTheyAreParsed() {
        for (src in listOf("8.8.8.8", "169.254.1.1", "100.64.0.1", "127.0.0.1", "not-an-address")) {
            val r = Rig()
            r.browse()
            r.push(full(ip = "192.168.1.20"), src)
            r.push(listOf(ptr(ttl = 0)), src)
            assertTrue(src, r.up.isEmpty() && r.down.isEmpty())
            // not even an entry: a good packet afterwards is reported once, with no "down"
            r.push(full())
            assertEquals(src, 1, r.up.size)
            r.close()
        }
    }

    @Test
    fun aGoodbyeFromAnotherSourceDoesNotRemoveARealPeer() {
        val r = Rig()
        r.browse()
        r.push(full())
        r.push(listOf(ptr(ttl = 0)), "192.168.1.99")
        assertTrue(r.down.isEmpty())
        r.close()
    }

    @Test
    fun onlyAcceptedInstancesEnterTheTable() {
        val r = Rig()
        runBlocking { r.adapter.browse({ r.up += it }, { r.down += it }, { it == inst }) }
        for (i in 0 until MDNS_MAX_INSTANCES * 2) {
            val n = name(i, 'f')
            r.push(listOf(ptr(n), srv(n), txt(n), a(n, "192.168.1.20")))
        }
        assertTrue(r.up.isEmpty())
        r.push(full())
        assertEquals(listOf(inst), r.up.map { it.instance })
        assertTrue(r.down.isEmpty()) // a flood of strangers evicted nothing
        r.close()
    }

    @Test
    fun anSrvToAForeignTargetNeverReports() {
        val r = Rig()
        r.browse()
        r.push(listOf(ptr(), srv(target = "evil.local"), txt(), a()))
        assertTrue(r.up.isEmpty())
        r.close()
    }

    @Test
    fun namesOfTheWrongShapeAndBadPortsAreDropped() {
        val r = Rig()
        r.browse()
        for (i in listOf("p1-short", "x1-abcdefghijklmnop", "p1-abcdefghijklmn89")) r.push(full(i))
        r.push(listOf(ptr(), srv(port = 0), txt(), a()))
        assertTrue(r.up.isEmpty())
        // A PTR that is not the service's own name is not an advert.
        r.push(listOf(MdnsRecord("_other._tcp.local", MdnsType.PTR, 0, MdnsData.Ptr(fq))))
        assertTrue(r.down.isEmpty())
        r.close()
    }

    private val alphabet = "abcdefghijklmnopqrstuvwxyz234567"

    private fun name(i: Int, pad: Char) = "p1-" + alphabet[i / 32] + alphabet[i % 32] + pad.toString().repeat(14)

    /** One LAN source per index, so a flood test is not held back by the per-source cap. */
    private fun sourceOf(i: Int) = "10.0.${i / 100}.${i % 100 + 1}"

    @Test
    fun aSourceMayCreateOnlyAFewNewEntriesAMinute() {
        val r = Rig()
        r.browse()
        val ip = "192.168.1.20"
        val names = (0 until MDNS_NEW_PER_MINUTE + 5).map { name(it, 'd') }
        for (n in names) r.push(listOf(ptr(n), srv(n), txt(n), a(n, ip)), ip)
        assertEquals(MDNS_NEW_PER_MINUTE, r.up.size)
        // a name already held is still refreshed, and a minute later the source may add more
        r.t += 61
        for (n in names.takeLast(5)) r.push(listOf(ptr(n), srv(n), txt(n), a(n, ip)), ip)
        assertEquals(MDNS_NEW_PER_MINUTE + 5, r.up.size)
        // another source is not held back by the first one's use
        val other = name(200, 'e')
        r.push(listOf(ptr(other), srv(other), txt(other), a(other, "192.168.1.21")), "192.168.1.21")
        assertTrue(r.up.any { it.instance == other })
        r.close()
    }

    @Test
    fun theInstanceTableIsBoundedAndEvictsTheLeastRecentlyRefreshed() {
        val r = Rig()
        r.browse()
        val names = (0 until MDNS_MAX_INSTANCES + 40).map { name(it, 'a') }
        for ((i, n) in names.withIndex()) r.push(listOf(ptr(n), srv(n), txt(n)), sourceOf(i))
        r.push(listOf(a(names.last(), sourceOf(names.size - 1))), sourceOf(names.size - 1))
        assertTrue(r.up.any { it.instance == names.last() })
        r.push(listOf(a(names.first(), sourceOf(0))), sourceOf(0))
        assertFalse(r.up.any { it.instance == names.first() }) // evicted: its SRV and TXT are forgotten
        r.close()
    }

    @Test
    fun anUpEntryThatExpiresReportsDownWhenTheTableIsFull() {
        val r = Rig()
        r.browse()
        r.push(full())
        r.t += MDNS_ENTRY_TTL_SECONDS + 1
        for (i in 0 until MDNS_MAX_INSTANCES + 2) r.push(listOf(ptr(name(i, 'c'))), sourceOf(i))
        assertEquals(listOf(inst), r.down)
        r.close()
    }

    @Test
    fun malformedAndOversizePacketsAreDropped() {
        val r = Rig()
        r.browse()
        r.sock.onPacket(ByteArray(9001), "192.168.1.20")
        r.sock.onPacket(byteArrayOf(0, 0, 0x84.toByte(), 0, 0, 0, 0, 0x41) + ByteArray(40), "192.168.1.20")
        r.sock.onPacket(buildMdnsQuery(listOf(MdnsQuestion(PEER_SERVICE, MdnsType.PTR))), "192.168.1.20")
        assertTrue(r.up.isEmpty())
        r.push(full())
        assertEquals(1, r.up.size) // still working
        r.close()
    }

    @Test
    fun aRaisingCallbackDoesNotStopDiscovery() {
        val scope = CoroutineScope(Dispatchers.Default + Job())
        var sock: FakeSocket? = null
        var calls = 0
        val a = JvmMdns(scope, { on -> FakeSocket(on).also { sock = it } }, null, false, null, { 1000.0 })
        runBlocking {
            a.browse({
                calls++
                error("host bug")
            })
        }
        sock!!.onPacket(buildMdnsResponse(full()), "192.168.1.20")
        sock!!.onPacket(buildMdnsResponse(listOf(srv(port = 4243))), "192.168.1.20")
        assertEquals(2, calls)
        scope.cancel()
    }

    @Test
    fun stopIgnoresLatePackets() = runBlocking {
        val r = Rig()
        val h = r.browse()
        h.stop()
        r.push(full())
        assertTrue(r.up.isEmpty())
        r.close()
    }

    // -- live (opt in) ---------------------------------------------------------------------------

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
