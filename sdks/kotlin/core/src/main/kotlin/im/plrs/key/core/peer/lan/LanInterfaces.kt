// The network interfaces the mDNS adapter uses (section 15.4): the IPv4 addresses of the private,
// multicast-capable ones (CC-12.11), and the IPv6 links with an fe80 address, at most eight (CC-IPV6.5a).
// Only the standard library, so it runs on Android API 24.

package im.plrs.key.core.peer.lan

import java.net.Inet4Address
import java.net.Inet6Address
import java.net.NetworkInterface

/** IPv6 interfaces used (section 15.4). */
public const val MDNS_MAX_INTERFACES: Int = 8

private const val ZONE_MAX = 15

private fun allInterfaces(): List<NetworkInterface> =
    runCatching { NetworkInterface.getNetworkInterfaces()?.toList().orEmpty() }.getOrDefault(emptyList())

internal fun usable(ni: NetworkInterface, allowLoopback: Boolean): Boolean =
    runCatching { ni.isUp && ni.supportsMulticast() && (allowLoopback || !ni.isLoopback) }.getOrDefault(false)

/** The IPv4 addresses of the interfaces mDNS would use: up, multicast-capable, private (not loopback unless allowed). */
public fun lanInterfaces(allowLoopback: Boolean = false): List<Pair<NetworkInterface, String>> = allInterfaces()
    .filter { usable(it, allowLoopback) }
    .flatMap { ni ->
        ni.inetAddresses.toList()
            .mapNotNull { (it as? Inet4Address)?.hostAddress }
            .filter { isLanAddress(it, allowLoopback) }
            .map { ni to it }
    }

/**
 * An IPv6 link mDNS uses. [zone] is what follows `%` in an address on this link (the interface name on
 * POSIX, its index on Windows). [addresses] are its fe80::/10 addresses without a zone, for the AAAA
 * records of an advert. [nets] are its connected subnets as CIDR text (`fe80::1/64`, `fd12::5/64`).
 */
public class Mdns6Interface(public val name: String, public val zone: String, public val addresses: List<String>, public val nets: List<String>) {
    override fun toString(): String = "Mdns6Interface($name)"
}

/** The IPv6 addresses of [ni] (groups) with their prefix lengths. */
private fun v6Parts(ni: NetworkInterface): List<Pair<IntArray, Int>> = ni.interfaceAddresses.mapNotNull { ia ->
    val g = (ia.address as? Inet6Address)?.let { parseLanAddress(literalOfInetAddress(it).substringBefore('%'))?.v6 }
    g?.let { it to ia.networkPrefixLength.toInt() }
}

/** The link of [ni] when it has an fe80 address and a zone that fits; null otherwise. */
private fun link6(ni: NetworkInterface): Mdns6Interface? {
    val parts = v6Parts(ni)
    val ll = parts.filter { isLinkLocal(it.first) }
    val zone = if (isWindows()) ni.index.toString() else ni.name
    val nets = parts.map { "${text6(it.first)}/${it.second}" }
    return if (ll.isEmpty() || zone.length > ZONE_MAX) null else Mdns6Interface(ni.name, zone, ll.map { text6(it.first) }, nets)
}

/**
 * The IPv6 links mDNS uses: up, multicast-capable, not a point-to-point tunnel, with an fe80 address; at
 * most [MDNS_MAX_INTERFACES], in name order. Loopback has no link-local address, so [allowLoopback] adds
 * nothing here.
 */
public fun lanInterfaces6(allowLoopback: Boolean = false): List<Mdns6Interface> = allInterfaces()
    .filter { usable(it, allowLoopback) && !runCatching { it.isPointToPoint }.getOrDefault(true) }
    .mapNotNull(::link6)
    .sortedBy { it.name }
    .take(MDNS_MAX_INTERFACES)

/** The connected subnets (CIDR text) of the IPv4 interfaces in [selected], or of every usable one. */
internal fun subnets4(allowLoopback: Boolean, selected: List<NetworkInterface>?): List<String> {
    val ifs = selected ?: allInterfaces().filter { usable(it, allowLoopback) }
    return ifs.flatMap { ni ->
        ni.interfaceAddresses.mapNotNull { ia -> (ia.address as? Inet4Address)?.let { "${it.hostAddress}/${ia.networkPrefixLength}" } }
    }
}
