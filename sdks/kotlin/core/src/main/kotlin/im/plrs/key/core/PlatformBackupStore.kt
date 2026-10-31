package im.plrs.key.core

import kotlinx.coroutines.withTimeoutOrNull

/**
 * What a read of the platform backup answered. Exactly one of four; [Unavailable] and [Refused] are
 * typed answers, never a missing method or a quiet empty result.
 */
public sealed class PlatformBackupRead {
    /** The stored bytes. */
    public class Found(public val bytes: ByteArray) : PlatformBackupRead() {
        // The bytes can be a secret: never in a log line or a crash report.
        override fun toString(): String = "Found(${bytes.size} bytes)"
    }

    /** The backup is reachable and holds nothing under the key. */
    public data object Missing : PlatformBackupRead()

    /** No backup here, or it cannot be reached now. [reason] is one of the `PlatformBackupStore.REASON_*` words. */
    public data class Unavailable(val reason: String) : PlatformBackupRead()

    /** The key is not one of ours. */
    public data class Refused(val reason: String) : PlatformBackupRead()
}

/** What a write or a delete of the platform backup answered. */
public sealed class PlatformBackupWrite {
    /**
     * Done. For a write, [cloud] is whether the OS also copies the item to the cloud (true only when
     * that copy is end-to-end encrypted, **D-5**); false keeps it local, for a device-to-device move
     * only. A delete answers false.
     */
    public data class Done(val cloud: Boolean) : PlatformBackupWrite()

    /** No backup here, or it cannot be reached now. [reason] is one of the `PlatformBackupStore.REASON_*` words. */
    public data class Unavailable(val reason: String) : PlatformBackupWrite()

    /** The key is not one of ours, or the value is over [PlatformBackupStore.MAX_VALUE_BYTES]. */
    public data class Refused(val reason: String) : PlatformBackupWrite()
}

/**
 * The OS-held backup of two small secrets (I-49): the restore item of automatic sign-in and the
 * Cloud Sync root. One native implementation per SDK; here it is Block Store on Android.
 *
 * - Keys: [restoreKey] and [syncKey], one per product. Anything else is [PlatformBackupRead.Refused].
 *   The OS limits an app to a few entries (16 on Android), so the value, not the key, carries the
 *   subject and the key ring id.
 * - Values: at most [MAX_VALUE_BYTES].
 * - Cloud: an item goes to the cloud only when [cloudBackup] is true (D-5); otherwise it stays on
 *   the device and moves only device to device.
 * - No implementation throws for an OS refusal; it answers `Unavailable`.
 */
public interface PlatformBackupStore {
    public suspend fun get(key: String): PlatformBackupRead

    public suspend fun set(key: String, bytes: ByteArray): PlatformBackupWrite

    public suspend fun delete(key: String): PlatformBackupWrite

    /**
     * Whether an item written now is copied to the cloud: the OS offers an end-to-end encrypted cloud
     * backup. False when it does not, and when the store is unavailable. (A function, not a property:
     * the answer comes from the OS.)
     */
    public suspend fun cloudBackup(): Boolean

    public companion object {
        public const val RESTORE_PREFIX: String = "pkey-restore-"
        public const val SYNC_PREFIX: String = "pkey-sync-"

        /** The longest value a store accepts (Block Store's 4 KB per entry). */
        public const val MAX_VALUE_BYTES: Int = 4096

        /** The most entries an app may hold (Block Store's limit); two per product use two of them. */
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

        /** The key of the restore item of [product] (`pkey-restore-<product>`). */
        public fun restoreKey(product: String): String = RESTORE_PREFIX + product

        /** The key of the Cloud Sync root of [product] (`pkey-sync-<product>`). */
        public fun syncKey(product: String): String = SYNC_PREFIX + product

        /** Whether [key] is one of ours: a known prefix and a product slug after it. */
        public fun isOurKey(key: String): Boolean = listOf(RESTORE_PREFIX, SYNC_PREFIX).any { key.startsWith(it) && key.length > it.length }
    }
}

/** A store that answers every call as unavailable for [reason]; the platform has no backup, or it is not wired. */
public class UnavailablePlatformBackupStore(private val reason: String = PlatformBackupStore.REASON_UNSUPPORTED) : PlatformBackupStore {
    override suspend fun get(key: String): PlatformBackupRead = PlatformBackupRead.Unavailable(reason)

    override suspend fun set(key: String, bytes: ByteArray): PlatformBackupWrite = PlatformBackupWrite.Unavailable(reason)

    override suspend fun delete(key: String): PlatformBackupWrite = PlatformBackupWrite.Unavailable(reason)

    override suspend fun cloudBackup(): Boolean = false
}

/**
 * A store in memory, for tests and hosts with no OS backup: it applies the same key, size and entry
 * rules as a real one and reports [cloud] from [cloudBackup]. Nothing survives the process.
 */
public class InMemoryPlatformBackupStore(private val cloud: Boolean = false) : PlatformBackupStore {
    private val items = LinkedHashMap<String, ByteArray>()

    override suspend fun get(key: String): PlatformBackupRead = synchronized(items) {
        if (!PlatformBackupStore.isOurKey(key)) return PlatformBackupRead.Refused(PlatformBackupStore.REASON_BAD_KEY)
        items[key]?.let { PlatformBackupRead.Found(it.copyOf()) } ?: PlatformBackupRead.Missing
    }

    override suspend fun set(key: String, bytes: ByteArray): PlatformBackupWrite = synchronized(items) {
        if (!PlatformBackupStore.isOurKey(key)) return PlatformBackupWrite.Refused(PlatformBackupStore.REASON_BAD_KEY)
        if (bytes.size > PlatformBackupStore.MAX_VALUE_BYTES) return PlatformBackupWrite.Refused(PlatformBackupStore.REASON_TOO_LARGE)
        if (key !in items && items.size >= PlatformBackupStore.MAX_ENTRIES) return PlatformBackupWrite.Unavailable(PlatformBackupStore.REASON_FULL)
        items[key] = bytes.copyOf()
        PlatformBackupWrite.Done(cloud)
    }

    override suspend fun delete(key: String): PlatformBackupWrite = synchronized(items) {
        if (!PlatformBackupStore.isOurKey(key)) return PlatformBackupWrite.Refused(PlatformBackupStore.REASON_BAD_KEY)
        items.remove(key)
        PlatformBackupWrite.Done(false)
    }

    override suspend fun cloudBackup(): Boolean = cloud
}

/**
 * [inner] with a bound on every call: one that does not answer within [boundMillis] counts as an unavailable store
 * (`failed`; [cloudBackup] false), so a store that never answers cannot hold a sign-out, a launch or the key ring's
 * lock. A write is "not written" and a delete leaves at most an item whose key the revocation takes away. A [set]
 * asks the end-to-end question first and is bounded end to end.
 */
public class BoundedPlatformBackupStore @JvmOverloads constructor(
    private val inner: PlatformBackupStore,
    private val boundMillis: Long = DEFAULT_BOUND_MILLIS,
) : PlatformBackupStore {
    override suspend fun get(key: String): PlatformBackupRead =
        withTimeoutOrNull(boundMillis) { inner.get(key) } ?: PlatformBackupRead.Unavailable(PlatformBackupStore.REASON_FAILED)

    override suspend fun set(key: String, bytes: ByteArray): PlatformBackupWrite =
        withTimeoutOrNull(boundMillis) { inner.set(key, bytes) } ?: PlatformBackupWrite.Unavailable(PlatformBackupStore.REASON_FAILED)

    override suspend fun delete(key: String): PlatformBackupWrite =
        withTimeoutOrNull(boundMillis) { inner.delete(key) } ?: PlatformBackupWrite.Unavailable(PlatformBackupStore.REASON_FAILED)

    override suspend fun cloudBackup(): Boolean = withTimeoutOrNull(boundMillis) { inner.cloudBackup() } ?: false

    public companion object {
        /** About five seconds per call. */
        public const val DEFAULT_BOUND_MILLIS: Long = 5_000

        /** [store] bounded, or itself when it already is (or null). */
        public fun of(store: PlatformBackupStore?, boundMillis: Long = DEFAULT_BOUND_MILLIS): PlatformBackupStore? =
            if (store == null || store is BoundedPlatformBackupStore) store else BoundedPlatformBackupStore(store, boundMillis)
    }
}
