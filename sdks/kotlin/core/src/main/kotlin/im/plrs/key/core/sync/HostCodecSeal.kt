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
     * A record mutation (section 13.10.4). `set` seals the value under the collection with `k = id`; `setField` under
     * `id U+0000 field`; `add` seals the element under `id U+0000 canonicalJson(e)`. `delete`, `removeField` and
     * `remove` carry no value. Every name goes blinded, the collection in the clear.
     */
    private fun record(m: JsonObject, codec: SyncCodecPort): JsonObject {
        val target = m["target"].objectValue!!
        val ref = HostRecord.ref(target["record"])
        HostCodec.refuseIf(ref == null, "a record reference is malformed")
        HostCodec.refuseIf(m.containsKey("ct"), "mutation carries a member this codec does not seal")
        val c = RecordSeal(m, codec, ref!!.first, ref.second)
        when (m["op"].stringValue) {
            "set" -> c.set()
            "delete" -> c.absent("value", "field", "element", "member")
            "setField" -> c.setField()
            "removeField" -> c.removeField()
            "add" -> c.add()
            "remove" -> c.remove()
            else -> HostCodec.refuseIf(true, "unsupported operation")
        }
        c.out["target"] = JsonObject(target + ("record" to HostRecord.pair(c.collection, codec.blind(SyncBlind.Kind.Record, c.collection, c.id))))
        return JsonObject(c.out)
    }

    /** One record mutation being sealed. */
    private class RecordSeal(val m: JsonObject, val codec: SyncCodecPort, val collection: String, val id: String) {
        val out: MutableMap<String, JsonElement> = m.toMutableMap()

        fun absent(vararg names: String) =
            HostCodec.refuseIf(names.any { m.containsKey(it) }, "mutation carries a member its operation does not take")

        private fun field(): String {
            val f = m["field"].stringValue
            HostCodec.refuseIf(f == null || f.isEmpty() || HostCodec.hasNul(f), "a field name is empty or holds U+0000")
            return f!!
        }

        /** The element's canonical JSON: a number or text that cannot be spelled identically everywhere is never sent. */
        private fun element(): String {
            val e = m["element"]
            HostCodec.refuseIf(e == null, "an element is missing")
            return try {
                CanonicalJson.encode(e!!)
            } catch (_: SyncCryptoException) {
                throw HostCodec.refuse("an element cannot be spelled canonically")
            }
        }

        private fun seal(name: String, value: JsonElement?) {
            HostCodec.refuseIf(value == null, "${m["op"].stringValue} needs a value")
            out.remove("value")
            out["ct"] = JsonPrimitive(Base64Url.encode(codec.seal(collection, name, value!!)))
        }

        private fun blind(kind: SyncBlind.Kind, name: String) = JsonPrimitive(codec.blind(kind, collection, name))

        fun set() {
            absent("field", "element", "member")
            seal(id, m["value"])
        }

        fun setField() {
            absent("element", "member")
            val f = field()
            seal("$id\u0000$f", m["value"])
            out["field"] = blind(SyncBlind.Kind.Field, f)
        }

        fun removeField() {
            absent("value", "element", "member")
            out["field"] = blind(SyncBlind.Kind.Field, field())
        }

        fun add() {
            absent("value", "field", "member")
            val name = element()
            seal("$id\u0000$name", m["element"])
            out["element"] = blind(SyncBlind.Kind.Element, name)
        }

        fun remove() {
            absent("value", "field", "member")
            out["element"] = blind(SyncBlind.Kind.Element, element())
        }
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
