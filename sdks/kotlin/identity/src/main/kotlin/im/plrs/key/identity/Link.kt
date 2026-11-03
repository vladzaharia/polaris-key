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

import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.arrayValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

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
        return when (response.status) {
            HTTP_NOT_FOUND -> LinkOfferResult.Unavailable
            HTTP_OK -> LinkOfferResult.Ok(parseOffer(response))
            else -> throw linkFailure(response)
        }
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
        val ready = client.linkAcceptReady() ?: return LinkAcceptResult.Unavailable
        val explicit = linkHandle ?: client.linkHeldHandle()
        var result: LinkAcceptResult
        if (explicit != null) {
            result = post(ready.url, ready.port, explicit, proofValue)
            // A handle that lapsed or was spent is no error for the person: the provider is asked in the same press.
            if (linkHandle == null && isLapsed(result)) {
                client.linkMemory.dropHandle()
                result = viaProvider(ready.url, ready.port)
            }
        } else {
            result = viaProvider(ready.url, ready.port)
        }
        // Linking spends the handle and the step-up, so the next offer is empty (the Worker says so); the app closes the
        // offer with `dismiss()`. An identity another account holds spends them too. Every other answer leaves it where it
        // is: a stale step-up asks the person to sign in again, and a handle nobody issued or a proof that failed spends nothing.
        if (result is LinkAcceptResult.Linked) client.linkMemory.dropHandle()
        if (result is LinkAcceptResult.Refused && result.code == ErrorCode.linkConflict) {
            // An identity that belongs to another account is not offered again here (`offer()` answers Unavailable).
            client.linkMemory.dropHandle()
            client.linkDeclineKey()?.let { client.linkDeclined.remember(it) }
        }
        return result
    }

    /** Not again for this account on this device: `sha256(issuer + sub)` is kept. With no known subject the offer is only closed. */
    public suspend fun decline() {
        val key = client.linkDeclineKey()
        client.linkMemory.close()
        if (key != null) client.linkDeclined.remember(key)
    }

    /** Close the offer for now without remembering a decline. */
    public fun dismiss() {
        client.linkMemory.close()
    }

    private suspend fun post(url: String, port: DeviceKeyPort, handle: String, proofValue: String?): LinkAcceptResult {
        if (!LINK_HANDLE.matches(handle)) return LinkAcceptResult.Refused(HTTP_NOT_FOUND, ErrorCode.notFound)
        val proof = client.linkProof(port, proofValue ?: handle, "-")
        return send(url, mapOf("linkHandle" to JsonPrimitive(handle), "proof" to JsonPrimitive(proof)))
    }

    private suspend fun viaProvider(url: String, port: DeviceKeyPort): LinkAcceptResult {
        val body = client.linkProviderBody(port) ?: return LinkAcceptResult.Unavailable
        return send(url, body)
    }

    private suspend fun send(url: String, body: Map<String, JsonPrimitive>): LinkAcceptResult {
        val response = client.linkSend(url, "POST", JsonObject(body).toString().toByteArray(Charsets.UTF_8))
        val o = JsonText.parseOrNull(response.text).objectValue
        if (response.status == HTTP_OK) {
            val linked = o?.get("linked").objectValue
            val kind = linked?.get("kind").stringValue?.takeIf { it in KINDS }
                ?: throw PolarisException(ErrorCode.badResponse, "the link answered without a link.")
            return LinkAcceptResult.Linked(kind, linked?.get("reach").stringValue)
        }
        val code = IdentityExchange.errorCode(o, response.status)
        if (response.status < HTTP_SERVER_ERROR && code in REFUSALS) return LinkAcceptResult.Refused(response.status, code)
        throw linkFailure(response)
    }
}

private const val HTTP_OK = 200
private const val HTTP_NOT_FOUND = 404
private const val HTTP_SERVER_ERROR = 500

/** `lh_` and 43 base64url characters. */
private val LINK_HANDLE = Regex("lh_[A-Za-z0-9_-]{43}")
private val KINDS = setOf("google", "apple", "gamecenter", "pgs")
private val REFUSALS = setOf(ErrorCode.stepUpRequired, ErrorCode.linkConflict, ErrorCode.invalidGrant, ErrorCode.notFound)

private fun isLapsed(r: LinkAcceptResult): Boolean =
    r is LinkAcceptResult.Refused && (r.code == ErrorCode.invalidGrant || r.code == ErrorCode.notFound)

private fun parseOffer(response: PolarisResponse): List<LinkOfferEntry> {
    val rows = JsonText.parseOrNull(response.text).objectValue?.get("offer").arrayValue
        ?: throw PolarisException(ErrorCode.badResponse, "the link offer answered without an offer.")
    return rows.mapNotNull { row ->
        val o = row.objectValue
        val kind = o?.get("kind").stringValue?.takeIf { it in KINDS }
        val reach = o?.get("reach").stringValue
        kind?.let { LinkOfferEntry(it, reach?.takeIf { r -> r == "global" || r == "developer" }) }
    }
}
