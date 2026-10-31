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
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket

class JvmMdnsTest {
    private val inst = "p1-abcdefghijklmnop"
    private val fq = "$inst.$PEER_SERVICE"
    private val host = "$inst.local"

    private class FakeSocket(val deliver: (ByteArray, String, Int) -> Unit) : MdnsSocket {
        val sent = ArrayList<MdnsPacket>()
        val sent6 = ArrayList<Pair<String, MdnsPacket>>()

        /** Packets sent to one address alone: the raw bytes, the host and the port. */
        val unicast = ArrayList<Triple<ByteArray, String, Int>>()
        var closed = false

        /** A datagram arrives from [src]:[port] (default: a multicast query's or response's port). */
        fun onPacket(data: ByteArray, src: String, port: Int = MDNS_PORT) = deliver(data, src, port)

        override fun sendTo(data: ByteArray, host: String, port: Int) {
            unicast += Triple(data, host, port)
        }

        override fun send(data: ByteArray) {
            sent += parseMdnsPacket(data)
        }

        override fun send6(data: ByteArray, zone: String) {
            sent6 += zone to parseMdnsPacket(data)
        }

        override fun close() {
            closed = true
        }
    }

    private val lan4 = listOf("192.168.1.0/24", "10.0.0.0/8", "172.20.0.0/16")

    private val en0 = Mdns6Interface("en0", "en0", listOf("fe80::1"), listOf("fe80::1/64", "fd12::5/64"))
    private val wlan0 = Mdns6Interface("wlan0", "wlan0", listOf("fe80::2"), listOf("fe80::2/64"))

    private class Rig(
        val addresses: (() -> List<String>)? = null,
        val allowLoopback: Boolean = false,
        val interfaces: List<String>? = null,
        val subnets: List<String> = listOf("192.168.1.0/24", "10.0.0.0/8", "172.20.0.0/16", "2001:db8:1::/64"),
        val v6: List<Mdns6Interface> = emptyList(),
    ) {
        val scope = CoroutineScope(Dispatchers.Default + Job())
        val socks = ArrayList<FakeSocket>()
        var t = 1000.0
        val adapter = JvmMdns(
            scope,
            { on -> FakeSocket(on).also { socks += it } },
            allowLoopback,
            interfaces,
            MdnsEnvironment(addresses, { subnets }, { v6 }, { t }),
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

    private fun a(i: String = inst, ip: String = "192.168.1.20", ttl: Long = 120) = MdnsRecord("$i.local", MdnsType.A, ttl, MdnsData.Address(ip))

    private fun aaaa(i: String = inst, ip: String = "fe80::1c2:3ff:fe4:5a6", ttl: Long = 120) =
        MdnsRecord("$i.local", MdnsType.AAAA, ttl, MdnsData.Address(ip))

    private fun fqdn(i: String) = "$i.$PEER_SERVICE"

    private fun full(i: String = inst, ip: String = "192.168.1.20") = listOf(ptr(i), srv(i), txt(i), if (ip.contains(':')) aaaa(i, ip) else a(i, ip))

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
    fun anAaaaRecordLeavesOnItsOwnLinkAndAnArecordOnTheIpv4Group() {
        val two = Mdns6Interface("wlan0", "wlan0", listOf("fe80::2", "fe80::3"), listOf("fe80::2/64"))
        val r = Rig(addresses = { listOf("192.168.1.20") }, v6 = listOf(en0, two))
        advertise(r)
        val v4 = r.sock.sent.single()
        assertEquals(listOf(MdnsType.A), v4.answers.map { it.type }.filter { it == MdnsType.A || it == MdnsType.AAAA })
        assertEquals(listOf("en0", "wlan0"), r.sock.sent6.map { it.first })
        for ((zone, p) in r.sock.sent6) {
            val addrs = p.answers.filter { it.type == MdnsType.AAAA }
            assertTrue(addrs.all { it.name == host })
            assertEquals(if (zone == "en0") listOf("fe80::1") else listOf("fe80::2", "fe80::3"), addrs.map { (it.data as MdnsData.Address).ip })
            assertEquals(MdnsData.Srv(4242, host, 0, 0), p.answers.first { it.type == MdnsType.SRV }.data)
        }
        // An IPv6-only host (no private IPv4 address) still says where it is.
        val only6 = Rig(addresses = { emptyList() }, v6 = listOf(en0))
        advertise(only6)
        assertTrue(only6.sock.sent.isEmpty())
        assertEquals(1, only6.sock.sent6.size)
        // The goodbye goes out on every link too, with TTL 0.
        runBlocking { advertise(r).stop() }
        assertTrue(r.sock.sent6.takeLast(2).all { (_, p) -> p.answers.all { it.ttl == 0L } })
        r.close()
        only6.close()
    }

    @Test
    fun aBrowseAsksForAaaaAndQueriesEveryLink() {
        val q = Rig(v6 = listOf(en0))
        q.browse()
        assertEquals(listOf("en0"), q.sock.sent6.map { it.first })
        q.push(listOf(ptr(), srv(), txt()))
        runBlocking { delay(1300) } // the second ask, after a second: the chased name is asked for with both address types
        val last = q.sock.sent.last().questions
        assertTrue(last.contains(MdnsQuestion(host, MdnsType.A)))
        assertTrue(last.contains(MdnsQuestion(host, MdnsType.AAAA)))
        assertEquals(last, q.sock.sent6.last().second.questions)
        q.close()
    }

    @Test
    fun aLinkLocalSourceNeedsNoSubnet() {
        // fe80::/10 is on-link by definition (RFC 6762 section 11): no subnet list is consulted for it.
        val r = Rig(subnets = emptyList(), v6 = listOf(en0))
        r.browse()
        r.push(listOf(ptr(), srv(), txt(), aaaa(ip = "fe80::7")), src = "fe80::7%en0")
        assertEquals(listOf("fe80::7%en0"), r.up.single().hosts)
        r.close()
    }

    @Test
    fun aLinkLocalSourceWithNoArrivalZoneOrAZoneWeDidNotJoinTeachesNothing() {
        val r = Rig(v6 = listOf(en0))
        r.browse()
        val ll = "fe80::1c2:3ff:fe4:5a6"
        r.push(full(ip = ll), src = ll) // no zone: the same fe80 text on another link is another host
        r.push(full(ip = ll), src = "$ll%wlan0") // a link that is not in use
        r.push(full(ip = ll), src = "$ll%99") // not a link either
        assertTrue(r.up.isEmpty())
        r.push(full(ip = ll), src = "$ll%en0")
        assertEquals(listOf("$ll%en0"), r.up.single().hosts)
        r.close()
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

    private val ask = buildMdnsQuery(listOf(MdnsQuestion(PEER_SERVICE, MdnsType.PTR)), 0x1234)

    @Test
    fun aQuerierOnAnEphemeralPortGetsAUnicastAnswerWithItsId() {
        val r = Rig(addresses = { listOf("192.168.1.20") })
        advertise(r)
        val sent = r.sock.sent.size
        r.sock.onPacket(ask, "192.168.1.30", 51234)
        assertEquals(sent, r.sock.sent.size) // nothing to the group
        assertEquals(1, r.sock.unicast.size)
        val (data, host, port) = r.sock.unicast[0]
        assertEquals("192.168.1.30" to 51234, host to port)
        val p = parseMdnsPacket(data)
        assertTrue(p.isResponse)
        assertEquals(0x1234, p.id)
        assertEquals(listOf(MdnsQuestion(PEER_SERVICE, MdnsType.PTR)), p.questions)
        assertEquals(listOf(MdnsType.PTR, MdnsType.SRV, MdnsType.TXT, MdnsType.A), p.answers.map { it.type })
        assertTrue(p.answers.all { it.ttl == 10L })
        // No cache-flush bit: every answer's class is plain IN (0x0001), followed by the TTL 10.
        val plain = byteArrayOf(0, 1, 0, 0, 0, 10)
        val hits = (0..data.size - plain.size).count { i -> plain.indices.all { data[i + it] == plain[it] } }
        assertEquals(4, hits)
        r.close()
    }

    @Test
    fun aQueryFromPort5353IsStillAnsweredByMulticast() {
        val r = Rig(addresses = { listOf("192.168.1.20") })
        advertise(r)
        val sent = r.sock.sent.size
        r.sock.onPacket(ask, "192.168.1.30", 5353)
        assertEquals(sent + 1, r.sock.sent.size)
        assertEquals(120L, r.sock.sent.last().answers[0].ttl)
        assertTrue(r.sock.unicast.isEmpty())
        r.close()
    }

    @Test
    fun aLegacyQueryFromOffTheLinkOrAPrivilegedPortGetsNothing() {
        val r = Rig(addresses = { listOf("192.168.1.20") })
        advertise(r)
        val sent = r.sock.sent.size
        for (src in listOf("8.8.8.8", "100.64.0.5", "fe80::5%en0", "not an address")) r.sock.onPacket(ask, src, 51234)
        r.sock.onPacket(ask, "8.8.8.8", 5353) // off the link, whatever its port
        for (port in listOf(1, 53, 1023)) r.sock.onPacket(ask, "192.168.1.30", port)
        assertTrue(r.sock.unicast.isEmpty())
        assertEquals(sent, r.sock.sent.size)
        // None of that used the second's reply slot.
        r.sock.onPacket(ask, "192.168.1.30", 1024)
        assertEquals(1, r.sock.unicast.size)
        r.close()
    }

    @Test
    fun aLegacyAnswerRepeatsOnlyOurQuestionsAndHonoursTheReplyGap() {
        val r = Rig(addresses = { listOf("192.168.1.20") })
        advertise(r)
        r.sock.onPacket(buildMdnsQuery(listOf(MdnsQuestion("_other._tcp.local", MdnsType.PTR))), "192.168.1.30", 51234)
        assertTrue(r.sock.unicast.isEmpty())
        val mine = List(10) { MdnsQuestion(fq, MdnsType.SRV) }
        r.sock.onPacket(buildMdnsQuery(listOf(MdnsQuestion("x.local", MdnsType.A)) + mine, 9), "192.168.1.30", 51234)
        assertEquals(mine.take(4), parseMdnsPacket(r.sock.unicast[0].first).questions)
        r.sock.onPacket(ask, "192.168.1.30", 51235)
        assertEquals(1, r.sock.unicast.size)
        r.t += 1.5
        r.sock.onPacket(ask, "192.168.1.30", 51235)
        assertEquals(2, r.sock.unicast.size)
        r.close()
    }

    @Test
    fun theRealSocketReportsTheSourcePortAndSendsUnicastOverLoopback() {
        val server = MulticastSocket(null as InetSocketAddress?).also { it.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0)) }
        val got = java.util.concurrent.LinkedBlockingQueue<Triple<ByteArray, String, Int>>()
        val real = JvmMdnsSocket(server, emptyList(), emptyMap(), emptySet())
        real.startReader { data, src, port -> got.add(Triple(data, src, port)) }
        DatagramSocket(0, InetAddress.getByName("127.0.0.1")).use { client ->
            client.soTimeout = 3000
            client.send(DatagramPacket(ask, ask.size, InetAddress.getByName("127.0.0.1"), server.localPort))
            val (data, src, port) = got.poll(3, java.util.concurrent.TimeUnit.SECONDS)!!
            assertEquals("127.0.0.1" to client.localPort, src to port)
            assertEquals(0x1234, parseMdnsPacket(data).id)
            real.sendTo(buildMdnsResponse(listOf(ptr()), 0x1234, flush = false), src, port)
            val buf = ByteArray(MDNS_MAX_PACKET)
            val reply = DatagramPacket(buf, buf.size)
            client.receive(reply)
            assertEquals(server.localPort, reply.port) // from the responder's own socket
            assertEquals(0x1234, parseMdnsPacket(reply.data.copyOf(reply.length)).id)
        }
        real.close()
    }

    @Test
    fun anIpv6LegacyQueryIsAnsweredWithTheAaaaOfItsOwnLink() {
        val r = Rig(addresses = { listOf("192.168.1.20") }, v6 = listOf(en0, wlan0))
        advertise(r)
        r.sock.onPacket(ask, "fe80::5%eth9", 51234)
        r.sock.onPacket(ask, "fe80::5", 51234)
        assertTrue(r.sock.unicast.isEmpty())
        r.sock.onPacket(ask, "fe80::5%wlan0", 51234)
        assertEquals(1, r.sock.unicast.size)
        assertEquals("fe80::5%wlan0" to 51234, r.sock.unicast[0].second to r.sock.unicast[0].third)
        val aaaa = parseMdnsPacket(r.sock.unicast[0].first).answers.filter { it.type == MdnsType.AAAA }
        assertEquals(listOf("fe80::2"), aaaa.map { (it.data as MdnsData.Address).ip })
        r.close()
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
        // .20 can say where it is.
        r.push(listOf(a(ip = "192.168.1.20")), src = "192.168.1.20")
        assertEquals(listOf(listOf("192.168.1.20")), r.up.map { it.hosts })
        r.close()
    }

    @Test
    fun anAaaaRecordIsBelievedOnlyFromItsOwnSourceAndALinkLocalOneTakesTheArrivalZone() {
        val r = Rig(v6 = listOf(en0, wlan0))
        r.browse()
        val ll = "fe80::1c2:3ff:fe4:5a6"
        r.push(listOf(ptr(), srv(), txt(), aaaa(ip = "fe80::9")), src = "$ll%en0") // not the source: nothing learned
        assertTrue(r.up.isEmpty())
        r.push(listOf(aaaa()), src = "$ll%en0")
        assertEquals(listOf("$ll%en0"), r.up.single().hosts)
        assertEquals("$ll%en0", r.up.single().host)
        // The same address on another link is another neighbour.
        r.push(listOf(aaaa()), src = "$ll%wlan0")
        assertEquals(listOf("$ll%en0", "$ll%wlan0"), r.up.last().hosts)
        // An A record in an IPv6 packet, and an AAAA record in an IPv4 packet, are never believed.
        r.push(listOf(a(ip = "192.168.1.20")), src = "$ll%en0")
        r.push(listOf(aaaa(ip = "fd12::7")), src = "192.168.1.20")
        assertEquals(2, r.up.last().hosts.size)
        r.close()
    }

    @Test
    fun aMappedSourceIsJudgedAsItsIpv4Address() {
        val r = Rig()
        r.browse()
        r.push(full(ip = "192.168.1.20"), src = "::ffff:192.168.1.20")
        assertEquals(listOf("192.168.1.20"), r.up.single().hosts)
        r.close()
    }

    @Test
    fun aDualStackHostIsDialledInFirstSeenOrder() {
        val r = Rig(v6 = listOf(en0))
        r.browse()
        r.push(full(ip = "192.168.1.20"), src = "192.168.1.20")
        r.push(listOf(aaaa(ip = "fe80::1")), src = "fe80::1%en0")
        assertEquals(listOf("192.168.1.20", "fe80::1%en0"), r.up.last().hosts)
        // An IPv6-first host lists its IPv6 address first.
        val r2 = Rig(v6 = listOf(en0))
        r2.browse()
        r2.push(listOf(ptr(), srv(), txt(), aaaa(ip = "fe80::1")), src = "fe80::1%en0")
        r2.push(listOf(a()), src = "192.168.1.20")
        assertEquals(listOf("fe80::1%en0", "192.168.1.20"), r2.up.last().hosts)
        r.close()
        r2.close()
    }

    @Test
    fun anAddressRecordWithTtlZeroWithdrawsItsAddressAndTheLastOneTakesTheAdvertDown() {
        val r = Rig(v6 = listOf(en0, wlan0))
        r.browse()
        r.push(full(ip = "192.168.1.20"), src = "192.168.1.20")
        r.push(listOf(aaaa(ip = "fe80::1")), src = "fe80::1%en0")
        // Not from its source: ignored.
        r.push(listOf(a(ttl = 0)), src = "192.168.1.99")
        assertTrue(r.down.isEmpty())
        r.push(listOf(a(ttl = 0)), src = "192.168.1.20")
        assertEquals(listOf("fe80::1%en0"), r.up.last().hosts)
        assertTrue(r.down.isEmpty())
        r.push(listOf(aaaa(ip = "fe80::1", ttl = 0)), src = "fe80::1%wlan0") // another zone: removes nothing
        assertTrue(r.down.isEmpty())
        r.push(listOf(aaaa(ip = "fe80::1", ttl = 0)), src = "fe80::1%en0")
        assertEquals(listOf(inst), r.down)
        // It comes back: reported again.
        val n = r.up.size
        r.push(listOf(a()), src = "192.168.1.20")
        assertEquals(n + 1, r.up.size)
        r.close()
    }

    @Test
    fun aNameKeepsFourAddressesInFirstSeenOrder() {
        val r = Rig()
        r.browse()
        r.push(full(ip = "192.168.1.20"), src = "192.168.1.20")
        for (n in 21..26) r.push(listOf(a(ip = "192.168.1.$n")), src = "192.168.1.$n")
        assertEquals(listOf(20, 21, 22, 23).map { "192.168.1.$it" }, r.up.last().hosts)
        r.close()
    }

    @Test
    fun aSourceOutsideTheInterfacesConnectedSubnetsIsIgnored() {
        for (ip in listOf("8.8.8.8", "169.254.9.9", "100.64.0.9", "127.0.0.1", "192.168.2.20", "2001:db8:2::1", "fd00::1")) {
            val r = Rig()
            r.browse()
            r.push(full(ip = ip), src = ip)
            assertTrue(ip, r.up.isEmpty())
            r.close()
        }
        // A global address on a connected /64 is heard (the dial-time verdict decides what is dialled); a
        // link-local source is on-link by definition; loopback only where its interface is in use.
        val g = Rig()
        g.browse()
        g.push(full(ip = "2001:db8:1::7"), src = "2001:db8:1::7")
        assertEquals(listOf("2001:db8:1::7"), g.up.single().hosts)
        g.close()
        val r = Rig(allowLoopback = true, subnets = listOf("127.0.0.0/8"))
        r.browse()
        r.push(full(ip = "127.0.0.1"), src = "127.0.0.1")
        assertEquals("127.0.0.1", r.up[0].host)
        r.close()
    }

    @Test
    fun noSourceOwnsANameAndTheAddressesAreDialledInFirstSeenOrder() {
        val r = Rig()
        r.browse()
        r.push(listOf(ptr(), srv(), txt()), "192.168.1.30")
        r.push(listOf(a(ip = "192.168.1.30")), "192.168.1.30")
        assertEquals(listOf("192.168.1.30"), r.up.map { it.host })
        // another source's SRV is judged by the same rules as the first's: no ownership
        r.push(listOf(srv(port = 5000)), "192.168.1.31")
        assertEquals(5000, r.up.last().port)
        // an address announced first by a stranger keeps its place: the order is first-seen
        val r2 = Rig()
        r2.browse()
        r2.push(listOf(a(ip = "192.168.1.66")), "192.168.1.66")
        r2.push(full(ip = "192.168.1.20"), "192.168.1.20")
        assertEquals(listOf("192.168.1.66", "192.168.1.20"), r2.up.last().hosts)
        r.close()
        r2.close()
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
    fun aGoodbyeFromAnotherSourceOnTheLinkTakesTheNameDownUntilItAnnouncesAgain() {
        // No source owns a name (V5 15.4): a goodbye is judged like any record, and the peer's next
        // announce (or the 30 s ask) brings it back. A goodbye never removes an address.
        val r = Rig()
        r.browse()
        r.push(full())
        r.push(listOf(ptr(ttl = 0)), "192.168.1.99")
        assertEquals(listOf(inst), r.down)
        r.push(full())
        assertEquals(2, r.up.size)
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
        for (port in listOf(0, 1, 1023, 80)) r.push(listOf(ptr(), srv(port = port), txt(), a()))
        assertTrue(r.up.isEmpty())
        // A PTR that is not the service's own name is not an advert.
        r.push(listOf(MdnsRecord("_other._tcp.local", MdnsType.PTR, 0, MdnsData.Ptr(fq))))
        assertTrue(r.down.isEmpty())
        r.close()
    }

    @Test
    fun anSrvPortIsBelievedFrom1024To65535() {
        for ((port, ok) in listOf(1023 to false, 1024 to true, 65535 to true)) {
            val r = Rig()
            r.browse()
            r.push(listOf(ptr(), srv(port = port), txt(), a()))
            assertEquals("port $port", if (ok) listOf(port) else emptyList<Int>(), r.up.map { it.port })
            r.close()
        }
    }

    @Test
    fun namesCompareByAsciiFoldAndAreHeldInLowerCase() {
        val r = Rig()
        r.browse()
        val up = inst.uppercase()
        val fqUp = "$up.${PEER_SERVICE.uppercase()}"
        r.push(
            listOf(
                MdnsRecord(PEER_SERVICE.uppercase(), MdnsType.PTR, 120, MdnsData.Ptr(fqUp)),
                MdnsRecord(fqUp, MdnsType.SRV, 120, MdnsData.Srv(4242, "$up.LOCAL")),
                MdnsRecord(fqUp, MdnsType.TXT, 4500, MdnsData.Txt(listOf("v=1", "m=a"))),
                MdnsRecord("$up.LOCAL", MdnsType.A, 120, MdnsData.Address("192.168.1.20")),
            ),
        )
        assertEquals(listOf(inst), r.up.map { it.instance })
        assertEquals(listOf("192.168.1.20"), r.up.single().hosts)
        r.close()
    }

    @Test
    fun theResponderAnswersAQuestionInAnyCase() {
        val r = Rig(addresses = { listOf("10.0.0.2") })
        advertise(r)
        r.t += 5
        assertEquals(1, query(r, PEER_SERVICE.uppercase()))
        r.close()
    }

    private val alphabet = "abcdefghijklmnopqrstuvwxyz234567"

    private fun name(i: Int, pad: Char) = "p1-" + alphabet[i / 32] + alphabet[i % 32] + pad.toString().repeat(14)

    /** One LAN source per index, so a flood test is not held back by the per-source cap. */
    private fun sourceOf(i: Int) = "10.0.${i / 100}.${i % 100 + 1}"

    @Test
    fun aSourceMayAddOnlyAFewNewNamesAMinute() {
        assertEquals(16, MDNS_NEW_PER_MINUTE)
        val r = Rig()
        r.browse()
        val ip = "192.168.1.20"
        // each advert adds two names to the tables (the instance, then its host name): both count
        val names = (0 until MDNS_NEW_PER_MINUTE + 5).map { name(it, 'd') }
        for (n in names) r.push(listOf(ptr(n), srv(n), txt(n), a(n, ip)), ip)
        assertEquals(MDNS_NEW_PER_MINUTE / 2, r.up.size)
        // a name already held is still refreshed, and a minute later the source may add more
        r.t += 61
        for (n in names.take(2)) r.push(listOf(ptr(n), srv(n), txt(n), a(n, ip, ttl = 121)), ip)
        assertEquals(MDNS_NEW_PER_MINUTE / 2, r.up.size)
        for (n in names.drop(MDNS_NEW_PER_MINUTE / 2)) r.push(listOf(ptr(n), srv(n), txt(n), a(n, ip)), ip)
        assertEquals(MDNS_NEW_PER_MINUTE, r.up.size)
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
        val a = JvmMdns(scope, { on -> FakeSocket(on).also { sock = it } }, env = MdnsEnvironment(subnets = { lan4 }, clock = { 1000.0 }))
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
}
