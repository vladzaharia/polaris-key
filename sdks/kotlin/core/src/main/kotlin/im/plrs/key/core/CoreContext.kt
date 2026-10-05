// Core's live state and the sync pass — wire contract v3 §4–§6, the analogue of Swift's
// `CoreContext` actor.
//
// Core owns the device principal, the credential, the trust set, the verified cache, the monotonic
// clock floor, discovery and the sync pass; a service module (:license, :config, … from P6-07) owns
// its own routes and the reads they feed, and plugs into the pass through the two injected
// closures (`reacquire` for §5's single re-acquire, `report` for telemetry).
//
// Concurrency: suspend functions; the mutable state is guarded by one Mutex held only for
// bookkeeping, never across network I/O, so the licence and config fetches of one pass overlap.

package im.plrs.key.core

import java.io.File
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject

/** What Core needs. Per-service inputs live in that service's own options. */
public data class CoreOptions(
    val productSlug: String,
    /** MUST be `https:`, or `http://localhost` / `http://127.0.0.1` for local development. */
    val baseUrl: String = "https://key.plrs.im",
    /** The HOST APPLICATION's version, sent as `X-PKey-Version`. */
    val version: String,
    /** Release channel; derived from [version] when null. */
    val channel: String? = null,
    /** Pinned trust set: the ONLY root (§1). */
    val pinnedKeys: TrustSet,
    /** Refresh the signed trust manifest inside `sync()` on Core's own cadence (§4.2). */
    val trustRefresh: Boolean = true,
    /** Defaults to a [FileStore] in [FileStore.defaultDirectory]. */
    val store: Store? = null,
    /** Defaults to [OkHttpTransport]; [NoNetworkTransport] gives the §7.3 local-only build. */
    val transport: PolarisTransport? = null,
    /** Per-request deadline in seconds; 0 disables it. */
    val requestTimeoutSeconds: Double = 15.0,
    /** What this build expects the product to run: the D-21 fallback before discovery answers. */
    val expectedServices: List<ServiceSlug>? = null,
    /** The system clock, epoch SECONDS; every claim check and gate comparison reads it. */
    val clock: (() -> Long)? = null,
    /**
     * This device's label (WIRE-CONTRACT-V4 §12.7.1): what the sign-in page and the customer's
     * device list call it. Null: the platform default; `""`: send none.
     */
    val deviceName: String? = null,
    /** The platform's own device name; null: the JVM host name (the Android glue supplies its own). */
    val defaultDeviceName: (() -> String?)? = null,
)

/** The status taxonomy every signed-document GET collapses to (§5). */
public sealed interface DocumentResult {
    public data class Ok(val jws: String, val etag: String?) : DocumentResult
    public data object NotModified : DocumentResult
    public data object Unauthorized : DocumentResult
    public data class DeviceCap(val limit: Long?, val deviceCount: Long?) : DocumentResult
    public data class Blocked(val reason: BlockReason, val allowedRange: AllowedRange?) : DocumentResult
    public data class Error(val status: Int, val message: String) : DocumentResult
}

/** What happened to one document in a pass. */
public sealed interface DocOutcome {
    public data object Applied : DocOutcome
    public data object Unchanged : DocOutcome
    public data object Unauthorized : DocOutcome
    public data class Blocked(val info: BlockInfoRecord) : DocOutcome
    public data class DeviceCap(val limit: Long?, val deviceCount: Long?) : DocOutcome

    /** The product does not run this service: nothing was fetched. */
    public data object Skipped : DocOutcome
    public data object Error : DocOutcome
}

public data class SyncResult(
    /** True when ANY document's content changed and was applied. */
    val applied: Boolean = false,
    /** A document fetch ended on a hard 401 after the single re-acquire. */
    val unauthorized: Boolean = false,
    /** `/license/document` answered 403 with a version or channel block. */
    val blocked: Boolean = false,
    val deviceCap: Boolean = false,
    val documents: Map<DocumentSlice, DocOutcome> = emptyMap(),
)

/** One re-verified document slice: the decoded payload and the artifact it came from. */
public data class CachedDoc<T : DocClaims>(val jws: String, val doc: T)

/** What a cache load produced; every field DERIVED from a signature just checked. */
public data class LoadedCache(
    val license: CachedDoc<LicenseDoc>? = null,
    val config: CachedDoc<ConfigDoc>? = null,
    val importedBundle: ImportedBundle? = null,
    val lastSyncUnauthorized: Boolean = false,
    val blocked: BlockInfoRecord? = null,
    /** Epoch MILLIseconds of the last verification. */
    val lastVerifiedAt: Long? = null,
)

/** How the current device token was obtained in this process. */
public enum class TokenSource(public val wire: String) {
    activate("activate"), enroll("enroll"), register("register"), signin("signin"), reacquire("reacquire"),
}

/** The two routes §5's single re-acquire can take. */
public enum class ReacquireRoute(public val wire: String) {
    licenseToken("license-token"), devicesRegister("devices-register"),
}

/** Pick the route for §5's single re-acquire (the same rule in every SDK, P1b-06). */
public fun chooseReacquireRoute(licenseEnabled: Boolean, source: TokenSource?): ReacquireRoute = when {
    !licenseEnabled -> ReacquireRoute.devicesRegister
    source == TokenSource.register -> ReacquireRoute.devicesRegister
    else -> ReacquireRoute.licenseToken
}

/** A re-acquired token and how it was obtained. */
public data class Reacquired(val token: String, val source: TokenSource)

/** §5's single re-acquire, injected so Core does not depend on the licence module. */
public typealias ReacquireFn = suspend (current: String, source: TokenSource?) -> Reacquired?

public class CoreContext(options: CoreOptions) {
    public val product: String = options.productSlug

    /** Throws `insecure-base-url` before anything else happens. */
    public val endpoints: Endpoints = Endpoints(options.baseUrl, options.productSlug)
    public val version: String = options.version
    public val channel: String = options.channel ?: Semver.channelForVersion(options.version).wire
    public val pinnedTrust: TrustSet = options.pinnedKeys
    public val trustRefreshEnabled: Boolean = options.trustRefresh
    public val store: Store = options.store ?: FileStore(options.productSlug, FileStore.defaultDirectory(options.productSlug))
    public val transport: PolarisTransport = options.transport ?: OkHttpTransport()
    public val requestTimeoutSeconds: Double = options.requestTimeoutSeconds

    /** True when the transport refuses to dial (§7.3). */
    public val localOnly: Boolean = transport === NoNetworkTransport
    private val expectedServices = options.expectedServices
    private val deviceNameOption = options.deviceName
    private val defaultDeviceNameHook: () -> String? = options.defaultDeviceName ?: ::jvmDefaultDeviceName

    /** The label to send (§12.7.1): [override], else `CoreOptions.deviceName`, else the platform default; null sends none. */
    public fun deviceLabel(override: String? = null): String? = resolveDeviceLabel(override, deviceNameOption, defaultDeviceNameHook)
    private val systemClock: () -> Long = options.clock ?: { System.currentTimeMillis() / 1000 }
    private val systemClockMillis: () -> Long =
        options.clock?.let { c -> { c() * 1000 } } ?: { System.currentTimeMillis() }

    private val lock = Mutex()
    private var deviceIdValue = ""
    private var tokenValue: String? = null
    private var tokenSourceValue: TokenSource? = null
    private var discoveredServices: ServicesMap? = null
    private var discoveryDocumentValue: ProductDiscoveryDocument? = null
    private var manifestKeys: TrustSet = emptyMap()
    private var manifest: TrustManifestDoc? = null
    private val clock = MonotonicClock()
    private var record: CacheRecord? = null
    private var loaded = LoadedCache()
    private var reacquireSpent = false
    private var reacquireInFlight: CompletableDeferred<Boolean>? = null
    private var feedFloorsValue: Map<String, FeedFloor> = emptyMap()

    @Volatile private var packSetIdSource: (suspend () -> String?)? = null

    /** Load device id, token and the cached artifacts, re-verifying everything. NO NETWORK. */
    public suspend fun start() {
        val deviceId = store.getDeviceId()
        val token = store.getToken()
        val cached = store.readCache()
        lock.withLock {
            deviceIdValue = deviceId
            tokenValue = token
            tokenSourceValue = null
            loadCache(cached)
        }
    }

    // ── Identity and credential ────────────────────────────────────────────────────────────
    public suspend fun deviceId(): String = lock.withLock { deviceIdValue }

    public suspend fun token(): String? = lock.withLock { tokenValue }

    public suspend fun tokenSource(): TokenSource? = lock.withLock { tokenSourceValue }

    /** Where the store keeps the token (P1b-09); null when it does not report. */
    public suspend fun storeStatus(): StoreStatus? = store.status()

    /** Store [token]; [source] is how it was obtained (null = unknown). Throws on a store failure. */
    public suspend fun setToken(token: String, source: TokenSource? = null) {
        store.setToken(token)
        lock.withLock {
            tokenValue = token
            tokenSourceValue = source
        }
    }

    /** Wipe every credential and artifact except the v4 update slices, which re-verify. */
    public suspend fun clearAll() {
        val carried = lock.withLock {
            val r = record
            tokenValue = null
            tokenSourceValue = null
            record = null
            loaded = LoadedCache()
            manifestKeys = emptyMap()
            manifest = null
            clock.reset()
            if (r == null || (r.feeds.isEmpty() && r.releaseRecords.isEmpty())) {
                feedFloorsValue = emptyMap()
                null
            } else {
                // Wire v4: a deactivation removes every credential, never the feeds' `seq` floors (a
                // floor a deactivation could reset could be rolled back). Re-verified against the
                // now pinned-only trust set.
                record = CacheRecord(feeds = r.feeds, releaseRecords = r.releaseRecords)
                reloadUpdateSlices()
                record
            }
        }
        var failure: Exception? = null
        try {
            store.clearToken()
        } catch (e: Exception) {
            failure = e
        }
        try {
            if (carried == null) store.clearCache() else store.writeCache(carried)
        } catch (e: Exception) {
            failure = failure ?: e
        }
        failure?.let { throw it }
    }

    // ── Clock (§4.2) ───────────────────────────────────────────────────────────────────────
    public suspend fun highWaterMark(): Long = lock.withLock { clock.highWaterMark }

    /** The time every gate comparison and network-path claim check runs at. */
    public suspend fun now(systemNow: Long? = null): Long = lock.withLock { clock.effectiveNow(systemNow ?: systemClock()) }

    // ── Trust (§1) ─────────────────────────────────────────────────────────────────────────
    /** The effective set: manifest keys UNION pins, pins last. */
    public suspend fun trust(): TrustSet = lock.withLock { mergeTrust(pinnedTrust, manifestKeys) }

    public suspend fun trustManifest(): TrustManifestDoc? = lock.withLock { manifest }

    /** Verify a manifest against the PINS ONLY and install what it publishes (caller holds the lock). */
    private fun applyTrustManifest(jws: String, checkFreshness: Boolean): Boolean {
        val result = verifyTrustManifest(
            jws,
            VerifyTrustManifestOptions(
                pinned = pinnedTrust, expectedAud = product, now = systemClock(),
                lastTrustIssuedAt = manifest?.issuedAt, checkFreshness = checkFreshness,
            ),
        )
        val doc = result.doc ?: return false
        manifestKeys = result.discovered
        manifest = doc
        clock.raise(doc.issuedAt)
        return true
    }

    /** Fetch, verify and install the signed trust manifest, on CORE's cadence. False keeps the old one. */
    public suspend fun refreshTrust(): Boolean {
        val response = try {
            request(endpoints.trustManifest, headers = mapOf("accept" to "application/jose"))
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            return false
        }
        if (!response.isOk || response.body.size > JwsVerifier.MAX_HEADER_B64 + JwsVerifier.MAX_PAYLOAD_B64 + 128) return false
        val jws = response.text
        val applied = lock.withLock {
            applyTrustManifest(jws, checkFreshness = true).also { ok ->
                // The effective trust set may have changed: the committed feeds are re-verified.
                if (ok) reloadUpdateSlices()
            }
        }
        if (!applied) return false
        patchCache { it.copy(trustJws = jws) }
        return true
    }

    // ── Capabilities (D-21) ────────────────────────────────────────────────────────────────
    /** Discovery this session > `expectedServices` > the suite default. No network. */
    public suspend fun services(): ServicesMap = lock.withLock { servicesLocked() }

    private fun servicesLocked(): ServicesMap =
        discoveredServices ?: expectedServices?.let { servicesFromList(it) } ?: DEFAULT_SERVICES

    public suspend fun enabled(slug: ServiceSlug): Boolean = services()[slug] == true

    /** Refuse a sub-client whose service the product does not run (typed `product` N/A). */
    public suspend fun requireService(slug: ServiceSlug, feature: String) {
        if (enabled(slug)) return
        val unsupported = Unsupported(feature, UnsupportedReason.product, "the product does not run the ${slug.slug} service")
        throw PolarisException(
            ErrorCode.serviceUnavailable, "The ${slug.slug} service is not enabled for $product.",
            detail = unsupported.detail, unsupported = unsupported,
        )
    }

    public suspend fun discoveryDocument(): ProductDiscoveryDocument? = lock.withLock { discoveryDocumentValue }

    /** Fetch the discovery document and install the product's real capability map. */
    public suspend fun discover(): DiscoveryResult {
        val result = Discovery.fetch(endpoints, transport, headers(), requestTimeoutSeconds)
        if (result is DiscoveryResult.Ok) {
            lock.withLock {
                discoveryDocumentValue = result.document
                discoveredServices = result.document.servicesMap
            }
        }
        return result
    }

    // ── Transport (§5) ─────────────────────────────────────────────────────────────────────
    /** The `X-PKey-*` metadata every product-scoped call carries. */
    public suspend fun headers(extra: Map<String, String> = emptyMap()): Map<String, String> {
        val out = linkedMapOf(
            HeaderName.device to deviceId(),
            HeaderName.version to version,
            HeaderName.channel to channel,
            HeaderName.sdkName to POLARIS_SDK_NAME,
            HeaderName.sdkVersion to POLARIS_SDK_VERSION,
        )
        RuntimeFamily.platformHeader?.let { out[HeaderName.platform] = it }
        RuntimeFamily.archHeader?.let { out[HeaderName.arch] = it }
        out.putAll(extra)
        return out
    }

    /** One request with this client's headers and deadline applied (R4-08). */
    public suspend fun request(
        url: String,
        method: String = "GET",
        headers: Map<String, String> = emptyMap(),
        body: ByteArray? = null,
        maxBodyBytes: Int? = null,
    ): PolarisResponse = transport.send(
        PolarisRequest(url, method, headers(headers), body, requestTimeoutSeconds, maxBodyBytes),
    )

    /** GET one signed document with conditional-request support; verification is NOT here. */
    public suspend fun getDocument(slice: DocumentSlice, token: String, etag: String? = null): DocumentResult {
        val extra = linkedMapOf("authorization" to "Bearer $token")
        if (etag != null) extra["if-none-match"] = etag
        val response = try {
            request(endpoints.document(slice), headers = extra)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            return DocumentResult.Error(0, e.message ?: "transport error")
        }
        return when (response.status) {
            304 -> DocumentResult.NotModified
            401 -> DocumentResult.Unauthorized
            429 -> {
                val body = JsonText.parseOrNull(response.text).objectValue
                DocumentResult.DeviceCap(body?.get("limit").longValue, body?.get("deviceCount").longValue)
            }
            403 -> {
                // v3 nests the code and keeps `allowedRange` at the top level (§5). A body that says
                // nothing falls back to the stricter reason, never the permissive one.
                val body = JsonText.parseOrNull(response.text).objectValue
                val error = body?.get("error").objectValue
                val reason = BlockReason.of(error?.get("reason").stringValue)
                    ?: BlockReason.of(body?.get("reason").stringValue)
                    ?: if (error?.get("code").stringValue == "channel_not_allowed") BlockReason.channelNotEntitled
                    else BlockReason.versionTooOld
                val range = body?.get("allowedRange").objectValue?.let { AllowedRange(it["min"].stringValue, it["max"].stringValue) }
                DocumentResult.Blocked(reason, range)
            }
            200 -> DocumentResult.Ok(response.text, response.header("etag"))
            else -> DocumentResult.Error(response.status, response.text)
        }
    }

    // ── Cache (§4.1) ───────────────────────────────────────────────────────────────────────
    public suspend fun cache(): LoadedCache = lock.withLock { loaded }

    /** The ETag held for one document (a non-security validator). */
    public suspend fun etag(slice: DocumentSlice): String? = lock.withLock { record?.etags?.get(slice) }

    /** Re-verify the whole record and derive every counter from it (caller holds the lock). */
    private fun loadCache(stored: CacheRecord?) {
        manifestKeys = emptyMap()
        manifest = null
        clock.reset()
        loaded = LoadedCache()
        if (stored == null || stored.v != CACHE_RECORD_VERSION) {
            record = null
            return
        }
        var next: CacheRecord = stored
        stored.trustJws?.let { jws ->
            if (!applyTrustManifest(jws, checkFreshness = false)) next = next.copy(trustJws = null)
        }
        var newest = 0L
        var license: CachedDoc<LicenseDoc>? = null
        var config: CachedDoc<ConfigDoc>? = null
        stored.docs[DocumentSlice.license]?.let { jws ->
            val doc = verifyCached(jws) { j, o -> verifyLicenseDoc(j, o) }
            if (doc != null) {
                license = CachedDoc(jws, doc)
                clock.raise(doc.issuedAt)
                newest = maxOf(newest, doc.issuedAt)
            } else {
                next = next.copy(docs = next.docs - DocumentSlice.license, etags = next.etags - DocumentSlice.license)
            }
        }
        stored.docs[DocumentSlice.config]?.let { jws ->
            val doc = verifyCached(jws) { j, o -> verifyConfigDoc(j, o) }
            if (doc != null) {
                config = CachedDoc(jws, doc)
                clock.raise(doc.issuedAt)
                newest = maxOf(newest, doc.issuedAt)
            } else {
                next = next.copy(docs = next.docs - DocumentSlice.config, etags = next.etags - DocumentSlice.config)
            }
        }
        loaded = LoadedCache(
            license = license,
            config = config,
            importedBundle = stored.importedBundle,
            lastSyncUnauthorized = stored.lastSyncUnauthorized == true,
            blocked = stored.blocked,
            lastVerifiedAt = if (newest > 0 && newest < Long.MAX_VALUE / 1000) newest * 1000 else null,
        )
        record = next
        // After the manifest: the feeds verify against the EFFECTIVE trust set.
        reloadUpdateSlices()
    }

    // ── Wire v4 update slices (plans/P3-01.md §2.5 "Reload path", §2.6) ──────────────────────

    /**
     * The reload path over the `feeds` and `releaseRecords` slices, on cache load and whenever the
     * effective trust set changes: each `feeds[k]` through steps 3–6 (freshness off, no floor, its
     * claim equal to `k`) gives `floors[k]`; each `releaseRecords[h]` is kept only while a surviving
     * feed's target pins `h`. The update client runs the same reload with the release keys and its
     * platform on every call (`runUpdateCheck`). Caller holds the lock.
     */
    private fun reloadUpdateSlices() {
        val r = record
        if (r == null) {
            feedFloorsValue = emptyMap()
            return
        }
        val reloaded = reloadFeeds(r.feeds, mergeTrust(pinnedTrust, manifestKeys), product, null)
        feedFloorsValue = reloaded.floors
        val pinned = reloaded.feeds.values.flatMap { c -> c.feed.app.targets.map { it.release.sha256 } }.toSet()
        record = r.copy(feeds = reloaded.feeds.mapValues { it.value.jws }, releaseRecords = r.releaseRecords.filterKeys { it in pinned })
    }

    /** Each canonical channel's `seq` floor, derived from the committed feed that re-verified. */
    public suspend fun feedFloors(): Map<String, FeedFloor> = lock.withLock { feedFloorsValue }

    /** The `feeds` and `releaseRecords` slices as Core holds them (re-verified on load). */
    public suspend fun updateSlices(): UpdateSlices = lock.withLock { UpdateSlices(record?.feeds ?: emptyMap(), record?.releaseRecords ?: emptyMap()) }

    /**
     * Write the update slices through Core's read-modify-write (§4.1's only mutation path) and
     * re-derive the floors. A null argument leaves that slice as it is.
     */
    public suspend fun commitUpdateSlices(feeds: Map<String, String>? = null, releaseRecords: Map<String, String>? = null) {
        patchCache { r -> r.copy(feeds = feeds ?: r.feeds, releaseRecords = releaseRecords ?: r.releaseRecords) }
        lock.withLock {
            feedFloorsValue = reloadFeeds(record?.feeds ?: emptyMap(), mergeTrust(pinnedTrust, manifestKeys), product, null).floors
        }
    }

    /** Register where `devices/report`'s `content.packSetId` comes from (the packs facet does). */
    public fun setPackSetIdSource(source: (suspend () -> String?)?) {
        packSetIdSource = source
    }

    /** The active pack set's `packSetId` for the device report, or null when this host has no packs. */
    public suspend fun packSetId(): String? = packSetIdSource?.invoke()

    /**
     * Re-verify a cached document at `max(now, its own issuedAt)` with freshness off, bounding how
     * far forward one artifact may drag the floor (caller holds the lock).
     */
    private fun <T : DocClaims> verifyCached(jws: String, verify: (String, VerifyOptions) -> T?): T? {
        val trust = mergeTrust(pinnedTrust, manifestKeys)
        val now = clock.effectiveNow(systemClock())
        // A signature-verified peek learns `issuedAt` (never an unauthenticated parse).
        val peek = verify(jws, VerifyOptions(trust, product, deviceIdValue, now = Long.MAX_VALUE / 2, checkFreshness = false))
            ?: return null
        if (peek.issuedAt > saturatingAdd(now, MAX_GRACE_SECONDS)) return null
        return verify(jws, VerifyOptions(trust, product, deviceIdValue, now = maxOf(now, peek.issuedAt), checkFreshness = false))
    }

    /** Read-modify-write the whole record: the ONLY mutation path (§4.1). */
    private suspend fun patchCache(mutate: (CacheRecord) -> CacheRecord) {
        val next = lock.withLock {
            val n = mutate(record ?: CacheRecord()).copy(v = CACHE_RECORD_VERSION)
            record = n
            loaded = loaded.copy(
                lastSyncUnauthorized = n.lastSyncUnauthorized == true,
                blocked = n.blocked,
                importedBundle = n.importedBundle,
            )
            n
        }
        try {
            store.writeCache(next)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            // A failed write is the store's to report (StoreException); the in-memory state holds.
        }
    }

    // ── Offline bundles (§7) ───────────────────────────────────────────────────────────────
    /** Verify an offline bundle and, only when every step passed, write it atomically. No token is created. */
    public suspend fun importBundle(jws: String): VerifiedBundle {
        val now = now()
        val inspection = inspectBundle(jws, BundleOptions(pinnedTrust, product, deviceId(), now))
        val bundle = when (inspection) {
            is BundleInspection.Ok -> inspection.bundle
            is BundleInspection.Refused -> throw PolarisException(inspection.reason.code, "the offline bundle was refused at ${inspection.reason.code}")
        }
        val stored = lock.withLock {
            val base = record ?: CacheRecord()
            val docs = LinkedHashMap<DocumentSlice, String>()
            bundle.license?.let { docs[DocumentSlice.license] = it.jws }
            bundle.config?.let { docs[DocumentSlice.config] = it.jws }
            val next = base.copy(
                trustJws = bundle.trustJws,
                docs = docs,
                etags = emptyMap(),
                importedBundle = bundle.license?.let { ImportedBundle(bundle.bundleId, now) },
                lastSyncUnauthorized = null,
                blocked = null,
                v = CACHE_RECORD_VERSION,
            )
            loadCache(next)
            next
        }
        store.writeCache(stored)
        return bundle
    }

    // ── Telemetry ──────────────────────────────────────────────────────────────────────────
    /** `POST /devices/report` with [body]; best-effort, never fails a sync. */
    public suspend fun reportSnapshot(body: ByteArray): Boolean {
        val token = token() ?: return false
        return try {
            request(
                endpoints.devicesReport, method = "POST",
                headers = mapOf("authorization" to "Bearer $token", "content-type" to "application/json"), body = body,
            ).isOk
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            false
        }
    }

    // ── The sync pass (§4.2, §5) ───────────────────────────────────────────────────────────
    /**
     * One Core pass: no token ⇒ zero network calls; re-arm the single re-acquire; refresh trust on
     * Core's cadence; fetch the ENABLED documents in parallel; verify each against the effective
     * set with its per-type anti-replay floor; ONE cache write; telemetry, best-effort.
     */
    public suspend fun sync(
        force: Boolean = false,
        reacquire: ReacquireFn? = null,
        report: (suspend () -> Unit)? = null,
    ): SyncResult {
        lock.withLock {
            if (tokenValue == null) return SyncResult()
            reacquireSpent = false
            reacquireInFlight = null
        }
        var trustJws: String? = null
        if (trustRefreshEnabled && refreshTrust()) trustJws = lock.withLock { record?.trustJws }

        val wantLicense = enabled(ServiceSlug.license)
        val wantConfig = enabled(ServiceSlug.config)
        val outcomes: Map<DocumentSlice, DocOutcome> = coroutineScope {
            val l = async { if (wantLicense) syncDocument(DocumentSlice.license, force, reacquire, true) else DocOutcome.Skipped }
            val c = async { if (wantConfig) syncDocument(DocumentSlice.config, force, reacquire, true) else DocOutcome.Skipped }
            linkedMapOf(DocumentSlice.license to l.await(), DocumentSlice.config to c.await())
        }

        var applied = false
        var unauthorized = false
        var blocked = false
        var deviceCap = false
        var patch: BlockInfoRecord? = null
        var patchSet = false
        val documents = LinkedHashMap<DocumentSlice, DocOutcome>()
        for ((slice, outcome) in outcomes) {
            if (outcome == DocOutcome.Skipped) continue
            documents[slice] = outcome
            when (outcome) {
                DocOutcome.Applied -> applied = true
                DocOutcome.Unauthorized -> unauthorized = true
                is DocOutcome.Blocked -> {
                    blocked = true
                    patch = outcome.info
                    patchSet = true
                }
                is DocOutcome.DeviceCap -> deviceCap = true
                else -> Unit
            }
        }
        // A healthy authenticated exchange (200 or 304) clears both unsigned hints.
        val healthy = outcomes.values.any { it == DocOutcome.Applied || it == DocOutcome.Unchanged }
        if (!patchSet && healthy) patchSet = true
        val finalPatch = patch
        patchCache { rec ->
            var r = rec
            if (trustJws != null) r = r.copy(trustJws = trustJws)
            if (unauthorized) r = r.copy(lastSyncUnauthorized = true) else if (healthy) r = r.copy(lastSyncUnauthorized = false)
            if (patchSet) r = r.copy(blocked = finalPatch)
            r
        }
        if (applied || !unauthorized) report?.invoke()
        return SyncResult(applied, unauthorized, blocked, deviceCap, documents)
    }

    private suspend fun syncDocument(slice: DocumentSlice, force: Boolean, reacquire: ReacquireFn?, allowReacquire: Boolean): DocOutcome {
        val token = token() ?: return DocOutcome.Skipped
        return when (val result = getDocument(slice, token, if (force) null else etag(slice))) {
            DocumentResult.NotModified -> {
                // A 304 renews freshness, not the signed window: past the half-life, re-ask
                // unconditionally so the server re-signs it (R2-11).
                val expiresAt = lock.withLock { currentExpiresAt(slice) }
                if (!force && expiresAt != null && now() > saturatingAdd(expiresAt, -REFRESH_MARGIN_SECONDS)) {
                    return syncDocument(slice, true, reacquire, allowReacquire)
                }
                markVerified()
                DocOutcome.Unchanged
            }
            DocumentResult.Unauthorized -> {
                if (allowReacquire && reacquire != null && reacquireOnce(reacquire)) {
                    syncDocument(slice, force, reacquire, false)
                } else {
                    DocOutcome.Unauthorized
                }
            }
            is DocumentResult.DeviceCap -> DocOutcome.DeviceCap(result.limit, result.deviceCount)
            is DocumentResult.Blocked -> DocOutcome.Blocked(BlockInfoRecord(result.reason, result.allowedRange))
            is DocumentResult.Ok -> {
                if (!applyDocument(slice, result.jws, result.etag)) return DocOutcome.Error
                markVerified()
                DocOutcome.Applied
            }
            is DocumentResult.Error -> DocOutcome.Error
        }
    }

    /** At most ONE re-acquire per pass, SHARED by every concurrent 401. */
    private suspend fun reacquireOnce(reacquire: ReacquireFn): Boolean {
        val (mine, current, source) = lock.withLock {
            reacquireInFlight?.let { return@withLock Triple(it, null, null) }
            if (reacquireSpent) return false
            val current = tokenValue ?: return false
            reacquireSpent = true
            val d = CompletableDeferred<Boolean>()
            reacquireInFlight = d
            Triple(d, current, tokenSourceValue)
        }
        if (current == null) return mine.await()
        val ok = try {
            val next = reacquire(current, source)
            if (next == null) {
                false
            } else {
                try {
                    setToken(next.token, next.source)
                } catch (e: StoreException) {
                    lock.withLock {
                        tokenValue = next.token
                        tokenSourceValue = next.source
                    }
                }
                true
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            mine.complete(false)
            throw e
        } catch (e: Exception) {
            false
        }
        mine.complete(ok)
        return ok
    }

    /** The single re-acquire for an authenticated call made OUTSIDE a pass; returns the new token. */
    public suspend fun reacquireOutsideSync(reacquire: ReacquireFn): String? {
        val (current, source) = lock.withLock { (tokenValue ?: return null) to tokenSourceValue }
        val next = reacquire(current, source) ?: return null
        setToken(next.token, next.source)
        return next.token
    }

    /** Verify a freshly arrived document and stage it: artifact and ETag in the record, payload in the state. */
    private suspend fun applyDocument(slice: DocumentSlice, jws: String, etag: String?): Boolean = lock.withLock {
        val trust = mergeTrust(pinnedTrust, manifestKeys)
        val now = clock.effectiveNow(systemClock())
        when (slice) {
            DocumentSlice.license -> {
                val doc = verifyLicenseDoc(
                    jws, VerifyOptions(trust, product, deviceIdValue, lastAcceptedIssuedAt = loaded.license?.doc?.issuedAt, now = now),
                ) ?: return@withLock false
                loaded = loaded.copy(license = CachedDoc(jws, doc))
                clock.raise(doc.issuedAt)
            }
            DocumentSlice.config -> {
                val doc = verifyConfigDoc(
                    jws, VerifyOptions(trust, product, deviceIdValue, lastAcceptedIssuedAt = loaded.config?.doc?.issuedAt, now = now),
                ) ?: return@withLock false
                loaded = loaded.copy(config = CachedDoc(jws, doc))
                clock.raise(doc.issuedAt)
            }
        }
        val base = record ?: CacheRecord()
        val etags = if (etag != null) base.etags + (slice to etag) else base.etags - slice
        record = base.copy(docs = base.docs + (slice to jws), etags = etags, v = CACHE_RECORD_VERSION)
        true
    }

    private fun currentExpiresAt(slice: DocumentSlice): Long? = when (slice) {
        DocumentSlice.license -> loaded.license?.doc?.expiresAt
        DocumentSlice.config -> loaded.config?.doc?.expiresAt
    }

    private suspend fun markVerified() {
        val ms = systemClockMillis()
        lock.withLock { loaded = loaded.copy(lastVerifiedAt = ms) }
    }

    /**
     * The licence STATE for this client's current state ([licenseState] over the cache, the floor
     * and the resolved services). The licence service's own reads are the :license module's.
     */
    public suspend fun licenseStatus(now: Long? = null): LicenseState {
        val enabled = enabled(ServiceSlug.license)
        val effective = now(now)
        return lock.withLock {
            val activation = when {
                tokenValue != null -> ActivationSource.token
                loaded.importedBundle != null && loaded.license != null -> ActivationSource.bundle
                else -> null
            }
            licenseState(
                GateInput(
                    licenseServiceEnabled = enabled,
                    activation = activation,
                    doc = loaded.license?.doc,
                    now = effective,
                    highWaterMark = clock.highWaterMark,
                    lastSyncUnauthorized = loaded.lastSyncUnauthorized,
                    blocked = loaded.blocked?.let { BlockInfo(it.reason, it.allowedRange) },
                    lastVerifiedAt = loaded.lastVerifiedAt,
                ),
            )
        }
    }

    /** The verified config values (`config` of the current config document), for reports and hosts. */
    public suspend fun configValues(): JsonObject = lock.withLock {
        JsonObject(loaded.config?.doc?.config?.mapValues { it.value.value } ?: emptyMap())
    }

    /** The verified entitlement values of the current licence document. */
    public suspend fun entitlementValues(): JsonObject = lock.withLock {
        JsonObject(loaded.license?.doc?.entitlements?.mapValues { it.value.value } ?: emptyMap())
    }

    public companion object {
        /** A context over a [FileStore] at [directory]. */
        public fun withFileStore(options: CoreOptions, directory: File): CoreContext =
            CoreContext(options.copy(store = FileStore(options.productSlug, directory)))
    }
}
