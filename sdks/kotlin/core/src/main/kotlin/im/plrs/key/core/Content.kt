// P4-13's content members, holds and revocation records (plans/P4-13.md §2.2–§2.4; WIRE-CONTRACT-V4
// §2.4.1, §2.5.2, §2.5.3) and P4-29's delta menu, ported to Kotlin by P6-08 from Swift's
// `Content.swift`. client-core's `feed.ts` (`feedContent`, `withFeedContent`), `packs/claims.ts`
// (`holdsOf`) and `record.ts` (`revocationOf`, `verifyRevocation`, `newerRevocation`) are the
// reference; `feedContentCases`, `revocationCases` and `stampCases` pin every verdict.
//
// Every function here reads a member BESIDE the claims, never as a claim: an unusable member is
// null and never refuses the feed or record, so a malformed content member cannot stop app updates.
// Integer members follow V4 §3.1's token rule at their RFC 6901 pointers (pass the verified
// payload's `nonWireIntegers`; an object you built has none). Unknown members are ignored at every
// level, and a parsed value carries the known members only. Nothing here throws.

package im.plrs.key.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

// ── The feed's content members (§2.2) ───────────────────────────────────────────────────────────

/** `packSets.releases[h]`: one pack release the rows' sets name. */
public data class FeedPackRelease(val pack: String, val version: String, val seq: Long) {
    public val json: JsonObject
        get() = buildJsonObject {
            put("pack", JsonPrimitive(pack))
            put("version", JsonPrimitive(version))
            put("seq", jsonInt(seq))
        }
}

/** `packSets.rows[]`: one group's row for a level, platform, engine and variant. */
public data class FeedPackRow(
    val contentApi: Long,
    val platform: String,
    /** `""` or `godot-<major>.<minor>`. */
    val engine: String,
    val variant: Map<String, String>,
    /** A key of `sets`. */
    val set: String,
) {
    public val json: JsonObject
        get() = buildJsonObject {
            put("contentApi", jsonInt(contentApi))
            put("platform", JsonPrimitive(platform))
            put("engine", JsonPrimitive(engine))
            put("variant", JsonObject(variant.mapValues { JsonPrimitive(it.value) }))
            put("set", JsonPrimitive(set))
        }
}

/** `packSets.outlets[id].gates[h]`: a per-outlet halt or rollout of one release. */
public data class FeedPackGate(val halted: Boolean, val rollout: FeedRollout?, val fallback: String?) {
    public val json: JsonObject
        get() = buildJsonObject {
            put("halted", JsonPrimitive(halted))
            put("fallback", fallback?.let { JsonPrimitive(it) } ?: JsonNull)
            rollout?.let { r ->
                put("rollout", buildJsonObject {
                    put("bp", jsonInt(r.bp))
                    put("salt", JsonPrimitive(r.salt))
                })
            }
        }
}

/** `packSets.outlets[id]`: the outlet's narrowing (`pinned`) and gates. */
public data class FeedPackOutlet(val pinned: List<String>? = null, val gates: Map<String, FeedPackGate>? = null) {
    public val json: JsonObject
        get() = buildJsonObject {
            pinned?.let { p -> put("pinned", JsonArray(p.map { JsonPrimitive(it) })) }
            gates?.let { g -> put("gates", JsonObject(g.mapValues { it.value.json })) }
        }
}

/** The feed's `packSets` member. */
public data class FeedPackSets(
    val releases: Map<String, FeedPackRelease>,
    /** `packSetId` → the record hashes of its members. */
    val sets: Map<String, List<String>>,
    val rows: List<FeedPackRow>,
    val outlets: Map<String, FeedPackOutlet>? = null,
) {
    public val json: JsonObject
        get() = buildJsonObject {
            put("releases", JsonObject(releases.mapValues { it.value.json }))
            put("sets", JsonObject(sets.mapValues { e -> JsonArray(e.value.map { JsonPrimitive(it) }) }))
            put("rows", JsonArray(rows.map { it.json }))
            outlets?.let { o -> put("outlets", JsonObject(o.mapValues { it.value.json })) }
        }
}

/** One `packFloors` entry: the effective floor of a pack at a live level. */
public data class FeedPackFloor(val pack: String, val contentApi: Long, val minVersion: String, val versionScheme: String) {
    public val json: JsonObject
        get() = buildJsonObject {
            put("pack", JsonPrimitive(pack))
            put("contentApi", jsonInt(contentApi))
            put("minVersion", JsonPrimitive(minVersion))
            put("versionScheme", JsonPrimitive(versionScheme))
        }
}

/** One `revocations` entry: a revocation record in force, by hash, and its target. */
public data class FeedRevocation(
    /** The revocation record's hash. */
    val record: String,
    val pack: String,
    /** The revoked record's hash. */
    val target: String,
    /** The target's version and `seq`. */
    val version: String,
    val seq: Long,
    /** `delegation` when the target is a delegation (plans/P4-19.md §2.7); null for a pack record. */
    val kind: String? = null,
) {
    public val json: JsonObject
        get() = buildJsonObject {
            put("record", JsonPrimitive(record))
            put("pack", JsonPrimitive(pack))
            put("target", JsonPrimitive(target))
            put("version", JsonPrimitive(version))
            put("seq", jsonInt(seq))
            kind?.let { put("kind", JsonPrimitive(it)) }
        }
}

/** One delta menu entry (plans/P4-29.md §2.2): a `payload`-scope delta from `from` to the key's payload. */
public data class FeedDelta(
    val from: String,
    val method: String,
    val memBytes: Long,
    val artifactSha256: String,
    val artifactBytes: Long,
) {
    /** Always `payload` (an entry of another scope is dropped alone). */
    val scope: String get() = "payload"

    public val json: JsonObject
        get() = buildJsonObject {
            put("from", JsonPrimitive(from))
            put("method", JsonPrimitive(method))
            put("scope", JsonPrimitive(scope))
            put("memBytes", jsonInt(memBytes))
            put("artifact", buildJsonObject {
                put("sha256", JsonPrimitive(artifactSha256))
                put("bytes", jsonInt(artifactBytes))
            })
        }
}

/** The feed's delta menu: target payload SHA-256 → its `payload`-scope entries. */
public typealias FeedDeltas = Map<String, List<FeedDelta>>

/** The menu as JSON (`expect.deltas`' shape). */
public fun feedDeltasJson(d: FeedDeltas): JsonObject = JsonObject(d.mapValues { e -> JsonArray(e.value.map { it.json }) })

/** [feedContent]'s answer: each member parsed, or null when absent or unusable. */
public data class FeedContent(
    val packSets: FeedPackSets?,
    val packFloors: List<FeedPackFloor>?,
    val revocations: List<FeedRevocation>?,
    /** plans/P4-29.md §2.2: the delta menu. */
    val deltas: FeedDeltas? = null,
) {
    /** `{packSets, packFloors, revocations}`, each its value or `null` (`expect.content`). */
    public val json: JsonObject
        get() = buildJsonObject {
            put("packSets", packSets?.json ?: JsonNull)
            put("packFloors", packFloors?.let { l -> JsonArray(l.map { it.json }) } ?: JsonNull)
            put("revocations", revocations?.let { l -> JsonArray(l.map { it.json }) } ?: JsonNull)
        }

    /** The delta menu as JSON, or `null` (`expect.deltas ?? null`). */
    public val deltasJson: JsonElement get() = deltas?.let { feedDeltasJson(it) } ?: JsonNull
}

/** "This member is unusable", caught per member. */
private class Unusable : RuntimeException(null, null, false, false)

private fun need(ok: Boolean) {
    if (!ok) throw Unusable()
}

private fun int(v: JsonElement?, pointer: String, min: Long, nonWire: NonWireIntegers): Long {
    val i = v.longValue
    if (!wireInteger(i, pointer, min, nonWire)) throw Unusable()
    return i!!
}

private fun string(v: JsonElement?, pattern: String): String {
    val s = v.stringValue
    if (s == null || !packMatch(pattern, s)) throw Unusable()
    return s
}

private fun sha256(v: JsonElement?): String {
    val s = v.stringValue
    if (s == null || !isSha256Hex(s)) throw Unusable()
    return s
}

private fun packId(v: JsonElement?): String {
    val s = v.stringValue
    if (!isPackId(s)) throw Unusable()
    return s!!
}

private fun parseVariant(v: JsonElement?): Map<String, String> {
    val sel = v.objectValue ?: throw Unusable()
    need(sel.size <= 4)
    val out = LinkedHashMap<String, String>()
    for ((name, value) in sel) {
        need(packMatch(PackPatterns.variantAxis, name))
        out[name] = string(value, PackPatterns.variantValue)
    }
    return out
}

private fun parsePackSets(v: JsonElement, selector: JsonElement?, nonWire: NonWireIntegers): FeedPackSets {
    val ps = v.objectValue ?: throw Unusable()
    need(ps.containsKey("releases") && ps.containsKey("sets") && ps.containsKey("rows"))

    val rawReleases = ps["releases"].objectValue ?: throw Unusable()
    val releases = LinkedHashMap<String, FeedPackRelease>()
    for ((h, r) in rawReleases) {
        need(isSha256Hex(h))
        val rel = r.objectValue ?: throw Unusable()
        val pack = packId(rel["pack"])
        val version = string(rel["version"], PackPatterns.version)
        val seq = int(rel["seq"], "/packSets/releases/$h/seq", 1, nonWire)
        releases[h] = FeedPackRelease(pack, version, seq)
    }

    val rawSets = ps["sets"].objectValue ?: throw Unusable()
    val sets = LinkedHashMap<String, List<String>>()
    for ((id, members) in rawSets) {
        need(isSha256Hex(id))
        val list = members.arrayValue ?: throw Unusable()
        val packs = HashSet<String>()
        val out = ArrayList<String>()
        for (m in list) {
            val h = m.stringValue ?: throw Unusable()
            val rel = releases[h] ?: throw Unusable()
            need(packs.add(rel.pack))
            out += h
        }
        sets[id] = out
    }

    val rawRows = ps["rows"].arrayValue ?: throw Unusable()
    val platform: JsonElement? = selector.objectValue?.get("platform")
    val rows = ArrayList<FeedPackRow>()
    val keys = HashSet<String>()
    for ((i, r) in rawRows.withIndex()) {
        val row = r.objectValue ?: throw Unusable()
        val contentApi = int(row["contentApi"], "/packSets/rows/$i/contentApi", 1, nonWire)
        val p = row["platform"].stringValue ?: throw Unusable()
        need(packMatch(FEED_PLATFORM_PATTERN, p))
        if (platform != null) need(jsonEquals(row["platform"], platform))
        val engine = row["engine"].stringValue ?: throw Unusable()
        need(engine.isEmpty() || packMatch(PackPatterns.engine, engine))
        val variant = parseVariant(row["variant"])
        val set = row["set"].stringValue ?: throw Unusable()
        need(sets.containsKey(set))
        need(keys.add("$contentApi\u0000$p\u0000$engine\u0000${variantKey(variant)}"))
        rows += FeedPackRow(contentApi, p, engine, variant, set)
    }

    var outlets: Map<String, FeedPackOutlet>? = null
    if (ps.containsKey("outlets")) {
        val o = ps["outlets"].objectValue ?: throw Unusable()
        val parsed = LinkedHashMap<String, FeedPackOutlet>()
        for ((id, e) in o) {
            need(packMatch(OUTLET_ID_PATTERN, id))
            val entry = e.objectValue ?: throw Unusable()
            var pinned: List<String>? = null
            if (entry.containsKey("pinned")) {
                val list = entry["pinned"].arrayValue ?: throw Unusable()
                val seen = HashSet<String>()
                pinned = list.map { p -> packId(p).also { need(seen.add(it)) } }
            }
            var gates: Map<String, FeedPackGate>? = null
            if (entry.containsKey("gates")) {
                val g = entry["gates"].objectValue ?: throw Unusable()
                val out = LinkedHashMap<String, FeedPackGate>()
                for ((h, gv) in g) {
                    need(releases.containsKey(h))
                    val gate = gv.objectValue ?: throw Unusable()
                    val halted = gate["halted"].boolValue ?: throw Unusable()
                    val at = "/packSets/outlets/${pointerToken(id)}/gates/$h"
                    var rollout: FeedRollout? = null
                    if (gate.containsKey("rollout")) {
                        val ro = gate["rollout"].objectValue ?: throw Unusable()
                        val bp = int(ro["bp"], "$at/rollout/bp", 0, nonWire)
                        need(bp <= ROLLOUT_BUCKETS)
                        val salt = ro["salt"].stringValue ?: throw Unusable()
                        need(packMatch(SALT_PATTERN, salt))
                        rollout = FeedRollout(bp, salt)
                    }
                    if (!gate.containsKey("fallback")) throw Unusable()
                    val rawFallback = gate["fallback"]
                    var fallback: String? = null
                    if (rawFallback !is JsonNull) {
                        val f = rawFallback.stringValue ?: throw Unusable()
                        need(releases.containsKey(f))
                        fallback = f
                    }
                    out[h] = FeedPackGate(halted, rollout, fallback)
                }
                gates = out
            }
            parsed[id] = FeedPackOutlet(pinned, gates)
        }
        outlets = parsed
    }
    return FeedPackSets(releases, sets, rows, outlets)
}

private fun parsePackFloors(v: JsonElement, nonWire: NonWireIntegers): List<FeedPackFloor> {
    val list = v.arrayValue ?: throw Unusable()
    val out = ArrayList<FeedPackFloor>()
    val keys = HashSet<String>()
    for ((i, f) in list.withIndex()) {
        val floor = f.objectValue ?: throw Unusable()
        val pack = packId(floor["pack"])
        val contentApi = int(floor["contentApi"], "/packFloors/$i/contentApi", 1, nonWire)
        val minVersion = string(floor["minVersion"], PackPatterns.version)
        val scheme = floor["versionScheme"].stringValue ?: throw Unusable()
        need(keys.add("$pack\u0000$contentApi"))
        // A forward scheme makes that entry alone ignored.
        if (scheme !in FEED_VERSION_SCHEMES) continue
        out += FeedPackFloor(pack, contentApi, minVersion, scheme)
    }
    return out
}

private fun parseRevocations(v: JsonElement, nonWire: NonWireIntegers): List<FeedRevocation> {
    val list = v.arrayValue ?: throw Unusable()
    val out = ArrayList<FeedRevocation>()
    val records = HashSet<String>()
    for ((i, e) in list.withIndex()) {
        val r = e.objectValue ?: throw Unusable()
        val record = sha256(r["record"])
        val pack = packId(r["pack"])
        val target = sha256(r["target"])
        val version = string(r["version"], PackPatterns.version)
        val seq = int(r["seq"], "/revocations/$i/seq", 1, nonWire)
        need(records.add(record))
        // plans/P4-19.md §2.7: `kind` absent or `delegation`; another vocabulary token is a forward
        // value whose entry is dropped alone; anything else makes the member unusable.
        var kind: String? = null
        if (r.containsKey("kind")) {
            val token = string(r["kind"], PackPatterns.vocabToken)
            if (token != "delegation") continue
            kind = token
        }
        out += FeedRevocation(record, pack, target, version, seq, kind)
    }
    return out
}

/**
 * The delta menu (plans/P4-29.md §2.2): both caps and both uniqueness rules count every entry,
 * dropped ones too; an entry of another vocabulary scope is dropped alone and a key whose entries
 * are all dropped is left out. An unknown `method` is kept for the planner to decide.
 */
private fun parseDeltas(v: JsonElement, nonWire: NonWireIntegers): FeedDeltas {
    val menu = v.objectValue ?: throw Unusable()
    val out = LinkedHashMap<String, List<FeedDelta>>()
    val artifacts = HashSet<String>()
    var total = 0
    for ((to, rawList) in menu) {
        need(isSha256Hex(to))
        val list = rawList.arrayValue ?: throw Unusable()
        need(list.size >= 1 && list.size <= MAX_FEED_DELTAS_PER_TARGET)
        total += list.size
        need(total <= MAX_FEED_DELTAS)
        val kept = ArrayList<FeedDelta>()
        val pairs = HashSet<String>()
        for ((i, e) in list.withIndex()) {
            val d = e.objectValue ?: throw Unusable()
            val from = sha256(d["from"])
            need(from != to)
            val method = string(d["method"], PackPatterns.vocabToken)
            val scope = string(d["scope"], PackPatterns.vocabToken)
            val at = "/deltas/$to/$i"
            val memBytes = int(d["memBytes"], "$at/memBytes", 1, nonWire)
            val a = d["artifact"].objectValue ?: throw Unusable()
            val artifact = sha256(a["sha256"])
            val bytes = int(a["bytes"], "$at/artifact/bytes", 1, nonWire)
            need(artifacts.add(artifact))
            need(pairs.add("$from\u0000$method"))
            if (scope != "payload") continue
            kept += FeedDelta(from, method, memBytes, artifact, bytes)
        }
        if (kept.isNotEmpty()) out[to] = kept
    }
    return out
}

private fun <T> member(doc: JsonObject, key: String, parse: (JsonElement) -> T): T? {
    val v = doc[key] ?: return null
    return try {
        parse(v)
    } catch (e: Unusable) {
        null
    }
}

/**
 * The feed's content members (plans/P4-13.md §2.2): `packSets`, `packFloors` and `revocations`, and
 * the delta menu `deltas` (plans/P4-29.md §2.2), each parsed, or null when absent or unusable. An
 * unusable member never refuses the feed and never affects the others.
 */
public fun feedContent(doc: JsonElement?, nonWire: NonWireIntegers = NonWireIntegers()): FeedContent {
    val o = doc.objectValue ?: return FeedContent(null, null, null, null)
    return FeedContent(
        packSets = member(o, "packSets") { parsePackSets(it, o["selector"], nonWire) },
        packFloors = member(o, "packFloors") { parsePackFloors(it, nonWire) },
        revocations = member(o, "revocations") { parseRevocations(it, nonWire) },
        deltas = member(o, "deltas") { parseDeltas(it, nonWire) },
    )
}

/**
 * The feed as the decision reads it: [feed] with each content member replaced by [content]'s
 * parsed value, or removed when that is null.
 */
public fun withFeedContent(feed: ChannelFeedDoc, content: FeedContent): ChannelFeedDoc {
    val o = LinkedHashMap<String, JsonElement>(feed.json)
    fun set(key: String, v: JsonElement?) {
        if (v == null) o.remove(key) else o[key] = v
    }
    set("packSets", content.packSets?.json)
    set("packFloors", content.packFloors?.let { l -> JsonArray(l.map { it.json }) })
    set("revocations", content.revocations?.let { l -> JsonArray(l.map { it.json }) })
    set("deltas", content.deltas?.let { feedDeltasJson(it) })
    return ChannelFeedDoc(
        feed.schemaVersion, feed.iss, feed.aud, feed.channel, feed.selectorPlatform, feed.seq, feed.issuedAt,
        feed.expiresAt, feed.app, JsonObject(o),
    )
}

// ── Holds (§2.4) ────────────────────────────────────────────────────────────────────────────────

/** One `content.holds` entry: a compatible pack held at an exact release. */
public data class ContentHold(val pack: String, val release: ReleasePin, val reason: String? = null) {
    public val json: JsonObject
        get() = buildJsonObject {
            put("pack", JsonPrimitive(pack))
            put("release", release.json)
            reason?.let { put("reason", JsonPrimitive(it)) }
        }
}

/**
 * The holds of an app record's `content` or a content stamp (plans/P4-13.md §2.4), read beside the
 * claims: `holds` absent reads `[]`; otherwise 0–256 entries, each `{pack: a pack id, unique and
 * not pinned, release {sha256, seq ≥ 1 by token, version}, reason?: string}`. Anything else reads
 * null (unusable). [pointer] is where the content object sits: `/content` in a record, `""` in a stamp.
 */
public fun holdsOf(content: JsonElement?, nonWire: NonWireIntegers = NonWireIntegers(), pointer: String = "/content"): List<ContentHold>? {
    val c = content.objectValue ?: return null
    if (!c.containsKey("holds")) return emptyList()
    val holds = c["holds"].arrayValue ?: return null
    if (holds.size > MAX_CONTENT_PINS) return null
    val pinned = HashSet<String>()
    for (p in c["pins"].arrayValue ?: emptyList()) p.objectValue?.get("pack").stringValue?.let { pinned += it }
    val seen = HashSet<String>()
    val out = ArrayList<ContentHold>()
    for ((i, h) in holds.withIndex()) {
        val o = h.objectValue ?: return null
        val pack = o["pack"].stringValue ?: return null
        if (!isPackId(pack)) return null
        if (pack in pinned || !seen.add(pack)) return null
        val r = o["release"].objectValue ?: return null
        val sha = r["sha256"].stringValue ?: return null
        if (!isSha256Hex(sha)) return null
        val seq = r["seq"].longValue ?: return null
        if (!wireInteger(seq, "$pointer/holds/$i/release/seq", 1, nonWire)) return null
        val version = r["version"].stringValue ?: return null
        if (!packMatch(PackPatterns.version, version)) return null
        var reason: String? = null
        if (o.containsKey("reason")) reason = o["reason"].stringValue ?: return null
        out += ContentHold(pack, ReleasePin(sha, seq, version), reason)
    }
    return out
}

/**
 * The holds of a content stamp file (plans/P4-13.md §2.4): strict JSON, then [holdsOf] at the
 * stamp's top level with its own non-wire pointers. Null when the stamp does not parse or its holds
 * are unusable.
 */
public fun stampHolds(input: ByteArray): List<ContentHold>? {
    val parsed = StrictJson.validate(input) ?: return null
    return holdsOf(parsed.value, parsed.nonWireIntegers, "")
}

public fun stampHolds(text: String): List<ContentHold>? = stampHolds(text.toByteArray(Charsets.UTF_8))

// ── The revocation record (§2.3) ────────────────────────────────────────────────────────────────

/** A usable revocation body, as [revocationOf] reads it. */
public data class RevocationBody(
    /** The revoked pack (the record's `deliverable`). */
    val pack: String,
    /** The revoked record's hash (`revokes`). */
    val target: String,
    val replacement: ReleasePin?,
    val reason: String,
    val issuedAt: Long,
) {
    /** `{pack, target, replacement, reason, issuedAt}` (`revocationCases`' `expect.revocation`). */
    public val json: JsonObject
        get() = buildJsonObject {
            put("pack", JsonPrimitive(pack))
            put("target", JsonPrimitive(target))
            put("replacement", replacement?.json ?: JsonNull)
            put("reason", JsonPrimitive(reason))
            put("issuedAt", jsonInt(issuedAt))
        }
}

/**
 * The revocation body (plans/P4-13.md §2.3), read beside the claims: usable when `kind` is
 * `revocation`, `deliverable` is a pack id, `revokes` is 64 lowercase hex, `replacement` is absent
 * or `{sha256: 64 hex and not revokes, seq ≥ 1 by token, version}`, and `reason` is 1–512 bytes.
 */
public fun revocationOf(doc: JsonElement?, nonWire: NonWireIntegers = NonWireIntegers()): RevocationBody? {
    val o = doc.objectValue ?: return null
    if (o["kind"].stringValue != "revocation") return null
    val pack = o["deliverable"].stringValue ?: return null
    if (!isPackId(pack)) return null
    val revokes = o["revokes"].stringValue ?: return null
    if (!isSha256Hex(revokes)) return null
    var replacement: ReleasePin? = null
    if (o.containsKey("replacement")) {
        val r = o["replacement"].objectValue ?: return null
        val sha = r["sha256"].stringValue ?: return null
        if (!isSha256Hex(sha) || sha == revokes) return null
        val seq = r["seq"].longValue ?: return null
        if (!wireInteger(seq, "/replacement/seq", 1, nonWire)) return null
        val version = r["version"].stringValue ?: return null
        if (!packMatch(PackPatterns.version, version)) return null
        replacement = ReleasePin(sha, seq, version)
    }
    val reason = o["reason"].stringValue ?: return null
    val bytes = reason.toByteArray(Charsets.UTF_8).size
    if (bytes < 1 || bytes > REVOCATION_REASON_MAX_BYTES) return null
    val issuedAt = o["issuedAt"].longValue ?: return null
    return RevocationBody(pack, revokes, replacement, reason, issuedAt)
}

/** What [newerRevocation] ranks: an `issuedAt` and a record hash. */
public interface RankedRevocation {
    public val issuedAt: Long
    public val record: String
}

/** A verified revocation: its body, its record hash and the pin it was verified with. */
public data class VerifiedRevocation(
    val pack: String,
    val target: String,
    val replacement: ReleasePin?,
    val reason: String,
    override val issuedAt: Long,
    /** The revocation record's hash. */
    override val record: String,
    /** The target's version and `seq` (the record's own `version` and `seq`). */
    val version: String,
    val seq: Long,
) : RankedRevocation {
    public val body: RevocationBody get() = RevocationBody(pack, target, replacement, reason, issuedAt)
}

public data class VerifyRevocationOptions(
    /** The PINNED release keys only, never the Worker's trust set. */
    val releaseKeys: TrustSet,
    /** The effective product trust set: a release key whose bytes are in it is refused. */
    val productTrust: TrustSet,
    val expectedAud: String,
    /** The feed's `revocations` entry (or a stored entry's equivalent). */
    val entry: FeedRevocation,
)

/** Why [verifyRevocation] refused, by step (`revocationCases` `expect.step`). */
public enum class RevocationStep(public val wire: String) {
    hash("hash"),
    jws("jws"),
    claims("claims"),
    crossCheck("cross-check"),
    revocation("revocation"),
}

public sealed interface VerifyRevocationResult {
    public data class Ok(val revocation: VerifiedRevocation) : VerifyRevocationResult
    public data class Refused(val step: RevocationStep) : VerifyRevocationResult
}

public val VerifyRevocationResult.revocation: VerifiedRevocation? get() = (this as? VerifyRevocationResult.Ok)?.revocation

public val VerifyRevocationResult.step: RevocationStep? get() = (this as? VerifyRevocationResult.Refused)?.step

/**
 * Verify a revocation record against a feed entry (plans/P4-13.md §2.3): V4 §3.5 steps 12–14 with
 * `entry.record` as the pin hash, step 15 with the pin `{kind: "revocation", deliverable:
 * entry.pack, version: entry.version, seq: entry.seq}`, and step 16 (`revocation`): the body is
 * usable and `revokes == entry.target`.
 */
public fun verifyRevocation(jws: String, options: VerifyRevocationOptions): VerifyRevocationResult {
    val entry = options.entry
    val r = verifyReleaseRecord(
        jws,
        VerifyReleaseRecordOptions(
            releaseKeys = options.releaseKeys,
            productTrust = options.productTrust,
            expectedAud = options.expectedAud,
            expectedHash = entry.record,
            pin = ReleaseRecordPin(kind = "revocation", deliverable = entry.pack, version = entry.version, seq = entry.seq),
        ),
    )
    val record = when (r) {
        is VerifyReleaseRecordResult.Refused -> return VerifyRevocationResult.Refused(
            RevocationStep.entries.firstOrNull { it.wire == r.step.wire } ?: RevocationStep.jws,
        )
        is VerifyReleaseRecordResult.Ok -> r.record
        is VerifyReleaseRecordResult.Delegated -> r.record
    }
    val body = revocationOf(record.json, record.nonWireIntegers)
    if (body == null || body.target != entry.target) return VerifyRevocationResult.Refused(RevocationStep.revocation)
    return VerifyRevocationResult.Ok(
        VerifiedRevocation(body.pack, body.target, body.replacement, body.reason, body.issuedAt, entry.record, record.version, record.seq),
    )
}

/**
 * The winner of two verified revocations of one target (plans/P4-13.md §2.3, decision 18): the
 * higher `issuedAt`, else the higher record hash by bytes.
 */
public fun <T : RankedRevocation> newerRevocation(a: T, b: T): T {
    if (a.issuedAt != b.issuedAt) return if (a.issuedAt > b.issuedAt) a else b
    return if (compareUtf8Bytes(a.record, b.record) >= 0) a else b
}
