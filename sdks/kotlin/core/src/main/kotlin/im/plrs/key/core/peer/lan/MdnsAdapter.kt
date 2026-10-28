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
public data class MdnsFound(val instance: String, val host: String, val port: Int, val txt: List<String>)

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

    /** [onUp] gets each complete (or changed) advert; [onDown] an instance that said goodbye or expired. */
    public suspend fun browse(onUp: (MdnsFound) -> Unit, onDown: (String) -> Unit = {}): MdnsHandle
}

/** The multicast socket the adapter drives: [send] multicasts one packet on every selected interface. */
public interface MdnsSocket {
    public fun send(data: ByteArray)

    public fun close()
}

/** Make a socket that calls `onPacket(data, sourceAddress)` for every datagram it receives. */
public fun interface MdnsSocketFactory {
    public suspend fun open(onPacket: (ByteArray, String) -> Unit): MdnsSocket
}

/** LAN discovery cannot run here: the socket could not be opened. */
public class MdnsUnavailableException(message: String, cause: Throwable? = null) : Exception(message, cause) {
    public val reason: String = "mdns_unavailable"
}

private val IPV4 = Regex("(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})")
private const val OCTET_MAX = 255
private const val CLASS_A = 10
private const val LOOPBACK = 127
private const val B_172 = 172
private const val B_172_FIRST = 16
private const val B_172_LAST = 31
private const val C_192 = 192
private const val C_168 = 168

/**
 * An address a LAN peer may legitimately have: RFC 1918, or loopback if allowed. Link-local
 * (169.254/16) and CGNAT (100.64/10) are not dialled.
 */
public fun isLanAddress(ip: String, allowLoopback: Boolean = false): Boolean {
    val m = IPV4.matchEntire(ip) ?: return false
    val g = m.groupValues.drop(1)
    if (g.any { it.length > 1 && it[0] == '0' }) return false
    val p = g.map { it.toInt() }
    if (p.any { it > OCTET_MAX }) return false
    val a = p[0]
    val b = p[1]
    return a == CLASS_A ||
        (a == B_172 && b in B_172_FIRST..B_172_LAST) ||
        (a == C_192 && b == C_168) ||
        (a == LOOPBACK && allowLoopback)
}
