package im.plrs.key.android

import android.content.Context
import im.plrs.key.core.PlatformBackupRead
import im.plrs.key.core.PlatformBackupStore
import im.plrs.key.core.PlatformBackupWrite
import im.plrs.key.platform.PlatformBackup
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import im.plrs.key.platform.PlatformBackupRead as PlatformRead
import im.plrs.key.platform.PlatformBackupWrite as PlatformWrite

/**
 * :android's adapter from :platform's [PlatformBackup] to :core's [PlatformBackupStore] (I-49.1b): in
 * the `play` flavour Block Store (an item reaches the cloud only when it is end-to-end encrypted,
 * D-5), in `direct` every call answers Unavailable("outlet"). Only the answer types are converted;
 * nothing is retried and nothing falls back.
 */
public class AndroidPlatformBackupStore(private val backup: PlatformBackup) : PlatformBackupStore {
    public constructor(context: Context) : this(PlatformBackup.create(context))

    override suspend fun get(key: String): PlatformBackupRead = suspendCancellableCoroutine { k ->
        backup.get(key) { r ->
            if (k.isActive) {
                k.resume(
                    when (r) {
                        is PlatformRead.Found -> PlatformBackupRead.Found(r.bytes)
                        PlatformRead.Missing -> PlatformBackupRead.Missing
                        is PlatformRead.Unavailable -> PlatformBackupRead.Unavailable(r.reason)
                        is PlatformRead.Refused -> PlatformBackupRead.Refused(r.reason)
                    },
                )
            }
        }
    }

    override suspend fun set(key: String, bytes: ByteArray): PlatformBackupWrite = suspendCancellableCoroutine { k ->
        backup.set(key, bytes) { r -> if (k.isActive) k.resume(write(r)) }
    }

    override suspend fun delete(key: String): PlatformBackupWrite = suspendCancellableCoroutine { k ->
        backup.delete(key) { r -> if (k.isActive) k.resume(write(r)) }
    }

    override suspend fun cloudBackup(): Boolean = suspendCancellableCoroutine { k ->
        backup.cloudBackup { if (k.isActive) k.resume(it) }
    }

    private fun write(r: PlatformWrite): PlatformBackupWrite = when (r) {
        is PlatformWrite.Done -> PlatformBackupWrite.Done(r.cloud)
        is PlatformWrite.Unavailable -> PlatformBackupWrite.Unavailable(r.reason)
        is PlatformWrite.Refused -> PlatformBackupWrite.Refused(r.reason)
    }
}
