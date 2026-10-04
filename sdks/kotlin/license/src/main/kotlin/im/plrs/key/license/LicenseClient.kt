// The License sub-client — activation, entitlements and the gate (wire contract v3 §5). A port of
// Swift's `LicenseClient`.
//
// `status()` is a pure call into :core's `licenseState`; each input comes from exactly one owner:
//
//   licenseServiceEnabled  Core's resolved capabilities (discovery > expectedServices > default).
//                          FALSE short-circuits to `not-applicable` (usable), which is how a
//                          config-only product boots usable instead of on `needs-activation` (D-08).
//   activation             `token` if a `pkeyt_` credential is held, else `bundle` if a verified
//                          offline import left a licence document, else null (§7).
//   doc / highWaterMark    the re-verified cache and the monotonic floor, both Core's.
//   blocked / lastSync…    unsigned hints that can only make the gate STRICTER (§4.1).
//
// Activation raises an EVENT (`onAcquired`) rather than syncing inline, so the facade decides what
// a fresh credential means and every mint path behaves the same.

package im.plrs.key.license

import im.plrs.key.core.ActivationSource
import im.plrs.key.core.BlockInfo
import im.plrs.key.core.CHANNEL_STABLE
import im.plrs.key.core.CoreContext
import im.plrs.key.core.DocProfile
import im.plrs.key.core.FingerprintSource
import im.plrs.key.core.GateInput
import im.plrs.key.core.HardwareFingerprint
import im.plrs.key.core.JvmFingerprintSource
import im.plrs.key.core.LicenseDoc
import im.plrs.key.core.LicenseState
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.TokenSource
import im.plrs.key.core.arrayValue
import im.plrs.key.core.boolValue
import im.plrs.key.core.isUsable
import im.plrs.key.core.licenseState
import im.plrs.key.core.stringValue
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonElement

public data class LicenseClientOptions(
    /**
     * Collect a hardware fingerprint at activation. Defaults to true; false opts out entirely (the
     * server then records the device as `unverified` rather than refusing it).
     */
    val fingerprint: Boolean = true,
    /** Where the fingerprint comes from; defaults to [JvmFingerprintSource] (Android's is P6-12's). */
    val fingerprintSource: FingerprintSource? = null,
)

/** Raised after a credential is minted, so the facade can sync. */
public typealias LicenseAcquiredListener = suspend (ActivationSource) -> Unit

/** The `LicenseState` overload, so a caller can write `isUsable(client.status())`. */
public fun isUsable(state: LicenseState): Boolean = isUsable(state.status)

public class LicenseClient(
    private val core: CoreContext,
    options: LicenseClientOptions = LicenseClientOptions(),
    private val onAcquired: LicenseAcquiredListener? = null,
) {
    private val fingerprintEnabled = options.fingerprint
    private val fingerprintSource: FingerprintSource = options.fingerprintSource ?: JvmFingerprintSource

    // ── Gate ─────────────────────────────────────────────────────────────────────────────────
    /** How this install became activated, or null. §7: a token supersedes a bundle. */
    public suspend fun activation(): ActivationSource? {
        if (core.token() != null) return ActivationSource.token
        val cache = core.cache()
        // A bundle activates ONLY if its licence document verified: a config-only bundle grants nothing.
        if (cache.importedBundle != null && cache.license != null) return ActivationSource.bundle
        return null
    }

    /** The renderable gate state at [now] (epoch seconds; the system clock when null), floored. */
    public suspend fun status(now: Long? = null): LicenseState {
        val cache = core.cache()
        return licenseState(
            GateInput(
                licenseServiceEnabled = core.enabled(ServiceSlug.license),
                activation = activation(),
                doc = cache.license?.doc,
                now = core.now(now),
                highWaterMark = core.highWaterMark(),
                lastSyncUnauthorized = cache.lastSyncUnauthorized,
                blocked = cache.blocked?.let { BlockInfo(it.reason, it.allowedRange) },
                lastVerifiedAt = cache.lastVerifiedAt,
            ),
        )
    }

    public suspend fun isLicensed(now: Long? = null): Boolean = isUsable(status(now))

    // ── Reads off the licence document ───────────────────────────────────────────────────────
    private suspend fun doc(): LicenseDoc? = core.cache().license?.doc

    /** True iff the named entitlement is present and its value is `true`. */
    public suspend fun isEntitled(name: String): Boolean = doc()?.entitlements?.get(name)?.value.boolValue == true

    /** Every entitlement's value, from the verified licence document. */
    public suspend fun entitlements(): Map<String, JsonElement> = doc()?.entitlements?.mapValues { it.value.value } ?: emptyMap()

    /** The signed greeting block, or null. Signed so it cannot be spoofed locally. */
    public suspend fun profile(): DocProfile? = doc()?.profile

    public suspend fun licenseId(): String? = doc()?.licenseId

    /**
     * The channels this licence grants: the `channels` entitlement's string values, in order, as
     * granted, or `["stable"]` when the entitlement is absent or not an array. The Worker's own
     * answer (`entitledChannels` in core/entitlements.ts) and every SDK's for the same document.
     * The grants are RAW: `staging` is not rewritten to `beta` here (WIRE-CONTRACT-V3 §5.1 rule 4
     * decides coverage).
     */
    public suspend fun entitledChannels(): List<String> {
        val array = doc()?.entitlements?.get("channels")?.value.arrayValue ?: return listOf(CHANNEL_STABLE)
        return array.mapNotNull { it.stringValue }
    }

    // ── Activation ───────────────────────────────────────────────────────────────────────────
    private fun fingerprint(): HardwareFingerprint? =
        if (fingerprintEnabled) fingerprintSource.collect(core.product) else null

    /** Obtain a licence with no key and no sign-in, when the product offers a free tier. */
    public suspend fun enroll(): ActivationResult =
        acquire(LicenseEndpoints.enroll(core, fingerprint()), TokenSource.enroll)

    /** Exchange a licence key for a per-device token. */
    public suspend fun activate(key: String): ActivationResult =
        acquire(LicenseEndpoints.activate(core, key, fingerprint()), TokenSource.activate)

    /** Persist a freshly issued token, then raise the acquisition event. A failed write is reported (R4-12). */
    private suspend fun acquire(result: ActivationResult, source: TokenSource): ActivationResult {
        if (result !is ActivationResult.Ok) return result
        try {
            core.setToken(result.token, source)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return ActivationResult.Error("could not persist the device token: ${e.message}")
        }
        onAcquired?.invoke(ActivationSource.token)
        return result
    }

    /**
     * Deauthorize this device and wipe every local credential and artifact. The network call is
     * best-effort and the local wipe is not: a device deactivating offline must not be left
     * holding a token.
     */
    public suspend fun deactivate() {
        core.token()?.let { LicenseEndpoints.deauthorize(core, it) }
        core.clearAll()
    }
}
