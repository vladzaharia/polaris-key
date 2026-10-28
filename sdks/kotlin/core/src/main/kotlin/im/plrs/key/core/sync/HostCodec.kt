// The host codec boundary of Cloud Sync's end-to-end mode (WIRE-CONTRACT-V5 section 13.10 and 13.10.7;
// U-07.K5). A port of Python's `cloud_sync/host_codec.py` and client-core's `sync/hostCodec.ts`, with
// every SEC-SYNC-HOST fix. The machine speaks plaintext; this is the one place a host turns the
// machine's requests into sealed ones (`sealPush`) and the Worker's answers into plaintext plus the
// typed open result the machine trusts (`openPull`).
//
//  - HC-1: a result list that repeats a `mutationId` is refused, and a conflict's server copy opens
//    only for a mutation of the request.
//  - HC-2: the open result comes only from this module's own open. `sealed`, `invalid`, `seq` and `ct`
//    members of a served body are removed, never read; `seq` is the change's `version`, plaintext rows only.
//  - HC-3: served `aliases` are replaced by the app's; `renamedTo` is kept only for an app alias.
//  - HC-4: a name holding U+0000 is refused on push and pull; a merge member's envelope name is the
//    setting, U+0000, the member.
//  - HC-5: a blinded name is accepted only when the `k` inside its envelope re-blinds to it; an envelope
//    that does not open is `invalid` and its row falls through to the document.
//  - HC-6: a locked codec refuses with `sync-locked` before anything is sealed, so nothing is sent; a
//    seal failure throws, so nothing is sent.
//
// Scope: settings (the `$settings` collection). A record mutation is refused with `invalid-options`; a
// record change carrying a `ct` reads as `invalid`. Nothing here logs or prints a value, a name or a
// root: errors name a rule, never content. Names compare as UTF-16 code units (equal to code points
// for well-formed text), never by canonical equivalence.

package im.plrs.key.core.sync

import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.core.arrayValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * What the host seals and opens with. The ring's `SyncCodec` is the app's one implementation; a test
 * implements it over a fixture root. Every call refuses with `sync-locked` while there is no root.
 */
public interface SyncCodecPort {
    public val locked: Boolean

    public fun seal(collection: String, name: String, value: JsonElement): ByteArray

    public fun open(collection: String, name: String, envelope: ByteArray, aliases: List<String> = emptyList()): SyncEnvelope.Opened

    public fun openAny(collection: String, envelope: ByteArray): SyncEnvelope.Opened

    public fun blind(kind: SyncBlind.Kind, ctx: String, name: String): String
}

/** The result of opening an answer: the body with plaintext values, and the machine's typed result. */
public class SyncOpenedPull(public val body: JsonElement, public val opened: OpenedBody)

public object HostCodec {
    /** The collection every setting is sealed under. */
    public const val SETTINGS_COLLECTION: String = "\$settings"

    internal val strip: List<String> = listOf("sealed", "invalid", "seq", "ct")

    /** The envelope name of a merge member (D-2): the setting, U+0000, the member. */
    public fun memberEnvelopeName(setting: String, member: String): String = "$setting\u0000$member"

    internal fun locked(): PolarisException = PolarisException(ErrorCode.syncLocked, "Cloud Sync is locked: there is no root")

    internal fun refuseIf(condition: Boolean, why: String) {
        if (condition) throw refuse(why)
    }

    internal fun refuse(why: String): PolarisException = PolarisException(ErrorCode.invalidOptions, "Cloud Sync host codec: $why")

    /**
     * The blind input has no length prefix (`kind NUL ctx NUL name`), so a name with a NUL could collide
     * with another (setting, member) pair; no name may hold one.
     */
    internal fun hasNul(s: String): Boolean = s.indexOf('\u0000') >= 0

    internal fun stripped(e: JsonObject): JsonObject = JsonObject(e - strip.toSet())

    /**
     * Seals a push body. [declared] are the catalog's declared setting keys: such a key stays in the clear;
     * any other key is an open setting and is blinded. The body is not changed; the answer is a copy.
     * Throws (and so sends nothing) when the codec is locked or a mutation cannot be sealed.
     */
    public fun sealPush(body: JsonElement, codec: SyncCodecPort, declared: Collection<String>): JsonElement {
        if (codec.locked) throw locked()
        val o = body as? JsonObject
        val list = o?.get("mutations").arrayValue
        if (o == null || list == null) return body
        val keys = declared.toSet()
        val mutations = list.map { m ->
            val mo = m as? JsonObject ?: throw refuse("mutation is not an object")
            HostCodecSeal.mutation(mo, codec, keys)
        }
        return JsonObject(o + ("mutations" to JsonArray(mutations)))
    }

    /** The same, over the catalog's routes. */
    public fun sealPush(body: JsonElement, codec: SyncCodecPort, routes: List<JsonObject>): JsonElement =
        sealPush(body, codec, routes.map { it["key"].stringValue!! })

    /**
     * Opens a pull or push answer. The body has plaintext `value`s and plaintext setting names where they
     * could be proven; `opened` is the typed result for the machine's `receive`. Throws (and so delivers
     * nothing to the machine) when the codec is locked or the answer repeats a `mutationId`.
     *
     * [mutations] are the plaintext mutations of the request the answer belongs to (a conflict's server copy
     * carries no name, so it opens against the mutation's own setting). [aliases] are the renames the app
     * declares, never taken from the body. [openKeys] are the open-setting keys the machine already holds: a
     * tombstone names a key blinded, and only these map back.
     */
    public fun openPull(
        body: JsonElement,
        codec: SyncCodecPort,
        mutations: List<JsonElement> = emptyList(),
        aliases: Map<String, String> = emptyMap(),
        openKeys: Collection<String> = emptyList(),
    ): SyncOpenedPull {
        if (codec.locked) throw locked()
        val b = body as? JsonObject ?: return SyncOpenedPull(body, OpenedBody())
        val out = b.toMutableMap()
        val rows = HostCodecOpen(codec, aliases)
        var changes: List<OpenedRow?> = emptyList()
        b["changes"].arrayValue?.let { list ->
            val opened = list.map { c -> (c as? JsonObject)?.let { rows.change(it) } }
            out["changes"] = JsonArray(opened.mapIndexed { i, r -> r?.first ?: list[i] })
            changes = opened.map { it?.second }
        }
        b["tombstones"].arrayValue?.let { out["tombstones"] = JsonArray(HostCodecResults.tombstones(it, codec, openKeys)) }
        // Renames come from the app only; a served map or `renamedTo` could swap values between keys.
        if (b.containsKey("aliases")) out["aliases"] = JsonObject(aliases.mapValues { JsonPrimitive(it.value) })
        var conflicts: Map<Long, OpenedRow?> = emptyMap()
        b["results"].arrayValue?.let { list ->
            val r = HostCodecResults.results(list, rows, mutations, aliases)
            out["results"] = JsonArray(r.first)
            conflicts = r.second
        }
        strip.forEach { out.remove(it) }
        return SyncOpenedPull(JsonObject(out), OpenedBody(changes, conflicts))
    }
}
