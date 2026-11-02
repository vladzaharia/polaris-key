// `identity.link`: the link offer (identity.link; WIRE-CONTRACT-V5 section 12.11.4). After a sign-in the person
// started on this device (a redirect, native or not), the SDK can offer to add the platform identity the exchange
// found no account for.
//
//   val link = client.identity.link
//   if (link.pending) { (link.offer() as? LinkOfferResult.Ok)?.let { ...show the choice... } }
//   when (val r = link.accept()) {            // the held handle, else one provider prompt
//       is LinkAcceptResult.Linked -> ...     // then link.dismiss()
//       is LinkAcceptResult.Refused -> ...    // step_up_required: sign in again, ask again
//       LinkAcceptResult.Unavailable -> ...
//   }
//   link.decline()                            // not again for this account on this device
//
// Rules:
//   - `offer()` and `accept()` answer Unavailable, with no request, until a sign-in this device started has completed
//     (`SignInOutcome.SignedIn.sameDevice`) and after the account's decline. A device-code, exchange, nearby or restore
//     sign-in never opens the offer, and neither does an answer that carried no subject.
//   - `pending` stays true after a link is made or refused until `dismiss()` or `decline()`: the app closes the offer
//     (the kit calls `dismiss()` after Linked).
//   - The handle an exchange left (`NeedsSignIn.linkHandle`) is held in memory for its lifetime and spent by the attempt
//     that uses it, except by a stale step-up, which leaves it.
//   - The proof is `pkey-proof/1` with purpose `link`, signed through the device key port. The handle, the provider
//     token and the proof never reach a log, a `toString` or an error message.
//   - A decline is `sha256(issuer + sub)`, kept in the SDK's state directory beside the other identity state (on Android
//     `noBackupFilesDir`, never backed up): the hash only, never the identity.

package im.plrs.key.identity

import im.plrs.key.core.Base64Url
import im.plrs.key.core.DeviceKeyPersistence
import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.DeviceProofPurpose
import im.plrs.key.core.DeviceProofs
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.FileStateSlot
import im.plrs.key.core.JsonText
import im.plrs.key.core.MemoryStateSlot
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.StateSlot
import im.plrs.key.core.arrayValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import java.security.MessageDigest

/** One platform identity the account could add. [reach] is what the link would cover (`global` or `developer`), null until a link is made. */
public data class LinkOfferEntry(val kind: String, val reach: String?)

/** `link.offer()`. */
public sealed interface LinkOfferResult {
    public data class Ok(val kinds: List<LinkOfferEntry>) : LinkOfferResult

    /** The product, the gate or the sign-in has no offer, or the person declined it here. */
    public data object Unavailable : LinkOfferResult
}

/**
 * `link.accept()`. [Refused.code] is the Worker's: `step_up_required` (sign in again), `link_conflict` (the identity
 * belongs to another account), `invalid_grant` or `not_found`.
 */
public sealed interface LinkAcceptResult {
    public data class Linked(val kind: String, val reach: String?) : LinkAcceptResult

    public data class Refused(val status: Int, val code: String) : LinkAcceptResult

    public data object Unavailable : LinkAcceptResult
}

/** The offer's memory for one client: whether a same-device sign-in is waiting for an answer, whose, and the handle the exchange left. */
internal class LinkMemory {
    private val lock = Any()
    private var owner: String? = null
    private var handle: String? = null
    private var handleExpiresAt = 0L
    private val choiceGrants = HashSet<String>()

    /** The subject the open offer belongs to; null when none is open. */
    fun owner(): String? = synchronized(lock) { owner }

    /** Open the offer for [subject]; an answer that carried none opens nothing. */
    fun open(subject: String?) {
        if (subject.isNullOrEmpty()) return
        synchronized(lock) { owner = subject }
    }

    fun hold(handle: String, expiresAt: Long) = synchronized(lock) {
        this.handle = handle
        handleExpiresAt = expiresAt
    }

    fun held(now: Long): String? = synchronized(lock) {
        val h = handle
        if (h == null || now >= handleExpiresAt) {
            handle = null
            null
        } else {
            h
        }
    }

    fun dropHandle() = synchronized(lock) { handle = null }

    /** The offer is answered, dismissed or not this account's: nothing is held for it (a choice still waiting stays). */
    fun close() = synchronized(lock) {
        owner = null
        handle = null
    }

    /** Forget everything (sign-out). */
    fun reset() = synchronized(lock) {
        owner = null
        handle = null
        choiceGrants.clear()
    }

    fun choicePending(grant: String) = synchronized(lock) { choiceGrants.add(grant) }

    /** True when [grant] was one this device's redirect left pending; the grant is forgotten. */
    fun choiceCompleted(grant: String): Boolean = synchronized(lock) { choiceGrants.remove(grant) }
}

/** `client.identity.link`. */
public class LinkClient internal constructor(private val client: IdentityClient) {
    /** True after a sign-in this device started, until the person answers, dismisses or signs out. */
    public val pending: Boolean get() = client.linkMemory.owner() != null

    /** `GET link`: the kinds the account could add. */
    public suspend fun offer(): LinkOfferResult {
        val url = client.linkReady(declinedAllowed = false) ?: return LinkOfferResult.Unavailable
        val response = client.linkSend(url, "GET", null)
        if (response.status == 404) return LinkOfferResult.Unavailable
        if (response.status != 200) throw client.linkFailure(response)
        val rows = JsonText.parseOrNull(response.text).objectValue?.get("offer").arrayValue
            ?: throw PolarisException(ErrorCode.badResponse, "the link offer answered without an offer.")
        return LinkOfferResult.Ok(
            rows.mapNotNull { row ->
                val o = row.objectValue ?: return@mapNotNull null
                val kind = o["kind"].stringValue?.takeIf { it in KINDS } ?: return@mapNotNull null
                val reach = o["reach"].stringValue
                LinkOfferEntry(kind, if (reach == "global" || reach == "developer") reach else null)
            },
        )
    }

    /**
     * `POST link`. With the handle the exchange left (or [linkHandle]), no second provider prompt; otherwise the installed
     * platform provider is asked once, over a fresh nonce.
     */
    @JvmOverloads
    public suspend fun accept(linkHandle: String? = null): LinkAcceptResult = accept(linkHandle, null)

    /** Conformance replay only: [proofValue] replaces the value the proof covers. */
    @ConformanceReplayOnly
    public suspend fun acceptRecorded(linkHandle: String?, proofValue: String?): LinkAcceptResult = accept(linkHandle, proofValue)

    private suspend fun accept(linkHandle: String?, proofValue: String?): LinkAcceptResult {
        val url = client.linkReady(declinedAllowed = true) ?: return LinkAcceptResult.Unavailable
        val port = client.deviceKeyPort() ?: return LinkAcceptResult.Unavailable
        if (port.persistence() == DeviceKeyPersistence.memory) return LinkAcceptResult.Unavailable
        val explicit = linkHandle ?: client.linkHeldHandle()
        var result: LinkAcceptResult
        if (explicit != null) {
            result = post(url, port, explicit, proofValue)
            // A handle that lapsed or was spent is no error for the person: the provider is asked in the same press.
            if (linkHandle == null && result is LinkAcceptResult.Refused &&
                (result.code == ErrorCode.invalidGrant || result.code == ErrorCode.notFound)
            ) {
                client.linkMemory.dropHandle()
                result = viaProvider(url, port)
            }
        } else {
            result = viaProvider(url, port)
        }
        // Linking spends the handle and the step-up, so the next offer is empty (the Worker says so); the app closes the
        // offer with `dismiss()`. An identity another account holds spends them too. Every other answer leaves it where it
        // is: a stale step-up asks the person to sign in again, and a handle nobody issued or a proof that failed spends nothing.
        when {
            result is LinkAcceptResult.Linked -> client.linkMemory.dropHandle()

            result is LinkAcceptResult.Refused && result.code == ErrorCode.linkConflict -> {
                // An identity that belongs to another account is not offered again here (`offer()` answers Unavailable).
                client.linkMemory.dropHandle()
                client.linkDeclineKey()?.let { client.linkRemember(it) }
            }
        }
        return result
    }

    /** Not again for this account on this device: `sha256(issuer + sub)` is kept. With no known subject the offer is only closed. */
    public suspend fun decline() {
        val key = client.linkDeclineKey()
        client.linkMemory.close()
        if (key != null) client.linkRemember(key)
    }

    /** Close the offer for now without remembering a decline. */
    public fun dismiss() {
        client.linkMemory.close()
    }

    private suspend fun post(url: String, port: DeviceKeyPort, handle: String, proofValue: String?): LinkAcceptResult {
        if (!IdentityExchange.isHandle(handle)) return LinkAcceptResult.Refused(404, ErrorCode.notFound)
        val proof = client.linkProof(port, proofValue ?: handle, "-")
        return send(url, mapOf("linkHandle" to JsonPrimitive(handle), "proof" to JsonPrimitive(proof)))
    }

    private suspend fun viaProvider(url: String, port: DeviceKeyPort): LinkAcceptResult {
        val provider = client.platformProvider.get() ?: return LinkAcceptResult.Unavailable
        val nonce = when (val step = client.requestExchangeNonce(provider.kind, port)) {
            is NonceStep.Got -> step.nonce.take()
            is NonceStep.Ended -> return LinkAcceptResult.Unavailable
        }
        val subject = try {
            provider.sheet(nonce, client.audienceFor(provider.kind))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return LinkAcceptResult.Unavailable
        } ?: return LinkAcceptResult.Unavailable
        if (subject.token.isEmpty()) throw PolarisException(ErrorCode.signInFailed, "the platform provider returned no token.")
        val keys = try {
            port.ensure()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw PolarisException(ErrorCode.deviceKeysUnreadable, "The device keys could not be read.")
        }
        val proof = client.linkProof(port, "$nonce.${keys.signKey}", IdentityExchange.tokenHash(subject.token))
        val body = linkedMapOf(
            "subjectToken" to JsonPrimitive(subject.token),
            "nonce" to JsonPrimitive(nonce),
            "signKey" to JsonPrimitive(keys.signKey),
            "agreeKey" to JsonPrimitive(keys.agreeKey),
            "proof" to JsonPrimitive(proof),
        )
        if (provider.kind == ExchangeKind.pgs) body["subjectTokenType"] = JsonPrimitive(IdentityExchange.subjectTokenType(provider.kind))
        return send(url, body)
    }

    private suspend fun send(url: String, body: Map<String, JsonPrimitive>): LinkAcceptResult {
        val response = client.linkSend(url, "POST", JsonObject(body).toString().toByteArray(Charsets.UTF_8))
        val o = JsonText.parseOrNull(response.text).objectValue
        if (response.status == 200) {
            val linked = o?.get("linked").objectValue
            val kind = linked?.get("kind").stringValue?.takeIf { it in KINDS }
                ?: throw PolarisException(ErrorCode.badResponse, "the link answered without a link.")
            return LinkAcceptResult.Linked(kind, linked?.get("reach").stringValue)
        }
        val code = IdentityExchange.errorCode(o, response.status)
        if (response.status < 500 && code in REFUSALS) return LinkAcceptResult.Refused(response.status, code)
        throw client.linkFailure(response)
    }

    private companion object {
        val KINDS = setOf("google", "apple", "gamecenter", "pgs")
        val REFUSALS = setOf(ErrorCode.stepUpRequired, ErrorCode.linkConflict, ErrorCode.invalidGrant, ErrorCode.notFound)
    }
}

private const val DECLINED_FILE = "link-declined"
private const val DECLINED_CAP = 64

/** The link route when an offer may be made now, else null and no request: no open offer, the offer belongs to another account, the person declined it, the product serves none, or no device token is held. */
internal suspend fun IdentityClient.linkReady(declinedAllowed: Boolean): String? {
    val owner = linkMemory.owner() ?: return null
    val now = core.storedSubject()
    if (now != null && now != owner) {
        linkMemory.close()
        return null
    }
    if (core.token() == null) return null
    if (!declinedAllowed) {
        val key = linkDeclineKey()
        if (key != null && key in linkDeclinedSet()) return null
    }
    discoverIfNeeded()
    val route = core.discoveryDocument()?.identity?.endpoints?.get("link")?.takeIf { it.isNotEmpty() } ?: return null
    if (!route.startsWith(core.endpoints.url(""))) {
        throw PolarisException(ErrorCode.badResponse, "an identity endpoint points outside this product.")
    }
    return route
}

internal suspend fun IdentityClient.linkHeldHandle(): String? = linkMemory.held(core.now())

/** Hold the handle an exchange left, for its lifetime. */
internal suspend fun IdentityClient.linkHold(outcome: ExchangeOutcome) {
    if (outcome !is ExchangeOutcome.NeedsSignIn) return
    val handle = outcome.linkHandle ?: return
    val seconds = outcome.expiresInSeconds?.takeIf { it > 0 } ?: return
    linkMemory.hold(handle, core.now() + seconds)
}

/** A licence choice completed: it opens the offer when its redirect started on this device. */
internal fun IdentityClient.linkChoiceCompleted(grant: String, subject: String?) {
    if (linkMemory.choiceCompleted(grant)) linkMemory.open(subject)
}

/** One request to the link route with the device token as bearer (the route is on this product: [linkReady] checked it). */
internal suspend fun IdentityClient.linkSend(url: String, method: String, body: ByteArray?): PolarisResponse {
    val token = core.token() ?: throw PolarisException(ErrorCode.noToken, "Sign in before linking.")
    val headers = buildMap {
        put("authorization", "Bearer $token")
        if (body != null) put("content-type", "application/json")
    }
    return try {
        core.request(url, method = method, headers = headers, body = body)
    } catch (e: CancellationException) {
        throw e
    } catch (e: PolarisException) {
        if (e.code == ErrorCode.localOnly) throw e
        throw PolarisException(ErrorCode.networkError, "the link request could not be sent.")
    } catch (e: Exception) {
        throw PolarisException(ErrorCode.networkError, "the link request could not be sent.")
    }
}

internal suspend fun IdentityClient.linkProof(port: DeviceKeyPort, value: String, tokenHash: String): String = try {
    DeviceProofs.sign(port, DeviceProofPurpose.link, core.product, core.deviceId(), value, tokenHash).sig
} catch (e: CancellationException) {
    throw e
} catch (e: Exception) {
    throw PolarisException(ErrorCode.signInFailed, "the device proof could not be signed.")
}

/** A refusal that is not one of the link's own: the code and status only. */
internal fun IdentityClient.linkFailure(response: PolarisResponse): PolarisException {
    val code = IdentityExchange.errorCode(JsonText.parseOrNull(response.text).objectValue, response.status)
    return PolarisException(code, "the link route refused the request (${response.status}).", httpStatus = response.status)
}

/** `sha256(issuer + sub)`, base64url; null while the subject is unknown. */
internal suspend fun IdentityClient.linkDeclineKey(): String? {
    val sub = core.storedSubject()?.takeIf { it.isNotEmpty() } ?: return null
    val issuer = core.discoveryDocument()?.identity?.issuer ?: core.endpoints.url("identity")
    return Base64Url.encode(MessageDigest.getInstance("SHA-256").digest((issuer + sub).toByteArray(Charsets.UTF_8)))
}

private fun IdentityClient.declinedSlot(): StateSlot = declinedSlotValue ?: synchronized(this) {
    declinedSlotValue ?: (core.store.stateDirectory?.let { FileStateSlot(File(it, DECLINED_FILE)) } ?: MemoryStateSlot()).also {
        declinedSlotValue = it
    }
}

private suspend fun IdentityClient.linkDeclinedSet(): List<String> = try {
    withContext(Dispatchers.IO) { declinedSlot().read() }?.split('\n')?.filter { it.isNotEmpty() } ?: emptyList()
} catch (e: CancellationException) {
    throw e
} catch (e: Exception) {
    emptyList()
}

internal suspend fun IdentityClient.linkRemember(key: String) {
    val all = linkDeclinedSet().toMutableList()
    if (key in all) return
    all.add(key)
    val kept = if (all.size > DECLINED_CAP) all.subList(all.size - DECLINED_CAP, all.size) else all
    try {
        withContext(Dispatchers.IO) { declinedSlot().write(kept.joinToString("\n")) }
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        // A decline that could not be saved still closes the offer for this run.
    }
}
