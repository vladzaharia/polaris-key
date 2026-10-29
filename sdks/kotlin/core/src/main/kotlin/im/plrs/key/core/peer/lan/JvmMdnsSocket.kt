// The real mDNS socket (CC-12.11, CC-IPV6.5a): one `MulticastSocket` on 5353 serves both families. It
// joins 224.0.0.251 on each IPv4 interface and ff02::fb on each IPv6 link, reads on a daemon thread and
// hands each datagram to the adapter with its source as canonical text (a link-local IPv6 source carries
// the zone of the arrival interface). A link-local source that arrived on a link we did not join is never
// passed on. Only the standard library, so it runs on Android API 24.

package im.plrs.key.core.peer.lan

import java.io.IOException
import java.net.DatagramPacket
import java.net.Inet6Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.NetworkInterface

/** The IPv4 mDNS group. */
public const val MDNS_GROUP: String = "224.0.0.251"

/** The IPv6 link-local mDNS group. */
public const val MDNS_GROUP6: String = "ff02::fb"

/** The mDNS port. */
public const val MDNS_PORT: Int = 5353

private const val MULTICAST_TTL = 255
private const val RECEIVE_BUFFER = MDNS_MAX_PACKET + 1
private const val RETRY_READ_MILLIS = 100L

/** The real socket: one `MulticastSocket` on 5353, joined to the groups on each interface, read on a daemon thread. */
internal class JvmMdnsSocket(
    private val sock: MulticastSocket,
    private val ifaces: List<NetworkInterface>,
    private val links6: Map<String, NetworkInterface>,
    private val zones: Set<String>,
) : MdnsSocket {
    @Volatile
    private var closed = false

    /** One datagram, or null when the socket failed or the datagram is not ours to hear. */
    private fun receive(buf: ByteArray): Pair<ByteArray, String>? {
        val p = DatagramPacket(buf, buf.size)
        sock.receive(p)
        val src = literalOfInetAddress(p.address)
        // A link-local source that arrived on an interface we did not join is not ours to hear.
        val zone = src.substringAfter('%', "")
        val heard = src.isNotEmpty() && (zone.isEmpty() || zone in zones)
        return if (heard) p.data.copyOfRange(p.offset, p.offset + p.length) to src else null
    }

    private fun readLoop(onPacket: (ByteArray, String) -> Unit) {
        val buf = ByteArray(RECEIVE_BUFFER)
        while (!closed) {
            val got = runCatching { receive(buf) }
            if (got.isFailure && !closed) Thread.sleep(RETRY_READ_MILLIS) // a socket that keeps failing does not spin
            // a bad packet or a host callback never stops the socket
            got.getOrNull()?.let { (data, src) -> runCatching { onPacket(data, src) } }
        }
    }

    fun startReader(onPacket: (ByteArray, String) -> Unit) {
        val t = Thread { readLoop(onPacket) }
        t.isDaemon = true
        t.name = "polaris-key-mdns"
        t.start()
    }

    override fun send(data: ByteArray) {
        if (closed) return
        val dest = InetSocketAddress(InetAddress.getByName(MDNS_GROUP), MDNS_PORT)
        val targets: List<NetworkInterface?> = ifaces.ifEmpty { listOf(null) }
        for (ni in targets) sendOn(ni, dest, data)
    }

    override fun send6(data: ByteArray, zone: String) {
        if (closed) return
        val ni = links6[zone] ?: return
        val group = Inet6Address.getByAddress(null, inetAddressOfLiteral(MDNS_GROUP6)!!.address, ni.index)
        sendOn(ni, InetSocketAddress(group, MDNS_PORT), data)
    }

    /** This interface may be down for now: a failed send is dropped. */
    private fun sendOn(ni: NetworkInterface?, dest: InetSocketAddress, data: ByteArray) {
        runCatching {
            synchronized(sock) {
                if (ni != null) sock.networkInterface = ni
                sock.send(DatagramPacket(data, data.size, dest))
            }
        }
    }

    override fun close() {
        closed = true
        sock.close()
    }
}

/** Join [group] on [ni]; false when the link refuses it. */
private fun MulticastSocket.joinOn(group: InetSocketAddress, ni: NetworkInterface?): Boolean = runCatching { joinGroup(group, ni) }.isSuccess

/**
 * Open the socket: bound with address reuse to 5353, joined to the IPv4 group on [ifaces] (on the default
 * interface when none joins and [fallback] allows it) and to ff02::fb on each of [links] that accepts it.
 * IPv6 is best effort: a host without it, or a link that refuses the group, is skipped. Throws
 * [MdnsUnavailableException] when the socket cannot be opened at all.
 */
internal fun openMulticastSocket(
    ifaces: List<NetworkInterface>,
    links: List<Mdns6Interface>,
    fallback: Boolean,
    onPacket: (ByteArray, String) -> Unit,
): MdnsSocket {
    val byZone = HashMap<String, NetworkInterface>()
    for (l in links) runCatching { NetworkInterface.getByName(l.name) }.getOrNull()?.let { byZone[l.zone] = it }
    val sock = try {
        MulticastSocket(null as InetSocketAddress?).also {
            it.reuseAddress = true
            it.bind(InetSocketAddress(MDNS_PORT))
            it.timeToLive = MULTICAST_TTL
            val group = InetSocketAddress(InetAddress.getByName(MDNS_GROUP), MDNS_PORT)
            val joined = ifaces.count { ni -> it.joinOn(group, ni) }
            if (joined == 0 && fallback) it.joinGroup(group, null)
            val group6 = InetSocketAddress(inetAddressOfLiteral(MDNS_GROUP6)!!, MDNS_PORT)
            byZone.keys.toList().filterNot { zone -> it.joinOn(group6, byZone.getValue(zone)) }.forEach { zone -> byZone.remove(zone) }
        }
    } catch (e: IOException) {
        throw MdnsUnavailableException("The mDNS socket could not be opened; LAN discovery is off.", e)
    }
    return JvmMdnsSocket(sock, ifaces, byZone, byZone.keys.toSet()).also { it.startReader(onPacket) }
}
