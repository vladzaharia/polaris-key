// The `KEYRING_WRAP` record a nearby approver sends over the channel (I-45.13; WIRE-CONTRACT-V5 section 13.11.3): exactly
// `{ringId, epoch, kid, kem, enc, ct}` as strict JSON, at most 2048 bytes. Parsing opens nothing; `SyncKeyring.adoptWrap`
// checks the ring against a fresh read before it opens anything.

package im.plrs.key.sdk

import im.plrs.key.core.JsonText
import im.plrs.key.core.longValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.sync.SyncHpke
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The most a `KEYRING_WRAP` record is read at (a real one is about 300 bytes). */
private const val WRAP_RECORD_MAX = 2048
private val WRAP_RECORD_KEYS = setOf("ringId", "epoch", "kid", "kem", "enc", "ct")
private val KID_HEX = Regex("^[0-9a-f]{32}$")

/**
 * A `KEYRING_WRAP` record body, or null when it is not exactly `{ringId, epoch, kid, kem, enc, ct}` (a missing or extra
 * member, a wrong type, an oversized body). Nothing is opened here.
 */
internal fun parseWrapRecord(body: ByteArray): SyncWrapBody? = if (body.isEmpty() || body.size > WRAP_RECORD_MAX) null else wrapFromText(body)

private fun wrapFromText(body: ByteArray): SyncWrapBody? {
    val text = runCatching { Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(body)).toString() }.getOrNull()
    val o = text?.let { JsonText.parseOrNull(it) } as? JsonObject
    return if (o == null || o.keys != WRAP_RECORD_KEYS) null else wrapFromFields(o)
}

private fun isX25519Kem(kem: JsonElement?): Boolean =
    kem is JsonPrimitive && if (kem.isString) kem.content == "x25519" else kem.content == SyncHpke.KEM_X25519.toString()

private fun wrapFromFields(o: JsonObject): SyncWrapBody? {
    val ringId = o["ringId"].stringValue
    val epoch = o["epoch"].longValue
    val kid = o["kid"].stringValue
    val enc = o["enc"].stringValue
    val ct = o["ct"].stringValue
    val named = ringId != null && RING_ID.matches(ringId) && epoch != null && epoch in 1..Int.MAX_VALUE
    val sealed = kid != null && KID_HEX.matches(kid) && enc != null && ct != null
    return if (named && sealed && isX25519Kem(o["kem"])) SyncWrapBody(ringId!!, epoch!!.toInt(), kid!!, o["kem"]!!, enc!!, ct!!) else null
}
