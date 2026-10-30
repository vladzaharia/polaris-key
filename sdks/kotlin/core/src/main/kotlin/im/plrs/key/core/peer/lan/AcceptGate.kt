// The accept gate the LAN transports share (CC-15.K2; WIRE-CONTRACT-V5 sections 15.4.1 and 15.6.1 rule 2).
// Mode a (`ConnectLan.kt` in :sdk) and the mode-v approver ([im.plrs.key.core.peer.nearby.NearbyApprover])
// admit an inbound socket by the same rule: [socketVerdict] on the socket's own addresses and the
// [PendingLimiter]. Mirrors sdk-node's `connect/lanGate.ts`.
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
internal class GateSlot(
    /** The judged source address (a link-local one keeps its zone). */
    val address: String,
    private val onEstablished: () -> Unit,
    private val onSettle: () -> Unit,
) {
    /** The transport is up: the handshake window ends, the slot is kept. */
    fun established(): Unit = onEstablished()

    /** Release the slot and end the window. Safe to call again. */
    fun settle(): Unit = onSettle()

    override fun toString(): String = "GateSlot"
}

internal class AcceptGate(
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
    val size: Int get() = synchronized(lock) { pending.size }

    /**
     * Judge, limit and time a new inbound socket. Null means it was closed: its source is off the LAN,
     * [refuse] is set (stopped, or no room for a session), or a limit is met.
     */
    fun admit(sock: Socket, refuse: Boolean = false): GateSlot? {
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
            onEstablished = {
                cancelDeadline()
                synchronized(lock) { up += sock }
            },
            onSettle = settle,
        )
    }

    /** Close every socket that still holds a slot; [keepUp] spares those past [GateSlot.established]. */
    fun destroyPending(keepUp: Boolean = false) {
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
