// The link offer's state around `LinkClient` (identity.link): when an offer may be made, the handle an exchange left,
// the choice a redirect left pending and the decline record. The decline is `sha256(issuer + sub)` kept in the SDK's
// state directory beside the other identity state (on Android `noBackupFilesDir`, never backed up): the hash only.

package im.plrs.key.identity

import im.plrs.key.core.Base64Url
import im.plrs.key.core.CoreContext
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.FileStateSlot
import im.plrs.key.core.MemoryStateSlot
import im.plrs.key.core.PolarisException
import im.plrs.key.core.StateSlot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.security.MessageDigest

private const val DECLINED_FILE = "link-declined"
private const val DECLINED_CAP = 64

/** The declined accounts' hashes, one per line, newest last. Best effort: an unreadable record reads as empty. */
internal class LinkDeclined(private val core: CoreContext) {
    private val slot: StateSlot by lazy {
        core.store.stateDirectory?.let { FileStateSlot(File(it, DECLINED_FILE)) } ?: MemoryStateSlot()
    }

    suspend fun all(): List<String> =
        attempt { withContext(Dispatchers.IO) { slot.read() } }.getOrNull()?.split('\n')?.filter { it.isNotEmpty() } ?: emptyList()

    suspend fun remember(key: String) {
        val known = all()
        if (key in known) return
        val kept = (known + key).takeLast(DECLINED_CAP)
        // A decline that could not be saved still closes the offer for this run.
        attempt { withContext(Dispatchers.IO) { slot.write(kept.joinToString("\n")) } }
    }
}

/** What an accept needs: the link route and keys that outlive a restart. */
internal class LinkAcceptReady(val url: String, val port: im.plrs.key.core.DeviceKeyPort)

/** The link route and the device keys when an accept may be made now, else null and no request. */
internal suspend fun IdentityClient.linkAcceptReady(): LinkAcceptReady? {
    val url = linkReady(declinedAllowed = true)
    val port = deviceKeyPort()?.takeIf { it.persistence() != im.plrs.key.core.DeviceKeyPersistence.memory }
    return if (url != null && port != null) LinkAcceptReady(url, port) else null
}

/** The link route when an offer may be made now, else null and no request. */
internal suspend fun IdentityClient.linkReady(declinedAllowed: Boolean): String? = if (linkAllowed(declinedAllowed)) linkRoute() else null

/** An offer is open for the account signed in now, a device token is held, and the person has not declined it. */
private suspend fun IdentityClient.linkAllowed(declinedAllowed: Boolean): Boolean {
    val held = linkOwnerHolds() && core.token() != null
    return held && (declinedAllowed || !linkDeclined())
}

/** The open offer belongs to the account signed in now; another account's is closed. */
private suspend fun IdentityClient.linkOwnerHolds(): Boolean {
    val owner = linkMemory.owner() ?: return false
    val now = core.storedSubject()
    val mine = now == null || now == owner
    if (!mine) linkMemory.close()
    return mine
}

private suspend fun IdentityClient.linkDeclined(): Boolean {
    val key = linkDeclineKey()
    return key != null && key in linkDeclined.all()
}

/** The product's link route, on this product; null when it serves none. */
private suspend fun IdentityClient.linkRoute(): String? {
    discoverIfNeeded()
    val route = core.discoveryDocument()?.identity?.endpoints?.get("link")?.takeIf { it.isNotEmpty() }
    if (route != null && !route.startsWith(core.endpoints.url(""))) {
        throw PolarisException(ErrorCode.badResponse, "an identity endpoint points outside this product.")
    }
    return route
}

internal suspend fun IdentityClient.linkHeldHandle(): String? = linkMemory.held(core.now())

/** Hold the handle an exchange left, for its lifetime. */
internal suspend fun IdentityClient.linkHold(outcome: ExchangeOutcome) {
    val needs = outcome as? ExchangeOutcome.NeedsSignIn
    val handle = needs?.linkHandle
    val seconds = needs?.expiresInSeconds?.takeIf { it > 0 }
    if (handle != null && seconds != null) linkMemory.hold(handle, core.now() + seconds)
}

/** A licence choice completed: it opens the offer when its redirect started on this device. */
internal fun IdentityClient.linkChoiceCompleted(grant: String, subject: String?) {
    if (linkMemory.choiceCompleted(grant)) linkMemory.open(subject)
}

/** `sha256(issuer + sub)`, base64url; null while the subject is unknown. */
internal suspend fun IdentityClient.linkDeclineKey(): String? {
    val sub = core.storedSubject()?.takeIf { it.isNotEmpty() } ?: return null
    val issuer = core.discoveryDocument()?.identity?.issuer ?: core.endpoints.url("identity")
    return Base64Url.encode(MessageDigest.getInstance("SHA-256").digest((issuer + sub).toByteArray(Charsets.UTF_8)))
}
