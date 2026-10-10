// The SDK's `PresentationSource` (plans/HA-13.md §3, Kotlin row): discovery's presentation member,
// and its icon fetched, verified and cached. `CoreContext.presentation` is the one per client;
// `PolarisKeyClient.presentationSource` hands it to the UI kit.
//
// MEMBER. After every successful discovery the member is parsed again (`Discovery.parse`): a
// document without one, or with an invalid one, clears it, and a failed discovery keeps the last.
// Listeners hear only a member that differs. A cold start reads the last member back from
// `presentation.json` ({v: 1, product, presentation}) through the same parser, so an offline start
// still shows the product; a file that does not re-parse to itself, or names another product, is
// deleted. Discovery never fetches the icon: [icon] does, on demand.
//
// FETCH. A plain GET through Core's transport with NO headers (no `Authorization`, no cookies, no
// `X-PKey-*`: the image host is public), `followRedirects = false` (a 3xx is a miss), 200 only, the
// PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS deadline and the PRESENTATION_ICON_MAX_BYTES cap. The URL
// must be https (or loopback http) and on the original's origin (`PresentationRules.safeFetchUrl`).
// A local-only client never fetches. Nothing is retried and no error is surfaced: a failure is
// null, and the kit keeps its monogram.
//
// VERIFY. Bytes are returned and cached only when their SHA-256 is the pick's `sha256`. Decoding is
// the kit's (BitmapFactory or ImageIO), which bounds the decoded size before it allocates.
//
// CACHE. `<state directory>/presentation/<sha256>`, and `presentation.json` beside it, each written
// to a temporary name and renamed over the target; never inside Core's cache record. A cached file
// is re-hashed on every read and deleted on a mismatch. After each discovery the files the member
// no longer names are removed, keeping at most PRESENTATION_CACHE_MAX_FILES icon files (the oldest
// go first). A store with no state directory keeps the member and the bytes in memory only.

package im.plrs.key.core

import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * [PresentationSource] over discovery and the icon cache.
 *
 * @param product the configured product's slug (`presentation.json` must name it).
 * @param directory the cache directory (`<state directory>/presentation`), resolved on first disk
 *   use (off the main thread); null keeps everything in memory.
 * @param transport Core's transport; [NoNetworkTransport] (local-only) never fetches.
 * @param decodable the content types the platform decodes ([PresentationRules.platformDecodable]).
 */
public class DiscoveryPresentationSource(
    public val product: String,
    directory: () -> File?,
    private val transport: PolarisTransport,
    public val decodable: Set<String> = PresentationRules.platformDecodable,
) : PresentationSource {
    /** A source over a fixed [directory] (null: memory only). */
    public constructor(product: String, directory: File?, transport: PolarisTransport, decodable: Set<String> = PresentationRules.platformDecodable) :
        this(product, { directory }, transport, decodable)

    private val dir: File? by lazy(directory)
    private val localOnly = transport === NoNetworkTransport

    @Volatile private var currentValue: Presentation? = null

    @Volatile private var discovered = false
    private val listeners = CopyOnWriteArrayList<(Presentation?) -> Unit>()
    private val memo = ConcurrentHashMap<String, ByteArray>()
    private val pending = ConcurrentHashMap<String, CompletableDeferred<ByteArray?>>()
    private val files = Any()

    override fun current(): Presentation? = currentValue

    override fun subscribe(listener: (Presentation?) -> Unit): () -> Unit {
        listeners += listener
        return { listeners -= listener }
    }

    /**
     * Cold boot: the last member from `presentation.json`, unless this session already discovered
     * one. A file that does not read back exactly as the parser normalises it, or that names another
     * product, is deleted. Main-safe.
     */
    public suspend fun loadCached() {
        if (discovered) return
        val m = withContext(Dispatchers.IO) { quietly { synchronized(files) { readMember() } } }
        if (m != null && !discovered) set(m)
    }

    /**
     * A successful discovery's member (`ProductDiscoveryDocument.presentation`): stored, the cache
     * pruned to what it names, and listeners told when it differs. Null (none, or an invalid one)
     * clears it. Main-safe.
     */
    public suspend fun accept(member: Presentation?) {
        discovered = true
        withContext(Dispatchers.IO) {
            quietly {
                synchronized(files) {
                    writeMember(member)
                    prune(member)
                }
            }
        }
        set(member)
    }

    private fun set(m: Presentation?) {
        if (m == currentValue) return
        currentValue = m
        for (l in listeners) {
            try {
                l(m)
            } catch (e: Exception) {
                // A listener's failure is the listener's: the member still changed.
            }
        }
    }

    /**
     * The verified icon for a hero drawn at [px] points on a [scale] screen, or null: no member, no
     * icon, nothing decodable, or a fetch or hash that failed. Concurrent calls for the same bytes
     * share one fetch. Each call returns its own copy. Never throws (cancellation aside).
     */
    override suspend fun icon(px: Double, scale: Double): ByteArray? {
        val ic = currentValue?.icon ?: return null
        val (sha, url) = when (val pick = PresentationRules.pickIconSize(ic, px, scale, decodable)) {
            is IconPick.Size -> pick.sha256 to pick.url
            is IconPick.Original -> pick.sha256 to pick.url
            IconPick.None -> return null
        }
        while (true) {
            memo[sha]?.let { return it.copyOf() }
            val waiter = CompletableDeferred<ByteArray?>()
            val owner = pending.putIfAbsent(sha, waiter)
            if (owner != null) {
                try {
                    return owner.await()?.copyOf()
                } catch (e: CancellationException) {
                    // The fetch's owner was cancelled, not this caller: start a fetch of its own.
                    currentCoroutineContext().ensureActive()
                    continue
                }
            }
            var bytes: ByteArray? = null
            var cancelled = false
            try {
                bytes = try {
                    load(sha, url, ic.original)
                } catch (e: CancellationException) {
                    cancelled = true
                    throw e
                } catch (e: Exception) {
                    null
                }
                if (bytes != null && sha in named(currentValue)) memo[sha] = bytes
            } finally {
                // Nothing that suspends here: a cancelled owner still releases its waiters.
                pending.remove(sha, waiter)
                if (cancelled) waiter.cancel() else waiter.complete(bytes)
            }
            return bytes?.copyOf()
        }
    }

    /** The disk cache (re-hashed), else the network; verified, then cached. */
    private suspend fun load(sha: String, url: String, original: String): ByteArray? {
        withContext(Dispatchers.IO) { quietly { synchronized(files) { readCached(sha) } } }?.let { return it }
        if (localOnly || !PresentationRules.safeFetchUrl(url, original)) return null
        val timeout = PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS.toDouble()
        val response = withTimeoutOrNull((timeout * 1000).toLong()) {
            transport.send(
                PolarisRequest(
                    url = url,
                    method = "GET",
                    headers = emptyMap(),
                    timeoutSeconds = timeout,
                    // One byte past the cap tells an oversize body from one exactly at it.
                    maxBodyBytes = PRESENTATION_ICON_MAX_BYTES + 1,
                    followRedirects = false,
                ),
            )
        } ?: return null
        if (response.status != 200) return null
        val body = response.body
        if (body.size > PRESENTATION_ICON_MAX_BYTES || !PresentationRules.iconMatches(body, sha)) return null
        withContext(Dispatchers.IO) {
            quietly {
                synchronized(files) {
                    val d = dir
                    // Only bytes the current member still names are written: a member that changed
                    // while the fetch ran must not leave a file the next prune would not know about.
                    if (d != null && sha in named(currentValue) && write(d, sha, body)) capFiles(d, sha)
                }
            }
        }
        return body
    }

    private fun readCached(sha: String): ByteArray? {
        val d = dir ?: return null
        val f = File(d, sha)
        if (!f.isFile) return null
        val held = try {
            if (f.length() > PRESENTATION_ICON_MAX_BYTES) null else f.readBytes()
        } catch (e: Exception) {
            null
        }
        if (held != null && PresentationRules.iconMatches(held, sha)) return held
        // Tampered or truncated: gone, and fetched again.
        f.delete()
        return null
    }

    // ── Cache files ────────────────────────────────────────────────────────────────────────

    /** Disk work that must never fail the caller: a full disk or an unreadable directory is a miss. */
    private inline fun <T> quietly(block: () -> T): T? = try {
        block()
    } catch (e: Exception) {
        null
    }

    /** The icon files in the cache, by name (no `presentation.json`, no interrupted write). */
    public fun cachedFiles(): List<String> {
        val d = quietly { dir } ?: return emptyList()
        return synchronized(files) { iconFiles(d).map { it.name }.sorted() }
    }

    private fun iconFiles(d: File): List<File> =
        d.listFiles()?.filter { it.isFile && it.name != MEMBER_FILE && !it.name.contains(".tmp-") } ?: emptyList()

    /** Remove every icon file [member] does not name (and any interrupted write), then cap the rest. */
    private fun prune(member: Presentation?) {
        val keep = named(member)
        memo.keys.retainAll(keep)
        val d = dir ?: return
        d.listFiles()?.forEach { f ->
            if (f.isFile && f.name != MEMBER_FILE && f.name !in keep) f.delete()
        }
        capFiles(d, null)
    }

    /** At most PRESENTATION_CACHE_MAX_FILES icon files: the oldest go first; [fresh] (just written) never does. */
    private fun capFiles(d: File, fresh: String?) {
        val others = iconFiles(d).filter { it.name != fresh }.sortedWith(compareBy<File>({ it.lastModified() }, { it.name }))
        val room = PRESENTATION_CACHE_MAX_FILES - (if (fresh != null) 1 else 0)
        if (others.size <= room) return
        others.take(others.size - room).forEach { it.delete() }
    }

    /** Write [bytes] to [name] in [d]: a temporary file, renamed over the target. */
    private fun write(d: File, name: String, bytes: ByteArray): Boolean {
        if (!d.isDirectory && !d.mkdirs()) return false
        val suffix = ByteArray(6).also { RANDOM.nextBytes(it) }.joinToString("") { "%02x".format(it.toInt() and 0xFF) }
        val tmp = File(d, "$name.tmp-$suffix")
        return try {
            tmp.writeBytes(bytes)
            try {
                Files.move(tmp.toPath(), File(d, name).toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
            } catch (e: java.nio.file.AtomicMoveNotSupportedException) {
                Files.move(tmp.toPath(), File(d, name).toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
            true
        } catch (e: Exception) {
            tmp.delete()
            false
        }
    }

    private fun writeMember(m: Presentation?) {
        val d = dir ?: return
        if (m == null) {
            File(d, MEMBER_FILE).delete()
            return
        }
        val doc = JsonObject(mapOf("v" to jsonInt(MEMBER_FILE_VERSION.toLong()), "product" to JsonPrimitive(product), "presentation" to m.toJson()))
        write(d, MEMBER_FILE, doc.toString().toByteArray(Charsets.UTF_8))
    }

    private fun readMember(): Presentation? {
        val d = dir ?: return null
        val f = File(d, MEMBER_FILE)
        if (!f.isFile) return null
        val value = try {
            JsonText.parseOrNull(f.readText(Charsets.UTF_8)).objectValue
        } catch (e: Exception) {
            null
        }
        var m: Presentation? = null
        if (value != null && value["v"].longValue == MEMBER_FILE_VERSION.toLong() && product.isNotEmpty() && value["product"].stringValue == product) {
            val raw = value["presentation"]
            m = PresentationRules.parsePresentation(JsonObject(mapOf("presentation" to (raw ?: JsonObject(emptyMap())))), null, product)
            // Only a member this SDK wrote reads back: the parser's normal form, exactly.
            if (m != null && !jsonEquals(m.toJson(), raw)) m = null
        }
        if (m == null) f.delete()
        return m
    }

    public companion object {
        /** The last member's file, beside the icons. */
        public const val MEMBER_FILE: String = "presentation.json"
        private const val MEMBER_FILE_VERSION = 1
        private val RANDOM = SecureRandom()

        /** The icon hashes [member] names: the original's and each size's. */
        public fun named(member: Presentation?): Set<String> {
            val ic = member?.icon ?: return emptySet()
            return buildSet {
                add(ic.sha256)
                ic.sizes.forEach { add(it.sha256) }
            }
        }
    }
}
