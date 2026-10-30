// The pull half of the host codec, rows: a change or a conflict's server copy opened (HC-2, HC-4, HC-5).

package im.plrs.key.core.sync

import im.plrs.key.core.Base64Url
import im.plrs.key.core.arrayValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** One opened row: the entry the machine will read, and the host's own verdict on it. */
internal typealias OpenedEntry = Pair<JsonObject, OpenedRow>

/** Row builders shared by the openers. */
internal object HostRow {
    /** The envelope of a served `ct`, or null for anything but non-empty canonical base64url. */
    fun fromCt(ct: JsonElement?): ByteArray? = ct.stringValue?.takeIf { it.isNotEmpty() }?.let { Base64Url.decodeStrict(it) }

    fun invalid(e: JsonObject): OpenedEntry = JsonObject(HostCodec.stripped(e) - "value" - "members") to OpenedRow(invalid = true)

    fun plain(e: JsonObject): OpenedEntry {
        val v = e["version"]
        return HostCodec.stripped(e) to OpenedRow(seq = if (SyncJson.isInteger(v)) SyncNum.long(v) else null)
    }

    fun sealed(e: JsonObject, extra: Map<String, JsonElement>): OpenedEntry =
        JsonObject(HostCodec.stripped(e) - "members" + extra) to OpenedRow(sealed = true)
}

internal class HostCodecOpen(private val codec: SyncCodecPort, private val aliases: Map<String, String>) {
    private val collection = HostCodec.SETTINGS_COLLECTION

    fun change(c: JsonObject): OpenedEntry {
        val served = c["setting"].stringValue
        return when {
            served != null -> settingChange(c, served)

            c.containsKey("record") -> recordChange(c)

            // Neither a setting nor a record: a sealed one cannot be placed.
            c.containsKey("ct") -> HostRow.invalid(c)

            else -> HostRow.plain(c)
        }
    }

    /**
     * A record change: `{record: [collection, id], ct, version}`. A sealed `merge` or `union` change (`fields`,
     * `elements`) is outside the scalar codec and reads as invalid; a plaintext row is legacy (the machine checks
     * its `seq` against `encryptionSince`). A sealed id is accepted only when it is blinded and the `k` inside the
     * envelope re-blinds to it (HC-5); it is then replaced by the id.
     */
    private fun recordChange(c: JsonObject): OpenedEntry {
        val ref = HostRecord.ref(c["record"])
        val opened = if (ref != null && SyncBlind.isBlindedName(ref.second)) {
            HostRow.fromCt(c["ct"])?.let { codec.openAny(ref.first, it) as? SyncEnvelope.Opened.Ok }
        } else {
            null
        }
        val honest = opened != null && opened.name.isNotEmpty() && !HostCodec.hasNul(opened.name) &&
            codec.blind(SyncBlind.Kind.Record, ref!!.first, opened.name) == ref.second
        return when {
            c["fields"] is JsonArray || c["elements"] is JsonArray -> HostRow.invalid(c)
            !c.containsKey("ct") -> HostRow.plain(c)
            honest -> HostRow.sealed(c, mapOf("record" to HostRecord.pair(ref!!.first, opened!!.name), "value" to opened.value))
            else -> HostRow.invalid(c)
        }
    }

    /** A conflict's server copy of the record [rec] of the mutation: one `ct`, opened under that id. */
    fun recordCopy(e: JsonObject, rec: Pair<String, String>): OpenedEntry {
        val r = HostRow.fromCt(e["ct"])?.let { codec.open(rec.first, rec.second, it, emptyList()) as? SyncEnvelope.Opened.Ok }
        return when {
            e["fields"] is JsonArray || e["elements"] is JsonArray -> HostRow.invalid(e)
            !e.containsKey("ct") -> HostRow.plain(e)
            r != null -> HostRow.sealed(e, mapOf("value" to r.value))
            else -> HostRow.invalid(e)
        }
    }

    private fun settingChange(c: JsonObject, served: String): OpenedEntry {
        val hasMembers = c["members"] is JsonArray
        return when {
            HostCodec.hasNul(served) -> HostRow.invalid(c)
            !c.containsKey("ct") && !hasMembers -> HostRow.plain(c)
            !SyncBlind.isBlindedName(served) -> copy(c, served)
            else -> openKey(c, served)
        }
    }

    /** An open key: the name is inside the envelope and must re-blind to the served name (HC-5). */
    private fun openKey(c: JsonObject, served: String): OpenedEntry {
        val opened = HostRow.fromCt(c["ct"])?.let { codec.openAny(collection, it) as? SyncEnvelope.Opened.Ok }
        val honest = opened != null && !HostCodec.hasNul(opened.name) && codec.blind(SyncBlind.Kind.Setting, collection, opened.name) == served
        return if (honest) HostRow.sealed(c, mapOf("setting" to JsonPrimitive(opened!!.name), "value" to opened.value)) else HostRow.invalid(c)
    }

    /**
     * Opens a row (or a conflict's server copy) whose setting name is [name]: one `ct`, or a merge setting's
     * sealed `members`. A null [name] (a conflict the host cannot place) reads as invalid.
     */
    fun copy(e: JsonObject, name: String?): OpenedEntry {
        val members = e["members"].arrayValue
        val hasCt = e.containsKey("ct")
        return when {
            !hasCt && members == null -> HostRow.plain(e)
            name == null || HostCodec.hasNul(name) -> HostRow.invalid(e)
            hasCt -> openCt(e, name)
            else -> openMembers(e, name, members!!)
        }
    }

    private fun openCt(e: JsonObject, name: String): OpenedEntry {
        val renamedFrom = aliases.filter { it.value == name }.keys.toList()
        val r = HostRow.fromCt(e["ct"])?.let { codec.open(collection, name, it, renamedFrom) as? SyncEnvelope.Opened.Ok }
        return if (r != null) HostRow.sealed(e, mapOf("value" to r.value)) else HostRow.invalid(e)
    }

    private fun openMembers(e: JsonObject, name: String, members: JsonArray): OpenedEntry {
        val opened = members.map { openMember(it, name) }
        val names = opened.map { it?.first }
        val bad = opened.any { it == null } || names.toSet().size != names.size
        return if (bad) HostRow.invalid(e) else HostRow.sealed(e, mapOf("value" to JsonObject(opened.associate { it!!.first to it.second })))
    }

    /** One sealed member: its blinded name must re-blind from the member the envelope names (D-2). */
    private fun openMember(m: JsonElement, name: String): Pair<String, JsonElement>? {
        val mo = m as? JsonObject
        val served = mo?.get("member").stringValue
        val env = HostRow.fromCt(mo?.get("ct"))
        val opened = if (env != null && served != null &&
            SyncBlind.isBlindedName(served)
        ) {
            codec.openAny(collection, env) as? SyncEnvelope.Opened.Ok
        } else {
            null
        }
        val prefix = "$name\u0000"
        val member = opened?.name?.takeIf { it.startsWith(prefix) }?.substring(prefix.length)
        val honest = member != null && !HostCodec.hasNul(member) && codec.blind(SyncBlind.Kind.Member, name, member) == served
        return if (honest) member!! to opened!!.value else null
    }
}
