// The JVM side of the LAN address helpers (CC-IPV6.5a): turn a literal that [lanVerdict] allowed into a
// socket address without a resolver, and a socket's address back into canonical text. A link-local
// address carries its link as the zone: the interface name on POSIX, its index on Windows (where names
// are too long for a zone, section 15.4.1). Only the standard library, so it runs on Android API 24.

package im.plrs.key.core.peer.lan

import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.NetworkInterface

private const val GROUPS = 8
private const val BYTE_BITS = 8
private const val BYTE_MASK = 0xff
private const val V6_BYTES = 16

internal fun isWindows(): Boolean = System.getProperty("os.name").orEmpty().startsWith("Windows", ignoreCase = true)

/**
 * The zone text of a link: the interface name on POSIX, its index on Windows. Null when the index names
 * no interface.
 */
public fun zoneOfIndex(index: Int): String? = when {
    index <= 0 -> null
    isWindows() -> index.toString()
    else -> runCatching { NetworkInterface.getByIndex(index)?.name }.getOrNull()
}

/** The index a zone names: a number (Windows) or an interface name (POSIX). Null when it names none. */
private fun indexOfZone(zone: String): Int? =
    zone.toIntOrNull()?.takeIf { it > 0 } ?: runCatching { NetworkInterface.getByName(zone)?.index }.getOrNull()

/** The bytes of a parsed address: 4 or 16. */
private fun LanAddr.bytes(): ByteArray = v4?.let { o -> ByteArray(o.size) { o[it].toByte() } }
    ?: ByteArray(V6_BYTES).also { b ->
        for ((i, x) in v6!!.withIndex()) {
            b[2 * i] = (x shr BYTE_BITS).toByte()
            b[2 * i + 1] = (x and BYTE_MASK).toByte()
        }
    }

/**
 * Build the socket address for a literal [text] without a resolver: dotted IPv4, or IPv6 with its zone
 * turned into a scope id (a link-local address needs one to be dialled). Null when [text] is not an
 * address, or its zone names no interface.
 */
public fun inetAddressOfLiteral(text: String): InetAddress? {
    val p = parseLanAddress(text) ?: return null
    val scope = p.zone?.let { indexOfZone(it) }
    return when {
        p.zone != null && scope == null -> null
        scope != null -> runCatching { Inet6Address.getByAddress(null, p.bytes(), scope) }.getOrNull()
        else -> runCatching { InetAddress.getByAddress(p.bytes()) }.getOrNull()
    }
}

private fun v6Literal(a: InetAddress): String {
    val bytes = a.address
    val g = IntArray(GROUPS) { ((bytes[2 * it].toInt() and BYTE_MASK) shl BYTE_BITS) or (bytes[2 * it + 1].toInt() and BYTE_MASK) }
    val v6 = a as? Inet6Address
    val scope = v6?.scopeId ?: 0
    val named = if (isWindows()) null else v6?.scopedInterface?.name
    val zone = if (isLinkLocal(g)) named ?: zoneOfIndex(scope) else null
    return if (zone == null) text6(g) else "${text6(g)}%$zone"
}

/**
 * The canonical text of a socket's address: dotted IPv4, or RFC 5952 IPv6 (a link-local address keeps
 * its scope as the zone). Empty when [a] is null.
 */
public fun literalOfInetAddress(a: InetAddress?): String = when {
    a == null -> ""
    a is Inet4Address || a.address.size != V6_BYTES -> a.hostAddress.orEmpty()
    else -> v6Literal(a)
}
