package im.plrs.key.platform

import android.content.Context

/** What a [PlatformBackup] read answered. Exactly one of four. */
public sealed class PlatformBackupRead {
    /** The stored bytes. [toString] never carries them. */
    public class Found(public val bytes: ByteArray) : PlatformBackupRead() {
        override fun toString(): String = "Found(${bytes.size} bytes)"
    }

    /** The backup is reachable and holds nothing under the key. */
    public data object Missing : PlatformBackupRead()

    /** [reason] is a short fixed word (see [PlatformBackup.Companion]), never provider text. */
    public data class Unavailable(val reason: String) : PlatformBackupRead()

    public data class Refused(val reason: String) : PlatformBackupRead()
}

/** What a [PlatformBackup] write or delete answered. */
public sealed class PlatformBackupWrite {
    /** Done; [cloud] is whether the OS also copies the item to the cloud (end-to-end encrypted only). */
    public data class Done(val cloud: Boolean) : PlatformBackupWrite()

    public data class Unavailable(val reason: String) : PlatformBackupWrite()

    public data class Refused(val reason: String) : PlatformBackupWrite()
}

/**
 * The OS-held backup of the restore item and the Cloud Sync root (I-49), available in every flavour as
 * one surface (the `:core` port `PlatformBackupStore` is adapted from it in `:android`):
 *
 * - `play`: Block Store (`play.BlockStoreBackup`). An item is copied to the cloud only when
 *   `isEndToEndEncryptionAvailable()` is true (**D-5**); otherwise it stays on the device and moves
 *   only device to device.
 * - `direct`: every call answers Unavailable with [REASON_OUTLET], and the build carries no
 *   `com.google.android.gms.auth.blockstore` class.
 *
 * Keys are `pkey-restore-<product>` and `pkey-sync-<product>`: one per product, because an app may
 * hold [MAX_ENTRIES] entries in all. A value is at most [MAX_VALUE_BYTES]. Callbacks arrive on
 * Android's main thread.
 */
public interface PlatformBackup {
    /** False when every call answers Unavailable. */
    public val isSupported: Boolean

    /** Whether an item written now is copied to the cloud (end-to-end encryption is available). False when unavailable. */
    public fun cloudBackup(callback: (Boolean) -> Unit)

    public fun get(key: String, callback: (PlatformBackupRead) -> Unit)

    public fun set(key: String, bytes: ByteArray, callback: (PlatformBackupWrite) -> Unit)

    public fun delete(key: String, callback: (PlatformBackupWrite) -> Unit)

    public companion object {
        public const val RESTORE_PREFIX: String = "pkey-restore-"
        public const val SYNC_PREFIX: String = "pkey-sync-"

        /** Block Store's limits: 4 KB per entry and 16 entries per app. */
        public const val MAX_VALUE_BYTES: Int = 4096
        public const val MAX_ENTRIES: Int = 16

        /** [PlatformBackupRead.Unavailable] and [PlatformBackupWrite.Unavailable] reasons. */
        public const val REASON_OUTLET: String = "outlet"
        public const val REASON_NO_PLAY_SERVICES: String = "no-play-services"
        public const val REASON_UNSUPPORTED: String = "unsupported"
        public const val REASON_FULL: String = "full"
        public const val REASON_FAILED: String = "failed"

        /** [PlatformBackupRead.Refused] and [PlatformBackupWrite.Refused] reasons. */
        public const val REASON_BAD_KEY: String = "bad-key"
        public const val REASON_TOO_LARGE: String = "too-large"

        /** This build's backup: Block Store in `play`, [unsupported] in `direct`. */
        public fun create(context: Context): PlatformBackup = FlavorBackup.create(context)

        /** A backup whose every call answers Unavailable with [reason]. */
        public fun unsupported(reason: String = REASON_OUTLET): PlatformBackup = UnsupportedBackup(reason)

        /** Whether [key] is one of ours: a known prefix and a product slug after it. */
        public fun isOurKey(key: String): Boolean = listOf(RESTORE_PREFIX, SYNC_PREFIX).any { key.startsWith(it) && key.length > it.length }
    }
}

private class UnsupportedBackup(private val reason: String) : PlatformBackup {
    override val isSupported: Boolean get() = false

    override fun cloudBackup(callback: (Boolean) -> Unit): Unit = callback(false)

    override fun get(key: String, callback: (PlatformBackupRead) -> Unit): Unit = callback(PlatformBackupRead.Unavailable(reason))

    override fun set(key: String, bytes: ByteArray, callback: (PlatformBackupWrite) -> Unit): Unit = callback(PlatformBackupWrite.Unavailable(reason))

    override fun delete(key: String, callback: (PlatformBackupWrite) -> Unit): Unit = callback(PlatformBackupWrite.Unavailable(reason))
}
