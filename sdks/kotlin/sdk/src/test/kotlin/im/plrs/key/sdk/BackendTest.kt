// @pkey-feature core.backend
//
// `client.backend` (WIRE-CONTRACT-V4 §14.5, framework drop-ins §6): the origin allow-list on the
// request and on every redirect hop (refused BEFORE the hop is sent), the shared pre-sync, one
// forced retry with a 10 s floor, and the typed 403 errors. Two MockWebServers on loopback are the
// "backend" and the "other origin"; the backend's origin is the only one in `backend.origins`.

package im.plrs.key.sdk

import im.plrs.key.core.PolarisException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class BackendTest {
    private lateinit var api: MockWebServer
    private lateinit var other: MockWebServer
    private val jws = "aaa.bbb.ccc"
    private val t0 = 1_700_000_000L

    private var now = t0 + 100
    private var clock = 0.0
    private var syncOk = true
    private var syncDelayMs = 0L
    private val syncs = java.util.Collections.synchronizedList(mutableListOf<Boolean>())

    @Before
    fun up() {
        api = MockWebServer().also { it.start() }
        other = MockWebServer().also { it.start() }
    }

    @After
    fun down() {
        api.shutdown()
        other.shutdown()
    }

    private fun origin(s: MockWebServer) = "http://127.0.0.1:${s.port}"

    private fun url(s: MockWebServer, path: String) = origin(s) + path

    private fun backend(origins: List<String> = listOf(origin(api)), held: Boolean = true) = BackendClient(
        origins,
        held = { if (held) BackendClient.Held(jws, t0, t0 + 3600) else null },
        deviceId = { "dev-1" },
        now = { now },
        sync = { force ->
            syncs += force
            if (syncDelayMs > 0) delay(syncDelayMs)
            syncOk
        },
        monotonic = { clock },
    )

    private fun http(b: BackendClient): OkHttpClient = b.install(OkHttpClient.Builder()).build()

    private fun get(url: String, auth: String? = null): Request =
        Request.Builder().url(url).apply { if (auth != null) header("Authorization", auth) }.build()

    private fun problem(status: Int, code: String) =
        MockResponse().setResponseCode(status).setBody("""{"code":"$code"}""")

    @Test
    fun sendsTheLicenceAndDeviceAndKeepsAuthorization() {
        api.enqueue(MockResponse().setBody("ok"))
        val r = http(backend()).newCall(get(url(api, "/x"), "Bearer app")).execute()
        assertEquals("ok", r.body!!.string())
        val seen = api.takeRequest()
        assertEquals(jws, seen.getHeader("X-PKey-License"))
        assertEquals("dev-1", seen.getHeader("X-PKey-Device"))
        assertEquals("Bearer app", seen.getHeader("Authorization"))
        assertEquals(emptyList<Boolean>(), syncs)
    }

    @Test
    fun aForeignOriginIsRefusedBeforeAnythingIsSent() {
        val client = http(backend())
        val e = assertThrows(PolarisException::class.java) {
            client.newCall(get(url(other, "/export?token=SECRET"))).execute()
        }
        assertEquals("backend-origin-not-allowed", e.code)
        assertTrue(e.message!!.contains(origin(other)))
        assertFalse(e.message!!.contains("SECRET"))
        assertFalse(e.message!!.contains("/export"))
        assertEquals(0, other.requestCount)
        assertEquals(emptyList<Boolean>(), syncs)
    }

    @Test
    fun anotherPortOrSchemeIsAnotherOrigin() {
        val client = http(backend(listOf("http://127.0.0.1:1")))
        assertThrows(PolarisException::class.java) { client.newCall(get(url(api, "/x"))).execute() }
        assertEquals(0, api.requestCount)
        assertThrows(PolarisException::class.java) {
            http(backend(emptyList())).newCall(get(url(api, "/x"))).execute()
        }
    }

    @Test
    fun aRedirectToAnotherOriginIsNeverSent() {
        api.enqueue(MockResponse().setResponseCode(302).setHeader("Location", url(other, "/steal")))
        val client = http(backend())
        val e = assertThrows(PolarisException::class.java) { client.newCall(get(url(api, "/export"))).execute() }
        assertEquals("backend-origin-not-allowed", e.code)
        assertTrue(e.message!!.contains(origin(other)))
        assertFalse(e.message!!.contains("steal"))
        assertEquals(1, api.requestCount)
        assertEquals("the hop never left", 0, other.requestCount)
    }

    @Test
    fun aRedirectToAnAllowedOriginCarriesTheHeaders() {
        api.enqueue(MockResponse().setResponseCode(302).setHeader("Location", url(api, "/b")))
        api.enqueue(MockResponse().setBody("ok"))
        http(backend()).newCall(get(url(api, "/a"))).execute().close()
        api.takeRequest()
        val hop = api.takeRequest()
        assertEquals("/b", hop.path)
        assertEquals(jws, hop.getHeader("X-PKey-License"))
    }

    @Test
    fun theApplicationHalfAloneNeverSendsALicence() {
        api.enqueue(MockResponse().setBody("ok"))
        val client = OkHttpClient.Builder().addInterceptor(backend().interceptor()).build()
        val e = assertThrows(PolarisException::class.java) { client.newCall(get(url(api, "/x"))).execute() }
        assertEquals("not-configured", e.code)
        assertNull(api.takeRequest().getHeader("X-PKey-License"))
    }

    @Test
    fun theApplicationHalfAloneCannotLeakOnARedirect() {
        api.enqueue(MockResponse().setResponseCode(302).setHeader("Location", url(other, "/steal")))
        other.enqueue(MockResponse().setBody("x"))
        val client = OkHttpClient.Builder().addInterceptor(backend().interceptor()).build()
        assertThrows(PolarisException::class.java) { client.newCall(get(url(api, "/x"))).execute() }
        assertNull(other.takeRequest(200, TimeUnit.MILLISECONDS)?.getHeader("X-PKey-License"))
    }

    @Test
    fun headersWithoutALicenceIsDeviceOnly() = runBlocking {
        assertEquals(mapOf("X-PKey-Device" to "dev-1"), backend(held = false).headers())
    }

    @Test
    fun concurrentCallersPastTheMarginShareOneUnforcedSync() = runBlocking {
        now = t0 + 3600 - 1799
        syncDelayMs = 100
        val b = backend()
        (1..5).map { async { b.headers() } }.awaitAll()
        assertEquals(listOf(false), syncs.toList())
    }

    @Test
    fun staleForcesOneSyncAndOneRetry() {
        api.enqueue(problem(401, "license_stale"))
        api.enqueue(problem(401, "license_stale"))
        val r = http(backend()).newCall(get(url(api, "/x"))).execute()
        assertEquals(401, r.code)
        assertEquals(listOf(true), syncs.toList())
        assertEquals("one retry, never two", 2, api.requestCount)
    }

    @Test
    fun invalidRetriesAndSucceeds() {
        api.enqueue(problem(401, "license_invalid"))
        api.enqueue(MockResponse().setBody("yes"))
        val r = http(backend()).newCall(get(url(api, "/x"))).execute()
        assertEquals("yes", r.body!!.string())
    }

    @Test
    fun aFailedSyncHandsBackTheBackendsResponse() {
        syncOk = false
        api.enqueue(problem(401, "license_stale"))
        val r = http(backend()).newCall(get(url(api, "/x"))).execute()
        assertEquals(401, r.code)
        assertEquals(1, api.requestCount)
    }

    @Test
    fun forcedSyncsAreTenSecondsApart() {
        repeat(6) { api.enqueue(problem(401, "license_stale")) }
        val client = http(backend())
        repeat(3) { client.newCall(get(url(api, "/x"))).execute().close() }
        assertEquals(listOf(true), syncs.toList())
        clock = 10.0
        client.newCall(get(url(api, "/x"))).execute().close()
        assertEquals(listOf(true, true), syncs.toList())
    }

    @Test
    fun notEntitledAndSignInRequiredThrowTypedAndAreNeverRetried() {
        for (code in listOf("not_entitled", "sign_in_required")) {
            val before = api.requestCount
            api.enqueue(problem(403, code))
            val e = assertThrows(PolarisException::class.java) {
                http(backend()).newCall(get(url(api, "/x"))).execute()
            }
            assertEquals(code, e.code)
            assertEquals(im.plrs.key.core.Copy.message(code), e.message)
            assertEquals(before + 1, api.requestCount)
        }
        assertEquals(emptyList<Boolean>(), syncs.toList())
    }

    @Test
    fun licenseRequiredIsSurfacedNotRetried() {
        api.enqueue(problem(401, "license_required"))
        val r = http(backend()).newCall(get(url(api, "/x"))).execute()
        assertEquals(401, r.code)
        assertEquals(emptyList<Boolean>(), syncs.toList())
    }

    @Test
    fun originNormalisation() {
        assertEquals("https://api.example.com", BackendClient.normalizeOrigin("HTTPS://API.Example.com:443"))
        assertEquals("https://a.example:8443", BackendClient.normalizeOrigin("https://a.example:8443/"))
        assertEquals("http://localhost:3000", BackendClient.normalizeOrigin("http://localhost:3000"))
        assertEquals("http://[::1]:8080", BackendClient.normalizeOrigin("http://[::1]:8080"))
        for (bad in listOf(
            "http://api.example.com", "https://*.example.com", "https://a.example/path", "https://a.example?x=1",
            "https://a.example#f", "https://u:p@a.example", "api.example.com", "ftp://a.example", "https://a.example?", "",
        )) {
            val e = assertThrows(bad, PolarisException::class.java) { BackendClient.normalizeOrigin(bad) }
            assertEquals(bad, "invalid-options", e.code)
        }
    }
}
