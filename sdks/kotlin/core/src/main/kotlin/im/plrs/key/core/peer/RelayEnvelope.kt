// WIRE-CONTRACT-V5 section 15.7: relay envelopes, one binary WebSocket message each (CC-12.3).
// Mirrors client-core's `peer/relay.ts`. A device is its 24 decoded device-id bytes. A message
// that does not match its layout exactly is refused.

package im.plrs.key.core.peer

/** The largest relay message. */
public const val RELAY_MAX_MESSAGE: Int = 65564

private const val DEVICE = 24
private const val PING = 8
private const val SESSION = 4
private const val BYTE = 0xff
private const val MAX_DEVICES = 255
private const val MAX_REASON = 4

private const val OP_SEND = 0x01
private const val OP_LIST = 0x02
private const val OP_PING = 0x03
private const val OP_RECV = 0x81
private const val OP_MEMBERS = 0x82
private const val OP_RING = 0x83
private const val OP_PONG = 0x84
private const val OP_GONE = 0x85
private const val OP_LIMIT = 0x86

/** Who sent an envelope. */
public enum class RelayDirection { toRoom, toClient }

/** One relay envelope. `toString` shows the op only: no device, session or Noise bytes. */
public sealed class RelayMessage(private val op: String) {
    public class Send(public val to: ByteArray, public val session: Long, public val noise: ByteArray) : RelayMessage("send")

    public object List : RelayMessage("list")

    public class Ping(public val data: ByteArray) : RelayMessage("ping")

    public class Recv(public val from: ByteArray, public val session: Long, public val noise: ByteArray) : RelayMessage("recv")

    public class Members(public val devices: kotlin.collections.List<ByteArray>) : RelayMessage("members")

    public class Ring(public val epoch: Long) : RelayMessage("ring")

    public class Pong(public val data: ByteArray) : RelayMessage("pong")

    public class Gone(public val device: ByteArray) : RelayMessage("gone")

    /** [reason] is 1 (rate), 2 (person), 3 (product) or 4 (paused). */
    public class Limit(public val reason: Int) : RelayMessage("limit")

    override fun toString(): String = "RelayMessage($op)"
}

private fun cat(vararg parts: ByteArray): ByteArray {
    val out = ByteArray(parts.sumOf { it.size })
    var off = 0
    for (p in parts) {
        p.copyInto(out, off)
        off += p.size
    }
    return out
}

private fun u32(n: Long): ByteArray = ByteArray(SESSION) { (n ushr (8 * (SESSION - 1 - it))).toByte() }

private fun u64(n: Long): ByteArray = ByteArray(PING) { (n ushr (8 * (PING - 1 - it))).toByte() }

private fun readU32(b: ByteArray, at: Int): Long = (0 until SESSION).fold(0L) { acc, i -> (acc shl 8) or (b[at + i].toLong() and BYTE.toLong()) }

private fun need(ok: Boolean) = require(ok) { "relay envelope" }

private fun routed(op: Int, device: ByteArray, session: Long, noise: ByteArray): ByteArray {
    need(device.size == DEVICE && session in 0..0xffffffffL && noise.size in 1..MAX_FRAME)
    return cat(byteArrayOf(op.toByte()), device, u32(session), noise)
}

/** Encodes one message; throws [IllegalArgumentException] on a value its layout cannot hold. */
public fun encodeRelay(m: RelayMessage): ByteArray {
    val out = when (m) {
        is RelayMessage.Send -> routed(OP_SEND, m.to, m.session, m.noise)

        is RelayMessage.Recv -> routed(OP_RECV, m.from, m.session, m.noise)

        RelayMessage.List -> byteArrayOf(OP_LIST.toByte())

        is RelayMessage.Ping -> byteArrayOf(OP_PING.toByte()) + m.data.also { need(it.size == PING) }

        is RelayMessage.Pong -> byteArrayOf(OP_PONG.toByte()) + m.data.also { need(it.size == PING) }

        is RelayMessage.Members -> {
            need(m.devices.size <= MAX_DEVICES && m.devices.all { it.size == DEVICE })
            m.devices.fold(byteArrayOf(OP_MEMBERS.toByte(), m.devices.size.toByte())) { acc, d -> acc + d }
        }

        is RelayMessage.Ring -> byteArrayOf(OP_RING.toByte()) + u64(m.epoch.also { need(it >= 0) })

        is RelayMessage.Gone -> byteArrayOf(OP_GONE.toByte()) + m.device.also { need(it.size == DEVICE) }

        is RelayMessage.Limit -> byteArrayOf(OP_LIMIT.toByte(), m.reason.also { need(it in 1..MAX_REASON) }.toByte())
    }
    need(out.size <= RELAY_MAX_MESSAGE)
    return out
}

/** Decodes one message sent in direction [dir]. Null means refused (the caller closes the socket). */
public fun decodeRelay(dir: RelayDirection, b: ByteArray): RelayMessage? {
    if (b.isEmpty() || b.size > RELAY_MAX_MESSAGE) return null
    val op = b[0].toInt() and BYTE
    val rest = b.copyOfRange(1, b.size)
    return if (dir == RelayDirection.toRoom) decodeToRoom(op, rest) else decodeToClient(op, rest)
}

private fun decodeToRoom(op: Int, rest: ByteArray): RelayMessage? = when {
    op == OP_SEND && rest.size >= DEVICE + SESSION + 1 ->
        RelayMessage.Send(rest.copyOfRange(0, DEVICE), readU32(rest, DEVICE), rest.copyOfRange(DEVICE + SESSION, rest.size))

    op == OP_LIST && rest.isEmpty() -> RelayMessage.List

    op == OP_PING && rest.size == PING -> RelayMessage.Ping(rest)

    else -> null
}

private fun decodeToClient(op: Int, rest: ByteArray): RelayMessage? = when {
    op == OP_RECV && rest.size >= DEVICE + SESSION + 1 ->
        RelayMessage.Recv(rest.copyOfRange(0, DEVICE), readU32(rest, DEVICE), rest.copyOfRange(DEVICE + SESSION, rest.size))

    op == OP_MEMBERS && rest.isNotEmpty() && rest.size == 1 + (rest[0].toInt() and BYTE) * DEVICE ->
        RelayMessage.Members(List(rest[0].toInt() and BYTE) { rest.copyOfRange(1 + it * DEVICE, 1 + (it + 1) * DEVICE) })

    op == OP_RING && rest.size == PING -> decodeRing(rest)

    op == OP_PONG && rest.size == PING -> RelayMessage.Pong(rest)

    op == OP_GONE && rest.size == DEVICE -> RelayMessage.Gone(rest)

    op == OP_LIMIT && rest.size == 1 && (rest[0].toInt() and BYTE) in 1..MAX_REASON -> RelayMessage.Limit(rest[0].toInt() and BYTE)

    else -> null
}

/** The epoch is a safe integer (below 2^53); a larger or negative u64 is refused, as Node does. */
private fun decodeRing(rest: ByteArray): RelayMessage? {
    val n = rest.fold(0L) { acc, x -> (acc shl 8) or (x.toLong() and BYTE.toLong()) }
    return if (n < 0 || n > MAX_SAFE) null else RelayMessage.Ring(n)
}

private const val MAX_SAFE: Long = 9_007_199_254_740_991L
