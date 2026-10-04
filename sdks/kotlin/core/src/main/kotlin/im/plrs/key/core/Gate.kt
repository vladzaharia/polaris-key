// The licence STATE function — wire contract v3 §5, the pure part of the gate. It lives in :core as
// `licenseState` lives in `@polaris-key/client-core`, because two core proofs need it: the
// clock-floor vectors (`clockFloorCases` pin the status the floor yields) and the sync
// transcripts (each step's `licenseStatus`). The licence SERVICE — activation, entitlements, the
// build gate and `gate-matrix.json` (`license.gate`) — is the :license module's (P6-07).
//
// The order is load-bearing and mirrors client-core exactly: not-applicable → no activation →
// blocked → revoked → no doc → expired → grace → ok.

package im.plrs.key.core

/** A server 403 block, reflected locally; unsigned is safe because it only tightens (§4.1). */
public data class BlockInfo(val reason: BlockReason, val allowedRange: AllowedRange? = null)

public data class LicenseState(
    val status: LicenseStatus,
    val graceUntil: Long? = null,
    /** Epoch MILLIseconds of the last successful verify. */
    val lastVerifiedAt: Long? = null,
    val allowedRange: AllowedRange? = null,
)

public data class GateInput(
    val licenseServiceEnabled: Boolean = true,
    val activation: ActivationSource?,
    val doc: LicenseDoc?,
    /** Epoch seconds. */
    val now: Long,
    /** The §4.2 floor: the gate evaluates at `max(now, highWaterMark)`. */
    val highWaterMark: Long = 0,
    val lastSyncUnauthorized: Boolean = false,
    val blocked: BlockInfo? = null,
    val lastVerifiedAt: Long? = null,
)

/** Compute the renderable gate state. */
public fun licenseState(input: GateInput): LicenseState {
    val now = maxOf(input.now, input.highWaterMark)
    if (!input.licenseServiceEnabled) return LicenseState(LicenseStatus.notApplicable)
    if (input.activation == null) return LicenseState(LicenseStatus.needsActivation)
    input.blocked?.let { b ->
        val status = when (b.reason) {
            BlockReason.versionTooOld -> LicenseStatus.versionTooOld
            BlockReason.versionTooNew -> LicenseStatus.versionTooNew
            BlockReason.channelNotEntitled -> LicenseStatus.channelNotEntitled
        }
        return LicenseState(status, allowedRange = b.allowedRange)
    }
    if (input.lastSyncUnauthorized) return LicenseState(LicenseStatus.revoked)
    val doc = input.doc ?: return LicenseState(LicenseStatus.needsActivation)
    if (now > doc.graceUntil) return LicenseState(LicenseStatus.expired, graceUntil = doc.graceUntil)
    if (now > doc.expiresAt) {
        return LicenseState(LicenseStatus.grace, graceUntil = doc.graceUntil, lastVerifiedAt = input.lastVerifiedAt)
    }
    return LicenseState(LicenseStatus.ok, graceUntil = doc.graceUntil, lastVerifiedAt = input.lastVerifiedAt)
}

/** True when the gate permits running: `ok`, `grace` or `not-applicable`. */
public fun isUsable(status: LicenseStatus): Boolean =
    status == LicenseStatus.ok || status == LicenseStatus.grace || status == LicenseStatus.notApplicable
