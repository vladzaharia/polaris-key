// Offline activation bundles — wire contract v3 §7. The VERIFIER only: pure, and it touches no
// store. Step 5 (the atomic cache write) belongs to `CoreContext`, so all-or-nothing is
// structural: a refusal returns no documents at all.
//
// The corpus pins WHICH numbered step refuses each vector, so refusals are named for the step.

package im.plrs.key.core

/** One inner document that survived every step, with the exact bytes it arrived as. */
public data class VerifiedBundleDoc<T : DocClaims>(val jws: String, val doc: T)

/** A bundle that passed all four verification steps. */
public data class VerifiedBundle(
    val bundleId: String,
    val trustJws: String,
    /** The inner trust manifest's signed `issuedAt`. */
    val trustIssuedAt: Long,
    /** Pinned kids the inner manifest newly tombstones (§1); the host files it as their evidence. */
    val revokedPins: List<String>,
    /** `usable pins ∪ live manifest keys`, pins terminal: the set step 4 used. */
    val effectiveTrust: TrustSet,
    val license: VerifiedBundleDoc<LicenseDoc>?,
    val config: VerifiedBundleDoc<ConfigDoc>?,
) {
    /** Which documents landed, in §7 order (a sequence, not a set). */
    val importedSlices: List<DocumentSlice>
        get() = listOfNotNull(license?.let { DocumentSlice.license }, config?.let { DocumentSlice.config })
}

/** Which numbered step of §7 refused, as the generated error codes spell it. */
public enum class BundleRefusalReason(public val code: String) {
    /** Step 1: signature, `typ`, or the 262 144-byte cap. */
    bundleJwsRejected(ErrorCode.bundleJwsRejected),

    /** Step 2: `aud`, `deviceId`, the import window, or vacuous `docs`. */
    bundleClaimsRejected(ErrorCode.bundleClaimsRejected),

    /** Step 3: the inner manifest failed against the PINS. */
    bundleTrustRejected(ErrorCode.bundleTrustRejected),

    /** Step 4: a carried document failed against the effective set. */
    innerDocRejected(ErrorCode.innerDocRejected),
}

/** `inspectBundle`'s answer: the bundle, or the step that refused it. */
public sealed interface BundleInspection {
    public data class Ok(val bundle: VerifiedBundle) : BundleInspection

    public data class Refused(val reason: BundleRefusalReason) : BundleInspection
}

/** §7 step 4's per-type anti-replay floors: the `issuedAt` of the verified cached document, or null. */
public data class BundleFloors(val license: Long?, val config: Long?) {
    public companion object {
        /** The reload profile names no floor: the inner documents ARE the cached ones. */
        public val NONE: BundleFloors = BundleFloors(null, null)
    }
}

/** `import` is the operator's act; `reload` is the cached bundle re-verified at every start. */
public enum class BundleProfile { import, reload }

public data class BundleOptions(
    /** The ONLY keys a bundle (and the manifest it carries) may verify against, less [tombstones]. */
    val pinned: TrustSet,
    /** The expected `aud`: this client's product slug. */
    val product: String,
    /** The LOCAL device id; step 4 binds inner documents to it. */
    val deviceId: String,
    /** Epoch seconds; required, never defaulted. */
    val now: Long,
    /** Each inner document must be strictly newer than its floor, else `inner-doc-rejected`. */
    val floors: BundleFloors,
    val profile: BundleProfile,
    /** Pinned kids tombstoned on this install: not usable for the bundle, its manifest or step 4. */
    val tombstones: Collection<String> = emptyList(),
    val clockSkewSeconds: Long = CLOCK_SKEW_SECONDS,
)

/** Walk §7's numbered order over one bundle, reporting which step refused. */
public fun inspectBundle(jws: String, options: BundleOptions): BundleInspection {
    fun refused(r: BundleRefusalReason) = BundleInspection.Refused(r)
    // 1. The bundle JWS against PINNED keys only, with the raised cap that travels with the typ.
    val pins = usablePins(options.pinned, options.tombstones)
    val verified = JwsVerifier.verify(jws, pins, JwsTyp.bundle, requireTyp = true, maxPayloadBytes = MAX_BUNDLE_BYTES)
        ?: return refused(BundleRefusalReason.bundleJwsRejected)
    // A missing or mistyped member is a CLAIMS failure, never a signature one.
    val bundle = BundleDoc.from(verified.payload) ?: return refused(BundleRefusalReason.bundleClaimsRejected)
    if (!wireInteger(bundle.issuedAt, "/issuedAt", 0, verified.nonWireIntegers) ||
        !wireInteger(bundle.expiresAt, "/expiresAt", 0, verified.nonWireIntegers)
    ) {
        return refused(BundleRefusalReason.bundleClaimsRejected)
    }

    // 2. The bundle's own claims; the import profile adds the 30-day window (§7.2), the reload
    //    profile (the cached bundle at every start) keeps everything else.
    val skew = options.clockSkewSeconds
    if (bundle.bundleId.isEmpty() ||
        bundle.aud != options.product ||
        bundle.deviceId != options.deviceId ||
        (bundle.docs.license == null && bundle.docs.config == null)
    ) {
        return refused(BundleRefusalReason.bundleClaimsRejected)
    }
    if (options.profile != BundleProfile.reload &&
        (bundle.issuedAt > saturatingAdd(options.now, skew) || options.now > saturatingAdd(bundle.expiresAt, skew))
    ) {
        return refused(BundleRefusalReason.bundleClaimsRejected)
    }

    // 3. The inner trust manifest against the PINS, on the reload profile.
    val manifest = verifyTrustManifest(
        bundle.trust,
        VerifyTrustManifestOptions(pinned = options.pinned, tombstones = options.tombstones, expectedAud = options.product, now = options.now, checkFreshness = false),
    )
    if (manifest.doc == null) return refused(BundleRefusalReason.bundleTrustRejected)
    val effectiveTrust = mergeTrust(usablePins(pins, manifest.revokedPins), manifest.discovered)

    // 4. Each inner document against the EFFECTIVE set, reload profile, the LOCAL device id, and
    //    strictly newer than its per-type floor.
    fun reload(floor: Long?) = VerifyOptions(
        trust = effectiveTrust, expectedAud = options.product, deviceId = options.deviceId,
        lastAcceptedIssuedAt = floor, now = options.now, clockSkewSeconds = skew, checkFreshness = false,
    )
    val license = bundle.docs.license?.let { j ->
        val doc = verifyLicenseDoc(j, reload(options.floors.license)) ?: return refused(BundleRefusalReason.innerDocRejected)
        VerifiedBundleDoc(j, doc)
    }
    val config = bundle.docs.config?.let { j ->
        val doc = verifyConfigDoc(j, reload(options.floors.config)) ?: return refused(BundleRefusalReason.innerDocRejected)
        VerifiedBundleDoc(j, doc)
    }

    // 5. The caller's turn: the atomic cache write.
    return BundleInspection.Ok(VerifiedBundle(bundle.bundleId, bundle.trust, manifest.doc.issuedAt, manifest.revokedPins, effectiveTrust, license, config))
}

/** Verify an offline bundle; null on any refusal (use [inspectBundle] when the reason matters). */
public fun verifyBundle(jws: String, options: BundleOptions): VerifiedBundle? =
    (inspectBundle(jws, options) as? BundleInspection.Ok)?.bundle
