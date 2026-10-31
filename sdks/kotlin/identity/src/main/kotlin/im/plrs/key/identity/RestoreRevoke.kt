// Silent restore, revocation (I-49.11; WIRE-CONTRACT-V5 section 12.11.8): `DELETE restore`, the queue that carries it
// to the next launch, and what sign-out and the developer's opt-out do. Enrolment is in RestoreEnrolment.kt.

package im.plrs.key.identity

import im.plrs.key.core.PlatformBackupRead
import kotlinx.coroutines.sync.withLock

private const val HTTP_NO_CONTENT = 204
private const val TOKEN_SUFFIX = "token"

/**
 * The route `DELETE restore` dials. A revocation is answered whatever the gates say, so it does not need discovery to
 * serve `restore`: without that member it is the token endpoint's sibling on this product. Null when no discovery
 * document is loaded, or it names neither.
 */
internal suspend fun IdentityClient.deleteRoute(): String? {
    discoverIfNeeded()
    val fragment = core.discoveryDocument()?.identity
    val own = ownUrl(fragment?.endpoints?.get("restore"))
    val sibling = ownUrl(fragment?.token)?.takeIf { it.endsWith("/$TOKEN_SUFFIX") }?.removeSuffix(TOKEN_SUFFIX)?.plus("restore")
    return own ?: sibling
}

/** `DELETE restore` with the device bearer; true on `204`. False when the Worker did not answer 204. Throws on a network failure. */
internal suspend fun IdentityClient.deleteRestore(): Boolean {
    val url = deleteRoute()
    val token = core.token()
    return url != null && token != null &&
        exchangePost(url, mapOf("authorization" to "Bearer $token"), null, method = "DELETE").status == HTTP_NO_CONTENT
}

/**
 * `DELETE restore` for a queued revocation, at the start of a launch. A flag with no bearer stays until a sign-in
 * provides one; one that cannot reach the Worker (or find discovery) stays, to be retried at the next launch. It is
 * dropped only when the Worker answered, or when restore is not served here (the key is inert and other revocations
 * reach it).
 */
internal suspend fun IdentityClient.sendQueuedDelete() {
    if (!core.restoreDeletePending()) return
    val sent = quietly(false) {
        when {
            // No bearer: the flag stays until a sign-in provides one (the first enrolment sends it before it enrols).
            core.token() == null -> false

            else -> {
                discoverIfNeeded()
                // No discovery document (offline): keep the flag. One that names no endpoint: nothing to serve.
                core.discoveryDocument() != null && (deleteRoute() == null || deleteRestore())
            }
        }
    }
    if (sent) core.setRestoreDeletePending(false)
}

/**
 * Sign-out, before the Worker's own `signout` and whatever it answers (or when it cannot be reached): the item goes,
 * and `DELETE restore` is sent with the bearer that is still there, or queued for the next launch.
 */
internal suspend fun IdentityClient.restoreSignOut() {
    val store = backupStore.get() ?: return
    restoreLock.withLock {
        deleteItem(store)
        core.setRestoreCheckedAt(null)
        core.setRestoreDeletePending(true)
        sendQueuedDelete()
    }
}

/** Called once the Worker accepted a sign-out: a check that wrote an item meanwhile does not leave it behind. */
internal suspend fun IdentityClient.restoreAfterSignOut() {
    val store = backupStore.get() ?: return
    restoreLock.withLock { deleteItem(store) }
}

/** The developer turned restore off: this app's item goes, and so does the key at the Worker. Idle when there is nothing to remove. */
internal suspend fun IdentityClient.restoreOptOut() {
    val store = backupStore.get() ?: return
    if (readBackup(store) is PlatformBackupRead.Found || core.restoreCheckedAt() != null) restoreSignOut()
}
