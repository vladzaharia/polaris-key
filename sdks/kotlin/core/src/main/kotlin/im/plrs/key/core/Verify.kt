// Per-document claim validation — wire contract v3 §2–§3, with v4's integer claims (§3).
//
// The licence and config documents share one ENVELOPE (`iss`, `aud`, `deviceId`, `issuedAt`,
// `expiresAt`, `graceUntil`), validated once in `validateEnvelope`; only the per-document claims
// differ. Freshness is asserted on the NETWORK path only: on the cache-reload path and on bundle
// import a document is expected to be past its short `expiresAt` (that is offline operation), and
// its outer bound there is `graceUntil`, which the gate enforces against the clock floor.

package im.plrs.key.core

/** Options for the product-scoped, anti-replay document check. */
public data class VerifyOptions(
    val trust: TrustSet,
    val expectedAud: String,
    val deviceId: String,
    /** Per-TYPE anti-replay floor: reject a document not strictly newer (§3). Required: "no floor" is an explicit null. */
    val lastAcceptedIssuedAt: Long?,
    val expectedIss: String = POLARIS_ISSUER,
    /** Epoch seconds; pass the client's floored `effectiveNow` (§4.2). */
    val now: Long? = null,
    val clockSkewSeconds: Long = CLOCK_SKEW_SECONDS,
    /** True on the network path, false on the reload path and bundle import. */
    val checkFreshness: Boolean = true,
)

private fun validateEnvelope(doc: DocClaims, opts: VerifyOptions, now: Long, nonWire: NonWireIntegers): Boolean {
    if (doc.aud != opts.expectedAud) return false
    if (!wireInteger(doc.issuedAt, "/issuedAt", 0, nonWire)) return false
    if (!wireInteger(doc.expiresAt, "/expiresAt", 0, nonWire)) return false
    if (!wireInteger(doc.graceUntil, "/graceUntil", 0, nonWire)) return false
    if (doc.iss != opts.expectedIss) return false
    if (doc.deviceId != opts.deviceId) return false
    val last = opts.lastAcceptedIssuedAt
    if (last != null && doc.issuedAt <= last) return false
    if (doc.graceUntil < doc.expiresAt) return false
    if (doc.graceUntil > saturatingAdd(doc.issuedAt, MAX_GRACE_SECONDS)) return false
    if (opts.checkFreshness) {
        if (doc.issuedAt > saturatingAdd(now, opts.clockSkewSeconds)) return false
        if (doc.expiresAt <= saturatingAdd(now, -opts.clockSkewSeconds)) return false
    }
    return true
}

private fun nowSeconds(): Long = System.currentTimeMillis() / 1000

/** Verify a `pkey-license+jws` document (§2.1); null on any failure. */
public fun verifyLicenseDoc(jws: String, options: VerifyOptions): LicenseDoc? {
    val verified = JwsVerifier.verify(jws, options.trust, JwsTyp.license, requireTyp = true) ?: return null
    val doc = LicenseDoc.from(verified.payload) ?: return null
    if (!validateEnvelope(doc, options, options.now ?: nowSeconds(), verified.nonWireIntegers)) return null
    if (doc.licenseId.isEmpty()) return null
    return doc
}

/** Verify a `pkey-config+jws` document (§2.2); null on any failure. */
public fun verifyConfigDoc(jws: String, options: VerifyOptions): ConfigDoc? {
    val verified = JwsVerifier.verify(jws, options.trust, JwsTyp.config, requireTyp = true) ?: return null
    val doc = ConfigDoc.from(verified.payload) ?: return null
    if (!validateEnvelope(doc, options, options.now ?: nowSeconds(), verified.nonWireIntegers)) return null
    // §3: the catalog version is shape-checked, never allow-listed; V4 §3: minimum 1.
    if (!wireInteger(doc.schemaVersion, "/schemaVersion", 1, verified.nonWireIntegers)) return null
    return doc
}
