package im.plrs.key.platform.play

import androidx.test.core.app.ApplicationProvider
import com.google.android.play.core.integrity.model.StandardIntegrityErrorCode
import im.plrs.key.platform.IntegrityResult
import im.plrs.key.platform.PlatformIntegrity
import im.plrs.key.platform.PlatformIntegrityToken
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * The play flavour's [PlatformIntegrity] over a fake backend: success with the prepare flags, every
 * refusal (Play never asked), every failure with its error code, the single re-prepare on
 * INTEGRITY_TOKEN_PROVIDER_INVALID, and lazy creation of Play's manager.
 */
@RunWith(RobolectricTestRunner::class)
class PlayPlatformIntegrityTest {
    private val project = 123456789012L

    private class FakeBackend : IntegrityBackend {
        var prepares = 0
        val hashes = mutableListOf<String>()
        var prepareFailure: Int? = null
        var prepareThrowable: Throwable? = null
        val requestFailures = ArrayDeque<Int>()

        override fun prepare(cloudProjectNumber: Long, callback: (Result<IntegrityTokenSource>) -> Unit) {
            prepares++
            prepareThrowable?.let {
                callback(Result.failure(it))
                return
            }
            prepareFailure?.let {
                callback(Result.failure(IntegrityError("StandardIntegrityException", "prepare failed", it)))
                return
            }
            val generation = prepares
            callback(
                Result.success(
                    IntegrityTokenSource { hash, cb ->
                        hashes.add(hash)
                        val code = requestFailures.removeFirstOrNull()
                        if (code != null) {
                            cb(Result.failure(IntegrityError("StandardIntegrityException", "request failed", code)))
                        } else {
                            cb(Result.success("token-$generation-$hash"))
                        }
                    },
                ),
            )
        }
    }

    private val backend = FakeBackend()
    private val integrity: PlatformIntegrity = PlayPlatformIntegrity(PlayIntegrity(backend))

    private fun prepare(cloud: Long = project): IntegrityResult<Boolean> {
        var out: IntegrityResult<Boolean>? = null
        integrity.prepare(cloud) { out = it }
        return out!!
    }

    private fun request(cloud: Long = project, hash: String = "rh"): IntegrityResult<PlatformIntegrityToken> {
        var out: IntegrityResult<PlatformIntegrityToken>? = null
        integrity.request(cloud, hash) { out = it }
        return out!!
    }

    @Test
    fun supportedAndTokensCarryThePrepareFlags() {
        assertTrue(integrity.isSupported)
        assertEquals(IntegrityResult.Success(PlatformIntegrityToken("token-1-rh", prepared = true, reprepared = false)), request())
        assertEquals(IntegrityResult.Success(PlatformIntegrityToken("token-1-x", prepared = false, reprepared = false)), request(hash = "x"))
        assertEquals(IntegrityResult.Success(false), prepare())
        assertEquals(1, backend.prepares)
        assertEquals(listOf("rh", "x"), backend.hashes)
    }

    @Test
    fun prepareAnswersTrueOnlyWhenItPrepared() {
        assertEquals(IntegrityResult.Success(true), prepare())
        assertEquals(IntegrityResult.Success(false), prepare())
        assertEquals(IntegrityResult.Success(true), prepare(cloud = 42))
        assertEquals(2, backend.prepares)
    }

    @Test
    fun everyRefusalIsAnsweredWithoutAskingPlay() {
        val positive = IntegrityResult.Refused("cloudProjectNumber must be positive")
        val hash = IntegrityResult.Refused("requestHash must be 1..500 characters")
        assertEquals(positive, prepare(cloud = 0))
        assertEquals(positive, prepare(cloud = -1))
        assertEquals(positive, request(cloud = 0))
        assertEquals(positive, request(cloud = Long.MIN_VALUE))
        assertEquals(hash, request(hash = ""))
        assertEquals(hash, request(hash = "a".repeat(501)))
        assertEquals(0, backend.prepares)
        assertTrue(backend.hashes.isEmpty())
        // The longest accepted hash goes through verbatim.
        val longest = "b".repeat(500)
        assertEquals(longest, ((request(hash = longest) as IntegrityResult.Success).value.token).removePrefix("token-1-"))
    }

    @Test
    fun playFailuresCarryTheirErrorCode() {
        backend.requestFailures.add(StandardIntegrityErrorCode.TOO_MANY_REQUESTS)
        val r = request()
        assertEquals(IntegrityResult.Failed("StandardIntegrityException", "request failed", StandardIntegrityErrorCode.TOO_MANY_REQUESTS), r)
    }

    @Test
    fun prepareFailuresCarryTheirErrorCode() {
        backend.prepareFailure = StandardIntegrityErrorCode.CLOUD_PROJECT_NUMBER_IS_INVALID
        val expected = IntegrityResult.Failed("StandardIntegrityException", "prepare failed", StandardIntegrityErrorCode.CLOUD_PROJECT_NUMBER_IS_INVALID)
        assertEquals(expected, prepare())
        assertEquals(expected, request())
    }

    @Test
    fun aBindErrorWithoutPlayServicesHasNoCode() {
        backend.prepareThrowable = IllegalStateException("bind failed")
        assertEquals(IntegrityResult.Failed("java.lang.IllegalStateException", "bind failed", null), request())
    }

    @Test
    fun anInvalidProviderIsPreparedAgainOnce() {
        backend.requestFailures.add(StandardIntegrityErrorCode.INTEGRITY_TOKEN_PROVIDER_INVALID)
        assertEquals(IntegrityResult.Success(PlatformIntegrityToken("token-2-rh", prepared = true, reprepared = true)), request())
        assertEquals(2, backend.prepares)
    }

    @Test
    fun aSecondInvalidProviderFails() {
        repeat(2) { backend.requestFailures.add(StandardIntegrityErrorCode.INTEGRITY_TOKEN_PROVIDER_INVALID) }
        val r = request() as IntegrityResult.Failed
        assertEquals(StandardIntegrityErrorCode.INTEGRITY_TOKEN_PROVIDER_INVALID, r.errorCode)
        assertEquals(2, backend.prepares)
    }

    @Test
    fun playsManagerIsCreatedOnFirstUse() {
        var created = 0
        val lazy = PlayPlatformIntegrity {
            created++
            PlayIntegrity(backend)
        }
        assertTrue(lazy.isSupported)
        assertEquals(0, created)
        lazy.request(project, "rh") {}
        lazy.request(project, "rh") {}
        assertEquals(1, created)
    }

    @Test
    fun createGivesThePlayIntegrity() {
        val i = PlatformIntegrity.create(ApplicationProvider.getApplicationContext())
        assertTrue(i is PlayPlatformIntegrity)
        assertTrue(i.isSupported)
    }
}
