// Play Billing as licence flags (SP-K05; notes/SDK-PARITY-PASS.md §3.9). `purchase()` is the one
// call a store button makes:
//
//   1. `client.commerce.binding()`         the licence's opaque purchase binding
//   2. Play's purchase flow                 with `obfuscatedAccountId = bindingId`, so the Worker can
//                                           tell the purchase belongs to this licence
//   3. `client.commerce.claimPlay(…)`       the Worker verifies the token with Google and grants the
//                                           mapped flag
//   4. acknowledge                          ONLY after the claim answered ok: an unacknowledged
//                                           purchase is refunded by Play after three days, so a claim
//                                           that failed leaves the purchase to be claimed again
//                                           (restore, or the next launch's listener)
//   5. `client.sync(force = true)`          the licence document now carries the flag
//
// `restore()` claims every purchase Play holds for this account (a reinstall, a new device), and
// `onPurchasesUpdated` claims purchases Play reports outside a flow (a pending purchase that
// completed, a purchase from the Play Store app). Play Billing is behind [PlayBillingPort] so the
// whole flow is testable without Play; [BillingClientPort] is the real one.

package im.plrs.key.billing

import android.app.Activity
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PolarisException
import im.plrs.key.sdk.ClaimResult
import im.plrs.key.sdk.PolarisKeyClient
import kotlinx.coroutines.CancellationException

/** One purchase as Play reports it. */
public data class PlayPurchase(
    val productIds: List<String>,
    val purchaseToken: String,
    /** Play's purchase state: only [PURCHASED] purchases are claimed. */
    val state: Int,
    val acknowledged: Boolean,
    /** The binding the purchase flow carried, when Play reports it. */
    val obfuscatedAccountId: String? = null,
) {
    override fun toString(): String = "PlayPurchase(productIds=$productIds, purchaseToken=[redacted], state=$state, acknowledged=$acknowledged)"

    public companion object {
        public const val UNSPECIFIED: Int = 0
        public const val PURCHASED: Int = 1
        public const val PENDING: Int = 2
    }
}

/** What Play's purchase flow ended with. */
public sealed interface PlayFlowResult {
    public data class Purchased(val purchases: List<PlayPurchase>) : PlayFlowResult
    public data object Cancelled : PlayFlowResult

    /** Play's `BillingResponseCode` and debug message. */
    public data class Failed(val responseCode: Int, val message: String?) : PlayFlowResult
}

/** The Play Billing calls [PolarisPlayBilling] makes. */
public interface PlayBillingPort {
    /** Connect (or keep the connection); false when Play Billing is unavailable on this device. */
    public suspend fun connect(): Boolean

    /** Run the purchase flow for [productId] with [obfuscatedAccountId]; suspends until Play answers. */
    public suspend fun purchase(activity: Activity, productId: String, productType: String, obfuscatedAccountId: String): PlayFlowResult

    /** The purchases Play holds for this account, of [productType]; throws when Play cannot list them. */
    public suspend fun purchases(productType: String): List<PlayPurchase>

    /** Acknowledge one purchase; true when Play took it. */
    public suspend fun acknowledge(purchaseToken: String): Boolean
}

/** [PolarisPlayBilling.purchase]'s outcome. */
public sealed interface PlayPurchaseOutcome {
    /** Claimed, acknowledged and synced: the licence carries [claim]'s flag. */
    public data class Claimed(val claim: ClaimResult.Ok, val acknowledged: Boolean) : PlayPurchaseOutcome

    /** Play holds the purchase as pending (a slow payment method); it is claimed when it completes. */
    public data object Pending : PlayPurchaseOutcome
    public data object Cancelled : PlayPurchaseOutcome

    /** The claim was refused; the purchase stays unacknowledged so a later claim can retry. */
    public data class ClaimRefused(val claim: ClaimResult) : PlayPurchaseOutcome

    /** Play Billing failed or is unavailable ([code] `platform-error`, or `unsupported`). */
    public data class BillingFailed(val code: String, val responseCode: Int?, val message: String?) : PlayPurchaseOutcome
}

/** [PolarisPlayBilling.restore]'s outcome. */
public sealed interface PlayRestoreOutcome {
    /**
     * Each completed purchase Play holds, with its claim. [unlisted] maps a product type Play could not
     * list to Play's message; its purchases were not claimed this time.
     */
    public data class Restored(
        val claims: List<Pair<PlayPurchase, ClaimResult>>,
        val unlisted: Map<String, String?> = emptyMap(),
    ) : PlayRestoreOutcome

    /** Play Billing failed or is unavailable ([code] `platform-error`, or `unsupported`). */
    public data class BillingFailed(val code: String, val responseCode: Int?, val message: String?) : PlayRestoreOutcome
}

/** One-call Play Billing purchases and restores that become licence flags. */
public class PolarisPlayBilling @JvmOverloads constructor(
    private val client: PolarisKeyClient,
    private val billing: PlayBillingPort,
    /** How long `connect()` may take before Billing counts as unavailable (SP-51); default 10 s. */
    private val connectTimeoutMillis: Long = CONNECT_TIMEOUT_MILLIS,
) {
    /** `connect()` within the timeout: a Play that never answers is `unsupported`, not a hang. */
    private suspend fun connected(): Boolean =
        kotlinx.coroutines.withTimeoutOrNull(connectTimeoutMillis) { billing.connect() } == true

    /**
     * Buy [productId] (a Play product the operator mapped to a licence flag) and claim it. [productType]
     * is [PRODUCT_INAPP] or [PRODUCT_SUBS]. Throws [PolarisException] only when the binding cannot be
     * fetched (no licence: enrol first, `not_entitled` + `no_license`).
     */
    public suspend fun purchase(activity: Activity, productId: String, productType: String = PRODUCT_INAPP): PlayPurchaseOutcome {
        if (!connected()) return PlayPurchaseOutcome.BillingFailed(ErrorCode.unsupported, null, "Play Billing is unavailable on this device")
        val binding = client.commerce.binding()
        return when (val flow = billing.purchase(activity, productId, productType, binding.bindingId)) {
            PlayFlowResult.Cancelled -> PlayPurchaseOutcome.Cancelled
            is PlayFlowResult.Failed -> PlayPurchaseOutcome.BillingFailed(ErrorCode.platformError, flow.responseCode, flow.message)
            is PlayFlowResult.Purchased -> {
                // Only a purchase of the requested product is claimed under it. Anything else Play
                // reports stays unacknowledged for restore() or the renewals loop, which claim each
                // purchase under its own product.
                val mine = flow.purchases.filter { productId in it.productIds }
                if (mine.isEmpty()) {
                    return PlayPurchaseOutcome.BillingFailed(ErrorCode.platformError, null, "Play reported no purchase of $productId")
                }
                val purchased = mine.firstOrNull { it.state == PlayPurchase.PURCHASED }
                    ?: return if (mine.any { it.state == PlayPurchase.PENDING }) PlayPurchaseOutcome.Pending
                    else PlayPurchaseOutcome.BillingFailed(ErrorCode.platformError, null, "Play reported no completed purchase")
                when (val claim = claimAndAcknowledge(purchased, productId)) {
                    is Claimed -> {
                        sync()
                        PlayPurchaseOutcome.Claimed(claim.result, claim.acknowledged)
                    }
                    is NotClaimed -> PlayPurchaseOutcome.ClaimRefused(claim.result)
                }
            }
        }
    }

    /**
     * Claim every completed purchase Play holds for this account (a reinstall, a new device), each under
     * its own product. Answers [PlayRestoreOutcome.Restored] with each purchase's claim (syncing once
     * when any claim succeeded) and the product types Play could not list; when Play Billing is
     * unavailable, [PlayRestoreOutcome.BillingFailed] with `unsupported`, as [purchase] does.
     */
    public suspend fun restore(productTypes: List<String> = listOf(PRODUCT_INAPP, PRODUCT_SUBS)): PlayRestoreOutcome {
        if (!connected()) return PlayRestoreOutcome.BillingFailed(ErrorCode.unsupported, null, "Play Billing is unavailable on this device")
        val out = ArrayList<Pair<PlayPurchase, ClaimResult>>()
        val unlisted = LinkedHashMap<String, String?>()
        for (type in productTypes) {
            val held = try {
                billing.purchases(type)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                unlisted[type] = e.message
                continue
            }
            for (p in held) {
                if (p.state != PlayPurchase.PURCHASED) continue
                val product = p.productIds.firstOrNull() ?: continue
                out += p to when (val c = claimAndAcknowledge(p, product)) {
                    is Claimed -> c.result
                    is NotClaimed -> c.result
                }
            }
        }
        if (out.any { it.second is ClaimResult.Ok }) sync()
        if (out.isEmpty() && unlisted.isNotEmpty() && unlisted.size == productTypes.size) {
            return PlayRestoreOutcome.BillingFailed(ErrorCode.platformError, null, unlisted.values.firstOrNull { it != null } ?: "Play could not list purchases")
        }
        return PlayRestoreOutcome.Restored(out, unlisted)
    }

    /**
     * The renewals loop's body: hand it what Play's `PurchasesUpdatedListener` reports outside a flow
     * ([BillingClientPort] does). Completed purchases that are not acknowledged yet are claimed.
     */
    public suspend fun onPurchasesUpdated(purchases: List<PlayPurchase>): List<Pair<PlayPurchase, ClaimResult>> {
        val out = ArrayList<Pair<PlayPurchase, ClaimResult>>()
        for (p in purchases) {
            if (p.state != PlayPurchase.PURCHASED || p.acknowledged) continue
            val product = p.productIds.firstOrNull() ?: continue
            out += p to when (val c = claimAndAcknowledge(p, product)) {
                is Claimed -> c.result
                is NotClaimed -> c.result
            }
        }
        if (out.any { it.second is ClaimResult.Ok }) sync()
        return out
    }

    private sealed interface ClaimStep
    private class Claimed(val result: ClaimResult.Ok, val acknowledged: Boolean) : ClaimStep
    private class NotClaimed(val result: ClaimResult) : ClaimStep

    private suspend fun claimAndAcknowledge(p: PlayPurchase, productId: String): ClaimStep {
        val claim = client.commerce.claimPlay(productId, p.purchaseToken)
        if (claim !is ClaimResult.Ok) return NotClaimed(claim)
        // Acknowledge only after the Worker recorded the purchase.
        val acknowledged = p.acknowledged || try {
            billing.acknowledge(p.purchaseToken)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            false
        }
        return Claimed(claim, acknowledged)
    }

    private suspend fun sync() {
        try {
            client.sync(force = true)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The claim is recorded; the next sync delivers the flag.
        }
    }

    public companion object {
        /** The longest a Billing connection may take (SP-51). */
        public const val CONNECT_TIMEOUT_MILLIS: Long = 10_000

        /** Play's `ProductType.INAPP` (a one-time product). */
        public const val PRODUCT_INAPP: String = "inapp"

        /** Play's `ProductType.SUBS`. */
        public const val PRODUCT_SUBS: String = "subs"
    }
}
