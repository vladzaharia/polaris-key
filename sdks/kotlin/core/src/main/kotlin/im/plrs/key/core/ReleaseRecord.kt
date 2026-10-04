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
// the update and pack engines (P6-08) verify records, and service modules never depend on one
// another. P6-08 added the delegated path of plans/P4-19.md §2.3 (a `pkd1-` kid verified through
// one delegation from the pinned release keys, step 16's scope; `delegationCases`): it is taken
// only when the caller passes the delegation's compact JWS, so a release-key-only caller (the
// release service) still refuses any other kid at step `jws`.

package im.plrs.key.core

import java.security.MessageDigest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

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
    /**
     * The compact JWS of the delegation a `pkd1-` kid names (plans/P4-19.md §2.3), fetched by the
     * caller by [delegationHashOf]. Only the surfaces of §2.4 pass it. Null: no delegated path.
     */
    val delegation: String? = null,
)

/** Why [verifyReleaseRecord] refused, by client step (`releaseRecordCases` `expect.step`). */
public enum class ReleaseRecordStep(public val wire: String) {
    hash("hash"),
    jws("jws"),
    claims("claims"),
    crossCheck("cross-check"),
    /** The delegated path: the delegation did not verify, or its key is a release or product key. */
    delegation("delegation"),
    /** The delegated path: the record is outside the delegation's scope (step 16). */
    scope("scope"),
}

/** The delegation a delegated record verified through (plans/P4-19.md §2.3). */
public data class RecordDelegation(
    /** The delegation's record hash (the kid's hex). */
    val sha256: String,
    /** The scope root, a pack id. */
    val deliverable: String,
    /** The effective types (`types ∩ DELEGABLE_PACK_TYPES`), in the delegation's order. */
    val types: List<String>,
    val issuedAt: Long,
    val expiresAt: Long,
) {
    /** `{sha256, deliverable, types, issuedAt, expiresAt}` (`delegationCases`' `expect.delegation`). */
    public val json: JsonObject
        get() = buildJsonObject {
            put("sha256", JsonPrimitive(sha256))
            put("deliverable", JsonPrimitive(deliverable))
            put("types", JsonArray(types.map { JsonPrimitive(it) }))
            put("issuedAt", jsonInt(issuedAt))
            put("expiresAt", jsonInt(expiresAt))
        }
}

public sealed interface VerifyReleaseRecordResult {
    public data class Ok(val record: ReleaseRecordDoc) : VerifyReleaseRecordResult

    /** A record a delegated content key signed, with the delegation it verified through. */
    public data class Delegated(val record: ReleaseRecordDoc, val delegation: RecordDelegation) : VerifyReleaseRecordResult
    public data class Refused(val step: ReleaseRecordStep) : VerifyReleaseRecordResult
}

/** The verified record (a release key's or a delegated one), or null when refused. */
public val VerifyReleaseRecordResult.record: ReleaseRecordDoc?
    get() = when (this) {
        is VerifyReleaseRecordResult.Ok -> record
        is VerifyReleaseRecordResult.Delegated -> record
        is VerifyReleaseRecordResult.Refused -> null
    }

/** The delegation a content key's record verified through; null for a release key's. */
public val VerifyReleaseRecordResult.delegation: RecordDelegation?
    get() = (this as? VerifyReleaseRecordResult.Delegated)?.delegation

/** The refusing step, or null. */
public val VerifyReleaseRecordResult.step: ReleaseRecordStep?
    get() = (this as? VerifyReleaseRecordResult.Refused)?.step

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

    // 13. The pinned release keys only, and never a product key; or one delegation from them.
    val kid = headerKid(jws) ?: return VerifyReleaseRecordResult.Refused(ReleaseRecordStep.jws)
    val key: String
    var verified: VerifiedDelegation? = null
    val releaseKey = options.releaseKeys[kid]
    if (releaseKey != null) {
        val raw = Base64Url.decode(releaseKey)
        if (raw == null || raw.size != 32 || inTrust(raw, options.productTrust)) {
            return VerifyReleaseRecordResult.Refused(ReleaseRecordStep.jws)
        }
        key = releaseKey
    } else {
        val delegationJws = options.delegation ?: return VerifyReleaseRecordResult.Refused(ReleaseRecordStep.jws)
        val hash = delegationHashOf(jws) ?: return VerifyReleaseRecordResult.Refused(ReleaseRecordStep.jws)
        val d = (
            verifyDelegation(
                delegationJws,
                VerifyDelegationOptions(options.releaseKeys, options.productTrust, options.expectedAud, hash),
            ) as? VerifyDelegationResult.Ok
            )?.delegation ?: return VerifyReleaseRecordResult.Refused(ReleaseRecordStep.delegation)
        val raw = Base64Url.decode(d.publicKey) ?: return VerifyReleaseRecordResult.Refused(ReleaseRecordStep.delegation)
        if (inTrust(raw, options.releaseKeys) || inTrust(raw, options.productTrust)) {
            return VerifyReleaseRecordResult.Refused(ReleaseRecordStep.delegation)
        }
        verified = d
        key = d.publicKey
    }
    val verifiedJws = JwsVerifier.verify(jws, mapOf(kid to key), JwsTyp.release, requireTyp = true)
        ?: return VerifyReleaseRecordResult.Refused(ReleaseRecordStep.jws)

    // 14. The claims.
    if (!releaseRecordClaims(verifiedJws.payload, options.expectedAud, verifiedJws.nonWireIntegers)) {
        return VerifyReleaseRecordResult.Refused(ReleaseRecordStep.claims)
    }
    val record = ReleaseRecordDoc.from(verifiedJws.payload, verifiedJws.nonWireIntegers)
        ?: return VerifyReleaseRecordResult.Refused(ReleaseRecordStep.claims)

    // 15. The cross-check against the pin.
    options.pin?.let { pin ->
        if (record.kind != pin.kind || record.deliverable != pin.deliverable || record.version != pin.version || record.seq != pin.seq) {
            return VerifyReleaseRecordResult.Refused(ReleaseRecordStep.crossCheck)
        }
    }

    // 16. The delegation's scope.
    val d = verified ?: return VerifyReleaseRecordResult.Ok(record)
    if (!inScope(record, d)) return VerifyReleaseRecordResult.Refused(ReleaseRecordStep.scope)
    return VerifyReleaseRecordResult.Delegated(record, RecordDelegation(d.sha256, d.deliverable, d.types, d.issuedAt, d.expiresAt))
}

/** Step 16 (plans/P4-19.md §2.3) over a record whose claims passed. */
private fun inScope(record: ReleaseRecordDoc, d: VerifiedDelegation): Boolean {
    val o = record.json
    if (record.kind != "pack") return false
    if (!coversPack(d.deliverable, record.deliverable)) return false
    val type = o["type"].stringValue ?: return false
    if (type !in d.types) return false
    val variants = o["variants"].arrayValue ?: return false
    for (v in variants) {
        if (v.objectValue?.get("files").objectValue?.get("layout").stringValue != "tree") return false
    }
    return d.issuedAt <= record.issuedAt && record.issuedAt <= d.expiresAt
}

/**
 * Whether pack id [pack] is the scope root [root] or under it by whole segments (plans/P4-19.md
 * §2.3 step 16): `djdl.events` covers `djdl.events.halloween`, never `djdl.eventsx`.
 */
public fun coversPack(root: String, pack: String): Boolean = pack == root || pack.startsWith("$root.")

/** One record that survived the reload path. */
public data class CommittedRecord(val jws: String, val record: ReleaseRecordDoc)

/**
 * The reload path for the `releaseRecords` slice (plans/P3-01.md §2.5): each `records[h]` goes
 * through steps 12–14 with `h` as the pin, and is kept only when [pinned] holds `h`. Never throws.
 */
public fun reloadReleaseRecords(
    cached: Map<String, String>,
    releaseKeys: TrustSet,
    productTrust: TrustSet,
    expectedAud: String,
    pinned: Set<String>,
): Map<String, CommittedRecord> {
    val out = LinkedHashMap<String, CommittedRecord>()
    for ((h, jws) in cached) {
        if (h !in pinned) continue
        val r = verifyReleaseRecord(jws, VerifyReleaseRecordOptions(releaseKeys, productTrust, expectedAud, h))
        r.record?.let { out[h] = CommittedRecord(jws, it) }
    }
    return out
}

// ── P4-19: content-key delegation (plans/P4-19.md §2.2–§2.6, WIRE-CONTRACT-V4 §2.5.4) ──────────

/** `DELEGATED_KID_PATTERN` (`@polaris-key/protocol/release`), restated: `pkd1-` and the delegation's hash. */
public const val DELEGATED_KID_PATTERN: String = "pkd1-[0-9a-f]{64}"

/** 32 raw bytes in strict base64url (V4 §1): 43 characters, no padding, zero trailing bits. */
private const val KEY_B64URL_PATTERN = "[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]"

/** The delegation hash a delegated record's header names: the hex of a `pkd1-<sha256>` kid, else null. */
public fun delegationHashOf(jws: String): String? {
    val kid = headerKid(jws) ?: return null
    if (!packMatch(DELEGATED_KID_PATTERN, kid)) return null
    return kid.substring(5)
}

/** The delegated kid of a delegation record hash: `pkd1-<sha256>`. */
public fun delegatedKid(delegationSha256: String): String = "pkd1-$delegationSha256"

/** A usable delegation body, as [delegationOf] reads it. */
public data class DelegationBody(
    /** The scope root, a pack id. */
    val deliverable: String,
    val seq: Long,
    /** The content key: base64url of its 32 raw Ed25519 bytes. */
    val publicKey: String,
    /** The effective types: `types ∩ DELEGABLE_PACK_TYPES`, in the record's order (never empty). */
    val types: List<String>,
    /** The record's `types` as listed. */
    val listedTypes: List<String>,
    val issuedAt: Long,
    val expiresAt: Long,
)

/**
 * The delegation body (plans/P4-19.md §2.2), read beside the claims: usable when `kind` is
 * `delegation`, `deliverable` is a pack id, `delegate.publicKey` is strict base64url of 32 bytes,
 * `types` is 1–`MAX_DELEGATION_TYPES` unique pack types meeting `DELEGABLE_PACK_TYPES`, and
 * `issuedAt < expiresAt ≤ issuedAt + MAX_DELEGATION_TTL_SECONDS` (integers by token).
 */
public fun delegationOf(doc: JsonElement?, nonWire: NonWireIntegers = NonWireIntegers()): DelegationBody? {
    val o = doc.objectValue ?: return null
    if (o["kind"].stringValue != "delegation") return null
    val deliverable = o["deliverable"].stringValue ?: return null
    if (!isPackId(deliverable)) return null
    val delegate = o["delegate"].objectValue ?: return null
    val publicKey = delegate["publicKey"].stringValue ?: return null
    if (!packMatch(KEY_B64URL_PATTERN, publicKey)) return null
    val types = o["types"].arrayValue ?: return null
    if (types.isEmpty() || types.size > MAX_DELEGATION_TYPES) return null
    val listed = ArrayList<String>()
    val seen = HashSet<String>()
    for (t in types) {
        val s = t.stringValue ?: return null
        if (!packMatch(PackPatterns.packType, s) || !seen.add(s)) return null
        listed += s
    }
    val effective = listed.filter { it in DELEGABLE_PACK_TYPE_VALUES }
    if (effective.isEmpty()) return null
    val expiresAt = o["expiresAt"].longValue
    val issuedAt = o["issuedAt"].longValue
    val seq = o["seq"].longValue
    if (!wireInteger(expiresAt, "/expiresAt", 1, nonWire) || !wireInteger(issuedAt, "/issuedAt", 0, nonWire) ||
        !wireInteger(seq, "/seq", 1, nonWire)
    ) {
        return null
    }
    if (issuedAt!! >= expiresAt!! || expiresAt > issuedAt + MAX_DELEGATION_TTL_SECONDS) return null
    return DelegationBody(deliverable, seq!!, publicKey, effective, listed, issuedAt, expiresAt)
}

/** A verified delegation: its body and its record hash. */
public data class VerifiedDelegation(val body: DelegationBody, val sha256: String) {
    val deliverable: String get() = body.deliverable
    val seq: Long get() = body.seq
    val publicKey: String get() = body.publicKey
    val types: List<String> get() = body.types
    val issuedAt: Long get() = body.issuedAt
    val expiresAt: Long get() = body.expiresAt
}

public data class VerifyDelegationOptions(
    /** The PINNED release keys only: never the Worker's trust set, never a delegated key. */
    val releaseKeys: TrustSet,
    /** The effective product trust set: a release key whose bytes are in it is refused. */
    val productTrust: TrustSet,
    val expectedAud: String,
    /** The delegation's hash: the delegated record's kid hex, or a feed entry's target. */
    val expectedHash: String,
)

public sealed interface VerifyDelegationResult {
    public data class Ok(val delegation: VerifiedDelegation) : VerifyDelegationResult

    /** A [verifyReleaseRecord] step, or `delegation`. */
    public data class Refused(val step: ReleaseRecordStep) : VerifyDelegationResult
}

/**
 * Verify a delegation record (plans/P4-19.md §2.3 step 13.1): steps 12–14 against the pinned release
 * keys only, then `kind == "delegation"` and [delegationOf]. A delegation is never verified through
 * another delegation, so a content key cannot re-delegate.
 */
public fun verifyDelegation(jws: String, options: VerifyDelegationOptions): VerifyDelegationResult {
    val r = verifyReleaseRecord(
        jws,
        VerifyReleaseRecordOptions(options.releaseKeys, options.productTrust, options.expectedAud, options.expectedHash),
    )
    val record = r.record ?: return VerifyDelegationResult.Refused(r.step ?: ReleaseRecordStep.jws)
    if (record.kind != "delegation") return VerifyDelegationResult.Refused(ReleaseRecordStep.delegation)
    val body = delegationOf(record.json, record.nonWireIntegers) ?: return VerifyDelegationResult.Refused(ReleaseRecordStep.delegation)
    return VerifyDelegationResult.Ok(VerifiedDelegation(body, options.expectedHash))
}

/** What revoked a release (plans/P4-19.md §2.3). */
public enum class RecordRevokedBy(public val wire: String) { record("record"), delegation("delegation") }

/**
 * The one rule for applying revocations to a release: `record` when the release's own hash is
 * revoked, else `delegation` when the delegation it was signed under is, else null.
 */
public fun recordRevoked(recordSha256: String, delegationSha256: String?, revoked: Set<String>): RecordRevokedBy? {
    if (recordSha256 in revoked) return RecordRevokedBy.record
    if (delegationSha256 != null && delegationSha256 in revoked) return RecordRevokedBy.delegation
    return null
}

/** A delegated release the engine knows (plans/P4-19.md §2.7): its pack and its delegation's hash. */
public data class DelegatedRelease(val pack: String, val delegation: String)
