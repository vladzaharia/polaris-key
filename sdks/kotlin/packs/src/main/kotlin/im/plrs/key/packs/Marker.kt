// The marker, `pkey-marker/1` (plans/P4-01.md §2.6, §2.8; WIRE-CONTRACT-V4 §3.7): the compact pack
// record beside an embedded single-file payload (`X.pkey.json`) or inside an embedded tree
// (`D/.pkey/pack.json`). `cases.json#markerCases` pins `verifyMarker`; the byte match against the
// embedded payload and the content stamp's pin is the host's (`matchEmbedded`). client-core
// `packs/marker.ts` is the reference; Swift's `Marker.swift` the structural model.

package im.plrs.key.packs

import im.plrs.key.core.MARKER_FORMAT
import im.plrs.key.core.MAX_RECORD_JWS_BYTES
import im.plrs.key.core.PackPatterns
import im.plrs.key.core.TrustSet
import im.plrs.key.core.VerifyReleaseRecordOptions
import im.plrs.key.core.VerifyReleaseRecordResult
import im.plrs.key.core.isPackId
import im.plrs.key.core.packMatch
import im.plrs.key.core.recordHash
import im.plrs.key.core.stringValue
import im.plrs.key.core.verifyReleaseRecord

/** What [verifyMarker] reports. */
public sealed interface VerifyMarkerResult {
    public data class Ok(val packId: String, val version: String, val release: String, val record: PackRecordDoc, val recordSha256: String) : VerifyMarkerResult

    /** `marker-rejected` at [step]: `format`, `hash`, `jws`, `claims` or `cross-check`. */
    public data class Rejected(val step: String) : VerifyMarkerResult
}

/**
 * `verifyMarker(marker, …)` (§2.6 "Markers", V4 §3.7), in order: strict JSON (`format`); the marker's
 * members (`format`); steps 12–14 with `release` as the body and its own SHA-256 as the pin hash
 * (`hash`, `jws`, `claims`); `kind == "pack"`, `deliverable == packId`, `version == version`
 * (`cross-check`). Never throws.
 */
public fun verifyMarker(marker: ByteArray, releaseKeys: TrustSet, productTrust: TrustSet, expectedAud: String): VerifyMarkerResult {
    val parsed = strictParse(marker) ?: return VerifyMarkerResult.Rejected("format")
    val m = parsed.value
    if (m["format"].stringValue != MARKER_FORMAT) return VerifyMarkerResult.Rejected("format")
    val packId = m["packId"].stringValue
    if (!isPackId(packId)) return VerifyMarkerResult.Rejected("format")
    val version = m["version"].stringValue ?: return VerifyMarkerResult.Rejected("format")
    if (!packMatch(PackPatterns.version, version)) return VerifyMarkerResult.Rejected("format")
    val release = m["release"].stringValue ?: return VerifyMarkerResult.Rejected("format")
    val bytes = release.toByteArray(Charsets.UTF_8)
    if (bytes.any { it < 0 } || bytes.size > MAX_RECORD_JWS_BYTES) return VerifyMarkerResult.Rejected("hash")
    val recordSha256 = recordHash(release)
    return when (val v = verifyReleaseRecord(release, VerifyReleaseRecordOptions(releaseKeys, productTrust, expectedAud, recordSha256))) {
        is VerifyReleaseRecordResult.Refused -> VerifyMarkerResult.Rejected(v.step.wire)
        // No delegation is passed (an embedded baseline is a release-key surface), so this never occurs.
        is VerifyReleaseRecordResult.Delegated -> VerifyMarkerResult.Rejected("jws")
        is VerifyReleaseRecordResult.Ok -> {
            val record = v.record
            val pack = if (record.kind == "pack" && record.deliverable == packId && record.version == version) PackRecordDoc.from(record.json) else null
            if (pack == null) VerifyMarkerResult.Rejected("cross-check") else VerifyMarkerResult.Ok(packId!!, version, release, pack, recordSha256)
        }
    }
}

public fun verifyMarker(marker: String, releaseKeys: TrustSet, productTrust: TrustSet, expectedAud: String): VerifyMarkerResult =
    verifyMarker(marker.toByteArray(Charsets.UTF_8), releaseKeys, productTrust, expectedAud)

/** What the host measured of the embedded payload: a single file's SHA-256 and size, or a tree's digest. */
public sealed interface EmbeddedPayload {
    public data class File(val sha256: String, val size: Long) : EmbeddedPayload
    public data class Tree(val treeDigest: String) : EmbeddedPayload
}

/** A `marker-rejected` refusal at the host's own steps (`payload`, `pin`). */
public data class MarkerRefusal(val step: String)

/**
 * The host's match of an embedded payload against its verified marker (§2.6): the variant whose
 * `payload` the bytes match, and, when the content stamp pins the pack, `recordSha256` equal to the
 * pin's `sha256`. The variant's index, or the refused step.
 */
public fun matchEmbedded(packId: String, record: PackRecordDoc, recordSha256: String, payload: EmbeddedPayload, stamp: AppContent?): Result<Int> {
    val index = record.variants.indexOfFirst { v ->
        when (payload) {
            is EmbeddedPayload.File -> v.payload.sha256 == payload.sha256 && v.payload.size == payload.size
            is EmbeddedPayload.Tree -> v.files.layout == "tree" && v.payload.sha256 == payload.treeDigest
        }
    }
    if (index < 0) return Result.failure(MarkerException(MarkerRefusal("payload")))
    val pin = stamp?.pins?.firstOrNull { it.pack == packId }
    if (pin != null && pin.sha256 != recordSha256) return Result.failure(MarkerException(MarkerRefusal("pin")))
    return Result.success(index)
}

/** A [MarkerRefusal] carried through a [Result]. */
public class MarkerException(public val refusal: MarkerRefusal) : Exception("marker-rejected at ${refusal.step}")
