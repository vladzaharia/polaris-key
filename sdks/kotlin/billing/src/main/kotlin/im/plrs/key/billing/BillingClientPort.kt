// [PlayBillingPort] over Play Billing Library 8's BillingClient. One PurchasesUpdatedListener serves
// both the purchase flow in progress and the renewals loop: purchases Play reports while no flow waits
// (a pending purchase that completed, a purchase made in the Play Store app) go to [onUpdate], which
// `PolarisPlayBilling.create` wires to `onPurchasesUpdated`.

package im.plrs.key.billing

import android.app.Activity
import android.content.Context
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Play could not answer a query: its `BillingResponseCode` and debug message. */
public class PlayBillingException(public val responseCode: Int, message: String?) : Exception("Play Billing $responseCode: ${message.orEmpty()}")

/** Play Billing Library's BillingClient as a [PlayBillingPort]. */
public class BillingClientPort(
    context: Context,
    /** Purchases Play reports outside a purchase flow (the renewals loop). */
    private val onUpdate: suspend (List<PlayPurchase>) -> Unit = {},
) : PlayBillingPort {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val flowLock = Mutex()
    @Volatile private var waiting: CompletableDeferred<PlayFlowResult>? = null

    private val listener = PurchasesUpdatedListener { result, purchases ->
        val mapped = purchases.orEmpty().map(::map)
        val w = waiting
        if (w != null && !w.isCompleted) {
            w.complete(
                when (result.responseCode) {
                    BillingClient.BillingResponseCode.OK -> PlayFlowResult.Purchased(mapped)
                    BillingClient.BillingResponseCode.USER_CANCELED -> PlayFlowResult.Cancelled
                    else -> PlayFlowResult.Failed(result.responseCode, result.debugMessage)
                },
            )
        } else if (result.responseCode == BillingClient.BillingResponseCode.OK && mapped.isNotEmpty()) {
            scope.launch { onUpdate(mapped) }
        }
    }

    private val billing: BillingClient = BillingClient.newBuilder(context.applicationContext)
        .setListener(listener)
        .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
        .build()

    override suspend fun connect(): Boolean {
        if (billing.isReady) return true
        return suspendCancellableCoroutine { cont ->
            billing.startConnection(
                object : BillingClientStateListener {
                    override fun onBillingSetupFinished(result: BillingResult) {
                        if (cont.isActive) cont.resume(result.responseCode == BillingClient.BillingResponseCode.OK)
                    }

                    override fun onBillingServiceDisconnected() {
                        // A connection lost before setup finished answers false now (SP-51); the
                        // next connect() starts the connection again.
                        if (cont.isActive) cont.resume(false)
                    }
                },
            )
        }
    }

    override suspend fun purchase(activity: Activity, productId: String, productType: String, obfuscatedAccountId: String): PlayFlowResult = flowLock.withLock {
        val query = QueryProductDetailsParams.newBuilder().setProductList(
            listOf(QueryProductDetailsParams.Product.newBuilder().setProductId(productId).setProductType(productType).build()),
        ).build()
        // Billing 8 answers a QueryProductDetailsResult (fetched details plus the unfetched products).
        val (result, details) = suspendCancellableCoroutine { cont ->
            billing.queryProductDetailsAsync(query) { r, answer -> if (cont.isActive) cont.resume(r to answer.productDetailsList) }
        }
        val product = details.firstOrNull { it.productId == productId }
        if (result.responseCode != BillingClient.BillingResponseCode.OK || product == null) {
            return@withLock PlayFlowResult.Failed(result.responseCode, result.debugMessage.ifEmpty { "Play knows no product $productId" })
        }
        val params = BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(product)
        product.subscriptionOfferDetails?.firstOrNull()?.offerToken?.let { params.setOfferToken(it) }
        val flow = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(listOf(params.build()))
            .setObfuscatedAccountId(obfuscatedAccountId)
            .build()
        val answer = CompletableDeferred<PlayFlowResult>()
        waiting = answer
        try {
            val launched = billing.launchBillingFlow(activity, flow)
            if (launched.responseCode != BillingClient.BillingResponseCode.OK) {
                return@withLock PlayFlowResult.Failed(launched.responseCode, launched.debugMessage)
            }
            answer.await()
        } finally {
            waiting = null
        }
    }

    override suspend fun purchases(productType: String): List<PlayPurchase> = suspendCancellableCoroutine { cont ->
        billing.queryPurchasesAsync(QueryPurchasesParams.newBuilder().setProductType(productType).build()) { r, list ->
            if (!cont.isActive) return@queryPurchasesAsync
            if (r.responseCode == BillingClient.BillingResponseCode.OK) cont.resume(list.map(::map))
            else cont.resumeWithException(PlayBillingException(r.responseCode, r.debugMessage))
        }
    }

    override suspend fun acknowledge(purchaseToken: String): Boolean = suspendCancellableCoroutine { cont ->
        billing.acknowledgePurchase(AcknowledgePurchaseParams.newBuilder().setPurchaseToken(purchaseToken).build()) { r ->
            if (cont.isActive) cont.resume(r.responseCode == BillingClient.BillingResponseCode.OK)
        }
    }

    /** End the Billing connection. */
    public fun close() {
        billing.endConnection()
    }

    private fun map(p: Purchase): PlayPurchase = PlayPurchase(
        productIds = p.products,
        purchaseToken = p.purchaseToken,
        state = when (p.purchaseState) {
            Purchase.PurchaseState.PURCHASED -> PlayPurchase.PURCHASED
            Purchase.PurchaseState.PENDING -> PlayPurchase.PENDING
            else -> PlayPurchase.UNSPECIFIED
        },
        acknowledged = p.isAcknowledged,
        obfuscatedAccountId = p.accountIdentifiers?.obfuscatedAccountId,
    )
}

/** The real thing: [PolarisPlayBilling] over [BillingClientPort], with the renewals loop wired. */
public fun PolarisPlayBilling.Companion.create(context: Context, client: im.plrs.key.sdk.PolarisKeyClient): PolarisPlayBilling {
    lateinit var helper: PolarisPlayBilling
    val port = BillingClientPort(context) { purchases -> helper.onPurchasesUpdated(purchases) }
    helper = PolarisPlayBilling(client, port)
    return helper
}
