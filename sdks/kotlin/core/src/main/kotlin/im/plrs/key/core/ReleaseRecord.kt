// The release record — WIRE-CONTRACT-V4 §2.4 and client steps 12–15 (plans/P3-01.md §2.4, §2.5),
// pinned by `cases.json`'s `releaseRecordCases`. A port of Swift's `ReleaseRecord.swift`;
// client-core's `record.ts` is the reference.
//
// `releaseRecordClaims` is step 14; `verifyReleaseRecord` runs steps 12–15 in the contract's order:
// HASH BEFORE SIGNATURE (a body over `MAX_RECORD_JWS_BYTES`, or with a byte outside ASCII, is
// refused without hashing), the key selected from the PINNED release keys only and refused when it
// is also a product key, the signature, the claims, then the cross-check against the feed's pin.
// Nothing here does I/O or throws.
//
// It lives in :core (as in Swift) because both the release service (`release.record`, P6-07) and
// the update engine (P6-08) verify records, and service modules never depend on one another. The
// delegated path of plans/P4-19.md (a `pkd1-` kid, `delegationCases`) is the pack engine's and is
// added by P6-08; a record whose kid is not a pinned release key is refused at step `jws` here.

package im.plrs.key.core

import java.security.MessageDigest
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** P2-04's `BUILD_ID_RE`: ASCII, so build-id uniqueness compares bytes. */
public const val BUILD_ID_PATTERN: String = "[a-z0-9][a-z0-9._-]{0,63}"
private const val RECORD_SHA256_PATTERN = "[0-9a-f]{64}"
private const val MAX_BUILDS = 64
private const val MAX_ARTIFACTS = 32

public data class ReleaseRecordArtifact(
    val name: String,
    /** v4 reads only `payload`. */
    val role: String,
    val sha256: String,
    val size: Long,
    val contentType: String? = null,
)

public data class ReleaseRecordBuild(
    val id: String,
    val platform: String,
    val arch: String,
    val format: String,
    val buildNumber: String? = null,
    val minOS: String? = null,
    /** Absent or any object: §2.8 reads `engine` and `minBinary`. */
    val requires: JsonObject? = null,
    /** Empty for a store-only build. */
    val artifacts: List<ReleaseRecordArtifact>,
)

public data class ReleaseRecordProvenance(val commit: String? = null, val workflowRun: String? = null)

/** A verified `pkey-release+jws` payload (WIRE-CONTRACT-V4 §2.4). */
public class ReleaseRecordDoc(
    public val schemaVersion: Long,
    public val aud: String,
    public val deliverable: String,
    public val kind: String,
    public val version: String,
    public val seq: Long,
    public val issuedAt: Long,
    public val minSupportedSeq: Long? = null,
    public val tag: String? = null,
    public val channel: String? = null,
    public val title: String? = null,
    public val notes: String? = null,
    public val provenance: ReleaseRecordProvenance? = null,
    /** Present for `kind: app`. */
    public val builds: List<ReleaseRecordBuild>? = null,
    /** The payload as decoded, reserved members (`content`, …) included. */
    public val json: JsonObject,
    /** The verified payload's non-wire integer pointers (V4 §3.1). Equality ignores them. */
    public val nonWireIntegers: NonWireIntegers = NonWireIntegers(),
) {
    override fun equals(other: Any?): Boolean = other is ReleaseRecordDoc && jsonEquals(json, other.json)

    override fun hashCode(): Int = json.hashCode()

    override fun toString(): String = "ReleaseRecordDoc(kind=$kind, deliverable=$deliverable, version=$version, seq=$seq)"

    public companion object {
        /** The typed view of a record object, or null when a member is missing or mistyped (SHAPE only). */
        public fun from(o: JsonObject, nonWireIntegers: NonWireIntegers = NonWireIntegers()): ReleaseRecordDoc? {
            var builds: List<ReleaseRecordBuild>? = null
            if (o.containsKey("builds")) {
                val list = o["builds"].arrayValue ?: return null
                builds = list.map { b ->
                    val bo = b.objectValue ?: return null
                    val artifacts = (bo["artifacts"].arrayValue ?: return null).map { a ->
                        val ao = a.objectValue ?: return null
                        ReleaseRecordArtifact(
                            name = ao["name"].stringValue ?: return null,
                            role = ao["role"].stringValue ?: return null,
                            sha256 = ao["sha256"].stringValue ?: return null,
                            size = ao["size"].longValue ?: return null,
                            contentType = ao["contentType"].stringValue,
                        )
                    }
                    ReleaseRecordBuild(
                        id = bo["id"].stringValue ?: return null,
                        platform = bo["platform"].stringValue ?: return null,
                        arch = bo["arch"].stringValue ?: return null,
                        format = bo["format"].stringValue ?: return null,
                        buildNumber = bo["buildNumber"].stringValue,
                        minOS = bo["minOS"].stringValue,
                        requires = bo["requires"].objectValue,
                        artifacts = artifacts,
                    )
                }
            }
            val provenance = o["provenance"].objectValue?.let {
                ReleaseRecordProvenance(it["commit"].stringValue, it["workflowRun"].stringValue)
            }
            return ReleaseRecordDoc(
                schemaVersion = o["schemaVersion"].longValue ?: return null,
                aud = o["aud"].stringValue ?: return null,
                deliverable = o["deliverable"].stringValue ?: return null,
                kind = o["kind"].stringValue ?: return null,
                version = o["version"].stringValue ?: return null,
                seq = o["seq"].longValue ?: return null,
                issuedAt = o["issuedAt"].longValue ?: return null,
                minSupportedSeq = o["minSupportedSeq"].longValue,
                tag = o["tag"].stringValue,
                channel = o["channel"].stringValue,
                title = o["title"].stringValue,
                notes = o["notes"].stringValue,
                provenance = provenance,
                builds = builds,
                json = o,
                nonWireIntegers = nonWireIntegers,
            )
        }
    }
}

// ── Step 14: the claims ──────────────────────────────────────────────────────────────────────

private fun nonEmptyString(v: JsonElement?): Boolean = !v.stringValue.isNullOrEmpty()

/** An optional string member: absent, or a string (a present `null` is refused). */
private fun optionalString(o: JsonObject, key: String): Boolean = !o.containsKey(key) || o[key].stringValue != null

private fun recordClaimsHold(doc: JsonObject, expectedAud: String, nonWire: NonWireIntegers): Boolean {
    fun int(v: JsonElement?, pointer: String, min: Long) = wireInteger(v.longValue, pointer, min, nonWire)

    if (!int(doc["schemaVersion"], "/schemaVersion", 1) || doc["schemaVersion"].longValue != 1L) return false
    if (doc["aud"].stringValue != expectedAud) return false
    val deliverable = doc["deliverable"].stringValue ?: return false
    if (deliverable.toByteArray(Charsets.UTF_8).size > 64 || !packMatch(PackPatterns.deliverable, deliverable)) return false
    if (!nonEmptyString(doc["kind"])) return false
    val version = doc["version"].stringValue ?: return false
    if (!packMatch(PackPatterns.version, version)) return false
    if (!int(doc["seq"], "/seq", 1) || !int(doc["issuedAt"], "/issuedAt", 0)) return false
    if (doc.containsKey("minSupportedSeq") && !int(doc["minSupportedSeq"], "/minSupportedSeq", 1)) return false
    for (key in listOf("tag", "channel", "title", "notes")) if (!optionalString(doc, key)) return false
    if (doc.containsKey("provenance")) {
        val p = doc["provenance"].objectValue ?: return false
        if (!optionalString(p, "commit") || !optionalString(p, "workflowRun")) return false
    }

    // plans/P4-01.md §2.2: §2.3 applies to `kind: pack` and §2.4 to `kind: app`; any other kind
    // keeps the common claims only.
    val kind = doc["kind"].stringValue
    if (kind == "pack") return packRecordClaims(doc, nonWire)
    if (kind == "app" && doc.containsKey("content") && !contentClaims(doc["content"], nonWire, "/content")) return false

    if (!doc.containsKey("builds")) return kind != "app"
    val builds = doc["builds"].arrayValue ?: return false
    if (builds.isEmpty() || builds.size > MAX_BUILDS) return false
    val ids = HashSet<String>()
    for ((i, rawBuild) in builds.withIndex()) {
        val build = rawBuild.objectValue ?: return false
        val id = build["id"].stringValue ?: return false
        if (!packMatch(BUILD_ID_PATTERN, id) || !ids.add(id)) return false
        if (!nonEmptyString(build["platform"]) || !nonEmptyString(build["arch"]) || !nonEmptyString(build["format"])) return false
        if (!optionalString(build, "buildNumber") || !optionalString(build, "minOS")) return false
        if (build.containsKey("requires") && build["requires"].objectValue == null) return false
        val artifacts = build["artifacts"].arrayValue ?: return false
        if (artifacts.size > MAX_ARTIFACTS) return false
        var payloads = 0
        for ((j, rawArtifact) in artifacts.withIndex()) {
            val artifact = rawArtifact.objectValue ?: return false
            if (!nonEmptyString(artifact["name"]) || !nonEmptyString(artifact["role"])) return false
            if (artifact["role"].stringValue == "payload") payloads++
            val sha = artifact["sha256"].stringValue ?: return false
            if (!packMatch(RECORD_SHA256_PATTERN, sha)) return false
            if (!int(artifact["size"], "/builds/$i/artifacts/$j/size", 0)) return false
            if (!optionalString(artifact, "contentType")) return false
        }
        if (payloads > 1) return false
        if (kind == "app" && build.containsKey("embeds") && !embedsClaims(build["embeds"]!!)) return false
    }
    return true
}

/**
 * Client step 14 over a verified record payload: true when every claim of §2.4 holds. A caller
 * holding a verified JWS passes its non-wire integers; a caller checking a value it built passes
 * none.
 */
public fun releaseRecordClaims(payload: JsonElement?, expectedAud: String, nonWire: NonWireIntegers = NonWireIntegers()): Boolean {
    val doc = payload.objectValue ?: return false
    return recordClaimsHold(doc, expectedAud, nonWire)
}

// ── Steps 12–15 ──────────────────────────────────────────────────────────────────────────────

/** The record hash (V4 §8): lowercase hex SHA-256 of the compact JWS's bytes, exactly as received. */
public fun recordHash(jws: String): String =
    MessageDigest.getInstance("SHA-256").digest(jws.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it.toInt() and 0xff) }

/** What a target pins, for the cross-check (step 15). */
public data class ReleaseRecordPin(
    /** `app` for a feed target, `pack` for a content pin (plans/P4-01.md §2.6). */
    val kind: String = "app",
    val deliverable: String = "app",
    val version: String,
    val seq: Long,
)

public data class VerifyReleaseRecordOptions(
    /** The PINNED release keys: the only keys a record verifies against (step 13). */
    val releaseKeys: TrustSet,
    /** The EFFECTIVE product trust set; a release key whose bytes are also in it is refused. */
    val productTrust: TrustSet,
    val expectedAud: String,
    /** The feed's pin, `targets[].release.sha256`: the lowercase hex SHA-256 the body must have. */
    val expectedHash: String,
    /** The pin to cross-check against (step 15). Null verifies only. */
    val pin: ReleaseRecordPin? = null,
)

/** Why [verifyReleaseRecord] refused, by client step (`releaseRecordCases` `expect.step`). */
public enum class ReleaseRecordStep(public val wire: String) {
    hash("hash"),
    jws("jws"),
    claims("claims"),
    crossCheck("cross-check"),
}

public sealed interface VerifyReleaseRecordResult {
    public data class Ok(val record: ReleaseRecordDoc) : VerifyReleaseRecordResult
    public data class Refused(val step: ReleaseRecordStep) : VerifyReleaseRecordResult
}

/** The verified record, or null when refused. */
public val VerifyReleaseRecordResult.record: ReleaseRecordDoc?
    get() = (this as? VerifyReleaseRecordResult.Ok)?.record

/** The protected header's `kid`, read without trusting anything else in it. */
private fun headerKid(jws: String): String? {
    val first = jws.split('.').firstOrNull() ?: return null
    val bytes = Base64Url.decodeStrict(first) ?: return null
    return JsonText.parseOrNull(bytes.toString(Charsets.UTF_8)).objectValue?.get("kid").stringValue
}

private fun inTrust(raw: ByteArray, set: TrustSet): Boolean = set.values.any { k -> Base64Url.decode(k)?.contentEquals(raw) == true }

/**
 * Client steps 12–15, in the contract's order:
 *
 *  12. a body over `MAX_RECORD_JWS_BYTES` or with a byte outside ASCII is refused without hashing;
 *      otherwise its SHA-256 must equal `expectedHash`, before any Ed25519 work;
 *  13. the key is selected by `kid` from `releaseKeys` only, refused if its raw bytes are also in
 *      `productTrust`, then verified with that one key and `typ` `pkey-release+jws`;
 *  14. the claims ([releaseRecordClaims]);
 *  15. with a `pin`: `kind`, `deliverable`, `version` and `seq` equal the pin's.
 *
 * Never throws.
 */
public fun verifyReleaseRecord(jws: String, options: VerifyReleaseRecordOptions): VerifyReleaseRecordResult {
    // 12. Hash before signature.
    val bytes = jws.toByteArray(Charsets.UTF_8)
    if (bytes.size > MAX_RECORD_JWS_BYTES || bytes.any { it < 0 }) return VerifyReleaseRecordResult.Refused(ReleaseRecordStep.hash)
    if (recordHash(jws) != options.expectedHash) return VerifyReleaseRecordResult.Refused(ReleaseRecordStep.hash)

    // 13. The pinned release keys only, and never a product key.
    val kid = headerKid(jws) ?: return VerifyReleaseRecordResult.Refused(ReleaseRecordStep.jws)
    val releaseKey = options.releaseKeys[kid] ?: return VerifyReleaseRecordResult.Refused(ReleaseRecordStep.jws)
    val raw = Base64Url.decode(releaseKey)
    if (raw == null || raw.size != 32 || inTrust(raw, options.productTrust)) {
        return VerifyReleaseRecordResult.Refused(ReleaseRecordStep.jws)
    }
    val verified = JwsVerifier.verify(jws, mapOf(kid to releaseKey), JwsTyp.release, requireTyp = true)
        ?: return VerifyReleaseRecordResult.Refused(ReleaseRecordStep.jws)

    // 14. The claims.
    if (!releaseRecordClaims(verified.payload, options.expectedAud, verified.nonWireIntegers)) {
        return VerifyReleaseRecordResult.Refused(ReleaseRecordStep.claims)
    }
    val record = ReleaseRecordDoc.from(verified.payload, verified.nonWireIntegers)
        ?: return VerifyReleaseRecordResult.Refused(ReleaseRecordStep.claims)

    // 15. The cross-check against the pin.
    options.pin?.let { pin ->
        if (record.kind != pin.kind || record.deliverable != pin.deliverable || record.version != pin.version || record.seq != pin.seq) {
            return VerifyReleaseRecordResult.Refused(ReleaseRecordStep.crossCheck)
        }
    }
    return VerifyReleaseRecordResult.Ok(record)
}
