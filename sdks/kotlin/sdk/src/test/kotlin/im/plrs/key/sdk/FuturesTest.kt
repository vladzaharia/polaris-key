// @pkey-feature license.gate license.entitlements
//
// SP-K11: the CompletableFuture adapters return what the suspend API returns, and a refusal
// completes the future exceptionally with the same PolarisException.

package im.plrs.key.sdk

import im.plrs.key.core.CoreOptions
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.LicenseStatus
import im.plrs.key.core.PolarisException
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import im.plrs.key.license.LicenseClientOptions
import java.util.concurrent.ExecutionException
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class FuturesTest {
    private val now = 1_700_000_000L
    private val signer = TestSigner()

    @Test
    fun futuresMirrorTheSuspendApi() {
        val license = signer.licenseDoc("djdl", "dev1", now, entitlements = mapOf("pro" to JsonPrimitive(true)))
        val options = PolarisKeyClientOptions(
            core = CoreOptions(
                productSlug = "djdl", version = "1.0.0", pinnedKeys = signer.trust, trustRefresh = false,
                store = InMemoryStore("djdl", "dev1").also { kotlinx.coroutines.runBlocking { it.setToken("pkeyt_held") } }, clock = { now },
                expectedServices = listOf(ServiceSlug.license),
                transport = ScriptedTransport { r -> if (r.path == "/djdl/license/document") respond(200, license) else respond(404) },
            ),
            license = LicenseClientOptions(fingerprint = false),
        )
        val client = PolarisKeyFutures.create(options).get(10, TimeUnit.SECONDS)
        val pk = PolarisKeyFutures(client)
        pk.start().get(10, TimeUnit.SECONDS)
        pk.sync().get(10, TimeUnit.SECONDS)
        assertEquals(LicenseStatus.ok, pk.status().get(10, TimeUnit.SECONDS).status)
        assertTrue(pk.isEntitled("pro").get(10, TimeUnit.SECONDS))
        try {
            pk.setChannel("nightly").get(10, TimeUnit.SECONDS)
            fail("refused")
        } catch (e: ExecutionException) {
            assertTrue(e.cause is PolarisException)
        }
        client.close()
    }
}
