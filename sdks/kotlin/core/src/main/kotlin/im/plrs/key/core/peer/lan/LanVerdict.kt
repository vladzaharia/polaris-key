// WIRE-CONTRACT-V5 section 15.4.1: which peer address a device may dial or accept on the local network,
// and the keys of the per-address and per-/64 connection counts (CC-IPV6.5a). Pure: text in, a verdict
// out, so the JVM adapters and Android reuse it. It mirrors client-core `peer/lanAddress.ts`
// (`lanVerdict`, `lanGroupKey`), which the `lanAddresses` rows of peer-matrix.json pin.
//   - IPv4: 10/8, 172.16/12 and 192.168/16; 127/8 only with `allowLoopback`;
//   - IPv6: fe80::/10; fc00::/7 (when `local` is known it must be IPv6 in the same /64); ::1 only with
//     `allowLoopback`; an address in 2000::/3 outside 2001::/32 (Teredo) and 2002::/16 (6to4) only
//     when the local address is IPv6 in the same /64;
//   - everything else is refused, including text that is not an address. The verdict ignores a zone;
//     the key of a link-local address keeps it.

package im.plrs.key.core.peer.lan

private const val GROUPS = 8
private const val V4_OCTETS = 4
private const val BYTE_BITS = 8
private const val GROUP_BITS = 16
private const val PREFIX_GROUPS = 4
private const val ULA = 0xfc00
private const val ULA_MASK = 0xfe00
private const val GLOBAL = 0x2000
private const val GLOBAL_MASK = 0xe000
private const val TEREDO = 0x2001
private const val SIX_TO_FOUR = 0x2002
private const val LOOPBACK_NET = 127
private const val NET_10 = 10
private const val NET_172 = 172
private const val NET_172_FIRST = 16
private const val NET_172_LAST = 31
private const val NET_192 = 192
private const val NET_168 = 168

private val REFUSED = LanVerdict(false, null)

/** The answer of [lanVerdict]: [dial] says whether the address may be dialled or accepted; [key] is the per-address count key. */
public data class LanVerdict(val dial: Boolean, val key: String?)

private fun allowed4(o: IntArray, allowLoopback: Boolean): Boolean {
    val a = o[0]
    val b = o[1]
    return a == NET_10 ||
        (a == NET_172 && b in NET_172_FIRST..NET_172_LAST) ||
        (a == NET_192 && b == NET_168) ||
        (a == LOOPBACK_NET && allowLoopback)
}

/** [local] is IPv6 (not mapped) and shares the first 64 bits with [g]. */
private fun sameSlash64(g: IntArray, local: String): Boolean {
    val l = parseLanAddress(local)?.v6
    return l != null && (0 until PREFIX_GROUPS).all { l[it] == g[it] }
}

private fun isLoopback6(g: IntArray) = (0 until GROUPS - 1).all { g[it] == 0 } && g[GROUPS - 1] == 1

private fun isTeredoOr6to4(g: IntArray) = (g[0] == TEREDO && g[1] == 0) || g[0] == SIX_TO_FOUR

private fun allowed6(g: IntArray, local: String?, allowLoopback: Boolean): Boolean = when {
    isLoopback6(g) -> allowLoopback

    isLinkLocal(g) -> true

    // fc00::/7 is routed, so it is on-link only when the local address says so.
    (g[0] and ULA_MASK) == ULA -> local == null || sameSlash64(g, local)

    (g[0] and GLOBAL_MASK) != GLOBAL -> false

    // not 2000::/3
    isTeredoOr6to4(g) -> false

    else -> local != null && sameSlash64(g, local)
}

/** The per-address key: a link-local address keeps its zone, any other drops it. */
private fun keyOf(p: LanAddr): String = if (p.zone != null && p.v6 != null && isLinkLocal(p.v6)) "${p.text()}%${p.zone}" else p.text()

/**
 * Judge a peer address.
 *
 * [remote] is the connected socket's remote address as text, with or without a zone. [local] is the
 * socket's own local address, or null when unknown (a global IPv6 address is then refused, and a ULA
 * address is judged on its own). [allowLoopback] accepts 127/8 and ::1: tests and same-host peers
 * only; production code never sets it and it is not public API of any SDK.
 */
public fun lanVerdict(remote: String, local: String?, allowLoopback: Boolean): LanVerdict {
    val p = parseLanAddress(remote)
    val ok = when {
        p == null -> false
        p.v4 != null -> allowed4(p.v4, allowLoopback)
        else -> allowed6(p.v6!!, local, allowLoopback)
    }
    return if (p != null && ok) LanVerdict(true, keyOf(p)) else REFUSED
}

/**
 * The key of the per-/64 count for a verdict [key]: the /64 of an IPv6 address (`2001:db8:1:2::/64`;
 * a link-local /64 keeps the zone, `fe80::/64%en0`), null for IPv4 and for no key.
 */
public fun lanGroupKey(key: String?): String? {
    val p = key?.takeIf { it.contains(':') }?.let { parseLanAddress(it) }
    val g = p?.v6 ?: return null
    val text = "${text6(IntArray(GROUPS) { if (it < PREFIX_GROUPS) g[it] else 0 })}/64"
    return if (p.zone == null) text else "$text%${p.zone}"
}

/** The first [prefix] bits of [x] and [y] agree; each element is [width] bits. */
private fun prefixMatches(x: IntArray, y: IntArray, prefix: Int): Boolean {
    val width = if (x.size == V4_OCTETS) BYTE_BITS else GROUP_BITS
    return prefix in 0..x.size * width &&
        x.indices.all { i ->
            val shift = width - (prefix - i * width).coerceIn(0, width)
            (x[i] shr shift) == (y[i] shr shift)
        }
}

/** True when the literal [addr] lies in the CIDR block [cidr] (`10.0.0.5/8`, `fe80::1/64`); a mapped address counts as its IPv4. */
internal fun cidrContains(cidr: String, addr: String): Boolean {
    val slash = cidr.lastIndexOf('/')
    val net = if (slash < 0) null else parseLanAddress(cidr.substring(0, slash))
    val prefix = if (slash < 0) null else cidr.substring(slash + 1).toIntOrNull()
    val a = parseLanAddress(addr)
    return when {
        a == null || net == null -> false
        prefix == null || a.isV4 != net.isV4 -> false
        else -> prefixMatches(a.parts(), net.parts(), prefix)
    }
}
