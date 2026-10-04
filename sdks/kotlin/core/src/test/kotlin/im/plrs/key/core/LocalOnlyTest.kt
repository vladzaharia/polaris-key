// @pkey-feature core.local
//
// §7.3's local-only profile: `NoNetworkTransport` refuses at the dial with `local-only`, a client
// built on it says so (`localOnly`), an unactivated client's sync makes zero network calls, and
// discovery reports the refusal as an error instead of "the product has no services".

package im.plrs.key.core

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class LocalOnlyTest {
    private val pins = mapOf("k" to "kDJF6Deuexo91hFZ9TAPr2SmjUEuTXdia67UogTEpkI")

    @Test
    fun theTransportRefusesAtTheDial() = runBlocking {
        try {
            NoNetworkTransport.send(PolarisRequest("https://key.plrs.im/djdl/devices"))
            fail("NoNetworkTransport sent a request")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.localOnly, e.code)
        }
    }

    @Test
    fun aLocalOnlyClientMakesNoCallsAndSaysWhy() = runBlocking {
        var calls = 0
        val counting = object : PolarisTransport {
            override suspend fun send(request: PolarisRequest): PolarisResponse {
                calls++
                return NoNetworkTransport.send(request)
            }
        }
        val core = CoreContext(
            CoreOptions(productSlug = "djdl", version = "1.0.0", pinnedKeys = pins, store = InMemoryStore("djdl"), transport = counting),
        )
        core.start()
        // No token: the pass returns before any request.
        assertEquals(SyncResult(), core.sync())
        assertEquals(0, calls)
        // Discovery is an explicit read: the refusal surfaces, the suite default stays.
        val result = core.discover()
        assertTrue(result is DiscoveryResult.Error)
        assertEquals(DEFAULT_SERVICES, core.services())
        assertEquals(1, calls)
        val local = CoreContext(CoreOptions(productSlug = "djdl", version = "1.0.0", pinnedKeys = pins, store = InMemoryStore("djdl"), transport = NoNetworkTransport))
        assertTrue(local.localOnly)
    }

    @Test
    fun aPlaintextBaseUrlIsRefusedBeforeAnythingElse() {
        try {
            CoreContext(CoreOptions(productSlug = "djdl", baseUrl = "http://key.plrs.im", version = "1.0.0", pinnedKeys = pins, store = InMemoryStore()))
            fail("plain http was accepted")
        } catch (e: PolarisException) {
            assertEquals(ErrorCode.insecureBaseUrl, e.code)
        }
        Endpoints("http://localhost:8787/", "djdl").also { assertEquals("http://localhost:8787", it.baseUrl) }
        assertEquals("https://key.plrs.im/a%2Fb/devices", Endpoints("https://key.plrs.im", "a/b").devices)
    }
}
