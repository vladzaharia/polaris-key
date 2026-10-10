// @pkey-feature core.presentation
//
// The presentation source's fetch and cache rules (plans/HA-13.md §3, the shared rules), against a
// local server through the real OkHttp transport: a plain GET with no headers at all, no redirect
// followed, 200 only, the byte cap, the SHA-256 gate, the cache by hash (re-hashed on every read,
// a tampered file replaced), the prune to PRESENTATION_CACHE_MAX_FILES, `presentation.json` for a cold
// start (and refused when it was edited), the safe link, local-only, and Core's discovery hook.

package im.plrs.key.core

import im.plrs.key.core.testing.ScriptedTransport
import java.io.File
import java.net.InetAddress
import java.nio.file.Files
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class PresentationSourceTest {
    private lateinit var server: MockWebServer
    private lateinit var dir: File
    private val transport = OkHttpTransport()
    private val requests = java.util.concurrent.CopyOnWriteArrayList<RecordedRequest>()
    private val routes = java.util.concurrent.ConcurrentHashMap<String, () -> MockResponse>()

    private val png = "\u0089PNG fake icon bytes".toByteArray(Charsets.ISO_8859_1)
    private val webp64 = "RIFF fake 64".toByteArray()
    private val webp128 = "RIFF fake 128".toByteArray()

    private fun sha(b: ByteArray) = PresentationRules.sha256Hex(b)
    private fun base() = "http://127.0.0.1:${server.port}"

    @Before
    fun up() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                return routes[request.path]?.invoke() ?: MockResponse().setResponseCode(404)
            }
        }
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        dir = Files.createTempDirectory("pkey-presentation").toFile()
    }

    @After
    fun down() {
        server.shutdown()
        transport.close()
        dir.deleteRecursively()
    }

    private fun ok(bytes: ByteArray) = { MockResponse().setResponseCode(200).setBody(Buffer().write(bytes)) }

    /** A member whose icon is served by the local server: a PNG original and a two-width ladder. */
    private fun member(original: ByteArray = png, sizes: List<Pair<Int, ByteArray>> = listOf(64 to webp64, 128 to webp128)): Presentation {
        val icon = PresentationIcon(
            sha256 = sha(original), contentType = "image/png", width = 1024, height = 1024,
            original = "${base()}/a/${sha(original)}",
            url = if (sizes.isEmpty()) null else "${base()}/a/${sha(original)}/{w}.webp",
            sizes = sizes.map { PresentationIconSize(it.first, sha(it.second)) },
        )
        return Presentation(name = "Drift Kart", developerName = "Polaris", accent = "#2ed6e6", icon = icon)
    }

    private fun serve(m: Presentation, bytes: Map<String, ByteArray>) {
        val ic = m.icon!!
        routes["/a/${ic.sha256}"] = ok(bytes[ic.sha256]!!)
        for (s in ic.sizes) bytes[s.sha256]?.let { routes["/a/${ic.sha256}/${s.w}.webp"] = ok(it) }
    }

    private fun source(decodable: Set<String> = setOf("image/png", "image/webp"), t: PolarisTransport = transport, d: File? = File(dir, "presentation")) =
        DiscoveryPresentationSource("driftkart", d, t, decodable)

    @Test
    fun fetchesTheSmallestFittingWidthWithNoHeadersAndCachesItByHash() = runBlocking {
        val m = member()
        serve(m, mapOf(m.icon!!.sha256 to png, sha(webp64) to webp64, sha(webp128) to webp128))
        val s = source()
        s.accept(m)
        assertArrayEquals(webp128, s.icon(48.0, 2.0))
        assertEquals(1, requests.size)
        val r = requests.single()
        assertEquals("GET", r.method)
        assertEquals("/a/${m.icon!!.sha256}/128.webp", r.path)
        for (name in r.headers.names()) {
            assertFalse("no Authorization", name.equals("authorization", true))
            assertFalse("no cookies", name.equals("cookie", true))
            assertFalse("no X-PKey-* ($name)", name.startsWith("x-pkey-", true))
        }
        assertEquals(listOf(sha(webp128)), s.cachedFiles())
        // A second source (a new process) reads the file, re-hashed, without the network.
        val again = source()
        again.accept(m)
        assertArrayEquals(webp128, again.icon(48.0, 2.0))
        assertEquals(1, requests.size)
    }

    @Test
    fun theRequestShapeIsTheRule() = runBlocking {
        val m = member()
        val scripted = ScriptedTransport { ScriptedTransport.respond(404) }
        val s = source(t = scripted)
        s.accept(m)
        assertNull(s.icon(32.0, 1.0))
        val r = scripted.requests().single()
        assertEquals(emptyMap<String, String>(), r.headers)
        assertFalse("never follows a redirect", r.followRedirects)
        assertEquals(PRESENTATION_ICON_FETCH_TIMEOUT_SECONDS.toDouble(), r.timeoutSeconds, 0.0)
        assertEquals(PRESENTATION_ICON_MAX_BYTES + 1, r.maxBodyBytes)
        assertNull(r.body)
    }

    @Test
    fun aRedirectIsAMissAndIsNotFollowed() = runBlocking {
        val m = member()
        routes["/a/${m.icon!!.sha256}/64.webp"] = { MockResponse().setResponseCode(302).setHeader("Location", "/elsewhere") }
        routes["/elsewhere"] = ok(webp64)
        val s = source()
        s.accept(m)
        assertNull(s.icon(32.0, 1.0))
        assertEquals(listOf("/a/${m.icon!!.sha256}/64.webp"), requests.map { it.path })
        assertTrue(s.cachedFiles().isEmpty())
    }

    @Test
    fun onlyA200Counts() = runBlocking {
        val m = member()
        routes["/a/${m.icon!!.sha256}/64.webp"] = { MockResponse().setResponseCode(203).setBody(Buffer().write(webp64)) }
        val s = source()
        s.accept(m)
        assertNull(s.icon(32.0, 1.0))
        assertTrue(s.cachedFiles().isEmpty())
    }

    @Test
    fun aMismatchIsNeitherShownNorCached() = runBlocking {
        val m = member()
        routes["/a/${m.icon!!.sha256}/64.webp"] = ok("not the bytes".toByteArray())
        val s = source()
        s.accept(m)
        assertNull(s.icon(32.0, 1.0))
        assertTrue(s.cachedFiles().isEmpty())
        // No retry within the call: one request.
        assertEquals(1, requests.size)
    }

    @Test
    fun aBodyPastTheCapIsRefusedEvenWhenItsHashMatches() = runBlocking {
        val big = ByteArray(PRESENTATION_ICON_MAX_BYTES + 1) { 7 }
        val m = member(original = big, sizes = emptyList())
        routes["/a/${sha(big)}"] = ok(big)
        val s = source()
        s.accept(m)
        assertNull(s.icon(32.0, 1.0))
        assertTrue(s.cachedFiles().isEmpty())
        // Exactly at the cap is fine.
        val edge = ByteArray(PRESENTATION_ICON_MAX_BYTES) { 7 }
        val m2 = member(original = edge, sizes = emptyList())
        routes["/a/${sha(edge)}"] = ok(edge)
        s.accept(m2)
        assertEquals(PRESENTATION_ICON_MAX_BYTES, s.icon(32.0, 1.0)!!.size)
    }

    @Test
    fun aTamperedCacheFileIsDeletedAndFetchedAgain() = runBlocking {
        val m = member()
        serve(m, mapOf(m.icon!!.sha256 to png, sha(webp64) to webp64, sha(webp128) to webp128))
        val cache = File(dir, "presentation").also { it.mkdirs() }
        File(cache, sha(webp64)).writeBytes("tampered".toByteArray())
        val s = source()
        s.accept(m)
        assertArrayEquals(webp64, s.icon(32.0, 1.0))
        assertEquals(1, requests.size)
        assertArrayEquals(webp64, File(cache, sha(webp64)).readBytes())
    }

    @Test
    fun theSafeLinkRefusesPlainHttpAndAnotherOrigin() = runBlocking {
        val scripted = ScriptedTransport { ScriptedTransport.respond(200, "x") }
        val s = source(t = scripted)
        // Plain http off loopback (built directly: the parser would have dropped it).
        val ic = PresentationIcon(sha256 = "a".repeat(64), contentType = "image/png", original = "http://img.plrs.im/a")
        s.accept(Presentation(name = "P", icon = ic))
        assertNull(s.icon(32.0, 1.0))
        // A ladder template on another origin than the original.
        val cross = PresentationIcon(
            sha256 = "a".repeat(64), contentType = "image/png", original = "https://img.plrs.im/a",
            url = "https://evil.example/a/{w}.webp", sizes = listOf(PresentationIconSize(64, "b".repeat(64))),
        )
        s.accept(Presentation(name = "P", icon = cross))
        assertNull(s.icon(32.0, 1.0))
        assertTrue(scripted.requests().isEmpty())
    }

    @Test
    fun aLocalOnlyClientNeverFetches() = runBlocking {
        val m = member()
        val s = source(t = NoNetworkTransport)
        s.accept(m)
        assertNull(s.icon(32.0, 1.0))
        assertTrue(requests.isEmpty())
    }

    @Test
    fun nothingDecodableIsNoFetch() = runBlocking {
        val m = member()
        val scripted = ScriptedTransport { ScriptedTransport.respond(200, "x") }
        val s = source(decodable = setOf("image/avif"), t = scripted)
        s.accept(m)
        assertNull(s.icon(32.0, 1.0))
        assertTrue(scripted.requests().isEmpty())
    }

    @Test
    fun concurrentCallsShareOneFetch() = runBlocking {
        val m = member()
        routes["/a/${m.icon!!.sha256}/64.webp"] = { MockResponse().setResponseCode(200).setBody(Buffer().write(webp64)).setBodyDelay(200, java.util.concurrent.TimeUnit.MILLISECONDS) }
        val s = source()
        s.accept(m)
        val got = (1..5).map { async { s.icon(32.0, 1.0) } }.awaitAll()
        got.forEach { assertArrayEquals(webp64, it) }
        assertEquals(1, requests.size)
        // Each caller holds its own copy.
        got[0]!![0] = 0
        assertArrayEquals(webp64, s.icon(32.0, 1.0))
    }

    @Test
    fun aCancelledFetchReleasesTheNextCall() = runBlocking {
        val m = member()
        val path = "/a/${m.icon!!.sha256}/64.webp"
        routes[path] = { MockResponse().setResponseCode(200).setBody(Buffer().write(webp64)).setHeadersDelay(3, java.util.concurrent.TimeUnit.SECONDS) }
        val s = source()
        s.accept(m)
        val first = async { s.icon(32.0, 1.0) }
        kotlinx.coroutines.delay(200)
        first.cancel()
        routes[path] = ok(webp64)
        assertArrayEquals(webp64, kotlinx.coroutines.withTimeout(5_000) { s.icon(32.0, 1.0) })
    }

    @Test
    fun pruneKeepsWhatTheMemberNamesAndAtMostFourFiles() = runBlocking {
        val cache = File(dir, "presentation").also { it.mkdirs() }
        val ladder = (1..6).map { (it * 32) to "width ${it * 32}".toByteArray() }
        val m = member(sizes = ladder)
        // Six named files, oldest first, plus a stray one and an interrupted write.
        ladder.forEachIndexed { i, (_, b) -> File(cache, sha(b)).apply { writeBytes(b); setLastModified(1_000_000L + i * 1000) } }
        File(cache, "f".repeat(64)).writeBytes("stray".toByteArray())
        File(cache, "${"e".repeat(64)}.tmp-abc").writeBytes("partial".toByteArray())
        val s = source()
        s.accept(m)
        val left = s.cachedFiles()
        assertEquals(PRESENTATION_CACHE_MAX_FILES, left.size)
        assertEquals(ladder.takeLast(4).map { sha(it.second) }.sorted(), left)
        assertFalse(File(cache, "${"e".repeat(64)}.tmp-abc").exists())
        assertTrue(File(cache, DiscoveryPresentationSource.MEMBER_FILE).exists())
        // A fresh write keeps the cap and never evicts itself.
        serve(m, mapOf(m.icon!!.sha256 to png) + ladder.associate { sha(it.second) to it.second })
        assertArrayEquals(ladder[0].second, s.icon(32.0, 1.0))
        val after = s.cachedFiles()
        assertEquals(PRESENTATION_CACHE_MAX_FILES, after.size)
        assertTrue(sha(ladder[0].second) in after)
        // No member: every icon file and presentation.json go.
        s.accept(null)
        assertTrue(s.cachedFiles().isEmpty())
        assertFalse(File(cache, DiscoveryPresentationSource.MEMBER_FILE).exists())
        assertNull(s.current())
    }

    @Test
    fun aColdStartReadsTheLastMemberBack() = runBlocking {
        val m = member()
        source().accept(m)
        val cold = source()
        cold.loadCached()
        assertEquals(m, cold.current())
        // A discovery that answered in this session wins over the file.
        val fresh = source()
        fresh.accept(null)
        fresh.loadCached()
        assertNull(fresh.current())
    }

    @Test
    fun anEditedOrForeignPresentationJsonIsRefusedAndDeleted() = runBlocking {
        val file = File(File(dir, "presentation"), DiscoveryPresentationSource.MEMBER_FILE)
        fun write(o: JsonObject) {
            file.parentFile.mkdirs()
            file.writeText(o.toString())
        }
        val m = member()
        val edited = JsonObject(m.toJson() + ("accent" to JsonPrimitive("#2ED6E6")))
        for (doc in listOf(
            JsonObject(mapOf("v" to jsonInt(1), "product" to JsonPrimitive("driftkart"), "presentation" to edited)),
            JsonObject(mapOf("v" to jsonInt(1), "product" to JsonPrimitive("other"), "presentation" to m.toJson())),
            JsonObject(mapOf("v" to jsonInt(2), "product" to JsonPrimitive("driftkart"), "presentation" to m.toJson())),
            JsonObject(mapOf("v" to jsonInt(1), "product" to JsonPrimitive("driftkart"), "presentation" to JsonPrimitive("x"))),
        )) {
            write(doc)
            val s = source()
            s.loadCached()
            assertNull(doc.toString(), s.current())
            assertFalse(doc.toString(), file.exists())
        }
        file.writeText("{not json")
        source().loadCached()
        assertFalse(file.exists())
    }

    @Test
    fun withoutAStateDirectoryEverythingStaysInMemory() = runBlocking {
        val m = member()
        serve(m, mapOf(m.icon!!.sha256 to png, sha(webp64) to webp64, sha(webp128) to webp128))
        val s = source(d = null)
        s.accept(m)
        assertArrayEquals(webp64, s.icon(32.0, 1.0))
        assertArrayEquals(webp64, s.icon(32.0, 1.0))
        assertEquals(1, requests.size)
        assertTrue(s.cachedFiles().isEmpty())
    }

    @Test
    fun coreDiscoveryParsesStoresAndClearsTheMember() = runBlocking {
        val presentation = JsonObject(
            mapOf(
                "name" to JsonPrimitive("Drift Kart"),
                "accent" to JsonPrimitive("#2ED6E6"),
                "unknown" to JsonPrimitive(1),
            ),
        )
        var answer: Int = 0
        val scripted = ScriptedTransport { req ->
            assertTrue(req.url.endsWith("/driftkart/.well-known/polaris.json"))
            when (answer) {
                0 -> ScriptedTransport.respond(200, discovery(presentation).toString())
                1 -> ScriptedTransport.respond(500, "{}")
                else -> ScriptedTransport.respond(200, discovery(null).toString())
            }
        }
        val core = CoreContext(CoreOptions(productSlug = "driftkart", version = "1.0.0", pinnedKeys = mapOf("k" to "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI"), store = InMemoryStore("driftkart"), transport = scripted))
        val heard = ArrayList<Presentation?>()
        val off = core.presentation.subscribe { heard += it }
        assertTrue(core.discover() is DiscoveryResult.Ok)
        val want = Presentation(name = "Drift Kart", accent = "#2ed6e6")
        assertEquals(want, core.presentation.current())
        assertEquals(want, (core.discoveryDocument()!!).presentation)
        answer = 1
        assertTrue(core.discover() is DiscoveryResult.Error)
        assertEquals("a failed discovery keeps the last", want, core.presentation.current())
        answer = 2
        assertTrue(core.discover() is DiscoveryResult.Ok)
        assertNull(core.presentation.current())
        assertEquals(listOf(want, null), heard)
        off()
    }

    private fun discovery(presentation: JsonObject?): JsonObject = JsonObject(
        mapOf(
            "version" to jsonInt(2),
            "product" to JsonPrimitive("driftkart"),
            "name" to JsonPrimitive("driftkart"),
            "core" to JsonObject(if (presentation != null) mapOf("presentation" to presentation) else emptyMap()),
            "services" to JsonObject(emptyMap()),
        ),
    )
}
