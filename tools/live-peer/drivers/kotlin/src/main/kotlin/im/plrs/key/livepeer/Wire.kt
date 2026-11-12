// The wire of the Kotlin live-peer driver: JSON lines on stdout and stdin (tools/live-peer/README.md).

package im.plrs.key.livepeer

import im.plrs.key.core.PolarisException
import im.plrs.key.sdk.LanException
import im.plrs.key.sdk.LocalPairingException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.FileDescriptor
import java.io.FileOutputStream
import java.io.PrintStream
import java.security.MessageDigest

private const val BYTE_MASK = 0xff
private const val PATTERN_MUL = 7
private const val PATTERN_ADD = 13

// stdout is the protocol: take it, and point System.out at stderr so nothing else can write to it.
private val protocol: PrintStream = PrintStream(FileOutputStream(FileDescriptor.out), true, "UTF-8")

internal fun send(m: JsonObject) {
    synchronized(protocol) { protocol.println(m.toString()) }
}

internal fun sendAnswer(
    seq: JsonElement?,
    ok: Boolean,
    body: Map<String, JsonElement>,
) {
    send(JsonObject(mapOf("seq" to (seq ?: JsonNull), "ok" to JsonPrimitive(ok)) + body))
}

/** A refused command: the answer is `ok: false` with this error, and `extra` fields beside it. */
internal class Refusal(
    val error: JsonObject,
    val extra: Map<String, JsonElement> = emptyMap(),
) : Exception()

internal fun errorOf(e: Throwable): JsonObject =
    buildJsonObject {
        put("code", (e as? PolarisException)?.code)
        put("reason", (e as? LocalPairingException)?.reason ?: (e as? LanException)?.reason?.name)
        put("cap", (e as? LocalPairingException)?.cap)
        put("message", e.message ?: e.toString())
    }

internal fun JsonObject.str(k: String): String? = this[k]?.takeIf { it !is JsonNull }?.jsonPrimitive?.contentOrNull

internal fun strings(xs: List<String>): JsonArray = JsonArray(xs.map { JsonPrimitive(it) })

internal fun sha256(b: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

/** The content the harness hashes: the sender builds it, so a wrong pattern shows as a hash mismatch. */
internal fun pattern(n: Int): ByteArray = ByteArray(n) { i -> ((i * PATTERN_MUL + PATTERN_ADD) and BYTE_MASK).toByte() }
