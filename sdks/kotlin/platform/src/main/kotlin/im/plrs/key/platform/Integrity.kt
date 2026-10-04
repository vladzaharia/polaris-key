package im.plrs.key.platform

import android.content.Context

/**
 * The outcome of a [PlatformIntegrity] call. Exactly one of four:
 *
 * - [Success]: Play answered.
 * - [Refused]: the arguments were rejected before Play was asked (a cloud project number that is
 *   not positive, a request hash that is empty or longer than [PlatformIntegrity.MAX_REQUEST_HASH]).
 * - [Failed]: Play was asked and failed; [Failed.errorCode] is the `StandardIntegrityErrorCode`
 *   when Play gave one (-8 TOO_MANY_REQUESTS, -16 CLOUD_PROJECT_NUMBER_IS_INVALID, -19
 *   INTEGRITY_TOKEN_PROVIDER_INVALID after the one re-prepare, ...). Without Play services the
 *   failure is an internal bind error with no code.
 * - [Unsupported]: this build cannot attest at all; [Unsupported.reason] is
 *   [PlatformIntegrity.REASON_OUTLET] in the `direct` flavour (an install Play did not make has no
 *   Play Integrity verdict to give).
 */
public sealed class IntegrityResult<out T> {
    public data class Success<out T>(public val value: T) : IntegrityResult<T>()

    public data class Refused(public val message: String) : IntegrityResult<Nothing>()

    public data class Failed(
        public val exception: String,
        public val message: String?,
        public val errorCode: Int?,
    ) : IntegrityResult<Nothing>()

    public data class Unsupported(public val reason: String) : IntegrityResult<Nothing>()
}

/**
 * A standard Play Integrity token and how it was obtained: [prepared] is true when this call had to
 * prepare a token provider first, [reprepared] when Play reported the cached provider invalid and
 * it was prepared again once. The token is opaque here: the Worker decodes and verifies it (P6-02).
 */
public data class PlatformIntegrityToken(
    public val token: String,
    public val prepared: Boolean,
    public val reprepared: Boolean,
)

/**
 * Device attestation through the STANDARD Play Integrity API, available in every flavour as one
 * surface (P6-02, P6-09):
 *
 * - `play`: `prepareIntegrityToken(cloudProjectNumber)` once (a warm-up of seconds), then
 *   `request(requestHash)` per verdict (~100–300 ms), over `play.PlayIntegrity`.
 * - `direct`: every call answers [IntegrityResult.Unsupported] with [REASON_OUTLET], and the build
 *   carries no Play Core class.
 *
 * The Google Cloud project number is the host app's, supplied at call time (the Worker returns it
 * with each challenge); this module never embeds one. The request hash is the Worker's
 * `requestHash` string, passed verbatim. Verdicts are never cached: every token is single-use.
 * Call from Android's main thread; callbacks arrive there.
 */
public interface PlatformIntegrity {
    /** False when every call answers [IntegrityResult.Unsupported]. */
    public val isSupported: Boolean

    /** Prepare (or keep) the token provider for [cloudProjectNumber]; the value is true when it was prepared now. */
    public fun prepare(cloudProjectNumber: Long, callback: (IntegrityResult<Boolean>) -> Unit)

    /** A standard integrity token bound to [requestHash], preparing the provider first if needed. */
    public fun request(
        cloudProjectNumber: Long,
        requestHash: String,
        callback: (IntegrityResult<PlatformIntegrityToken>) -> Unit,
    )

    public companion object {
        /** The [IntegrityResult.Unsupported] reason of a build whose outlet cannot attest (`direct`). */
        public const val REASON_OUTLET: String = "outlet"

        /** The longest request hash Play accepts. */
        public const val MAX_REQUEST_HASH: Int = 500

        /** This build's Integrity: Play's in the `play` flavour, [unsupported] in `direct`. */
        public fun create(context: Context): PlatformIntegrity = FlavorIntegrity.create(context)

        /** An Integrity whose every call answers [IntegrityResult.Unsupported] with [reason]. */
        public fun unsupported(reason: String = REASON_OUTLET): PlatformIntegrity = UnsupportedIntegrity(reason)

        /** Why the arguments are refused, or null when they are acceptable. A null [requestHash] checks only the project. */
        public fun refusal(cloudProjectNumber: Long, requestHash: String?): String? = when {
            cloudProjectNumber <= 0 -> "cloudProjectNumber must be positive"
            requestHash != null && (requestHash.isEmpty() || requestHash.length > MAX_REQUEST_HASH) ->
                "requestHash must be 1..$MAX_REQUEST_HASH characters"
            else -> null
        }
    }
}

private class UnsupportedIntegrity(private val reason: String) : PlatformIntegrity {
    override val isSupported: Boolean get() = false

    override fun prepare(cloudProjectNumber: Long, callback: (IntegrityResult<Boolean>) -> Unit) {
        callback(IntegrityResult.Unsupported(reason))
    }

    override fun request(
        cloudProjectNumber: Long,
        requestHash: String,
        callback: (IntegrityResult<PlatformIntegrityToken>) -> Unit,
    ) {
        callback(IntegrityResult.Unsupported(reason))
    }
}
