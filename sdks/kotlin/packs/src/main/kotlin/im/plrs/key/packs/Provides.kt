// Save compatibility on the device (P4-20, CONTENT §6.7 item 8, PARITY `packs.provides`): which
// content ids a pack release provides, read from its signed record's record-level `provides`. A port
// of client-core `packs/provides.ts` (Swift's `Provides.swift` the structural model).
//
// `provides` is a member WIRE-CONTRACT-V4 §2.5.1 reserves on the pack record: never a claim, so a
// record carrying a malformed list still verifies. This reader is the one interpretation every SDK
// shares: absent → nothing; an array of 0–4096 unique content ids → those ids; anything else →
// nothing. Content ids are printable ASCII without the space, 1–128 bytes.

package im.plrs.key.packs

import im.plrs.key.core.Base64Url
import im.plrs.key.core.JsonText
import im.plrs.key.core.ReleasePin
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The most ids one `provides` list may hold. */
public const val MAX_PROVIDES: Int = 4096

/** The longest content id. */
public const val MAX_CONTENT_ID_LENGTH: Int = 128

/** Whether [s] is a content id: 1–128 bytes, each 0x21–0x7E. */
public fun isContentId(s: String): Boolean {
    val bytes = s.toByteArray(Charsets.UTF_8)
    if (bytes.isEmpty() || bytes.size > MAX_CONTENT_ID_LENGTH) return false
    return bytes.all { it in 0x21..0x7E }
}

/** A record payload's `provides`, as a set (empty when absent or unusable). */
public fun providesOf(record: JsonElement?): Set<String> {
    val o = record as? JsonObject ?: return emptySet()
    val list = o["provides"] as? JsonArray ?: return emptySet()
    if (list.size > MAX_PROVIDES) return emptySet()
    val out = LinkedHashSet<String>()
    for (v in list) {
        val p = v as? JsonPrimitive
        val id = if (p != null && p.isString) p.content else return emptySet()
        if (!isContentId(id) || id in out) return emptySet()
        out += id
    }
    return out
}

/** The payload of a compact JWS the engine has ALREADY verified, decoded and never re-verified here. */
public fun verifiedPayloadOf(jws: String): JsonElement? {
    val parts = jws.split('.')
    if (parts.size != 3) return null
    val data = Base64Url.decodeStrict(parts[1]) ?: return null
    return JsonText.parseOrNull(data.toString(Charsets.UTF_8))
}

/** What save compatibility reads from one verified pack record. */
public data class ProvidesFacts(val provides: Set<String>, val entitlement: String?) {
    /** Whether the licence lets this pack answer: ungated, no License service (null), or the flag granted. */
    internal fun entitled(granted: Set<String>?): Boolean = entitlement == null || granted == null || entitlement in granted

    internal fun answers(contentId: String, granted: Set<String>?): Boolean = contentId in provides && entitled(granted)

    public companion object {
        public fun of(record: JsonElement?): ProvidesFacts = ProvidesFacts(providesOf(record), record.objectValue?.get("entitlement").stringValue)
    }
}

/** What `packFor` answers: the pack whose target release provides the id. */
public data class PackProvider(val packId: String, val release: ReleasePin)

internal const val MAX_PROVIDES_MEMO: Int = 1024

/** [ProvidesFacts] of verified records, by pack id and record hash (bounded: cleared when full). */
internal class ProvidesMemo {
    private val table = HashMap<String, ProvidesFacts>()

    fun get(key: String): ProvidesFacts? = table[key]

    fun facts(key: String, jws: String): ProvidesFacts {
        table[key]?.let { return it }
        val f = ProvidesFacts.of(verifiedPayloadOf(jws))
        if (table.size >= MAX_PROVIDES_MEMO) table.clear()
        table[key] = f
        return f
    }

    companion object {
        fun key(packId: String, recordSha256: String): String = packId + "\u0000" + recordSha256
    }
}
