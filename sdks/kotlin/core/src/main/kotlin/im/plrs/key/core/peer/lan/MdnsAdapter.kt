// WIRE-CONTRACT-V5 section 15.4: the seam between the LAN service and multicast DNS (CC-12.11).
// `MdnsAdapter` is what the service uses, so a test injects a fake; `JvmMdns` implements it on the
// bounded packet codec ([parseMdnsPacket]) and one UDP socket on 5353. Mirrors sdk-node's
// `connect/mdns.ts` and the Python `core/peer_mdns.py`.

package im.plrs.key.core.peer.lan

/** An advert to publish: [instance] is `p1-` plus 16 base32 characters; [txt] are `key=value` entries. */
public class MdnsAdvert(public val instance: String, public val port: Int, public val txt: List<String>) {
    override fun toString(): String = "MdnsAdvert(port=$port)"
}

/** A complete advert seen on the network: [host] is the address to dial. */
public data class MdnsFound(
    val instance: String,
    val host: String,
    val port: Int,
    val txt: List<String>,
    /** The addresses learned for the name, at most four, [host] first; a link-local one carries its `%zone`. A dial tries them in order. */
    val hosts: List<String> = listOf(host),
)

/** What `advertise` and `browse` return. [stop] may be called twice. */
public class MdnsHandle(private val stopper: suspend () -> Unit) {
    private var done = false

    /** End the advert or the browse; the second call does nothing. */
    public suspend fun stop() {
        synchronized(this) {
            if (done) return
            done = true
        }
        stopper()
    }
}

/** The seam the LAN service uses; callbacks run on an adapter thread and must not block. */
public interface MdnsAdapter {
    public suspend fun advertise(advert: MdnsAdvert): MdnsHandle

    /**
     * [onUp] gets each complete (or changed) advert; [onDown] an instance that said goodbye or expired.
     * Only an instance [accept] allows enters the adapter's tables (the service passes the names its
     * roster can announce), so a stranger's names cannot crowd out a real one.
     */
    public suspend fun browse(onUp: (MdnsFound) -> Unit, onDown: (String) -> Unit = {}, accept: (String) -> Boolean = { true }): MdnsHandle
}

/**
 * The multicast socket the adapter drives: [send] multicasts one packet to 224.0.0.251 on every selected
 * interface, and [send6] one packet to ff02::fb on the link [zone] only (an AAAA record names the
 * interface it leaves on).
 */
public interface MdnsSocket {
    public fun send(data: ByteArray)

    /** The default does nothing: a socket without IPv6 has no link to send on. */
    public fun send6(data: ByteArray, zone: String) {}

    public fun close()
}

/**
 * Make a socket that calls `onPacket(data, sourceAddress)` for every datagram it receives. The source is
 * the address as RFC 5952 text; a link-local IPv6 source carries the zone of the arrival interface
 * (`fe80::1%en0`).
 */
public fun interface MdnsSocketFactory {
    public suspend fun open(onPacket: (ByteArray, String) -> Unit): MdnsSocket
}

/** LAN discovery cannot run here: the socket could not be opened. */
public class MdnsUnavailableException(message: String, cause: Throwable? = null) : Exception(message, cause) {
    public val reason: String = "mdns_unavailable"
}

/**
 * An IPv4 address a LAN peer may legitimately have: RFC 1918, or loopback if allowed. Link-local
 * (169.254/16) and CGNAT (100.64/10) are not. It is [lanVerdict] on the IPv4 literal; an IPv6 address
 * is never one of the device's own advert addresses.
 */
public fun isLanAddress(ip: String, allowLoopback: Boolean = false): Boolean = !ip.contains(':') && lanVerdict(ip, null, allowLoopback).dial
