// The key ring's requests and the shapes it reads (U-39.8): `GET|POST|PUT|DELETE /<p>/devices/keyring...`
// with the bearer token, the Worker's refusals as typed errors, and the served ring and wrap parsed
// strictly (an answer that is not in the contract shape is `bad_response`).

package im.plrs.key.sdk

import im.plrs.key.core.Base64Url
import im.plrs.key.core.CoreContext
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.jsonInt
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.sync.SyncHpke
import im.plrs.key.core.wireErrorCode
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

internal class RingWire(private val core: CoreContext) {
    suspend fun request(method: String, path: String, body: JsonElement? = null): PolarisResponse {
        val token = core.token() ?: throw PolarisException(ErrorCode.noToken, "Activate, register or sign in before using the key ring.")
        val headers = LinkedHashMap<String, String>()
        headers["authorization"] = "Bearer $token"
        if (body != null) headers["content-type"] = "application/json"
        val res = core.request(core.endpoints.url(path), method, headers, body?.toString()?.toByteArray(Charsets.UTF_8))
        if (!res.isOk) throw refusal(res)
        return res
    }

    suspend fun send(method: String, path: String, body: JsonElement? = null) {
        request(method, path, body)
    }

    /** The Worker answers `{"error": {"code", "message"}}`, or `{"error": "<code>"}` for a bare 404. */
    private fun refusal(res: PolarisResponse): PolarisException {
        val code = wireErrorCode(res.body) ?: ErrorCode.httpError
        val message = JsonText.parseOrNull(res.text).objectValue?.get("error").objectValue?.get("message").stringValue
        return PolarisException(code, message ?: "The server answered ${res.status}.", httpStatus = res.status)
    }

    fun wireWrap(w: SyncHpke.Wrap): Map<String, JsonElement> = mapOf(
        "kem" to jsonInt(SyncHpke.KEM_X25519.toLong()),
        "enc" to str(Base64Url.encode(w.enc)),
        "ct" to str(Base64Url.encode(w.ct)),
    )

    fun parseState(text: String): SyncKeyringState? {
        val b = JsonText.parseOrNull(text).objectValue
        val r = b?.get("ring")
        val w = b?.get("wrap")
        val ring = if (r == null || r is JsonNull) null else parseRing(r)
        val wrap = if (w == null || w is JsonNull) null else parseWrap(w)
        val ok = r != null && w != null && (r is JsonNull || ring != null) && (w is JsonNull || wrap != null)
        return if (ok) SyncKeyringState(ring, wrap) else null
    }

    private fun parseAdopted(list: List<JsonElement>): List<SyncKeyringRing.Adopted>? {
        val out = ArrayList<SyncKeyringRing.Adopted>()
        for (a in list) {
            val x = a.objectValue
            val id = x?.get("ringId").stringValue
            val epoch = x?.get("epoch").longValue
            val kid = x?.get("kid").stringValue
            val ct = x?.get("ct").stringValue
            if (anyNull(id, epoch, kid, ct)) return null
            out += SyncKeyringRing.Adopted(id!!, epoch!!.toInt(), kid!!, ct!!)
        }
        return out
    }

    private fun parsePrevious(x: JsonObject?): SyncKeyringRing.Previous? {
        val id = x?.get("ringId").stringValue
        val kid = x?.get("kid").stringValue
        val until = x?.get("until").longValue
        return if (anyNull(id, kid, until)) null else SyncKeyringRing.Previous(id!!, kid!!, until!!)
    }

    private fun parseRing(r: JsonElement): SyncKeyringRing? {
        val o = r.objectValue
        val rec = o?.get("recovery").objectValue
        val adopted = o?.get("adopted").arrayValue?.let { parseAdopted(it) }
        val p = o?.get("previous")
        val previous = parsePrevious(p?.objectValue)
        val previousOk = p == null || p is JsonNull || previous != null
        val ringId = o?.get("ringId").stringValue
        val epoch = o?.get("epoch").longValue
        val rootKid = o?.get("rootKid").stringValue
        val state = o?.get("state").stringValue
        val createdAt = o?.get("createdAt").longValue
        val set = rec?.get("set").boolValue
        val ok = !anyNull(ringId, epoch, rootKid, state, createdAt, set, adopted) && previousOk
        return if (ok) {
            SyncKeyringRing(
                ringId!!, epoch!!.toInt(), rootKid!!, state!!, createdAt!!, set!!, rec?.get("createdAt").longValue, adopted!!,
                previous,
            )
        } else {
            null
        }
    }

    private fun parseWrap(w: JsonElement): SyncKeyringWrapInfo? {
        val o = w.objectValue
        val kem = o?.get("kem")
        val epoch = o?.get("epoch").longValue
        val kid = o?.get("kid").stringValue
        val enc = o?.get("enc").stringValue
        val ct = o?.get("ct").stringValue
        val kemOk = kem != null && (kem.stringValue != null || kem.longValue != null)
        val ok = kemOk && !anyNull(epoch, kid, enc, ct)
        return if (ok) SyncKeyringWrapInfo(epoch!!.toInt(), kid!!, kem!!, enc!!, ct!!, o?.get("by").stringValue) else null
    }
}
