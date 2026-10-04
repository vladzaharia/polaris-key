// The pack install-state machine (CONTENT §9 "Install state", §10; plans/P4-01.md §2.13; client-core
// `packs/state.ts`, whose fields and transitions this follows exactly; Swift's `State.swift` the
// structural model).
//
// One document per product, written by atomic replace:
//
//   active            pack id → the install the next boot (and, for `hot` packs, this process) uses
//   previous          pack id → the install `active` replaced, kept for `rollback`
//   inflight          pack id → the journal of an install in progress, for resume
//   observed          what a platform transport reported; carried, never interpreted
//   confirmedBootSeq  the last boot `confirm` marked healthy; `bootSeq` counts loads
//
// The document is NEVER trusted from storage. Each install and journal carries its pack record's
// compact JWS verbatim, and `reloadPackState` re-verifies every one through the caller's verifier
// before anything uses it. What fails is dropped, never repaired. Pure functions.

package im.plrs.key.packs

import im.plrs.key.core.FeedDelta
import im.plrs.key.core.MAX_WIRE_INTEGER
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.isPackId
import im.plrs.key.core.isSha256Hex
import im.plrs.key.core.jsonInt
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.packMatch
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

public const val PACK_STATE_VERSION: Int = 1

/** One installed pack release. */
public data class PackInstall(
    val packId: String,
    /** The pack record's compact JWS, verbatim: re-verified on every load. */
    val record: String,
    val recordSha256: String,
    val version: String,
    val seq: Long,
    val type: String,
    /** The selected variant's key (`variantKey`). */
    val variant: String,
    val layout: String,
    val payloadSha256: String,
    val payloadSize: Long,
    /** `hot` (live at commit) or `restart` (live from the next boot). */
    val activation: String,
    /** Where the host keeps the payload (a store directory, an embedded path). */
    val location: String,
    /** True for an embedded baseline the host registered. */
    val embedded: Boolean? = null,
    /** Epoch seconds of the commit. */
    val installedAt: Long,
    /** The delegation's compact JWS when a delegated content key signed [record] (plans/P4-19.md §2.7). */
    val delegation: String? = null,
) {
    public val json: JsonObject
        get() = buildJsonObject {
            put("packId", JsonPrimitive(packId))
            put("record", JsonPrimitive(record))
            put("recordSha256", JsonPrimitive(recordSha256))
            put("version", JsonPrimitive(version))
            put("seq", jsonInt(seq))
            put("type", JsonPrimitive(type))
            put("variant", JsonPrimitive(variant))
            put("layout", JsonPrimitive(layout))
            put("payloadSha256", JsonPrimitive(payloadSha256))
            put("payloadSize", jsonInt(payloadSize))
            put("activation", JsonPrimitive(activation))
            put("location", JsonPrimitive(location))
            put("installedAt", jsonInt(installedAt))
            embedded?.let { put("embedded", JsonPrimitive(it)) }
            delegation?.let { put("delegation", JsonPrimitive(it)) }
        }
}

/** One object of an in-flight plan: its stored ref and how many bytes are staged. */
public data class JournalObject(val sha256: String, val bytes: Long, val done: Long)

/** The journal of an install in progress (CONTENT §10 step 2). */
public data class PackJournal(
    val planId: String,
    val packId: String,
    val record: String,
    val recordSha256: String,
    val variant: String,
    val strategy: String,
    val delta: String? = null,
    val objects: List<JournalObject>,
    val startedAt: Long,
    val delegation: String? = null,
    /** plans/P4-29.md §2.4 step 6: the feed-offered delta being installed, when [delta] names one. */
    val feedDelta: FeedDelta? = null,
) {
    public val json: JsonObject
        get() = buildJsonObject {
            put("planId", JsonPrimitive(planId))
            put("packId", JsonPrimitive(packId))
            put("record", JsonPrimitive(record))
            put("recordSha256", JsonPrimitive(recordSha256))
            put("variant", JsonPrimitive(variant))
            put("strategy", JsonPrimitive(strategy))
            put("objects", JsonArray(objects.map { buildJsonObject { put("sha256", JsonPrimitive(it.sha256)); put("bytes", jsonInt(it.bytes)); put("done", jsonInt(it.done)) } }))
            put("startedAt", jsonInt(startedAt))
            delta?.let { put("delta", JsonPrimitive(it)) }
            feedDelta?.let { put("feedDelta", it.json) }
            delegation?.let { put("delegation", JsonPrimitive(it)) }
        }
}

/** The install state document. */
public data class PackStateDoc(
    val v: Int = PACK_STATE_VERSION,
    val active: Map<String, PackInstall> = emptyMap(),
    val previous: Map<String, PackInstall> = emptyMap(),
    val inflight: Map<String, PackJournal> = emptyMap(),
    val observed: Map<String, JsonElement> = emptyMap(),
    val confirmedBootSeq: Long = 0,
    val bootSeq: Long = 0,
    /** Set when the engine first stores a revocation in the sibling `revocations.json`; never cleared. */
    val revocationsStored: Boolean = false,
) {
    public val json: JsonObject
        get() = buildJsonObject {
            put("v", jsonInt(v.toLong()))
            put("active", JsonObject(active.mapValues { it.value.json }))
            put("previous", JsonObject(previous.mapValues { it.value.json }))
            put("inflight", JsonObject(inflight.mapValues { it.value.json }))
            put("observed", JsonObject(observed))
            put("confirmedBootSeq", jsonInt(confirmedBootSeq))
            put("bootSeq", jsonInt(bootSeq))
            if (revocationsStored) put("revocationsStored", JsonPrimitive(true))
        }
}

/**
 * Where the document lives: read it whole, replace it atomically. [read] answers null ONLY when there
 * is no document and throws for anything else. The quarantine members keep a torn document aside, as
 * `state.json.torn`, before the first write replaces it.
 */
public interface PackStateStore {
    public fun read(): String?
    public fun replace(text: String)

    /** Keep the torn text aside (never overwriting an earlier one). */
    public fun quarantine(text: String)

    /** Whether a quarantined document is held. */
    public fun quarantined(): Boolean

    /** Drop the quarantined document and its hold list (operator recovery). */
    public fun clearQuarantine()

    /** Whether this store keeps the torn hold's snapshot. */
    public val keepsHoldList: Boolean get() = false

    /** The hold's saved snapshot: null when none was saved; throws when it cannot be read. */
    public fun readHoldList(): String? = null

    /** Save the hold's snapshot, atomically, the first time a hold starts. */
    public fun writeHoldList(text: String) {}
}

public fun emptyPackState(): PackStateDoc = PackStateDoc()

private fun nat(v: JsonElement?): Long? = v.longValue?.takeIf { it in 0..MAX_WIRE_INTEGER }

private fun asInstall(v: JsonElement, packId: String): PackInstall? {
    val o = v.objectValue ?: return null
    if (o["packId"].stringValue != packId || !isPackId(packId)) return null
    val s = HashMap<String, String>()
    for (k in listOf("record", "version", "type", "variant", "layout", "location")) s[k] = o[k].stringValue ?: return null
    val rs = o["recordSha256"].stringValue ?: return null
    val ps = o["payloadSha256"].stringValue ?: return null
    if (!isSha256Hex(rs) || !isSha256Hex(ps)) return null
    val seq = nat(o["seq"]) ?: return null
    val size = nat(o["payloadSize"]) ?: return null
    val at = nat(o["installedAt"]) ?: return null
    val embedded = if (o.containsKey("embedded")) o["embedded"].boolValue ?: return null else null
    val activation = o["activation"].stringValue ?: return null
    if (activation != "hot" && activation != "restart") return null
    val delegation = if (o.containsKey("delegation")) o["delegation"].stringValue ?: return null else null
    return PackInstall(
        packId, s.getValue("record"), rs, s.getValue("version"), seq, s.getValue("type"), s.getValue("variant"),
        s.getValue("layout"), ps, size, activation, s.getValue("location"), embedded, at, delegation,
    )
}

/** A journal's `feedDelta`: the shape of a feed menu entry (plans/P4-29.md §2.2). */
private fun asFeedDelta(v: JsonElement?): FeedDelta? {
    val o = v.objectValue ?: return null
    val a = o["artifact"].objectValue ?: return null
    val from = o["from"].stringValue ?: return null
    if (!isSha256Hex(from)) return null
    val method = o["method"].stringValue ?: return null
    if (o["scope"].stringValue != "payload") return null
    val mem = nat(o["memBytes"]) ?: return null
    if (mem < 1) return null
    val sha = a["sha256"].stringValue ?: return null
    if (!isSha256Hex(sha)) return null
    val bytes = nat(a["bytes"]) ?: return null
    if (bytes < 1) return null
    return FeedDelta(from, method, mem, sha, bytes)
}

private fun asJournal(v: JsonElement, packId: String): PackJournal? {
    val o = v.objectValue ?: return null
    if (o["packId"].stringValue != packId || !isPackId(packId)) return null
    val planId = o["planId"].stringValue ?: return null
    val record = o["record"].stringValue ?: return null
    val variant = o["variant"].stringValue ?: return null
    val strategy = o["strategy"].stringValue ?: return null
    val rs = o["recordSha256"].stringValue ?: return null
    if (!isSha256Hex(rs)) return null
    val delta = if (o.containsKey("delta")) o["delta"].stringValue ?: return null else null
    val feedDelta = if (o.containsKey("feedDelta")) asFeedDelta(o["feedDelta"]) ?: return null else null
    val delegation = if (o.containsKey("delegation")) o["delegation"].stringValue ?: return null else null
    if (!packMatch("[A-Za-z0-9_-]{1,64}", planId)) return null
    val started = nat(o["startedAt"]) ?: return null
    val list = o["objects"].arrayValue ?: return null
    val objects = list.map { x ->
        val xo = x.objectValue ?: return null
        val sha = xo["sha256"].stringValue ?: return null
        if (!isSha256Hex(sha)) return null
        val bytes = nat(xo["bytes"]) ?: return null
        val done = nat(xo["done"]) ?: return null
        if (done > bytes) return null
        JournalObject(sha, bytes, done)
    }
    return PackJournal(planId, packId, record, rs, variant, strategy, delta, objects, started, delegation, feedDelta)
}

/** Whether stored text is at least a version-1 state document's shape. */
internal fun looksLikeState(text: String): Boolean = parseJson(text).objectValue?.get("v").longValue == PACK_STATE_VERSION.toLong()

/** Parse the stored document's shape; anything malformed is dropped entry by entry. Shape only. */
public fun parsePackState(text: String?): PackStateDoc {
    if (text == null) return emptyPackState()
    val doc = parseJson(text).objectValue ?: return emptyPackState()
    if (doc["v"].longValue != PACK_STATE_VERSION.toLong()) return emptyPackState()
    val active = LinkedHashMap<String, PackInstall>()
    for ((id, v) in doc["active"].objectValue ?: emptyMap()) asInstall(v, id)?.let { active[id] = it }
    val previous = LinkedHashMap<String, PackInstall>()
    for ((id, v) in doc["previous"].objectValue ?: emptyMap()) asInstall(v, id)?.let { previous[id] = it }
    val inflight = LinkedHashMap<String, PackJournal>()
    for ((id, v) in doc["inflight"].objectValue ?: emptyMap()) asJournal(v, id)?.let { inflight[id] = it }
    val boot = nat(doc["bootSeq"]) ?: 0
    val confirmed = minOf(nat(doc["confirmedBootSeq"]) ?: 0, boot)
    return PackStateDoc(
        PACK_STATE_VERSION, active, previous, inflight, doc["observed"].objectValue ?: emptyMap(), confirmed, boot,
        doc["revocationsStored"].boolValue == true,
    )
}

public fun serializePackState(state: PackStateDoc): String = canonicalJson(state.json)

/** What [reloadPackState] asks of the host for each entry. Throwing counts as false. */
public class PackStateVerifier(
    public val install: suspend (PackInstall) -> Boolean,
    public val journal: suspend (PackJournal) -> Boolean,
)

/** The reload path: every install and journal goes through the verifier; only what passes survives. */
public suspend fun reloadPackState(state: PackStateDoc, verify: PackStateVerifier): PackStateDoc {
    suspend fun ok(f: suspend () -> Boolean): Boolean = try {
        f()
    } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
    } catch (e: Exception) {
        false
    }
    val active = LinkedHashMap<String, PackInstall>()
    for (id in state.active.keys.sorted()) {
        val i = state.active.getValue(id)
        if (ok { verify.install(i) }) active[id] = i
    }
    val previous = LinkedHashMap<String, PackInstall>()
    for (id in state.previous.keys.sorted()) {
        val i = state.previous.getValue(id)
        if (active[id]?.recordSha256 == i.recordSha256) continue
        if (ok { verify.install(i) }) previous[id] = i
    }
    val inflight = LinkedHashMap<String, PackJournal>()
    for (id in state.inflight.keys.sorted()) {
        val j = state.inflight.getValue(id)
        if (ok { verify.journal(j) }) inflight[id] = j
    }
    return PackStateDoc(
        PACK_STATE_VERSION, active, previous, inflight, state.observed, state.confirmedBootSeq, state.bootSeq + 1, state.revocationsStored,
    )
}

/** Start (or restart) a plan: its journal becomes the pack's `inflight`. */
public fun beginInstall(state: PackStateDoc, journal: PackJournal): PackStateDoc = state.copy(inflight = state.inflight + (journal.packId to journal))

/** Record how many bytes of one staged object are done. */
public fun checkpoint(state: PackStateDoc, packId: String, sha256: String, done: Long): PackStateDoc {
    val j = state.inflight[packId] ?: return state
    val next = j.copy(objects = j.objects.map { if (it.sha256 == sha256) it.copy(done = minOf(done, it.bytes)) else it })
    return state.copy(inflight = state.inflight + (packId to next))
}

/** Abandon a plan (its staging becomes garbage). */
public fun abandonInstall(state: PackStateDoc, packId: String): PackStateDoc = state.copy(inflight = state.inflight - packId)

/** Commit a verified install: the pointer swap. */
public fun commitInstall(state: PackStateDoc, install: PackInstall): PackStateDoc {
    var previous = state.previous
    val old = state.active[install.packId]
    if (old != null && old.recordSha256 != install.recordSha256) previous = previous + (install.packId to old)
    return state.copy(previous = previous, inflight = state.inflight - install.packId, active = state.active + (install.packId to install))
}

/** Roll a pack back to `previous`. Unchanged (and false) when there is none. */
public fun rollbackInstall(state: PackStateDoc, packId: String): Pair<PackStateDoc, Boolean> {
    val prev = state.previous[packId] ?: return state to false
    return state.copy(previous = state.previous - packId, active = state.active + (packId to prev)) to true
}

/** Mark this boot healthy (CONTENT §10 step 7). */
public fun confirmBoot(state: PackStateDoc): PackStateDoc = state.copy(confirmedBootSeq = state.bootSeq)

/** What garbage collection must keep. */
public data class PackGcRoots(val locations: Set<String>, val plans: Set<String>)

/** `roots()` (CONTENT §4.1): every active, previous and embedded location, and every in-flight plan id. */
public fun gcRoots(state: PackStateDoc, embedded: Collection<PackInstall> = emptyList()): PackGcRoots {
    val locations = HashSet<String>()
    state.active.values.forEach { locations += it.location }
    state.previous.values.forEach { locations += it.location }
    embedded.forEach { locations += it.location }
    return PackGcRoots(locations, state.inflight.values.map { it.planId }.toSet())
}
