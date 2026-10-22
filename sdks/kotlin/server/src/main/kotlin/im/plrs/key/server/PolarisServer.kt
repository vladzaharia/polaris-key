// The server core's facade: the trust sets (§14.4), the verified-document cache and the verdict,
// shaped for a framework adapter. `authenticate` is the whole request-time API; `start` begins the
// 900 s trust refresh, `close` ends it.
//
// Nothing here logs a header, a JWS or a holder. `onVerdict(code, step)` reports every verdict for
// metrics and carries neither.

package im.plrs.key.server

import im.plrs.key.core.Base64Url
import im.plrs.key.core.CLOCK_SKEW_SECONDS
import im.plrs.key.core.Endpoints
import im.plrs.key.core.OkHttpTransport
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisTransport
import im.plrs.key.core.SdkId
import im.plrs.key.core.SignedInUser
import im.plrs.key.core.TrustSet
import im.plrs.key.core.VerifyTrustManifestOptions
import im.plrs.key.core.HeaderName
import im.plrs.key.core.jwsHeaderKid
import im.plrs.key.core.mergeTrust
import im.plrs.key.core.trustSignerOrder
import im.plrs.key.core.usablePins
import im.plrs.key.core.verifyTrustManifest
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull

private const val CONFIG_HINT = "build it from the file `pkey sdk --lang kotlin --write` generates: " +
    "PolarisProduct(PolarisConfig.PRODUCT_SLUG, PolarisConfig.pinnedKeys, PolarisConfig.BASE_URL)"

/** A raw Ed25519 public key, base64url: what a pin is. */
private val PIN = Regex("^[A-Za-z0-9_-]{43}$")

/**
 * One product this backend serves. Build it from the app's generated `PolarisConfig`:
 * `PolarisProduct(PolarisConfig.PRODUCT_SLUG, PolarisConfig.pinnedKeys, PolarisConfig.BASE_URL)`.
 * A product that could never verify a document (no slug, no pin, a malformed pin, a bad base URL)
 * throws `IllegalArgumentException` here, at startup, with the fix.
 */
public data class PolarisProduct @JvmOverloads constructor(
    val slug: String,
    /** The pinned trust set: the only root. */
    val pinnedKeys: TrustSet,
    val baseUrl: String = "https://key.plrs.im",
) {
    init {
        require(slug.isNotEmpty()) { "PolarisProduct: the product slug is empty; $CONFIG_HINT" }
        require(pinnedKeys.isNotEmpty()) {
            "PolarisProduct: the pinned keys for \"$slug\" are empty, so no license could verify; run `pkey sdk --lang kotlin --write` to write the product's keys"
        }
        for ((kid, key) in pinnedKeys) {
            require(PIN.matches(key)) {
                "PolarisProduct: the pinned key \"$kid\" for \"$slug\" is not a raw Ed25519 public key (43 base64url characters); copy it from Core > Keys & secrets or rerun `pkey sdk --lang kotlin --write`"
            }
        }
        try {
            Endpoints(baseUrl, slug)
        } catch (e: PolarisException) {
            throw IllegalArgumentException(
                "PolarisProduct: baseUrl \"$baseUrl\" for \"$slug\" is not an https origin such as https://key.plrs.im (http only on localhost): ${e.message}",
                e,
            )
        }
    }
}

public data class PolarisServerOptions @JvmOverloads constructor(
    /** The products served, in order; a document's `aud` picks its trust set. The first is the challenge's realm. */
    val products: List<PolarisProduct>,
    /** Tighten the freshness window: seconds after `issuedAt`, plus the 300 s skew, never past `graceUntil`. */
    val maxAgeSeconds: Long? = null,
    /** Fetch the signed trust manifest at start, every 900 s and on an unknown `kid`. False: the pins alone. */
    val trustRefresh: Boolean = true,
    /** Defaults to [OkHttpTransport]. */
    val transport: PolarisTransport? = null,
    /** The server's clock, epoch seconds. */
    val clock: (() -> Long)? = null,
    /** Reports every verdict: the code (null for a pass) and the step. Carries no header and no document. */
    val onVerdict: ((code: String?, step: Int) -> Unit)? = null,
    val cacheSize: Int = 1000,
    /**
     * Debug lines: the step, the key id, the audience and a short device hash per verdict, and why a
     * trust fetch failed. Never the header, the document or the holder. Null: silent.
     */
    val debug: ((line: String) -> Unit)? = null,
) {
    init {
        require(products.isNotEmpty()) { "PolarisServerOptions: products names no product; $CONFIG_HINT" }
        val slugs = products.map { it.slug }
        require(slugs.toSet().size == slugs.size) { "PolarisServerOptions: products repeats the slug \"${slugs.first { s -> slugs.count { it == s } > 1 }}\"" }
        require(maxAgeSeconds == null || maxAgeSeconds >= 0) { "PolarisServerOptions: maxAgeSeconds is negative; pass seconds of age to accept, or null for the document's own window" }
        require(cacheSize >= 0) { "PolarisServerOptions: cacheSize is negative" }
    }
}

/** A refusal raised into the framework's own error pipeline (`errors = throw`). */
public class PolarisKeyError(public val problem: BackendProblem) : RuntimeException(problem.code) {
    /** The refusal's code, for example `not_entitled`. */
    public val code: String get() = problem.code
    public val status: Int get() = problem.status
    public val headers: Map<String, String> get() = problem.headers
}

/** The refusal a gate sends: status, headers, the localized title and detail, and the JSON body. */
public typealias PolarisProblem = BackendProblem

/** What a passing document gives the route. Its [toString] never carries the holder. */
public class PolarisLicense internal constructor(
    public val product: String,
    public val id: String,
    public val deviceId: String,
    public val tier: String?,
    public val issuedAt: Long,
    public val ageSeconds: Long,
    public val holder: Holder?,
    public val user: SignedInUser?,
    private val entitlements: Map<String, JsonElement>,
) {
    /** Boolean entitlement [name] is true. */
    public fun isEntitled(name: String): Boolean = (entitlements[name] as? kotlinx.serialization.json.JsonPrimitive)?.let { !it.isString && it.content == "true" } == true

    /** The entitlement [name]'s value, or null. */
    public fun value(name: String): JsonElement? = entitlements[name]?.takeIf { it !is JsonNull }

    /** The first of [requirements], in order, that this licence does not meet, or null. */
    public fun unmet(requirements: List<BackendRequirement>): BackendRefusal? =
        unmetRequirement(requirements, tier, user != null) { entitlements[it] }

    override fun toString(): String = "PolarisLicense(product=$product, tier=$tier)"
}

/** The request's context in every language's shape: [license] or [problem], never both. */
public class PolarisAuth(
    public val license: PolarisLicense?,
    public val problem: BackendProblem?,
) {
    public val user: SignedInUser? get() = license?.user
}

private class ProductTrust(val product: PolarisProduct) {
    val lock = Mutex()
    @Volatile var effective: TrustSet = product.pinnedKeys
    var discovered: TrustSet = emptyMap()
    var tombstones: List<String> = emptyList()
    var lastIssuedAt: Long? = null
    @Volatile var lastFetchAt: Long = Long.MIN_VALUE / 2
}

public class PolarisServer(public val options: PolarisServerOptions) : AutoCloseable {
    private val clock: () -> Long = options.clock ?: { System.currentTimeMillis() / 1000 }
    private val transport: PolarisTransport = options.transport ?: OkHttpTransport()
    private val ownsTransport = options.transport == null
    private val trusts = options.products.associate { it.slug to ProductTrust(it) }
    private val slugs = options.products.map { it.slug }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val started = AtomicBoolean(false)
    private var refreshJob: Job? = null

    // The verified-document cache: an LRU keyed by the header's SHA-256, dropped when a trust set changes.
    private val cache = object : LinkedHashMap<String, VerifiedDocument>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, VerifiedDocument>): Boolean = size > options.cacheSize
    }

    /** Fetch the trust manifests now and every 900 s. Idempotent; a failed fetch keeps the last verified set. */
    public fun start() {
        if (!options.trustRefresh || !started.compareAndSet(false, true)) return
        refreshJob = scope.launch {
            while (true) {
                for (t in trusts.values) {
                    try {
                        refresh(t, unknownKid = false)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        // A failed refresh keeps the last verified set; the loop must not die.
                    }
                }
                delay(BackendWire.TRUST_REFRESH_SECONDS * 1000)
            }
        }
    }

    override fun close() {
        refreshJob?.cancel()
        scope.cancel()
        if (ownsTransport) (transport as? AutoCloseable)?.close()
    }

    /** The trust set of [slug] now: the pins plus the last verified manifest's keys. */
    public fun trustFor(slug: String): TrustSet = trusts[slug]?.effective ?: emptyMap()

    /** The problem for [code], in the locale [acceptLanguage] names. */
    public fun problem(code: String, acceptLanguage: String?): BackendProblem = backendProblem(code, acceptLanguage, slugs.first())

    /**
     * Decide a request from its header fields. [require] are the route's requirements, in order.
     * A refusal is a [BackendVerdict] with [BackendVerdict.refusal]; use [authenticate] for the
     * request-shaped result.
     */
    public suspend fun verdict(headers: Iterable<Pair<String, String>>, require: List<BackendRequirement> = emptyList()): BackendVerdict {
        val fields = headers.toList()
        val route = BackendOptions(slugs, options.maxAgeSeconds, require)
        var verdict = decide(fields, clock(), route) { jws -> verify(jws) }
        if (verdict.refusal == BackendRefusal.LicenseInvalid && verdict.step == 3 && options.trustRefresh) {
            // An unknown `kid` refreshes the manifests, at most once a minute per product, then decides again.
            val kid = backendHeaderElements(fields, BackendWire.HEADER_LICENSE).singleOrNull()?.let(::jwsHeaderKid)
            if (kid != null && trusts.values.none { kid in it.effective } && refreshForUnknownKid()) {
                verdict = decide(fields, clock(), route) { jws -> verify(jws) }
            }
        }
        options.onVerdict?.invoke(verdict.code, verdict.step)
        options.debug?.let { debug -> debug(verdictLine(fields, verdict)) }
        return verdict
    }

    /**
     * Step 6 on an already authenticated request: the problem for the first of [requirements] that
     * [license] does not meet, in [acceptLanguage]'s locale, or null. Reports a refusal to
     * `onVerdict`; [authenticate] has already reported the pass.
     */
    public fun refusalFor(license: PolarisLicense, requirements: List<BackendRequirement>, acceptLanguage: String? = null): BackendProblem? {
        val unmet = license.unmet(requirements) ?: return null
        options.onVerdict?.invoke(unmet.code, 6)
        return problem(unmet.code, acceptLanguage)
    }

    private fun verdictLine(fields: List<Pair<String, String>>, v: BackendVerdict): String {
        val jws = backendHeaderElements(fields, BackendWire.HEADER_LICENSE).firstOrNull()
        val kid = jws?.takeIf { it.length <= BackendWire.LICENSE_MAX_BYTES }?.let(::jwsHeaderKid)
        val step = when (v.refusal) {
            null -> "pass"
            BackendRefusal.LicenseRequired -> "credential"
            BackendRefusal.LicenseInvalid -> "verify"
            BackendRefusal.LicenseStale -> "fresh"
            else -> "require"
        }
        val ctx = v.context
        return "polaris-key: $step ${v.code ?: "ok"} kid=${kid ?: "-"} aud=${ctx?.license?.product ?: "-"} device=${ctx?.let { shortHash(it.license.deviceId) } ?: "-"}"
    }

    /** Eight hex characters of an FNV-1a fold of [s]: it only lets a log line tell devices apart. */
    private fun shortHash(s: String): String {
        var h = 0x811c9dc5L
        for (c in s) {
            h = (h xor c.code.toLong()) and 0xffffffffL
            h = (h * 0x01000193L) and 0xffffffffL
        }
        return h.toString(16).padStart(8, '0')
    }

    /** [verdict], shaped as the request's [PolarisAuth]; the problem is in [acceptLanguage]'s locale. */
    public suspend fun authenticate(
        headers: Iterable<Pair<String, String>>,
        require: List<BackendRequirement> = emptyList(),
        acceptLanguage: String? = null,
    ): PolarisAuth {
        val v = verdict(headers, require)
        val refusal = v.refusal
        if (refusal != null) return PolarisAuth(null, problem(refusal.code, acceptLanguage))
        return PolarisAuth(licenseOf(v), null)
    }

    internal fun licenseOf(v: BackendVerdict): PolarisLicense {
        val ctx = v.context!!
        val doc = v.document!!
        return PolarisLicense(
            product = ctx.license.product,
            id = ctx.license.id,
            deviceId = ctx.license.deviceId,
            tier = ctx.license.tier,
            issuedAt = ctx.license.issuedAt,
            ageSeconds = ctx.license.ageSeconds,
            holder = ctx.license.holder,
            user = ctx.user,
            entitlements = doc.entitlements.mapValues { it.value.value },
        )
    }

    /** Bumped, with the cache clear, whenever a trust set changes. Guarded by `synchronized(cache)`. */
    private var trustGeneration: Long = 0

    /** Test seams. */
    internal var beforeCacheInsert: (() -> Unit)? = null
    internal fun cacheSize(): Int = synchronized(cache) { cache.size }
    internal suspend fun refreshAll() {
        for (t in trusts.values) refresh(t, unknownKid = false)
    }

    private fun key(jws: String): String = Base64Url.encode(MessageDigest.getInstance("SHA-256").digest(jws.toByteArray(Charsets.UTF_8)))

    private fun verify(jws: String): VerifiedDocument? {
        val k = key(jws)
        synchronized(cache) { cache[k] }?.let { return it }
        // Read the generation before the snapshot: a trust change in between leaves the result uncached.
        val generation = synchronized(cache) { trustGeneration }
        val trust = trusts.mapValues { it.value.effective }
        val verified = verifyBackendDocument(jws, slugs, trust) ?: return null
        beforeCacheInsert?.invoke()
        synchronized(cache) { if (trustGeneration == generation) cache[k] = verified }
        return verified
    }

    private suspend fun refreshForUnknownKid(): Boolean {
        var changed = false
        for (t in trusts.values) {
            if (refresh(t, unknownKid = true)) changed = true
        }
        return changed
    }

    /** One fetch and verify of [t]'s manifest. True when it changed the trust set. */
    private suspend fun refresh(t: ProductTrust, unknownKid: Boolean): Boolean = t.lock.withLock {
        // The unknown-kid gate lives under the lock: concurrent junk makes one fetch a minute.
        if (unknownKid && clock() - t.lastFetchAt < 60) return@withLock false
        t.lastFetchAt = clock()
        val endpoints = Endpoints(t.product.baseUrl, t.product.slug)
        val first = fetch(t, endpoints.trustManifest) ?: return@withLock false
        var applied = apply(t, first)
        if (!applied) {
            val usable = usablePins(t.product.pinnedKeys, t.tombstones)
            for (signer in trustSignerOrder(usable, jwsHeaderKid(first))) {
                val retry = fetch(t, endpoints.trustManifest + "?signer=" + java.net.URLEncoder.encode(signer, "UTF-8").replace("+", "%20")) ?: continue
                if (apply(t, retry)) {
                    applied = true
                    break
                }
            }
        }
        if (!applied) {
            options.debug?.invoke("trust: the manifest for ${t.product.slug} was not accepted (not signed by a pinned key, for another product, or no newer than the last); keeping the last verified keys and the pins")
        }
        applied
    }

    private fun apply(t: ProductTrust, jws: String): Boolean {
        val result = verifyTrustManifest(
            jws,
            VerifyTrustManifestOptions(
                pinned = t.product.pinnedKeys, tombstones = t.tombstones, expectedAud = t.product.slug,
                now = clock(), lastTrustIssuedAt = t.lastIssuedAt,
            ),
        )
        val doc = result.doc ?: return false
        t.tombstones = (t.tombstones + result.revokedPins).distinct()
        t.discovered = result.discovered
        t.lastIssuedAt = doc.issuedAt
        val next = mergeTrust(usablePins(t.product.pinnedKeys, t.tombstones), t.discovered)
        val changed = next != t.effective
        t.effective = next
        if (changed) synchronized(cache) {
            trustGeneration++
            cache.clear()
        }
        return true
    }

    private suspend fun fetch(t: ProductTrust, url: String): String? {
        val response = try {
            transport.send(PolarisRequest(url = url, headers = mapOf("accept" to "application/jose", HeaderName.sdkName to SdkId.kotlinServer), maxBodyBytes = MAX_MANIFEST_BYTES + 1))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            options.debug?.invoke("trust: fetch failed for ${t.product.slug} (${reasonOf(e)}); keeping the last verified keys and the pins")
            return null
        }
        if (!response.isOk) {
            options.debug?.invoke("trust: ${t.product.baseUrl} answered ${response.status} for ${t.product.slug}; check baseUrl and the product slug")
            return null
        }
        if (response.body.size > MAX_MANIFEST_BYTES) {
            options.debug?.invoke("trust: the manifest for ${t.product.slug} is larger than $MAX_MANIFEST_BYTES bytes; ignoring it")
            return null
        }
        return response.text
    }

    /** A short, secret-free reason for a failed fetch: the exception's name and message. */
    private fun reasonOf(e: Exception): String {
        val inner = e.cause?.let { ": ${it.message ?: it.javaClass.simpleName}" } ?: ""
        return "${e.javaClass.simpleName}: ${e.message ?: "no message"}$inner".take(200)
    }

    private companion object {
        const val MAX_MANIFEST_BYTES = 400_000
    }
}
