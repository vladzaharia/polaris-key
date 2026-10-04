// The device's revocations (plans/P4-13.md §2.5 "Persistence"; client-core `packs/revocations.ts`;
// Swift's `Revocations.swift` the structural model): a sibling document, `revocations.json`, beside
// the pack state and never inside it, so an unparseable `state.json` cannot lose revocations.
//
//   {v: 1, revoked: {[targetSha256]: {jws, pack, version, seq, record, issuedAt}}, relearn: [packId]}
//
// The document is NEVER trusted from storage: `reloadRevocations` re-verifies every entry against the
// currently pinned release keys and the stored pin, and a failing entry is dropped alone. A key that
// is no longer pinned forgets its target (the key-rotation recovery lever); any other failure adds the
// entry's pack to `relearn`, cleared only by a fresh, network-verified feed or `recoverState()`.

package im.plrs.key.packs

import im.plrs.key.core.Base64Url
import im.plrs.key.core.FeedRevocation
import im.plrs.key.core.JsonText
import im.plrs.key.core.MAX_WIRE_INTEGER
import im.plrs.key.core.RankedRevocation
import im.plrs.key.core.RevocationStep
import im.plrs.key.core.TrustSet
import im.plrs.key.core.VerifiedRevocation
import im.plrs.key.core.VerifyRevocationOptions
import im.plrs.key.core.arrayValue
import im.plrs.key.core.compareUtf8Bytes
import im.plrs.key.core.isPackId
import im.plrs.key.core.isSha256Hex
import im.plrs.key.core.jsonInt
import im.plrs.key.core.longValue
import im.plrs.key.core.newerRevocation
import im.plrs.key.core.objectValue
import im.plrs.key.core.revocation
import im.plrs.key.core.step
import im.plrs.key.core.stringValue
import im.plrs.key.core.verifyRevocation
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

public const val REVOCATIONS_VERSION: Int = 1

/** A device keeps at most this many revoked targets; beyond it the oldest is dropped first. */
public const val MAX_STORED_REVOCATIONS: Int = 256

/** One stored revocation: the winner for its target. */
public data class StoredRevocation(
    /** The revocation record's compact JWS, verbatim. */
    val jws: String,
    /** The pin it was verified with: the feed entry's pack, version and `seq`. */
    val pack: String,
    val version: String,
    val seq: Long,
    /** The revocation record's hash. */
    override val record: String,
    override val issuedAt: Long,
) : RankedRevocation {
    public val json: JsonObject
        get() = buildJsonObject {
            put("jws", JsonPrimitive(jws))
            put("pack", JsonPrimitive(pack))
            put("version", JsonPrimitive(version))
            put("seq", jsonInt(seq))
            put("record", JsonPrimitive(record))
            put("issuedAt", jsonInt(issuedAt))
        }
}

public data class RevocationsDoc(
    val revoked: Map<String, StoredRevocation> = emptyMap(),
    /** Packs whose revocations must be re-learned from a fresh feed (sorted). */
    val relearn: List<String> = emptyList(),
    val v: Int = REVOCATIONS_VERSION,
) {
    public val json: JsonObject
        get() = buildJsonObject {
            put("v", jsonInt(v.toLong()))
            put("revoked", JsonObject(revoked.mapValues { it.value.json }))
            put("relearn", JsonArray(relearn.map { JsonPrimitive(it) }))
        }
}

public fun emptyRevocations(): RevocationsDoc = RevocationsDoc()

/** True when the document holds nothing. */
public fun isEmptyRevocations(doc: RevocationsDoc): Boolean = doc.revoked.isEmpty() && doc.relearn.isEmpty()

private fun nat(v: JsonElement?): Long? = v.longValue?.takeIf { it in 0..MAX_WIRE_INTEGER }

private fun sortedPacks(s: Set<String>): List<String> = s.sortedWith { a, b -> compareUtf8Bytes(a, b) }

/**
 * Parse the stored text's shape. Null when it does not parse as the document at all (a torn file).
 * Entries of the wrong shape are dropped with their pack (when readable) added to `relearn`.
 */
public fun parseRevocations(text: String): RevocationsDoc? {
    val doc = parseJson(text).objectValue ?: return null
    if (doc["v"].longValue != REVOCATIONS_VERSION.toLong()) return null
    val revoked = doc["revoked"].objectValue ?: return null
    val relearnList = doc["relearn"].arrayValue ?: return null
    val relearn = HashSet<String>()
    for (p in relearnList) p.stringValue?.takeIf { isPackId(it) }?.let { relearn += it }
    val out = LinkedHashMap<String, StoredRevocation>()
    for ((target, e) in revoked) {
        val o = e.objectValue
        val jws = o?.get("jws").stringValue
        val pack = o?.get("pack").stringValue
        val version = o?.get("version").stringValue
        val seq = nat(o?.get("seq"))
        val record = o?.get("record").stringValue
        val issuedAt = nat(o?.get("issuedAt"))
        if (isSha256Hex(target) && o != null && jws != null && pack != null && isPackId(pack) && version != null &&
            seq != null && seq >= 1 && record != null && isSha256Hex(record) && issuedAt != null
        ) {
            out[target] = StoredRevocation(jws, pack, version, seq, record, issuedAt)
        } else if (pack != null && isPackId(pack)) {
            relearn += pack
        }
    }
    return RevocationsDoc(out, sortedPacks(relearn))
}

public fun serializeRevocations(doc: RevocationsDoc): String = canonicalJson(doc.json)

/** The protected header's `kid`, read without trusting anything else. */
private fun kidOf(jws: String): String? {
    val first = jws.split('.').firstOrNull() ?: return null
    val data = Base64Url.decode(first) ?: return null
    return JsonText.parseOrNull(data.toString(Charsets.UTF_8)).objectValue?.get("kid").stringValue
}

public data class ReloadRevocationsResult(
    val doc: RevocationsDoc,
    /** The verified revocation of every surviving target. */
    val verified: Map<String, VerifiedRevocation>,
    /** Whether re-verification changed the document. */
    val changed: Boolean,
)

/**
 * Re-verify every entry against the currently pinned release keys and its stored pin. A failing entry
 * is dropped alone: a key that is no longer pinned forgets the target; any other failure adds the
 * entry's pack to `relearn`.
 */
public fun reloadRevocations(doc: RevocationsDoc, releaseKeys: TrustSet, productTrust: TrustSet, expectedAud: String): ReloadRevocationsResult {
    val out = LinkedHashMap<String, StoredRevocation>()
    val verified = LinkedHashMap<String, VerifiedRevocation>()
    var changed = false
    val relearn = HashSet(doc.relearn)
    for ((target, e) in doc.revoked) {
        val r = verifyRevocation(e.jws, VerifyRevocationOptions(releaseKeys, productTrust, expectedAud, FeedRevocation(e.record, e.pack, target, e.version, e.seq)))
        val v = r.revocation
        if (v != null) {
            out[target] = e
            verified[target] = v
            continue
        }
        changed = true
        val kid = kidOf(e.jws)
        val rotated = r.step == RevocationStep.jws && kid != null && releaseKeys[kid] == null
        if (!rotated) relearn += e.pack
    }
    return ReloadRevocationsResult(RevocationsDoc(out, sortedPacks(relearn)), verified, changed)
}

/**
 * Store a verified revocation (plans/P4-13.md §2.5 step 11): kept when its target is new, or when
 * [newerRevocation] ranks it above the stored one. Then the cap.
 */
public fun storeRevocation(doc: RevocationsDoc, revocation: VerifiedRevocation, jws: String): Pair<RevocationsDoc, Boolean> {
    val target = revocation.target
    val next = StoredRevocation(jws, revocation.pack, revocation.version, revocation.seq, revocation.record, revocation.issuedAt)
    val prev = doc.revoked[target]
    if (prev != null) {
        if (prev.record == revocation.record) return doc to false
        if (newerRevocation(next, prev) !== next) return doc to false
    }
    return capRevocations(doc.copy(revoked = doc.revoked + (target to next))) to true
}

/** Keep at most [MAX_STORED_REVOCATIONS] targets: the oldest by `issuedAt` (then the lower record hash) goes first. */
public fun capRevocations(doc: RevocationsDoc): RevocationsDoc {
    if (doc.revoked.size <= MAX_STORED_REVOCATIONS) return doc
    val keep = doc.revoked.keys.sortedWith { a, b ->
        val x = doc.revoked.getValue(a)
        val y = doc.revoked.getValue(b)
        if (x.issuedAt != y.issuedAt) y.issuedAt.compareTo(x.issuedAt) else -compareUtf8Bytes(x.record, y.record)
    }.take(MAX_STORED_REVOCATIONS)
    return doc.copy(revoked = keep.associateWith { doc.revoked.getValue(it) })
}

/** Clear `relearn` for the given packs. */
public fun clearRelearn(doc: RevocationsDoc, packs: List<String>): Pair<RevocationsDoc, Boolean> {
    if (packs.isEmpty()) return doc to false
    val drop = packs.toSet()
    val relearn = doc.relearn.filter { it !in drop }
    if (relearn.size == doc.relearn.size) return doc to false
    return doc.copy(relearn = relearn) to true
}
