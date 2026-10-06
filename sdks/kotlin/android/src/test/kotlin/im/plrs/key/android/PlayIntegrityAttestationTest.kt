// @pkey-feature devices.attest
package im.plrs.key.android

import org.robolectric.RobolectricTestRunner
import im.plrs.key.core.AttestChallenge
import im.plrs.key.core.AttestEvidence
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.core.UnsupportedException
import im.plrs.key.core.UnsupportedReason
import im.plrs.key.platform.InstallSourceInfo
import im.plrs.key.platform.IntegrityResult
import im.plrs.key.platform.PlatformIntegrity
import im.plrs.key.platform.PlatformIntegrityToken
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * devices.attest's Android provider (SP-K04): only a play build Google Play installed can attest
 * (anything else is the typed `outlet` N/A before Play is asked); the token is bound to the Worker's
 * requestHash verbatim under the challenge's cloud project number (else the host's); Play's failures
 * keep their meaning.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class PlayIntegrityAttestationTest {
    private class FakeIntegrity(override val isSupported: Boolean = true, val answer: IntegrityResult<PlatformIntegrityToken>? = null) : PlatformIntegrity {
        val calls = mutableListOf<Pair<Long, String>>()
        override fun prepare(cloudProjectNumber: Long, callback: (IntegrityResult<Boolean>) -> Unit) = callback(IntegrityResult.Success(true))
        override fun request(cloudProjectNumber: Long, requestHash: String, callback: (IntegrityResult<PlatformIntegrityToken>) -> Unit) {
            calls += cloudProjectNumber to requestHash
            callback(answer ?: IntegrityResult.Success(PlatformIntegrityToken("tok-$requestHash", prepared = true, reprepared = false)))
        }
    }

    private fun info(installer: String?, initiator: String?) = InstallSourceInfo(
        packageName = "gg.vlad.diceroll", sdkInt = 34, versionCode = 7, targetSdk = 36, api = "installSourceInfo",
        installer = installer, initiator = initiator, originator = null, initiatorSigners = null, packageSource = 3,
        updateOwner = null, selfSigners = listOf("ab".repeat(32)),
    )

    private val play = info("com.android.vending", "com.android.vending")

    @Test
    fun aPlayInstallAttestsWithTheChallengesProject() = runBlocking {
        val integrity = FakeIntegrity()
        val p = PlayIntegrityAttestation(integrity, { play }, cloudProjectNumber = "999")
        assertNull(p.unavailable())
        assertEquals(AttestEvidence.PlayIntegrity("tok-rh"), p.evidence(AttestChallenge("ch", "rh", "1234")))
        assertEquals(1234L to "rh", integrity.calls.single())
        // Without one in the challenge, the host's.
        p.evidence(AttestChallenge("ch", "rh2", null))
        assertEquals(999L to "rh2", integrity.calls.last())
    }

    @Test
    fun onlyAGooglePlayInstallCanAttest() {
        for (source in listOf(info("com.android.vending", "com.android.shell"), info("com.example.store", "com.example.store"), info(null, null))) {
            assertEquals(UnsupportedReason.outlet, PlayIntegrityAttestation(FakeIntegrity(), { source }).unavailable()?.reason)
        }
        assertEquals(UnsupportedReason.outlet, PlayIntegrityAttestation(FakeIntegrity(isSupported = false), { play }).unavailable()?.reason)
        val integrity = FakeIntegrity()
        try {
            runBlocking { PlayIntegrityAttestation(integrity, { null }).evidence(AttestChallenge("c", "r", "1")) }
            fail("expected the typed N/A")
        } catch (e: UnsupportedException) {
            assertEquals(UnsupportedReason.outlet, e.unsupported.reason)
        }
        assertEquals(0, integrity.calls.size)
    }

    @Test
    fun aMissingProjectOrAPlayFailureIsTyped() {
        try {
            runBlocking { PlayIntegrityAttestation(FakeIntegrity(), { play }).evidence(AttestChallenge("c", "r", null)) }
            fail("expected invalid-options")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.invalidOptions, e.code)
        }
        try {
            runBlocking {
                PlayIntegrityAttestation(FakeIntegrity(answer = IntegrityResult.Failed("IntegrityServiceException", "too many", -8)), { play }).evidence(AttestChallenge("c", "r", "1"))
            }
            fail("expected platform-error")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.platformError, e.code)
        }
    }
}
