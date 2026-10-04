// The typed views of packs on the wire (`@polaris-key/protocol/packs`; plans/P4-01.md §2.3–§2.8).
// Each is built from a JSON value that already passed its claims (the record's step 14, the files
// index's member rules, the stamp's `contentClaims`); the views are SHAPE only and keep unknown
// vocabulary values as strings, so an unusable codec, layout, method or scope stays visible to the
// selection and planning rules rather than being dropped at parse. A port of Swift's `Types.swift`.

package im.plrs.key.packs

import im.plrs.key.core.ContentExpectation
import im.plrs.key.core.JsonText
import im.plrs.key.core.NonWireIntegers
import im.plrs.key.core.PackTarget
import im.plrs.key.core.ReleasePin
import im.plrs.key.core.StrictJson
import im.plrs.key.core.ContentHold
import im.plrs.key.core.UpdateContentStamp
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.jsonInt
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** An object ref `{sha256, bytes, size, codec}` over the stored bytes. */
public data class PackObjectRef(val sha256: String, val bytes: Long, val size: Long, val codec: String) {
    public val json: JsonObject
        get() = buildJsonObject {
            put("sha256", JsonPrimitive(sha256))
            put("bytes", jsonInt(bytes))
            put("size", jsonInt(size))
            put("codec", JsonPrimitive(codec))
        }

    public companion object {
        public fun from(json: JsonElement?): PackObjectRef? {
            val o = json.objectValue ?: return null
            return PackObjectRef(
                o["sha256"].stringValue ?: return null,
                o["bytes"].longValue ?: return null,
                o["size"].longValue ?: return null,
                o["codec"].stringValue ?: return null,
            )
        }
    }
}

/** A `{sha256, bytes}` member: a payload delta's `artifact`, a files delta's `data`. */
public data class PackHashBytes(val sha256: String, val bytes: Long) {
    public companion object {
        public fun from(json: JsonElement?): PackHashBytes? {
            val o = json.objectValue ?: return null
            return PackHashBytes(o["sha256"].stringValue ?: return null, o["bytes"].longValue ?: return null)
        }
    }
}

/** A variant's `files` member: an object ref plus `format`, `layout` and (a container's) `gaps`. */
public data class PackFilesRef(
    val format: String?,
    val layout: String,
    val sha256: String,
    val bytes: Long,
    val size: Long,
    val codec: String,
    /** A container's gaps ref; null when absent or without a `size`. */
    val gaps: PackObjectRef?,
) {
    val ref: PackObjectRef get() = PackObjectRef(sha256, bytes, size, codec)

    public companion object {
        public fun from(json: JsonElement?): PackFilesRef? {
            val o = json.objectValue ?: return null
            return PackFilesRef(
                o["format"].stringValue,
                o["layout"].stringValue ?: return null,
                o["sha256"].stringValue ?: return null,
                o["bytes"].longValue ?: return null,
                o["size"].longValue ?: return null,
                o["codec"].stringValue ?: return null,
                PackObjectRef.from(o["gaps"]),
            )
        }
    }
}

/** One entry of `deltas[]`. */
public sealed interface PackDelta {
    public val scope: String
    public val method: String
    public val from: String
    public val memBytes: Long

    /** The delta's id: a payload delta's artifact hash, a files delta's patch hash. */
    public val id: String?

    /** `scope: "payload"`: one raw-prefix frame over the whole installed payload. */
    public data class Payload(override val method: String, override val from: String, override val memBytes: Long, val artifact: PackHashBytes) : PackDelta {
        override val scope: String get() = "payload"
        override val id: String get() = artifact.sha256
    }

    /** `scope: "files"`: the `pkey-patch/1` descriptor and its packed data object. */
    public data class Files(
        override val method: String,
        override val from: String,
        override val memBytes: Long,
        val patch: PackObjectRef,
        val data: PackHashBytes,
    ) : PackDelta {
        override val scope: String get() = "files"
        override val id: String get() = patch.sha256
    }

    /** Any other scope (unusable in v1). */
    public data class Other(override val scope: String, override val method: String, override val from: String, override val memBytes: Long) : PackDelta {
        override val id: String? get() = null
    }

    public companion object {
        public fun from(json: JsonElement?): PackDelta? {
            val o = json.objectValue ?: return null
            val scope = o["scope"].stringValue ?: return null
            val method = o["method"].stringValue ?: return null
            val from = o["from"].stringValue ?: return null
            val mem = o["memBytes"].longValue ?: return null
            if (scope == "payload") PackHashBytes.from(o["artifact"])?.let { return Payload(method, from, mem, it) }
            if (scope == "files") {
                val p = PackObjectRef.from(o["patch"])
                val d = PackHashBytes.from(o["data"])
                if (p != null && d != null) return Files(method, from, mem, p, d)
            }
            return Other(scope, method, from, mem)
        }
    }
}

/** `payload {size, sha256}`. */
public data class PackPayload(val size: Long, val sha256: String) {
    public val json: JsonObject
        get() = buildJsonObject {
            put("size", jsonInt(size))
            put("sha256", JsonPrimitive(sha256))
        }

    public companion object {
        public fun from(json: JsonElement?): PackPayload? {
            val o = json.objectValue ?: return null
            return PackPayload(o["size"].longValue ?: return null, o["sha256"].stringValue ?: return null)
        }
    }
}

/** A variant's chunk-index reference (plans/P4-10.md §2.2): `format` plus an object ref. */
public data class PackChunksRef(val format: String?, val ref: PackObjectRef) {
    public companion object {
        public fun from(json: JsonElement?): PackChunksRef? {
            val o = json.objectValue ?: return null
            val ref = PackObjectRef.from(o) ?: return null
            return PackChunksRef(o["format"].stringValue, ref)
        }
    }
}

/** One variant of a pack record. */
public data class PackVariant(
    val variant: Map<String, String>,
    val payload: PackPayload,
    val full: PackObjectRef?,
    val files: PackFilesRef,
    val deltas: List<PackDelta>,
    val requires: JsonObject?,
    /** plans/P4-10.md §2.2: the chunk index, valid but ignored on a `tree`. */
    val chunks: PackChunksRef?,
) {
    public companion object {
        public fun from(json: JsonElement?): PackVariant? {
            val o = json.objectValue ?: return null
            val payload = PackPayload.from(o["payload"]) ?: return null
            // A fragment without `files` (a corpus apply case for a payload delta) reads as an empty
            // layout, which no rule can use.
            val files = PackFilesRef.from(o["files"]) ?: PackFilesRef(null, "", "", 0, 0, "", null)
            val sel = LinkedHashMap<String, String>()
            for ((k, v) in o["variant"].objectValue ?: emptyMap()) sel[k] = v.stringValue ?: ""
            return PackVariant(
                sel, payload, PackObjectRef.from(o["full"]), files,
                (o["deltas"].arrayValue ?: emptyList()).mapNotNull { PackDelta.from(it) },
                o["requires"].objectValue, PackChunksRef.from(o["chunks"]),
            )
        }
    }
}

/** A verified `kind: pack` record (plans/P4-01.md §2.3). */
public class PackRecordDoc(
    public val deliverable: String,
    public val version: String,
    public val seq: Long,
    public val issuedAt: Long,
    public val type: String,
    public val formatVersion: Long,
    /** `handler.activation`, when the record names one. */
    public val activation: String?,
    public val entitlement: String?,
    public val variants: List<PackVariant>,
    /** The payload as verified. */
    public val json: JsonObject,
) {
    public companion object {
        public fun from(json: JsonElement?): PackRecordDoc? {
            val o = json.objectValue ?: return null
            if (o["kind"].stringValue != "pack") return null
            val raw = o["variants"].arrayValue ?: return null
            val variants = raw.map { PackVariant.from(it) ?: return null }
            return PackRecordDoc(
                o["deliverable"].stringValue ?: return null,
                o["version"].stringValue ?: return null,
                o["seq"].longValue ?: return null,
                o["issuedAt"].longValue ?: return null,
                o["type"].stringValue ?: return null,
                o["formatVersion"].longValue ?: return null,
                o["handler"].objectValue?.get("activation").stringValue,
                o["entitlement"].stringValue,
                variants,
                o,
            )
        }
    }
}

/** One entry of a `pkey-files/1` index. */
public data class FilesIndexEntry(val path: String, val size: Long, val sha256: String, val blob: Blob, val offset: Long?) {
    public data class Blob(val sha256: String, val bytes: Long, val codec: String)
}

/** A parsed `pkey-files/1` index. */
public class FilesIndexDoc(
    public val layout: String,
    public val payload: PackPayload,
    public val files: List<FilesIndexEntry>,
    /** The document as parsed (what a host keeps beside an install). */
    public val json: JsonObject,
) {
    public companion object {
        /** The typed view of an index that passed `parseFilesIndex`'s member rules (or a kept copy). */
        public fun from(json: JsonElement?): FilesIndexDoc? {
            val o = json.objectValue ?: return null
            val layout = o["layout"].stringValue ?: return null
            val payload = PackPayload.from(o["payload"]) ?: return null
            val list = o["files"].arrayValue ?: return null
            val files = ArrayList<FilesIndexEntry>(list.size)
            for (e in list) {
                val eo = e.objectValue ?: return null
                val b = eo["blob"].objectValue ?: return null
                files += FilesIndexEntry(
                    eo["path"].stringValue ?: return null,
                    eo["size"].longValue ?: return null,
                    eo["sha256"].stringValue ?: return null,
                    FilesIndexEntry.Blob(b["sha256"].stringValue ?: return null, b["bytes"].longValue ?: return null, b["codec"].stringValue ?: return null),
                    eo["offset"].longValue,
                )
            }
            return FilesIndexDoc(layout, payload, files, o)
        }
    }
}

/** One pin of the content stamp / an app record's `content`. */
public data class ContentPin(val pack: String, val sha256: String, val seq: Long, val version: String)

/** One `expects` entry. */
public data class ContentExpect(val pack: String, val required: Boolean, val delivery: String)

/** An app's `content` (plans/P4-01.md §2.4): what the running build pins and expects. */
public data class AppContent(val contentApi: Long, val pins: List<ContentPin>, val expects: List<ContentExpect>) {
    public val json: JsonObject
        get() = buildJsonObject {
            put("contentApi", jsonInt(contentApi))
            put("pins", JsonArray(pins.map { p ->
                buildJsonObject {
                    put("pack", JsonPrimitive(p.pack))
                    put("release", ReleasePin(p.sha256, p.seq, p.version).json)
                }
            }))
            put("expects", JsonArray(expects.map { e ->
                buildJsonObject {
                    put("pack", JsonPrimitive(e.pack))
                    put("required", JsonPrimitive(e.required))
                    put("delivery", JsonPrimitive(e.delivery))
                }
            }))
        }

    /** The decision's view of a parsed content stamp, with its holds (null when unusable). */
    public fun stamp(holds: List<ContentHold>?): UpdateContentStamp = UpdateContentStamp(
        contentApi,
        pins.map { PackTarget(it.pack, ReleasePin(it.sha256, it.seq, it.version)) },
        expects.map { ContentExpectation(it.pack, it.required, it.delivery) },
        holds,
    )

    public companion object {
        /** The view of a value that passed `contentClaims`. */
        public fun from(json: JsonElement?): AppContent? {
            val o = json.objectValue ?: return null
            val api = o["contentApi"].longValue ?: return null
            val pins = (o["pins"].arrayValue ?: return null).map { p ->
                val po = p.objectValue ?: return null
                val r = po["release"].objectValue ?: return null
                ContentPin(
                    po["pack"].stringValue ?: return null, r["sha256"].stringValue ?: return null,
                    r["seq"].longValue ?: return null, r["version"].stringValue ?: return null,
                )
            }
            val expects = (o["expects"].arrayValue ?: return null).map { e ->
                val eo = e.objectValue ?: return null
                ContentExpect(eo["pack"].stringValue ?: return null, eo["required"].boolValue ?: return null, eo["delivery"].stringValue ?: return null)
            }
            return AppContent(api, pins, expects)
        }
    }
}

// ── JSON helpers ──────────────────────────────────────────────────────────────────────────────

/** A strictly parsed object (V4 §1.2) with its non-wire-integer pointers. */
public class StrictValue(public val value: JsonObject, public val nonWire: NonWireIntegers)

/**
 * V4 §1.2's strict JSON over UTF-8 bytes (no BOM, duplicate members refused, an object at the top),
 * with the integer rule's pointers; null on any failure.
 */
public fun strictParse(bytes: ByteArray): StrictValue? = StrictJson.validate(bytes)?.let { StrictValue(it.value, it.nonWireIntegers) }

/** Canonical JSON text of a value (object keys sorted by UTF-16 code units, which is byte order for ASCII). */
public fun canonicalJson(value: JsonElement): String = sortKeys(value).toString()

private fun sortKeys(v: JsonElement): JsonElement = when (v) {
    is JsonObject -> JsonObject(v.keys.sorted().associateWith { sortKeys(v.getValue(it)) })
    is JsonArray -> JsonArray(v.map { sortKeys(it) })
    else -> v
}

/** A JSON value from text, or null. */
public fun parseJson(text: String): JsonElement? = JsonText.parseOrNull(text)
