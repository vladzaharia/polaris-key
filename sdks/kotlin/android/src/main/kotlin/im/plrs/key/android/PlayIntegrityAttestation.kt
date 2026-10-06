// devices.attest on Android (SP-K04; P6-02, notes/SDK-PARITY-PASS.md §3.10): :core's
// AttestationProvider over :platform's PlatformIntegrity. Play Integrity's STANDARD API: the
// provider is prepared for the cloud project number once, then one token per verdict, bound to the
// Worker's `requestHash` verbatim.
//
// Who can attest: a play build (PlatformIntegrity.isSupported) that Google Play installed
// (installer com.android.vending, and the installer is the initiator: `adb install -i
// com.android.vending` is not a Play install). Anything else answers the typed `outlet` N/A, before
// any request, as Godot's PKeyAndroid gate does. The cloud project number is the challenge's
// (the operator configures it on the Worker), else [AndroidOptions.playCloudProjectNumber].

package im.plrs.key.android

import android.content.Context
import android.os.Handler
import android.os.Looper
import im.plrs.key.core.AttestChallenge
import im.plrs.key.core.AttestEvidence
import im.plrs.key.core.AttestationProvider
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Feature
import im.plrs.key.core.PolarisException
import im.plrs.key.core.Unsupported
import im.plrs.key.core.UnsupportedException
import im.plrs.key.core.UnsupportedReason
import im.plrs.key.platform.InstallSource
import im.plrs.key.platform.InstallSourceInfo
import im.plrs.key.platform.IntegrityResult
import im.plrs.key.platform.PlatformIntegrity
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/** Play Integrity as `devices.attest`'s platform side. */
public class PlayIntegrityAttestation(
    private val integrity: PlatformIntegrity,
    /** This install's source, read on each availability check. */
    private val installSource: () -> InstallSourceInfo?,
    /** The cloud project number when the Worker's challenge names none. */
    private val cloudProjectNumber: String? = null,
) : AttestationProvider {
    override fun unavailable(): Unsupported? {
        if (!integrity.isSupported) {
            return Unsupported(Feature.devicesAttest, UnsupportedReason.outlet, "a direct build carries no Play Integrity; only a Google Play install can attest, so it stays at the basic trust level")
        }
        val info = installSource()
        if (info == null || info.installer != InstallSource.PLAY_STORE || (info.initiator != null && info.initiator != info.installer)) {
            return Unsupported(Feature.devicesAttest, UnsupportedReason.outlet, "Google Play did not install this build (installer ${info?.installer ?: "unknown"}); it stays at the basic trust level")
        }
        return null
    }

    override suspend fun evidence(challenge: AttestChallenge): AttestEvidence {
        unavailable()?.let { throw UnsupportedException(it) }
        val raw = challenge.playCloudProjectNumber ?: cloudProjectNumber
        val project = raw?.takeIf { Regex("^[0-9]{1,19}$").matches(it) }?.toLongOrNull()?.takeIf { it > 0 }
            ?: throw PolarisException(ErrorCode.invalidOptions, "No Play Integrity cloud project number: the operator configured none on the Worker and AndroidOptions.playCloudProjectNumber is ${if (raw == null) "unset" else "not a positive number"}.")
        // Play's callbacks arrive on the main thread; the call itself must start there too.
        val result = suspendCancellableCoroutine<IntegrityResult<im.plrs.key.platform.PlatformIntegrityToken>> { cont ->
            val call = Runnable { integrity.request(project, challenge.requestHash) { if (cont.isActive) cont.resume(it) } }
            if (Looper.myLooper() == Looper.getMainLooper()) call.run() else Handler(Looper.getMainLooper()).post(call)
        }
        return when (result) {
            is IntegrityResult.Success -> AttestEvidence.PlayIntegrity(result.value.token)
            is IntegrityResult.Refused -> throw PolarisException(ErrorCode.invalidOptions, result.message)
            is IntegrityResult.Failed -> throw PolarisException(ErrorCode.platformError, "Play Integrity failed (${result.errorCode ?: result.exception}): ${result.message}")
            is IntegrityResult.Unsupported -> throw UnsupportedException(Unsupported(Feature.devicesAttest, UnsupportedReason.outlet, "Play Integrity is unavailable here (${result.reason})"))
        }
    }

    public companion object {
        /** This build's provider: [PlatformIntegrity.create] and the install source, read per check. */
        public fun create(context: Context, cloudProjectNumber: String? = null): PlayIntegrityAttestation {
            val app = context.applicationContext
            val readSource: () -> InstallSourceInfo? = {
                try {
                    InstallSource.read(app)
                } catch (e: Exception) {
                    null
                }
            }
            return PlayIntegrityAttestation(PlatformIntegrity.create(app), readSource, cloudProjectNumber)
        }
    }
}
