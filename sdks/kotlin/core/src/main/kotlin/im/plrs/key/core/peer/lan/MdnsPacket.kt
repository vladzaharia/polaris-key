// WIRE-CONTRACT-V5 section 15.4: the mDNS packet codec for `_pkeypeer._tcp.local` (CC-12.7). Pure
// functions over bytes: no socket, no clock. It parses and builds PTR queries and PTR, SRV, TXT and
// A and AAAA answers, and it is the one place a neighbour's packet is decoded, so every limit is enforced
// here (G5): a packet is at most 9,000 bytes and a section holds at most 64 records; a name is at
// most 255 bytes and a label at most 63; a compression pointer must point strictly backwards and a
// name follows at most 16 of them; a record's data lies inside the packet and fills exactly its
// length (an A record is 4 bytes, an AAAA record 16); a TXT record keeps its first 8 entries; unknown
// types and classes are skipped. A packet that breaks a limit throws [MdnsPacketError] and the caller
// drops the whole packet. Names are lower-cased on the way in. Whether an address is believed is the
// adapter's business (it needs the UDP source). Mirrors the Python codec `core/peer_mdns_packet.py`.

package im.plrs.key.core.peer.lan

import java.io.ByteArrayOutputStream

/** The service every Polaris Key peer advertises under. */
public const val PEER_SERVICE: String = "_pkeypeer._tcp.local"

/** The largest datagram decoded or built. */
public const val MDNS_MAX_PACKET: Int = 9000

/** The most records in one section. */
public const val MDNS_MAX_RECORDS: Int = 64

/** The longest name, in wire bytes. */
public const val MDNS_MAX_NAME: Int = 255

/** The longest label. */
public const val MDNS_MAX_LABEL: Int = 63

/** The most compression pointers one name may follow. */
public const val MDNS_MAX_JUMPS: Int = 16

/** The TXT entries kept per record. */
public const val MDNS_MAX_TXT: Int = 8

private const val T_A = 1
private const val T_AAAA = 28
private const val T_PTR = 12
private const val T_TXT = 16
private const val T_SRV = 33
private const val CLASS_IN = 1
private const val CACHE_FLUSH = 0x8000
private const val RESPONSE_FLAGS = 0x8400
private const val RESPONSE_BIT = 0x8000
private const val HEADER = 12
private const val POINTER = 0xC0
private const val BYTE = 0xff
private const val WORD = 0xffff
private const val SRV_FIXED = 6
private const val FIELD_BITS = 8
private const val MAX_TXT_ENTRY = 255
private const val V6_BYTES = 16

/** A packet that cannot be decoded within the limits. [reason] is a short stable code. */
public class MdnsPacketError(public val reason: String) : Exception(reason)

/** The record types the codec understands. */
public enum class MdnsType(internal val code: Int) { A(T_A), AAAA(T_AAAA), PTR(T_PTR), TXT(T_TXT), SRV(T_SRV) }

/** The decoded data of a record. */
public sealed class MdnsData {
    /** A PTR record's target name. */
    public data class Ptr(val name: String) : MdnsData()

    /** An SRV record. */
    public data class Srv(val port: Int, val target: String, val priority: Int = 0, val weight: Int = 0) : MdnsData()

    /** A TXT record's entries. */
    public data class Txt(val entries: List<String>) : MdnsData()

    /** An A record's dotted IPv4 address, or an AAAA record's address as RFC 5952 text (never with a zone). */
    public data class Address(val ip: String) : MdnsData()
}

/** One question. */
public data class MdnsQuestion(val name: String, val type: MdnsType)

/** One resource record. */
public data class MdnsRecord(val name: String, val type: MdnsType, val ttl: Long, val data: MdnsData)

/** A decoded datagram; [answers] are the answers followed by the additionals (authority is dropped). */
public data class MdnsPacket(val isResponse: Boolean, val questions: List<MdnsQuestion>, val answers: List<MdnsRecord>)

private fun typeOf(code: Int): MdnsType? = MdnsType.values().firstOrNull { it.code == code }

private class Reader(val buf: ByteArray) {
    fun u8(at: Int): Int = buf[at].toInt() and BYTE

    fun u16(at: Int): Int = (u8(at) shl FIELD_BITS) or u8(at + 1)

    fun u32(at: Int): Long = (u16(at).toLong() shl 16) or u16(at + 2).toLong()

    /** Read a name at [pos]: it and the offset just after its first (uncompressed) form. */
    fun name(pos: Int): Pair<String, Int> {
        val labels = ArrayList<String>()
        var total = 0
        var jumps = 0
        var end = -1
        var cur = pos
        while (true) {
            if (cur >= buf.size) throw MdnsPacketError("truncated")
            val n = u8(cur)
            if (n == 0) {
                if (end < 0) end = cur + 1
                break
            }
            val kind = n and POINTER
            if (kind == POINTER) {
                if (cur + 1 >= buf.size) throw MdnsPacketError("truncated")
                val target = ((n and POINTER.inv() and BYTE) shl FIELD_BITS) or u8(cur + 1)
                if (end < 0) end = cur + 2
                if (target >= cur) throw MdnsPacketError("bad_pointer")
                if (++jumps > MDNS_MAX_JUMPS) throw MdnsPacketError("too_many_jumps")
                cur = target
                continue
            }
            if (kind != 0 || n > MDNS_MAX_LABEL) throw MdnsPacketError("bad_label")
            if (cur + 1 + n > buf.size) throw MdnsPacketError("truncated")
            total += n + 1
            if (total + 1 > MDNS_MAX_NAME) throw MdnsPacketError("name_too_long")
            labels += label(cur + 1, n)
            cur += 1 + n
        }
        return labels.joinToString(".") to end
    }

    private fun label(from: Int, n: Int): String {
        val sb = StringBuilder(n)
        for (i in from until from + n) {
            val c = u8(i)
            if (c >= 0x80) throw MdnsPacketError("bad_label")
            sb.append(c.toChar().lowercaseChar())
        }
        return sb.toString()
    }

    fun rdata(type: MdnsType, start: Int, end: Int): MdnsData = when (type) {
        MdnsType.A -> {
            if (end - start != 4) throw MdnsPacketError("bad_rdata")
            MdnsData.Address((start until end).joinToString(".") { u8(it).toString() })
        }

        MdnsType.AAAA -> {
            if (end - start != V6_BYTES) throw MdnsPacketError("bad_rdata")
            MdnsData.Address(text6(IntArray(V6_BYTES / 2) { (u8(start + 2 * it) shl FIELD_BITS) or u8(start + 2 * it + 1) }))
        }

        MdnsType.PTR -> {
            val (name, after) = name(start)
            if (after != end) throw MdnsPacketError("bad_rdata")
            MdnsData.Ptr(name)
        }

        MdnsType.SRV -> {
            if (end - start < SRV_FIXED + 1) throw MdnsPacketError("bad_rdata")
            val (target, after) = name(start + SRV_FIXED)
            if (after != end) throw MdnsPacketError("bad_rdata")
            MdnsData.Srv(port = u16(start + 4), target = target, priority = u16(start), weight = u16(start + 2))
        }

        MdnsType.TXT -> txt(start, end)
    }

    private fun txt(start: Int, end: Int): MdnsData.Txt {
        val out = ArrayList<String>()
        var cur = start
        while (cur < end) {
            val n = u8(cur)
            if (cur + 1 + n > end) throw MdnsPacketError("bad_rdata")
            if (n > 0 && out.size < MDNS_MAX_TXT) out += String(buf, cur + 1, n, Charsets.UTF_8)
            cur += 1 + n
        }
        return MdnsData.Txt(out)
    }

    fun records(start: Int, count: Int, keep: Boolean): Pair<List<MdnsRecord>, Int> {
        val out = ArrayList<MdnsRecord>()
        var pos = start
        repeat(count) {
            val (name, after) = name(pos)
            pos = after
            if (pos + 10 > buf.size) throw MdnsPacketError("truncated")
            val code = u16(pos)
            val rclass = u16(pos + 2)
            val ttl = u32(pos + 4)
            val rdlen = u16(pos + 8)
            pos += 10
            val end = pos + rdlen
            if (end > buf.size) throw MdnsPacketError("truncated")
            val type = typeOf(code)
            if (keep && type != null && (rclass and CACHE_FLUSH.inv()) == CLASS_IN) out += MdnsRecord(name, type, ttl, rdata(type, pos, end))
            pos = end
        }
        return out to pos
    }
}

/** Decode a datagram, or throw [MdnsPacketError]. */
public fun parseMdnsPacket(data: ByteArray): MdnsPacket {
    if (data.size > MDNS_MAX_PACKET) throw MdnsPacketError("packet_too_large")
    if (data.size < HEADER) throw MdnsPacketError("truncated")
    val r = Reader(data)
    val flags = r.u16(2)
    val counts = IntArray(4) { r.u16(4 + 2 * it) }
    if (counts.max() > MDNS_MAX_RECORDS) throw MdnsPacketError("too_many_records")
    var pos = HEADER
    val questions = ArrayList<MdnsQuestion>()
    repeat(counts[0]) {
        val (name, after) = r.name(pos)
        pos = after
        if (pos + 4 > data.size) throw MdnsPacketError("truncated")
        typeOf(r.u16(pos))?.let { questions += MdnsQuestion(name, it) }
        pos += 4
    }
    val (answers, afterAnswers) = r.records(pos, counts[1], true)
    val (_, afterAuthority) = r.records(afterAnswers, counts[2], false)
    val (extra, _) = r.records(afterAuthority, counts[3], true)
    return MdnsPacket((flags and RESPONSE_BIT) != 0, questions, answers + extra)
}

private fun u16(out: ByteArrayOutputStream, v: Int) {
    out.write((v shr FIELD_BITS) and BYTE)
    out.write(v and BYTE)
}

private fun encodeName(name: String): ByteArray {
    val out = ByteArrayOutputStream()
    val trimmed = name.removeSuffix(".")
    if (trimmed.isNotEmpty()) {
        for (label in trimmed.split(".")) {
            require(label.all { it.code < 0x80 }) { "name: not ASCII" }
            require(label.length in 1..MDNS_MAX_LABEL) { "name: label length" }
            out.write(label.length)
            out.write(label.toByteArray(Charsets.US_ASCII))
        }
    }
    out.write(0)
    require(out.size() <= MDNS_MAX_NAME) { "name: too long" }
    return out.toByteArray()
}

private fun ipv4(text: String): ByteArray {
    val parts = text.split(".")
    require(
        parts.size == 4 && parts.all { p ->
            p.isNotEmpty() && p.all { it in '0'..'9' } && p == p.toInt().toString() && p.toInt() < 256
        },
    ) { "a: not an IPv4 address" }
    return ByteArray(4) { parts[it].toInt().toByte() }
}

private fun ipv6(text: String): ByteArray {
    val a = parseLanAddress(text, foldMapped = false)
    val g = a?.v6
    require(a != null && g != null && a.zone == null) { "aaaa: not an IPv6 address" }
    return ByteArray(V6_BYTES) { ((if (it % 2 == 0) g[it / 2] shr FIELD_BITS else g[it / 2]) and BYTE).toByte() }
}

private fun encodeTxt(data: MdnsData.Txt): ByteArray {
    require(data.entries.size <= MDNS_MAX_TXT) { "txt: too many entries" }
    val out = ByteArrayOutputStream()
    for (e in data.entries) {
        val b = e.toByteArray(Charsets.UTF_8)
        require(b.size <= MAX_TXT_ENTRY) { "txt: entry too long" }
        out.write(b.size)
        out.write(b)
    }
    if (out.size() == 0) out.write(0)
    return out.toByteArray()
}

private fun encodeRdata(data: MdnsData, type: MdnsType): ByteArray {
    val out = ByteArrayOutputStream()
    when {
        type == MdnsType.PTR && data is MdnsData.Ptr -> out.write(encodeName(data.name))

        type == MdnsType.SRV && data is MdnsData.Srv -> {
            require(data.port in 0..WORD && data.priority in 0..WORD && data.weight in 0..WORD) { "srv: field range" }
            u16(out, data.priority)
            u16(out, data.weight)
            u16(out, data.port)
            out.write(encodeName(data.target))
        }

        type == MdnsType.TXT && data is MdnsData.Txt -> out.write(encodeTxt(data))

        type == MdnsType.A && data is MdnsData.Address -> out.write(ipv4(data.ip))

        type == MdnsType.AAAA && data is MdnsData.Address -> out.write(ipv6(data.ip))

        else -> throw IllegalArgumentException("record data does not match its type")
    }
    return out.toByteArray()
}

/** A query packet (flags 0): `(name, type)` pairs. */
public fun buildMdnsQuery(questions: List<MdnsQuestion>, packetId: Int = 0): ByteArray {
    require(questions.size <= MDNS_MAX_RECORDS) { "too many questions" }
    val out = ByteArrayOutputStream()
    u16(out, packetId and WORD)
    u16(out, 0)
    u16(out, questions.size)
    repeat(3) { u16(out, 0) }
    for (q in questions) {
        out.write(encodeName(q.name))
        u16(out, q.type.code)
        u16(out, CLASS_IN)
    }
    require(out.size() <= MDNS_MAX_PACKET) { "packet too large" }
    return out.toByteArray()
}

/**
 * An authoritative response packet (flags 0x8400) holding [answers]. Class IN; the cache-flush bit
 * is set on SRV, TXT, A and AAAA (unique records), never on the shared PTR.
 */
public fun buildMdnsResponse(answers: List<MdnsRecord>): ByteArray {
    require(answers.size <= MDNS_MAX_RECORDS) { "too many records" }
    val out = ByteArrayOutputStream()
    u16(out, 0)
    u16(out, RESPONSE_FLAGS)
    u16(out, 0)
    u16(out, answers.size)
    u16(out, 0)
    u16(out, 0)
    for (r in answers) {
        val rdata = encodeRdata(r.data, r.type)
        out.write(encodeName(r.name))
        u16(out, r.type.code)
        u16(out, if (r.type == MdnsType.PTR) CLASS_IN else CLASS_IN or CACHE_FLUSH)
        val ttl = r.ttl and 0xffffffffL
        u16(out, (ttl shr 16).toInt())
        u16(out, (ttl and WORD.toLong()).toInt())
        u16(out, rdata.size)
        out.write(rdata)
    }
    require(out.size() <= MDNS_MAX_PACKET) { "packet too large" }
    return out.toByteArray()
}
