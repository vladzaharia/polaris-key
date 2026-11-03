// The link offer's requests (identity.link): the bearer call, the `link` device proof and the platform provider's
// part of an accept. Nothing here prints a handle, a token or a proof.

package im.plrs.key.identity

import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.DeviceProofPurpose
import im.plrs.key.core.DeviceProofs
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.objectValue
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonPrimitive
import java.io.IOException

/** Run [block]; a failure is a [Result], but cancelling the coroutine still cancels it. */
internal suspend fun <T> attempt(block: suspend () -> T): Result<T> = runCatching { block() }.onFailure { if (it is CancellationException) throw it }

private fun networkFailure(cause: Exception) = PolarisException(ErrorCode.networkError, "the link request could not be sent.", cause = cause)

private suspend fun IdentityClient.linkHeaders(hasBody: Boolean): Map<String, String> {
    val token = core.token() ?: throw PolarisException(ErrorCode.noToken, "Sign in before linking.")
    return buildMap {
        put("authorization", "Bearer $token")
        if (hasBody) put("content-type", "application/json")
    }
}

/** One request to the link route with the device token as bearer (the route is on this product: `linkReady` checked it). */
internal suspend fun IdentityClient.linkSend(url: String, method: String, body: ByteArray?): PolarisResponse {
    val headers = linkHeaders(body != null)
    return try {
        core.request(url, method = method, headers = headers, body = body)
    } catch (e: PolarisException) {
        throw if (e.code == ErrorCode.localOnly) e else networkFailure(e)
    } catch (e: IOException) {
        throw networkFailure(e)
    }
}

internal suspend fun IdentityClient.linkProof(port: DeviceKeyPort, value: String, tokenHash: String): String =
    attempt { DeviceProofs.sign(port, DeviceProofPurpose.link, core.product, core.deviceId(), value, tokenHash).sig }
        .getOrElse { throw PolarisException(ErrorCode.signInFailed, "the device proof could not be signed.") }

/** A refusal that is not one of the link's own: the code and status only. */
internal fun linkFailure(response: PolarisResponse): PolarisException {
    val code = IdentityExchange.errorCode(JsonText.parseOrNull(response.text).objectValue, response.status)
    return PolarisException(code, "the link route refused the request (${response.status}).", httpStatus = response.status)
}

/** What the installed provider gave over a fresh nonce. */
private class ProviderGrant(val nonce: String, val token: String)

private suspend fun IdentityClient.providerGrant(provider: PlatformIdentityProvider, port: DeviceKeyPort): ProviderGrant? {
    val nonce = (requestExchangeNonce(provider.kind, port) as? NonceStep.Got)?.nonce?.take()
    val subject = nonce?.let { attempt { provider.sheet(it, audienceFor(provider.kind)) }.getOrNull() }
    if (subject != null && subject.token.isEmpty()) throw PolarisException(ErrorCode.signInFailed, "the platform provider returned no token.")
    return if (nonce != null && subject != null) ProviderGrant(nonce, subject.token) else null
}

/**
 * The body of a link by token: the provider is asked once over a fresh nonce and the proof covers the nonce, this
 * device's signing key and the token's hash. Null when there is no provider, nonce or token.
 */
internal suspend fun IdentityClient.linkProviderBody(port: DeviceKeyPort): Map<String, JsonPrimitive>? {
    val provider = platformProvider.get()
    val grant = provider?.let { providerGrant(it, port) }
    if (provider == null || grant == null) return null
    val keys = attempt { port.ensure() }.getOrElse { throw PolarisException(ErrorCode.deviceKeysUnreadable, "The device keys could not be read.") }
    val proof = linkProof(port, "${grant.nonce}.${keys.signKey}", IdentityExchange.tokenHash(grant.token))
    val body = linkedMapOf(
        "subjectToken" to JsonPrimitive(grant.token),
        "nonce" to JsonPrimitive(grant.nonce),
        "signKey" to JsonPrimitive(keys.signKey),
        "agreeKey" to JsonPrimitive(keys.agreeKey),
        "proof" to JsonPrimitive(proof),
    )
    if (provider.kind == ExchangeKind.pgs) body["subjectTokenType"] = JsonPrimitive(IdentityExchange.subjectTokenType(provider.kind))
    return body
}
