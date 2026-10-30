// Silent restore, the ladder's side (I-49.11; WIRE-CONTRACT-V5 section 12.11.8): rung 2, the enrolment after a
// sign-in and the daily check, the queued `DELETE restore` and what sign-out and the developer's opt-out do. The
// wire primitives (redeem, enrol, delete) are in IdentityRestore.kt; the rules are in its header.

package im.plrs.key.identity

import im.plrs.key.core.DeviceKeyPort
import im.plrs.key.core.ErrorCode
import im.plrs.key.core.PlatformBackupRead
import im.plrs.key.core.PlatformBackupStore
import im.plrs.key.core.PolarisException
import kotlinx.coroutines.CancellationException

internal fun IdentityClient.itemKey() = PlatformBackupStore.restoreKey(core.product)

/** [block]'s answer, or [fallback] when it fails. A restore step never breaks the sign-in around it; cancellation passes through. */
internal suspend fun <T> quietly(fallback: T, block: suspend () -> T): T = try {
    block()
} catch (e: CancellationException) {
    throw e
} catch (e: Exception) {
    fallback
}

internal suspend fun IdentityClient.readBackup(store: PlatformBackupStore): PlatformBackupRead =
    quietly<PlatformBackupRead>(PlatformBackupRead.Unavailable(PlatformBackupStore.REASON_FAILED)) { store.get(itemKey()) }

/** The item, or null for a missing, unreadable or malformed one and for an unavailable store. */
internal suspend fun IdentityClient.readItem(store: PlatformBackupStore): RestoreItem? =
    (readBackup(store) as? PlatformBackupRead.Found)?.let { RestoreItem.decode(it.bytes) }

internal suspend fun IdentityClient.deleteItem(store: PlatformBackupStore) {
    // Best effort: the item is inert once the Worker has dropped the key.
    quietly(Unit) { store.delete(itemKey()) }
}

/** What rung 2's redeem led to: a result, or "go on to rung 3" (null). */
private fun restoreResult(outcome: ExchangeOutcome): AutoSignInResult? = when (outcome) {
    is ExchangeOutcome.SignedIn -> AutoSignInResult.SignedIn(outcome.subject, outcome.licenseId)

    is ExchangeOutcome.PendingConsent -> AutoSignInResult.Confirm(outcome)

    is ExchangeOutcome.PendingSignIn -> AutoSignInResult.Choose(outcome)

    // The key was used and the sign-in refused (terms), or the rung is not served here.
    is ExchangeOutcome.NeedsSignIn, is ExchangeOutcome.Unavailable -> null
}

/**
 * Rung 2. Null means "no result here, go on to rung 3": no store, the option off, no item, restore not served, a
 * refusal of any kind, or a key that was used and then refused.
 */
internal suspend fun IdentityClient.restoreRung(generation: Long): AutoSignInResult? {
    val store = backupStore.get()
    val item = if (store != null && restoreOn.get()) readItem(store) else null
    val port = deviceKeyPort()
    if (store == null || item == null || port == null) return null
    return quietly(null) { redeemForRung(store, item, port, generation) }
}

private suspend fun IdentityClient.redeemForRung(
    store: PlatformBackupStore,
    item: RestoreItem,
    port: DeviceKeyPort,
    generation: Long,
): AutoSignInResult? = try {
    restoreResult(redeemRestore(item, port) { core.signOutGeneration() == generation && !core.explicitSignOut() })
} catch (e: SignedOutDuringExchange) {
    AutoSignInResult.NeedsSignIn(null, AutoSignInReason.SignedOut)
} catch (e: PolarisException) {
    // The key is spent or never was: Android keeps no dead item. A 429, a 503 or a network failure leaves it.
    if (e.code == ErrorCode.invalidGrant) deleteItem(store)
    null
}
