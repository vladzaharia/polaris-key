// The account on the device (identity.account, WIRE-CONTRACT-V4 §12.3 and §12.6): `subject()`,
// `signOut()` and `openAccount()`. Each is used only when discovery's identity fragment carries the
// endpoint (`account: true` with `subject`, `signout`, `accountPortal`), and the URL is the one the
// fragment published: this client never builds one. A product with Identity off, or a discovery that
// predates the account features, answers `Unavailable`: never a throw and never a request.
//
//   subject()      GET  <subject>    the pairwise subject signed in on the device (`ps_…`), stored
//                                    beside the token; `None` for a key-only device.
//   signOut()      the pre-sign-out hooks run first (Cloud Sync registers its flush there, D-4), then
//                  POST <signout>, then the stored subject is forgotten. The token goes only when the
//                  server answers `released: true` (the sign-in had bound this device to a licence of
//                  the account, which deauthorized it); `released: false` keeps the licence and token.
//   openAccount()  hands discovery's `accountPortal` to the host's opener.
//   attach(confirm) POST <attach> `{confirm}`: false previews the device's own licence and writes
//                  nothing; true puts it in the signed-in account, rotates and stores the token. A
//                  Worker refusal (`account_required`, `license_owned`, `license_email_bound`,
//                  `unauthorized`, `not_found`, ...) is a typed `Refused`, never a throw, and keeps
//                  the token, the cache and the identity.

package im.plrs.key.identity

import im.plrs.key.core.CoreContext
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.IdentityDiscovery
import im.plrs.key.core.JsonText
import im.plrs.key.core.PolarisException
import im.plrs.key.core.PolarisResponse
import im.plrs.key.core.TokenProvenance
import im.plrs.key.core.TokenSource
import im.plrs.key.core.boolValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** `subject()`'s answer. */
public sealed interface SubjectResult {
    /** The pairwise subject of the account signed in on this device. */
    public data class Subject(val subject: String) : SubjectResult

    /** No account is signed in here: a key-only device, or no credential at all. */
    public data object None : SubjectResult

    /** The product does not serve the account features (no `account: true`, or no `subject` endpoint). */
    public data object Unavailable : SubjectResult
}

/** `signOut()`'s answer. */
public sealed interface SignOutResult {
    /**
     * Signed out. [released] is true when the seat was released and the token dropped (the device
     * needs activating again); false when the licence and token stay.
     */
    public data class SignedOut(val released: Boolean) : SignOutResult

    /** The product does not serve sign-out; nothing was sent and nothing changed. */
    public data object Unavailable : SignOutResult
}

/** `openAccount()`'s answer. */
public sealed interface OpenAccountResult {
    /** The host's opener took [url]. */
    public data class Opened(val url: String) : OpenAccountResult

    /** There is no opener, or it declined: show [url] (a link or a QR code) instead. */
    public data class NotOpened(val url: String) : OpenAccountResult

    /** The product publishes no `accountPortal`. */
    public data object Unavailable : OpenAccountResult
}

/** The licence an `attach(confirm = false)` preview names. */
public data class AttachLicense(val id: String, val tierId: String? = null, val name: String? = null)

/** `attach(confirm)`'s answer. */
public sealed interface AttachResult {
    /** `confirm = false`: the device's own licence, written nowhere. */
    public data class Confirm(val license: AttachLicense) : AttachResult

    /**
     * `confirm = true`: the licence is in the signed-in account and the token is rotated and stored.
     * [attached] is `claimed` when this call put it there, null when it already was. The caller syncs,
     * as after `activateWithKey`.
     */
    public data class Ok(val subject: String?, val attached: String?) : AttachResult

    /** The Worker refused ([code] is its error code, e.g. `account_required`). Nothing local changed. */
    public data class Refused(val code: String, val status: Int) : AttachResult

    /** The product publishes no `attach` endpoint (no `account: true`); nothing was sent. */
    public data object Unavailable : AttachResult
}

/** How the host opens the account portal: the system browser on a desktop or phone; true when it did. */
public fun interface AccountOpener {
    public suspend fun open(url: String): Boolean
}

/** A step to run before a sign-out reaches the server (Cloud Sync's flush, D-4). */
public typealias BeforeSignOutHook = suspend () -> Unit

/**
 * Register a step `signOut()` runs (and awaits) before it signs out, in registration order. Cloud
 * Sync's flush registers here (D-4); a hook that throws stops the sign-out. An extension, so the
 * registry's identity surface stays the account calls themselves.
 */
public fun IdentityClient.onBeforeSignOut(hook: BeforeSignOutHook) {
    beforeSignOut.add(hook)
}

internal class IdentityAccount(
    private val core: CoreContext,
    private val opener: AccountOpener?,
    private val hooks: () -> List<BeforeSignOutHook>,
    private val onSubject: suspend (String?) -> Unit,
    private val onSignedOut: suspend () -> Unit,
    /** Raised once the Worker accepted a sign-out: the explicit-sign-out flag and the platform cleanup. */
    private val onAccepted: suspend () -> Unit = {},
) {
    /** The identity fragment, discovering once when this client has not yet (a fragment is never guessed). */
    private suspend fun fragment(): IdentityDiscovery? {
        if (core.discoveryDocument() == null) {
            try {
                core.discover()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                return null
            }
        }
        return core.discoveryDocument()?.identity
    }

    suspend fun subject(): SubjectResult {
        val url = fragment()?.takeIf { it.account }?.subject ?: return SubjectResult.Unavailable
        val token = core.token() ?: return SubjectResult.None
        val response = send(url, "GET", token)
        if (response.status >= 500) throw PolarisException(ErrorCode.serverError, "subject read failed with status ${response.status}.")
        if (response.status != 200) throw PolarisException(ErrorCode.badResponse, "subject read refused (status ${response.status}).")
        val body = JsonText.parseOrNull(response.text).objectValue
            ?: throw PolarisException(ErrorCode.badResponse, "subject read answered without a body.")
        val value = body["subject"]
        val subject = if (value == null || value == JsonNull) {
            null
        } else {
            value.stringValue?.takeIf { it.isNotEmpty() }
                ?: throw PolarisException(ErrorCode.badResponse, "subject read answered a non-string subject.")
        }
        if (core.setSubject(subject)) onSubject(subject)
        return if (subject == null) SubjectResult.None else SubjectResult.Subject(subject)
    }

    suspend fun signOut(): SignOutResult {
        val url = fragment()?.takeIf { it.account }?.signout ?: return SignOutResult.Unavailable
        // A ladder already running must not store a token after this point.
        core.bumpSignOutGeneration()
        // Nothing may be lost to a sign-out: each hook finishes, or throws and the sign-out stops.
        for (hook in hooks()) hook()
        val token = core.token()
        var released = false
        if (token != null) {
            val response = send(url, "POST", token)
            if (response.status >= 500) throw PolarisException(ErrorCode.serverError, "sign-out failed with status ${response.status}.")
            if (response.status != 200) throw PolarisException(ErrorCode.signOutFailed, "sign-out refused (status ${response.status}).")
            val body = JsonText.parseOrNull(response.text).objectValue
                ?: throw PolarisException(ErrorCode.badResponse, "sign-out answered without a body.")
            released = body["released"].boolValue
                ?: throw PolarisException(ErrorCode.badResponse, "sign-out answered without `released`.")
        }
        // The Worker accepted it: nothing silent may sign this person back in.
        onAccepted()
        val had = core.storedSubject() != null
        if (released) {
            core.clearAll()
            onSignedOut()
        } else {
            core.setSubject(null)
            // The token stays, but it is no longer a signed-in person's: rung 1 must not count it.
            core.setTokenProvenance(TokenProvenance.key)
        }
        if (had) onSubject(null)
        return SignOutResult.SignedOut(released)
    }

    suspend fun openAccount(): OpenAccountResult {
        val url = fragment()?.accountPortal ?: return OpenAccountResult.Unavailable
        val opened = try {
            opener?.open(url) == true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            false
        }
        return if (opened) OpenAccountResult.Opened(url) else OpenAccountResult.NotOpened(url)
    }

    suspend fun attach(confirm: Boolean): AttachResult {
        val url = fragment()?.takeIf { it.account }?.attach ?: return AttachResult.Unavailable
        val token = core.token() ?: throw PolarisException(ErrorCode.noToken, "Activate or sign in before attaching.")
        val body = JsonObject(mapOf("confirm" to JsonPrimitive(confirm))).toString().toByteArray()
        val response = send(url, "POST", token, body)
        val json = JsonText.parseOrNull(response.text).objectValue
        if (response.status != 200) {
            val error = json?.get("error")
            val code = error.objectValue?.get("code").stringValue ?: error.stringValue ?: "http_${response.status}"
            return AttachResult.Refused(code, response.status)
        }
        val answer = json ?: throw PolarisException(ErrorCode.badResponse, "attach answered without a body.")
        if (answer["status"].stringValue == "confirm") {
            val l = answer["license"].objectValue
            return AttachResult.Confirm(AttachLicense(l?.get("id").stringValue ?: "", l?.get("tierId").stringValue, l?.get("name").stringValue))
        }
        val newToken = answer["token"].stringValue?.takeIf { it.isNotEmpty() }
            ?: throw PolarisException(ErrorCode.badResponse, "attach answered without a token.")
        val subject = answer["subject"].stringValue?.takeIf { it.isNotEmpty() }
        if (core.storeSignIn(newToken, subject, TokenSource.activate, provenance = TokenProvenance.signin)) onSubject(subject)
        return AttachResult.Ok(subject, if (answer["attached"].stringValue == "claimed") "claimed" else null)
    }

    private suspend fun send(url: String, method: String, token: String, body: ByteArray? = null): PolarisResponse = try {
        val headers = mapOf("authorization" to "Bearer $token") + if (body != null) mapOf("content-type" to "application/json") else emptyMap()
        core.request(url, method = method, headers = headers, body = body)
    } catch (e: CancellationException) {
        throw e
    } catch (e: PolarisException) {
        if (e.code == ErrorCode.localOnly) throw e
        throw PolarisException(ErrorCode.networkError, e.message ?: "network error", cause = e)
    } catch (e: Exception) {
        throw PolarisException(ErrorCode.networkError, e.message ?: "network error", cause = e)
    }
}
