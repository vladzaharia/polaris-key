// The content decision — plans/P4-13.md §2.6 (WIRE-CONTRACT-V4 §11.1), ported by P6-08 from Swift's
// `ContentDecision.swift`; client-core's `decide.ts` is the reference and
// `update-matrix.json#/contentRows` pins every rule.
//
// With `UpdateDecisionInput.content`, P3-01's app answer is refined by the pack composition (pins,
// holds, the feed's rows after the outlet's narrowing and gates, stored revocations and their
// usable replacements), the content blocks (`revoked-content` for a REQUIRED pack revoked without a
// fix; `content-floor` for a pack below its floor), `prestage` on a `binary` offer, and the `packs`
// answer. Pure and synchronous: the caller does every fetch, hash and signature check.

package im.plrs.key.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

// ── Inputs and outputs ──────────────────────────────────────────────────────────────────────────

/** A pack and an exact release: a `packs` answer's `install` entry, a `prestage` entry, a stamp pin. */
public data class PackTarget(val pack: String, val release: ReleasePin) {
    public val json: JsonObject
        get() = buildJsonObject {
            put("pack", JsonPrimitive(pack))
            put("release", release.json)
        }
}

/** One entry of a `packs` answer's `set`: the effective release of a pack. */
public data class PackSetMember(val pack: String, val sha256: String) {
    public val json: JsonObject
        get() = buildJsonObject {
            put("pack", JsonPrimitive(pack))
            put("sha256", JsonPrimitive(sha256))
        }
}

/** One `expects` entry of a content stamp. */
public data class ContentExpectation(val pack: String, val required: Boolean, val delivery: String)

/** The running build's content stamp as the decision reads it, with its holds (null when unusable). */
public data class UpdateContentStamp(
    val contentApi: Long,
    val pins: List<PackTarget>,
    val expects: List<ContentExpectation>,
    val holds: List<ContentHold>?,
)

/** One stored, verified revocation (the winner of [newerRevocation] for its target). */
public data class ContentRevocationInput(
    val target: String,
    val pack: String,
    val replacement: ReleasePin?,
    /** False while a replacement is still unfetched (§2.5 step 12 retries it). */
    val replacementUsable: Boolean,
)

/** `UpdateDecisionInput.content` (plans/P4-13.md §2.6 "Input"). */
public data class UpdateContentInput(
    val stamp: UpdateContentStamp,
    /** The pack state's active installs, embedded baselines included, by pack id. */
    val active: Map<String, ReleasePin>,
    /** The host's variant preferences, per axis. */
    val axes: Map<String, List<String>>,
    val revocations: List<ContentRevocationInput>,
    /** The rollout bucket of every gate salt; a null value for a host that computed none. */
    val buckets: Map<String, Long?>,
) {
    public companion object {
        /** The decoded form (`update-matrix.json#/contentRows/<i>/input/content`), or null. Shape only. */
        public fun from(json: JsonElement?): UpdateContentInput? {
            fun pin(v: JsonElement?): ReleasePin? {
                val o = v.objectValue ?: return null
                return ReleasePin(o["sha256"].stringValue ?: return null, o["seq"].longValue ?: return null, o["version"].stringValue ?: return null)
            }
            val o = json.objectValue ?: return null
            val s = o["stamp"].objectValue ?: return null
            val contentApi = s["contentApi"].longValue ?: return null
            val rawPins = s["pins"].arrayValue ?: return null
            val rawExpects = s["expects"].arrayValue ?: return null
            val rawActive = o["active"].objectValue ?: return null
            val rawAxes = o["axes"].objectValue ?: return null
            val rawRevs = o["revocations"].arrayValue ?: return null
            val rawBuckets = o["buckets"].objectValue ?: return null
            val pins = rawPins.map { p ->
                val po = p.objectValue ?: return null
                PackTarget(po["pack"].stringValue ?: return null, pin(po["release"]) ?: return null)
            }
            val expects = rawExpects.map { e ->
                val eo = e.objectValue ?: return null
                ContentExpectation(eo["pack"].stringValue ?: return null, eo["required"].boolValue ?: return null, eo["delivery"].stringValue ?: return null)
            }
            val holds: List<ContentHold>? = when {
                !s.containsKey("holds") -> emptyList()
                s["holds"] is JsonNull -> null
                else -> (s["holds"].arrayValue ?: return null).map { h ->
                    val ho = h.objectValue ?: return null
                    ContentHold(ho["pack"].stringValue ?: return null, pin(ho["release"]) ?: return null, ho["reason"].stringValue)
                }
            }
            val active = rawActive.mapValues { (_, v) -> pin(v) ?: return null }
            val axes = rawAxes.mapValues { (_, v) -> (v.arrayValue ?: return null).mapNotNull { it.stringValue } }
            val revs = rawRevs.map { r ->
                val ro = r.objectValue ?: return null
                val rep = ro["replacement"]
                val replacement = if (rep == null || rep is JsonNull) null else pin(rep) ?: return null
                ContentRevocationInput(
                    ro["target"].stringValue ?: return null,
                    ro["pack"].stringValue ?: return null,
                    replacement,
                    ro["replacementUsable"].boolValue ?: return null,
                )
            }
            val buckets = rawBuckets.mapValues { it.value.longValue }
            return UpdateContentInput(UpdateContentStamp(contentApi, pins, expects, holds), active, axes, revs, buckets)
        }
    }
}

// ── Row selection (§2.6 steps 1–4) ──────────────────────────────────────────────────────────────

private fun lexLess(a: List<Int>, b: List<Int>): Boolean {
    for (i in 0 until minOf(a.size, b.size)) if (a[i] != b[i]) return a[i] < b[i]
    return a.size < b.size
}

/**
 * Row selection (plans/P4-13.md §2.6 steps 1–4): the candidate rows of [packSets] at
 * ([contentApi], [platform]) whose `engine` equals [engine] exactly, grouped by their sorted axis
 * names; in each group the row whose every axis is in [axes] with the lowest tuple of preference
 * indexes. Returns the feed target per pack, a pack named by two selected rows left out.
 */
public fun selectPackRows(
    packSets: FeedPackSets,
    contentApi: Long,
    platform: String,
    engine: String,
    axes: Map<String, List<String>>,
): Map<String, String> {
    val groups = LinkedHashMap<String, Pair<String, List<Int>>>()
    for (row in packSets.rows) {
        if (row.contentApi != contentApi || row.platform != platform || row.engine != engine) continue
        val names = row.variant.keys.sortedWith { a, b -> compareUtf8Bytes(a, b) }
        val key = ArrayList<Int>()
        var eligible = true
        for (axis in names) {
            val k = axes[axis]?.indexOf(row.variant[axis]!!) ?: -1
            if (k < 0) {
                eligible = false
                break
            }
            key += k
        }
        if (!eligible) continue
        val group = names.joinToString("\u0000")
        val best = groups[group]
        if (best != null && !lexLess(key, best.second)) continue
        groups[group] = row.set to key
    }
    val targets = LinkedHashMap<String, String>()
    val twice = HashSet<String>()
    for ((_, g) in groups) {
        for (h in packSets.sets[g.first] ?: emptyList()) {
            val rel = packSets.releases[h] ?: continue
            if (targets.containsKey(rel.pack)) twice += rel.pack
            targets[rel.pack] = h
        }
    }
    for (p in twice) targets.remove(p)
    return targets
}

// ── The composition ─────────────────────────────────────────────────────────────────────────────

private class Composition {
    val install = ArrayList<PackTarget>()
    val revoke = ArrayList<String>()
    val set = ArrayList<PackSetMember>()
    var revokedRequired = false
    var floor = false
}

private class ContentEnv(
    val content: UpdateContentInput,
    val packSets: FeedPackSets?,
    val floors: List<FeedPackFloor>,
    val pinned: Set<String>,
    val gates: Map<String, FeedPackGate>,
    val dataUpdates: Boolean,
    val platform: String,
    val engine: String,
) {
    val revoked: Map<String, ContentRevocationInput> by lazy { content.revocations.associateBy { it.target } }
}

/** The feed targets at one level, after the outlet's narrowing and gates (§2.6 step 5). */
private fun feedTargets(env: ContentEnv, contentApi: Long, engine: String): Map<String, ReleasePin> {
    val sets = env.packSets ?: return emptyMap()
    val out = LinkedHashMap<String, ReleasePin>()
    for ((pack, h0) in selectPackRows(sets, contentApi, env.platform, engine, env.content.axes)) {
        if (pack in env.pinned) continue
        var h: String? = h0
        val gate = env.gates[h0]
        if (gate != null) {
            var isOut = gate.halted
            val rollout = gate.rollout
            if (!isOut && rollout != null) {
                val b = env.content.buckets[rollout.salt]
                isOut = !(b != null && b < rollout.bp)
            }
            if (isOut) h = gate.fallback
        }
        if (h != null) sets.releases[h]?.let { out[pack] = ReleasePin(h, it.seq, it.version) }
    }
    return out
}

/** `rep(x)`: x when not revoked; else its usable, unrevoked replacement when data updates are allowed and the pack is not narrowed. */
private fun replacementOf(x: ReleasePin?, revoked: Map<String, ContentRevocationInput>, env: ContentEnv, narrowed: Boolean): ReleasePin? {
    if (x == null) return null
    val r = revoked[x.sha256] ?: return x
    val rep = r.replacement
    if (r.replacementUsable && rep != null && !revoked.containsKey(rep.sha256) && env.dataUpdates && !narrowed) return rep
    return null
}

/** The pack composition (§2.6 "Composition, per pack p"). */
private fun compose(env: ContentEnv): Composition {
    val content = env.content
    val stamp = content.stamp
    val level = stamp.contentApi
    val revoked = env.revoked
    fun isRevoked(x: ReleasePin?): Boolean = x != null && revoked.containsKey(x.sha256)

    val pins = stamp.pins.associate { it.pack to it.release }
    val holds = (stamp.holds ?: emptyList()).associate { it.pack to it.release }
    val required = stamp.expects.filter { it.required }.map { it.pack }.toSet()
    val essential = stamp.expects.filter { it.delivery == "essential" }.map { it.pack }.toSet()
    val active = content.active
    val targets = feedTargets(env, level, env.engine)

    val known = HashSet<String>()
    known += pins.keys
    known += holds.keys
    known += stamp.expects.map { it.pack }
    known += active.keys
    known += targets.keys

    val out = Composition()
    for (p in known.sortedWith { a, b -> compareUtf8Bytes(a, b) }) {
        val narrowed = p in env.pinned
        val base: ReleasePin? = pins[p] ?: holds[p] ?: if (narrowed || stamp.holds == null || !env.dataUpdates || env.packSets == null) null else targets[p]

        val act = active[p]
        var cand = replacementOf(base, revoked, env, narrowed)
        if (cand == null && isRevoked(act)) cand = replacementOf(act, revoked, env, narrowed)

        val wanted = act != null || p in required || p in essential
        var install = false
        val c = cand
        if (c != null && c.sha256 != act?.sha256 && wanted) {
            install = pins.containsKey(p) || holds.containsKey(p) || act == null || isRevoked(act) || c.seq > act.seq
        }
        if (install) out.install += PackTarget(p, cand!!)
        val eff: ReleasePin? = if (install) cand else if (act != null && !isRevoked(act)) act else cand
        if (eff != null) out.set += PackSetMember(p, eff.sha256)

        val noFix = cand == null && (isRevoked(act) || (isRevoked(base) && act == null))
        if (noFix && p in required) out.revokedRequired = true
        if (noFix && p !in required && act != null) out.revoke += p

        if (!noFix && (act != null || p in required)) {
            val f = env.floors.firstOrNull { it.pack == p && it.contentApi == level }
            if (f != null) {
                val cmp = eff?.let { compareVersions(f.versionScheme, it.version, f.minVersion) }
                if (cmp == null || cmp < 0) out.floor = true
            }
        }
    }
    return out
}

/** §2.6 "Prestage": the new level's required and essential packs, minus the build's embeds. */
private fun prestageOf(env: ContentEnv, input: UpdateDecisionInput, buildId: String): List<PackTarget> {
    val record = input.record ?: return emptyList()
    val rc = record.json["content"].objectValue ?: return emptyList()
    val level2 = rc["contentApi"].longValue ?: return emptyList()
    if (level2 == env.content.stamp.contentApi) return emptyList()
    val rawBuild = (record.json["builds"].arrayValue ?: emptyList()).mapNotNull { it.objectValue }.firstOrNull { it["id"].stringValue == buildId }
    val embeds = (rawBuild?.get("embeds").arrayValue ?: emptyList()).mapNotNull { it.stringValue }.toSet()
    val engine = rawBuild?.get("requires").objectValue?.get("engine").stringValue ?: env.engine
    val revoked = env.revoked

    val pins = LinkedHashMap<String, ReleasePin>()
    for (p in rc["pins"].arrayValue ?: emptyList()) {
        val po = p.objectValue ?: continue
        val pack = po["pack"].stringValue ?: continue
        val r = po["release"].objectValue ?: continue
        val sha = r["sha256"].stringValue ?: continue
        val seq = r["seq"].longValue ?: continue
        val v = r["version"].stringValue ?: continue
        pins[pack] = ReleasePin(sha, seq, v)
    }
    val recordHolds = holdsOf(rc, record.nonWireIntegers, "/content")
    val holds = (recordHolds ?: emptyList()).associate { it.pack to it.release }
    val targets = if (recordHolds == null || !env.dataUpdates) emptyMap() else feedTargets(env, level2, engine)
    val active = env.content.active

    val out = ArrayList<PackTarget>()
    for (e in rc["expects"].arrayValue ?: emptyList()) {
        val eo = e.objectValue ?: continue
        val p = eo["pack"].stringValue ?: continue
        val required = eo["required"].boolValue == true
        if (!(required || eo["delivery"].stringValue == "essential") || p in embeds) continue
        val narrowed = p in env.pinned
        val release = replacementOf(pins[p] ?: holds[p] ?: targets[p], revoked, env, narrowed) ?: continue
        if (active[p]?.sha256 == release.sha256) continue
        out += PackTarget(p, release)
    }
    return out.sortedWith { a, b -> compareUtf8Bytes(a.pack, b.pack) }
}

/** §2.6 "Order": the content refinement of P3-01's answer [app]. */
internal fun decideContent(input: UpdateDecisionInput, content: UpdateContentInput, app: UpdateDecision): UpdateDecision {
    val feed = input.feed
    val target = feedTarget(feed.app.targets, input.installed.platform)
    val entry = outletEntry(target, input.outlet)
    val entryId = outletEntryKey(target, input.outlet)
    val caps = effectiveCapabilities(input.outlet.kind, input.installed.platform, input.subkind, entry?.capabilities)
    val fc = feedContent(feed.json, feed.nonWireIntegers)
    val outlet: FeedPackOutlet? = entryId?.let { fc.packSets?.outlets?.get(it) }
    fun env(packSets: FeedPackSets?) = ContentEnv(
        content = content,
        packSets = packSets,
        floors = fc.packFloors ?: emptyList(),
        pinned = if (packSets != null) (outlet?.pinned ?: emptyList()).toSet() else emptySet(),
        gates = if (packSets != null) outlet?.gates ?: emptyMap() else emptyMap(),
        dataUpdates = caps.dataUpdates,
        platform = input.installed.platform,
        engine = input.installed.engine ?: "",
    )
    val discard = input.staged != null

    // 1. Stale or unknown version: only revoked required content can change the answer.
    if (app is UpdateDecision.None && (app.reason == UpdateNoneReason.stale || app.reason == UpdateNoneReason.unknownVersion)) {
        if (compose(env(null)).revokedRequired) return UpdateDecision.Blocked(UpdateBlockedReason.revokedContent, discard)
        return app
    }

    val full = env(fc.packSets)
    val c = compose(full)
    val block: String? = if (c.revokedRequired) UpdateBlockedReason.revokedContent else if (c.floor) UpdateBlockedReason.contentFloor else null

    when (app) {
        // 2. The app floor.
        is UpdateDecision.Blocked -> return if (block == null) app else UpdateDecision.Blocked(app.reason, app.discardStaged, block)
        // 3. Offers.
        is UpdateDecision.Binary -> {
            val prestage = prestageOf(full, input, app.build)
            return app.copy(mandatory = block != null || app.mandatory, prestage = prestage, contentBlock = block)
        }
        is UpdateDecision.Store -> {
            if (block != null) return app.copy(mandatory = true, contentBlock = block)
            if (app.mandatory) return app
        }
        is UpdateDecision.Platform -> {
            if (block != null) return app.copy(mandatory = true, contentBlock = block)
            if (app.mandatory) return app
        }
        else -> {}
    }

    // 4. A content block.
    if (block != null) return UpdateDecision.Blocked(block, discard)

    // 5. code-ready.
    if (app is UpdateDecision.CodeReady) return app

    // 6. packs.
    if (caps.dataUpdates && (c.install.isNotEmpty() || c.revoke.isNotEmpty())) {
        return UpdateDecision.Packs(c.install.toList(), c.revoke.toList(), c.set.toList(), discard)
    }

    // 7. Otherwise P3-01's answer.
    return app
}
