package im.plrs.key.platform.play

import android.content.Context
import com.google.android.gms.auth.blockstore.Blockstore
import com.google.android.gms.auth.blockstore.BlockstoreClient
import com.google.android.gms.auth.blockstore.BlockstoreStatusCodes
import com.google.android.gms.auth.blockstore.DeleteBytesRequest
import com.google.android.gms.auth.blockstore.RetrieveBytesRequest
import com.google.android.gms.auth.blockstore.StoreBytesData
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.tasks.Task
import im.plrs.key.platform.PlatformBackup
import im.plrs.key.platform.PlatformBackupRead
import im.plrs.key.platform.PlatformBackupWrite

/** What [BlockStoreBackup] asks of Block Store: the real client, or a fake in tests. Callbacks arrive on the main thread. */
internal interface BlockStoreBackend {
    fun endToEndEncrypted(callback: (Result<Boolean>) -> Unit)

    fun store(key: String, bytes: ByteArray, cloud: Boolean, callback: (Result<Unit>) -> Unit)

    /** The bytes under [key], or null when there are none. */
    fun retrieve(key: String, callback: (Result<ByteArray?>) -> Unit)

    fun delete(key: String, callback: (Result<Unit>) -> Unit)
}

internal class BlockStoreClientBackend(private val context: Context) : BlockStoreBackend {
    // Created on first use, so a device with no Play services fails inside a call (answered as
    // Unavailable), never while the SDK is built.
    private fun client(): BlockstoreClient = Blockstore.getClient(context)

    // Blockstore.getClient and the Task calls can throw anything on a device with a broken Play services.
    @Suppress("TooGenericExceptionCaught")
    private fun <T, R> run(callback: (Result<R>) -> Unit, map: (T) -> R, task: () -> Task<T>) {
        val t = try {
            task()
        } catch (e: Exception) {
            callback(Result.failure(e))
            return
        }
        t.addOnSuccessListener { callback(Result.success(map(it))) }
        t.addOnFailureListener { callback(Result.failure(it)) }
    }

    override fun endToEndEncrypted(callback: (Result<Boolean>) -> Unit): Unit =
        run(callback, { it == true }) { client().isEndToEndEncryptionAvailable() }

    override fun store(key: String, bytes: ByteArray, cloud: Boolean, callback: (Result<Unit>) -> Unit): Unit = run(callback, { _: Int -> Unit }) {
        client().storeBytes(StoreBytesData.Builder().setKey(key).setBytes(bytes).setShouldBackupToCloud(cloud).build())
    }

    override fun retrieve(key: String, callback: (Result<ByteArray?>) -> Unit): Unit =
        run(callback, { r: com.google.android.gms.auth.blockstore.RetrieveBytesResponse -> r.blockstoreDataMap[key]?.bytes }) {
            client().retrieveBytes(RetrieveBytesRequest.Builder().setKeys(listOf(key)).build())
        }

    override fun delete(key: String, callback: (Result<Unit>) -> Unit): Unit = run(callback, { _: Boolean -> Unit }) {
        client().deleteBytes(DeleteBytesRequest.Builder().setKeys(listOf(key)).build())
    }
}

/**
 * [PlatformBackup] over Block Store (`play-services-auth-blockstore` 16.4.0, I-49.1b):
 *
 * - **D-5.** A write asks `isEndToEndEncryptionAvailable()` first and passes the answer to
 *   `setShouldBackupToCloud`: the item reaches the cloud only when it is end-to-end encrypted. When
 *   the question fails the answer is false, so the item stays on the device and moves only device to
 *   device.
 * - Limits: 4 KB per entry and 16 entries per app, checked here (`too-large`) and mapped from the
 *   service's `MAX_SIZE_EXCEEDED` and `TOO_MANY_ENTRIES` (`full`).
 * - Errors map to a fixed reason, never the exception's text. The bytes never reach a log.
 * - A delete answers `Done(cloud = false)`: Block Store's delete reports nothing about the cloud copy.
 */
public class BlockStoreBackup internal constructor(private val backend: BlockStoreBackend) : PlatformBackup {
    public constructor(context: Context) : this(BlockStoreClientBackend(context))

    override val isSupported: Boolean get() = true

    override fun cloudBackup(callback: (Boolean) -> Unit): Unit = backend.endToEndEncrypted { callback(it.getOrDefault(false)) }

    override fun get(key: String, callback: (PlatformBackupRead) -> Unit) {
        if (!PlatformBackup.isOurKey(key)) return callback(PlatformBackupRead.Refused(PlatformBackup.REASON_BAD_KEY))
        backend.retrieve(key) { r ->
            callback(
                r.fold(
                    { bytes -> if (bytes == null) PlatformBackupRead.Missing else PlatformBackupRead.Found(bytes) },
                    { PlatformBackupRead.Unavailable(reasonOf(it)) },
                ),
            )
        }
    }

    override fun set(key: String, bytes: ByteArray, callback: (PlatformBackupWrite) -> Unit) {
        if (!PlatformBackup.isOurKey(key)) return callback(PlatformBackupWrite.Refused(PlatformBackup.REASON_BAD_KEY))
        if (bytes.size > PlatformBackup.MAX_VALUE_BYTES) return callback(PlatformBackupWrite.Refused(PlatformBackup.REASON_TOO_LARGE))
        backend.endToEndEncrypted { e2ee ->
            val cloud = e2ee.getOrDefault(false)
            backend.store(key, bytes, cloud) { r ->
                callback(
                    r.fold(
                        { PlatformBackupWrite.Done(cloud) },
                        { failure -> writeFailure(failure) },
                    ),
                )
            }
        }
    }

    override fun delete(key: String, callback: (PlatformBackupWrite) -> Unit) {
        if (!PlatformBackup.isOurKey(key)) return callback(PlatformBackupWrite.Refused(PlatformBackup.REASON_BAD_KEY))
        backend.delete(key) { r -> callback(r.fold({ PlatformBackupWrite.Done(false) }, { writeFailure(it) })) }
    }

    private fun writeFailure(e: Throwable): PlatformBackupWrite = if ((e as? ApiException)?.statusCode == BlockstoreStatusCodes.MAX_SIZE_EXCEEDED) {
        PlatformBackupWrite.Refused(PlatformBackup.REASON_TOO_LARGE)
    } else {
        PlatformBackupWrite.Unavailable(reasonOf(e))
    }

    private fun reasonOf(e: Throwable): String = when (val code = (e as? ApiException)?.statusCode) {
        BlockstoreStatusCodes.TOO_MANY_ENTRIES -> PlatformBackup.REASON_FULL
        BlockstoreStatusCodes.FEATURE_NOT_SUPPORTED -> PlatformBackup.REASON_UNSUPPORTED
        else -> if (code in NO_PLAY_SERVICES) PlatformBackup.REASON_NO_PLAY_SERVICES else PlatformBackup.REASON_FAILED
    }
}

// The statuses that mean Play services is missing, disabled, too old or not connected.
private val NO_PLAY_SERVICES: Set<Int> = setOf(
    ConnectionResult.SERVICE_MISSING,
    ConnectionResult.SERVICE_VERSION_UPDATE_REQUIRED,
    ConnectionResult.SERVICE_DISABLED,
    ConnectionResult.SERVICE_INVALID,
    CommonStatusCodes.API_NOT_CONNECTED,
)
