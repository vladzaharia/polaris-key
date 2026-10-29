// Which peer addresses the JVM LAN adapter dials and accepts (WIRE-CONTRACT-V5 section 15.4.1), around
// [lanVerdict] (CC-IPV6.5b). Mirrors sdk-node's `connect/lanJudge.ts`:
//  - the address TEXT is judged before a socket is opened, and the connected socket again (its remote
//    and its own local address) before its first byte, on a dial and on an accept;
//  - the pre-handshake limiter counts per address (4), per /64 (16) and in total (32); a link-local key
//    carries its zone, because the same fe80 address on two links is two hosts.

package im.plrs.key.core.peer.lan

/** Unauthenticated sockets at once (G7). */
public const val LAN_MAX_PENDING: Int = 32

/** Unauthenticated sockets per source address (G7). */
public const val LAN_MAX_PENDING_PER_ADDRESS: Int = 4

/** Unauthenticated sockets per source /64 (section 15.4.1). */
public const val LAN_MAX_PENDING_PER_GROUP: Int = 16

private val REFUSED = LanVerdict(false, null)

/**
 * Judge an address before opening a socket. The address itself stands in for "some local address in the
 * same /64", so a global or ULA IPv6 address passes here when it could be on-link; the connected socket
 * decides with its own local address.
 */
public fun textVerdict(host: String, allowLoopback: Boolean): Boolean = lanVerdict(host, host.substringBefore('%'), allowLoopback).dial

/** Judge a connected socket's addresses: after `connect`, and at `accept`, before any byte is read or written. */
public fun socketVerdict(remote: String?, local: String?, allowLoopback: Boolean): LanVerdict =
    if (remote.isNullOrEmpty()) REFUSED else lanVerdict(remote, local?.takeIf { it.isNotEmpty() }, allowLoopback)

/**
 * Counts of sockets that have not finished the handshake. Not thread-safe: the caller holds its own lock.
 * [take] gives a slot for a verdict key, or null when a limit is met.
 */
public class PendingLimiter(
    private val max: Int = LAN_MAX_PENDING,
    private val perAddress: Int = LAN_MAX_PENDING_PER_ADDRESS,
    private val perGroup: Int = LAN_MAX_PENDING_PER_GROUP,
) {
    private val addresses = HashMap<String, Int>()
    private val groups = HashMap<String, Int>()
    private var total = 0

    /** Sockets holding a slot. */
    public val size: Int get() = total

    /** The slots held per address key (a test hook). */
    public fun perAddressCounts(): Map<String, Int> = HashMap(addresses)

    /** Take a slot for the address [key] of an allowed verdict; returns the release, or null when a limit is met. */
    public fun take(key: String): (() -> Unit)? {
        val group = lanGroupKey(key)
        val full = total >= max || (addresses[key] ?: 0) >= perAddress || (group != null && (groups[group] ?: 0) >= perGroup)
        if (full) return null
        total++
        bump(addresses, key, 1)
        if (group != null) bump(groups, group, 1)
        var done = false
        return {
            if (!done) {
                done = true
                total--
                bump(addresses, key, -1)
                if (group != null) bump(groups, group, -1)
            }
        }
    }

    private fun bump(m: MutableMap<String, Int>, key: String, by: Int) {
        val n = (m[key] ?: 0) + by
        if (n <= 0) m.remove(key) else m[key] = n
    }
}
