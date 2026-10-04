// The trust set — WIRE-CONTRACT-V3 §1, pinned by the corpus's `trustCases`.
//
//   pinned      compiled into the host application. TERMINAL: nothing overrides it.
//   discovered  learned from a trust manifest a PINNED key signed, replaced wholesale on every
//               accepted manifest, so absence is revocation.
//
// The on-disk cache is not a tier: it keeps the manifest's compact JWS, so the keys it yields are
// exactly the keys a pinned key vouched for (audit R2-01, R2-02, R4-02).

package im.plrs.key.core

/** The outcome of verifying a trust manifest; `doc == null` means refused (keep the old set). */
public data class TrustManifestResult(val doc: TrustManifestDoc?, val discovered: TrustSet)

public data class VerifyTrustManifestOptions(
    /** The ONLY keys a manifest may be signed by. */
    val pinned: TrustSet,
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
    val verified = JwsVerifier.verify(jws, options.pinned, JwsTyp.trust, requireTyp = true) ?: return rejected
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
    for (key in doc.keys) {
        // A PINNED kid with different bytes is a substitution attempt: refuse the WHOLE manifest.
        val pinned = options.pinned[key.kid]
        if (pinned != null && pinned != key.publicKey) return rejected
        // A future-alg key is skipped, not fatal.
        if (key.alg != "EdDSA" || key.kty != "OKP" || key.crv != "Ed25519") continue
        // `revoked` must not enter the set; active, staged and retired all verify.
        if (key.status == "revoked") continue
        discovered[key.kid] = key.publicKey
    }
    return TrustManifestResult(doc, discovered)
}

/** The effective trust set: discovered UNION pinned, PINS LAST (R2-01). */
public fun mergeTrust(pinned: TrustSet, discovered: TrustSet): TrustSet = LinkedHashMap(discovered).apply { putAll(pinned) }
