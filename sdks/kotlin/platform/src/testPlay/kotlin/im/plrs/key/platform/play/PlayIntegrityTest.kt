package im.plrs.key.platform.play

import com.google.android.play.core.integrity.model.StandardIntegrityErrorCode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * The standard Play Integrity flow over a fake backend (Play ships no fake StandardIntegrityManager):
 * prepare once and cache the provider, the request hash passed verbatim, one re-prepare on
 * INTEGRITY_TOKEN_PROVIDER_INVALID, and every other failure surfaced with its error code. Robolectric
 * only for the real org.json.
 */
@RunWith(RobolectricTestRunner::class)
class PlayIntegrityTest {
    private val requestHash = "q8Jm3rJ0b1x2Vd4n6Q9sT0uW1yZ2aB3cD4eF5gH6iJ7"
    private val project = 123456789012L

    /** Answers synchronously, as Play's tasks would on the main looper. */
    private class FakeBackend : IntegrityBackend {
        var prepares = 0
        val projects = mutableListOf<Long>()
        val hashes = mutableListOf<String>()
        var prepareFailure: Int? = null
        /** Error codes the next requests fail with, in order (then success). */
        val requestFailures = ArrayDeque<Int>()

        override fun prepare(cloudProjectNumber: Long, callback: (Result<IntegrityTokenSource>) -> Unit) {
            prepares++
            projects.add(cloudProjectNumber)
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

    private fun request(pi: PlayIntegrity, cloud: Long = project, hash: String = requestHash): Result<IntegrityToken> {
        var out: Result<IntegrityToken>? = null
        pi.request(cloud, hash) { out = it }
        return out!!
    }

    @Test
    fun preparesOnceAndPassesTheRequestHashVerbatim() {
        val fake = FakeBackend()
        val pi = PlayIntegrity(fake)
        assertFalse(pi.isPrepared(project))
        val first = request(pi).getOrThrow()
        assertEquals("token-1-$requestHash", first.token)
        assertTrue(first.prepared)
        assertFalse(first.reprepared)
        assertTrue(pi.isPrepared(project))
        val second = request(pi, hash = "other").getOrThrow()
        assertFalse("the provider is cached", second.prepared)
        assertEquals(1, fake.prepares)
        assertEquals(listOf(requestHash, "other"), fake.hashes)
        assertEquals(listOf(project), fake.projects)
    }

    @Test
    fun anotherCloudProjectPreparesAgain() {
        val fake = FakeBackend()
        val pi = PlayIntegrity(fake)
        request(pi).getOrThrow()
        request(pi, cloud = 42L).getOrThrow()
        assertEquals(listOf(project, 42L), fake.projects)
        assertTrue(pi.isPrepared(42L))
        assertFalse(pi.isPrepared(project))
    }

    @Test
    fun providerInvalidReprepareOnceAndRetries() {
        val fake = FakeBackend()
        val pi = PlayIntegrity(fake)
        request(pi).getOrThrow()
        fake.requestFailures.add(StandardIntegrityErrorCode.INTEGRITY_TOKEN_PROVIDER_INVALID)
        val t = request(pi).getOrThrow()
        assertTrue(t.reprepared)
        assertTrue(t.prepared)
        assertEquals("token-2-$requestHash", t.token)
        assertEquals(2, fake.prepares)
    }

    @Test
    fun providerInvalidTwiceFailsWithoutLooping() {
        val fake = FakeBackend()
        val pi = PlayIntegrity(fake)
        fake.requestFailures.add(PlayIntegrity.PROVIDER_INVALID)
        fake.requestFailures.add(PlayIntegrity.PROVIDER_INVALID)
        val e = request(pi).exceptionOrNull() as IntegrityError
        assertEquals(-19, e.errorCode)
        assertEquals(2, fake.prepares)
        assertFalse("the invalid provider is dropped", pi.isPrepared(project))
    }

    @Test
    fun otherFailuresSurfaceTheirCode() {
        val fake = FakeBackend()
        val pi = PlayIntegrity(fake)
        fake.requestFailures.add(StandardIntegrityErrorCode.TOO_MANY_REQUESTS)
        val e = request(pi).exceptionOrNull() as IntegrityError
        assertEquals(StandardIntegrityErrorCode.TOO_MANY_REQUESTS, e.errorCode)
        assertEquals(1, fake.prepares)
        val json = e.toJson()
        assertEquals("integrity", json.getString("error"))
        assertEquals(StandardIntegrityErrorCode.TOO_MANY_REQUESTS, json.getInt("errorCode"))
        assertTrue("the provider survives a non-provider failure", pi.isPrepared(project))
    }

    @Test
    fun aFailedPrepareIsNotCached() {
        val fake = FakeBackend()
        fake.prepareFailure = StandardIntegrityErrorCode.CLOUD_PROJECT_NUMBER_IS_INVALID
        val pi = PlayIntegrity(fake)
        val e = request(pi).exceptionOrNull() as IntegrityError
        assertEquals(StandardIntegrityErrorCode.CLOUD_PROJECT_NUMBER_IS_INVALID, e.errorCode)
        assertFalse(pi.isPrepared(project))
        fake.prepareFailure = null
        assertTrue(request(pi).isSuccess)
        assertEquals(2, fake.prepares)
    }

    @Test
    fun badInputIsRefusedBeforePlay() {
        val fake = FakeBackend()
        val pi = PlayIntegrity(fake)
        assertTrue(request(pi, cloud = 0).isFailure)
        assertTrue(request(pi, hash = "").isFailure)
        assertTrue(request(pi, hash = "x".repeat(501)).isFailure)
        assertTrue(request(pi, hash = "x".repeat(500)).isSuccess)
        assertEquals(1, fake.prepares)
    }

    @Test
    fun errorOfMapsForeignExceptions() {
        val e = IntegrityError.of(IllegalStateException("Failed to bind to the service."))
        assertEquals("java.lang.IllegalStateException", e.exception)
        assertNull(e.errorCode)
        assertEquals(JSONNull, e.toJson().get("errorCode"))
    }

    private companion object {
        val JSONNull: Any = org.json.JSONObject.NULL
    }
}
