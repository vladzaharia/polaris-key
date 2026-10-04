// The pack claims the release record applies at step 14 (plans/P4-01.md §2.3, §2.4;
// WIRE-CONTRACT-V4 §2.5.1, §2.5.2): a `kind: pack` record's claims, an app record's `content` and
// its builds' `embeds`. A port of Swift's `PackClaims.swift` (client-core's `packs/claims.ts`,
// `packs/variant.ts` and the pack half of `record.ts` are the reference). Pure, never throws.
//
// They live in :core, not :packs, because `releaseRecordClaims` applies them and :core cannot
// depend on the packs module (P6-08 builds the pack engine on top of them).

package im.plrs.key.core

import java.util.concurrent.ConcurrentHashMap
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * The pack patterns of `packages/shared-protocol/src/packs.ts`, restated because the constants
 * generator does not carry regular expressions. Each is matched against the WHOLE string
 * ([packMatch]); every class is ASCII.
 */
public object PackPatterns {
    public const val packType: String = "[a-z][a-z0-9-]{0,31}\\.[a-z][a-z0-9-]{0,31}"
    public const val vocabToken: String = "[a-z][a-z0-9-]{0,31}"
    public const val objectFormat: String = "[a-z][a-z0-9-]{0,31}/[1-9][0-9]{0,8}"
    public const val handlerPrefix: String = "res://([A-Za-z0-9_][A-Za-z0-9 ._@+-]*/)+"
    public const val entitlement: String = "[A-Za-z0-9][A-Za-z0-9._:-]{0,63}"
    public const val variantAxis: String = "[a-z][a-z0-9-]{0,15}"
    public const val variantValue: String = "[A-Za-z0-9][A-Za-z0-9-]{0,34}"
    public const val engine: String = "godot-[0-9]+\\.[0-9]+"
    public const val deliverable: String = "[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*"
    public const val version: String = "[0-9A-Za-z][0-9A-Za-z.+-]{0,63}"
}

private val compiledPatterns = ConcurrentHashMap<String, Regex>()

/**
 * Whole-string match through a cached compiled pattern. `Regex.matches` needs the entire input,
 * so a trailing line terminator never matches (WIRE-CONTRACT-V4 §3's rule).
 */
public fun packMatch(pattern: String, value: String): Boolean =
    compiledPatterns.getOrPut(pattern) { Regex(pattern) }.matches(value)

/** 64 lowercase hex digits. */
public fun isSha256Hex(value: String): Boolean =
    value.length == 64 && value.all { it in '0'..'9' || it in 'a'..'f' }

/** An integer claim at [pointer] (V4 §3), decided from the token. */
internal fun packWireInt(v: JsonElement?, pointer: String, min: Long, nonWire: NonWireIntegers): Boolean =
    wireInteger(v.longValue, pointer, min, nonWire)

/** Compare two strings by their UTF-8 bytes (code-point order), never by canonical equivalence. */
public fun compareUtf8Bytes(a: String, b: String): Int {
    val x = a.toByteArray(Charsets.UTF_8)
    val y = b.toByteArray(Charsets.UTF_8)
    for (i in 0 until minOf(x.size, y.size)) {
        val p = x[i].toInt() and 0xff
        val q = y[i].toInt() and 0xff
        if (p != q) return p - q
    }
    return x.size - y.size
}

/** The variant key (V4 §8): `axis=value` pairs sorted by axis bytes, joined with `;`. */
public fun variantKey(variant: Map<String, String>): String =
    variant.keys.sortedWith { a, b -> compareUtf8Bytes(a, b) }.joinToString(";") { "$it=${variant[it]}" }

/** A pack id: `DELIVERABLE_ID_PATTERN`, at most 64 bytes, and not `app`. */
public fun isPackId(value: String?): Boolean =
    value != null && value != "app" && value.toByteArray(Charsets.UTF_8).size <= 64 && packMatch(PackPatterns.deliverable, value)

/**
 * An object ref `{sha256, bytes, size, codec}` at [pointer]: `sha256` 64 lowercase hex; `bytes`
 * and `size` integer claims from [minBytes] and [minSize]; `codec` a vocabulary token; `codec:
 * "none"` only with `bytes == size`. An unknown codec verifies.
 */
public fun objectRef(value: JsonElement?, pointer: String, minBytes: Long, minSize: Long, nonWire: NonWireIntegers = NonWireIntegers()): Boolean {
    val o = value.objectValue ?: return false
    val sha = o["sha256"].stringValue ?: return false
    if (!isSha256Hex(sha)) return false
    if (!packWireInt(o["bytes"], "$pointer/bytes", minBytes, nonWire)) return false
    if (!packWireInt(o["size"], "$pointer/size", minSize, nonWire)) return false
    val codec = o["codec"].stringValue ?: return false
    if (!packMatch(PackPatterns.vocabToken, codec)) return false
    if (codec == "none" && o["bytes"].longValue != o["size"].longValue) return false
    return true
}

/**
 * The `content` claims (plans/P4-01.md §2.4): an integer `contentApi` ≥ 1, `pins` (0–256, `pack`
 * a unique pack id, `release {sha256, seq ≥ 1, version}`) and `expects` (0–256, `pack` a unique
 * pack id, a boolean `required`, a vocabulary-token `delivery`). Unknown members are ignored.
 */
public fun contentClaims(value: JsonElement?, nonWire: NonWireIntegers = NonWireIntegers(), pointer: String = "/content"): Boolean {
    val o = value.objectValue ?: return false
    if (!packWireInt(o["contentApi"], "$pointer/contentApi", 1, nonWire)) return false
    val pins = o["pins"].arrayValue ?: return false
    if (pins.size > MAX_CONTENT_PINS) return false
    val pinned = HashSet<String>()
    for ((i, raw) in pins.withIndex()) {
        val pin = raw.objectValue ?: return false
        val pack = pin["pack"].stringValue
        if (!isPackId(pack) || !pinned.add(pack!!)) return false
        val r = pin["release"].objectValue ?: return false
        val sha = r["sha256"].stringValue ?: return false
        if (!isSha256Hex(sha)) return false
        if (!packWireInt(r["seq"], "$pointer/pins/$i/release/seq", 1, nonWire)) return false
        val v = r["version"].stringValue ?: return false
        if (!packMatch(PackPatterns.version, v)) return false
    }
    val expects = o["expects"].arrayValue ?: return false
    if (expects.size > MAX_CONTENT_PINS) return false
    val expected = HashSet<String>()
    for (raw in expects) {
        val e = raw.objectValue ?: return false
        val pack = e["pack"].stringValue
        if (!isPackId(pack) || !expected.add(pack!!)) return false
        if (e["required"].boolValue == null) return false
        val d = e["delivery"].stringValue ?: return false
        if (!packMatch(PackPatterns.vocabToken, d)) return false
    }
    return true
}

/** `builds[].embeds` (plans/P4-01.md §2.4): 0–64 unique pack ids. */
internal fun embedsClaims(value: JsonElement): Boolean {
    val list = value.arrayValue ?: return false
    if (list.size > MAX_BUILD_EMBEDS) return false
    val seen = HashSet<String>()
    for (id in list) {
        val s = id.stringValue
        if (!isPackId(s) || !seen.add(s!!)) return false
    }
    return true
}

/** An optional member that must match [pattern] when present (a present `null` is refused). */
private fun optPattern(o: JsonObject, key: String, pattern: String): Boolean {
    if (!o.containsKey(key)) return true
    val s = o[key].stringValue ?: return false
    return packMatch(pattern, s)
}

/** A `{sha256, bytes}` member (a delta's `artifact` or `data`): bytes ≥ 1. */
private fun hashBytesOk(v: JsonElement?, pointer: String, nonWire: NonWireIntegers): Boolean {
    val o = v.objectValue ?: return false
    val sha = o["sha256"].stringValue ?: return false
    if (!isSha256Hex(sha)) return false
    return packWireInt(o["bytes"], "$pointer/bytes", 1, nonWire)
}

/**
 * The pack record's claims (plans/P4-01.md §2.3), after the common ones. A value outside a v1
 * vocabulary is never refused here; it only makes the governed thing unusable (§2.2).
 */
internal fun packRecordClaims(doc: JsonObject, nonWire: NonWireIntegers): Boolean {
    fun int(v: JsonElement?, p: String, min: Long) = packWireInt(v, p, min, nonWire)
    if (doc["deliverable"].stringValue == "app") return false
    if (doc.containsKey("builds")) return false
    val type = doc["type"].stringValue ?: return false
    if (!packMatch(PackPatterns.packType, type)) return false
    if (!int(doc["formatVersion"], "/formatVersion", 1)) return false
    if (doc.containsKey("handler")) {
        val h = doc["handler"].objectValue ?: return false
        if (h.containsKey("mountOrder") && !int(h["mountOrder"], "/handler/mountOrder", 0)) return false
        if (h.containsKey("prefixes")) {
            val p = h["prefixes"].arrayValue ?: return false
            if (p.isEmpty() || p.size > 32) return false
            val seen = HashSet<String>()
            for (prefix in p) {
                val s = prefix.stringValue ?: return false
                if (!packMatch(PackPatterns.handlerPrefix, s)) return false
                if (s.toByteArray(Charsets.UTF_8).size > 256 || !seen.add(s)) return false
            }
        }
        if (!optPattern(h, "activation", PackPatterns.vocabToken)) return false
    }
    if (!optPattern(doc, "entitlement", PackPatterns.entitlement)) return false

    val variants = doc["variants"].arrayValue ?: return false
    if (variants.isEmpty() || variants.size > MAX_PACK_VARIANTS) return false
    val keys = HashSet<String>()
    var axes: List<String>? = null
    for ((i, raw) in variants.withIndex()) {
        val v = raw.objectValue ?: return false
        val at = "/variants/$i"
        val sel = v["variant"].objectValue ?: return false
        if (sel.size > 4) return false
        val selection = LinkedHashMap<String, String>()
        for ((name, value) in sel) {
            val s = value.stringValue ?: return false
            if (!packMatch(PackPatterns.variantAxis, name) || !packMatch(PackPatterns.variantValue, s)) return false
            selection[name] = s
        }
        val p = v["payload"].objectValue ?: return false
        if (!int(p["size"], "$at/payload/size", 0)) return false
        val psha = p["sha256"].stringValue ?: return false
        if (!isSha256Hex(psha)) return false
        if (!objectRef(v["full"], "$at/full", 0, 0, nonWire)) return false
        val f = v["files"].objectValue ?: return false
        val format = f["format"].stringValue ?: return false
        if (!packMatch(PackPatterns.objectFormat, format)) return false
        val layout = f["layout"].stringValue ?: return false
        if (!packMatch(PackPatterns.vocabToken, layout)) return false
        if (!objectRef(v["files"], "$at/files", 1, 1, nonWire)) return false
        if (f.containsKey("gaps")) {
            val gaps = f["gaps"]
            if (gaps.objectValue == null) return false
            if (layout == "tree") return false
            if (!objectRef(gaps, "$at/files/gaps", 0, 0, nonWire)) return false
        } else if (layout == "container") {
            return false
        }
        if (v.containsKey("deltas")) {
            val deltas = v["deltas"].arrayValue ?: return false
            if (deltas.size > MAX_VARIANT_DELTAS) return false
            val ids = HashSet<String>()
            for ((j, rd) in deltas.withIndex()) {
                val d = rd.objectValue ?: return false
                val dt = "$at/deltas/$j"
                val method = d["method"].stringValue ?: return false
                if (!packMatch(PackPatterns.vocabToken, method)) return false
                val scope = d["scope"].stringValue ?: return false
                if (!packMatch(PackPatterns.vocabToken, scope)) return false
                if (scope == "payload" && layout == "tree") return false
                val from = d["from"].stringValue ?: return false
                if (!isSha256Hex(from)) return false
                if (!int(d["memBytes"], "$dt/memBytes", 1)) return false
                var id: String? = null
                if (scope == "payload") {
                    if (!hashBytesOk(d["artifact"], "$dt/artifact", nonWire)) return false
                    id = d["artifact"].objectValue?.get("sha256").stringValue
                } else if (scope == "files") {
                    if (!objectRef(d["patch"], "$dt/patch", 1, 1, nonWire)) return false
                    if (!hashBytesOk(d["data"], "$dt/data", nonWire)) return false
                    id = d["patch"].objectValue?.get("sha256").stringValue
                }
                if (id != null && !ids.add(id)) return false
            }
        }
        if (v.containsKey("requires")) {
            val r = v["requires"].objectValue ?: return false
            if (!optPattern(r, "engine", PackPatterns.engine)) return false
        }
        if (v.containsKey("chunks")) {
            val c = v["chunks"].objectValue ?: return false
            val cf = c["format"].stringValue ?: return false
            if (!packMatch(PackPatterns.objectFormat, cf)) return false
            if (!objectRef(c, "$at/chunks", 1, 1, nonWire)) return false
            if (c.containsKey("params") && c["params"].objectValue == null) return false
        }
        if (!keys.add(variantKey(selection))) return false
        val names = sel.keys.sorted()
        if (axes != null) {
            if (axes != names) return false
        } else {
            axes = names
        }
    }
    return true
}
