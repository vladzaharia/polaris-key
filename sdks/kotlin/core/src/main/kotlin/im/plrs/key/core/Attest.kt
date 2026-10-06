// Device attestation (registry `devices.attest`, P6-02; notes/SDK-PARITY-PASS.md §3.10): raise this
// device from trust level `basic` to `attested`.
//
//   1. `POST /<p>/devices/attest/challenge` (bearer)  → {challenge, requestHash, play?: {cloudProjectNumber}}
//   2. the platform token for `requestHash`            → an [AttestationProvider] (Play Integrity on
//                                                         Android, :android's; App Attest is Swift's)
//   3. `POST /<p>/devices/attest` (bearer)             → {trustLevel, kind, attestedAt}
//
// Refusals keep the Worker's code: `attestation_rejected` (422), `attestation_unavailable` (409 when
// the product is not set up for the kind, 503 when Google could not be reached), `rate_limited`. A
// runtime with no provider (a JVM desktop) answers the typed `runtime` N/A; an Android build Play did
// not install answers `outlet`.
//
// ATTEST AND RETRY: every call that can answer 403 `attestation_required` (edge-mint, gated delivery,
// a commerce claim) attests once and retries once through [attestAndRetry], only when this runtime
// has a provider; elsewhere the caller gets the typed refusal.

package im.plrs.key.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The Worker's challenge (step 1). */
public data class AttestChallenge(
    val challenge: String,
    /** The string a platform token binds to, verbatim (Play's `requestHash`, App Attest's client data). */
    val requestHash: String,
    /** The Play Integrity cloud project number the operator configured, when the Worker sent one. */
    val playCloudProjectNumber: String? = null,
)

/** What a platform attestation produced (step 2). */
public sealed interface AttestEvidence {
    public val kind: String

    /** A standard Play Integrity token bound to the challenge's `requestHash`. */
    public data class PlayIntegrity(val token: String) : AttestEvidence {
        override val kind: String get() = "play-integrity"
        override fun toString(): String = "PlayIntegrity(token=[redacted])"
    }

    /** An App Attest key attestation (Swift's; here for hosts that bridge one in). */
    public data class AppAttest(val keyId: String, val attestation: String) : AttestEvidence {
        override val kind: String get() = "app-attest"
    }
}

/**
 * The platform side of `devices.attest`. [unavailable] answers why this install cannot attest (the
 * typed N/A), or null when it can; [evidence] throws [PolarisException] or [UnsupportedException].
 */
public interface AttestationProvider {
    public fun unavailable(): Unsupported?
    public suspend fun evidence(challenge: AttestChallenge): AttestEvidence
}

/** A runtime with no attestation service the Worker verifies (a JVM desktop): the `runtime` N/A. */
public object NoAttestation : AttestationProvider {
    override fun unavailable(): Unsupported =
        Unsupported(Feature.devicesAttest, UnsupportedReason.runtime, "a ${RuntimeFamily.capabilityRuntime} build has no attestation service the Worker verifies; it stays at the basic trust level")

    override suspend fun evidence(challenge: AttestChallenge): AttestEvidence = throw UnsupportedException(unavailable())
}

/**
 * The provider this process's platform glue installed (`:android` sets Play Integrity), read by the
 * capability engine's `devices.attest` `outlet` detector and used by a client with no provider of
 * its own. Null on a plain JVM.
 */
public object AttestationProviders {
    @Volatile public var installed: AttestationProvider? = null
}

/** `devices.attest`'s answer. */
public data class AttestResult(val trustLevel: String, val kind: String, val attestedAt: Long?)

/** Runs the three steps above with [provider]. Throws the typed N/A, or a [PolarisException] with the Worker's code. */
public suspend fun CoreContext.attestDevice(provider: AttestationProvider): AttestResult {
    provider.unavailable()?.let { throw UnsupportedException(it) }
    if (localOnly) throw PolarisException(ErrorCode.localOnly, "This client is local-only; attestation is refused.")
    val token = token() ?: throw PolarisException(ErrorCode.unauthorized, "Activate or register before attesting this device.")
    val auth = mapOf("authorization" to "Bearer $token")
    val ch = request(endpoints.url("devices/attest/challenge"), method = "POST", headers = auth)
    if (!ch.isOk) throw PolarisException(wireErrorCode(ch.body) ?: ErrorCode.attestationUnavailable, "attest/challenge answered HTTP ${ch.status}.")
    val o = JsonText.parseOrNull(ch.text).objectValue
    val challenge = o?.get("challenge").stringValue?.takeIf { it.isNotEmpty() }
    val requestHash = o?.get("requestHash").stringValue?.takeIf { it.isNotEmpty() }
    if (challenge == null || requestHash == null) throw PolarisException(ErrorCode.badResponse, "The attestation challenge has no challenge or requestHash.")
    val evidence = provider.evidence(AttestChallenge(challenge, requestHash, o?.get("play")?.objectValue?.get("cloudProjectNumber").stringValue))
    val body = when (evidence) {
        is AttestEvidence.PlayIntegrity -> mapOf("kind" to evidence.kind, "token" to evidence.token, "challenge" to challenge)
        is AttestEvidence.AppAttest -> mapOf("kind" to evidence.kind, "keyId" to evidence.keyId, "attestation" to evidence.attestation, "challenge" to challenge)
    }
    val r = request(
        endpoints.url("devices/attest"), method = "POST",
        headers = auth + ("content-type" to "application/json"),
        body = JsonObject(body.mapValues { JsonPrimitive(it.value) }).toString().toByteArray(Charsets.UTF_8),
    )
    if (!r.isOk) throw PolarisException(wireErrorCode(r.body) ?: ErrorCode.attestationRejected, "devices/attest answered HTTP ${r.status}.")
    val out = JsonText.parseOrNull(r.text).objectValue
    val level = out?.get("trustLevel").stringValue ?: throw PolarisException(ErrorCode.badResponse, "The attestation answer has no trustLevel.")
    return AttestResult(level, out?.get("kind").stringValue ?: evidence.kind, out?.get("attestedAt").longValue)
}

/**
 * §3.10's rule: run [call]; when it fails with `attestation_required` and [attest] is given, attest
 * once and run [call] once more. [attest] answers false when this runtime cannot attest (the first
 * refusal then stands).
 */
public suspend fun <T> attestAndRetry(attest: (suspend () -> Boolean)?, call: suspend () -> T): T {
    try {
        return call()
    } catch (e: PolarisException) {
        if (e.code != ErrorCode.attestationRequired || attest == null) throw e
        val attested = try {
            attest()
        } catch (x: kotlinx.coroutines.CancellationException) {
            throw x
        } catch (x: Exception) {
            false
        }
        if (!attested) throw e
    }
    return call()
}
