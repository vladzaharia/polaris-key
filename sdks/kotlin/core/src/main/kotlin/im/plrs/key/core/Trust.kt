// The trust set — WIRE-CONTRACT-V4 §1 and §2.3, pinned by the corpus's `trustCases`.
//
//   pinned      compiled into the host application. Terminal unless TOMBSTONED: a verified manifest
//               signed by another usable pin that lists a pin's exact bytes as `revoked` removes it
//               from the usable pins, permanently, on this install.
//   discovered  learned from a trust manifest a USABLE pin signed, replaced wholesale on every
//               accepted manifest, so absence is revocation.
//
// The on-disk cache is not a tier: it keeps the manifest's compact JWS, so the keys it yields are
// exactly the keys a pinned key vouched for. A tombstone is kept the same way, as SIGNED EVIDENCE
// (the revoking manifest, verbatim, in the cache's `pinRevocations` slice), re-verified on every
// load by [loadPinRevocations].

package im.plrs.key.core

/** Ascending byte order of the UTF-8 encodings: the order every SDK can reproduce exactly. */
internal val KID_BYTE_ORDER: Comparator<String> = Comparator { a, b ->
    val x = a.toByteArray(Charsets.UTF_8)
    val y = b.toByteArray(Charsets.UTF_8)
    val n = minOf(x.size, y.size)
    for (i in 0 until n) if (x[i] != y[i]) return@Comparator (x[i].toInt() and 0xff) - (y[i].toInt() and 0xff)
    x.size - y.size
}

/** The statuses that keep a manifest key: an exact, case-sensitive allow-list (§1). */
private val LIVE_STATUSES = setOf("active", "staged", "retired")

/** The outcome of verifying a trust manifest; `doc == null` means refused (keep the old set). */
public data class TrustManifestResult(
    val doc: TrustManifestDoc?,
    val discovered: TrustSet,
    /** The pinned kids this manifest NEWLY tombstones, ascending byte order; empty when refused. */
    val revokedPins: List<String> = emptyList(),
)

public data class VerifyTrustManifestOptions(
    /** The ONLY keys a manifest may be signed by. */
    val pinned: TrustSet,
    /** Pinned kids already tombstoned on this install: a manifest one of them signed is refused. */
    val tombstones: Collection<String> = emptyList(),
    val expectedAud: String,
    val expectedIss: String = POLARIS_ISSUER,
    val now: Long? = null,
    val clockSkewSeconds: Long = CLOCK_SKEW_SECONDS,
    /** Anti-rollback, from the manifest last verified (R4-03). */
    val lastTrustIssuedAt: Long? = null,
    /** False on the reload path and on bundle import (§7.3). */
    val checkFreshness: Boolean = true,
)

/** Verify a compact trust manifest and compute the keys it publishes. Never throws. */
public fun verifyTrustManifest(jws: String, options: VerifyTrustManifestOptions): TrustManifestResult {
    val rejected = TrustManifestResult(null, emptyMap())
    val dead = options.tombstones.toSet()
    val verified = JwsVerifier.verify(jws, usablePins(options.pinned, dead), JwsTyp.trust, requireTyp = true) ?: return rejected
    val doc = TrustManifestDoc.from(verified.payload) ?: return rejected
    val nonWire = verified.nonWireIntegers
    if (!wireInteger(doc.schemaVersion, "/schemaVersion", 1, nonWire)) return rejected
    if (!wireInteger(doc.issuedAt, "/issuedAt", 0, nonWire)) return rejected
    if (!wireInteger(doc.expiresAt, "/expiresAt", 0, nonWire)) return rejected

    val now = options.now ?: (System.currentTimeMillis() / 1000)
    val skew = options.clockSkewSeconds
    if (doc.schemaVersion !in SUPPORTED_TRUST_SCHEMA_VERSIONS) return rejected
    if (doc.aud != options.expectedAud || doc.iss != options.expectedIss) return rejected
    val last = options.lastTrustIssuedAt
    if (last != null && doc.issuedAt <= last) return rejected
    if (options.checkFreshness) {
        if (doc.issuedAt > saturatingAdd(now, skew)) return rejected
        if (doc.expiresAt <= saturatingAdd(now, -skew)) return rejected
    }

    val discovered = LinkedHashMap<String, String>()
    val revoked = LinkedHashSet<String>()
    for (key in doc.keys) {
        // A PINNED kid with different bytes is a substitution attempt: refuse the WHOLE manifest
        // (a tombstoned pin keeps this protection).
        val pinned = options.pinned[key.kid]
        if (pinned != null && pinned != key.publicKey) return rejected
        if (key.status == "revoked") {
            if (pinned != null) {
                // A manifest cannot revoke the key that signed it: refused in full (§1 rule 2).
                if (key.kid == verified.kid) return rejected
                if (key.kid !in dead) revoked += key.kid
            }
            continue
        }
        // The allow-list: any other status (absent, unknown, a case variant) skips the entry.
        if (key.status !in LIVE_STATUSES) continue
        // A future-alg key, or one whose publicKey is not canonical, is skipped, not fatal.
        if (key.alg != "EdDSA" || key.kty != "OKP" || key.crv != "Ed25519") continue
        if (!Base64Url.isCanonical(key.publicKey)) continue
        discovered[key.kid] = key.publicKey
    }
    // A tombstoned kid leaves every set; a later manifest cannot restore it (§1 rule 3).
    for (kid in dead + revoked) discovered.remove(kid)
    return TrustManifestResult(doc, discovered, revoked.sortedWith(KID_BYTE_ORDER))
}

/** The pins minus the tombstoned kids (§1): the ONLY keys a manifest or bundle verifies against. */
public fun usablePins(pinned: TrustSet, tombstones: Collection<String> = emptyList()): TrustSet {
    if (tombstones.isEmpty()) return pinned
    val dead = tombstones.toSet()
    return pinned.filterKeys { it !in dead }
}

/** What [loadPinRevocations] derives from the cached evidence. */
public data class PinRevocations(
    /** The tombstoned pinned kids, ascending byte order. */
    val tombstones: List<String>,
    /** The evidence that re-verified, keyed by the kid it revokes: write this back. */
    val kept: Map<String, String>,
)

/**
 * Re-derive the tombstones from the cache's `pinRevocations` slice (§4.1): `kid → the revoking
 * manifest's compact JWS`. Each entry is re-verified on the RELOAD profile, in ascending manifest
 * `issuedAt` (ties: the revoked kid's byte order), against the pins minus the tombstones already
 * applied. An entry that does not verify, whose signer is already tombstoned, or that does not
 * revoke the kid it is filed under, is dropped.
 */
public fun loadPinRevocations(
    evidence: Map<String, String>,
    pinned: TrustSet,
    expectedAud: String,
    expectedIss: String = POLARIS_ISSUER,
): PinRevocations {
    class Candidate(val kid: String, val jws: String, val issuedAt: Long)
    val candidates = ArrayList<Candidate>()
    for ((kid, jws) in evidence) {
        if (kid !in pinned) continue
        val pre = verifyTrustManifest(jws, VerifyTrustManifestOptions(pinned, expectedAud = expectedAud, expectedIss = expectedIss, checkFreshness = false))
        val doc = pre.doc ?: continue
        candidates += Candidate(kid, jws, doc.issuedAt)
    }
    candidates.sortWith(compareBy<Candidate> { it.issuedAt }.thenComparing({ it.kid }, KID_BYTE_ORDER))
    val tombstones = ArrayList<String>()
    val kept = LinkedHashMap<String, String>()
    for (c in candidates) {
        val result = verifyTrustManifest(
            c.jws,
            VerifyTrustManifestOptions(pinned, tombstones.toList(), expectedAud, expectedIss, checkFreshness = false),
        )
        if (result.doc == null || c.kid !in result.revokedPins) continue
        tombstones += c.kid
        kept[c.kid] = c.jws
    }
    return PinRevocations(tombstones.sortedWith(KID_BYTE_ORDER), kept)
}

/** The header `kid` of a compact JWS, unverified, or null. For the signer retry only. */
public fun jwsHeaderKid(jws: String): String? {
    val header = jws.substringBefore('.', "").takeIf { it.isNotEmpty() }?.let { Base64Url.decode(it) } ?: return null
    return JsonText.parseOrNull(header.toString(Charsets.UTF_8)).objectValue?.get("kid").stringValue
}

/**
 * The `?signer=<kid>` retry order (§2.3). When the default manifest's header `kid` is a usable pin
 * there is nothing to retry: empty. Otherwise each usable pin in ascending kid byte order, at most
 * [MAX_TRUST_SIGNER_ATTEMPTS]; the client stops at the first manifest it accepts.
 */
public fun trustSignerOrder(usable: TrustSet, headerKid: String?): List<String> {
    if (headerKid != null && headerKid in usable) return emptyList()
    return usable.keys.filter { it != headerKid }.sortedWith(KID_BYTE_ORDER).take(MAX_TRUST_SIGNER_ATTEMPTS)
}

/** The effective trust set: discovered UNION pinned, PINS LAST (R2-01). */
public fun mergeTrust(pinned: TrustSet, discovered: TrustSet): TrustSet = LinkedHashMap(discovered).apply { putAll(pinned) }
