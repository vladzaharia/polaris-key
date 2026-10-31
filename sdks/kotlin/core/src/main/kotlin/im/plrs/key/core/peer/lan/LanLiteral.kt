// WIRE-CONTRACT-V5 section 15.4.1: the literal-only address parser (CC-IPV6.5a). It never calls a
// resolver (`InetAddress.getByName`), `inet_aton` or a URL parser, because those accept spellings (a
// whole number, a leading zero, a trailing dot) that other languages refuse, and a verdict that depends
// on the parser is a hole:
//   - IPv4 is four decimal octets with no leading zero;
//   - IPv6 is eight groups with at most one `::`, and a dotted IPv4 tail only as the last two groups;
//   - ASCII only.
// The zone and the IPv4-mapped fold are in LanAddress.kt.

package im.plrs.key.core.peer.lan

private const val GROUPS = 8
private const val V4_OCTETS = 4
private const val OCTET_MAX = 255
private const val OCTET_DIGITS = 3
private const val GROUP_DIGITS = 4
private const val HEX = 16
private const val DECIMAL = 10
private const val BYTE_MASK = 0xff

private fun isDigit(c: Char) = c in '0'..'9'

private fun hexValue(c: Char): Int = when (c) {
    in '0'..'9' -> c - '0'
    in 'a'..'f' -> c - 'a' + DECIMAL
    in 'A'..'F' -> c - 'A' + DECIMAL
    else -> -1
}

/** One decimal octet, no sign and no leading zero (some parsers read a leading zero as octal); -1 when it is not one. */
private fun octet(p: String): Int {
    val shapeOk = p.length in 1..OCTET_DIGITS && p.all(::isDigit)
    val noLeadingZero = p.length <= 1 || p[0] != '0'
    val n = if (shapeOk && noLeadingZero) p.toInt() else -1
    return if (n <= OCTET_MAX) n else -1
}

internal fun parseV4(s: String): IntArray? {
    val octets = s.split('.').map(::octet)
    return if (octets.size == V4_OCTETS && octets.none { it < 0 }) octets.toIntArray() else null
}

/** One hex group of one to four digits; -1 when it is not one. */
private fun hexGroup(item: String): Int = if (item.length in 1..GROUP_DIGITS) {
    item.fold(0) { acc, c -> if (acc < 0 || hexValue(c) < 0) -1 else acc * HEX + hexValue(c) }
} else {
    -1
}

/** Add the group(s) [item] stands for to [out]; a dotted IPv4 tail ([tailAllowed]) closes the address and is two groups. */
private fun addGroup(item: String, tailAllowed: Boolean, out: MutableList<Int>): Boolean {
    if (item.contains('.')) {
        val o = if (tailAllowed) parseV4(item) else null
        if (o != null) {
            out += o[0] * (BYTE_MASK + 1) + o[1]
            out += o[2] * (BYTE_MASK + 1) + o[V4_OCTETS - 1]
        }
        return o != null
    }
    val n = hexGroup(item)
    if (n >= 0) out += n
    return n >= 0
}

private fun groupsOf(part: String, last: Boolean): List<Int>? {
    if (part.isEmpty()) return emptyList()
    val out = ArrayList<Int>()
    val items = part.split(':')
    val ok = items.withIndex().all { (i, item) -> addGroup(item, last && i == items.lastIndex, out) }
    return if (ok) out else null
}

private fun isV6Char(c: Char) = c == ':' || c == '.' || hexValue(c) >= 0

/** `::` stands for one or more zero groups. */
private fun joinHalves(halves: List<String>): IntArray? {
    val head = groupsOf(halves[0], false)
    val tail = groupsOf(halves[1], true)
    val gap = GROUPS - (head?.size ?: GROUPS) - (tail?.size ?: GROUPS)
    return if (head != null && tail != null && gap >= 1) (head + List(gap) { 0 } + tail).toIntArray() else null
}

/** `fe80::1`, `::ffff:1.2.3.4` or a full eight-group form: its groups, or null. */
internal fun parseV6(s: String): IntArray? {
    val halves = s.split("::")
    return when {
        s.isEmpty() || !s.all(::isV6Char) || halves.size > 2 -> null
        halves.size == 1 -> groupsOf(s, true)?.takeIf { it.size == GROUPS }?.toIntArray()
        else -> joinHalves(halves)
    }
}
