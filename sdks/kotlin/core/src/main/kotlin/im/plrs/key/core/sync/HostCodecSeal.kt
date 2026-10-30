// The push half of the host codec: one mutation sealed (HC-4, HC-6).

package im.plrs.key.core.sync

import im.plrs.key.core.Base64Url
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** One mutation being sealed: the plaintext, the copy being built, and what it names. */
private class SealCtx(val m: JsonObject, val codec: SyncCodecPort, val setting: String, val member: String?, val openKey: Boolean) {
    val out: MutableMap<String, JsonElement> = m.toMutableMap()
}

internal object HostCodecSeal {
    private const val COLLECTION = HostCodec.SETTINGS_COLLECTION

    private fun ct(c: SealCtx, name: String, value: JsonElement): JsonPrimitive =
        JsonPrimitive(Base64Url.encode(c.codec.seal(COLLECTION, name, value)))

    private fun context(m: JsonObject, codec: SyncCodecPort, declared: Set<String>): SealCtx {
        val target = m["target"].objectValue
        val setting = target?.get("setting").stringValue
        HostCodec.refuseIf(setting == null, "only a setting mutation can be sealed")
        HostCodec.refuseIf(
            m.containsKey("ct") || m.containsKey("field") || m.containsKey("element"),
            "mutation carries a member this codec does not seal",
        )
        val member = m["member"].stringValue
        HostCodec.refuseIf(HostCodec.hasNul(setting!!) || (member != null && HostCodec.hasNul(member)), "a name holds U+0000")
        return SealCtx(m, codec, setting, member, setting !in declared).also {
            if (it.openKey) {
                val blinded = JsonPrimitive(codec.blind(SyncBlind.Kind.Setting, COLLECTION, setting))
                it.out["target"] = JsonObject(target!! + ("setting" to blinded))
            }
        }
    }

    fun mutation(m: JsonObject, codec: SyncCodecPort, declared: Set<String>): JsonObject {
        if (m["target"].objectValue?.containsKey("record") == true) return record(m, codec)
        val c = context(m, codec, declared)
        when (m["op"].stringValue) {
            "set" -> set(c)
            "setMember" -> setMember(c)
            "removeMember" -> removeMember(c)
            "clear" -> HostCodec.refuseIf(m.containsKey("value") || m.containsKey("member"), "clear carries no value")
            else -> HostCodec.refuseIf(true, "unsupported operation")
        }
        return JsonObject(c.out)
    }

    /**
     * A record mutation (scalar value, D-2): `set` seals the value under the collection with `k = id`; `delete`
     * carries none. Either sends the id blinded. The collection travels in the clear (section 13.10.2).
     */
    private fun record(m: JsonObject, codec: SyncCodecPort): JsonObject {
        val target = m["target"].objectValue!!
        val ref = HostRecord.ref(target["record"])
        HostCodec.refuseIf(ref == null, "a record reference is malformed")
        HostCodec.refuseIf(
            m.containsKey("ct") || m.containsKey("field") || m.containsKey("element") || m.containsKey("member"),
            "mutation carries a member this codec does not seal",
        )
        val (collection, id) = ref!!
        val out = m.toMutableMap()
        when (m["op"].stringValue) {
            "set" -> {
                val value = m["value"]
                HostCodec.refuseIf(value == null, "set needs a value")
                out.remove("value")
                out["ct"] = JsonPrimitive(Base64Url.encode(codec.seal(collection, id, value!!)))
            }

            "delete" -> HostCodec.refuseIf(m.containsKey("value"), "delete carries no value")

            else -> HostCodec.refuseIf(true, "unsupported operation")
        }
        val blinded = codec.blind(SyncBlind.Kind.Record, collection, id)
        out["target"] = JsonObject(target + ("record" to HostRecord.pair(collection, blinded)))
        return JsonObject(out)
    }

    private fun set(c: SealCtx) {
        val value = c.m["value"]
        HostCodec.refuseIf(value == null || c.m.containsKey("member"), "set needs a value and no member")
        c.out.remove("value")
        c.out["ct"] = ct(c, c.setting, value!!)
    }

    private fun setMember(c: SealCtx) {
        val value = c.m["value"]
        HostCodec.refuseIf(c.openKey || c.member == null || value == null, "setMember needs a declared setting, a member and a value")
        c.out.remove("value")
        c.out["member"] = JsonPrimitive(c.codec.blind(SyncBlind.Kind.Member, c.setting, c.member!!))
        c.out["ct"] = ct(c, HostCodec.memberEnvelopeName(c.setting, c.member), value!!)
    }

    private fun removeMember(c: SealCtx) {
        HostCodec.refuseIf(c.openKey || c.member == null || c.m.containsKey("value"), "removeMember needs a declared setting and a member")
        c.out["member"] = JsonPrimitive(c.codec.blind(SyncBlind.Kind.Member, c.setting, c.member!!))
    }
}
