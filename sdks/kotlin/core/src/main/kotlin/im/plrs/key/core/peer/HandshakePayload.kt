// WIRE-CONTRACT-V5 section 15.5: handshake payloads (CC-12.6). Strict JSON (section 1.2), an
// object, at most 8 KiB. Pure; mirrors client-core's `peer/payload.ts`.

package im.plrs.key.core.peer

import im.plrs.key.core.StrictJson
import im.plrs.key.core.longValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.wireInteger
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/** The largest handshake payload, in bytes. */
public const val MAX_HANDSHAKE_PAYLOAD: Int = 8192

/** The most capabilities a payload lists. */
public const val MAX_CAPS: Int = 32

private val CAP = Regex("[a-z0-9]+/[0-9]+")
private const val FIRST = 1
private const val UNICODE_ESCAPE_WIDTH = 4
private const val FIRST_PRINTABLE = 0x20

/** The verdict on one payload. */
public sealed class PayloadVerdict {
    /** Accepted. [ring] and [cert] are set in mode a, messages 2 and 3. */
    public class Accepted(public val caps: List<String>, public val ring: Long? = null, public val cert: String? = null) : PayloadVerdict() {
        override fun toString(): String = "Accepted(caps=${caps.size})"
    }

    /** Refused. */
    public object Refused : PayloadVerdict()
}

/** Parse a payload as strict JSON; null on any failure. */
public fun parseStrictObject(bytes: ByteArray): JsonObject? = StrictJson.validate(bytes)?.value

/** Judge one handshake payload: message 1, or message 2 or 3 in a mode. */
public fun parseHandshakePayload(mode: PeerMode, message: Int, bytes: ByteArray): PayloadVerdict {
    if (bytes.size > MAX_HANDSHAKE_PAYLOAD) return PayloadVerdict.Refused
    val parsed = StrictJson.validate(bytes) ?: return PayloadVerdict.Refused
    val o = parsed.value
    if (o["v"].longValue != 1L || "/v" in parsed.nonWireIntegers) return PayloadVerdict.Refused
    if (message == FIRST) return if ("cert" in o) PayloadVerdict.Refused else PayloadVerdict.Accepted(emptyList())
    val list = capsOf(o["caps"]) ?: return PayloadVerdict.Refused
    if (mode != PeerMode.a) return if ("cert" in o) PayloadVerdict.Refused else PayloadVerdict.Accepted(list)
    val cert = o["cert"].stringValue?.takeIf { it.isNotEmpty() } ?: return PayloadVerdict.Refused
    val ring = o["ring"].longValue
    if (!wireInteger(ring, "/ring", 1, parsed.nonWireIntegers)) return PayloadVerdict.Refused
    return PayloadVerdict.Accepted(list, ring, cert)
}

private fun capsOf(e: kotlinx.serialization.json.JsonElement?): List<String>? {
    val caps = e as? JsonArray ?: return null
    if (caps.size > MAX_CAPS) return null
    val out = ArrayList<String>(caps.size)
    for (c in caps) {
        val s = c.stringValue ?: return null
        if (!CAP.matches(s)) return null
        out += s
    }
    return out
}

/** The capabilities both sides list, once each, in byte order. */
public fun capsIntersection(a: List<String>, b: List<String>): List<String> = a.filter { it in b }.toSet().sortedWith(Comparator(::utf8Compare))

private fun utf8Compare(x: String, y: String): Int {
    val a = x.toByteArray(Charsets.UTF_8)
    val b = y.toByteArray(Charsets.UTF_8)
    for (i in 0 until minOf(a.size, b.size)) if (a[i] != b[i]) return (a[i].toInt() and 0xff) - (b[i].toInt() and 0xff)
    return a.size - b.size
}

/** The bytes of message 1's payload. */
public fun payload1(): ByteArray = "{\"v\":1}".toByteArray(Charsets.UTF_8)

/** The account block of a mode-a payload. */
public class AccountPayload(public val cert: String, public val ring: Long) {
    override fun toString(): String = "AccountPayload(ring=$ring)"
}

private fun quoted(s: String): String {
    val out = StringBuilder("\"")
    for ((i, ch) in s.withIndex()) {
        when {
            ch == '"' -> out.append("\\\"")
            ch == '\\' -> out.append("\\\\")
            ch == '\b' -> out.append("\\b")
            ch == '\u000c' -> out.append("\\f")
            ch == '\n' -> out.append("\\n")
            ch == '\r' -> out.append("\\r")
            ch == '\t' -> out.append("\\t")
            ch.code < FIRST_PRINTABLE || loneSurrogate(s, i) -> out.append("\\u").append(ch.code.toString(16).padStart(UNICODE_ESCAPE_WIDTH, '0'))
            else -> out.append(ch)
        }
    }
    return out.append('"').toString()
}

private fun loneSurrogate(s: String, i: Int): Boolean {
    val c = s[i]
    return when {
        Character.isHighSurrogate(c) -> i + 1 >= s.length || !Character.isLowSurrogate(s[i + 1])
        Character.isLowSurrogate(c) -> i == 0 || !Character.isHighSurrogate(s[i - 1])
        else -> false
    }
}

/** The bytes of message 2 or 3: `cert` and `ring` in mode a only. */
public fun payload23(mode: PeerMode, caps: List<String>, account: AccountPayload? = null): ByteArray {
    val sb = StringBuilder("{\"v\":1")
    if (mode == PeerMode.a) {
        requireNotNull(account) { "account payload" }
        sb.append(",\"cert\":").append(quoted(account.cert)).append(",\"ring\":").append(account.ring)
    }
    sb.append(",\"caps\":[").append(caps.joinToString(",") { quoted(it) }).append("]}")
    val bytes = sb.toString().toByteArray(Charsets.UTF_8)
    require(bytes.size <= MAX_HANDSHAKE_PAYLOAD) { "payload size" }
    return bytes
}
