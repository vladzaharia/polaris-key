// Silent restore, enrolment and revocation (I-49.11; WIRE-CONTRACT-V5 section 12.11.8): the key enrolled after a
// sign-in and checked daily, the queued `DELETE restore`, and what sign-out and the developer's opt-out do. Rung 2
// itself is in RestoreLadder.kt; the wire primitives are in IdentityRestore.kt.

package im.plrs.key.identity

import im.plrs.key.core.PlatformBackupRead
import im.plrs.key.core.PlatformBackupStore
import im.plrs.key.core.PlatformBackupWrite
import im.plrs.key.core.TokenProvenance
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withLock

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
 * restore is not served, and when the backup is unavailable (a key nobody could keep). It runs one at a time with
 * sign-out's revocation, so a key cannot be minted into the item while a sign-out is deleting it. With a
 * [generation], it does nothing when a sign-out began since the generation was read.
 */
internal suspend fun IdentityClient.enrolRestoreIfDue(force: Boolean, generation: Long? = null) {
    val store = backupStore.get()
    if (store == null || !restoreOn.get()) return
    restoreLock.withLock {
        if (generation != null && core.signOutGeneration() != generation) return
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
}

/**
 * Rung 1's daily check, detached: the sign-in result is returned first and the check never delays a launch. A
 * failure is swallowed (the next launch checks again). [generation] is the sign-out generation the ladder read: a
 * sign-out that began since stops the check, and one that begins during it waits for it, then revokes what it enrolled.
 */
internal fun IdentityClient.launchDailyRestoreCheck(generation: Long) {
    if (backupStore.get() == null || !restoreOn.get() || dailyCheck.get()?.isActive == true) return
    dailyCheck.set(
        restoreScope.launch {
            // Best effort: a failure is the next launch's retry.
            quietly(Unit) { enrolRestoreIfDue(force = false, generation = generation) }
        },
    )
}

/** Wait for the detached daily check, if one is running (tests; a host that is shutting down). */
internal suspend fun IdentityClient.awaitDailyRestoreCheck() {
    dailyCheck.get()?.join()
}

/** Called after every completed sign-in, from any rung or form. */
internal suspend fun IdentityClient.afterSignIn() {
    enrolRestoreIfDue(force = true)
}
