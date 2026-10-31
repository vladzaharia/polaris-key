package im.plrs.key.platform.play

import com.google.android.gms.auth.blockstore.BlockstoreStatusCodes
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Status
import im.plrs.key.platform.PlatformBackup
import im.plrs.key.platform.PlatformBackupRead
import im.plrs.key.platform.PlatformBackupWrite
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * [BlockStoreBackup] over a fake Block Store client: D-5 (cloud only when end-to-end encrypted), the
 * key and size guards, the status-code mapping and the redaction of the bytes.
 */
@Suppress("TooManyFunctions")
@RunWith(RobolectricTestRunner::class)
class BlockStoreBackupTest {
    private class Stored(val bytes: ByteArray, val cloud: Boolean)

    private class Fake : BlockStoreBackend {
        val items = LinkedHashMap<String, Stored>()
        var e2ee: Result<Boolean> = Result.success(true)
        var failure: Throwable? = null
        var probes = 0

        override fun endToEndEncrypted(callback: (Result<Boolean>) -> Unit) {
            probes++
            callback(e2ee)
        }

        override fun store(key: String, bytes: ByteArray, cloud: Boolean, callback: (Result<Unit>) -> Unit) {
            val f = failure
            if (f != null) return callback(Result.failure(f))
            items[key] = Stored(bytes, cloud)
            callback(Result.success(Unit))
        }

        override fun retrieve(key: String, callback: (Result<ByteArray?>) -> Unit) {
            val f = failure
            if (f != null) return callback(Result.failure(f))
            callback(Result.success(items[key]?.bytes))
        }

        override fun delete(key: String, callback: (Result<Unit>) -> Unit) {
            val f = failure
            if (f != null) return callback(Result.failure(f))
            items.remove(key)
            callback(Result.success(Unit))
        }
    }

    private val fake = Fake()
    private val backup = BlockStoreBackup(fake)
    private val key = PlatformBackup.RESTORE_PREFIX + "tidewater"

    private fun get(k: String = key): PlatformBackupRead {
        var out: PlatformBackupRead? = null
        backup.get(k) { out = it }
        return out!!
    }

    private val payload = "payload".toByteArray()

    private fun set(k: String = key, bytes: ByteArray = payload): PlatformBackupWrite {
        var out: PlatformBackupWrite? = null
        backup.set(k, bytes) { out = it }
        return out!!
    }

    private fun delete(k: String = key): PlatformBackupWrite {
        var out: PlatformBackupWrite? = null
        backup.delete(k) { out = it }
        return out!!
    }

    private fun api(code: Int) = ApiException(Status(code))

    @Test
    fun cloudBackupOnlyWhenEndToEndEncryptionIsAvailable() {
        assertEquals(PlatformBackupWrite.Done(true), set())
        assertTrue(fake.items.getValue(key).cloud)
        var probe: Boolean? = null
        backup.cloudBackup { probe = it }
        assertEquals(true, probe)

        fake.e2ee = Result.success(false)
        assertEquals(PlatformBackupWrite.Done(false), set())
        assertFalse("the item stays on the device", fake.items.getValue(key).cloud)
    }

    @Test
    fun aFailedEncryptionProbeKeepsTheItemLocal() {
        fake.e2ee = Result.failure(api(BlockstoreStatusCodes.FEATURE_NOT_SUPPORTED))
        assertEquals(PlatformBackupWrite.Done(false), set())
        assertFalse(fake.items.getValue(key).cloud)
        var cloud: Boolean? = null
        backup.cloudBackup { cloud = it }
        assertEquals(false, cloud)
    }

    @Test
    fun roundTripMissingAndDelete() {
        assertEquals(PlatformBackupRead.Missing, get())
        set(bytes = payload)
        assertArrayEquals(payload, (get() as PlatformBackupRead.Found).bytes)
        assertEquals("Found(${payload.size} bytes)", get().toString())
        assertEquals(PlatformBackupWrite.Done(false), delete())
        assertEquals(PlatformBackupRead.Missing, get())
    }

    @Test
    fun keysOutsideTheTwoPrefixesAreRefusedBeforeTheClientIsAsked() {
        for (bad in listOf("", "tidewater", "pkey-restore-", PlatformBackup.SYNC_PREFIX)) {
            assertEquals(PlatformBackupRead.Refused("bad-key"), get(bad))
            assertEquals(PlatformBackupWrite.Refused("bad-key"), set(bad))
            assertEquals(PlatformBackupWrite.Refused("bad-key"), delete(bad))
        }
        assertEquals(0, fake.probes)
        assertTrue(fake.items.isEmpty())
    }

    @Test
    fun aValueOverFourKilobytesIsRefusedBeforeTheClientIsAsked() {
        assertEquals(PlatformBackupWrite.Done(true), set(bytes = ByteArray(PlatformBackup.MAX_VALUE_BYTES)))
        fake.probes = 0
        assertEquals(PlatformBackupWrite.Refused("too-large"), set(bytes = ByteArray(PlatformBackup.MAX_VALUE_BYTES + 1)))
        assertEquals(0, fake.probes)
    }

    @Test
    fun statusCodesMapToFixedReasons() {
        fake.failure = api(BlockstoreStatusCodes.TOO_MANY_ENTRIES)
        assertEquals(PlatformBackupWrite.Unavailable("full"), set())
        assertEquals(PlatformBackupRead.Unavailable("full"), get())

        fake.failure = api(BlockstoreStatusCodes.MAX_SIZE_EXCEEDED)
        assertEquals(PlatformBackupWrite.Refused("too-large"), set())

        fake.failure = api(BlockstoreStatusCodes.FEATURE_NOT_SUPPORTED)
        assertEquals(PlatformBackupRead.Unavailable("unsupported"), get())
        assertEquals(PlatformBackupWrite.Unavailable("unsupported"), delete())

        for (missing in listOf(
            ConnectionResult.SERVICE_MISSING,
            ConnectionResult.SERVICE_VERSION_UPDATE_REQUIRED,
            ConnectionResult.SERVICE_DISABLED,
            ConnectionResult.SERVICE_INVALID,
            CommonStatusCodes.API_NOT_CONNECTED,
        )) {
            fake.failure = api(missing)
            assertEquals(PlatformBackupRead.Unavailable("no-play-services"), get())
        }

        fake.failure = api(CommonStatusCodes.INTERNAL_ERROR)
        assertEquals(PlatformBackupRead.Unavailable("failed"), get())
        fake.failure = IllegalStateException("provider text that must not surface")
        assertEquals(PlatformBackupWrite.Unavailable("failed"), set())
    }

    @Test
    fun aCancelledBlockStoreTaskAnswersUnavailable() {
        val cancel = com.google.android.gms.tasks.CancellationTokenSource()
        val source = com.google.android.gms.tasks.TaskCompletionSource<Int>(cancel.token)
        var answer: Result<Unit>? = null
        runTask<Int, Unit>({ answer = it }, { _ -> Unit }) { source.task }
        assertEquals(null, answer)
        cancel.cancel()
        org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
        assertTrue("a cancelled task answers", answer!!.isFailure)
        // The answer maps to the failed reason, like any other failure.
        val failure = answer!!.exceptionOrNull()!!
        var out: PlatformBackupRead? = null
        val cancelling = BlockStoreBackup(
            object : BlockStoreBackend by fake {
                override fun retrieve(key: String, callback: (Result<ByteArray?>) -> Unit) = callback(Result.failure(failure))
            },
        )
        cancelling.get(key) { out = it }
        assertEquals(PlatformBackupRead.Unavailable(PlatformBackup.REASON_FAILED), out)
    }
}
