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

/** Interface names that are tunnels whatever their flags say (VPNs, `utun`, PPP, WireGuard, IPsec, GIF, 6to4). */
private val TUNNEL_NAMES = Regex("^(utun|tun|ppp|wg|ipsec|gif|stf)[0-9]*$", RegexOption.IGNORE_CASE)

private fun onAndroid(): Boolean = System.getProperty("java.vendor").orEmpty().contains("Android", ignoreCase = true) ||
    System.getProperty("java.vm.name").orEmpty().contains("Dalvik", ignoreCase = true)

/**
 * What the platform says of one interface. [hasHardware] is a hardware address that is not all zeros;
 * [hardwareKnown] is false where the platform hides hardware addresses from apps (Android 11 and later),
 * and the test is then the flags and the name only.
 */
internal data class IfaceFacts(
    val up: Boolean,
    val multicast: Boolean,
    val loopback: Boolean,
    val pointToPoint: Boolean,
    val name: String,
    val hasHardware: Boolean,
    val hardwareKnown: Boolean,
)

private fun IfaceFacts.isTunnel(): Boolean = pointToPoint ||
    TUNNEL_NAMES.matches(name) ||
    (hardwareKnown && !hasHardware)

/**
 * Whether an interface counts for the mDNS source test, the join and the unions of subnets (section 15.4):
 * up, multicast-capable, loopback only when allowed, and not a tunnel, point-to-point or pseudo-interface
 * (a VPN, `utun`, `ppp`, WireGuard). Where the platform has no flag for a tunnel, an interface with no
 * hardware address (or an all-zero one) is taken as one.
 */
internal fun countsAsLan(f: IfaceFacts, allowLoopback: Boolean): Boolean = f.up && f.multicast && if (f.loopback) allowLoopback else !f.isTunnel()

internal fun usable(ni: NetworkInterface, allowLoopback: Boolean): Boolean = runCatching {
    val facts = IfaceFacts(
        up = ni.isUp,
        multicast = ni.supportsMulticast(),
        loopback = ni.isLoopback,
        pointToPoint = ni.isPointToPoint,
        name = ni.name,
        hasHardware = runCatching { ni.hardwareAddress }.getOrNull()?.any { it.toInt() != 0 } == true,
        hardwareKnown = !onAndroid(),
    )
    countsAsLan(facts, allowLoopback)
}.getOrDefault(false)

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
 * The IPv6 links mDNS uses: [usable] (so no tunnel or point-to-point interface), with an fe80 address; at
 * most [MDNS_MAX_INTERFACES], in name order. Loopback has no link-local address, so [allowLoopback] adds
 * nothing here.
 */
public fun lanInterfaces6(allowLoopback: Boolean = false): List<Mdns6Interface> = allInterfaces()
    .filter { usable(it, allowLoopback) }
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
