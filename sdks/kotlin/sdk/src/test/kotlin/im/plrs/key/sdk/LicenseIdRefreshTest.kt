// @pkey-feature core.sync license.entitlements
//
// LX-17 (S-19 §7.5, §10.1 risk 1, decision 10): does the Kotlin SDK tolerate a `licenseId` that
// changes on a PLAIN REFRESH (no activation call, the same device token), the way
// `licensing.reanchor: onRefresh` would deliver it?
//
// "Tolerate" is pinned on the three surfaces the audit names:
//   cache       the new document is applied, the accessors read it, and it is what a fresh client
//               restores from the same store while offline;
//   telemetry   the `/devices/report` after the refresh carries the NEW licence's grants, and the
//               current device reports the new `licenseId`;
//   activation  the device stays activated on the SAME token, with no re-activation and no wipe.
//
// Audit result for Kotlin: PASS.

package im.plrs.key.sdk

import im.plrs.key.core.ActivationSource
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.DocOutcome
import im.plrs.key.core.DocumentSlice
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.JsonText
import im.plrs.key.core.LicenseStatus
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.PolarisTransport
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.objectValue
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import im.plrs.key.license.ActivationResult
import im.plrs.key.license.LicenseClientOptions
import java.io.IOException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LicenseIdRefreshTest {
    private val signer = TestSigner()
    private var now = 1_700_000_000L

    private fun options(store: InMemoryStore, transport: PolarisTransport) = PolarisKeyClientOptions(
        core = CoreOptions(
            productSlug = "djdl", version = "1.0.0", pinnedKeys = signer.trust, trustRefresh = false,
            store = store, transport = transport, clock = { now }, expectedServices = listOf(ServiceSlug.license),
        ),
        license = LicenseClientOptions(fingerprint = false),
    )

    private fun entitlements(tier: String): Map<String, JsonElement> =
        mapOf("license.tier" to JsonPrimitive(tier)) + if (tier == "pro") mapOf("pro" to JsonPrimitive(true)) else emptyMap()

    @Test
    fun aLicenseIdChangeOnAPlainRefreshIsTolerated() = runBlocking {
        var licenseId = "lic_trial"
        var tier = "free"
        var etag = "lic-1"
        var issuedAt = now
        val store = InMemoryStore("djdl", "dev1")
        val transport = ScriptedTransport { r: PolarisRequest ->
            when (r.path) {
                "/djdl/license/activate" -> respond(200, """{"token":"pkeyt_lx17","schemaVersion":4}""")
                "/djdl/devices/report" -> respond(200, """{"ok":true}""")
                "/djdl/license/document" ->
                    if (r.headers["if-none-match"] == etag) {
                        respond(304, headers = mapOf("etag" to etag))
                    } else {
                        respond(
                            200,
                            signer.licenseDoc("djdl", "dev1", issuedAt, entitlements(tier), licenseId = licenseId),
                            mapOf("etag" to etag),
                        )
                    }
                else -> respond(404)
            }
        }
        val client = PolarisKeyClient.create(options(store, transport))
        assertTrue(client.activate("pkey_djdl_test") is ActivationResult.Ok)
        assertEquals("lic_trial", client.license.licenseId())
        assertFalse(client.license.isEntitled("pro"))
        val sentBefore = transport.requests().size

        // The server re-anchors this device on another licence; the next plain sync receives it.
        licenseId = "lic_pro"
        tier = "pro"
        etag = "lic-2"
        issuedAt += 60
        now += 60
        val result = client.sync()
        val sent = transport.requests().drop(sentBefore)

        // cache
        assertEquals(DocOutcome.Applied, result.documents[DocumentSlice.license])
        assertEquals("lic_pro", client.license.licenseId())
        assertTrue(client.license.isEntitled("pro"))
        assertEquals(JsonPrimitive("pro"), client.license.entitlements()["license.tier"])
        // activation state
        assertFalse(sent.any { it.path == "/djdl/license/activate" })
        assertEquals(
            setOf("Bearer pkeyt_lx17"),
            transport.requests().filter { it.path == "/djdl/license/document" }.map { it.headers["authorization"] }.toSet(),
        )
        assertEquals(ActivationSource.token, client.license.activation())
        assertEquals(LicenseStatus.ok, client.status().status)
        // telemetry
        val reports = sent.filter { it.path == "/djdl/devices/report" }
        assertEquals(1, reports.size)
        val body = JsonText.parse(reports.single().body!!.toString(Charsets.UTF_8)).objectValue!!
        assertEquals(JsonPrimitive("pro"), body["entitlements"]!!.objectValue!!["license.tier"])
        assertEquals("lic_pro", client.currentDevice().licenseId)

        // The following refresh revalidates the new licence's document normally.
        assertEquals(DocOutcome.Unchanged, client.sync().documents[DocumentSlice.license])
        assertEquals("lic_pro", client.license.licenseId())
        client.close()

        // A fresh client on the same store, fully offline, restores the re-anchored document.
        val offline = PolarisKeyClient.create(
            options(
                store,
                object : PolarisTransport {
                    override suspend fun send(request: PolarisRequest): PolarisResponse = throw IOException("offline")
                },
            ),
        )
        assertEquals("lic_pro", offline.license.licenseId())
        assertTrue(offline.license.isEntitled("pro"))
        assertEquals(LicenseStatus.ok, offline.status().status)
        offline.close()
    }
}
