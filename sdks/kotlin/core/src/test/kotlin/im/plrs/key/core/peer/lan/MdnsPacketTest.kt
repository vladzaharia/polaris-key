// @pkey-feature connect.lan
//
// The mDNS packet codec (WIRE-CONTRACT-V5 section 15.4, G5 bounds): round trips and malformed
// packets. Mirrors the Python codec's tests.

package im.plrs.key.core.peer.lan

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayOutputStream

class MdnsPacketTest {
    private val inst = "p1-abcdefghijklmnop"
    private val fqdn = "$inst.$PEER_SERVICE"
    private val host = "$inst.local"

    private fun u16(v: Int) = byteArrayOf((v shr 8).toByte(), v.toByte())

    private fun header(qd: Int = 0, an: Int = 0, ns: Int = 0, ar: Int = 0, flags: Int = 0x8400): ByteArray =
        u16(0) + u16(flags) + u16(qd) + u16(an) + u16(ns) + u16(ar)

    private fun name(s: String): ByteArray {
        val out = ByteArrayOutputStream()
        for (p in s.split(".")) {
            out.write(p.length)
            out.write(p.toByteArray())
        }
        out.write(0)
        return out.toByteArray()
    }

    private fun rr(owner: ByteArray, type: Int, rdata: ByteArray, ttl: Int = 120, cls: Int = 1): ByteArray =
        owner + u16(type) + u16(cls) + u16(ttl ushr 16) + u16(ttl and 0xffff) + u16(rdata.size) + rdata

    private val aTen1 = byteArrayOf(10, 0, 0, 1)

    private fun answers() = listOf(
        MdnsRecord(PEER_SERVICE, MdnsType.PTR, 120, MdnsData.Ptr(fqdn)),
        MdnsRecord(fqdn, MdnsType.SRV, 120, MdnsData.Srv(4242, host)),
        MdnsRecord(fqdn, MdnsType.TXT, 4500, MdnsData.Txt(listOf("v=1", "k=abc"))),
        MdnsRecord(host, MdnsType.A, 120, MdnsData.Address("192.168.1.20")),
    )

    private fun reason(data: ByteArray): String {
        try {
            parseMdnsPacket(data)
        } catch (e: MdnsPacketError) {
            return e.reason
        }
        fail("expected a refusal")
        return ""
    }

    private fun refused(block: () -> Unit) {
        try {
            block()
            fail("expected a refusal")
        } catch (e: IllegalArgumentException) {
            assertTrue(e.message != null)
        }
    }

    @Test
    fun queryRoundTrip() {
        val qs = listOf(MdnsQuestion(PEER_SERVICE, MdnsType.PTR), MdnsQuestion(fqdn, MdnsType.SRV), MdnsQuestion(host, MdnsType.A))
        val pkt = parseMdnsPacket(buildMdnsQuery(qs))
        assertFalse(pkt.isResponse)
        assertEquals(qs, pkt.questions)
        assertTrue(pkt.answers.isEmpty())
    }

    @Test
    fun responseRoundTrip() {
        val pkt = parseMdnsPacket(buildMdnsResponse(answers()))
        assertTrue(pkt.isResponse)
        assertEquals(answers(), pkt.answers)
    }

    @Test
    fun namesAreLowercasedAndEmptyTxtRoundTrips() {
        val raw = header(an = 2) + rr(name("_PkeyPeer._TCP.local"), 12, name(fqdn.uppercase())) + rr(name(fqdn), 16, byteArrayOf(0))
        val pkt = parseMdnsPacket(raw)
        assertEquals(MdnsRecord(PEER_SERVICE, MdnsType.PTR, 120, MdnsData.Ptr(fqdn)), pkt.answers[0])
        assertEquals(MdnsData.Txt(emptyList()), pkt.answers[1].data)
        val empty = parseMdnsPacket(buildMdnsResponse(listOf(MdnsRecord(fqdn, MdnsType.TXT, 1, MdnsData.Txt(emptyList())))))
        assertEquals(MdnsData.Txt(emptyList()), empty.answers[0].data)
    }

    @Test
    fun compressionBackwardsIsFollowed() {
        val nm = name(inst)
        val first = rr(name(PEER_SERVICE), 12, nm.copyOf(nm.size - 1) + byteArrayOf(0xc0.toByte(), 0x0c))
        val pkt = parseMdnsPacket(header(an = 1) + first)
        assertEquals(MdnsData.Ptr("$inst.$PEER_SERVICE"), pkt.answers[0].data)
    }

    @Test
    fun unknownTypesAndClassesAreSkipped() {
        val raw = header(an = 3) +
            rr(name(host), 99, "xyz".toByteArray()) +
            rr(name(host), 1, aTen1, cls = 3) +
            rr(name(host), 1, aTen1, cls = 0x8001)
        assertEquals(listOf(MdnsRecord(host, MdnsType.A, 120, MdnsData.Address("10.0.0.1"))), parseMdnsPacket(raw).answers)
    }

    @Test
    fun anAaaaRecordIsSixteenBytesAndReadsAsRfc5952Text() {
        val fe80 = intArrayOf(0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0x01, 0xc2, 0x03, 0xff, 0xfe, 0x04, 0x05, 0xa6).map { it.toByte() }.toByteArray()
        val got = parseMdnsPacket(header(an = 1) + rr(name(host), 28, fe80)).answers
        assertEquals(listOf(MdnsRecord(host, MdnsType.AAAA, 120, MdnsData.Address("fe80::1c2:3ff:fe04:5a6"))), got)
        // Another length is not an address.
        assertEquals("bad_rdata", reason(header(an = 1) + rr(name(host), 28, ByteArray(4))))
        assertEquals("bad_rdata", reason(header(an = 1) + rr(name(host), 28, ByteArray(17))))
        // It builds back to the same bytes, and the cache-flush bit is set like an A record's.
        val built = buildMdnsResponse(got)
        assertEquals(got, parseMdnsPacket(built).answers)
        org.junit.Assert.assertArrayEquals(header(an = 1) + rr(name(host), 28, fe80, cls = 0x8001), built)
    }

    @Test
    fun authorityIsDroppedAdditionalsAreKept() {
        val raw = header(ns = 1, ar = 1) + rr(name(host), 1, byteArrayOf(10, 0, 0, 2)) + rr(name(host), 1, aTen1)
        assertEquals(listOf(MdnsData.Address("10.0.0.1")), parseMdnsPacket(raw).answers.map { it.data })
    }

    @Test
    fun txtKeepsTheFirstEightEntries() {
        val rdata = (0 until 12).map { "k$it" }.fold(ByteArray(0)) { acc, s -> acc + byteArrayOf(s.length.toByte()) + s.toByteArray() }
        val pkt = parseMdnsPacket(header(an = 1) + rr(name(fqdn), 16, rdata))
        assertEquals(MdnsData.Txt((0 until 8).map { "k$it" }), pkt.answers[0].data)
    }

    @Test
    fun pointerLoopSelfAndForwardPointers() {
        assertEquals("bad_pointer", reason(header(an = 1) + byteArrayOf(0xc0.toByte(), 0x0c) + ByteArray(10)))
        val loop = header(qd = 1) + byteArrayOf(0xc0.toByte(), 0x0e, 0xc0.toByte(), 0x0c, 0, 12, 0, 1)
        assertEquals("bad_pointer", reason(loop))
        val forward = header(qd = 1) + byteArrayOf(0xc0.toByte(), 0x20, 0, 12, 0, 1) + ByteArray(40)
        assertEquals("bad_pointer", reason(forward))
    }

    private fun chainPacket(chain: Int): ByteArray {
        val firstOwner = byteArrayOf(1, 'a'.code.toByte(), 0)
        val rdataAt = 12 + firstOwner.size + 10
        var rdata = ByteArray(0)
        var prev = 12
        for (i in 0 until chain) {
            rdata += u16(0xC000 or prev)
            prev = rdataAt + 2 * i
        }
        val second = u16(0xC000 or prev) + u16(1) + u16(1) + u16(0) + u16(120) + u16(4) + aTen1
        return header(an = 2) + rr(firstOwner, 99, rdata) + second
    }

    @Test
    fun jumpLimit() {
        assertEquals(listOf(MdnsRecord("a", MdnsType.A, 120, MdnsData.Address("10.0.0.1"))), parseMdnsPacket(chainPacket(15)).answers)
        assertEquals("too_many_jumps", reason(chainPacket(16)))
    }

    @Test
    fun truncatedRdata() {
        val good = header(an = 1) + rr(name(host), 1, aTen1)
        assertEquals("truncated", reason(good.copyOf(good.size - 2)))
        assertEquals("bad_rdata", reason(header(an = 1) + rr(name(host), 1, byteArrayOf(10, 0, 0))))
        assertEquals("bad_rdata", reason(header(an = 1) + rr(name(fqdn), 16, byteArrayOf(5, 'a'.code.toByte(), 'b'.code.toByte()))))
        val srv = u16(0) + u16(0) + u16(80) + name(host)
        assertTrue(reason(header(an = 1) + rr(name(fqdn), 33, srv.copyOf(srv.size - 3))) in listOf("bad_rdata", "truncated"))
        assertEquals("bad_rdata", reason(header(an = 1) + rr(name(fqdn), 33, srv.copyOf(5))))
        val ptr = name(inst)
        assertTrue(reason(header(an = 1) + rr(name(fqdn), 12, ptr.copyOf(ptr.size - 1))) in listOf("bad_rdata", "truncated"))
    }

    @Test
    fun trailingBytesAfterAPtrOrSrvNameAreRefused() {
        val ptr = name(inst) + byteArrayOf(0, 0)
        assertEquals("bad_rdata", reason(header(an = 1) + rr(name(fqdn), 12, ptr)))
        val srv = u16(0) + u16(0) + u16(80) + name(host) + byteArrayOf(7)
        assertEquals("bad_rdata", reason(header(an = 1) + rr(name(fqdn), 33, srv)))
    }

    @Test
    fun truncatedHeaderAndFields() {
        assertEquals("truncated", reason(ByteArray(11)))
        assertEquals("truncated", reason(header(an = 1)))
        assertEquals("truncated", reason(header(qd = 1) + name(host)))
        assertEquals("truncated", reason(header(an = 1) + name(host) + byteArrayOf(0, 1)))
    }

    @Test
    fun oversizePacketAndSections() {
        assertEquals("packet_too_large", reason(ByteArray(MDNS_MAX_PACKET + 1)))
        for (field in 0 until 4) {
            val counts = IntArray(4).also { it[field] = 65 }
            assertEquals("too_many_records", reason(header(counts[0], counts[1], counts[2], counts[3])))
        }
        val one = rr(name(host), 1, aTen1)
        assertEquals(64, parseMdnsPacket(header(an = 64) + (0 until 64).fold(ByteArray(0)) { acc, _ -> acc + one }).answers.size)
    }

    @Test
    fun nameAndLabelLimits() {
        val tail = byteArrayOf(0, 12, 0, 1)
        fun q(n: ByteArray) = header(qd = 1) + n + tail
        assertEquals("bad_label", reason(q(byteArrayOf(64) + ByteArray(64) { 'a'.code.toByte() } + byteArrayOf(0))))
        fun label(n: Int, c: Char) = byteArrayOf(n.toByte()) + ByteArray(n) { c.code.toByte() }
        val ok = label(63, 'a') + label(63, 'a') + label(63, 'a') + label(61, 'b') + byteArrayOf(0)
        assertEquals(255, ok.size)
        assertEquals(MdnsType.PTR, parseMdnsPacket(q(ok)).questions[0].type)
        val tooLong = label(63, 'a') + label(63, 'a') + label(63, 'a') + label(63, 'a') + byteArrayOf(0)
        assertEquals("name_too_long", reason(q(tooLong)))
        assertEquals("bad_label", reason(q(byteArrayOf(0x40, 'a'.code.toByte(), 0))))
        assertEquals("bad_label", reason(q(byteArrayOf(1, 0xe9.toByte(), 0))))
    }

    @Test
    fun buildersRefuseOutOfBoundsInput() {
        refused { buildMdnsQuery(listOf(MdnsQuestion("a".repeat(64) + ".local", MdnsType.PTR))) }
        refused { buildMdnsResponse(listOf(MdnsRecord(host, MdnsType.A, 1, MdnsData.Address("300.1.1.1")))) }
        refused { buildMdnsResponse(listOf(MdnsRecord(host, MdnsType.AAAA, 1, MdnsData.Address("10.0.0.1")))) }
        refused { buildMdnsResponse(listOf(MdnsRecord(host, MdnsType.AAAA, 1, MdnsData.Address("fe80::1%en0")))) }
        refused { buildMdnsResponse(listOf(MdnsRecord(host, MdnsType.A, 1, MdnsData.Address("fe80::1")))) }
        refused { buildMdnsResponse(listOf(MdnsRecord(fqdn, MdnsType.TXT, 1, MdnsData.Txt(List(9) { "x" })))) }
        refused { buildMdnsResponse(listOf(MdnsRecord(fqdn, MdnsType.TXT, 1, MdnsData.Txt(listOf("x".repeat(256)))))) }
        refused { buildMdnsResponse(List(65) { MdnsRecord(host, MdnsType.A, 1, MdnsData.Address("10.0.0.1")) }) }
        refused { buildMdnsResponse(listOf(MdnsRecord(fqdn, MdnsType.SRV, 1, MdnsData.Srv(70000, host)))) }
    }
}
