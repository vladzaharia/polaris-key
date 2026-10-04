// @pkey-feature core.sync
//
// The default transport (OkHttp) against a local server: every request carries the `X-PKey-*`
// metadata, an `Authorization` header is never forwarded across a redirect (even to the same
// host), redirects are bounded, a response body can be capped, and a dead endpoint is a
// `network-error`, never a hang.

package im.plrs.key.core

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class TransportTest {
    private lateinit var server: MockWebServer
    private val transport = OkHttpTransport()

    @Before
    fun up() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun down() = server.shutdown()

    @Test
    fun authorizationNeverCrossesARedirect() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "/next"))
        server.enqueue(MockResponse().setResponseCode(200).setBody("ok"))
        val response = transport.send(
            PolarisRequest(server.url("/first").toString(), headers = mapOf("Authorization" to "Bearer pkeyt_x", "X-PKey-Device" to "d")),
        )
        assertEquals(200, response.status)
        assertEquals("ok", response.text)
        val first = server.takeRequest()
        val second = server.takeRequest()
        assertEquals("Bearer pkeyt_x", first.getHeader("Authorization"))
        assertNull(second.getHeader("Authorization"))
        assertEquals("d", second.getHeader("X-PKey-Device"))
        assertEquals("/next", second.path)
    }

    @Test
    fun redirectsAreBounded() = runBlocking {
        repeat(7) { server.enqueue(MockResponse().setResponseCode(307).setHeader("Location", "/loop")) }
        try {
            transport.send(PolarisRequest(server.url("/loop").toString()))
            fail("an endless redirect was followed")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.tooManyRedirects, e.code)
        }
    }

    @Test
    fun aBodyCanBeCapped() = runBlocking {
        server.enqueue(MockResponse().setBody("x".repeat(10_000)))
        val response = transport.send(PolarisRequest(server.url("/big").toString(), maxBodyBytes = 100))
        assertTrue(response.body.size <= 100)
    }

    @Test
    fun aDeadEndpointIsANetworkError() = runBlocking {
        val url = server.url("/gone").toString()
        server.shutdown()
        try {
            transport.send(PolarisRequest(url, timeoutSeconds = 5.0))
            fail("a dead endpoint answered")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.networkError, e.code)
        }
        server = MockWebServer().also { it.start() }
    }

    @Test
    fun theCoreSendsItsMetadataOnEveryRequest() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(404))
        val core = CoreContext(
            CoreOptions(
                productSlug = "djdl", baseUrl = server.url("/").toString().replace("127.0.0.1", "localhost"),
                version = "0.0.0-beta.3", pinnedKeys = emptyMap(), store = InMemoryStore("djdl", "DEV"),
                transport = transport,
            ),
        )
        core.start()
        assertTrue(core.discover() is DiscoveryResult.NotFound)
        val request = server.takeRequest()
        assertEquals("/djdl/.well-known/polaris.json", request.path)
        assertEquals("DEV", request.getHeader(HeaderName.device))
        assertEquals("0.0.0-beta.3", request.getHeader(HeaderName.version))
        assertEquals("beta", request.getHeader(HeaderName.channel))
        assertEquals(SdkId.kotlin, request.getHeader(HeaderName.sdkName))
        assertEquals(POLARIS_SDK_VERSION, request.getHeader(HeaderName.sdkVersion))
        RuntimeFamily.platformHeader?.let { assertEquals(it, request.getHeader(HeaderName.platform)) }
        Unit
    }
}
