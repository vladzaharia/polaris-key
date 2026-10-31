// Silent restore (I-49.11; WIRE-CONTRACT-V5 section 12.11.8): rung 2 of the automatic sign-in ladder.
//
// A device that was signed in keeps a restore key in the platform's end-to-end backup (Block Store on
// Android). A new device of the same person redeems it once and is signed in with no click.
//
//   redeemRestore   POST token with the restore grant: the `restore` device proof over `<restoreId>.<signKey>`,
//                   its sixth line the SHA-256 of the secret. The answer is an [ExchangeOutcome], as the exchange's.
//   enrolRestore    POST restore with the device bearer: `{}` or `{restoreId}`. 201 is a new key (written to the
//                   backup item), 200 `current` leaves the item alone.
//   deleteRestore   DELETE restore: a revocation no gate stops. When discovery serves no `restore` member (the gate or
//                   the product's setting is off) it dials the token endpoint's sibling, as Swift does.
//
// The item is a [PlatformBackupStore] entry, `pkey-restore-<product>`, holding `{"v":1,"restoreId","secret"}`.
// Nothing here logs, prints or keeps the secret outside the item; [RestoreItem] and [RestoreEnrolResult] redact it.
//
// Rules the ladder follows (the same in every SDK):
//   - it runs after rung 1 misses, with no explicit sign-out, when discovery names `restore` and the app's
//     option allows it; the JVM desktop has no backup store, so it is skipped there;
//   - a key is enrolled after any completed sign-in and checked at most once a day on a stored sign-in; the Worker
//     answers `current` while the key is this device's and under 90 days old, else a new key (rotation);
//   - sign-out deletes the item and sends `DELETE restore` before it asks the Worker and whatever the Worker
//     answers; one that cannot reach the Worker is queued (a flag in the no-backup state directory) and retried at the next launch, before any
//     other call;
//   - `invalid_grant` deletes the Android item; a 429, a 503, a network failure or an unavailable store leaves it.
//     Whatever refuses a redeemed key, the ladder goes on to rung 3.

package im.plrs.key.identity

import im.plrs.key.core.DeviceKeyPersistence
import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.DeviceProofException
import im.plrs.key.core.DeviceProofPurpose
import im.plrs.key.core.DeviceProofs
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.IdentityDiscovery
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.net.URLEncoder

/** What `POST restore` answered. */
public sealed interface RestoreEnrolResult {
    /** A new key (201): the client writes [restoreId] and the secret into its backup item. `toString` redacts the secret. */
    public class Enrolled internal constructor(public val restoreId: String, public val secret: String) : RestoreEnrolResult {
        override fun toString(): String = "Enrolled(restoreId=$restoreId, secret=[redacted])"
    }

    /** The held key is this device's and live (200): nothing to write. */
    public data object Current : RestoreEnrolResult

    /** The feature is off here: discovery names no `restore`, or the route answered 404. */
    public data object Unavailable : RestoreEnrolResult

    /** The Worker refused ([code] is its error code, e.g. `account_required`; `rate_limited` carries [retryAfterSeconds]). */
    public data class Refused(val code: String, val status: Int, val retryAfterSeconds: Int? = null) : RestoreEnrolResult
}

/** Conformance replay only: the recorded step addresses the grant to another product or signs another value. */
internal class RestoreReplayOverrides(val proofValue: String?, val product: String?)

/** The value of the restore item. The secret never leaves this class except into a request or the backup. */
internal class RestoreItem(val restoreId: String, val secret: String) {
    override fun toString(): String = "RestoreItem(restoreId=$restoreId, secret=[redacted])"

    fun encode(): ByteArray = JsonObject(
        mapOf("v" to JsonPrimitive(1), "restoreId" to JsonPrimitive(restoreId), "secret" to JsonPrimitive(secret)),
    ).toString().toByteArray(Charsets.UTF_8)

    companion object {
        private val ID = Regex("rk_[A-Za-z0-9_-]{22}")
        private val SECRET = Regex("rs_[A-Za-z0-9_-]{43}")

        fun isId(s: String?): Boolean = s != null && ID.matches(s)

        fun isSecret(s: String?): Boolean = s != null && SECRET.matches(s)

        /** The item in [bytes], or null when it is not a version-1 item with a well-formed id and secret. */
        fun decode(bytes: ByteArray): RestoreItem? {
            val o = JsonText.parseOrNull(String(bytes, Charsets.UTF_8)).objectValue
            val id = o?.get("restoreId").stringValue
            val secret = o?.get("secret").stringValue
            val v1 = (o?.get("v") as? JsonPrimitive)?.content == "1"
            return if (v1 && isId(id) && isSecret(secret)) RestoreItem(id!!, secret!!) else null
        }
    }
}

internal const val DAY_SECONDS = 86_400L
private const val NO_STATUS = 0
private const val HTTP_OK = 200
private const val HTTP_CREATED = 201
private const val HTTP_NOT_FOUND = 404
private const val RESTORE_GRANT_TYPE = "urn:polaris-key:grant-type:restore"

/** The identity fragment when it serves restore (`restore: true` and the endpoint), else null. */
internal suspend fun IdentityClient.restoreFragment(): IdentityDiscovery? {
    discoverIfNeeded()
    return core.discoveryDocument()?.identity?.takeIf { it.restore }
}

/** [url] when it is this product's own (the device's headers go there only). */
internal fun IdentityClient.ownUrl(url: String?): String? = url?.takeIf { it.isNotEmpty() && it.startsWith(core.endpoints.url("")) }

/** The token route for the restore grant, or why there is none (nothing is dialled then). */
private suspend fun IdentityClient.restoreTokenUrl(port: DeviceKeyPort): Pair<String?, ExchangeUnavailableReason?> {
    val memory = port.persistence() == DeviceKeyPersistence.memory
    val fragment = if (memory) null else restoreFragment()
    val url = ownUrl(fragment?.token)
    return when {
        memory -> null to ExchangeUnavailableReason.memoryOnlyKeys
        fragment == null -> null to ExchangeUnavailableReason.noMember
        url == null -> null to ExchangeUnavailableReason.noEndpoint
        else -> url to null
    }
}

private suspend fun DeviceKeyPort.keysOrThrow() = try {
    ensure()
} catch (e: CancellationException) {
    throw e
} catch (e: Exception) {
    throw PolarisException(ErrorCode.deviceKeysUnreadable, "The device keys could not be read.", cause = e)
}

/** The form body of the restore grant: the `restore` proof covers `<restoreId>.<signKey>` and the SHA-256 of the secret. */
private suspend fun IdentityClient.restoreForm(item: RestoreItem, port: DeviceKeyPort, replay: RestoreReplayOverrides?): String {
    val keys = port.keysOrThrow()
    val product = replay?.product ?: core.product
    val proof = try {
        DeviceProofs.sign(
            port,
            DeviceProofPurpose.restore,
            product,
            core.deviceId(),
            value = replay?.proofValue ?: "${item.restoreId}.${keys.signKey}",
            tokenHash = IdentityExchange.tokenHash(item.secret),
        )
    } catch (e: DeviceProofException) {
        throw PolarisException(ErrorCode.invalidArgument, "The restore proof could not be built.", cause = e)
    }
    return listOf(
        "grant_type" to RESTORE_GRANT_TYPE,
        "client_id" to product,
        "restore_id" to item.restoreId,
        "restore_secret" to item.secret,
        "device_key" to proof.signKey,
        "agree_key" to keys.agreeKey,
        "proof" to proof.sig,
    ).joinToString("&") { (k, v) -> "${URLEncoder.encode(k, "UTF-8")}=${URLEncoder.encode(v, "UTF-8")}" }
}

/** The restore grant. [mayStore] answers false to stop before the token is stored. */
internal suspend fun IdentityClient.redeemRestore(
    item: RestoreItem,
    port: DeviceKeyPort,
    personInitiated: Boolean = false,
    replay: RestoreReplayOverrides? = null,
    mayStore: (suspend () -> Boolean)? = null,
): ExchangeOutcome {
    val (own, why) = restoreTokenUrl(port)
    // A recorded step addressed to another product dials that product's route.
    val url = if (replay?.product != null) own?.replace("/${core.product}/", "/${replay.product}/") else own
    if (url == null) return ExchangeOutcome.Unavailable(why!!)
    val res = exchangePost(url, contentType(IdentityRedirect.TOKEN_CONTENT_TYPE), restoreForm(item, port, replay).toByteArray(Charsets.UTF_8))
    return settleTokenAnswer(res, personInitiated, mayStore)
}

private fun enrolResult(res: PolarisResponse): RestoreEnrolResult {
    val json = JsonText.parseOrNull(res.text).objectValue
    return when {
        res.status == HTTP_CREATED && RestoreItem.isId(json?.get("restoreId").stringValue) && RestoreItem.isSecret(json?.get("secret").stringValue) ->
            RestoreEnrolResult.Enrolled(json?.get("restoreId").stringValue!!, json?.get("secret").stringValue!!)

        res.status == HTTP_CREATED -> throw PolarisException(ErrorCode.badResponse, "the restore route answered without a well-formed key.")

        res.status == HTTP_OK && json?.get("status").stringValue == "current" -> RestoreEnrolResult.Current

        res.status == HTTP_NOT_FOUND -> RestoreEnrolResult.Unavailable

        else -> RestoreEnrolResult.Refused(IdentityExchange.errorCode(json, res.status), res.status, IdentityExchange.retryAfter(res, json))
    }
}

/** The restore route, when discovery serves restore and names it on this product. */
private suspend fun IdentityClient.restoreRoute(): String? = restoreFragment()?.let { ownUrl(it.endpoints["restore"]) }

/** `POST restore` with the device bearer. [heldId] is the id the client holds, absent when it holds none. */
internal suspend fun IdentityClient.enrolRestore(heldId: String?): RestoreEnrolResult {
    val url = restoreRoute()
    val token = core.token()
    val body = JsonObject(if (heldId == null) emptyMap() else mapOf("restoreId" to JsonPrimitive(heldId))).toString()
    return when {
        url == null -> RestoreEnrolResult.Unavailable

        token == null -> RestoreEnrolResult.Refused(ErrorCode.noToken, NO_STATUS)

        else -> enrolResult(
            exchangePost(url, contentType("application/json") + ("authorization" to "Bearer $token"), body.toByteArray(Charsets.UTF_8)),
        )
    }
}
