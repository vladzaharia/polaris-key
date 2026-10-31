package im.plrs.key.android

import im.plrs.key.core.PlatformBackupRead
import im.plrs.key.core.PlatformBackupStore
import im.plrs.key.core.PlatformBackupWrite
import im.plrs.key.platform.PlatformBackup
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import im.plrs.key.platform.PlatformBackupRead as PlatformRead
import im.plrs.key.platform.PlatformBackupWrite as PlatformWrite

/** [AndroidPlatformBackupStore] converts :platform's answers to :core's, one for one. */
class PlatformBackupStoreAdapterTest {
    private class Fake : PlatformBackup {
        val calls = mutableListOf<String>()
        var read: PlatformRead = PlatformRead.Missing
        var write: PlatformWrite = PlatformWrite.Done(true)
        var cloud = true
        override val isSupported = true

        override fun cloudBackup(callback: (Boolean) -> Unit) = callback(cloud)

        override fun get(key: String, callback: (PlatformRead) -> Unit) {
            calls += "get:$key"
            callback(read)
        }

        override fun set(key: String, bytes: ByteArray, callback: (PlatformWrite) -> Unit) {
            calls += "set:$key:${bytes.size}"
            callback(write)
        }

        override fun delete(key: String, callback: (PlatformWrite) -> Unit) {
            calls += "delete:$key"
            callback(write)
        }
    }

    private val key = PlatformBackupStore.restoreKey("tidewater")

    @Test
    fun answersConvertOneForOne() = runTest {
        val fake = Fake()
        val store = AndroidPlatformBackupStore(fake)

        assertEquals(PlatformBackupRead.Missing, store.get(key))
        fake.read = PlatformRead.Found(byteArrayOf(1, 2))
        assertArrayEquals(byteArrayOf(1, 2), (store.get(key) as PlatformBackupRead.Found).bytes)
        fake.read = PlatformRead.Unavailable("no-play-services")
        assertEquals(PlatformBackupRead.Unavailable("no-play-services"), store.get(key))
        fake.read = PlatformRead.Refused("bad-key")
        assertEquals(PlatformBackupRead.Refused("bad-key"), store.get(key))

        assertEquals(PlatformBackupWrite.Done(true), store.set(key, byteArrayOf(1)))
        fake.write = PlatformWrite.Done(false)
        assertEquals(PlatformBackupWrite.Done(false), store.delete(key))
        fake.write = PlatformWrite.Unavailable("full")
        assertEquals(PlatformBackupWrite.Unavailable("full"), store.set(key, byteArrayOf(1)))
        fake.write = PlatformWrite.Refused("too-large")
        assertEquals(PlatformBackupWrite.Refused("too-large"), store.set(key, byteArrayOf(1)))

        assertTrue(store.cloudBackup())
        fake.cloud = false
        assertFalse(store.cloudBackup())
        assertEquals(listOf("get:$key", "get:$key", "get:$key", "get:$key", "set:$key:1", "delete:$key", "set:$key:1", "set:$key:1"), fake.calls)
    }

    @Test
    fun anUnsupportedPlatformIsATypedUnavailable() = runTest {
        val store = AndroidPlatformBackupStore(PlatformBackup.unsupported())
        assertEquals(PlatformBackupRead.Unavailable("outlet"), store.get(key))
        assertEquals(PlatformBackupWrite.Unavailable("outlet"), store.set(key, byteArrayOf(1)))
        assertEquals(PlatformBackupWrite.Unavailable("outlet"), store.delete(key))
        assertFalse(store.cloudBackup())
    }
}
