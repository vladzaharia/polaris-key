// Silent restore, enrolment and revocation (I-49.11; WIRE-CONTRACT-V5 section 12.11.8): the key enrolled after a
// sign-in and checked daily, the queued `DELETE restore`, and what sign-out and the developer's opt-out do. Rung 2
// itself is in RestoreLadder.kt; the wire primitives are in IdentityRestore.kt.

package im.plrs.key.identity

import im.plrs.key.core.PlatformBackupRead
import im.plrs.key.core.PlatformBackupStore
import im.plrs.key.core.PlatformBackupWrite
import im.plrs.key.core.TokenProvenance

/** Whether a stored sign-in may enrol now: signed in (not signed out), served here, and due. */
private suspend fun IdentityClient.enrolDue(force: Boolean): Boolean {
    val signedIn = !core.explicitSignOut() && core.token() != null && core.tokenProvenance() == TokenProvenance.signin
    val last = core.restoreCheckedAt()
    val fresh = last != null && core.now() - last in 0 until DAY_SECONDS
    return signedIn && (force || !fresh) && restoreFragment() != null
}

/** Write a freshly enrolled key into the backup item; true when it is written. */
private suspend fun IdentityClient.keepKey(store: PlatformBackupStore, key: RestoreEnrolResult.Enrolled): Boolean =
    store.set(itemKey(), RestoreItem(key.restoreId, key.secret).encode()) is PlatformBackupWrite.Done

/**
 * Enrol, or check, this device's key (best effort; never throws but for cancellation). [force] ignores the
 * 24 h interval (after a completed sign-in). A held id the Worker no longer knows (a redeemed key) gets a new key.
 * Skipped without a store, with the option off, after an explicit sign-out, without a signed-in token, when
 * restore is not served, and when the backup is unavailable (a key nobody could keep).
 */
internal suspend fun IdentityClient.enrolRestoreIfDue(force: Boolean) {
    val store = backupStore.get()
    if (store == null || !restoreOn.get()) return
    quietly(Unit) {
        if (enrolDue(force)) {
            sendQueuedDelete()
            val read = readBackup(store)
            val canKeep = read is PlatformBackupRead.Found || read is PlatformBackupRead.Missing
            val held = (read as? PlatformBackupRead.Found)?.let { RestoreItem.decode(it.bytes)?.restoreId }
            val done = canKeep && when (val result = enrolRestore(held)) {
                // The Worker replaced this device's key: only a written item holds the new one.
                is RestoreEnrolResult.Enrolled -> keepKey(store, result)

                RestoreEnrolResult.Current -> true

                RestoreEnrolResult.Unavailable, is RestoreEnrolResult.Refused -> false
            }
            if (done) core.setRestoreCheckedAt(core.now())
        }
    }
}

/** Called after every completed sign-in, from any rung or form. */
internal suspend fun IdentityClient.afterSignIn() {
    enrolRestoreIfDue(force = true)
}

/**
 * `DELETE restore` for a queued revocation, at the start of a launch. A flag that cannot be served (nothing to
 * authenticate with, or restore not served here: the key is inert and other revocations reach it) is dropped; one
 * that failed to reach the Worker stays, to be retried at the next launch.
 */
internal suspend fun IdentityClient.sendQueuedDelete() {
    if (!core.restoreDeletePending()) return
    val sent = quietly(false) { core.token() == null || restoreFragment() == null || deleteRestore() }
    if (sent) core.setRestoreDeletePending(false)
}

/** Sign-out (the Worker accepted it): the item goes whatever the Worker answered, and the revocation is sent or queued. */
internal suspend fun IdentityClient.restoreSignOut() {
    val store = backupStore.get() ?: return
    deleteItem(store)
    core.setRestoreCheckedAt(null)
    core.setRestoreDeletePending(true)
    sendQueuedDelete()
}

/** The developer turned restore off: this app's item goes, and so does the key at the Worker. Idle when there is nothing to remove. */
internal suspend fun IdentityClient.restoreOptOut() {
    val store = backupStore.get() ?: return
    if (readBackup(store) is PlatformBackupRead.Found || core.restoreCheckedAt() != null) restoreSignOut()
}
