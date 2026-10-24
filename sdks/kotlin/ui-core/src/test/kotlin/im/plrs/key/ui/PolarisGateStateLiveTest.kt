package im.plrs.key.ui

import im.plrs.key.core.CoreOptions
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.LicenseStatus
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import im.plrs.key.license.ActivationResult
import im.plrs.key.license.LicenseClientOptions
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.PolarisKeyClientOptions
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The gate state follows the real client: a licence sync reaches it through `client.events`. */
class PolarisGateStateLiveTest {
    private val signer = TestSigner()
    private val now = 1_700_000_000L

    @Test
    fun gateStateUpdatesWhenTheClientActivatesAndSyncs() = runBlocking {
        val transport = ScriptedTransport { r: PolarisRequest ->
            when (r.path) {
                "/djdl/license/activate" -> respond(200, """{"token":"pkeyt_live","schemaVersion":4}""")
                "/djdl/license/document" -> {
                    val device = r.headers["X-PKey-Device"] ?: r.headers["x-pkey-device"] ?: "dev-live"
                    respond(200, signer.licenseDoc("djdl", device, now, emptyMap()), mapOf("etag" to "\"v1\""))
                }
                else -> respond(200, """{"ok":true}""")
            }
        }
        val client = PolarisKeyClient(
            PolarisKeyClientOptions(
                core = CoreOptions(
                    productSlug = "djdl", version = "1.0.0", pinnedKeys = signer.trust, trustRefresh = false,
                    store = InMemoryStore("djdl", "dev-live"), transport = transport, clock = { now },
                    expectedServices = listOf(ServiceSlug.license),
                ),
                license = LicenseClientOptions(fingerprint = false),
            ),
        )
        val scope = CoroutineScope(Dispatchers.Unconfined)
        try {
            val gate = PolarisGateState(client.gateActions(), scope, clock = { now })
            gate.start()
            assertTrue(client.license.activateWithKey("pkey_djdl_x") is ActivationResult.Ok)
            assertEquals(LicenseStatus.ok, gate.gate.value.license?.status)
        } finally {
            scope.cancel()
            client.close()
        }
    }
}
