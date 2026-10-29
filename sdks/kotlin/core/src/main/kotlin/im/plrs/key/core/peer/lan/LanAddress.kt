// WIRE-CONTRACT-V5 section 15.4.1: a parsed LAN address (CC-IPV6.5a). Pure: text in, a [LanAddr] out, so
// the JVM adapters and Android reuse it. It mirrors client-core `peer/lanAddress.ts`.
//   - a zone is `%` and 1 to 15 characters of U+0021 to U+007E other than `%`; a zone on IPv4 and a
//     zone on an IPv4-mapped address are malformed;
//   - an IPv4-mapped address (::ffff:0:0/96) is read as its IPv4 address;
//   - the text of an IPv6 address is RFC 5952.

package im.plrs.key.core.peer.lan

private const val GROUPS = 8
private const val ZONE_MAX = 15
private const val ZONE_FIRST = 0x21
private const val ZONE_LAST = 0x7e
private const val HEX = 16
private const val BYTE_BITS = 8
private const val BYTE_MASK = 0xff
private const val MAPPED_MARK = 0xffff
private const val MAPPED_ZERO_GROUPS = 5
private const val MAPPED_HIGH = 6
private const val MAPPED_LOW = 7
private const val LINK_LOCAL = 0xfe80
private const val LINK_LOCAL_MASK = 0xffc0

/** A parsed address: four octets (`v4`) or eight 16-bit groups (`v6`), and the zone when one was written. */
internal class LanAddr(val v4: IntArray?, val v6: IntArray?, val zone: String?) {
    val isV4: Boolean get() = v4 != null

    /** The canonical text, without a zone: dotted IPv4, or RFC 5952 IPv6. */
    fun text(): String = v4?.joinToString(".") ?: text6(v6!!)

    /** The octets (4) or the groups (8). */
    fun parts(): IntArray = v4 ?: v6!!
}

private fun zoneOk(z: String): Boolean = z.length in 1..ZONE_MAX && z.all { it.code in ZONE_FIRST..ZONE_LAST && it != '%' }

private fun isMapped(g: IntArray): Boolean = (0 until MAPPED_ZERO_GROUPS).all { g[it] == 0 } && g[MAPPED_ZERO_GROUPS] == MAPPED_MARK

private fun mappedOctets(g: IntArray): IntArray =
    intArrayOf(g[MAPPED_HIGH] shr BYTE_BITS, g[MAPPED_HIGH] and BYTE_MASK, g[MAPPED_LOW] shr BYTE_BITS, g[MAPPED_LOW] and BYTE_MASK)

private fun parseV6Address(s: String, zone: String?, foldMapped: Boolean): LanAddr? {
    val g = parseV6(s)
    return when {
        g == null -> null

        !foldMapped || !isMapped(g) -> LanAddr(null, g, zone)

        zone != null -> null

        // a zone on a mapped address is ambiguous
        else -> LanAddr(mappedOctets(g), null, null)
    }
}

/** Parse a literal; [foldMapped] reads `::ffff:a.b.c.d` as the IPv4 address `a.b.c.d`. Null: not an address. */
internal fun parseLanAddress(text: String, foldMapped: Boolean = true): LanAddr? {
    val pct = text.indexOf('%')
    val zone = if (pct >= 0) text.substring(pct + 1) else null
    val s = if (pct >= 0) text.substring(0, pct) else text
    // A bad zone (empty, a second `%`, a control, a space, too long) and a zone on IPv4 are malformed.
    val zoneBad = zone != null && (!zoneOk(zone) || !s.contains(':'))
    return when {
        zoneBad -> null
        s.contains(':') -> parseV6Address(s, zone, foldMapped)
        else -> parseV4(s)?.let { LanAddr(it, null, null) }
    }
}

/** RFC 5952: lower case, no leading zeros, the first longest run of two or more zero groups is `::`. */
internal fun text6(g: IntArray): String {
    var at = -1
    var len = 0
    var i = 0
    while (i < GROUPS) {
        val j = if (g[i] == 0) (i until GROUPS).firstOrNull { g[it] != 0 } ?: GROUPS else i + 1
        if (g[i] == 0 && j - i > len) {
            at = i
            len = j - i
        }
        i = j
    }
    fun join(xs: List<Int>) = xs.joinToString(":") { it.toString(HEX) }
    val all = g.toList()
    return if (len < 2) join(all) else "${join(all.subList(0, at))}::${join(all.subList(at + len, GROUPS))}"
}

internal fun isLinkLocal(g: IntArray) = (g[0] and LINK_LOCAL_MASK) == LINK_LOCAL
