// `client.commerce` (registry `commerce.receipt`, P6-01; notes/SDK-PARITY-PASS.md §3.9): store
// purchases become licence flags. The store sells; the Worker verifies the purchase with the store and
// puts the mapped flag on the player's licence. The device only forwards what its store handed it.
//
//   binding()            `GET /<p>/distribution/commerce/binding` → {bindingId, products}. Call it
//                        BEFORE buying and hand `bindingId` to the store:
//                          Play         BillingFlowParams.setObfuscatedAccountId(bindingId)
//                                       (`:billing`'s PolarisPlayBilling does it for you)
//                          App Store    purchase(product, appAccountToken = bindingId)
//                          Steam        ISteamUser::GetAuthTicketForWebApi(bindingId)
//   claim(store, …)      `POST /<p>/distribution/commerce/claim` → [ClaimResult]. It does not sync
//                        (the commerce-claim transcript pins exactly the claim): on `Ok`, call
//                        `client.sync(force = true)` so the licence document carries the flag. The
//                        one-call helpers (`:billing`'s PolarisPlayBilling) do that for you.
//   claimPlay / claimSteam / claimAppStore   the typed payloads.
//   hiddenHere(flag)     App Store 3.1.3(b): a flag sold elsewhere but not as an App Store product is
//                        hidden on an Apple outlet (the rule Godot applies; Android never hides).
//   isUnlocked(flag)     the licence holds the flag (gate usable, S-19 G11) and the outlet does not hide it.
//
// Refusals keep the server's code and `reason`: `not_entitled` + `no_license` (enrol first),
// `forbidden` + `binding_mismatch` / `bound_elsewhere` / `unbound` / `not_owned`, `bad_request` + a
// store reason, `unavailable` (retry later), `not_found` (commerce is not set up for this store).
// `attestation_required` attests once and retries once where this runtime can attest (§3.10).

package im.plrs.key.sdk

import im.plrs.key.core.CoreContext
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.Feature
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.ServiceSlug
import im.plrs.key.core.boolValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** One store product the operator mapped to a licence flag. */
public data class CommerceProduct(val store: String, val productId: String, val flag: String, val deliverable: String = "app")

/** `binding()`'s answer. */
public data class CommerceBinding(
    /** The licence's opaque purchase binding (a lowercase UUID): what the store purchase carries. */
    val bindingId: String,
    val products: List<CommerceProduct>,
)

/** The stores a claim names. */
public object CommerceStore {
    public const val appStore: String = "app-store"
    public const val play: String = "play"
    public const val steam: String = "steam"
}

/** A claim's outcome (§3.9). Every refusal keeps the server's [code] and `reason`. */
public sealed interface ClaimResult {
    /** The Worker recorded the purchase; the licence carries [flag] from the next document on. */
    public data class Ok(
        val store: String,
        val productId: String?,
        val flag: String?,
        val deliverable: String?,
        val state: String?,
        val granted: Boolean,
        val changed: Boolean,
    ) : ClaimResult

    /** 403 `forbidden` + `not_owned`: the store does not report this account as the owner. */
    public data class NotOwned(val code: String, val message: String?) : ClaimResult

    /** 403 `attestation_required` after the one attest-and-retry (or where this runtime cannot attest). */
    public data object AttestationRequired : ClaimResult

    /** Any other refusal: the server's code and reason. */
    public data class Refused(val code: String, val reason: String?, val status: Int, val message: String?) : ClaimResult

    /** Transport failure or an unreadable answer (`network-error`, `bad_response`). */
    public data class Error(val code: String, val message: String?) : ClaimResult
}

/** The commerce sub-client. */
public class CommerceClient internal constructor(
    private val core: CoreContext,
    private val attest: (suspend () -> Boolean)?,
    private val isEntitled: suspend (String) -> Boolean,
    private val outletKind: suspend () -> String?,
) {
    /** The product list from the last successful [binding] (empty until then). */
    @Volatile public var products: List<CommerceProduct> = emptyList()
        private set

    private suspend fun require() {
        core.requireService(ServiceSlug.license, Feature.commerceReceipt)
        core.requireService(ServiceSlug.distribution, Feature.commerceReceipt)
    }

    private suspend fun bearer(): String = core.token()
        ?: throw PolarisException(ErrorCode.unauthorized, "Activate, enrol or register before using commerce: a claim needs a licence.")

    /** The licence's purchase binding and the store products on sale. Throws [PolarisException] with the server's code. */
    public suspend fun binding(): CommerceBinding {
        require()
        val token = bearer()
        val r = core.request(core.endpoints.url("distribution/commerce/binding"), headers = mapOf("authorization" to "Bearer $token"))
        val o = JsonText.parseOrNull(r.text).objectValue
        if (!r.isOk) throw PolarisException(code(o) ?: "http_${r.status}", o?.get("message").stringValue ?: "commerce/binding answered HTTP ${r.status}.")
        val id = o?.get("bindingId").stringValue?.takeIf { UUID.matches(it) }
            ?: throw PolarisException(ErrorCode.badResponse, "commerce/binding answered no binding UUID.")
        val list = (o?.get("products") as? kotlinx.serialization.json.JsonArray)?.mapNotNull { p ->
            val po = p.objectValue ?: return@mapNotNull null
            CommerceProduct(
                po["store"].stringValue ?: return@mapNotNull null,
                po["productId"].stringValue ?: return@mapNotNull null,
                po["flag"].stringValue ?: return@mapNotNull null,
                po["deliverable"].stringValue ?: "app",
            )
        } ?: emptyList()
        products = list
        return CommerceBinding(id.lowercase(), list)
    }

    /**
     * Claim one store purchase. [payload] is the store's own fields: `signedTransaction` (App Store),
     * `productId` + `purchaseToken` (Play), `ticket` + `dlcAppId` (Steam). On [ClaimResult.Ok] call
     * `client.sync(force = true)` so the flag arrives in the licence document.
     */
    public suspend fun claim(store: String, payload: Map<String, String>): ClaimResult {
        require()
        val body = LinkedHashMap<String, String>()
        body["store"] = store
        val needs = when (store) {
            CommerceStore.appStore -> listOf("signedTransaction")
            CommerceStore.play -> listOf("productId", "purchaseToken")
            CommerceStore.steam -> listOf("ticket", "dlcAppId")
            else -> throw PolarisException(ErrorCode.invalidOptions, "store must be app-store, play or steam.")
        }
        for (k in needs) body[k] = payload[k]?.takeIf { it.isNotEmpty() } ?: throw PolarisException(ErrorCode.invalidOptions, "A $store claim needs $k.")
        bearer()
        var result = post(body)
        if (result == ClaimResult.AttestationRequired && attest != null) {
            val attested = try {
                attest.invoke()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                false
            }
            if (attested) result = post(body)
        }
        return result
    }

    /** A Play purchase: the product id (SKU) and the purchase token Play Billing handed the app. */
    public suspend fun claimPlay(productId: String, purchaseToken: String): ClaimResult =
        claim(CommerceStore.play, mapOf("productId" to productId, "purchaseToken" to purchaseToken))

    /** A Steam DLC: the hex ticket from `GetAuthTicketForWebApi(bindingId)` and the DLC's app id. */
    public suspend fun claimSteam(ticketHex: String, dlcAppId: String): ClaimResult =
        claim(CommerceStore.steam, mapOf("ticket" to ticketHex, "dlcAppId" to dlcAppId))

    /** A StoreKit transaction's signed JWS. Finish the transaction only after this answered [ClaimResult.Ok]. */
    public suspend fun claimAppStore(signedTransaction: String): ClaimResult =
        claim(CommerceStore.appStore, mapOf("signedTransaction" to signedTransaction))

    /** Whether this build's outlet hides [flag] although the licence holds it (App Store 3.1.3(b)). */
    public suspend fun hiddenHere(flag: String): Boolean {
        val kind = outletKind() ?: return false
        if (kind != "app-store" && kind != "testflight") return false
        return hiddenOn(flag, products)
    }

    /** The licence holds [flag] (with a usable gate) and this outlet does not hide it. */
    public suspend fun isUnlocked(flag: String): Boolean = isEntitled(flag) && !hiddenHere(flag)

    private suspend fun post(body: Map<String, String>): ClaimResult {
        val token = bearer()
        val r = try {
            core.request(
                core.endpoints.url("distribution/commerce/claim"), method = "POST",
                headers = mapOf("authorization" to "Bearer $token", "content-type" to "application/json"),
                body = JsonObject(body.mapValues { JsonPrimitive(it.value) }).toString().toByteArray(Charsets.UTF_8),
            )
        } catch (e: CancellationException) {
            throw e
        } catch (e: PolarisException) {
            return ClaimResult.Error(if (e.code == ErrorCode.localOnly) e.code else ErrorCode.networkError, e.message)
        } catch (e: Exception) {
            return ClaimResult.Error(ErrorCode.networkError, e.message)
        }
        val o = JsonText.parseOrNull(r.text).objectValue
        if (r.isOk) {
            if (o == null || o["ok"].boolValue != true) return ClaimResult.Error(ErrorCode.badResponse, "commerce/claim answered a body that is not a claim.")
            return ClaimResult.Ok(
                store = o["store"].stringValue ?: body["store"]!!,
                productId = o["productId"].stringValue,
                flag = o["flag"].stringValue,
                deliverable = o["deliverable"].stringValue,
                state = o["state"].stringValue,
                granted = o["granted"].boolValue == true,
                changed = o["changed"].boolValue == true,
            )
        }
        val code = code(o) ?: "http_${r.status}"
        val reason = o?.get("reason").stringValue ?: o?.get("error").objectValue?.get("reason").stringValue
        val message = o?.get("message").stringValue
        return when {
            code == ErrorCode.attestationRequired -> ClaimResult.AttestationRequired
            code == ErrorCode.forbidden && reason == NOT_OWNED -> ClaimResult.NotOwned(code, message)
            else -> ClaimResult.Refused(code, reason, r.status, message)
        }
    }

    private fun code(o: JsonObject?): String? =
        (o?.get("error").stringValue ?: o?.get("error").objectValue?.get("code").stringValue)?.takeIf { it.isNotEmpty() }

    public companion object {
        /** The refusal reason of a purchase the account does not own. */
        public const val NOT_OWNED: String = "not_owned"
        private val UUID = Regex("^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$")

        /** The App Store rule for a product list: a flag sold somewhere but not as an App Store product is hidden. */
        public fun hiddenOn(flag: String, products: List<CommerceProduct>): Boolean {
            var sold = false
            for (p in products) {
                if (p.flag != flag) continue
                if (p.store == CommerceStore.appStore) return false
                sold = true
            }
            return sold
        }
    }
}
