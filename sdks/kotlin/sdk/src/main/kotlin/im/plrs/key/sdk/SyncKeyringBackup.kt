// The Cloud Sync root in the platform backup (U-39.10; Block Store on the Play flavour). One entry per
// product, `pkey-sync-<product>` (the OS holds 16 entries), whose value names the person and the ring:
// `{"v":1,"subject","ringId","epoch","kid","root"}`.
//
// Rules this file keeps:
//  - The store decides what reaches the cloud: it copies an entry there only when the OS backup is
//    end-to-end encrypted (D-5, `PlatformBackupStore.cloudBackup`). Otherwise the entry stays on the
//    device and moves device to device only. This file writes either way.
//  - A write or a read that fails is not an error: the ring works without a backup, and the device
//    falls through to the wrap or the recovery code.
//  - A sign-out keeps the entry (R-11). Only a reset (a new ring replaces it), a start over and an
//    account deletion (`SyncKeyring.removeBackup`) remove it.
//  - An entry opens only for the person and the ring the Worker serves now, and only when the root in
//    it derives the served `kid`. Anything else is ignored and left where it is.
//  - The root is never printed: the record prints as redacted.

package im.plrs.key.sdk

import im.plrs.key.core.Base64Url
import im.plrs.key.core.BoundedPlatformBackupStore
import im.plrs.key.core.CoreContext
import im.plrs.key.core.JsonText
import im.plrs.key.core.PlatformBackupRead
import im.plrs.key.core.PlatformBackupStore
import im.plrs.key.core.PlatformBackupWrite
import im.plrs.key.core.jsonInt
import im.plrs.key.core.longValue
import im.plrs.key.core.objectValue
import im.plrs.key.core.stringValue
import im.plrs.key.core.sync.SyncCrypto
import im.plrs.key.core.sync.SyncKeys

/** The value of the backup entry. Never printed. */
internal class SyncBackupRecord(val subject: String, val ringId: String, val epoch: Int, val kid: String, val root: String) {
    override fun toString(): String = "SyncBackupRecord(redacted)"

    fun encode(): ByteArray = obj(
        "v" to jsonInt(VERSION.toLong()),
        "subject" to str(subject),
        "ringId" to str(ringId),
        "epoch" to jsonInt(epoch.toLong()),
        "kid" to str(kid),
        "root" to str(root),
    ).toString().toByteArray(Charsets.UTF_8)

    fun isRing(ringId: String, epoch: Int): Boolean = this.ringId == ringId && this.epoch == epoch

    /** Whether this entry is for [subject] and the ring the Worker serves. */
    fun isFor(subject: String, ring: SyncRingPin): Boolean =
        this.subject == subject && ringId == ring.ringId && epoch == ring.epoch && kid == ring.rootKid

    companion object {
        const val VERSION = 1

        fun parse(raw: ByteArray): SyncBackupRecord? {
            val o = JsonText.parseOrNull(raw.toString(Charsets.UTF_8)).objectValue
            val subject = o?.get("subject").stringValue
            val ringId = o?.get("ringId").stringValue
            val epoch = o?.get("epoch").longValue
            val kid = o?.get("kid").stringValue
            val root = o?.get("root").stringValue
            val ok = o != null && o["v"].longValue == VERSION.toLong() && !anyNull(subject, ringId, epoch, kid, root)
            return if (ok) SyncBackupRecord(subject!!, ringId!!, epoch!!.toInt(), kid!!, root!!) else null
        }
    }
}

/** The key ring's side of the platform backup. With no store (the default, and every JVM desktop) each call does nothing. */
internal class RingBackup(
    private val core: CoreContext,
    options: KeyringOptions,
    boundMillis: Long = BoundedPlatformBackupStore.DEFAULT_BOUND_MILLIS,
) {
    // Every call is bounded: a store that does not answer never holds the ring's lock, so never a sign-out either.
    private val host: PlatformBackupStore? = BoundedPlatformBackupStore.of(options.backup, boundMillis)

    // Writing and reading stop with the developer's opt-out; removing does not (Reset, Start over, account deletion).
    private val store: PlatformBackupStore? = host?.takeIf { options.keyBackup }

    private fun key(): String = PlatformBackupStore.syncKey(core.product)

    private suspend fun entry(s: PlatformBackupStore): SyncBackupRecord? =
        (s.get(key()) as? PlatformBackupRead.Found)?.let { SyncBackupRecord.parse(it.bytes) }

    /**
     * Writes [h] for the signed-in person, replacing an earlier entry of theirs. It leaves another person's entry
     * alone (one entry per product, so a second person on the account has no backup). A write that fails removes the
     * person's own entry only when it names another ring or epoch: that entry names a ring that no longer stands.
     */
    suspend fun save(h: HeldRoot) {
        val s = store ?: return
        val subject = core.storedSubject() ?: return
        write(s, subject, h, entry(s))
    }

    private suspend fun write(s: PlatformBackupStore, subject: String, h: HeldRoot, current: SyncBackupRecord?) {
        if (current != null && current.subject != subject) return
        val record = SyncBackupRecord(subject, h.ringId, h.epoch, hex(h.kid), Base64Url.encode(h.root))
        val written = s.set(key(), record.encode()) is PlatformBackupWrite.Done
        if (!written && current != null && !current.isRing(h.ringId, h.epoch)) s.delete(key())
    }

    /** Writes [h] unless the entry already holds this ring for this person: a device that held the root before the backup existed. */
    suspend fun ensure(h: HeldRoot) {
        val s = store ?: return
        val subject = core.storedSubject() ?: return
        val current = entry(s)
        if (current == null || !current.isFor(subject, SyncRingPin(h.ringId, h.epoch, hex(h.kid)))) write(s, subject, h, current)
    }

    /**
     * The root the entry holds for the served [ring], or null: no store, no entry, another person or
     * ring, or a root that does not derive [kid].
     */
    suspend fun find(ring: SyncRingPin, kid: ByteArray): ByteArray? {
        val subject = if (store == null) null else core.storedSubject()
        val found = if (subject == null) null else store?.get(key()) as? PlatformBackupRead.Found
        val record = found?.let { SyncBackupRecord.parse(it.bytes) }
        val root = record?.takeIf { it.isFor(subject!!, ring) }?.let { unb64(it.root, SyncCrypto.ROOT_BYTES) }
        return root?.takeIf { SyncCrypto.equalBytes(SyncKeys.deriveKid(it), kid) }
    }

    /** Deletes the entry, whatever the opt-out. False when it could not be (no store at all counts as nothing to delete: true). */
    suspend fun remove(): Boolean {
        val s = host ?: return true
        return s.delete(key()) is PlatformBackupWrite.Done
    }

    /** A new ring replaced the old: with the backup off, the old entry (an earlier build wrote it) goes too. Best effort. */
    suspend fun dropOldWhenOff() {
        if (store == null) host?.delete(key())
    }
}
