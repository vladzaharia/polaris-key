// @pkey-feature commerce.receipt
package im.plrs.key.billing

import android.app.Activity
import im.plrs.key.core.CoreOptions
import im.plrs.key.core.InMemoryStore
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisRequest
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.testing.ScriptedTransport
import im.plrs.key.core.testing.ScriptedTransport.Companion.respond
import im.plrs.key.core.testing.TestSigner
import im.plrs.key.core.testing.path
import im.plrs.key.license.LicenseClientOptions
import im.plrs.key.sdk.ClaimResult
import im.plrs.key.sdk.PolarisKeyClient
import im.plrs.key.sdk.PolarisKeyClientOptions
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The one-call Play purchase (SP-K05, notes/SDK-PARITY-PASS.md §3.9): the binding rides as
 * obfuscatedAccountId, the purchase is claimed, acknowledged ONLY after the claim answered ok, then
 * synced; a refused claim leaves the purchase unacknowledged; pending and cancelled flows claim
 * nothing; restore and the renewals loop claim what Play holds.
 */
class PolarisPlayBillingTest {
    private val signer = TestSigner()
    private val binding = "f8606ae6-c6af-419a-a7ca-125107444036"

    private class FakePlay(var flow: PlayFlowResult, var held: List<PlayPurchase> = emptyList()) : PlayBillingPort {
        val accountIds = mutableListOf<String>()
        val acknowledged = mutableListOf<String>()
        override suspend fun connect() = true
        override suspend fun purchase(activity: Activity, productId: String, productType: String, obfuscatedAccountId: String): PlayFlowResult {
            accountIds += obfuscatedAccountId
            return flow
        }
        override suspend fun purchases(productType: String) = if (productType == PolarisPlayBilling.PRODUCT_INAPP) held else emptyList()
        override suspend fun acknowledge(purchaseToken: String): Boolean {
            acknowledged += purchaseToken
            return true
        }
    }

    private fun client(claim: (PolarisRequest) -> PolarisResponse): Pair<PolarisKeyClient, ScriptedTransport> = runBlocking {
        val transport = ScriptedTransport { r ->
            when (r.path) {
                "/djdl/distribution/commerce/binding" -> respond(200, """{"bindingId":"$binding","products":[{"store":"play","productId":"skins","flag":"extras.skins"}]}""")
                "/djdl/distribution/commerce/claim" -> claim(r)
                else -> respond(404)
            }
        }
        PolarisKeyClient.create(
            PolarisKeyClientOptions(
                core = CoreOptions(
                    productSlug = "djdl", version = "1.0.0", pinnedKeys = signer.trust, trustRefresh = false,
                    store = InMemoryStore("djdl", "dev1").also { it.setToken("pkeyt_held") }, transport = transport, clock = { 1_700_000_000L },
                    expectedServices = listOf(ServiceSlug.license, ServiceSlug.distribution),
                ),
                license = LicenseClientOptions(fingerprint = false),
            ),
        ) to transport
    }

    private val ok = respond(200, """{"ok":true,"store":"play","productId":"skins","flag":"extras.skins","state":"active","granted":true,"changed":true}""")
    private fun purchased(token: String = "tok1", ack: Boolean = false) = PlayPurchase(listOf("skins"), token, PlayPurchase.PURCHASED, ack)
    private val activity = Activity()

    @Test
    fun aPurchaseIsBoundClaimedAcknowledgedAndSynced() = runBlocking {
        val play = FakePlay(PlayFlowResult.Purchased(listOf(purchased())))
        val (client, transport) = client { ok }
        val out = PolarisPlayBilling(client, play).purchase(activity, "skins")
        assertTrue(out is PlayPurchaseOutcome.Claimed)
        assertEquals(listOf(binding), play.accountIds)
        assertEquals(listOf("tok1"), play.acknowledged)
        val claim = JsonText.parse(transport.requests().single { it.path.endsWith("/claim") }.body!!.toString(Charsets.UTF_8)).objectValue!!
        assertEquals("play", claim["store"].stringValue)
        assertEquals("skins", claim["productId"].stringValue)
        assertEquals("tok1", claim["purchaseToken"].stringValue)
        // The forced sync after the claim.
        assertTrue(transport.requests().any { it.path == "/djdl/license/document" })
    }

    @Test
    fun aRefusedClaimIsNeverAcknowledged() = runBlocking {
        val play = FakePlay(PlayFlowResult.Purchased(listOf(purchased())))
        val (client, _) = client { respond(400, """{"error":{"code":"bad_request"},"reason":"test_purchase"}""") }
        val out = PolarisPlayBilling(client, play).purchase(activity, "skins")
        assertEquals(PlayPurchaseOutcome.ClaimRefused(ClaimResult.Refused("bad_request", "test_purchase", 400, null)), out)
        assertTrue(play.acknowledged.isEmpty())
    }

    @Test
    fun pendingAndCancelledFlowsClaimNothing() = runBlocking {
        val (client, transport) = client { ok }
        assertEquals(PlayPurchaseOutcome.Pending, PolarisPlayBilling(client, FakePlay(PlayFlowResult.Purchased(listOf(purchased().copy(state = PlayPurchase.PENDING))))).purchase(activity, "skins"))
        assertEquals(PlayPurchaseOutcome.Cancelled, PolarisPlayBilling(client, FakePlay(PlayFlowResult.Cancelled)).purchase(activity, "skins"))
        val failed = PolarisPlayBilling(client, FakePlay(PlayFlowResult.Failed(6, "error"))).purchase(activity, "skins")
        assertTrue(failed is PlayPurchaseOutcome.BillingFailed)
        assertTrue(transport.requests().none { it.path.endsWith("/claim") })
    }

    @Test
    fun restoreAndTheRenewalsLoopClaimWhatPlayHolds() = runBlocking {
        val play = FakePlay(PlayFlowResult.Cancelled, held = listOf(purchased("a", ack = true), purchased("b"), purchased("c").copy(state = PlayPurchase.PENDING)))
        val (client, transport) = client { ok }
        val helper = PolarisPlayBilling(client, play)
        val restored = helper.restore()
        assertEquals(listOf("a", "b"), restored.map { it.first.purchaseToken })
        assertTrue(restored.all { it.second is ClaimResult.Ok })
        // Only the unacknowledged one is acknowledged.
        assertEquals(listOf("b"), play.acknowledged)
        // The listener claims a completed purchase made outside a flow, and skips acknowledged ones.
        val updates = helper.onPurchasesUpdated(listOf(purchased("d"), purchased("e", ack = true)))
        assertEquals(listOf("d"), updates.map { it.first.purchaseToken })
        assertEquals(3, transport.requests().count { it.path.endsWith("/claim") })
    }
}
