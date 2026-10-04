// `packs` — the Kotlin pack facet (plans/P4-01.md §2.6–§2.9, §5; CONTENT §10, §13; P6-08), Swift's
// `PacksClient` ported. It is [PackEngine] with this SDK's ports:
//
//   transport  the pinned pack record from discovery's `release.endpoints.record` (through Core's
//              transport, the body capped at `MAX_RECORD_JWS_BYTES + 1`), objects from
//              `distribution.endpoints.blobs` (`{sha256}`) with `Range`/`If-Range`, streamed by OkHttp
//              (or an injected [PackObjectTransport]: Play Asset Delivery is P6-12's); the device bearer
//              goes only to the control plane's own origin. Any answer but 200 or 206 is a failed fetch;
//   storage    [DirPackStorage] under the data directory (never a cache directory): a versioned
//              directory per tree payload and an atomic pointer swap in `state.json`;
//   zstd       libzstd through zstd-jni, after a start-up probe ([selectZstd]);
//   SHA-256    the JDK's, streaming.
//
// The running build's pins come from its content stamp (`PacksOptions.contentStamp`, a file among the
// app's own read-only resources): a host without a stamp has no packs. Embedded baselines are verified
// once (marker, bytes, stamp pin) and then count as installed. The active set's `packSetId` rides on
// `devices/report` as `content`. The facet is the update client's content host
// ([UpdateContentHost]); the umbrella client wires the two, so :update never sees :packs.

package im.plrs.key.packs

import im.plrs.key.core.CoreContext
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Feature
import im.plrs.key.core.FeedDeltas
import im.plrs.key.core.FileStore
import im.plrs.key.core.MAX_RECORD_JWS_BYTES
import im.plrs.key.core.PackTarget
import im.plrs.key.core.PolarisException
import im.plrs.key.core.ReleasePin
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.TrustSet
import im.plrs.key.core.UpdateCheckContent
import im.plrs.key.core.UpdateCheckRevocations
import im.plrs.key.core.UpdateContentHost
import im.plrs.key.core.boolValue
import im.plrs.key.core.expandTemplate
import im.plrs.key.core.sameOrigin
import im.plrs.key.core.stampHolds
import java.io.File
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Where the content stamp comes from. */
public sealed interface PackStampSource {
    /** A file among the app's own read-only resources. */
    public data class FromFile(val file: File) : PackStampSource

    /** Its bytes. */
    public class FromBytes(public val bytes: ByteArray) : PackStampSource
}

/** One embedded baseline: a payload file (marker `<file>.pkey.json`) or a tree directory (marker `.pkey/pack.json`). */
public data class EmbeddedPack(val path: File, val marker: File? = null)

/** Fetches one object (the blob route) with the headers the facet computed. */
public interface PackObjectTransport {
    public suspend fun get(url: String, headers: Map<String, String>, timeoutSeconds: Double): ObjectResponse

    /** Whether it sends a bounded `Range` and reports `Content-Range` and `ETag` (P4-11). Default false. */
    public val supportsRange: Boolean get() = false
}

/**
 * The default object transport: OkHttp, streamed in 64 KiB pieces. Redirects are followed by hand:
 * `https` → `http` is refused, at most five hops, and `Authorization` is dropped on every redirect
 * (as Core's transport). `timeoutSeconds` is the idle (read) timeout, so a large payload is never cut
 * off for taking longer than one request may.
 */
public class OkHttpPackObjectTransport(client: OkHttpClient = OkHttpClient()) : PackObjectTransport {
    private val base: OkHttpClient = client.newBuilder().followRedirects(false).followSslRedirects(false).build()

    override val supportsRange: Boolean get() = true

    override suspend fun get(url: String, headers: Map<String, String>, timeoutSeconds: Double): ObjectResponse {
        val client = if (timeoutSeconds > 0) base.newBuilder().readTimeout((timeoutSeconds * 1000).toLong(), TimeUnit.MILLISECONDS).build() else base
        var current = url
        var h = headers
        for (hop in 0..5) {
            val httpUrl = current.toHttpUrlOrNull() ?: throw PolarisException(ErrorCode.transport, "not an http(s) URL: $current")
            val builder = Request.Builder().url(httpUrl)
            for ((k, v) in h) builder.header(k, v)
            val r = client.newCall(builder.get().build()).await()
            val location = r.header("location")
            if (r.code in setOf(301, 302, 303, 307, 308) && location != null) {
                r.close()
                if (hop == 5) throw PolarisException(ErrorCode.tooManyRedirects, "more than 5 redirects")
                val next = r.request.url.resolve(location) ?: throw PolarisException(ErrorCode.insecureRedirect, "unusable redirect target")
                if (r.request.url.isHttps && !next.isHttps) throw PolarisException(ErrorCode.insecureRedirect, "redirect from https to plain http")
                h = h.filterKeys { !it.equals("authorization", ignoreCase = true) }
                current = next.toString()
                continue
            }
            val source = r.body?.source()
            val body = object : ByteStream {
                private var done = false
                override suspend fun next(): ByteArray? = withContext(Dispatchers.IO) {
                    if (done || source == null) return@withContext null
                    val buf = ByteArray(1 shl 16)
                    val n = source.read(buf)
                    if (n < 0) {
                        close()
                        null
                    } else buf.copyOf(n)
                }

                override fun close() {
                    if (!done) {
                        done = true
                        r.close()
                    }
                }
            }
            return ObjectResponse(r.code, r.header("content-range"), r.header("etag"), body)
        }
        throw PolarisException(ErrorCode.tooManyRedirects, "more than 5 redirects")
    }

    private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
        cont.invokeOnCancellation { cancel() }
        enqueue(object : Callback {
            override fun onFailure(call: Call, e: java.io.IOException) {
                cont.resumeWithException(PolarisException(ErrorCode.networkError, e.message ?: "network error", cause = e))
            }

            override fun onResponse(call: Call, response: Response) {
                cont.resume(response) { _, value, _ -> value.close() }
            }
        })
    }
}

/** The `packs` facet's options. */
public class PacksOptions(
    /** The content stamp (`pkey-content.json`). Without one the facet has no packs. */
    public val contentStamp: PackStampSource? = null,
    /** Embedded baselines, verified once at load and then used as installed state. */
    public val embedded: List<EmbeddedPack> = emptyList(),
    /** Variant preferences, per axis, in preference order (`{"locale": ["fr", "en"]}`). */
    public val axes: Map<String, List<String>> = emptyMap(),
    /** `godot-<major>.<minor>` for a host that runs Godot packs; null otherwise. */
    public val engine: String? = null,
    /** The most memory one delta frame may take (`memBytes`). Default 256 MiB. */
    public val memBudget: Long = 256L * 1024 * 1024,
    /** Where staging, the store and `state.json` live. Default `<store directory>/packs`. */
    public val dir: Path? = null,
    /** Extra handlers (`ml.model`, game-registered `custom.*`). `files.tree`, `data.json`, `l10n.table` are built in. */
    public val handlers: List<PackHandler> = emptyList(),
    /** The blob transport. Default [OkHttpPackObjectTransport]. */
    public val objectTransport: PackObjectTransport? = null,
)

/** The delta menu of a committed feed (null deltas: the feed carries none). */
public class FeedMenu(public val deltas: FeedDeltas?)

/** The pack facet. */
public class PacksClient(
    private val core: CoreContext,
    private val releaseKeys: TrustSet,
    private val opts: PacksOptions = PacksOptions(),
    /** The update client's read of the committed feed's delta menu, before any check ran (null: no committed feed). */
    private val loadFeedDeltas: (suspend () -> FeedMenu?)? = null,
) : UpdateContentHost {
    private var engine: PackEngine? = null
    private val startLock = Mutex()
    @Volatile private var building: PackEngine? = null
    private val pendingHandlers = java.util.concurrent.CopyOnWriteArrayList<PackHandler>()
    private val listeners = ConcurrentHashMap<Long, (PackProgress) -> Unit>()
    private var listenerSeq = 0L
    @Volatile private var zstdInfo: PackZstdInfo? = null
    private val refused = java.util.concurrent.CopyOnWriteArrayList<Pair<String, String>>()

    /** plans/P4-29.md §2.4 step 1: the delta menu of the most recently committed feed (null until known). */
    @Volatile private var feedMenu: FeedMenu? = null

    init {
        if (opts.contentStamp != null) core.setPackSetIdSource { packSetId() }
    }

    /** Whether the host configured a content stamp (and so may have packs). */
    public val configured: Boolean get() = opts.contentStamp != null

    override fun noteFeedDeltas(deltas: FeedDeltas?) {
        feedMenu = FeedMenu(deltas)
    }

    /** Install the pinned release of each pack (CONTENT §10). */
    public suspend fun ensure(packIds: List<String>): List<PackInstall> {
        core.requireService(ServiceSlug.release, Feature.packsState)
        return start().ensure(packIds)
    }

    /** The install state and this process's running set. */
    public suspend fun state(): PacksSnapshot = start().state()

    /** The directory of a pack's running tree payload, or null when it is not running. */
    public suspend fun path(packId: String): File? {
        val i = state().running[packId] ?: return null
        return if (i.layout == "tree") File(i.location) else null
    }

    /** Add a handler for a pack type (CONTENT §4.1). */
    public fun registerHandler(handler: PackHandler) {
        val e = building
        if (e != null) {
            e.registerHandler(handler)
            return
        }
        if ((handler.layout != "tree" && handler.layout != "container") || (handler.activation != "hot" && handler.activation != "restart") || handler.type.isEmpty()) {
            throw PackException(ErrorCode.invalidOptions, "registerHandler needs {type, layout tree|container, activation hot|restart, supports}.")
        }
        pendingHandlers += handler
        building?.registerHandler(handler)
    }

    /** Progress events (`download`, `apply`, `done`, `state-issue`); returns the unsubscribe. */
    public fun on(listener: (PackProgress) -> Unit): () -> Unit {
        val id = synchronized(listeners) { ++listenerSeq }
        listeners[id] = listener
        return { listeners.remove(id) }
    }

    /** The running set's `packSetId`; null without a stamp or before packs can start. */
    public suspend fun packSetId(): String? {
        if (!configured) return null
        return try {
            start().packSetId()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
    }

    /** Mark this boot healthy (CONTENT §10 step 7). */
    public suspend fun confirm(): Unit = start().confirm()

    /** Operator recovery after a torn `state.json`. */
    public suspend fun recoverState(): Unit = start().recoverState()

    /** Re-point a pack at the install it replaced. */
    public suspend fun rollback(packId: String): Boolean = start().rollback(packId)

    /** The boot stage machine's pack options from the content stamp, for `BootOptions`. */
    public fun bootOptions(): Pair<List<String>, List<String>> = bootPackOptions(readStamp())

    /** The boot's FETCH stage (the stage machine's host side). */
    public suspend fun bootFetch(
        send: (im.plrs.key.core.BootEvent) -> Unit,
        consent: BootConsentPolicy = BootConsentPolicy.metered,
        metered: Boolean = false,
        answer: (suspend (Long, Boolean) -> Boolean)? = null,
        install: List<PackTarget>? = null,
    ): BootFetchResult = runBootFetch(start(), RunBootFetchOptions(readStamp(), send, consent, metered, answer, install))

    /** Install exact releases: a `packs` decision's `install` list (plans/P4-13.md §2.6). */
    public suspend fun ensureReleases(targets: List<PackTarget>): List<PackInstall> {
        core.requireService(ServiceSlug.release, Feature.packsState)
        return start().ensureReleases(targets)
    }

    /** Preflight sizes for a consent dialog. */
    public suspend fun estimate(packIds: List<String>): PackEstimate = start().estimate(packIds)

    /** Save compatibility: whether a running pack release provides [contentId]. False without a stamp. */
    public suspend fun isAvailable(contentId: String): Boolean = if (!configured) false else start().isAvailable(contentId)

    /** The pack whose target release provides [contentId]; null when none or without a stamp. */
    public suspend fun packFor(contentId: String, targets: List<PackTarget>? = null): PackProvider? = if (!configured) null else start().packFor(contentId, targets)

    /** The stored and this process's verified revocations, and `relearn`. */
    public suspend fun revocations(): RevocationsSnapshot = start().revocations()

    override suspend fun contentInput(): UpdateCheckContent? {
        if (!configured) return null
        val bytes = readStampBytes() ?: return null
        val stamp = readStamp() ?: return null
        val e = start()
        val active = e.state().running.mapValues { (_, i) -> ReleasePin(i.recordSha256, i.seq, i.version) }
        val revs = e.revocations()
        val prefs = VariantPrefs(opts.engine, opts.axes)
        return UpdateCheckContent(
            stamp = stamp.stamp(stampHolds(bytes)),
            active = active,
            engine = opts.engine,
            axes = opts.axes,
            revoked = revs.verified,
            relearn = revs.relearn,
            selectsVariant = { variants -> selectVariant(variants, prefs) is SelectVariantResult.Index },
            delegated = e.delegatedReleases(),
        )
    }

    override suspend fun recordRevocations(revocations: UpdateCheckRevocations) {
        start().recordRevocations(revocations.learned, revocations.relearnCleared)
    }

    /** Which decoder serves frames (after the start-up probe). */
    public suspend fun zstd(): PackZstdInfo {
        start()
        return zstdInfo!!
    }

    /** The embedded baselines `start` refused, by marker step. */
    public suspend fun refusedEmbedded(): List<Pair<String, String>> {
        start()
        return refused.toList()
    }

    // ── Internals ───────────────────────────────────────────────────────────────────────────

    private suspend fun start(): PackEngine {
        engine?.let { return it }
        return startLock.withLock {
            engine ?: try {
                boot().also { engine = it }
            } catch (e: Exception) {
                building = null
                throw e
            }
        }
    }

    private suspend fun boot(): PackEngine {
        val stamp = readStamp()
        val (zstd, info) = selectZstd()
        zstdInfo = info
        val root = opts.dir ?: defaultRoot()
        val storage = DirPackStorage(root)
        storage.freeDisk() // creates the root
        val transport = opts.objectTransport ?: OkHttpPackObjectTransport()
        val holds = try {
            readStampBytes()?.let { stampHolds(it) }
        } catch (e: Exception) {
            null
        } ?: emptyList()
        val e = PackEngine(
            PackEngineOptions(
                product = core.product,
                releaseKeys = releaseKeys,
                productTrust = { core.trust() },
                stamp = stamp,
                prefs = VariantPrefs(opts.engine, opts.axes),
                zstd = zstd,
                patchMethods = info.patchMethods,
                memBudget = opts.memBudget,
                storage = storage,
                state = storage.stateStore(),
                revocations = storage.revocationStore(),
                fetchRecord = { fetchRecord(it) },
                fetchObject = { fetchObject(transport, it) },
                supportsRange = transport.supportsRange,
                entitlements = { entitlements() },
                now = { core.now() },
                handlers = opts.handlers + pendingHandlers,
                holds = holds,
                feedDeltas = { feedMenu?.deltas },
            ),
        )
        if (feedMenu == null) loadFeedDeltas?.invoke()?.let { loaded -> if (feedMenu == null) feedMenu = loaded }
        e.on { p -> for (l in listeners.values) l(p) }
        building = e
        for (h in pendingHandlers) try {
            e.registerHandler(h)
        } catch (x: Exception) {
            // Validated when it was registered.
        }
        refused += e.load(embeddedBaselines())
        return e
    }

    private fun defaultRoot(): Path {
        val store = core.store
        val base = if (store is FileStore) store.directory else FileStore.defaultDirectory(core.product)
        return File(base, "packs").toPath()
    }

    private fun readStampBytes(): ByteArray? = when (val src = opts.contentStamp) {
        null -> null
        is PackStampSource.FromBytes -> src.bytes
        is PackStampSource.FromFile -> try {
            src.file.readBytes()
        } catch (e: Exception) {
            throw PackException(ErrorCode.contentStampInvalid, "The content stamp cannot be read.")
        }
    }

    private fun readStamp(): AppContent? {
        val bytes = readStampBytes() ?: return null
        return parseContentStamp(bytes).content
            ?: throw PackException(ErrorCode.contentStampInvalid, "The content stamp is not a valid pkey-content/1 document.")
    }

    private fun embeddedBaselines(): List<EmbeddedBaseline> {
        val out = ArrayList<EmbeddedBaseline>()
        for (e in opts.embedded) {
            val path = e.path.toPath().toAbsolutePath().normalize()
            try {
                val a = attrsOrNull(path) ?: throw java.nio.file.NoSuchFileException(path.toString())
                val dir = a.isDirectory
                val markerPath = e.marker?.toPath() ?: if (dir) path.resolve(".pkey/pack.json") else path.resolveSibling(path.fileName.toString() + ".pkey.json")
                val marker = readFileOrNull(markerPath) ?: throw java.nio.file.NoSuchFileException(markerPath.toString())
                val payload: EmbeddedPayload = if (dir) {
                    EmbeddedPayload.Tree(directoryTreeDigest(path))
                } else {
                    val (sha, size) = measureFile(path)
                    EmbeddedPayload.File(sha, size)
                }
                out += EmbeddedBaseline(marker, payload, path.toString())
            } catch (x: Exception) {
                refused += path.toString() to "format"
            }
        }
        return out
    }

    /** The licence's granted boolean flags, or null when the product runs no License service. */
    private suspend fun entitlements(): Set<String>? {
        if (!core.enabled(ServiceSlug.license)) return null
        val ent = core.cache().license?.doc?.entitlements ?: return emptySet()
        return ent.filterValues { it.value.boolValue == true }.keys
    }

    /** A discovered template, loading discovery first when this session has not. */
    private suspend fun template(service: ServiceSlug, name: String): String? {
        var doc = core.discoveryDocument()
        if (doc == null && !core.localOnly) {
            core.discover()
            doc = core.discoveryDocument()
        }
        return doc?.services?.get(service)?.endpoints?.get(name)
    }

    private suspend fun fetchRecord(sha256: String): RecordFetchResult {
        if (core.localOnly) return RecordFetchResult.Failed(ErrorCode.localOnly)
        val t = template(ServiceSlug.release, "record") ?: return RecordFetchResult.Failed(ErrorCode.serviceUnavailable)
        val url = expandTemplate(t, core.endpoints.baseUrl, mapOf("sha256" to sha256)) ?: return RecordFetchResult.Failed(ErrorCode.networkError)
        val headers = linkedMapOf("accept" to "application/jose")
        core.token()?.let { if (sameOrigin(url, core.endpoints.baseUrl)) headers["authorization"] = "Bearer $it" }
        return try {
            val res = core.request(url, headers = headers, maxBodyBytes = MAX_RECORD_JWS_BYTES + 1)
            if (!res.isOk) return RecordFetchResult.Failed(ErrorCode.networkError)
            val body = res.body
            // A record over the bound is refused at step `hash` from this prefix, never hashed.
            RecordFetchResult.Ok(body.copyOf(minOf(body.size, MAX_RECORD_JWS_BYTES + 1)).toString(Charsets.UTF_8))
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            RecordFetchResult.Failed(ErrorCode.networkError)
        }
    }

    private suspend fun fetchObject(transport: PackObjectTransport, req: ObjectRequest): ObjectResponse {
        if (core.localOnly) throw PolarisException(ErrorCode.localOnly, "This client is in local-only mode.")
        val t = template(ServiceSlug.distribution, "blobs") ?: throw PackException(ErrorCode.serviceUnavailable, "Discovery names no blob endpoint.")
        val url = expandTemplate(t, core.endpoints.baseUrl, mapOf("sha256" to req.sha256))
            ?: throw PackException(ErrorCode.serviceUnavailable, "Discovery names no usable blob endpoint.")
        val extra = LinkedHashMap<String, String>()
        core.token()?.let { if (sameOrigin(url, core.endpoints.baseUrl)) extra["authorization"] = "Bearer $it" }
        val length = req.length
        if (length != null) {
            // A transport that cannot send a bounded range is never handed one: refused, so the chunk
            // strategy falls back (never `interrupted`, which would keep retrying).
            if (!transport.supportsRange) return ObjectResponse(0, null, null, ByteStream.empty)
            if (length <= 0 || req.offset < 0) throw PackException(ErrorCode.networkError, "A range request needs a positive length.")
            extra["range"] = "bytes=${req.offset}-${req.offset + length - 1}"
            extra["accept-encoding"] = "identity"
        } else if (req.offset > 0) {
            extra["range"] = "bytes=${req.offset}-"
        }
        req.ifRange?.let { extra["if-range"] = it }
        return transport.get(url, core.headers(extra), core.requestTimeoutSeconds)
    }
}
