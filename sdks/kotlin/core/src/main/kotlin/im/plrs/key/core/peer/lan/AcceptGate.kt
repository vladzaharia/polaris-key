// The accept gate of the mode-v approver (CC-15.K2; WIRE-CONTRACT-V5 sections 15.4.1 and 15.6.1 rule 2).
// [im.plrs.key.core.peer.nearby.NearbyApprover] admits an inbound socket by the same rule as mode a:
// [socketVerdict] on the socket's own addresses and the [PendingLimiter]. Mode a (`ConnectLan.kt` in
// :sdk) does not use this class: it keeps its own glue around the same two (a follow-up moves it onto this
// gate). Mirrors sdk-node's `connect/lanGate.ts`.
//
// Rules this file keeps:
// - an accepted socket is judged before a byte is read; one that fails, or one refused for capacity, is
//   closed at once and costs no slot;
// - unauthenticated sockets are bounded in number, per address and per group (the limiter); a slot lives
//   until [GateSlot.settle];
// - the handshake window ends at [GateSlot.established]: a socket past it lives on, a socket that never
//   reaches it is closed when the window lapses.

package im.plrs.key.core.peer.lan

import java.io.IOException
import java.net.Socket

/** What [AcceptGate.admit] hands back for an admitted socket. */
public class GateSlot internal constructor(
    /** The judged source address (a link-local one keeps its zone). */
    public val address: String,
    /** The source group (a link, an IPv4 /24 or an IPv6 /64; the address when it has none). */
    public val group: String,
    private val onEstablished: () -> Unit,
    private val onSettle: () -> Unit,
) {
    /** The transport is up: the handshake window ends, the slot is kept. */
    public fun established(): Unit = onEstablished()

    /** Release the slot and end the window. Safe to call again. */
    public fun settle(): Unit = onSettle()

    override fun toString(): String = "GateSlot"
}

public class AcceptGate(
    private val allowLoopback: Boolean = false,
    maxPending: Int = LAN_MAX_PENDING,
    maxPendingPerAddress: Int = LAN_MAX_PENDING_PER_ADDRESS,
    maxPendingPerGroup: Int = LAN_MAX_PENDING_PER_GROUP,
    private val handshakeSeconds: Double = 30.0,
    /** Schedule `fn` after `seconds`; returns the cancel. */
    private val schedule: (Double, () -> Unit) -> (() -> Unit),
) {
    private val lock = Any()
    private val limiter = PendingLimiter(maxPending, maxPendingPerAddress, maxPendingPerGroup)
    private val pending = HashSet<Socket>()
    private val up = HashSet<Socket>()

    /** Sockets that hold a slot. */
    public val size: Int get() = synchronized(lock) { pending.size }

    /**
     * Judge, limit and time a new inbound socket. Null means it was closed: its source is off the LAN,
     * [refuse] is set (stopped, or no room for a session), or a limit is met.
     */
    public fun admit(sock: Socket, refuse: Boolean = false): GateSlot? {
        // Judged first, on the socket's own addresses and before a byte is read: a source off the LAN is
        // closed at once and costs no slot.
        val v = socketVerdict(literalOfInetAddress(sock.inetAddress), literalOfInetAddress(sock.localAddress), allowLoopback)
        val key = v.key
        val release = if (v.dial && key != null && !refuse) synchronized(lock) { limiter.take(key)?.also { pending += sock } } else null
        if (key == null || release == null) {
            close(sock)
            return null
        }
        var cancelDeadline: () -> Unit = {}
        val settle: () -> Unit = {
            cancelDeadline()
            synchronized(lock) {
                up -= sock
                if (pending.remove(sock)) release()
            }
        }
        // An unauthenticated socket lives for the handshake window and no longer.
        cancelDeadline = schedule(handshakeSeconds) {
            close(sock)
            settle()
        }
        return GateSlot(
            key,
            lanGroupKey(key) ?: key,
            onEstablished = {
                cancelDeadline()
                synchronized(lock) { up += sock }
            },
            onSettle = settle,
        )
    }

    /** Close every socket that still holds a slot; [keepUp] spares those past [GateSlot.established]. */
    public fun destroyPending(keepUp: Boolean = false) {
        val socks = synchronized(lock) { pending.filter { !keepUp || it !in up } }
        for (s in socks) close(s)
    }

    private fun close(s: Socket) {
        try {
            s.close()
        } catch (e: IOException) {
            // already closed
        }
    }

    override fun toString(): String = "AcceptGate"
}
