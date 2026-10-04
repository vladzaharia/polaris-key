package im.plrs.key.platform.play

import android.content.Context
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.StandardIntegrityException
import com.google.android.play.core.integrity.StandardIntegrityManager
import com.google.android.play.core.integrity.StandardIntegrityManager.PrepareIntegrityTokenRequest
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityTokenProvider
import com.google.android.play.core.integrity.StandardIntegrityManager.StandardIntegrityTokenRequest
import com.google.android.play.core.integrity.model.StandardIntegrityErrorCode
import im.plrs.key.platform.IntegrityResult
import im.plrs.key.platform.PlatformIntegrity
import im.plrs.key.platform.PlatformIntegrityToken
import org.json.JSONObject

/**
 * A Play Integrity failure. [errorCode] is the `StandardIntegrityErrorCode` when Play gave one
 * (e.g. -19 INTEGRITY_TOKEN_PROVIDER_INVALID, -16 CLOUD_PROJECT_NUMBER_IS_INVALID, -8
 * TOO_MANY_REQUESTS, -3 NETWORK_ERROR); without Play services the failure is an internal bind
 * error with no code, as for In-App Updates (notes/S-10 §1).
 */
public class IntegrityError(public val exception: String, message: String?, public val errorCode: Int?) : Exception(message) {
    public fun toJson(): JSONObject = JSONObject()
        .put("error", "integrity")
        .put("exception", exception)
        .put("message", message ?: JSONObject.NULL)
        .put("errorCode", errorCode ?: JSONObject.NULL)

    public companion object {
        public fun of(e: Throwable?): IntegrityError = e as? IntegrityError ?: IntegrityError(
            e?.javaClass?.name ?: "null",
            e?.message,
            (e as? StandardIntegrityException)?.errorCode,
        )
    }
}

/** A prepared standard token provider: one `request(requestHash)` per verdict. */
public fun interface IntegrityTokenSource {
    public fun request(requestHash: String, callback: (Result<String>) -> Unit)
}

/** Where providers come from: Play's [StandardIntegrityManager], or a fake in tests. */
public fun interface IntegrityBackend {
    public fun prepare(cloudProjectNumber: Long, callback: (Result<IntegrityTokenSource>) -> Unit)
}

/** The real backend over `IntegrityManagerFactory.createStandard`. */
public class PlayIntegrityBackend(private val manager: StandardIntegrityManager) : IntegrityBackend {
    public constructor(context: Context) : this(IntegrityManagerFactory.createStandard(context))

    override fun prepare(cloudProjectNumber: Long, callback: (Result<IntegrityTokenSource>) -> Unit) {
        val task = try {
            manager.prepareIntegrityToken(PrepareIntegrityTokenRequest.builder().setCloudProjectNumber(cloudProjectNumber).build())
        } catch (e: Exception) {
            callback(Result.failure(IntegrityError.of(e)))
            return
        }
        task.addOnCompleteListener { t ->
            val provider: StandardIntegrityTokenProvider? = if (t.isSuccessful) t.result else null
            if (provider != null) callback(Result.success(Source(provider))) else callback(Result.failure(IntegrityError.of(t.exception)))
        }
    }

    private class Source(private val provider: StandardIntegrityTokenProvider) : IntegrityTokenSource {
        override fun request(requestHash: String, callback: (Result<String>) -> Unit) {
            val task = try {
                provider.request(StandardIntegrityTokenRequest.builder().setRequestHash(requestHash).build())
            } catch (e: Exception) {
                callback(Result.failure(IntegrityError.of(e)))
                return
            }
            task.addOnCompleteListener { t ->
                val token = if (t.isSuccessful) t.result?.token() else null
                if (token != null) callback(Result.success(token)) else callback(Result.failure(IntegrityError.of(t.exception)))
            }
        }
    }
}

/** A token and how it was obtained ([prepared]: this call had to prepare a provider first). */
public data class IntegrityToken(val token: String, val prepared: Boolean, val reprepared: Boolean) {
    public fun toJson(): JSONObject = JSONObject().put("token", token).put("prepared", prepared).put("reprepared", reprepared)
}

/**
 * The STANDARD Play Integrity API (notes/E2 §A5): `prepareIntegrityToken(cloudProjectNumber)` once
 * (a warm-up of seconds), then `request(requestHash)` per verdict (~100–300 ms). The provider is
 * cached per cloud project number; when Play answers INTEGRITY_TOKEN_PROVIDER_INVALID the provider
 * is dropped, prepared again and the request retried once, as Google documents. Verdicts are never
 * cached here: the Worker's challenge makes every token single-use.
 *
 * The request hash is the Worker's `requestHash` string, passed verbatim (at most 500 characters).
 * Call from Android's main thread; callbacks arrive there.
 */
public class PlayIntegrity(private val backend: IntegrityBackend) {
    public constructor(context: Context) : this(PlayIntegrityBackend(context))

    private var provider: IntegrityTokenSource? = null
    private var providerProject: Long? = null

    /** Whether a provider for [cloudProjectNumber] is ready. */
    @Synchronized
    public fun isPrepared(cloudProjectNumber: Long): Boolean = provider != null && providerProject == cloudProjectNumber

    /** Prepare (or keep) the provider for [cloudProjectNumber]. */
    public fun prepare(cloudProjectNumber: Long, callback: (Result<Boolean>) -> Unit) {
        if (isPrepared(cloudProjectNumber)) {
            callback(Result.success(false))
            return
        }
        backend.prepare(cloudProjectNumber) { r ->
            r.fold(
                { source ->
                    synchronized(this) {
                        provider = source
                        providerProject = cloudProjectNumber
                    }
                    callback(Result.success(true))
                },
                { callback(Result.failure(IntegrityError.of(it))) },
            )
        }
    }

    /** A standard integrity token bound to [requestHash], preparing the provider first if needed. */
    public fun request(cloudProjectNumber: Long, requestHash: String, callback: (Result<IntegrityToken>) -> Unit) {
        if (cloudProjectNumber <= 0) {
            callback(Result.failure(IntegrityError("IllegalArgumentException", "cloudProjectNumber must be positive", null)))
            return
        }
        if (requestHash.isEmpty() || requestHash.length > MAX_REQUEST_HASH) {
            callback(Result.failure(IntegrityError("IllegalArgumentException", "requestHash must be 1..$MAX_REQUEST_HASH characters", null)))
            return
        }
        attempt(cloudProjectNumber, requestHash, reprepared = false, callback)
    }

    private fun attempt(cloudProjectNumber: Long, requestHash: String, reprepared: Boolean, callback: (Result<IntegrityToken>) -> Unit) {
        prepare(cloudProjectNumber) { p ->
            p.fold(
                { prepared ->
                    val source = synchronized(this) { provider }
                    if (source == null) {
                        callback(Result.failure(IntegrityError("IllegalStateException", "no provider", null)))
                        return@fold
                    }
                    source.request(requestHash) { r ->
                        r.fold(
                            { callback(Result.success(IntegrityToken(it, prepared || reprepared, reprepared))) },
                            { e ->
                                val err = IntegrityError.of(e)
                                // An invalid provider is never kept; it is prepared again once per request.
                                if (err.errorCode == PROVIDER_INVALID) invalidate(source)
                                if (err.errorCode == PROVIDER_INVALID && !reprepared) {
                                    attempt(cloudProjectNumber, requestHash, reprepared = true, callback)
                                } else {
                                    callback(Result.failure(err))
                                }
                            },
                        )
                    }
                },
                { callback(Result.failure(it)) },
            )
        }
    }

    @Synchronized
    private fun invalidate(source: IntegrityTokenSource) {
        if (provider === source) {
            provider = null
            providerProject = null
        }
    }

    public companion object {
        /** StandardIntegrityErrorCode.INTEGRITY_TOKEN_PROVIDER_INVALID (-19). */
        public const val PROVIDER_INVALID: Int = StandardIntegrityErrorCode.INTEGRITY_TOKEN_PROVIDER_INVALID

        /** The longest request hash Play accepts. */
        public const val MAX_REQUEST_HASH: Int = PlatformIntegrity.MAX_REQUEST_HASH
    }
}

/**
 * [PlatformIntegrity] over [PlayIntegrity], the `play` flavour's answer to
 * [PlatformIntegrity.create]: arguments are checked first ([IntegrityResult.Refused], Play never
 * asked), then Play's failures become [IntegrityResult.Failed] with their error code. The
 * [PlayIntegrity] (and so Play's StandardIntegrityManager) is created on first use.
 */
public class PlayPlatformIntegrity(integrity: () -> PlayIntegrity) : PlatformIntegrity {
    public constructor(integrity: PlayIntegrity) : this({ integrity })

    private val play: PlayIntegrity by lazy(integrity)

    override val isSupported: Boolean get() = true

    override fun prepare(cloudProjectNumber: Long, callback: (IntegrityResult<Boolean>) -> Unit) {
        PlatformIntegrity.refusal(cloudProjectNumber, null)?.let {
            callback(IntegrityResult.Refused(it))
            return
        }
        play.prepare(cloudProjectNumber) { r -> callback(r.fold({ IntegrityResult.Success(it) }, { failed(it) })) }
    }

    override fun request(
        cloudProjectNumber: Long,
        requestHash: String,
        callback: (IntegrityResult<PlatformIntegrityToken>) -> Unit,
    ) {
        PlatformIntegrity.refusal(cloudProjectNumber, requestHash)?.let {
            callback(IntegrityResult.Refused(it))
            return
        }
        play.request(cloudProjectNumber, requestHash) { r ->
            callback(r.fold({ IntegrityResult.Success(PlatformIntegrityToken(it.token, it.prepared, it.reprepared)) }, { failed(it) }))
        }
    }

    private fun failed(e: Throwable): IntegrityResult.Failed {
        val err = IntegrityError.of(e)
        return IntegrityResult.Failed(err.exception, err.message, err.errorCode)
    }
}
